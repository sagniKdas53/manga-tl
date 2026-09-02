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
            let payload = job
                .payload
                .as_deref()
                .map(|p| coordinator::update_payload_attempt(p, attempt));
            let _ = sqlx::query(
                "UPDATE jobs SET status='PENDING', started_at=NULL, attempt=$2, payload=COALESCE($3, payload), updated_at=now() WHERE id=$1",
            )
            .bind(&job.id)
            .bind(attempt)
            .bind(payload)
            .execute(&mut *tx)
            .await;
        }
    }
    if let Err(err) = tx.commit().await {
        tracing::error!("Failed to commit processing-job reset: {err}");
    }
}

/// The @Scheduled(fixedRate = 300000) stale sweep.
pub async fn recover_stale_processing_jobs(state: &AppState) {
    let threshold = chrono::Utc::now() - chrono::Duration::minutes(10);
    let stale: Vec<crate::models::Job> =
        sqlx::query_as("SELECT * FROM jobs WHERE status = 'PROCESSING' ORDER BY created_at ASC")
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();

    for job in stale {
        let Some(updated_at) = job.updated_at else {
            continue;
        };
        if updated_at >= threshold {
            continue;
        }
        let attempt = job.attempt.map(|a| a + 1).unwrap_or(1);
        let max_attempts = job.max_attempts.unwrap_or(3);
        tracing::warn!(
            "Recovering stale PROCESSING job {} (attempt {}/{}, last updated at {})",
            job.id,
            attempt,
            max_attempts,
            updated_at
        );
        if attempt > max_attempts {
            let _ = sqlx::query(
                "UPDATE jobs SET status='FAILED', error='Max attempts exhausted after stale recovery', updated_at=now() WHERE id=$1",
            )
            .bind(&job.id)
            .execute(&state.pool)
            .await;
        } else {
            let payload = job
                .payload
                .as_deref()
                .map(|p| coordinator::update_payload_attempt(p, attempt));
            let _ = sqlx::query(
                "UPDATE jobs SET status='PENDING', started_at=NULL, attempt=$2, payload=COALESCE($3,payload), updated_at=now() WHERE id=$1",
            )
            .bind(&job.id)
            .bind(attempt)
            .bind(payload)
            .execute(&state.pool)
            .await;
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

/// DebouncedRenderService port. Pages edited more than 10s ago whose last render is
/// older than their last edit get a debounced render redo.
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
    for page in pages {
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

        tracing::info!("Debounced render triggered for page: {}", page.id);
        if coordinator::trigger_page_redo(state, page.id, "render", None)
            .await
            .is_ok()
        {
            let _ = sqlx::query("UPDATE pages SET last_rendered_at = now() WHERE id = $1")
                .bind(page.id)
                .execute(&state.pool)
                .await;
            triggered += 1;
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
