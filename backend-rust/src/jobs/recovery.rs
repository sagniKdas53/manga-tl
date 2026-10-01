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
            // The same compare-and-swap as the re-arm below: a heartbeat or a callback that
            // landed after this sweep read the row must not be overwritten with FAILED.
            let _ = sqlx::query(
                "UPDATE jobs SET status='FAILED', error='Max attempts exhausted after stale recovery', \
                   updated_at=now() \
                 WHERE id=$1 AND status='PROCESSING' \
                   AND attempt IS NOT DISTINCT FROM $2 AND lease_token IS NOT DISTINCT FROM $3 \
                   AND lease_expires_at IS NOT DISTINCT FROM $4",
            )
            .bind(&job.id)
            .bind(job.attempt)
            .bind(job.lease_token.as_deref())
            .bind(job.lease_expires_at)
            .execute(&state.pool)
            .await;
        } else {
            // Compare-and-swap on the attempt, lease token and lease expiry this sweep observed.
            // A heartbeat renews lease_expires_at, not the token: without the expiry in the
            // compare, a worker that heartbeated between the SELECT above and this UPDATE was
            // yanked back to PENDING underneath it and its result refused as stale. With it, the
            // statement matches nothing and the live job is left alone.
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
                   AND attempt IS NOT DISTINCT FROM $5 AND lease_token IS NOT DISTINCT FROM $6 \
                   AND lease_expires_at IS NOT DISTINCT FROM $7",
            )
            .bind(&job.id)
            .bind(attempt)
            .bind(payload)
            .bind(&lease_token)
            .bind(job.attempt)
            .bind(job.lease_token.as_deref())
            .bind(job.lease_expires_at)
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
    // A final-pass render is asked for by a QA callback, or by a late-patch cleanup
    // (`coordinator::queue_late_patches`); either way a re-queued render must not queue QA.
    let intent: Option<serde_json::Value> = sqlx::query_scalar(
        "SELECT payload::jsonb->'requiredRender' FROM jobs WHERE page_id=$1 \
         AND type IN ('qa', 'cleanup') \
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
            .presigned_job_url(&path)
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

/// Serves the page's current snapshot from the render it already has when the two draw the same
/// thing ([`crate::page_scene::scene_content_digest`]), instead of queueing a render.
///
/// A revision can advance without anything drawable changing: a settings save that re-wrote the
/// defaults bumped every page in the library on 2026-09-30, and the sweep queued 650 renders,
/// each followed by a paid QA pass. Clearing the queue did not help, because the pages stayed
/// dirty and the next sweep queued them again. Here the old artifact is filed under the new
/// revision (a COMPLETED render job and a succeeded ledger row pointing at the same PNG), so the
/// page is current, the reader and exports find it, and no render or QA runs.
///
/// Only the debounce sweep calls this. It declines when a render is already queued, running or
/// done for this revision, and when a QA job is waiting on a render of it: those renders carry
/// pipeline intent (final pass, completion) that a reused artifact would drop.
pub(crate) async fn reuse_unchanged_render(
    state: &AppState,
    page: &crate::models::Page,
) -> Result<bool, String> {
    let Some(snapshot) = crate::page_scene::current_snapshot(&state.pool, page.id)
        .await
        .map_err(|err| err.to_string())?
    else {
        return Ok(false);
    };
    let pending: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM page_render_jobs WHERE page_id = $1 AND page_revision = $2 \
                          AND status IN ('queued', 'running', 'succeeded')) \
             OR EXISTS (SELECT 1 FROM jobs WHERE page_id = $1 AND type = 'qa' \
                          AND status IN ('PENDING', 'PROCESSING') \
                          AND payload::jsonb->'requiredRender'->>'pageRevision' = $3)",
    )
    .bind(page.id)
    .bind(snapshot.revision)
    .bind(snapshot.revision.to_string())
    .fetch_one(&state.pool)
    .await
    .map_err(|err| err.to_string())?;
    if pending {
        return Ok(false);
    }

    // The artifact the page shows now, with the scene it was drawn from.
    let previous: Option<(String, serde_json::Value)> = sqlx::query_as(
        "SELECT render.job_id, snapshot.scene_json \
         FROM pages page \
         JOIN page_render_jobs render ON render.job_id = page.current_render_job_id \
         JOIN page_scene_snapshots snapshot \
           ON snapshot.page_id = render.page_id AND snapshot.revision = render.page_revision \
         WHERE page.id = $1 AND render.status = 'succeeded' \
           AND render.rendered_png_storage_path IS NOT NULL",
    )
    .bind(page.id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|err| err.to_string())?;
    let Some((previous_job_id, previous_scene)) = previous else {
        return Ok(false);
    };
    let same = crate::page_scene::scene_content_digest(&previous_scene)
        .and_then(|old| {
            crate::page_scene::scene_content_digest(&snapshot.scene_json).map(|new| old == new)
        })
        .unwrap_or(false);
    if !same {
        return Ok(false);
    }

    let job_id = Uuid::new_v4().to_string();
    let payload = serde_json::json!({
        "jobId": job_id,
        "type": "render",
        "imageId": page.image_id.to_string(),
        "pageId": page.id.to_string(),
        "chapterId": page.chapter_id.to_string(),
        "pageRevision": snapshot.revision,
        "logicalSceneSha256": snapshot.logical_scene_sha256,
        "reusedRenderJobId": previous_job_id,
    })
    .to_string();
    let mut tx = state.pool.begin().await.map_err(|err| err.to_string())?;
    sqlx::query(
        "INSERT INTO jobs (id, type, status, image_id, page_id, attempt, max_attempts, payload, \
                           input_generation, created_at, updated_at) \
         VALUES ($1, 'render', 'COMPLETED', $2, $3, 1, 3, $4, $5, now(), now())",
    )
    .bind(&job_id)
    .bind(page.image_id)
    .bind(page.id)
    .bind(&payload)
    .bind(page.input_generation)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    sqlx::query(
        "INSERT INTO page_render_jobs \
         (job_id, page_id, page_revision, logical_scene_sha256, rendered_png_sha256, \
          rendered_png_storage_path, renderer_build_sha256, browser_build_sha256, status, \
          diagnostics_json, layout_json, completed_at) \
         SELECT $1, page_id, $2, $3, rendered_png_sha256, rendered_png_storage_path, \
                renderer_build_sha256, browser_build_sha256, 'succeeded', diagnostics_json, \
                layout_json, now() \
         FROM page_render_jobs WHERE job_id = $4",
    )
    .bind(&job_id)
    .bind(snapshot.revision)
    .bind(&snapshot.logical_scene_sha256)
    .bind(&previous_job_id)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    let pointed = sqlx::query(
        "UPDATE pages SET current_render_job_id = $1, last_rendered_at = now() \
         WHERE id = $2 AND scene_revision = $3",
    )
    .bind(&job_id)
    .bind(page.id)
    .bind(snapshot.revision)
    .execute(&mut *tx)
    .await
    .map_err(|err| err.to_string())?;
    if pointed.rows_affected() == 0 {
        // Edited again since the snapshot; the next sweep handles the newer revision.
        tx.rollback().await.map_err(|err| err.to_string())?;
        return Ok(false);
    }
    tx.commit().await.map_err(|err| err.to_string())?;
    let _ = sqlx::query("UPDATE images SET last_rendered_at = now() WHERE id = $1")
        .bind(page.image_id)
        .execute(&state.pool)
        .await;

    if let Ok(Some(job)) =
        sqlx::query_as::<_, crate::models::Job>("SELECT * FROM jobs WHERE id = $1")
            .bind(&job_id)
            .fetch_optional(&state.pool)
            .await
    {
        state
            .sse
            .emit_event_for_image(
                page.image_id,
                "job_update",
                &serde_json::to_string(&job).unwrap_or_default(),
            )
            .await;
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

/// How long a page must sit unedited before its debounced render (`RENDER_DEBOUNCE_SECONDS`,
/// default 30). A burst of edits renders once, after the last of them.
pub fn render_debounce_seconds() -> i64 {
    std::env::var("RENDER_DEBOUNCE_SECONDS")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|v| *v >= 0)
        .unwrap_or(30)
}

/// Stages that change what a page will show. While one is queued or running for a page, its
/// debounced render waits: rendering now would draw a half-finished page, and every pipeline
/// render is followed by a paid QA pass. A merge is the case that showed it — the merge edits the
/// page at once, its translation lands minutes later, and QA judged the page in between. The
/// page stays dirty, so the first sweep after the work ends renders it once. `render` and `qa`
/// are not here, or a page would wait on itself.
const RENDER_BLOCKING_JOBS: &[&str] = &[
    "panel-detection",
    "ocr",
    "layout",
    "cleanup",
    "manual-cleanup",
    "translation",
    "region-redo-tl",
    "region-redo-ocr",
    "qa-re-ocr",
];

/// How long a PROCESSING row with no lease (queued before leases existed) holds a render back —
/// the same ten minutes recovery gives such rows before re-dispatching them. A leased row blocks
/// while its lease is live; a PENDING row always blocks, however long it has queued, because
/// the dispatcher will either run it or fail it and a long queue is exactly when a page's merge
/// sits waiting for its cleanup.
const RENDER_BLOCK_UNLEASED_MINUTES: i64 = 10;

/// DebouncedRenderService port. Pages edited more than [`render_debounce_seconds`] ago whose last
/// render is older than their last edit, and with no [`RENDER_BLOCKING_JOBS`] in flight, get a
/// debounced render redo.
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
    let threshold = chrono::Utc::now() - chrono::Duration::seconds(render_debounce_seconds());
    let unleased_after =
        chrono::Utc::now() - chrono::Duration::minutes(RENDER_BLOCK_UNLEASED_MINUTES);
    // findPagesNeedingRender: last_edited_at < threshold AND (last_rendered_at IS NULL
    // OR last_edited_at > last_rendered_at), and nothing still working on the page.
    let pages: Vec<crate::models::Page> = sqlx::query_as(
        "SELECT * FROM pages p \
         WHERE p.last_edited_at IS NOT NULL AND p.last_edited_at < $1 \
           AND (p.last_rendered_at IS NULL OR p.last_edited_at > p.last_rendered_at) \
           AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.page_id = p.id AND j.type = ANY($2) \
                 AND (j.status = 'PENDING' \
                      OR (j.status = 'PROCESSING' AND (j.lease_expires_at > now() \
                          OR (j.lease_expires_at IS NULL \
                              AND COALESCE(j.updated_at, j.created_at) > $3)))))",
    )
    .bind(threshold)
    .bind(RENDER_BLOCKING_JOBS)
    .bind(unleased_after)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    if pages.is_empty() {
        return;
    }

    let mut triggered = 0usize;
    let mut reused = 0usize;
    for mut page in pages {
        if snapshot_backoff_active(page.id) {
            continue;
        }
        // Skip when a render failed within the last five minutes for this page. By page, not
        // image: duplicate-upload clones share an image, and one clone's failed render held back
        // every other clone's for five minutes.
        let last_render: Option<crate::models::Job> = sqlx::query_as(
            "SELECT * FROM jobs WHERE page_id = $1 AND type = 'render' ORDER BY created_at DESC LIMIT 1",
        )
        .bind(page.id)
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

        match reuse_unchanged_render(state, &page).await {
            Ok(true) => {
                reused += 1;
                continue;
            }
            Ok(false) => {}
            Err(err) => tracing::warn!(
                "Could not check page {} for an unchanged render: {err}; rendering it",
                page.id
            ),
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
    if reused > 0 {
        tracing::info!(
            "Kept {reused} existing renders: their pages' new revisions draw the same scene"
        );
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
    coordinator::drop_jobs_of_deleted_pages(&state.pool).await;
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
