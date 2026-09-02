//! WorkerDispatcherService port: pops `queue:*` keys and POSTs jobs to worker URLs
//! (`WORKER_URLS`, default http://worker:8000) with health/capacity gating.
//!
//! Parity notes:
//!   * poll interval = WORKER_POLL_MS (default 2000), pause gate checked first;
//!   * /capabilities gates dispatch by heavy/light slots (max_heavy_slots etc.);
//!   * 202 ⇒ stamp started_at; 400/422 ⇒ job FAILED permanently, never re-pushed;
//!   * 429 ⇒ exponential cooldown per worker (10s base, doubling, 60s cap);
//!   * an undispatchable job is re-pushed to the BACK of ITS queue and only that
//!     queue's drain stops for the cycle (AUDIT-P3).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::jobs::{HEAVY_QUEUES, LIGHT_QUEUES};
use crate::state::AppState;

const COOLDOWN_BASE_SECS: u64 = 10;
const COOLDOWN_MAX_SECS: u64 = 60;

/// The one queue whose ordering matters within a chapter. See `earlier_page_is_still_translating`.
const TRANSLATION_QUEUE: &str = "queue:translation";

#[derive(Default)]
struct WorkerState {
    cooldown_until: HashMap<String, Instant>,
    consecutive_429s: HashMap<String, u32>,
}

pub struct Dispatcher {
    state: AppState,
    http: reqwest::Client,
    workers: Mutex<WorkerState>,
    worker_urls: Vec<String>,
    api_secret: Option<String>,
}

impl Dispatcher {
    pub fn new(state: AppState) -> Self {
        let worker_urls = std::env::var("WORKER_URLS")
            .unwrap_or_else(|_| "http://worker:8000".to_string())
            .split(',')
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(|url| url.trim_end_matches('/').to_string())
            .collect();
        // Compose passes WORKER_API_SECRET_FILE (Docker secret); the plain env var is
        // the dev spelling. resolve_credential handles both — reading only the env var
        // silently dropped the secret in containers, and every capabilities probe then
        // came back 401, which this loop treated as "no workers" without a word.
        let mut credential_problems = Vec::new();
        let api_secret =
            crate::config::resolve_credential("WORKER_API_SECRET", &mut credential_problems);
        for problem in credential_problems {
            tracing::error!("{problem}");
        }
        Self {
            state,
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(30))
                .build()
                .expect("dispatcher HTTP client"),
            workers: Mutex::new(WorkerState::default()),
            worker_urls,
            api_secret,
        }
    }

    fn in_cooldown(&self, worker_url: &str) -> bool {
        self.workers
            .lock()
            .expect("worker state")
            .cooldown_until
            .get(worker_url)
            .map(|until| Instant::now() < *until)
            .unwrap_or(false)
    }

    /// One scheduler pass: pause-gate → capabilities → heavy/light dispatch.
    /// Public so tests can drive exact cycles against a mock worker.
    pub async fn run_cycle(&self) {
        let Some(redis) = &self.state.redis else {
            return;
        };
        match redis.queue_paused().await {
            Ok(true) => return,
            Ok(false) => {}
            Err(_) => return,
        }
        if self.worker_urls.is_empty() || !self.any_queue_has_items(redis).await {
            return;
        }

        // Query capacities from workers not in cooldown.
        let mut capacities: HashMap<String, Capacity> = HashMap::new();
        for url in &self.worker_urls {
            if self.in_cooldown(url) {
                continue;
            }
            let mut request = self
                .http
                .get(format!("{url}/capabilities"))
                .timeout(Duration::from_secs(3));
            if let Some(secret) = &self.api_secret {
                request = request.header("WORKER_API_SECRET", secret);
            }
            if let Ok(response) = request.send().await {
                let status = response.status().as_u16();
                if status != 200 {
                    // A 401 here (secret mismatch) looks identical to "no workers" from
                    // the outside: nothing dispatches and nothing logs. Make it loud.
                    tracing::warn!(
                        "Worker {url} capabilities probe returned {status}; skipping this cycle"
                    );
                } else if let Ok(body) = response.json::<serde_json::Value>().await {
                    capacities.insert(url.clone(), Capacity::from_json(&body));
                    self.workers
                        .lock()
                        .expect("worker state")
                        .consecutive_429s
                        .remove(url);
                }
            } else {
                tracing::debug!("Worker {url} is unreachable for capabilities");
            }
        }
        if capacities.is_empty() {
            return;
        }

        self.dispatch_slot(&HEAVY_QUEUES, &capacities, true).await;
        self.dispatch_slot(&LIGHT_QUEUES, &capacities, false).await;
    }

    async fn any_queue_has_items(&self, redis: &crate::redis_service::RedisService) -> bool {
        for queue in HEAVY_QUEUES.into_iter().chain(LIGHT_QUEUES) {
            if redis.queue_size(queue).await.unwrap_or(0) > 0 {
                return true;
            }
        }
        false
    }

    /// AUDIT-W13: is an earlier page of this page's chapter still waiting to be translated?
    ///
    /// A chapter with `use_context_memory` on has every page's translation prompt prefixed with
    /// the *previous* page's dialogue, assembled by `image_details` in `routes/internal.rs`. That
    /// only means anything if the previous page has actually been translated by the time this one
    /// starts — and nothing enforced it. `queue:translation` is a LIGHT queue with four slots by
    /// default, so four consecutive pages translated at once and each read a predecessor that was
    /// still in flight.
    ///
    /// The failure is worse than a missing prefix. The context query is
    /// `COALESCE(translated_text, text)`, so an untranslated predecessor hands back its **Japanese
    /// source**, which the prompt then labels "Previous Page Dialogue (in reading order)". The
    /// model is shown untranslated text as though it were the established English. A feature the
    /// chapter header advertises as "Context Injection: Enabled" was, for every page but the
    /// first, either inert or actively misleading.
    ///
    /// Gating here rather than in the worker is deliberate: a blocked job simply stays in Redis,
    /// so no concurrency slot is held while it waits. A per-chapter lock taken inside the worker
    /// would have been the obvious alternative and would have burned a light slot for the whole
    /// wait — the failure mode `AUDIT-W3` already describes. This keeps W13 independent of W3.
    ///
    /// Attributes a blocker to a **page**, not an image. A duplicate upload into the same chapter
    /// is a supported path — `upload_page` appends a second page at `max+1` pointing at the
    /// *existing* image row — so one `image_id` can belong to two pages of one chapter. Joining
    /// through `image_id` made the later page's own job match the earlier page, satisfy
    /// `prev.page_number < me.page_number`, and block itself forever. `jobs.page_id` is populated
    /// as of AUDIT-B17; rows predating that have NULL and simply do not block, which is the
    /// fail-open direction.
    ///
    /// It blocks on the whole run-up to a translation — `panel-detection`, `ocr`, `layout` as well
    /// as `translation` — not just on translation itself. Pages move through the pipeline at
    /// different rates (that is why they were parallel to begin with), so an earlier page still
    /// sitting in OCR has no translation job to find, and gating on `translation` alone would wave
    /// this page straight through to read a predecessor that has not been translated.
    ///
    /// It deliberately does **not** block on `render` or `qa`. QA's `direct_fix` can still rewrite
    /// an earlier page's `translated_text` after this page has read it, so the ordering is not
    /// absolute — but blocking on QA would serialise every chapter's entire pipeline end to end
    /// for the sake of small text corrections. The report asked for the TL phase to be sequential
    /// and the rest to stay parallel; this is that line.
    ///
    /// Fails **open**: no row (chapter has context injection off, or the page is gone) and any
    /// database error both read as "not blocked". A gate that cannot answer must not stall the
    /// pipeline. A predecessor wedged in PROCESSING cannot deadlock the chapter either — the
    /// 5-minute stale sweep in `recovery.rs` returns it to PENDING or fails it, and a FAILED job
    /// is neither PENDING nor PROCESSING, so it stops blocking. A page that produced no OCR
    /// regions never enqueues a translation at all, so it never blocks the pages after it.
    async fn earlier_page_is_still_translating(&self, page_id: uuid::Uuid) -> bool {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS ( \
                 SELECT 1 FROM jobs j \
                   JOIN pages prev ON prev.id = j.page_id \
                  WHERE j.type IN ('panel-detection', 'ocr', 'layout', 'translation') \
                    AND j.status IN ('PENDING', 'PROCESSING') \
                    AND prev.chapter_id = me.chapter_id \
                    AND prev.page_number < me.page_number \
             ) \
             FROM pages me \
             JOIN chapters c ON c.id = me.chapter_id \
             WHERE me.id = $1 AND c.use_context_memory",
        )
        .bind(page_id)
        .fetch_optional(&self.state.pool)
        .await
        .unwrap_or(None)
        .unwrap_or(false)
    }

    async fn dispatch_slot(
        &self,
        queues: &[&str],
        capacities: &HashMap<String, Capacity>,
        is_heavy: bool,
    ) {
        let Some(redis) = &self.state.redis else {
            return;
        };
        for queue in queues {
            let has_capacity = capacities.values().any(|c| c.has_slot(is_heavy));
            if !has_capacity {
                continue;
            }

            loop {
                let Ok(Some(job_json)) = redis.pop_from_queue(queue).await else {
                    break;
                };

                let job_id: String = serde_json::from_str::<serde_json::Value>(&job_json)
                    .ok()
                    .and_then(|v| v.get("jobId").and_then(|j| j.as_str()).map(str::to_string))
                    .unwrap_or_else(|| "unknown".into());

                // AUDIT-W13: a context-injecting chapter translates strictly in page order.
                // Re-pushed to the BACK and this queue's drain stopped for the cycle — the same
                // shape as the undispatchable case below, and for the same reason (AUDIT-P3).
                // Going to the back is what lets the queue sort itself out: the page that *is*
                // ready surfaces on the next cycle instead of sitting behind a blocked one.
                if *queue == TRANSLATION_QUEUE
                    && let Some(page_id) = page_id_of(&job_json)
                    && self.earlier_page_is_still_translating(page_id).await
                {
                    tracing::debug!(
                        "Holding translation job {job_id}: an earlier page of its chapter is still                          translating and the chapter injects previous-page context"
                    );
                    let _ = redis.push_to_queue(queue, &job_json).await;
                    break;
                }

                let mut sent = false;
                for (worker_url, cap) in capacities {
                    if !cap.has_slot(is_heavy) {
                        continue;
                    }

                    let body = json!({ "queue_name": queue, "job_data": serde_json::from_str::<serde_json::Value>(&job_json).unwrap_or(json!({})) });
                    let mut request = self
                        .http
                        .post(format!("{worker_url}/api/v1/jobs/submit"))
                        .header("Content-Type", "application/json")
                        .json(&body);
                    if let Some(secret) = &self.api_secret {
                        request = request.header("WORKER_API_SECRET", secret);
                    }

                    match request.send().await {
                        Ok(response) => {
                            let status = response.status().as_u16();
                            match status {
                                202 => {
                                    sent = true;
                                    mark_job_started(&self.state.pool, &job_id).await;
                                    break;
                                }
                                400 | 422 => {
                                    let body_text = response.text().await.unwrap_or_default();
                                    tracing::error!(
                                        "Worker {worker_url} permanently rejected job {job_id} (status {status}): {body_text}"
                                    );
                                    sent = true;
                                    mark_permanently_rejected(
                                        &self.state,
                                        &job_id,
                                        status,
                                        &body_text,
                                    )
                                    .await;
                                    break;
                                }
                                429 => {
                                    let consecutive = {
                                        let mut workers =
                                            self.workers.lock().expect("worker state");
                                        let counter = workers
                                            .consecutive_429s
                                            .entry(worker_url.clone())
                                            .or_insert(0);
                                        *counter += 1;
                                        *counter
                                    };
                                    let cooldown_secs = (COOLDOWN_BASE_SECS
                                        << (consecutive - 1).min(6))
                                    .min(COOLDOWN_MAX_SECS);
                                    self.workers
                                        .lock()
                                        .expect("worker state")
                                        .cooldown_until
                                        .insert(
                                            worker_url.clone(),
                                            Instant::now() + Duration::from_secs(cooldown_secs),
                                        );
                                    tracing::warn!(
                                        "Worker {worker_url} returned 429 (consecutive={consecutive}). Cooling down for {cooldown_secs}s."
                                    );
                                }
                                other => {
                                    let _ = response.text().await;
                                    tracing::error!(
                                        "Worker {worker_url} returned status {other} for job {job_id}"
                                    );
                                }
                            }
                        }
                        Err(err) => {
                            tracing::debug!("Worker {worker_url} is unreachable: {err}");
                        }
                    }
                }

                if !sent {
                    // Re-push to the BACK so other jobs proceed; stop draining THIS queue
                    // only (AUDIT-P3).
                    let _ = redis.push_to_queue(queue, &job_json).await;
                    break;
                }
            }
        }
    }
}

/// `pageId` out of a queued job payload, when it carries one.
fn page_id_of(job_json: &str) -> Option<uuid::Uuid> {
    serde_json::from_str::<serde_json::Value>(job_json)
        .ok()?
        .get("pageId")?
        .as_str()
        .and_then(|s| uuid::Uuid::parse_str(s).ok())
}

#[derive(Clone, Copy)]
struct Capacity {
    max_total: i32,
    active_total: i32,
    max_heavy: i32,
    active_heavy: i32,
    max_light: i32,
    active_light: i32,
}

impl Capacity {
    fn from_json(value: &serde_json::Value) -> Self {
        let int_at = |key: &str, default: i32| {
            value
                .get(key)
                .and_then(|v| v.as_i64())
                .unwrap_or(default as i64) as i32
        };
        Self {
            max_total: int_at("max_concurrent_jobs", 2),
            active_total: int_at("active_jobs", 0),
            max_heavy: int_at("max_heavy_slots", 1),
            active_heavy: int_at("active_heavy_jobs", 0),
            max_light: int_at("max_light_slots", 1),
            active_light: int_at("active_light_jobs", 0),
        }
    }

    fn has_slot(&self, heavy: bool) -> bool {
        if heavy {
            self.active_heavy < self.max_heavy && self.active_total < self.max_total
        } else {
            self.active_light < self.max_light && self.active_total < self.max_total
        }
    }
}

/// Best-effort started_at stamp at the moment a worker accepted the job.
async fn mark_job_started(pool: &sqlx::PgPool, job_id: &str) {
    if job_id == "unknown" {
        return;
    }
    if let Err(err) = sqlx::query("UPDATE jobs SET started_at = now() WHERE id = $1")
        .bind(job_id)
        .execute(pool)
        .await
    {
        tracing::debug!("Could not stamp started_at on job {job_id}: {err}");
    }
}

/// AUDIT-P2: a 400/422 pops the job off Redis permanently — mark it FAILED so it does
/// not sit PENDING forever with no error anywhere in the UI.
async fn mark_permanently_rejected(state: &AppState, job_id: &str, status_code: u16, body: &str) {
    if job_id == "unknown" {
        tracing::warn!("Permanently rejected job has no usable jobId — cannot mark it FAILED");
        return;
    }
    const MAX_ERROR_LEN: usize = 500;
    let truncated: String = if body.len() <= MAX_ERROR_LEN {
        body.to_string()
    } else {
        format!("{}…", &body[..MAX_ERROR_LEN])
    };
    let error = format!("Worker rejected the job payload (HTTP {status_code}): {truncated}");

    let result = sqlx::query_scalar::<_, Option<uuid::Uuid>>(
        "UPDATE jobs SET status='FAILED', error=$2, updated_at=now() WHERE id=$1 RETURNING image_id",
    )
    .bind(job_id)
    .bind(error)
    .fetch_optional(&state.pool)
    .await;
    match result {
        Ok(Some(image_id)) => {
            if let Some(image_id) = image_id {
                state
                    .sse
                    .emit_event_for_image(
                        image_id,
                        "job_update",
                        &format!(r#"{{"id":"{job_id}","type":"","status":"FAILED"}}"#),
                    )
                    .await;
            }
            tracing::error!(
                "Marked job {job_id} FAILED after a permanent worker rejection (HTTP {status_code})"
            );
        }
        Ok(None) => {
            tracing::warn!("Permanently rejected job {job_id} has no DB row to mark FAILED")
        }
        Err(err) => tracing::error!("Failed to mark rejected job {job_id} as FAILED: {err}"),
    }
}

/// The scheduler loop entrypoint — spawn this once at startup.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let dispatcher = Dispatcher::new(state);
        let poll_ms: u64 = std::env::var("WORKER_POLL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2000);
        loop {
            dispatcher.run_cycle().await;
            tokio::time::sleep(Duration::from_millis(poll_ms)).await;
        }
    });
}
