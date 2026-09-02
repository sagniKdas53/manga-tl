//! Job pipeline coordination — port of JobCoordinatorService (~2.3k lines Java).
//!
//! Structure mirrors the Java service function-for-function. The transaction-boundary
//! rules from the Java audit are preserved exactly:
//!   * SSE fan-out happens immediately (Java emitted inside the transaction);
//!   * Redis queue pushes happen strictly AFTER the DB write commits (Java's
//!     afterCommit hook) — see [`enqueue_job_directly`], which takes an optional
//!     `&mut PgTransaction`-style executor and returns a "pending push" the caller
//!     performs once its transaction has committed.
//!   * callback application is claimed ONCE per job row (`claim_callback`) — duplicate
//!     worker callbacks after a recovery requeue are dropped, not reapplied.
//!   * trace ids: `pipeline:trace:{imageId}` with a 12h TTL refreshed on every enqueue.

use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::models::{Chapter, Image, Job, Layer, LayerElement, OcrRegion, Page, Panel, Series};
use crate::resolve::resolve_model;
use crate::settings::load_global_settings;
use crate::state::AppState;

pub const PIPELINE_TRACE_TTL_SECS: u64 = 12 * 3600;
pub const REDO_REASON_TTL_SECS: u64 = 24 * 3600;
/// Worker queues in drain order (heavy first). Also used by the dispatcher.
pub const HEAVY_QUEUES: [&str; 4] = [
    "queue:qa-re-ocr",
    "queue:region-redo-ocr",
    "queue:ocr",
    "queue:panel-detection",
];
pub const LIGHT_QUEUES: [&str; 5] = [
    "queue:region-redo-tl",
    "queue:qa",
    "queue:render",
    "queue:translation",
    "queue:layout",
];

/// Everything a callback needs to resolve its job row (AUDIT-P5): prefer the echoed
/// jobId exactly; fall back to newest job of that type for the image only when absent,
/// never trusting a jobId that points at a row of a different type.
pub async fn resolve_callback_job(
    pool: &PgPool,
    job_id: Option<&str>,
    image_id: Uuid,
    job_type: &str,
) -> Option<Job> {
    if let Some(id) = job_id.map(str::trim).filter(|s| !s.is_empty()) {
        let by_id: Option<Job> = sqlx::query_as("SELECT * FROM jobs WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
        match by_id {
            Some(job) if job.job_type == job_type => return Some(job),
            Some(job) => tracing::warn!(
                "{job_type} callback for image {image_id} carried jobId {id}, but that job is of type {} — refusing to claim it",
                job.job_type
            ),
            None => tracing::warn!(
                "{job_type} callback for image {image_id} carried jobId {id}, but no such job row exists"
            ),
        }
    }
    sqlx::query_as(
        "SELECT * FROM jobs WHERE image_id = $1 AND type = $2 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(image_id)
    .bind(job_type)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

/// True when this layer is a region-redo overlay — a one-element patch stacked on a full pass,
/// not a pass of its own.
///
/// Several places independently pick "the newest layer of this type" and treat what they get as
/// complete: QA's hybrid prepare and its callback, get_image_info's region filter, and export's
/// activeLayer. Every one of them is wrong about an overlay, and each was found separately. The
/// test lives here so the next such reader has something to call instead of inventing a sixth.
pub fn is_redo_overlay(layer: &Layer) -> bool {
    layer
        .metadata_json
        .as_ref()
        .and_then(|m| m.get("overlay"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// The newest *complete* layer of a type, ignoring region-redo overlays.
pub fn latest_complete_layer<'a>(layers: &'a [Layer], layer_type: &str) -> Option<&'a Layer> {
    layers
        .iter()
        .filter(|l| l.layer_type.eq_ignore_ascii_case(layer_type) && !is_redo_overlay(l))
        .max_by_key(|l| l.z_order)
}

/// Claims the right to apply a result callback (AUDIT-P4). False ⇒ already applied:
/// log and drop the duplicate.
pub async fn claim_callback(
    state: &AppState,
    job_id: Option<&str>,
    image_id: Uuid,
    job_type: &str,
) -> bool {
    let Some(job) = resolve_callback_job(&state.pool, job_id, image_id, job_type).await else {
        return true; // nothing to deduplicate against — apply
    };
    let result = sqlx::query(
        "UPDATE jobs SET callback_applied_at = now() WHERE id = $1 AND callback_applied_at IS NULL",
    )
    .bind(&job.id)
    .execute(&state.pool)
    .await;
    match result {
        Ok(res) if res.rows_affected() > 0 => true,
        Ok(_) => {
            tracing::warn!(
                "Ignoring duplicate {job_type} callback for image {image_id} — job {} already applied its result at {:?}",
                job.id,
                job.callback_applied_at
            );
            false
        }
        Err(err) => {
            tracing::error!("claimCallback failed for job {}: {err}", job.id);
            true // fail-open like a lost race, never lose a genuine result
        }
    }
}

/// Transaction-scoped `claim_callback`, for callers whose writes must land or fail *with* the
/// claim.
///
/// The pool-based version marks the delivery applied in its own statement, so a caller that claims
/// and then fails leaves the job flagged and the worker's retry discarded as a duplicate — the
/// result lost. Claiming inside the caller's transaction makes a rollback release the claim too.
///
/// Returns Ok(false) when the delivery was already applied.
pub async fn claim_callback_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    job_id: Option<&str>,
    image_id: Uuid,
    job_type: &str,
) -> Result<bool, sqlx::Error> {
    let job: Option<Job> = match job_id.filter(|s| !s.is_empty()) {
        Some(id) => {
            sqlx::query_as("SELECT * FROM jobs WHERE id = $1")
                .bind(id)
                .fetch_optional(&mut **tx)
                .await?
        }
        // Deliberately no fallback to "newest job for this image and type". Region redos run
        // several at a time on one image, one per bubble, so that lookup claims another region's
        // job and drops this region's result as a duplicate.
        None => None,
    };
    let Some(job) = job else {
        return Ok(true); // nothing to deduplicate against — apply
    };
    if !job.job_type.eq_ignore_ascii_case(job_type) {
        return Ok(true);
    }
    if job.image_id != Some(image_id) {
        tracing::warn!(
            "Ignoring job {} while claiming {job_type} callback for image {image_id}: job belongs to image {:?}",
            job.id,
            job.image_id
        );
        return Ok(true);
    }
    let res = sqlx::query(
        "UPDATE jobs SET callback_applied_at = now() WHERE id = $1 AND callback_applied_at IS NULL",
    )
    .bind(&job.id)
    .execute(&mut **tx)
    .await?;
    if res.rows_affected() == 0 {
        tracing::warn!(
            "Ignoring duplicate {job_type} callback for image {image_id} — job {} already applied its result",
            job.id
        );
        return Ok(false);
    }
    Ok(true)
}

/// Resolves the page a callback reports on: exact pageId first, then first page for
/// the image.
pub async fn resolve_page_for_callback(
    pool: &PgPool,
    image_id: Uuid,
    page_id: Option<Uuid>,
) -> Option<Page> {
    if let Some(page_id) = page_id {
        return sqlx::query_as("SELECT * FROM pages WHERE id = $1")
            .bind(page_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    }
    // Same trap as clone.rs: pages has no created_at, so this ordering errored and
    // .ok().flatten() reported "no such page" for every page_id-less callback.
    sqlx::query_as("SELECT * FROM pages WHERE image_id = $1 ORDER BY page_number ASC LIMIT 1")
        .bind(image_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

/// Marks the job a callback belongs to FAILED and pushes the update down the stream.
pub async fn fail_job(
    state: &AppState,
    job_id: Option<&str>,
    image_id: Uuid,
    job_type: &str,
    error: &str,
) {
    let Some(mut job) = resolve_callback_job(&state.pool, job_id, image_id, job_type).await else {
        tracing::warn!("No {job_type} job row found for image {image_id} — cannot mark it FAILED");
        return;
    };
    let _ = sqlx::query(
        "UPDATE jobs SET status = 'FAILED', error = $2, updated_at = now() WHERE id = $1",
    )
    .bind(&job.id)
    .bind(error)
    .execute(&state.pool)
    .await;
    job.status = "FAILED".into();
    job.error = Some(error.to_string());
    state
        .sse
        .emit_event_for_image(
            image_id,
            "job_update",
            &serde_json::to_string(&job).unwrap_or_default(),
        )
        .await;
}

fn extract_uuid(map: &Value, key: &str) -> Option<Uuid> {
    map.get(key)?.as_str().and_then(|s| Uuid::parse_str(s).ok())
}

// ---------------------------------------------------------------------------
// Enqueue path
// ---------------------------------------------------------------------------

/// Port of startPipeline: mint/refresh the trace id, reuse existing panels (detection
/// is geometric and shared across pages), enter at OCR when they exist.
pub async fn start_pipeline(
    state: &AppState,
    image_id: Uuid,
    page_id: Option<Uuid>,
    chapter_id: Option<Uuid>,
) {
    if let Some(redis) = &state.redis {
        let trace_id = Uuid::new_v4().to_string();
        let _ = redis
            .set_ex(
                &format!("pipeline:trace:{image_id}"),
                &trace_id,
                PIPELINE_TRACE_TTL_SECS,
            )
            .await;
        tracing::info!("Pipeline trace for image {image_id} is {trace_id}");
    }

    let panels_exist: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM panels WHERE image_id = $1)")
            .bind(image_id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or(false);

    if panels_exist {
        tracing::info!(
            "Panels already exist for image {image_id} — reusing them and starting pipeline at OCR"
        );
        enqueue_job_directly(
            state,
            "ocr",
            image_id,
            page_id,
            chapter_id,
            "normal",
            |_| {},
        )
        .await;
        return;
    }
    enqueue_job_directly(
        state,
        "panel-detection",
        image_id,
        page_id,
        chapter_id,
        "normal",
        |_| {},
    )
    .await;
}

/// The AUTHORITY for payload construction (task keys ocr/tl/qaLLM/qaVLM live here).
///
/// Returns whether the DB insert happened; the Redis push is performed here AFTER our
/// own single-statement insert has committed (each handler-level transaction wraps the
/// CALLER's writes; the job row itself commits atomically inside this function).
#[allow(clippy::too_many_arguments)]
pub async fn enqueue_job_directly(
    state: &AppState,
    job_type: &str,
    image_id: Uuid,
    page_id: Option<Uuid>,
    chapter_id: Option<Uuid>,
    priority: &str,
    customize: impl FnOnce(&mut serde_json::Map<String, Value>),
) {
    // Trace id: read or create, refreshing the TTL on every hand-off (AUDIT-P8).
    let trace_id = match &state.redis {
        Some(redis) => match redis.get(&format!("pipeline:trace:{image_id}")).await {
            Ok(Some(existing)) => {
                let _ = redis
                    .expire(
                        &format!("pipeline:trace:{image_id}"),
                        PIPELINE_TRACE_TTL_SECS,
                    )
                    .await;
                existing
            }
            _ => {
                let fresh = Uuid::new_v4().to_string();
                let _ = redis
                    .set_ex(
                        &format!("pipeline:trace:{image_id}"),
                        &fresh,
                        PIPELINE_TRACE_TTL_SECS,
                    )
                    .await;
                fresh
            }
        },
        None => Uuid::new_v4().to_string(),
    };

    let job_row_id = Uuid::new_v4().to_string();
    let mut job = serde_json::Map::new();
    job.insert("jobId".into(), json!(job_row_id));
    job.insert("traceId".into(), json!(trace_id));
    job.insert("type".into(), json!(job_type));
    job.insert("imageId".into(), json!(image_id.to_string()));
    job.insert("priority".into(), json!(priority));
    job.insert("attempt".into(), json!(1));
    job.insert("maxAttempts".into(), json!(3));
    job.insert("createdAt".into(), json!(chrono::Utc::now().to_rfc3339()));

    // Resolve the page: explicit id > chapter+image > first page for the image.
    let mut page_opt: Option<Page> = None;
    if let Some(pid) = page_id {
        page_opt = sqlx::query_as("SELECT * FROM pages WHERE id = $1")
            .bind(pid)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
    }
    if page_opt.is_none()
        && let Some(cid) = chapter_id
    {
        page_opt =
            sqlx::query_as("SELECT * FROM pages WHERE chapter_id = $1 AND image_id = $2 LIMIT 1")
                .bind(cid)
                .bind(image_id)
                .fetch_optional(&state.pool)
                .await
                .ok()
                .flatten();
    }
    if page_opt.is_none() {
        page_opt = sqlx::query_as(
            "SELECT * FROM pages WHERE image_id = $1 ORDER BY page_number ASC LIMIT 1",
        )
        .bind(image_id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
    }

    if let Some(page) = &page_opt {
        job.insert("pageId".into(), json!(page.id.to_string()));
        job.insert("chapterId".into(), json!(page.chapter_id.to_string()));

        let chapter: Option<Chapter> = sqlx::query_as("SELECT * FROM chapters WHERE id = $1")
            .bind(page.chapter_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
        if let Some(chapter) = &chapter {
            let series: Option<Series> = sqlx::query_as("SELECT * FROM series WHERE id = $1")
                .bind(chapter.series_id)
                .fetch_optional(&state.pool)
                .await
                .ok()
                .flatten();
            if let Some(series) = &series {
                job.insert(
                    "readingDirection".into(),
                    json!(series.reading_direction.trim().to_lowercase()),
                );
                if let Some(lang) = &series.source_language {
                    job.insert("sourceLanguage".into(), json!(lang.trim().to_lowercase()));
                }
                if let Some(lang) = &series.target_language {
                    job.insert("targetLanguage".into(), json!(lang.trim().to_lowercase()));
                }
                job.insert("pageNumber".into(), json!(page.page_number));
                job.insert("chapterNumber".into(), json!(chapter.chapter_number));
                if let Some(title) = &chapter.title {
                    job.insert("chapterTitle".into(), json!(title));
                }
                job.insert("seriesTitle".into(), json!(series.title));

                let defaults = crate::settings::PipelineDefaults::from_env();
                let settings = load_global_settings(&state.pool, &defaults).await;

                let ch_ocr_provider = chapter.ocr_provider.as_deref();
                let s_ocr_provider = series.ocr_provider.as_deref();
                let resolved_ocr_provider =
                    resolve_model(ch_ocr_provider, s_ocr_provider, &settings.ocr_provider);
                job.insert("ocrProvider".into(), json!(resolved_ocr_provider));

                let global_ocr_model = if resolved_ocr_provider == "local" {
                    settings.local_ocr_model.clone()
                } else {
                    settings.ocr_model.clone()
                };
                job.insert(
                    "ocrModel".into(),
                    json!(crate::resolve::resolve_model_with_check(
                        state,
                        chapter.ocr_model.as_deref(),
                        series.ocr_model.as_deref(),
                        &global_ocr_model,
                        &resolved_ocr_provider,
                        "ocr",
                    )),
                );

                let resolved_tl_provider = resolve_model(
                    chapter.tl_provider.as_deref(),
                    series.tl_provider.as_deref(),
                    &settings.tl_provider,
                );
                job.insert("tlProvider".into(), json!(resolved_tl_provider));
                job.insert(
                    "tlModel".into(),
                    json!(crate::resolve::resolve_model_with_check(
                        state,
                        chapter.tl_model.as_deref(),
                        series.tl_model.as_deref(),
                        &settings.tl_model,
                        &resolved_tl_provider,
                        "tl",
                    )),
                );

                let resolved_qa_provider = resolve_model(
                    chapter.qa_provider.as_deref(),
                    series.qa_provider.as_deref(),
                    &settings.qa_provider,
                );
                job.insert("qaProvider".into(), json!(resolved_qa_provider));

                let resolved_qa_llm = crate::resolve::resolve_model_with_check(
                    state,
                    chapter.qa_llm_model.as_deref(),
                    series.qa_llm_model.as_deref(),
                    &settings.qa_llm_model,
                    &resolved_qa_provider,
                    "qaLLM",
                );
                job.insert("qaLlmModel".into(), json!(resolved_qa_llm.clone()));

                job.insert(
                    "routingStrategy".into(),
                    json!(resolve_model(
                        chapter.routing_strategy.as_deref(),
                        series.routing_strategy.as_deref(),
                        &settings.routing_strategy,
                    )),
                );

                let resolved_qa_vlm = crate::resolve::resolve_model_with_check(
                    state,
                    chapter.qa_vlm_model.as_deref(),
                    series.qa_vlm_model.as_deref(),
                    &settings.qa_vlm_model,
                    &resolved_qa_provider,
                    "qaVLM",
                );
                job.insert("qaVlmModel".into(), json!(resolved_qa_vlm.clone()));

                let mut resolved_qa_mode = resolve_model(
                    chapter.qa_mode.as_deref(),
                    series.qa_mode.as_deref(),
                    &settings.qa_mode,
                );
                let vlm_usable =
                    has_usable_model(state, &resolved_qa_provider, &resolved_qa_vlm, "qaVLM");
                let llm_usable =
                    has_usable_model(state, &resolved_qa_provider, &resolved_qa_llm, "qaLLM");

                // Mode "auto" prefers VLM, falling back to LLM when unsupported; explicit
                // modes also gracefully fall back to the other when unavailable.
                if resolved_qa_mode.eq_ignore_ascii_case("auto") {
                    if vlm_usable {
                        resolved_qa_mode = "vlm".into();
                    } else if llm_usable {
                        resolved_qa_mode = "llm".into();
                    }
                } else if resolved_qa_mode.eq_ignore_ascii_case("vlm") && !vlm_usable && llm_usable
                {
                    tracing::warn!(
                        "VLM mode explicitly requested but not available for provider '{resolved_qa_provider}'. Falling back to LLM."
                    );
                    resolved_qa_mode = "llm".into();
                } else if resolved_qa_mode.eq_ignore_ascii_case("llm") && !llm_usable && vlm_usable
                {
                    tracing::warn!(
                        "LLM mode explicitly requested but not available for provider '{resolved_qa_provider}'. Falling back to VLM."
                    );
                    resolved_qa_mode = "vlm".into();
                }
                job.insert("qaMode".into(), json!(resolved_qa_mode));

                let resolved_fallback = chapter
                    .use_fallback_models
                    .or(series.use_fallback_models)
                    .unwrap_or(settings.use_fallback_models);
                job.insert("useFallbackModels".into(), json!(resolved_fallback));
            }
        }
    }

    customize(&mut job);

    let payload = Value::Object(job).to_string();

    let inserted: Result<(), sqlx::Error> = async {
        sqlx::query(
            "INSERT INTO jobs (id, type, status, image_id, attempt, max_attempts, trace_id, payload, created_at, updated_at) \
             VALUES ($1, $2, 'PENDING', $3, 1, 3, $4, $5, now(), now())",
        )
        .bind(&job_row_id)
        .bind(job_type)
        .bind(image_id)
        .bind(&trace_id)
        .bind(&payload)
        .execute(&state.pool)
        .await?;
        Ok(())
    }
    .await;

    match inserted {
        Ok(()) => {
            // SSE first (Java emitted inside the tx), Redis push after the commit.
            let db_job = JobRowSnapshot {
                id: job_row_id.clone(),
                job_type: job_type.to_string(),
                image_id: Some(image_id),
                trace_id: Some(trace_id),
                payload: Some(payload.clone()),
                status: "PENDING".into(),
                attempt: Some(1),
                max_attempts: Some(3),
                error: None,
                started_at: None,
                created_at: None,
                updated_at: None,
                callback_applied_at: None,
                page_id: page_opt.map(|p| p.id),
            };
            state
                .sse
                .emit_event_for_image(
                    image_id,
                    "job_update",
                    &serde_json::to_string(&db_job).unwrap_or_default(),
                )
                .await;
            push_persisted_job_if_queue_running(state, &job_row_id, job_type, &payload).await;
        }
        Err(err) => tracing::error!("Failed to enqueue {job_type} job for image {image_id}: {err}"),
    }
}

/// Minimal Job-shaped view for SSE serialization right after insert (the full struct
/// round-trip is unnecessary; fields mirror models::Job's camelCase output).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct JobRowSnapshot {
    id: String,
    #[serde(rename = "type")]
    job_type: String,
    image_id: Option<Uuid>,
    page_id: Option<Uuid>,
    attempt: Option<i32>,
    callback_applied_at: Option<chrono::DateTime<chrono::Utc>>,
    created_at: Option<chrono::DateTime<chrono::Utc>>,
    error: Option<String>,
    max_attempts: Option<i32>,
    payload: Option<String>,
    started_at: Option<chrono::DateTime<chrono::Utc>>,
    status: String,
    trace_id: Option<String>,
    updated_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// afterCommit parity: push to the stage queue unless the global pause gate is closed.
pub async fn push_persisted_job_if_queue_running(
    state: &AppState,
    job_id: &str,
    job_type: &str,
    payload: &str,
) {
    let Some(redis) = &state.redis else { return };
    match redis.queue_paused().await {
        Ok(false) => push_job_to_redis(state, job_type, payload).await,
        Ok(true) => {
            tracing::info!("Queue is paused. Job {job_id} saved to DB but not pushed to Redis.")
        }
        Err(err) => tracing::error!("Failed to check queue pause gate for job {job_id}: {err}"),
    }
}

/// RPUSH the payload onto `queue:{type}`.
pub async fn push_job_to_redis(state: &AppState, job_type: &str, payload: &str) {
    if let Some(redis) = &state.redis {
        let queue_name = format!("queue:{job_type}");
        if let Err(err) = redis.push_to_queue(&queue_name, payload).await {
            tracing::error!("Failed to push job onto {queue_name}: {err}");
        }
    }
}

/// Re-pushes every PENDING job after wiping the queues (startup / resume).
pub async fn requeue_pending_jobs(state: &AppState) {
    let Some(redis) = &state.redis else { return };
    for key in HEAVY_QUEUES.into_iter().chain(LIGHT_QUEUES) {
        let _ = redis.delete(key).await;
    }

    let pending: Vec<Job> =
        sqlx::query_as("SELECT * FROM jobs WHERE status = 'PENDING' ORDER BY created_at ASC")
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();
    tracing::info!(
        "Re-queuing {} PENDING jobs onto Redis queues",
        pending.len()
    );
    for job in &pending {
        if let Some(payload) = &job.payload {
            push_job_to_redis(state, &job.job_type, payload).await;
        }
    }
}

/// Rewrites the `attempt` field of a stored payload; returns the original on failure.
pub fn update_payload_attempt(payload: &str, attempt: i32) -> String {
    match serde_json::from_str::<Value>(payload) {
        Ok(mut value) => {
            if let Some(obj) = value.as_object_mut() {
                obj.insert("attempt".into(), json!(attempt));
            }
            value.to_string()
        }
        Err(err) => {
            tracing::error!("Failed to update payload attempt: {err}");
            payload.to_string()
        }
    }
}

fn has_usable_model(state: &AppState, provider: &str, model: &str, task: &str) -> bool {
    let trimmed = model.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("N/A")
        || trimmed == "inherit"
        || trimmed == "default"
        || trimmed.contains("[ORPHANED]")
    {
        return false;
    }
    // An empty cache is permissive (pre-publish deployments still work).
    state
        .providers
        .is_valid_provider_model(provider, trimmed, task)
}

// ---------------------------------------------------------------------------
// Redo triggers
// ---------------------------------------------------------------------------

/// POST /api/ocr-regions/{id}/redo backend: enqueue region-redo-{ocr|tl} with high priority.
pub async fn trigger_redo(
    state: &AppState,
    region_id: Uuid,
    redo_type: &str,
) -> Result<(), String> {
    let region: OcrRegion = sqlx::query_as("SELECT * FROM ocr_regions WHERE id = $1")
        .bind(region_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Region not found: {region_id}"))?;

    let page: Option<Page> = sqlx::query_as("SELECT * FROM pages WHERE id = $1")
        .bind(region.page_id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
    let image_id = page.as_ref().map(|p| p.image_id);
    let page_id = page.as_ref().map(|p| p.id);
    // Region without a page cannot be attributed; Java NPE'd into a 500 here.
    let Some(image_id) = image_id else {
        return Err(format!("Region {region_id} has no page — cannot redo"));
    };

    let job_type = if redo_type.eq_ignore_ascii_case("ocr") {
        "region-redo-ocr"
    } else {
        "region-redo-tl"
    };

    let region_str = region_id.to_string();
    let redo = redo_type.to_string();
    enqueue_job_directly(
        state,
        job_type,
        image_id,
        page_id,
        None,
        "high",
        move |job| {
            job.insert("regionId".into(), json!(region_str));
            job.insert("redoType".into(), json!(redo));
        },
    )
    .await;
    Ok(())
}

fn reason_key_for(job_type: &str, image_id: Uuid) -> Option<(String, &'static str)> {
    match job_type {
        "ocr" => Some((format!("image:ocr:reason:{image_id}"), "manual-re-ocr")),
        "translation" => Some((
            format!("image:translation:reason:{image_id}"),
            "manual-re-translate",
        )),
        _ => None,
    }
}

async fn clear_trace_and_set_reason(state: &AppState, image_id: Uuid, job_type: &str) {
    if let Some(redis) = &state.redis {
        if let Some((key, reason)) = reason_key_for(job_type, image_id) {
            let _ = redis.set_ex(&key, reason, REDO_REASON_TTL_SECS).await;
        }
        let _ = redis.delete(&format!("pipeline:trace:{image_id}")).await;
    }
}

/// Page-scoped redo: same as image redo but keeps the page context pinned.
pub async fn trigger_page_redo(
    state: &AppState,
    page_id: Uuid,
    job_type: &str,
    chapter_id: Option<Uuid>,
) -> Result<(), String> {
    let page: Page = sqlx::query_as("SELECT * FROM pages WHERE id = $1")
        .bind(page_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Page not found: {page_id}"))?;

    clear_trace_and_set_reason(state, page.image_id, job_type).await;

    let effective_chapter = chapter_id.or(Some(page.chapter_id));
    enqueue_job_directly(
        state,
        job_type,
        page.image_id,
        Some(page_id),
        effective_chapter,
        "normal",
        |_| {},
    )
    .await;
    Ok(())
}

/// Image-scoped redo (no page pinning).
pub async fn trigger_image_redo(
    state: &AppState,
    image_id: Uuid,
    job_type: &str,
    chapter_id: Option<Uuid>,
) {
    clear_trace_and_set_reason(state, image_id, job_type).await;
    enqueue_job_directly(
        state,
        job_type,
        image_id,
        None,
        chapter_id,
        "normal",
        |_| {},
    )
    .await;
}

// ---------------------------------------------------------------------------
// Callback handlers
// ---------------------------------------------------------------------------

pub async fn handle_panel_callback(state: &AppState, dto: &Value) -> Result<(), String> {
    let image_id = extract_uuid(dto, "imageId").ok_or("imageId missing")?;
    tracing::info!(
        "Received panel callback for image: {} with {} panels",
        image_id,
        dto.get("panels")
            .and_then(|p| p.as_array())
            .map(Vec::len)
            .unwrap_or(0)
    );

    let job_id = dto.get("jobId").and_then(|v| v.as_str());
    if !claim_callback(state, job_id, image_id, "panel-detection").await {
        return Ok(());
    }

    sqlx::query_as::<_, Image>("SELECT * FROM images WHERE id = $1")
        .bind(image_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Image not found: {image_id}"))?;

    let page = resolve_page_for_callback(&state.pool, image_id, extract_uuid(dto, "pageId")).await;

    let existing_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM panels WHERE image_id = $1")
        .bind(image_id)
        .fetch_one(&state.pool)
        .await
        .unwrap_or(0);

    if existing_count == 0 {
        if let Some(panels) = dto.get("panels").and_then(|p| p.as_array()) {
            for p in panels {
                sqlx::query(
                    "INSERT INTO panels (id, bbox_x, bbox_y, bbox_w, bbox_h, grid_row, grid_col, reading_order, image_id) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                )
                .bind(Uuid::new_v4())
                .bind(p.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32)
                .bind(p.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32)
                .bind(p.get("width").and_then(|v| v.as_i64()).unwrap_or(0) as i32)
                .bind(p.get("height").and_then(|v| v.as_i64()).unwrap_or(0) as i32)
                .bind(p.get("gridRow").and_then(|v| v.as_i64()).map(|v| v as i32))
                .bind(p.get("gridCol").and_then(|v| v.as_i64()).map(|v| v as i32))
                .bind(p.get("readingOrder").and_then(|v| v.as_i64()).unwrap_or(0) as i32)
                .bind(image_id)
                .execute(&state.pool)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
    } else {
        tracing::info!(
            "Image {image_id} already has {existing_count} panels — reusing them instead of re-detecting"
        );
    }

    enqueue_job_directly(
        state,
        "ocr",
        image_id,
        page.map(|p| p.id),
        None,
        "normal",
        |_| {},
    )
    .await;
    Ok(())
}

pub async fn handle_ocr_callback(state: &AppState, dto: &Value) -> Result<(), String> {
    let image_id = extract_uuid(dto, "imageId").ok_or("imageId missing")?;
    tracing::info!(
        "Received OCR callback for image: {} with {} regions",
        image_id,
        dto.get("regions")
            .and_then(|r| r.as_array())
            .map(Vec::len)
            .unwrap_or(0)
    );

    let job_id = dto.get("jobId").and_then(|v| v.as_str());
    if !claim_callback(state, job_id, image_id, "ocr").await {
        return Ok(());
    }

    sqlx::query_as::<_, Image>("SELECT * FROM images WHERE id = $1")
        .bind(image_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Image not found: {image_id}"))?;

    let regions_empty = dto
        .get("regions")
        .and_then(|r| r.as_array())
        .map(Vec::is_empty)
        .unwrap_or(true);
    if regions_empty {
        tracing::info!("OCR found 0 regions for image {image_id} — skipping downstream pipeline");
        if let Some(mut job) = resolve_callback_job(&state.pool, job_id, image_id, "ocr").await {
            sqlx::query("UPDATE jobs SET status='COMPLETED', updated_at=now() WHERE id=$1")
                .bind(&job.id)
                .execute(&state.pool)
                .await
                .map_err(|e| e.to_string())?;
            job.status = "COMPLETED".into();
            state
                .sse
                .emit_event_for_image(
                    image_id,
                    "job_update",
                    &serde_json::to_string(&job).unwrap_or_default(),
                )
                .await;
        }
        return Ok(());
    }

    let page = resolve_page_for_callback(&state.pool, image_id, extract_uuid(dto, "pageId")).await;
    // AUDIT-P9: page deleted mid-pipeline ⇒ fail the job with a reason instead of
    // letting NOT NULL constraints roll the whole result back.
    let Some(page) = page else {
        tracing::warn!(
            "OCR callback for image {image_id} has no page (deleted mid-pipeline?) — failing the job"
        );
        fail_job(
            state,
            job_id,
            image_id,
            "ocr",
            "Page no longer exists — it was deleted while OCR was running",
        )
        .await;
        return Ok(());
    };

    // Hide old OCR layers, compute next z-order.
    let layers: Vec<Layer> = sqlx::query_as("SELECT * FROM layers WHERE page_id = $1")
        .bind(page.id)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    let mut max_z = 0;
    for layer in &layers {
        if layer.z_order > max_z {
            max_z = layer.z_order;
        }
        if layer.layer_type.eq_ignore_ascii_case("ocr") {
            // Keep existing layers for multi-pass history, but hide old OCR ones.
            sqlx::query("UPDATE layers SET visible = FALSE WHERE id = $1")
                .bind(layer.id)
                .execute(&state.pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    let next_z = max_z + 1;

    let panels: Vec<Panel> = sqlx::query_as("SELECT * FROM panels WHERE image_id = $1")
        .bind(image_id)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| e.to_string())?;

    let regions = dto
        .get("regions")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    let mut saved_region_ids: Vec<Uuid> = Vec::with_capacity(regions.len());

    // One transaction around the whole result application (Java @Transactional).
    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
    for r in &regions {
        let rx = r.get("x").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let ry = r.get("y").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let rw = r.get("width").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let rh = r.get("height").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let matching = find_matching_panel(rx, ry, rw, rh, &panels);
        let confidence = r.get("confidence").and_then(|v| v.as_f64());
        let region_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO ocr_regions (id, text, detected_language, confidence, ocr_score, rotation, \
             bbox_x, bbox_y, bbox_w, bbox_h, panel_reading_order, bubble_reading_order, background_color, \
             bubble_x, bubble_y, bubble_w, bubble_h, bubble_id, detection_confidence, mask_polygon, \
             safe_text_x, safe_text_y, safe_text_w, safe_text_h, page_id, panel_id) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)",
        )
        .bind(region_id)
        .bind(r.get("text").and_then(|v| v.as_str()))
        .bind(r.get("detectedLanguage").and_then(|v| v.as_str()).unwrap_or(""))
        .bind(confidence)
        .bind(confidence) // ocr_score mirrors confidence
        .bind(r.get("rotation").and_then(|v| v.as_f64()).or(Some(0.0)))
        .bind(rx)
        .bind(ry)
        .bind(rw)
        .bind(rh)
        .bind(matching.map(|p| p.reading_order))
        .bind(r.get("bubbleReadingOrder").and_then(|v| v.as_i64()).map(|v| v as i32))
        .bind(r.get("backgroundColor").and_then(|v| v.as_str()))
        .bind(r.get("bubbleX").and_then(|v| v.as_i64()).map(|v| v as i32))
        .bind(r.get("bubbleY").and_then(|v| v.as_i64()).map(|v| v as i32))
        .bind(r.get("bubbleWidth").and_then(|v| v.as_i64()).map(|v| v as i32))
        .bind(r.get("bubbleHeight").and_then(|v| v.as_i64()).map(|v| v as i32))
        .bind(r.get("bubbleId").and_then(|v| v.as_str()))
        .bind(r.get("detectionConfidence").and_then(|v| v.as_f64()))
        .bind(mask_polygon_value(r.get("maskPolygon")))
        .bind(r.get("safeTextX").and_then(|v| v.as_i64()).map(|v| v as i32))
        .bind(r.get("safeTextY").and_then(|v| v.as_i64()).map(|v| v as i32))
        .bind(r.get("safeTextW").and_then(|v| v.as_i64()).map(|v| v as i32))
        .bind(r.get("safeTextH").and_then(|v| v.as_i64()).map(|v| v as i32))
        .bind(page.id)
        .bind(matching.map(|p| p.id))
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        saved_region_ids.push(region_id);
    }

    // Default OCR overlay layer + one element per saved region.
    let mut metadata = serde_json::Map::new();
    metadata.insert("provider".into(), json!("OCR Worker"));
    metadata.insert(
        "model".into(),
        json!(
            dto.get("modelIdentifier")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        ),
    );
    metadata.insert("time".into(), json!(chrono::Utc::now().to_rfc3339()));
    metadata.insert(
        "confidence".into(),
        json!(
            dto.get("confidence")
                .and_then(|v| v.as_f64())
                .unwrap_or(1.0)
        ),
    );

    let mut ocr_reason: Option<String> = None;
    if let Some(redis) = &state.redis {
        ocr_reason = redis
            .get(&format!("image:ocr:reason:{image_id}"))
            .await
            .ok()
            .flatten();
        if ocr_reason.is_some() {
            let _ = redis.delete(&format!("image:ocr:reason:{image_id}")).await;
        }
    }
    metadata.insert(
        "layer_name".into(),
        json!(match &ocr_reason {
            Some(reason) => format!("OCR ({reason})"),
            None => "OCR".to_string(),
        }),
    );

    if let Some(cost) = dto.get("cost").filter(|c| !c.is_null()) {
        metadata.insert("cost".into(), cost.clone());
        save_job_costs(
            state,
            image_id,
            dto.get("jobId").and_then(Value::as_str),
            cost,
        )
        .await;
    }

    metadata.insert("layer_order".into(), json!(next_z));
    metadata.insert(
        "last_modified".into(),
        json!(chrono::Utc::now().to_rfc3339()),
    );

    let layer_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO layers (id, type, visible, z_order, metadata_json, page_id, created_at) VALUES ($1,'ocr',TRUE,$2,$3,$4,now())",
    )
    .bind(layer_id)
    .bind(next_z)
    .bind(Value::Object(metadata.clone()))
    .bind(page.id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    for region_id in &saved_region_ids {
        let region: Option<OcrRegion> = sqlx::query_as("SELECT * FROM ocr_regions WHERE id = $1")
            .bind(region_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        let Some(region) = region else { continue };
        sqlx::query(
            "INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, word_wrap, layer_id, region_id) \
             VALUES ($1,$2,$3,$4,$5,$6,TRUE,TRUE,$7,$8)",
        )
        .bind(Uuid::new_v4())
        .bind(&region.text)
        .bind(region.bbox_x as f64)
        .bind(region.bbox_y as f64)
        .bind(region.bbox_w)
        .bind(region.bbox_h)
        .bind(layer_id)
        .bind(region.id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;

    enqueue_job_directly(
        state,
        "layout",
        image_id,
        Some(page.id),
        None,
        "normal",
        |_| {},
    )
    .await;
    Ok(())
}

/// The worker sends maskPolygon as a JSON string; store it as jsonb structure
/// either way (shared normalization lives in models).
fn mask_polygon_value(raw: Option<&Value>) -> Option<Value> {
    crate::models::normalize_mask_polygon(raw?.clone())
}

pub fn find_matching_panel(rx: i32, ry: i32, rw: i32, rh: i32, panels: &[Panel]) -> Option<&Panel> {
    let mut best: Option<(&Panel, f64)> = None;
    for p in panels {
        let overlap_x = (rx + rw)
            .min(p.bbox_x + p.bbox_w)
            .saturating_sub(rx.max(p.bbox_x))
            .max(0);
        let overlap_y = (ry + rh)
            .min(p.bbox_y + p.bbox_h)
            .saturating_sub(ry.max(p.bbox_y))
            .max(0);
        let area = (overlap_x * overlap_y) as f64;
        if area > best.map(|(_, a)| a).unwrap_or(0.0) {
            best = Some((p, area));
        }
    }
    best.map(|(p, _)| p)
}

/// Layout callback: region types, conversations, reader-mode short-circuit.
pub async fn handle_layout_callback(
    state: &AppState,
    job_id: Option<&str>,
    image_id: Uuid,
    callback_page_id: Option<Uuid>,
    payload: &Value,
) -> Result<(), String> {
    if !claim_callback(state, job_id, image_id, "layout").await {
        return Ok(());
    }

    sqlx::query_as::<_, Image>("SELECT * FROM images WHERE id = $1")
        .bind(image_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Image not found: {image_id}"))?;

    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;

    if let Some(region_types) = payload.get("regionTypes").and_then(|v| v.as_array()) {
        for rt in region_types {
            let Some(region_id) = rt
                .get("regionId")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok())
            else {
                continue;
            };
            let region_type = rt
                .get("regionType")
                .and_then(|v| v.as_str())
                .unwrap_or("speech");
            let _ = sqlx::query("UPDATE ocr_regions SET region_type = $2 WHERE id = $1")
                .bind(region_id)
                .bind(region_type)
                .execute(&mut *tx)
                .await;
        }
    }

    let callback_page = resolve_page_for_callback(&state.pool, image_id, callback_page_id).await;

    if let Some(conversations) = payload.get("conversations").and_then(|v| v.as_array()) {
        for conv_data in conversations {
            let scene_type = conv_data
                .get("sceneType")
                .and_then(|v| v.as_str())
                .unwrap_or("dialogue")
                .to_string();
            let conv_id = Uuid::new_v4();
            let Some(page) = &callback_page else { continue };
            if sqlx::query("INSERT INTO conversations (id, scene_type, page_id) VALUES ($1,$2,$3)")
                .bind(conv_id)
                .bind(&scene_type)
                .bind(page.id)
                .execute(&mut *tx)
                .await
                .is_err()
            {
                continue;
            }
            if let Some(region_ids) = conv_data.get("regionIds").and_then(|v| v.as_array()) {
                let mut position = 1;
                for rid in region_ids {
                    if let Some(region_id) = rid.as_str().and_then(|s| Uuid::parse_str(s).ok()) {
                        let pos = position;
                        position += 1;
                        let _ = sqlx::query(
                            "INSERT INTO conversation_regions (conversation_id, region_id, position) VALUES ($1,$2,$3)",
                        )
                        .bind(conv_id)
                        .bind(region_id)
                        .bind(pos)
                        .execute(&mut *tx)
                        .await;
                    }
                }
            }
        }
    }
    tx.commit().await.map_err(|e| e.to_string())?;

    // Reader mode: source==target ends the pipeline here; complete the layout job.
    let series: Option<Series> = match &callback_page {
        Some(page) => {
            let chapter: Option<Chapter> = sqlx::query_as("SELECT * FROM chapters WHERE id = $1")
                .bind(page.chapter_id)
                .fetch_optional(&state.pool)
                .await
                .ok()
                .flatten();
            match chapter {
                Some(ch) => sqlx::query_as("SELECT * FROM series WHERE id = $1")
                    .bind(ch.series_id)
                    .fetch_optional(&state.pool)
                    .await
                    .ok()
                    .flatten(),
                None => None,
            }
        }
        None => None,
    };

    let reader_mode = series.as_ref().is_some_and(|s| {
        s.source_language
            .as_deref()
            .zip(s.target_language.as_deref())
            .map(|(src, tgt)| src.trim().eq_ignore_ascii_case(tgt.trim()))
            .unwrap_or(false)
    });

    if reader_mode {
        if let Some(series) = &series {
            tracing::info!(
                "Reader mode detected (source=target={}) for image {image_id}. Skipping translation, render, and QA.",
                series.source_language.as_deref().unwrap_or("")
            );
        }
        if let Some(mut layout_job) =
            resolve_callback_job(&state.pool, job_id, image_id, "layout").await
        {
            sqlx::query("UPDATE jobs SET status='COMPLETED', updated_at=now() WHERE id=$1")
                .bind(&layout_job.id)
                .execute(&state.pool)
                .await
                .map_err(|e| e.to_string())?;
            layout_job.status = "COMPLETED".into();
            state
                .sse
                .emit_event_for_image(
                    image_id,
                    "job_update",
                    &serde_json::to_string(&layout_job).unwrap_or_default(),
                )
                .await;
        }
        return Ok(());
    }

    enqueue_job_directly(
        state,
        "translation",
        image_id,
        callback_page.map(|p| p.id),
        None,
        "normal",
        |_| {},
    )
    .await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Cost recording
// ---------------------------------------------------------------------------

/// Persists cost entries from a worker cost blob ({breakdown:[...]} or {estimated_cost}).
pub async fn save_job_costs(
    state: &AppState,
    image_id: Uuid,
    job_id: Option<&str>,
    cost_map: &Value,
) {
    let Some(obj) = cost_map.as_object() else {
        return;
    };
    if obj.is_empty() {
        return;
    }
    let entries: Vec<&Value> = match obj.get("breakdown").and_then(|b| b.as_array()) {
        Some(list) => list.iter().collect(),
        None if obj.contains_key("estimated_cost") => vec![cost_map],
        None => Vec::new(),
    };
    for entry in entries {
        let Some(entry_obj) = entry.as_object() else {
            continue;
        };
        let number = |key: &str| entry_obj.get(key).and_then(|v| v.as_i64());
        let float = |key: &str| entry_obj.get(key).and_then(|v| v.as_f64());
        let text = |key: &str| entry_obj.get(key).and_then(|v| v.as_str());
        // The worker sends "" rather than omitting these, and an empty string is not a value —
        // storing it would make `WHERE generation_id IS NULL` miss the rows that have no id.
        let text_opt = |key: &str| text(key).filter(|s| !s.is_empty());
        if let Err(err) = sqlx::query(
            "INSERT INTO job_costs (id, image_id, job_id, provider, model, prompt_tokens, completion_tokens, \
             estimated_cost, generation_id, upstream_provider, cached_tokens, cost_source, stage, duration_ms, created_at) \
             VALUES ($1,$2,(SELECT id FROM jobs WHERE id = $3),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())",
        )
        .bind(Uuid::new_v4())
        .bind(image_id)
        // Resolved through a subquery rather than bound directly: the row carries a foreign key to
        // jobs(id), and a callback can land after its job was cleared. Binding a stale id would
        // fail the whole insert and lose the cost outright; the subquery yields NULL instead, which
        // is exactly what the ON DELETE SET NULL rule would have left behind anyway.
        .bind(job_id.filter(|s| !s.is_empty()))
        .bind(text("provider"))
        .bind(text("model"))
        .bind(number("prompt_tokens").map(|v| v as i32))
        .bind(number("completion_tokens").map(|v| v as i32))
        .bind(float("estimated_cost"))
        .bind(text_opt("generation_id"))
        .bind(text_opt("upstream_provider"))
        .bind(number("cached_tokens").map(|v| v as i32))
        .bind(text_opt("cost_source"))
        .bind(text_opt("stage"))
        .bind(number("duration_ms").map(|v| v as i32))
        .execute(&state.pool)
        .await
        {
            tracing::error!("Error saving job costs for image {image_id}: {err}");
        }
    }
}

/// Persists worker cost entries on a callback's transaction so the callback result, claim, and
/// spend either commit together or all remain retryable.
pub async fn save_job_costs_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    image_id: Uuid,
    job_id: Option<&str>,
    cost_map: &Value,
) -> Result<(), sqlx::Error> {
    let Some(obj) = cost_map.as_object() else {
        return Ok(());
    };
    if obj.is_empty() {
        return Ok(());
    }
    let entries: Vec<&Value> = match obj.get("breakdown").and_then(|b| b.as_array()) {
        Some(list) => list.iter().collect(),
        None if obj.contains_key("estimated_cost") => vec![cost_map],
        None => Vec::new(),
    };
    for entry in entries {
        let Some(entry_obj) = entry.as_object() else {
            continue;
        };
        let number = |key: &str| entry_obj.get(key).and_then(|v| v.as_i64());
        let float = |key: &str| entry_obj.get(key).and_then(|v| v.as_f64());
        let text = |key: &str| entry_obj.get(key).and_then(|v| v.as_str());
        let text_opt = |key: &str| text(key).filter(|s| !s.is_empty());
        sqlx::query(
            "INSERT INTO job_costs (id, image_id, job_id, provider, model, prompt_tokens, completion_tokens, \
             estimated_cost, generation_id, upstream_provider, cached_tokens, cost_source, stage, duration_ms, created_at) \
             VALUES ($1,$2,(SELECT id FROM jobs WHERE id = $3),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())",
        )
        .bind(Uuid::new_v4())
        .bind(image_id)
        .bind(job_id.filter(|s| !s.is_empty()))
        .bind(text("provider"))
        .bind(text("model"))
        .bind(number("prompt_tokens").map(|v| v as i32))
        .bind(number("completion_tokens").map(|v| v as i32))
        .bind(float("estimated_cost"))
        .bind(text_opt("generation_id"))
        .bind(text_opt("upstream_provider"))
        .bind(number("cached_tokens").map(|v| v as i32))
        .bind(text_opt("cost_source"))
        .bind(text_opt("stage"))
        .bind(number("duration_ms").map(|v| v as i32))
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Text-box geometry (Java's TextBox/textBoxFor/freeTextBox)
// ---------------------------------------------------------------------------

const TEXT_BOX_PADDING: i32 = 20;
const MIN_TEXT_BOX: i32 = 24;
const FREE_TEXT_PADDING: i32 = 20;
const FREE_TEXT_COLUMN_ASPECT: f64 = 1.5;
const FREE_TEXT_MAX_WIDEN: f64 = 2.5;
/// Narrowest a free-floating box may be, as a fraction of page width. Below this a column cannot
/// hold an English word at a readable size, so widening earns the artwork it costs; above it,
/// widening only buys line length the column's own height already pays for.
const FREE_TEXT_MIN_WIDTH_FRACTION: f64 = 0.07;

/// Where translated text is laid out, in original image pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextBox {
    pub x: f64,
    pub y: f64,
    pub w: i32,
    pub h: i32,
}

/// True when bubble* describes a container LARGER than the bbox (a real detected
/// bubble rather than the bbox echo the worker fills in for free-floating text).
pub fn has_detected_bubble(region: &OcrRegion) -> bool {
    match (region.bubble_w, region.bubble_h) {
        (Some(bw), Some(bh)) => {
            !(Some(bw) == region.bbox_w.into_option() && Some(bh) == region.bbox_h.into_option())
        }
        _ => false,
    }
}

trait IntoOptionI32 {
    fn into_option(self) -> Option<i32>;
}
impl IntoOptionI32 for i32 {
    fn into_option(self) -> Option<i32> {
        Some(self)
    }
}

async fn page_bounds<'a>(pool: &'a PgPool, region: &'a OcrRegion) -> Option<(i32, i32)> {
    let image: Option<Image> = sqlx::query_as(
        "SELECT i.* FROM images i JOIN pages p ON p.image_id = i.id WHERE p.id = $1",
    )
    .bind(region.page_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    image.and_then(|img| img.width.zip(img.height))
}

/// Geometry source selection — textBoxFor's exact chain: bubble extent/origin when the
/// bubble exists, else safeText, else the bbox (all-or-nothing like Java's null check).
fn geometry_source(region: &OcrRegion) -> (f64, f64, i32, i32) {
    let w = region.bubble_w.or(region.safe_text_w);
    let h = region.bubble_h.or(region.safe_text_h);
    let x = if region.bubble_w.is_some() {
        region.bubble_x
    } else {
        region.safe_text_x
    };
    let y = if region.bubble_h.is_some() {
        region.bubble_y
    } else {
        region.safe_text_y
    };
    match (x, y, w, h) {
        (Some(x), Some(y), Some(w), Some(h)) => (x as f64, y as f64, w, h),
        _ => (
            region.bbox_x as f64,
            region.bbox_y as f64,
            region.bbox_w,
            region.bbox_h,
        ),
    }
}

/// Pure text-box geometry: everything textBoxFor decides given the page bounds.
/// Split from [`text_box_for`] so TextBoxForTest ports as database-free unit tests.
pub fn text_box_geometry(region: &OcrRegion, page: Option<(f64, f64)>) -> TextBox {
    if !has_detected_bubble(region) {
        let (x, y, w, h) = geometry_source(region);
        let half_pad = (FREE_TEXT_PADDING / 2) as f64;
        return free_text_box(
            x - half_pad,
            y - half_pad,
            w + FREE_TEXT_PADDING,
            h + FREE_TEXT_PADDING,
            page,
        );
    }

    let (x, y, w, h) = geometry_source(region);
    // Only inset when there is room; a tiny bubble keeps its full extent.
    let inset_w = w > MIN_TEXT_BOX + TEXT_BOX_PADDING;
    let inset_h = h > MIN_TEXT_BOX + TEXT_BOX_PADDING;
    let half_pad = (TEXT_BOX_PADDING / 2) as f64;

    TextBox {
        x: (x + if inset_w { half_pad } else { 0.0 }).max(0.0),
        y: (y + if inset_h { half_pad } else { 0.0 }).max(0.0),
        w: if inset_w { w - TEXT_BOX_PADDING } else { w },
        h: if inset_h { h - TEXT_BOX_PADDING } else { h },
    }
}

/// Text box for a region: inset into a detected bubble, grown outward + squared up
/// for free-floating columns (Japanese vertical text).
pub async fn text_box_for(pool: &PgPool, region: &OcrRegion) -> TextBox {
    // Java consults page bounds only on the free-text path.
    if has_detected_bubble(region) {
        return text_box_geometry(region, None);
    }
    let page = page_bounds(pool, region)
        .await
        .map(|(pw, ph)| (pw as f64, ph as f64));
    text_box_geometry(region, page)
}

/// Widens a thin vertical column just enough to set English in, keeping the height it already has.
///
/// This used to square the column into a box of equal area — a 91x293 column became 186x187. That
/// trade is backwards: the height was already erased and available, while the width was not, so
/// every pixel of widening bought line length by spending artwork. Measured over the 400-export
/// corpus, it put 329 of 552 free-floating elements' text outside the erased plate, a median 38%
/// of the box width; keeping the height instead leaves 70% of them needing no widening at all, at
/// a median 35px against the squared box's 37px.
///
/// So the height is never touched, and the width grows only for a column too narrow to hold an
/// English word — below `FREE_TEXT_MIN_WIDTH_FRACTION` of the page — still capped at
/// `FREE_TEXT_MAX_WIDEN`. What widening remains is erased along with the column by the renderer,
/// which fills the union of mask and box for a region with no detected bubble.
fn free_text_box(x: f64, y: f64, w: i32, h: i32, page: Option<(f64, f64)>) -> TextBox {
    let unchanged = TextBox {
        x: x.max(0.0),
        y: y.max(0.0),
        w,
        h,
    };
    if w <= 0 || (h as f64) < w as f64 * FREE_TEXT_COLUMN_ASPECT {
        return unchanged;
    }

    // Without page bounds there is no readable-width floor to compare against, so nothing widens.
    let floor = match page {
        Some((page_w, _)) => page_w * FREE_TEXT_MIN_WIDTH_FRACTION,
        None => 0.0,
    };
    let new_w = (w as f64)
        .max(floor.min(w as f64 * FREE_TEXT_MAX_WIDEN))
        .round() as i32;
    if new_w <= w {
        return unchanged;
    }

    // Grow about the column's centre. The height, and therefore `y`, stay exactly as they were.
    let mut nx = x + (w - new_w) as f64 / 2.0;
    match page {
        Some((page_w, _)) => nx = nx.clamp(0.0, (page_w - new_w as f64).max(0.0)),
        None => nx = nx.max(0.0),
    }
    TextBox {
        x: nx,
        y: y.max(0.0),
        w: new_w,
        h,
    }
}

fn contrasting_text_color(hex_color: Option<&str>) -> String {
    let Some(hex) = hex_color else {
        return "#000000".into();
    };
    let body = hex.strip_prefix('#').unwrap_or(hex);
    if hex.len() < 7 || !body.chars().all(|c| c.is_ascii_hexdigit()) || hex.len() != 7 {
        return "#000000".into();
    }
    let parse = |range: std::ops::Range<usize>| u8::from_str_radix(&hex[range], 16);
    match (parse(1..3), parse(3..5), parse(5..7)) {
        (Ok(r), Ok(g), Ok(b)) => {
            let luminance = (0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64) / 255.0;
            if luminance < 0.5 {
                "#ffffff".into()
            } else {
                "#000000".into()
            }
        }
        _ => "#000000".into(),
    }
}

// ---------------------------------------------------------------------------
// Translation / render / QA callbacks
// ---------------------------------------------------------------------------

/// Translation callback. `payload` is the raw translations array plus optional cost map.
pub async fn handle_translation_callback(
    state: &AppState,
    job_id: Option<&str>,
    image_id: Uuid,
    translations: &[Value],
    cost: Option<&Value>,
) -> Result<(), String> {
    tracing::info!(
        "Received Translation callback for image: {} with {} translations",
        image_id,
        translations.len()
    );

    if !claim_callback(state, job_id, image_id, "translation").await {
        return Ok(());
    }

    sqlx::query_as::<_, Image>("SELECT * FROM images WHERE id = $1")
        .bind(image_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Image not found: {image_id}"))?;

    let tl_page_id = translations.first().and_then(|t| extract_uuid(t, "pageId"));
    let page = resolve_page_for_callback(&state.pool, image_id, tl_page_id).await;

    // Series target language decides which translation layers count as "current".
    let mut target_language: Option<String> = None;
    if let Some(page) = &page {
        let chapter: Option<Chapter> = sqlx::query_as("SELECT * FROM chapters WHERE id = $1")
            .bind(page.chapter_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
        if let Some(chapter) = chapter {
            let series: Option<Series> = sqlx::query_as("SELECT * FROM series WHERE id = $1")
                .bind(chapter.series_id)
                .fetch_optional(&state.pool)
                .await
                .ok()
                .flatten();
            target_language = series
                .and_then(|s| s.target_language)
                .map(|lang| lang.trim().to_lowercase());
        }
    }
    let target_language = target_language.unwrap_or_else(|| "en".to_string());

    let success_count = translations
        .iter()
        .filter(|r| !r.get("translationFailed").map(falsy).unwrap_or(false))
        .count();

    // AUDIT-B13: a page with nothing translatable on it is a warning, not a failure.
    //
    // This used to mark the job FAILED, which put a red row in the queue that the user had to
    // dismiss by hand — for pages whose only regions were an SFX, a watermark, or an OCR misfire
    // on a texture. It is also the wrong signal for the retry machinery: the worker has already
    // made up to three attempts per region (batch, batch retry, then individual fallback with the
    // fallback models) before it reports zero successes, so the whole-job retries this triggered
    // were three more rounds of LLM calls that could not produce a different answer.
    //
    // Note this is the *all regions failed* case. Zero regions is handled earlier, and quietly,
    // by the OCR callback — that page never enqueues a translation at all.
    if success_count == 0 {
        tracing::warn!(
            "No region on image {image_id} produced a translation — completing with a warning rather than failing"
        );
        if let Some(mut job) =
            resolve_callback_job(&state.pool, job_id, image_id, "translation").await
        {
            sqlx::query("UPDATE jobs SET status='COMPLETED', error=$2, updated_at=now() WHERE id=$1")
                .bind(&job.id)
                .bind("No translatable text: no region produced a translation")
                .execute(&state.pool)
                .await
                .map_err(|e| e.to_string())?;
            job.status = "COMPLETED".into();
            job.error = Some("No translatable text: no region produced a translation".into());
            state
                .sse
                .emit_event_for_image(
                    image_id,
                    "job_update",
                    &serde_json::to_string(&job).unwrap_or_default(),
                )
                .await;
        }
        state
            .sse
            .emit_notification_for_image(
                image_id,
                "WARNING",
                "No Translatable Text",
                &format!(
                    "Nothing on this page could be translated — all {} detected region(s) came back empty. The page is left as it is.",
                    translations.len()
                ),
                None,
            )
            .await;
        return Ok(());
    }

    // Existing translation layers for this page+language ⇒ this is a redo pass.
    let all_layers: Vec<Layer> = match &page {
        Some(page) => sqlx::query_as("SELECT * FROM layers WHERE page_id = $1")
            .bind(page.id)
            .fetch_all(&state.pool)
            .await
            .map_err(|e| e.to_string())?,
        None => Vec::new(),
    };
    let existing_translation_layers: Vec<&Layer> = all_layers
        .iter()
        .filter(|l| {
            l.layer_type.eq_ignore_ascii_case("translation")
                && l.target_language
                    .as_deref()
                    .map(|l| l.eq_ignore_ascii_case(&target_language))
                    .unwrap_or(false)
        })
        .collect();

    let is_redo = !existing_translation_layers.is_empty();

    // Z-order over ALL layers so the new one is always on top.
    let next_z = all_layers.iter().map(|l| l.z_order).max().unwrap_or(0) + 1;

    // Metadata: provider/model split from "org/model" identifiers, reason labels.
    let first = translations.first().cloned().unwrap_or(Value::Null);
    let model_identifier = first
        .get("modelIdentifier")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let avg_confidence = first
        .get("confidence")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0);
    let (provider_label, model_label) = match model_identifier.split_once('/') {
        Some((provider, model)) => (provider.to_string(), model.to_string()),
        None => ("Translation Worker".to_string(), model_identifier.clone()),
    };

    let mut metadata = serde_json::Map::new();
    metadata.insert("provider".into(), json!(provider_label));
    metadata.insert("model".into(), json!(model_label));
    metadata.insert("time".into(), json!(chrono::Utc::now().to_rfc3339()));
    metadata.insert("confidence".into(), json!(avg_confidence));

    let mut trans_reason: Option<String> = None;
    if let Some(redis) = &state.redis {
        trans_reason = redis
            .get(&format!("image:translation:reason:{image_id}"))
            .await
            .ok()
            .flatten();
        if trans_reason.is_some() {
            let _ = redis
                .delete(&format!("image:translation:reason:{image_id}"))
                .await;
        }
    }
    metadata.insert(
        "layer_name".into(),
        json!(match (&trans_reason, is_redo) {
            (Some(reason), _) => format!("Translation ({reason})"),
            (None, true) => "Translation (retry)".to_string(),
            (None, false) => "Translation".to_string(),
        }),
    );
    metadata.insert("layer_order".into(), json!(next_z));
    metadata.insert(
        "last_modified".into(),
        json!(chrono::Utc::now().to_rfc3339()),
    );

    if let Some(cost) = cost.filter(|c| !c.is_null()) {
        metadata.insert("tl".into(), json!({ "cost": cost }));
        save_job_costs(state, image_id, job_id, cost).await;
    }

    let layer_id = Uuid::new_v4();
    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
    if is_redo {
        // Stand overlays down from newest to oldest before hiding the complete layers. Each
        // overlay restores its predecessor, so this order walks the chain back to the complete
        // layer and leaves that layer intact for a future editor toggle.
        let mut old_layers = existing_translation_layers.clone();
        old_layers.sort_by_key(|layer| std::cmp::Reverse(layer.z_order));
        for old in old_layers.iter().filter(|layer| is_redo_overlay(layer)) {
            sync_superseded_elements(&mut tx, old.id, false)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("UPDATE layers SET visible = FALSE WHERE id = $1")
                .bind(old.id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
        for old in old_layers.iter().filter(|layer| !is_redo_overlay(layer)) {
            sqlx::query("UPDATE layers SET visible = FALSE WHERE id = $1")
                .bind(old.id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    sqlx::query(
        "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, created_at) \
         VALUES ($1,'translation',$2,TRUE,$3,$4,$5,now())",
    )
    .bind(layer_id)
    .bind(&target_language)
    .bind(next_z)
    .bind(Value::Object(metadata.clone()))
    .bind(page.as_ref().map(|p| p.id))
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    for t in translations {
        let Some(region_id) = t
            .get("regionId")
            .and_then(|v| v.as_str())
            .and_then(|s| Uuid::parse_str(s).ok())
        else {
            continue;
        };
        let translated_text = t
            .get("translatedText")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let failed = t.get("translationFailed").map(falsy).unwrap_or(false);
        let score = t.get("translationScore").and_then(|v| v.as_f64());

        // Backward-compatible OcrRegion fields.
        sqlx::query(
            "UPDATE ocr_regions SET translated_text=$2, translation_failed=$3, translation_score=$4 WHERE id=$1",
        )
        .bind(region_id)
        .bind(&translated_text)
        .bind(failed)
        .bind(score)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        // Find or create the LayerElement in THIS layer.
        let existing: Option<crate::models::LayerElement> = sqlx::query_as(
            "SELECT * FROM layer_elements WHERE region_id = $1 AND layer_id = $2 LIMIT 1",
        )
        .bind(region_id)
        .bind(layer_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        let region: Option<OcrRegion> = sqlx::query_as("SELECT * FROM ocr_regions WHERE id = $1")
            .bind(region_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;

        match (existing, &region) {
            (Some(element), Some(region)) => {
                let manually_edited = element.is_manually_edited.unwrap_or(false);
                if manually_edited {
                    // Never touch a hand-tuned layout — text only.
                    sqlx::query("UPDATE layer_elements SET text=$2 WHERE id=$1")
                        .bind(element.id)
                        .bind(&translated_text)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                } else {
                    let box_geom = text_box_for(&state.pool, region).await;
                    sqlx::query(
                        "UPDATE layer_elements SET text=$2, x=$3, y=$4, max_width=$5, max_height=$6, mask_polygon=$7, visible=$8 WHERE id=$1",
                    )
                    .bind(element.id)
                    .bind(&translated_text)
                    .bind(box_geom.x)
                    .bind(box_geom.y)
                    .bind(box_geom.w)
                    .bind(box_geom.h)
                    .bind(&region.mask_polygon)
                    .bind(!failed)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                }
            }
            (_, Some(region)) => {
                let box_geom = text_box_for(&state.pool, region).await;
                // visible = !failed. The worker reports a region it could not translate as
                // translationFailed:true with a null translatedText, having already tried the
                // batch, a retry pass and a per-region fallback. Creating that element visible
                // anyway gave it a mask_polygon and no text, so it erased the artwork and drew
                // nothing back -- the empty bubble. The flag was read and written onto
                // ocr_regions but never consulted here.
                sqlx::query(
                    "INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, auto_size, font, font_weight, \
                     background_color, text_color, box_shape, mask_polygon, word_wrap, layer_id, region_id) \
                     VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,'Comic Neue','bold',$8,$9,$10,$11,TRUE,$12,$13)",
                )
                .bind(Uuid::new_v4())
                .bind(&translated_text)
                .bind(box_geom.x)
                .bind(box_geom.y)
                .bind(box_geom.w)
                .bind(box_geom.h)
                .bind(!failed)
                .bind(&region.background_color)
                .bind(contrasting_text_color(region.background_color.as_deref()))
                .bind(if region.region_type.as_deref().unwrap_or("").eq_ignore_ascii_case("speech") {
                    "elliptical"
                } else {
                    "rectangular"
                })
                .bind(&region.mask_polygon)
                .bind(layer_id)
                .bind(region_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            }
            (Some(element), None) => {
                sqlx::query("UPDATE layer_elements SET text=$2, visible=$3 WHERE id=$1")
                    .bind(element.id)
                    .bind(&translated_text)
                    .bind(!failed)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            (None, None) => {}
        }
    }
    tx.commit().await.map_err(|e| e.to_string())?;

    enqueue_job_directly(
        state,
        "render",
        image_id,
        page.map(|p| p.id),
        None,
        "normal",
        |_| {},
    )
    .await;
    Ok(())
}

fn falsy(value: &Value) -> bool {
    matches!(value, Value::Bool(true))
        || value
            .as_str()
            .map(|s| s.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
}

/// True when this render job was enqueued by QA's own final pass (`finalPass` in its payload).
///
/// Read from the job row rather than threaded through the callback, because the worker's render
/// callback does not echo the payload back. A job that cannot be resolved reads as `false`, which
/// keeps the pre-existing behaviour (run QA) for every job that predates the flag.
async fn is_final_pass_render(state: &AppState, job_id: Option<&str>) -> bool {
    let Some(job_id) = job_id else {
        return false;
    };
    let payload: Option<String> = sqlx::query_scalar("SELECT payload FROM jobs WHERE id = $1")
        .bind(job_id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
    payload
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.get("finalPass").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// Render callback: stamp pages rendered, skip QA when manual edits exist, else queue QA.
pub async fn handle_render_callback(
    state: &AppState,
    job_id: Option<&str>,
    image_id: Uuid,
    page_id: Option<Uuid>,
) -> Result<(), String> {
    if !claim_callback(state, job_id, image_id, "render").await {
        return Ok(());
    }

    let pages: Vec<Page> = match page_id {
        Some(page_id) => sqlx::query_as("SELECT * FROM pages WHERE id = $1")
            .bind(page_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect(),
        None => sqlx::query_as("SELECT * FROM pages WHERE image_id = $1")
            .bind(image_id)
            .fetch_all(&state.pool)
            .await
            .map_err(|e| e.to_string())?,
    };

    for page in &pages {
        sqlx::query("UPDATE pages SET last_rendered_at = now() WHERE id = $1")
            .bind(page.id)
            .execute(&state.pool)
            .await
            .map_err(|e| e.to_string())?;
    }

    let mut manual_changes_done = false;
    for page in &pages {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM layer_elements WHERE is_manually_edited = TRUE AND layer_id IN (SELECT id FROM layers WHERE page_id = $1)",
        )
        .bind(page.id)
        .fetch_one(&state.pool)
        .await
        .unwrap_or(0);
        if count > 0 {
            manual_changes_done = true;
            break;
        }
    }

    // AUDIT-B12: a render QA itself asked for must not queue QA again — that is a render/QA loop
    // with no ceiling. The flag rides on the job payload rather than on Redis so it cannot be lost
    // to an eviction and leave the loop live.
    if is_final_pass_render(state, job_id).await {
        tracing::info!(
            "Received Render callback for image: {image_id}. This was QA's own re-render; not re-running QA."
        );
        if let Some(redis) = &state.redis {
            let _ = redis.delete(&format!("pipeline:trace:{image_id}")).await;
        }
    } else if manual_changes_done {
        tracing::info!(
            "Received Render callback for image: {image_id}. Skipping QA as manual edits exist."
        );
        if let Some(redis) = &state.redis {
            let _ = redis.delete(&format!("pipeline:trace:{image_id}")).await;
        }
    } else {
        tracing::info!("Received Render callback for image: {image_id}. Enqueuing QA job...");
        let qa_page_id = page_id.or_else(|| pages.first().map(|p| p.id));
        let retries = qa_retry_count(state, image_id, qa_page_id).await;
        enqueue_job_directly(
            state,
            "qa",
            image_id,
            qa_page_id,
            None,
            "normal",
            move |job| {
                job.insert("qaPass".into(), json!(retries + 1));
            },
        )
        .await;
    }
    Ok(())
}

/// QA retries are counted per PAGE when known (two chapters sharing a duplicated image
/// must not consume each other's retry budget), per image otherwise.
/// QA retries are counted per PAGE when known (two chapters sharing a duplicated image
/// must not consume each other's retry budget), per image otherwise.
fn qa_retry_key(image_id: Uuid, page_id: Option<Uuid>) -> String {
    match page_id {
        Some(page_id) => format!("page:qa:retries:{page_id}"),
        None => format!("image:qa:retries:{image_id}"),
    }
}

async fn qa_retry_count(state: &AppState, image_id: Uuid, page_id: Option<Uuid>) -> i64 {
    let key = qa_retry_key(image_id, page_id);
    match &state.redis {
        Some(redis) => redis
            .get(&key)
            .await
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
        None => 0,
    }
}

/// QA Re-OCR callback: write corrected text back, then retry translation with the new OCR.
pub async fn handle_qa_re_ocr_callback(
    state: &AppState,
    job_id: Option<&str>,
    image_id: Uuid,
    callback_page_id: Option<Uuid>,
    results: &[Value],
    cost: Option<&Value>,
) -> Result<(), String> {
    tracing::info!(
        "Received QA Re-OCR callback for image: {} with {} results",
        image_id,
        results.len()
    );

    if !claim_callback(state, job_id, image_id, "qa-re-ocr").await {
        return Ok(());
    }

    for r in results {
        let Some(region_id) = r
            .get("regionId")
            .and_then(|v| v.as_str())
            .and_then(|s| Uuid::parse_str(s).ok())
        else {
            continue;
        };
        let text = r.get("text").and_then(|v| v.as_str());
        let confidence = r.get("confidence").and_then(|v| v.as_f64());
        let language = r.get("detectedLanguage").and_then(|v| v.as_str());
        let _ = sqlx::query(
            "UPDATE ocr_regions SET text=COALESCE($2,text), confidence=$3, detected_language=COALESCE($4,detected_language), qa_status='re_ocr_completed' WHERE id=$1",
        )
        .bind(region_id)
        .bind(text)
        .bind(confidence)
        .bind(language)
        .execute(&state.pool)
        .await;
    }

    // The worker attaches this (qa_re_ocr.py), and until now the handler took the callback and
    // dropped the spend on the floor — a cloud re-OCR cost real money and left no row behind.
    if let Some(cost) = cost.filter(|c| !c.is_null()) {
        save_job_costs(state, image_id, job_id, cost).await;
    }

    tracing::info!("QA Re-OCR complete for image {image_id}. Enqueuing translation job...");
    let reocr_page = resolve_page_for_callback(&state.pool, image_id, callback_page_id).await;
    if let Some(redis) = &state.redis {
        let _ = redis
            .set_ex(
                &format!("image:translation:reason:{image_id}"),
                "qa-re-ocr",
                REDO_REASON_TTL_SECS,
            )
            .await;
    }
    enqueue_job_directly(
        state,
        "translation",
        image_id,
        reocr_page.map(|p| p.id),
        None,
        "normal",
        |_| {},
    )
    .await;
    Ok(())
}

/// Hybrid QA first pass (LLM): apply direct fixes / SFX rejections, then fix layer
/// visibility so exactly the newest translation layer shows.
pub async fn prepare_hybrid_qa(
    state: &AppState,
    image_id: Uuid,
    callback_page_id: Option<Uuid>,
    qa_results: &[Value],
) -> Result<(), String> {
    tracing::info!(
        "Preparing hybrid QA for image: {image_id} with {} LLM first pass results",
        qa_results.len()
    );

    let hybrid_page = resolve_page_for_callback(&state.pool, image_id, callback_page_id).await;
    let Some(page) = &hybrid_page else {
        return Ok(());
    };

    // Latest translation layer by z_order (Java compared zOrder for the same purpose).
    let layers: Vec<Layer> = sqlx::query_as("SELECT * FROM layers WHERE page_id = $1")
        .bind(page.id)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    // Skips redo overlays: QA hides everything but the layer it picks, so choosing a one-element
    // overlay would blank every other bubble on the page and leave direct fixes with no element to
    // land on.
    let latest_translation = latest_complete_layer(&layers, "translation").map(|l| l.id);

    for r in qa_results {
        let Some(region_id) = r
            .get("regionId")
            .and_then(|v| v.as_str())
            .and_then(|s| Uuid::parse_str(s).ok())
        else {
            continue;
        };
        let status = r.get("qaStatus").and_then(|v| v.as_str());
        let score = r.get("qaScore").and_then(|v| v.as_f64());
        let feedback = r.get("qaFeedback").and_then(|v| v.as_str());

        if status
            .map(|s| s.eq_ignore_ascii_case("direct_fix"))
            .unwrap_or(false)
            && r.get("directFix").is_some()
        {
            let corrected = r
                .get("directFix")
                .and_then(|df| df.get("correctedText"))
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let font_size = r
                .get("directFix")
                .and_then(|df| df.get("suggestedFontSize"))
                .and_then(|v| v.as_f64());
            let fixed =
                apply_direct_fix(state, region_id, latest_translation, corrected, font_size).await;
            // direct_fix lands as "fixed" (Java overwrote the status after fixing) -- but only
            // when the correction actually reached an element. Stamping "fixed" over a write that
            // did not happen is what let the dropped-bubble bug stay invisible.
            let _ = sqlx::query(
                "UPDATE ocr_regions SET qa_status=$4, qa_score=$2, qa_feedback=$3 WHERE id=$1",
            )
            .bind(region_id)
            .bind(score)
            .bind(feedback)
            .bind(if fixed { "fixed" } else { "failed" })
            .execute(&state.pool)
            .await;
        } else if status
            .map(|s| s.eq_ignore_ascii_case("reject_sfx"))
            .unwrap_or(false)
        {
            hide_translation_elements(state, region_id, latest_translation).await;
            let _ = sqlx::query(
                "UPDATE ocr_regions SET qa_status=$2, qa_score=$3, qa_feedback=$4 WHERE id=$1",
            )
            .bind(region_id)
            .bind(status)
            .bind(score)
            .bind(feedback)
            .execute(&state.pool)
            .await;
        } else {
            let _ = sqlx::query(
                "UPDATE ocr_regions SET qa_status=$2, qa_score=$3, qa_feedback=$4 WHERE id=$1",
            )
            .bind(region_id)
            .bind(status)
            .bind(score)
            .bind(feedback)
            .execute(&state.pool)
            .await;
        }
    }

    // Visibility sweep: newest translation visible, OCR hidden, SFX visible, others kept.
    for layer in &layers {
        // Redo overlays are left exactly as the editor left them. An overlay is paired with the
        // element it superseded — that element is flagged invisible and only
        // `sync_superseded_elements` gives it back — so flipping the layer here would blank the
        // redone bubble instead of reverting it. A stale overlay is not a worry: a fresh full
        // translation pass already hides same-language layers, overlays included, before QA runs.
        let should_be_visible = if is_redo_overlay(layer) {
            layer.visible.unwrap_or(true)
        } else if layer.layer_type.eq_ignore_ascii_case("translation") {
            latest_translation == Some(layer.id)
        } else if layer.layer_type.eq_ignore_ascii_case("ocr") {
            false
        } else if layer.layer_type.eq_ignore_ascii_case("sfx") {
            true
        } else {
            layer.visible.unwrap_or(true)
        };
        if layer.visible.unwrap_or(true) != should_be_visible {
            let _ = sqlx::query("UPDATE layers SET visible=$2 WHERE id=$1")
                .bind(layer.id)
                .bind(should_be_visible)
                .execute(&state.pool)
                .await;
        }
    }
    Ok(())
}

/// Picks the single translation layer QA may change for this region.
///
/// A visible overlay layer is not enough. Older overlays stay visible as layers while their
/// elements are hidden by newer redos. Select the topmost overlay whose element is rendering,
/// then fall back to the newest complete translation layer.
async fn qa_may_edit(
    state: &AppState,
    region_id: Uuid,
    latest_translation: Option<Uuid>,
) -> Option<Uuid> {
    let active_overlay: Option<Uuid> = sqlx::query_scalar(
        "SELECT l.id FROM layers l JOIN layer_elements e ON e.layer_id = l.id \
         WHERE e.region_id = $1 \
           AND l.type ILIKE 'translation' \
           AND COALESCE(l.visible, TRUE) = TRUE \
           AND COALESCE(e.visible, TRUE) = TRUE \
           AND l.metadata_json->>'overlay' = 'true' \
         ORDER BY l.z_order DESC LIMIT 1",
    )
    .bind(region_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();
    if active_overlay.is_some() {
        return active_overlay;
    }

    if latest_translation.is_some() {
        return latest_translation;
    }

    sqlx::query_scalar(
        "SELECT l.id FROM layers l JOIN layer_elements e ON e.layer_id = l.id \
         WHERE e.region_id = $1 \
           AND l.type ILIKE 'translation' \
           AND l.metadata_json->>'overlay' IS DISTINCT FROM 'true' \
         ORDER BY l.z_order DESC LIMIT 1",
    )
    .bind(region_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
}

async fn apply_direct_fix(
    state: &AppState,
    region_id: Uuid,
    latest_translation: Option<Uuid>,
    corrected_text: Option<String>,
    font_size: Option<f64>,
) -> bool {
    let Some(layer_id) = qa_may_edit(state, region_id, latest_translation).await else {
        tracing::warn!(
            "QA direct_fix for region {region_id} matched no translation element — \
             the correction was not applied"
        );
        return false;
    };
    let applied = sqlx::query(
        "UPDATE layer_elements SET text=COALESCE($3,text), size=COALESCE($4,size) \
         WHERE region_id=$1 AND layer_id=$2",
    )
    .bind(region_id)
    .bind(layer_id)
    .bind(corrected_text.as_deref())
    .bind(font_size)
    .execute(&state.pool)
    .await
    .map(|result| result.rows_affected())
    .unwrap_or(0);
    if applied == 0 {
        tracing::warn!(
            "QA direct_fix for region {region_id} found layer {layer_id}, but no element was updated"
        );
        return false;
    }
    if corrected_text.is_some() {
        let _ = sqlx::query("UPDATE ocr_regions SET translated_text=$2 WHERE id=$1")
            .bind(region_id)
            .bind(corrected_text)
            .execute(&state.pool)
            .await;
    }
    true
}

/// Hide typeset text for a region QA judged a sound effect. Hidden, not deleted: an
/// editor may disagree, and the renderer skips invisible elements anyway.
pub async fn hide_translation_elements(
    state: &AppState,
    region_id: Uuid,
    latest_translation: Option<Uuid>,
) {
    let Some(layer_id) = qa_may_edit(state, region_id, latest_translation).await else {
        return;
    };
    let hidden =
        sqlx::query("UPDATE layer_elements SET visible=FALSE WHERE region_id=$1 AND layer_id=$2")
            .bind(region_id)
            .bind(layer_id)
            .execute(&state.pool)
            .await
            .map(|result| result.rows_affected())
            .unwrap_or(0);
    tracing::info!(
        "QA rejected region {region_id} as SFX, hiding {hidden} element(s) on layer {layer_id}"
    );
}

/// Records a redone region as a one-element layer stacked on top, and hides the element it
/// supersedes so the same bubble is not drawn twice.
///
/// Region redo was the one destructive step in a system that otherwise versions everything by
/// layer: a full re-run inserts fresh regions and a new layer, while a redo overwrote
/// `ocr_regions` and the visible layer element in place, so the previous read was simply gone.
/// Losing it is the opposite of what the editor is for.
///
/// An overlay rather than a full copy because every renderer already composites — `render.py`
/// filters elements on `layerVisible` instead of picking a layer, and the reader and the canvas
/// export both iterate every visible layer — so one small layer on top is enough. It also keeps N
/// redos to N small layers instead of N full copies whose visibility has to be reconciled, and
/// they flatten on export for free.
///
/// Returns the new layer's id, or None when there is nothing to supersede (a region with no
/// visible element of this type yet — in that case the in-place write is all there is to do).
pub async fn create_region_redo_overlay(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    region_id: Uuid,
    new_text: Option<&str>,
    layer_type: &str,
    job_id: Option<&str>,
) -> Result<Option<Uuid>, sqlx::Error> {
    let target_language: Option<String> = if layer_type.eq_ignore_ascii_case("translation") {
        sqlx::query_scalar(
            "SELECT COALESCE( \
               (SELECT payload::jsonb->>'targetLanguage' FROM jobs WHERE id = $1), \
               (SELECT s.target_language FROM ocr_regions r \
                JOIN pages p ON p.id = r.page_id \
                JOIN chapters c ON c.id = p.chapter_id \
                JOIN series s ON s.id = c.series_id WHERE r.id = $2) \
             )",
        )
        .bind(job_id)
        .bind(region_id)
        .fetch_one(&mut **tx)
        .await?
    } else {
        None
    };

    // The element being superseded, topmost first. It supplies the geometry and styling the
    // overlay has to reproduce exactly, or the redone bubble would be typeset unlike the one it
    // replaces.
    //
    // Never filtered to visible-only: a bubble is resolved through the region it belongs to, so
    // whichever layers happen to be hidden or stacked over each other cannot change which region a
    // redo lands on. Requiring `visible = TRUE` meant a redo silently did nothing once the user had
    // toggled the layer off — or, on a second redo, once the first had hidden what it replaced.
    //
    // But what is *rendering* wins the tie. Ordering by z_order alone can pick a hidden element
    // that sits above a visible one, and then the update below hides something already invisible
    // while the visible stale text stays underneath the new overlay — old and new composited on top
    // of each other. Visible first, then topmost; hidden matches only when nothing is showing.
    let Some(prev): Option<LayerElement> = sqlx::query_as(
        "SELECT e.* FROM layer_elements e JOIN layers l ON l.id = e.layer_id \
         WHERE e.region_id = $1 AND l.type ILIKE $2 \
           AND ($3::text IS NULL OR LOWER(l.target_language) = LOWER($3)) \
         ORDER BY (e.visible AND l.visible) DESC NULLS LAST, l.z_order DESC LIMIT 1",
    )
    .bind(region_id)
    .bind(layer_type)
    .bind(target_language.as_deref())
    .fetch_optional(&mut **tx)
    .await?
    else {
        // Nothing to supersede — a region with no element of this type yet. Not an error: the
        // in-place write is all there is to do. Distinct from the Err path, which means the write
        // genuinely failed and the caller must not acknowledge the delivery.
        return Ok(None);
    };

    let Some(source_layer): Option<Layer> = sqlx::query_as("SELECT * FROM layers WHERE id = $1")
        .bind(prev.layer_id)
        .fetch_optional(&mut **tx)
        .await?
    else {
        return Ok(None);
    };
    let page_id = source_layer.page_id;

    let next_z: i32 =
        sqlx::query_scalar("SELECT COALESCE(MAX(z_order), -1) + 1 FROM layers WHERE page_id = $1")
            .bind(page_id)
            .fetch_one(&mut **tx)
            .await
            .unwrap_or(0);

    let pretty_type = if layer_type.eq_ignore_ascii_case("translation") {
        "Translation"
    } else {
        "OCR"
    };
    let metadata = json!({
        "layer_name": format!("{pretty_type} (region redo)"),
        // Marks this as a patch, not a full pass. export.rs keeps choosing the full layer as
        // `activeLayer` on the strength of this, because the QA verdict lives in that layer's
        // metadata and an overlay has none.
        "overlay": true,
        "region_id": region_id.to_string(),
        "supersedes_layer": prev.layer_id.to_string(),
        "layer_order": next_z,
        "last_modified": chrono::Utc::now().to_rfc3339(),
    });

    let layer_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, created_at) \
         VALUES ($1,$2,$3,TRUE,$4,$5,$6,now())",
    )
    .bind(layer_id)
    .bind(&source_layer.layer_type)
    .bind(&source_layer.target_language)
    .bind(next_z)
    .bind(&metadata)
    .bind(page_id)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        "INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, auto_size, \
         font, font_style, font_weight, background_color, text_color, box_shape, mask_polygon, \
         word_wrap, rotation, size, layer_id, region_id) \
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
    )
    .bind(Uuid::new_v4())
    .bind(new_text)
    .bind(prev.x)
    .bind(prev.y)
    .bind(prev.max_width)
    .bind(prev.max_height)
    .bind(prev.auto_size)
    .bind(&prev.font)
    .bind(&prev.font_style)
    .bind(&prev.font_weight)
    .bind(&prev.background_color)
    .bind(&prev.text_color)
    .bind(&prev.box_shape)
    .bind(&prev.mask_polygon)
    .bind(prev.word_wrap)
    .bind(prev.rotation)
    .bind(prev.size)
    .bind(layer_id)
    .bind(region_id)
    .execute(&mut **tx)
    .await?;

    let hidden: Vec<Uuid> = sqlx::query_scalar(
        "UPDATE layer_elements SET visible = FALSE \
         WHERE region_id = $1 AND visible = TRUE AND layer_id <> $2 \
           AND layer_id IN ( \
             SELECT id FROM layers WHERE type ILIKE $3 AND visible = TRUE \
               AND ($4::text IS NULL OR LOWER(target_language) = LOWER($4)) \
           ) \
         RETURNING id",
    )
    .bind(region_id)
    .bind(layer_id)
    .bind(layer_type)
    .bind(target_language.as_deref())
    .fetch_all(&mut **tx)
    .await?;

    sqlx::query(
        "UPDATE layers SET metadata_json = jsonb_set(metadata_json::jsonb, '{superseded_elements}', $2::jsonb) WHERE id = $1",
    )
    .bind(layer_id)
    .bind(json!(hidden.iter().map(|i| i.to_string()).collect::<Vec<_>>()))
    .execute(&mut **tx)
    .await?;

    tracing::info!(
        "Region {region_id} redo recorded as overlay layer {layer_id} (z={next_z}), superseding element {} on layer {}",
        prev.id,
        prev.layer_id
    );
    Ok(Some(layer_id))
}

type PredecessorRow = (Option<bool>, Uuid, Option<bool>, Option<Value>);

async fn predecessor_elements(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    layer_id: Uuid,
    ids: &[Uuid],
    exposed_only: bool,
) -> Result<Vec<Uuid>, sqlx::Error> {
    let mut predecessors = Vec::new();
    let mut queue = ids.to_vec();
    let mut seen = Vec::new();
    while let Some(element_id) = queue.pop() {
        if seen.contains(&element_id) {
            continue;
        }
        seen.push(element_id);
        let row: Option<PredecessorRow> = sqlx::query_as(
            "SELECT e.visible, l.id, l.visible, l.metadata_json FROM layer_elements e \
             JOIN layers l ON l.id = e.layer_id WHERE e.id = $1",
        )
        .bind(element_id)
        .fetch_optional(&mut **tx)
        .await?;
        let Some((element_visible, owning_layer, layer_visible, layer_meta)) = row else {
            continue;
        };
        let is_overlay = layer_meta
            .as_ref()
            .and_then(|meta| meta.get("overlay"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let is_target = owning_layer != layer_id
            && if is_overlay {
                layer_visible.unwrap_or(false)
                    && (!exposed_only || element_visible.unwrap_or(false))
            } else {
                true
            };
        if is_target {
            predecessors.push(element_id);
            continue;
        }
        if let Some(meta) = layer_meta
            && let Some(list) = meta.get("superseded_elements").and_then(Value::as_array)
        {
            for id in list.iter().filter_map(Value::as_str) {
                if let Ok(id) = Uuid::parse_str(id) {
                    queue.push(id);
                }
            }
        }
    }
    Ok(predecessors)
}

async fn active_overlay_successor(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    layer_id: Uuid,
    region_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    sqlx::query_scalar(
        "WITH RECURSIVE successor_layers(id) AS ( \
           SELECT candidate.id FROM layers candidate \
           JOIN layer_elements predecessor ON predecessor.layer_id = $1 \
           WHERE candidate.id <> $1 \
             AND candidate.page_id = (SELECT page_id FROM layers WHERE id = $1) \
             AND candidate.metadata_json->>'overlay' = 'true' \
             AND candidate.metadata_json->>'region_id' = $2 \
             AND EXISTS ( \
               SELECT 1 FROM jsonb_array_elements_text( \
                 CASE WHEN jsonb_typeof(candidate.metadata_json->'superseded_elements') = 'array' \
                   THEN candidate.metadata_json->'superseded_elements' ELSE '[]'::jsonb END \
               ) referenced(element_id) \
               WHERE referenced.element_id = predecessor.id::text \
             ) \
           UNION \
           SELECT candidate.id FROM successor_layers previous \
           JOIN layer_elements predecessor ON predecessor.layer_id = previous.id \
           JOIN layers candidate \
             ON candidate.id <> $1 \
            AND candidate.page_id = (SELECT page_id FROM layers WHERE id = $1) \
            AND candidate.metadata_json->>'overlay' = 'true' \
            AND candidate.metadata_json->>'region_id' = $2 \
           WHERE EXISTS ( \
             SELECT 1 FROM jsonb_array_elements_text( \
               CASE WHEN jsonb_typeof(candidate.metadata_json->'superseded_elements') = 'array' \
                 THEN candidate.metadata_json->'superseded_elements' ELSE '[]'::jsonb END \
             ) referenced(element_id) \
             WHERE referenced.element_id = predecessor.id::text \
           ) \
         ) \
         SELECT successor.id FROM successor_layers successor \
         JOIN layers layer ON layer.id = successor.id \
         WHERE layer.visible = TRUE \
           AND EXISTS ( \
             SELECT 1 FROM layer_elements element \
             WHERE element.layer_id = successor.id \
               AND element.region_id = $3 \
               AND element.visible = TRUE \
           ) \
         LIMIT 1",
    )
    .bind(layer_id)
    .bind(region_id.to_string())
    .bind(region_id)
    .fetch_optional(&mut **tx)
    .await
}

/// Keeps a redo overlay and the elements it superseded in step.
///
/// The overlay hides what it replaces so the two do not composite, but that flag lives on the
/// *element*, not on the overlay. Hiding or deleting the overlay therefore left the bubble blank
/// rather than reverting it — the previous reading still in the database and still unreachable.
///
/// `active` is whether the overlay is (about to be) in effect: false when it is being hidden or
/// deleted, true when it is shown again. A no-op for any layer that is not a redo overlay.
///
/// Restoration walks the chain rather than flipping the ids recorded on this layer. Redo twice and
/// the layers chain — base ← A ← B — so standing A down while B is up must not surface the base
/// underneath B, and standing B down afterwards must not stop at A's element when A's own layer is
/// hidden, which would leave the bubble showing nothing at all. Both cases are the same question:
/// what is the newest reading for this region that lives on a layer the user can actually see.
pub async fn sync_superseded_elements(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    layer_id: Uuid,
    active: bool,
) -> Result<(), sqlx::Error> {
    let metadata: Option<Value> =
        sqlx::query_scalar("SELECT metadata_json FROM layers WHERE id = $1")
            .bind(layer_id)
            .fetch_optional(&mut **tx)
            .await?
            .flatten();
    let Some(metadata) = metadata else {
        return Ok(());
    };
    if !metadata
        .get("overlay")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(());
    }
    let ids: Vec<Uuid> = metadata
        .get("superseded_elements")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter_map(|s| Uuid::parse_str(s).ok())
                .collect()
        })
        .unwrap_or_default();
    if ids.is_empty() {
        return Ok(());
    }

    if active {
        // The recorded element may belong to an overlay that is still hidden. Follow that
        // overlay's history until reaching the element that is currently exposed, then hide it.
        let exposed = predecessor_elements(tx, layer_id, &ids, true).await?;
        if exposed.is_empty() {
            return Ok(());
        }
        sqlx::query("UPDATE layer_elements SET visible = FALSE WHERE id = ANY($1)")
            .bind(&exposed)
            .execute(&mut **tx)
            .await?;
        return Ok(());
    }

    let Some(region_id) = metadata
        .get("region_id")
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok())
    else {
        return Ok(());
    };

    // Walk through hidden overlays, but retain a full-layer predecessor even when its layer is
    // hidden. Its element visibility still has to be restored now so showing that layer later
    // brings the reading back.
    let restore = predecessor_elements(tx, layer_id, &ids, false).await?;

    // Follow the recorded replacement chain. z-order is presentation state that users can reorder;
    // it does not say which overlay superseded which.
    if let Some(successor) = active_overlay_successor(tx, layer_id, region_id).await? {
        tracing::info!(
            "Redo overlay {layer_id} stood down, but overlay {successor} still supersedes region {region_id} — leaving its elements hidden"
        );
        return Ok(());
    }

    if restore.is_empty() {
        return Ok(());
    }
    sqlx::query("UPDATE layer_elements SET visible = TRUE WHERE id = ANY($1)")
        .bind(&restore)
        .execute(&mut **tx)
        .await?;
    tracing::info!(
        "Redo overlay {layer_id} stood down — restored {} element(s) for region {region_id}",
        restore.len()
    );
    Ok(())
}

/// Rewrites overlay history before one layer is deleted.
///
/// A successor records element ids, and deleting their owning layer cascades those elements away.
/// Replace each reference to the deleted layer with that layer's own predecessors so later toggles
/// can still reach the surviving history.
pub async fn relink_overlay_successors(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    layer_id: Uuid,
) -> Result<(), sqlx::Error> {
    let metadata: Option<Value> =
        sqlx::query_scalar("SELECT metadata_json FROM layers WHERE id = $1")
            .bind(layer_id)
            .fetch_optional(&mut **tx)
            .await?
            .flatten();
    let Some(metadata) = metadata else {
        return Ok(());
    };
    if !metadata
        .get("overlay")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(());
    }

    let predecessors: Vec<Uuid> = metadata
        .get("superseded_elements")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter_map(|id| Uuid::parse_str(id).ok())
                .collect()
        })
        .unwrap_or_default();
    let owned: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM layer_elements WHERE layer_id = $1")
        .bind(layer_id)
        .fetch_all(&mut **tx)
        .await?;
    if owned.is_empty() {
        return Ok(());
    }

    let successors: Vec<(Uuid, Option<Value>)> = sqlx::query_as(
        "SELECT id, metadata_json FROM layers \
         WHERE id <> $1 \
           AND page_id = (SELECT page_id FROM layers WHERE id = $1) \
           AND metadata_json->>'overlay' = 'true' \
         FOR UPDATE",
    )
    .bind(layer_id)
    .fetch_all(&mut **tx)
    .await?;

    for (successor_id, successor_meta) in successors {
        let Some(mut successor_meta) = successor_meta else {
            continue;
        };
        let Some(recorded) = successor_meta
            .get("superseded_elements")
            .and_then(Value::as_array)
        else {
            continue;
        };
        let mut changed = false;
        let mut rewritten = Vec::new();
        for recorded_id in recorded.iter().filter_map(Value::as_str) {
            let Ok(recorded_id) = Uuid::parse_str(recorded_id) else {
                continue;
            };
            if owned.contains(&recorded_id) {
                changed = true;
                for predecessor in &predecessors {
                    if !rewritten.contains(predecessor) {
                        rewritten.push(*predecessor);
                    }
                }
            } else if !rewritten.contains(&recorded_id) {
                rewritten.push(recorded_id);
            }
        }
        if !changed {
            continue;
        }
        successor_meta["superseded_elements"] =
            json!(rewritten.iter().map(Uuid::to_string).collect::<Vec<_>>());
        if let Some(object) = successor_meta.as_object_mut() {
            object.remove("supersedes_layer");
        }
        sqlx::query("UPDATE layers SET metadata_json = $2 WHERE id = $1")
            .bind(successor_id)
            .bind(successor_meta)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

/// The full QA verdict. Returns one of DUPLICATE / MANUAL_REVIEW / RETRIED /
/// COMPLETED_NO_QA / COMPLETED — the controller turns the last two into SSE notifications.
pub async fn handle_qa_callback(
    state: &AppState,
    job_id: Option<&str>,
    image_id: Uuid,
    callback_page_id: Option<Uuid>,
    qa_results: &[Value],
    cost: Option<&Value>,
) -> Result<&'static str, String> {
    tracing::info!(
        "Received QA callback for image: {} with {} results",
        image_id,
        qa_results.len()
    );

    if !claim_callback(state, job_id, image_id, "qa").await {
        return Ok("DUPLICATE");
    }

    let mut needs_retry = false;
    let mut needs_manual_intervention = false;
    // AUDIT-B12: set when QA rewrote text or hid an element, i.e. when the rendered PNG on disk
    // no longer matches the layers. See the final render pass at the end of this function.
    let mut qa_changed_the_page = false;
    let mut regions_to_re_ocr: Vec<String> = Vec::new();
    let mut failed_regions_list: Vec<Value> = Vec::new();
    // 0 total, 1 passed, 2 failed, 3 fixed/direct_fix, 4 manual_review
    let mut stats = [0i64; 5];
    let mut score_sum = 0.0f64;
    let mut score_count = 0i64;
    let mut discarded_results = 0i64;

    // Latest translation layer by z_order, so a direct_fix edits the layer the reader is looking
    // at rather than every superseded retranslation sharing the region. Same derivation as
    // prepare_hybrid_qa. None (page unresolved) still works: both helpers read it as "any
    // translation layer".
    let qa_page = resolve_page_for_callback(&state.pool, image_id, callback_page_id).await;
    let latest_translation = match &qa_page {
        Some(page) => {
            let layers: Vec<Layer> = sqlx::query_as("SELECT * FROM layers WHERE page_id = $1")
                .bind(page.id)
                .fetch_all(&state.pool)
                .await
                .unwrap_or_default();
            latest_complete_layer(&layers, "translation").map(|l| l.id)
        }
        None => None,
    };

    for r in qa_results {
        // A truncated model response loses its identifying fields; without this guard
        // the counters stayed at zero — which scored as a clean "passed".
        let raw_region_id = r.get("regionId").and_then(|v| v.as_str()).unwrap_or("");
        if raw_region_id.trim().is_empty() {
            discarded_results += 1;
            tracing::warn!(
                "Discarding QA result without a regionId for image {image_id} (likely a truncated model response)"
            );
            continue;
        }
        let Ok(region_id) = Uuid::parse_str(raw_region_id) else {
            discarded_results += 1;
            continue;
        };
        let status_before = r
            .get("qaStatus")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let score = r.get("qaScore").and_then(|v| v.as_f64());
        let feedback = r.get("qaFeedback").and_then(|v| v.as_str());

        let existing: Option<OcrRegion> = sqlx::query_as("SELECT * FROM ocr_regions WHERE id = $1")
            .bind(region_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();

        if let Some(mut region) = existing {
            let mut final_status = status_before.to_string();

            if status_before.eq_ignore_ascii_case("direct_fix") && r.get("directFix").is_some() {
                let corrected = r
                    .get("directFix")
                    .and_then(|df| df.get("correctedText"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                let font_size = r
                    .get("directFix")
                    .and_then(|df| df.get("suggestedFontSize"))
                    .and_then(|v| v.as_f64());
                let fixed =
                    apply_direct_fix(state, region_id, latest_translation, corrected, font_size)
                        .await;
                final_status = if fixed {
                    qa_changed_the_page = true;
                    "fixed".into()
                } else {
                    "failed".into()
                };
            } else if status_before.eq_ignore_ascii_case("failed") && r.get("escalation").is_some()
            {
                let escalation = r.get("escalation").cloned().unwrap_or(Value::Null);
                let flag = |key: &str| {
                    escalation
                        .get(key)
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                };
                if flag("needsManualIntervention") {
                    final_status = "manual_review".into();
                } else if flag("needsReOcr") {
                    regions_to_re_ocr.push(region_id.to_string());
                } else if flag("ocrBad") && escalation.get("correctedSourceText").is_some() {
                    let _ = sqlx::query("UPDATE ocr_regions SET text=$2 WHERE id=$1")
                        .bind(region_id)
                        .bind(
                            escalation
                                .get("correctedSourceText")
                                .and_then(Value::as_str),
                        )
                        .execute(&state.pool)
                        .await;
                }
                if flag("orderBad") && escalation.get("suggestedReadingOrderIndex").is_some() {
                    let order = escalation
                        .get("suggestedReadingOrderIndex")
                        .and_then(Value::as_i64)
                        .unwrap_or(0) as i32;
                    let _ =
                        sqlx::query("UPDATE ocr_regions SET bubble_reading_order=$2 WHERE id=$1")
                            .bind(region_id)
                            .bind(order)
                            .execute(&state.pool)
                            .await;
                    region.bubble_reading_order = Some(order);
                }
            } else if status_before.eq_ignore_ascii_case("reject_sfx") {
                hide_translation_elements(state, region_id, latest_translation).await;
                qa_changed_the_page = true;
            }

            let _ = sqlx::query(
                "UPDATE ocr_regions SET qa_status=$2, qa_score=$3, qa_feedback=$4 WHERE id=$1",
            )
            .bind(region_id)
            .bind(if final_status.is_empty() {
                None
            } else {
                Some(final_status.as_str())
            })
            .bind(score)
            .bind(feedback)
            .execute(&state.pool)
            .await;

            stats[0] += 1;
            match final_status.as_str() {
                s if s.eq_ignore_ascii_case("passed") => stats[1] += 1,
                s if s.eq_ignore_ascii_case("failed") => stats[2] += 1,
                s if s.eq_ignore_ascii_case("fixed") || s.eq_ignore_ascii_case("direct_fix") => {
                    stats[3] += 1
                }
                s if s.eq_ignore_ascii_case("manual_review") => stats[4] += 1,
                _ => {}
            }
            if let Some(score) = score {
                score_sum += score;
                score_count += 1;
            }

            if !final_status.eq_ignore_ascii_case("passed") {
                failed_regions_list.push(json!({
                    "regionId": region_id.to_string(),
                    "bubbleReadingOrder": region.bubble_reading_order,
                    "qaStatus": final_status,
                    "qaScore": score,
                    "qaFeedback": feedback,
                    "escalation": r.get("escalation"),
                }));
            }
        }

        if status_before.eq_ignore_ascii_case("failed") {
            let manual = r
                .get("escalation")
                .and_then(|e| e.get("needsManualIntervention"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if manual {
                needs_manual_intervention = true;
            } else {
                needs_retry = true;
            }
        }
    }

    // A QA pass that scored nothing is not a QA pass.
    let qa_unusable = discarded_results > 0 && stats[0] == 0;
    if qa_unusable {
        tracing::error!(
            "QA produced no usable results for image {image_id} ({discarded_results} discarded). Not reporting a pass."
        );
    }

    let qa_page = resolve_page_for_callback(&state.pool, image_id, callback_page_id).await;
    let qa_page_id = qa_page.as_ref().map(|p| p.id);
    let retries = qa_retry_count(state, image_id, qa_page_id).await;

    // Record the pass on the NEWEST translation layer only (per-cycle results).
    if let Some(page) = &qa_page {
        let newest: Option<Layer> = sqlx::query_as(
            "SELECT * FROM layers WHERE page_id = $1 AND type ILIKE 'translation' ORDER BY created_at DESC LIMIT 1",
        )
        .bind(page.id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();

        if let Some(layer) = newest {
            let mut metadata = layer
                .metadata_json
                .clone()
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default();

            let status = if qa_unusable {
                "error"
            } else if needs_manual_intervention || stats[4] > 0 {
                "manual_review"
            } else if stats[2] > 0 {
                if needs_retry {
                    "partial_pass"
                } else {
                    "failed"
                }
            } else if stats[3] > 0 {
                "partial_pass"
            } else {
                "passed"
            };

            let mut qa_node = serde_json::Map::new();
            qa_node.insert("status".into(), json!(status));
            if discarded_results > 0 {
                qa_node.insert("discarded_results".into(), json!(discarded_results));
            }
            qa_node.insert("total_regions".into(), json!(stats[0]));
            qa_node.insert("passed".into(), json!(stats[1]));
            qa_node.insert("failed".into(), json!(stats[2]));
            qa_node.insert("direct_fix".into(), json!(stats[3]));
            qa_node.insert("manual_review".into(), json!(stats[4]));
            qa_node.insert(
                "avg_score".into(),
                json!(if score_count > 0 {
                    score_sum / score_count as f64
                } else {
                    0.0
                }),
            );
            qa_node.insert("last_qa_at".into(), json!(chrono::Utc::now().to_rfc3339()));
            qa_node.insert("retries_used".into(), json!(retries));
            qa_node.insert(
                "failed_regions".into(),
                Value::Array(failed_regions_list.clone()),
            );
            if let Some(cost) = cost.filter(|c| !c.is_null()) {
                qa_node.insert("cost".into(), cost.clone());
            }
            metadata.insert("qa".into(), Value::Object(qa_node));

            if needs_manual_intervention {
                let current = metadata
                    .get("layer_name")
                    .and_then(Value::as_str)
                    .unwrap_or("Translation")
                    .to_string();
                if !current.contains("qa-manual-review-needed") {
                    metadata.insert(
                        "layer_name".into(),
                        json!(format!("{current} (qa-manual-review-needed)")),
                    );
                }
            }

            let _ = sqlx::query("UPDATE layers SET metadata_json=$2 WHERE id=$1")
                .bind(layer.id)
                .bind(Value::Object(metadata))
                .execute(&state.pool)
                .await;

            if cost.is_some() {
                save_job_costs(state, image_id, job_id, cost.unwrap_or(&Value::Null)).await;
            }
        }
    }

    if needs_manual_intervention {
        tracing::warn!("QA requested manual intervention for image {image_id}. Halting pipeline.");
        if let Some(redis) = &state.redis {
            if let Some(page_id) = qa_page_id {
                let _ = redis.delete(&format!("page:qa:retries:{page_id}")).await;
            }
            let _ = redis.delete(&qa_retry_key(image_id, qa_page_id)).await;
            let _ = redis.delete(&format!("pipeline:trace:{image_id}")).await;
        }
        Ok("MANUAL_REVIEW")
    } else if needs_retry && retries < 2 {
        if let Some(redis) = &state.redis {
            let _ = redis
                .set(
                    &qa_retry_key(image_id, qa_page_id),
                    &(retries + 1).to_string(),
                )
                .await;
        }
        if !regions_to_re_ocr.is_empty() {
            tracing::info!(
                "QA failed for image {image_id} with Re-OCR request. Retry {}/2. Enqueuing qa-re-ocr job...",
                retries + 1
            );
            let payload_regions = regions_to_re_ocr.clone();
            enqueue_job_directly(
                state,
                "qa-re-ocr",
                image_id,
                qa_page_id,
                None,
                "high",
                move |job| {
                    job.insert("regionsToReOcr".into(), json!(payload_regions));
                },
            )
            .await;
        } else {
            tracing::info!(
                "QA failed for image {image_id}. Retry {}/2. Enqueuing translation job...",
                retries + 1
            );
            if let Some(redis) = &state.redis {
                let _ = redis
                    .set_ex(
                        &format!("image:translation:reason:{image_id}"),
                        "qa-re-translate",
                        REDO_REASON_TTL_SECS,
                    )
                    .await;
            }
            enqueue_job_directly(
                state,
                "translation",
                image_id,
                qa_page_id,
                None,
                "normal",
                |_| {},
            )
            .await;
        }
        Ok("RETRIED")
    } else {
        if needs_retry {
            tracing::warn!(
                "QA failed for image {image_id} but reached max retries. Completing pipeline."
            );
        } else if qa_unusable {
            tracing::warn!(
                "QA returned no usable results for image {image_id}. Completing pipeline without a QA verdict."
            );
        } else {
            tracing::info!("QA passed for image {image_id}. Pipeline complete!");
        }
        // AUDIT-B12. The pipeline renders *before* it runs QA — `render` is enqueued in exactly
        // one place, at the end of the translation callback — so until now every QA verdict landed
        // after the only render the page ever got. A `direct_fix` rewrote text that `/rendered`
        // and the chapter ZIP kept showing in its uncorrected form, and a `reject_sfx` hid an
        // element the rendered PNG still had typeset. The reader looked right and the artifact did
        // not, which is the whole of the reported "QA rejections don't reach the output".
        //
        // Only when QA actually changed something, and marked `finalPass` so `handle_render_callback`
        // does not queue QA again off the back of it — that would be an unbounded render/QA loop.
        if qa_changed_the_page {
            tracing::info!(
                "QA changed layers for image {image_id}; re-rendering so the export matches"
            );
            enqueue_job_directly(
                state,
                "render",
                image_id,
                qa_page_id,
                None,
                "normal",
                |job| {
                    job.insert("finalPass".into(), json!(true));
                },
            )
            .await;
        }
        if let Some(redis) = &state.redis {
            let _ = redis.delete(&qa_retry_key(image_id, qa_page_id)).await;
            let _ = redis.delete(&format!("pipeline:trace:{image_id}")).await;
        }
        Ok(if qa_unusable {
            "COMPLETED_NO_QA"
        } else {
            "COMPLETED"
        })
    }
}

// ---------------------------------------------------------------------------
// TextBoxForTest port — pure geometry, no database.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod textbox_tests {
    use super::*;
    use uuid::Uuid;

    /// OcrRegion fixtures via JSON (camelCase, same as the wire shape).
    fn region(value: serde_json::Value) -> OcrRegion {
        serde_json::from_value(value).expect("region fixture")
    }

    /// A region with a real detected bubble: the bubble is strictly larger than the bbox.
    fn bubble_region(bx: i32, by: i32, bw: i32, bh: i32) -> serde_json::Value {
        serde_json::json!({
            "id": Uuid::new_v4(), "pageId": Uuid::new_v4(),
            "detectedLanguage": "ja",
            "bubbleId": "bubble_0",
            "bubbleX": bx, "bubbleY": by, "bubbleW": bw, "bubbleH": bh,
            // The text sits well inside the bubble, as it does when detection fires.
            "bboxX": bx + bw / 4, "bboxY": by + bh / 4, "bboxW": bw / 2, "bboxH": bh / 2,
        })
    }

    /// A free-floating region: the worker copies bubble* from the text bbox.
    fn direct_text_region(x: i32, y: i32, w: i32, h: i32) -> serde_json::Value {
        serde_json::json!({
            "id": Uuid::new_v4(), "pageId": Uuid::new_v4(),
            "detectedLanguage": "ja",
            "bubbleId": "direct_text_0",
            "bubbleX": x, "bubbleY": y, "bubbleW": w, "bubbleH": h,
            "bboxX": x, "bboxY": y, "bboxW": w, "bboxH": h,
            "safeTextX": x, "safeTextY": y, "safeTextW": w, "safeTextH": h,
        })
    }

    #[test]
    fn insets_inside_the_bubble_rather_than_growing_past_it() {
        let box_geom = text_box_geometry(&region(bubble_region(100, 200, 300, 400)), None);
        assert_eq!(box_geom.x, 110.0);
        assert_eq!(box_geom.y, 210.0);
        assert_eq!(box_geom.w, 280);
        assert_eq!(box_geom.h, 380);
        assert!(box_geom.x >= 100.0, "left edge inside bubble");
        assert!(box_geom.y >= 200.0, "top edge inside bubble");
        assert!(
            box_geom.x + box_geom.w as f64 <= 400.0,
            "right edge inside bubble"
        );
        assert!(
            box_geom.y + box_geom.h as f64 <= 600.0,
            "bottom edge inside bubble"
        );
    }

    #[test]
    fn uses_bubble_width_not_the_vertical_japanese_text_extent() {
        let mut r = bubble_region(0, 0, 300, 200);
        // safeText traces the source text: tall and narrow — English must not inherit it.
        r["safeTextX"] = serde_json::json!(120);
        r["safeTextY"] = serde_json::json!(10);
        r["safeTextW"] = serde_json::json!(60);
        r["safeTextH"] = serde_json::json!(180);

        let box_geom = text_box_geometry(&region(r), None);
        assert_eq!(
            box_geom.w, 280,
            "should take the bubble's width, not safeText's 60"
        );
        assert!(
            box_geom.w > box_geom.h,
            "a wide bubble should yield a wide text box"
        );
    }

    #[test]
    fn tiny_bubble_keeps_its_extent_instead_of_collapsing() {
        let box_geom = text_box_geometry(&region(bubble_region(5, 5, 30, 18)), None);
        assert!(
            box_geom.w > 0 && box_geom.h > 0,
            "must never invert to zero or negative"
        );
        assert_eq!(box_geom.w, 30);
        assert_eq!(box_geom.h, 18);
    }

    #[test]
    fn keeps_the_column_height_instead_of_squaring_it_away() {
        // Openrouter ch. 11 p22: a 49x489 caption, padded to 69x509.
        let box_geom = text_box_geometry(
            &region(direct_text_region(71, 675, 49, 489)),
            Some((1000.0, 2000.0)),
        );
        assert_eq!(
            box_geom.h, 509,
            "the column's own height is never traded away"
        );
        assert_eq!(box_geom.y, 665.0, "and so the top edge does not move");
        assert_eq!(
            box_geom.w, 70,
            "69px sits just under the 70px readable floor for a 1000px page"
        );
        assert!(
            box_geom.w < 3 * 49,
            "nowhere near the 173px the equal-area squaring used to produce"
        );
    }

    /// A column already wide enough to set English in is left exactly as it is.
    #[test]
    fn does_not_widen_a_column_that_clears_the_readable_floor() {
        // HKXfexLbAAAN7IE p4's caption: 91x293 on a 1075px page, padded to 111x313.
        let box_geom = text_box_geometry(
            &region(direct_text_region(2, 1005, 91, 293)),
            Some((1075.0, 1518.0)),
        );
        assert_eq!(
            box_geom.w, 111,
            "111px clears the 75px floor, so nothing widens"
        );
        assert_eq!(box_geom.h, 313);
        assert_eq!(box_geom.x, 0.0, "the padded left edge clamps onto the page");
        assert_eq!(box_geom.y, 995.0);
    }

    /// The widening a very narrow column does get is still capped.
    #[test]
    fn caps_the_widening_of_an_extremely_narrow_column() {
        // A 25px column padded to 45px on a 1600px page: the floor asks for 112, the cap allows 112.
        let box_geom = text_box_geometry(
            &region(direct_text_region(400, 200, 25, 300)),
            Some((1600.0, 2000.0)),
        );
        assert_eq!(box_geom.w, 112, "2.5x the padded 45px column");
        assert_eq!(box_geom.h, 320, "height still untouched");
        assert_eq!(
            box_geom.x + box_geom.w as f64 / 2.0,
            412.5,
            "widened about the column's own centre"
        );
    }

    /// Rows written before bubbleId existed are caught by the geometry, not the tag.
    #[test]
    fn treats_bubble_geometry_identical_to_the_bbox_as_no_bubble_at_all() {
        let mut untagged = direct_text_region(1050, 631, 57, 428);
        untagged["bubbleId"] = serde_json::Value::Null;
        // 57 + 20 of padding, taken whole: the free-text path. The bubble path would have inset
        // it to 37 instead, so the width is what tells the two apart.
        assert_eq!(text_box_geometry(&region(untagged), None).w, 77);
    }

    /// Horizontal text is already a shape English fits; reshaping would only move it.
    #[test]
    fn leaves_text_that_is_not_a_vertical_column_alone() {
        let box_geom = text_box_geometry(&region(direct_text_region(100, 100, 540, 120)), None);
        assert_eq!(box_geom.w, 560);
        assert_eq!(box_geom.h, 140);
        assert_eq!(box_geom.x, 90.0);
    }

    /// A column near the edge of the page reshapes onto the paper, not off it.
    #[test]
    fn keeps_a_reshaped_box_on_the_page() {
        let box_geom = text_box_geometry(
            &region(direct_text_region(5, 700, 40, 400)),
            Some((1200.0, 1600.0)),
        );
        assert!(box_geom.x >= 0.0, "left edge on the page");
        assert!(
            box_geom.x + box_geom.w as f64 <= 1200.0,
            "right edge on the page"
        );
        assert!(
            box_geom.y >= 0.0 && box_geom.y + box_geom.h as f64 <= 1600.0,
            "vertically on the page"
        );
        assert_eq!(
            box_geom.h, 420,
            "height carried through the clamp untouched"
        );
    }

    /// The worker's contour fallback can supply a real container for a region YOLO
    /// matched to no bubble; the direct_text tag must not decide this.
    #[test]
    fn insets_a_contour_recovered_bubble_even_though_it_is_still_tagged_direct_text() {
        let mut recovered = direct_text_region(71, 675, 49, 489);
        recovered["bubbleX"] = serde_json::json!(30);
        recovered["bubbleY"] = serde_json::json!(640);
        recovered["bubbleW"] = serde_json::json!(127);
        recovered["bubbleH"] = serde_json::json!(560);

        let box_geom = text_box_geometry(&region(recovered), None);
        assert_eq!(
            box_geom.w, 107,
            "inset into the recovered bubble, not grown past it"
        );
        assert_eq!(box_geom.h, 540);
        assert!(
            box_geom.x >= 30.0 && box_geom.x + box_geom.w as f64 <= 157.0,
            "stays within the recovered bubble"
        );
    }

    /// Absent bubble == synthetic bubble: safeText then bbox both grow rather than inset.
    #[test]
    fn falls_back_to_safe_text_then_bbox_when_bubble_geometry_is_missing() {
        let no_bubble = serde_json::json!({
            "id": Uuid::new_v4(), "pageId": Uuid::new_v4(),
            "detectedLanguage": "ja",
            "safeTextX": 50, "safeTextY": 60, "safeTextW": 200, "safeTextH": 100,
            "bboxX": 0, "bboxY": 0, "bboxW": 999, "bboxH": 999,
        });
        let box_geom = text_box_geometry(&region(no_bubble), None);
        assert_eq!(
            box_geom.w, 220,
            "safeText preferred over bbox when bubble is absent"
        );
        assert_eq!(box_geom.x, 40.0);

        let bbox_only = serde_json::json!({
            "id": Uuid::new_v4(), "pageId": Uuid::new_v4(),
            "detectedLanguage": "ja",
            "bboxX": 10, "bboxY": 10, "bboxW": 120, "bboxH": 120,
        });
        assert_eq!(text_box_geometry(&region(bbox_only), None).w, 140);
    }

    #[test]
    fn never_positions_off_the_top_left_of_the_image() {
        assert!(text_box_geometry(&region(bubble_region(0, 0, 200, 200)), None).x >= 0.0);
        assert!(text_box_geometry(&region(bubble_region(0, 0, 200, 200)), None).y >= 0.0);
        // Free-floating text grows outward — the case that can go negative.
        assert!(text_box_geometry(&region(direct_text_region(0, 0, 200, 200)), None).x >= 0.0);
        assert!(text_box_geometry(&region(direct_text_region(0, 0, 200, 200)), None).y >= 0.0);
    }
}
