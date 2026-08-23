//! Job pipeline: coordinator (enqueue + callbacks), dispatcher (worker fan-out) and
//! recovery (startup reset, stale sweep, debounced renders).

pub mod coordinator;
pub mod dispatcher;
pub mod recovery;

use std::time::Duration;

pub use coordinator::{HEAVY_QUEUES, LIGHT_QUEUES, PIPELINE_TRACE_TTL_SECS, REDO_REASON_TTL_SECS};

/// Spawns every background loop the Java @Scheduled pool ran:
///   * stale-PROCESSING recovery sweep — fixedRate 300_000 ms
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

    let render_state = state.clone();
    tokio::spawn(async move {
        loop {
            recovery::process_pending_renders(&render_state).await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });

    dispatcher::spawn(state.clone());
}
