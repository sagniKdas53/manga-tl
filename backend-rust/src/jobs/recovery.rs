//! Scheduled recovery tasks replacing Spring's @Scheduled pool:
//!   * startup: resetProcessingJobsToPending + (unless paused) requeuePendingJobs
//!   * every 5 min: recoverStaleProcessingJobs — PROCESSING rows silent for 10 min go
//!     back to PENDING (or FAILED once attempts are exhausted) and re-push
//!   * every 5 s: DebouncedRenderService.processPendingRenders — pages edited >10s ago
//!     whose render predates the edit get a render redo (skipped within 5 min of a
//!     recent render failure)
//!   * every 2 min: requeue_orphaned_pending_jobs — PENDING rows that are on no queue at
//!     all go back on one (AUDIT-W13 review)

use std::collections::HashSet;

use crate::jobs::coordinator;
use crate::jobs::{HEAVY_QUEUES, LIGHT_QUEUES};
use crate::state::AppState;
use uuid::Uuid;

/// Boot-time reset of orphaned PROCESSING jobs, in one transaction.
pub async fn reset_processing_jobs_to_pending(state: &AppState) {
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(err) => {
            tracing::error!("Failed to open reset transaction: {err}");
            return;
        }
    };
    let processing: Vec<crate::models::Job> =
        sqlx::query_as("SELECT * FROM jobs WHERE status = 'PROCESSING' ORDER BY created_at ASC")
            .fetch_all(&mut *tx)
            .await
            .unwrap_or_default();

    for job in processing {
        let attempt = job.attempt.map(|a| a + 1).unwrap_or(1);
        let max_attempts = job.max_attempts.unwrap_or(3);
        if attempt > max_attempts {
            tracing::warn!(
                "Startup: Job {} exhausted max attempts ({}/{}), marking FAILED",
                job.id,
                attempt - 1,
                max_attempts
            );
            let _ = sqlx::query(
                "UPDATE jobs SET status='FAILED', error=$2, updated_at=now() WHERE id=$1",
            )
            .bind(&job.id)
            .bind(format!(
                "Max attempts exhausted ({}/{}) on startup",
                attempt - 1,
                max_attempts
            ))
            .execute(&mut *tx)
            .await;
        } else {
            tracing::info!(
                "Resetting processing job {} to PENDING on startup (attempt {}/{})",
                job.id,
                attempt,
                max_attempts
            );
            // Clear started_at: the abandoned attempt's wall-clock must not charge the retry.
            // The fresh lease token is what makes the abandoned attempt harmless if its process
            // is somehow still alive: its headers name the old token, so every status update and
            // every callback it makes from here on is a 409.
            let lease_token = Uuid::new_v4().to_string();
            let payload = job
                .payload
                .as_deref()
                .map(|p| coordinator::update_payload_attempt_and_lease(p, attempt, &lease_token));
            let _ = sqlx::query(
                "UPDATE jobs SET status='PENDING', started_at=NULL, attempt=$2, \
                   payload=COALESCE($3, payload), lease_token=$4, lease_expires_at=NULL, \
                   heartbeat_at=NULL, callback_applied_at=NULL, updated_at=now() \
                 WHERE id=$1",
            )
            .bind(&job.id)
            .bind(attempt)
            .bind(payload)
            .bind(&lease_token)
            .execute(&mut *tx)
            .await;
        }
    }
    if let Err(err) = tx.commit().await {
        tracing::error!("Failed to commit processing-job reset: {err}");
    }
}

/// The @Scheduled(fixedRate = 300000) stale sweep.
///
/// Staleness is now the **lease**, not a flat ten minutes of silence. A worker renews its lease
/// every heartbeat (`JOB_LEASE_SECS`), so a job that is genuinely working — a cleanup page that
/// spends seventeen minutes in CTD — is never swept, while a worker that died is recoverable
/// roughly one lease plus one sweep interval later. That is a bounded window, not a two-minute
/// one: this loop runs every five minutes, so recovery is worst-case ~5 min + the lease, and the
/// handoff is explicit that those two numbers must be read together.
///
/// Rows predating this change (or never started) have no lease; they fall back to the original
/// ten-minute `updated_at` rule so an upgrade does not strand them.
pub async fn recover_stale_processing_jobs(state: &AppState) {
    let legacy_threshold = chrono::Utc::now() - chrono::Duration::minutes(10);
    let now = chrono::Utc::now();
    let stale: Vec<crate::models::Job> =
        sqlx::query_as("SELECT * FROM jobs WHERE status = 'PROCESSING' ORDER BY created_at ASC")
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();

    for job in stale {
        let Some(updated_at) = job.updated_at else {
            continue;
        };
        let expired = match job.lease_expires_at {
            Some(expires_at) => expires_at < now,
            None => updated_at < legacy_threshold,
        };
        if !expired {
            continue;
        }
        // A job whose page has moved on is not recoverable, it is obsolete. Re-arming it would
        // dispatch the stage again — for cleanup, a full CTD pass — against the region list and
        // geometry it was built for, and its callback would then be refused on the generation
        // fence anyway. Up to `max_attempts` runs of that is not a retry, it is waste.
        if let Some(page_id) = job.page_id {
            let page_generation: Option<i32> =
                sqlx::query_scalar("SELECT input_generation FROM pages WHERE id = $1")
                    .bind(page_id)
                    .fetch_optional(&state.pool)
                    .await
                    .ok()
                    .flatten();
            if page_generation.is_some_and(|current| current != job.input_generation) {
                tracing::warn!(
                    "Abandoning stale job {} ({}): its page is at input generation {:?}, the job at {}",
                    job.id,
                    job.job_type,
                    page_generation,
                    job.input_generation
                );
                let _ = sqlx::query(
                    "UPDATE jobs SET status='FAILED', \
                       error='Superseded: the page inputs were replaced while this attempt ran', \
                       updated_at=now() WHERE id=$1 AND status='PROCESSING'",
                )
                .bind(&job.id)
                .execute(&state.pool)
                .await;
                continue;
            }
        }
        let attempt = job.attempt.map(|a| a + 1).unwrap_or(1);
        let max_attempts = job.max_attempts.unwrap_or(3);
        tracing::warn!(
            "Recovering stale PROCESSING job {} (attempt {}/{}, last updated at {}, lease expiry {:?})",
            job.id,
            attempt,
            max_attempts,
            updated_at,
            job.lease_expires_at
        );
        if attempt > max_attempts {
            let _ = sqlx::query(
                "UPDATE jobs SET status='FAILED', error='Max attempts exhausted after stale recovery', updated_at=now() WHERE id=$1",
            )
            .bind(&job.id)
            .execute(&state.pool)
            .await;
        } else {
            // Compare-and-swap on the attempt and lease this sweep observed. A worker that
            // heartbeated between the SELECT above and this UPDATE has already moved the lease
            // on, and this statement then matches nothing rather than yanking a live job back to
            // PENDING underneath it.
            let lease_token = Uuid::new_v4().to_string();
            let payload = job
                .payload
                .as_deref()
                .map(|p| coordinator::update_payload_attempt_and_lease(p, attempt, &lease_token));
            let swapped = sqlx::query(
                "UPDATE jobs SET status='PENDING', started_at=NULL, attempt=$2, \
                   payload=COALESCE($3,payload), lease_token=$4, lease_expires_at=NULL, \
                   heartbeat_at=NULL, callback_applied_at=NULL, updated_at=now() \
                 WHERE id=$1 AND status='PROCESSING' \
                   AND attempt IS NOT DISTINCT FROM $5 AND lease_token IS NOT DISTINCT FROM $6",
            )
            .bind(&job.id)
            .bind(attempt)
            .bind(payload)
            .bind(&lease_token)
            .bind(job.attempt)
            .bind(job.lease_token.as_deref())
            .execute(&state.pool)
            .await;
            if swapped.map(|res| res.rows_affected()).unwrap_or(0) == 0 {
                tracing::info!(
                    "Job {} moved on before the stale sweep could re-arm it; leaving it alone",
                    job.id
                );
                continue;
            }
            // Re-push only when still PENDING (mirrors Java's post-save check).
            if let Some(refreshed) = sqlx::query_as::<_, crate::models::Job>(
                "SELECT * FROM jobs WHERE id = $1 AND status = 'PENDING'",
            )
            .bind(&job.id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
                && let Some(payload) = &refreshed.payload
            {
                coordinator::push_persisted_job_if_queue_running(
                    state,
                    &refreshed.id,
                    &refreshed.job_type,
                    payload,
                )
                .await;
            }
        }
    }
}

/// Queues one immutable render of the page's current scene snapshot, or nothing when that
/// exact revision/digest already has a queued, running or succeeded render.
///
/// `extra` lets the pipeline mark the job (`finalPass`, `completesPipeline`) the way
/// `handle_render_callback` expects; the debounce poller passes nothing. Every cleanup asset the
/// snapshot references is handed to the worker as a presigned URL under `renderAssetUrls`.
pub async fn enqueue_current_snapshot_render(
    state: &AppState,
    page: &crate::models::Page,
    mut extra: serde_json::Map<String, serde_json::Value>,
) -> Result<bool, String> {
    let Some(snapshot) = crate::page_scene::current_snapshot(&state.pool, page.id)
        .await
        .map_err(|err| err.to_string())?
    else {
        tracing::debug!(
            "Page {} revision {} has no immutable scene snapshot; render remains pending",
            page.id,
            page.scene_revision
        );
        return Ok(false);
    };
    let intent: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT payload::jsonb->'requiredRender' FROM jobs WHERE page_id=$1 AND type='qa' \
         AND payload::jsonb->'requiredRender'->>'pageRevision'=$2 \
         AND payload::jsonb->'requiredRender'->>'logicalSceneSha256'=$3 \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(page.id)
    .bind(snapshot.revision.to_string())
    .bind(&snapshot.logical_scene_sha256)
    .fetch_optional(&state.pool)
    .await
    .map_err(|err| err.to_string())?;
    if let Some(intent) = intent {
        for key in ["finalPass", "completesPipeline"] {
            if let Some(value) = intent.get(key).and_then(serde_json::Value::as_bool) {
                extra.insert(key.into(), serde_json::json!(value));
            }
        }
    }
    let mut asset_urls = serde_json::Map::new();
    for (asset_id, path) in
        crate::page_scene_builder::current_asset_paths(&state.pool, page.id, snapshot.revision)
            .await?
    {
        let url = state
            .storage
            .presigned_get_url(&path)
            .await
            .map_err(|err| format!("could not presign scene asset {path}: {err}"))?;
        asset_urls.insert(asset_id, serde_json::json!(url));
    }

    let existing: Option<String> = sqlx::query_scalar(
        "SELECT job_id FROM page_render_jobs \
         WHERE page_id = $1 AND page_revision = $2 AND logical_scene_sha256 = $3 \
           AND status IN ('queued', 'running', 'succeeded') \
         ORDER BY created_at ASC LIMIT 1",
    )
    .bind(page.id)
    .bind(snapshot.revision)
    .bind(&snapshot.logical_scene_sha256)
    .fetch_optional(&state.pool)
    .await
    .map_err(|err| err.to_string())?;

    // The ledger row and the jobs row share one id and are written together by
    // `enqueue_job_with_ledger` (jobs first — the ledger's foreign key requires it).
    if existing.is_some() {
        return Ok(false);
    }
    let job_id = Uuid::new_v4().to_string();

    let revision = snapshot.revision;
    let digest = snapshot.logical_scene_sha256.clone();
    let scene = snapshot.scene_json;
    let ledger = coordinator::RenderLedger {
        page_id: page.id,
        page_revision: revision,
        logical_scene_sha256: digest.clone(),
    };
    let persisted = coordinator::enqueue_job_with_ledger(
        state,
        "render",
        page.image_id,
        Some(page.id),
        Some(page.chapter_id),
        "normal",
        move |job| {
            job.insert("jobId".into(), serde_json::json!(job_id));
            job.insert("pageRevision".into(), serde_json::json!(revision));
            job.insert("logicalSceneSha256".into(), serde_json::json!(digest));
            job.insert("logicalScene".into(), scene);
            job.insert(
                "renderAssetUrls".into(),
                serde_json::Value::Object(asset_urls),
            );
            for (key, value) in extra {
                job.insert(key, value);
            }
        },
        Some(ledger),
    )
    .await;
    if !persisted {
        return Err(format!(
            "render job for page {} revision {revision} was not persisted",
            page.id
        ));
    }
    Ok(true)
}

/// Pages whose scene could not be built, with when that happened. A page that cannot be
/// snapshotted (no image hash, invalid rows) would otherwise be retried every 5 s with the same
/// error; it waits five minutes instead, like a failed render job does.
static SNAPSHOT_BACKOFF: std::sync::Mutex<
    Option<std::collections::HashMap<Uuid, std::time::Instant>>,
> = std::sync::Mutex::new(None);

fn snapshot_backoff_active(page_id: Uuid) -> bool {
    let mut guard = SNAPSHOT_BACKOFF
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let map = guard.get_or_insert_with(Default::default);
    map.retain(|_, at| at.elapsed() < std::time::Duration::from_secs(300));
    map.contains_key(&page_id)
}

fn snapshot_backoff_record(page_id: Uuid) {
    let mut guard = SNAPSHOT_BACKOFF
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard
        .get_or_insert_with(Default::default)
        .insert(page_id, std::time::Instant::now());
}

/// DebouncedRenderService port. Pages edited more than 10s ago whose last render is
/// older than their last edit get a debounced render redo.
///
/// A page whose current revision has no immutable snapshot gets one built here from its rows
/// (`page_scene_builder`) before the render is queued. That is what editor edits rely on: the
/// layer routes advance the revision in their own transaction and leave the snapshot to this
/// debounce, so a burst of drags produces one snapshot and one render. Pipeline callbacks
/// snapshot immediately and this loop then finds the render already queued.
///
/// Before the 2026-09-17 realignment this loop selected the same pages, found no snapshot for
/// any of them (nothing on the live path wrote one), queued nothing, and logged "Debounced
/// render triggered" every 5 s per page — 3,130 lines and zero renders in one afternoon's
/// `logs/run-1.log`.
pub async fn process_pending_renders(state: &AppState) {
    let threshold = chrono::Utc::now() - chrono::Duration::seconds(10);
    // findPagesNeedingRender: last_edited_at < threshold AND (last_rendered_at IS NULL
    // OR last_edited_at > last_rendered_at).
    let pages: Vec<crate::models::Page> = sqlx::query_as(
        "SELECT * FROM pages \
         WHERE last_edited_at IS NOT NULL AND last_edited_at < $1 \
           AND (last_rendered_at IS NULL OR last_edited_at > last_rendered_at)",
    )
    .bind(threshold)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    if pages.is_empty() {
        return;
    }

    let mut triggered = 0usize;
    for mut page in pages {
        if snapshot_backoff_active(page.id) {
            continue;
        }
        // Skip when a render failed within the last five minutes for this image.
        let last_render: Option<crate::models::Job> = sqlx::query_as(
            "SELECT * FROM jobs WHERE image_id = $1 AND type = 'render' ORDER BY created_at DESC LIMIT 1",
        )
        .bind(page.image_id)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);
        if let Some(job) = &last_render
            && job.status == "FAILED"
            && job
                .updated_at
                .map(|at| at > chrono::Utc::now() - chrono::Duration::minutes(5))
                .unwrap_or(false)
        {
            continue;
        }

        let has_snapshot = crate::page_scene::current_snapshot(&state.pool, page.id)
            .await
            .ok()
            .flatten()
            .is_some();
        if !has_snapshot {
            let built = async {
                let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
                let (snapshot, _) =
                    crate::page_scene_builder::snapshot_pipeline_scene(state, &mut tx, page.id)
                        .await?;
                tx.commit().await.map_err(|e| e.to_string())?;
                Ok::<i32, String>(snapshot.revision)
            }
            .await;
            match built {
                Ok(revision) => {
                    tracing::info!(
                        "Snapshotted page {} as revision {revision} for its debounced render",
                        page.id
                    );
                    page.scene_revision = revision;
                }
                Err(err) => {
                    tracing::error!(
                        "Could not build a scene for page {}: {err}; retrying in five minutes",
                        page.id
                    );
                    snapshot_backoff_record(page.id);
                    continue;
                }
            }
        }

        match enqueue_current_snapshot_render(state, &page, serde_json::Map::new()).await {
            Ok(true) => {
                triggered += 1;
                tracing::info!("Debounced render enqueued for page: {}", page.id);
            }
            Ok(false) => {}
            Err(err) => tracing::error!("Could not queue render for page {}: {err}", page.id),
        }
    }
    if triggered > 0 {
        tracing::info!("Enqueued {triggered} debounced render jobs");
    }
}

/// ApplicationReadyEvent parity: reset orphans, then requeue unless globally paused.
pub async fn run_startup_recovery(state: AppState) {
    reset_processing_jobs_to_pending(&state).await;

    let paused = match state.redis.as_ref() {
        Some(redis) => redis
            .get("system:queue:paused")
            .await
            .ok()
            .flatten()
            .unwrap_or_default(),
        None => String::new(),
    };
    if paused != "true" {
        coordinator::requeue_pending_jobs(&state).await;
    } else {
        tracing::info!("Queue is globally paused. Skipping requeue.");
    }
}

/// HealthReporter.reportHealth — every 5 minutes, log queue depth and prove Redis is
/// answering by round-tripping the `health:ping` key.
///
/// This was dropped in the port. Nothing outside the backend reads `health:ping`, so no
/// consumer broke, but the periodic queue-depth line is the only place a stuck pipeline
/// shows up in the logs without someone querying Postgres by hand — the Java service
/// logged it every 5 minutes and operators read it that way.
pub async fn report_health(state: &AppState) {
    let counts: (i64, i64, i64) = sqlx::query_as(
        "SELECT \
           COUNT(*) FILTER (WHERE status = 'PENDING'), \
           COUNT(*) FILTER (WHERE status = 'PROCESSING'), \
           COUNT(*) FILTER (WHERE status = 'FAILED') \
         FROM jobs",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap_or((0, 0, 0));
    let (pending, processing, failed) = counts;

    // Java wrote then re-read the key and reported DOWN when either half failed or the
    // value came back wrong; a bare PING would not catch a read-only replica.
    let redis = match state.redis.as_ref() {
        None => "DOWN",
        Some(redis) => match redis.set("health:ping", "pong").await {
            Ok(()) => match redis.get("health:ping").await {
                Ok(Some(value)) if value == "pong" => "OK",
                _ => "DOWN",
            },
            Err(_) => "DOWN",
        },
    };

    tracing::info!(
        "Health: queue[pending={pending}, processing={processing}, failed={failed}] redis={redis}"
    );
}

/// Re-push PENDING jobs that are on no Redis queue.
///
/// A job is inserted PENDING and then pushed onto its queue as two separate steps. If the push
/// fails — a transient Redis error, a connection dropped between the two — the row stays PENDING
/// forever with nothing to pick it up: `recover_stale_processing_jobs` only looks at PROCESSING,
/// and `requeue_pending_jobs` only runs at startup or on resume.
///
/// That hole predates the ordering gate, but the gate makes it much worse. Before, an orphaned
/// job meant one page never finished. Now, if that page belongs to a chapter with context
/// injection on, `earlier_page_is_still_translating` counts it as an outstanding predecessor and
/// **every later page of the chapter waits behind it** — indefinitely, even after Redis recovers.
///
/// `started_at IS NULL` is what separates orphaned from in-flight: the dispatcher stamps it on a
/// 202, so a row that has one is at a worker rather than lost. There is a millisecond window
/// between the dispatcher popping a job and stamping it in which this sweep could re-push a job
/// that is fine; the duplicate is harmless, because the worker re-reads the job's status before
/// processing and skips anything no longer PENDING.
pub async fn requeue_orphaned_pending_jobs(state: &AppState) {
    let Some(redis) = &state.redis else { return };
    // While paused, PENDING rows are *meant* to be off the queues — requeue_pending_jobs puts them
    // back on resume. An unreadable pause gate reads as paused, so a Redis wobble cannot make this
    // sweep flood the queues.
    if redis.queue_paused().await.unwrap_or(true) {
        return;
    }

    let mut queued: HashSet<String> = HashSet::new();
    for queue in HEAVY_QUEUES.into_iter().chain(LIGHT_QUEUES) {
        for entry in redis.list_range(queue).await.unwrap_or_default() {
            if let Some(id) = serde_json::from_str::<serde_json::Value>(&entry)
                .ok()
                .and_then(|value| {
                    value
                        .get("jobId")
                        .and_then(|id| id.as_str())
                        .map(str::to_string)
                })
            {
                queued.insert(id);
            }
        }
    }

    // The grace period keeps this off the heels of an enqueue that is still in progress.
    let orphaned: Vec<crate::models::Job> = sqlx::query_as(
        "SELECT * FROM jobs WHERE status = 'PENDING' AND started_at IS NULL \
           AND updated_at < now() - interval '2 minutes' ORDER BY created_at ASC",
    )
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let mut requeued = 0usize;
    for job in orphaned {
        if queued.contains(&job.id) {
            continue;
        }
        let Some(payload) = job.payload.as_deref() else {
            continue;
        };
        tracing::warn!(
            "Job {} ({}) is PENDING but on no queue — re-pushing",
            job.id,
            job.job_type
        );
        coordinator::push_job_to_redis(state, &job.job_type, payload).await;
        requeued += 1;
    }
    if requeued > 0 {
        tracing::info!("Re-pushed {requeued} orphaned PENDING job(s) onto their queues");
    }
}
