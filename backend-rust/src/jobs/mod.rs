//! Job pipeline: coordinator (enqueue + callbacks), dispatcher (worker fan-out) and
//! recovery (startup reset, stale sweep, debounced renders).

pub mod coordinator;
pub mod dispatcher;
pub mod recovery;

use std::time::Duration;

pub use coordinator::{HEAVY_QUEUES, LIGHT_QUEUES, PIPELINE_TRACE_TTL_SECS, REDO_REASON_TTL_SECS};

/// Spawns every background loop the Java @Scheduled pool ran:
///   * stale-PROCESSING recovery sweep — fixedRate 300_000 ms
///   * health report (queue depth + Redis probe) — fixedRate 300_000 ms
///   * debounced render pass       — fixedDelay  5_000 ms
///   * worker dispatch cycle       — WORKER_POLL_MS (default 2000)
pub fn spawn_scheduled_tasks(state: &crate::state::AppState) {
    let sweep_state = state.clone();
    tokio::spawn(async move {
        loop {
            recovery::recover_stale_processing_jobs(&sweep_state).await;
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
    });

    let health_state = state.clone();
    tokio::spawn(async move {
        loop {
            recovery::report_health(&health_state).await;
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
    });

    // AUDIT-W13 review: PENDING rows that never reached a queue. Cheap — one LRANGE per queue
    // plus one indexed query — so it can run often enough that a lost push is a blip rather than
    // a stalled chapter.
    let orphan_state = state.clone();
    tokio::spawn(async move {
        loop {
            recovery::requeue_orphaned_pending_jobs(&orphan_state).await;
            tokio::time::sleep(Duration::from_secs(120)).await;
        }
    });

    let render_state = state.clone();
    tokio::spawn(async move {
        loop {
            recovery::process_pending_renders(&render_state).await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    dispatcher::spawn(state.clone());
}

/// Daily export sweeps (Java: ChapterExportService fixedRate 24h + ExportCleanupService
/// cron 02:00). One loop covers both.
///
/// Both Java services are run here. `cleanup_old_exports` used to be defined but never
/// called, which silently made `APP_EXPORT_RETENTION_DAYS` a no-op — the hard-coded
/// 7-day sweep was the only one running, so a deployment configuring a different
/// retention window got the default regardless.
pub fn spawn_export_cleanup(state: &crate::state::AppState) {
    let sweep_state = state.clone();
    tokio::spawn(async move {
        loop {
            crate::export::cleanup_stale_exports(&sweep_state).await;
            crate::export::cleanup_old_exports(&sweep_state).await;
            // 24 hours, like Java's fixedRate = 86400000.
            tokio::time::sleep(Duration::from_secs(86_400)).await;
        }
    });
}
