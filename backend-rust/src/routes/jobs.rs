//! `/api/jobs` — port of JobController. SSE fan-out and `requeuePendingJobs` are Phase 3;
//! queue push/pause state (Redis) is fully live here.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::json;

use crate::models::Job;
use crate::redis_service::RedisService;
use crate::state::AppState;

const ACTIVE_STATUSES: [&str; 4] = ["PENDING", "PROCESSING", "FAILED", "PAUSED"];

async fn redis(state: &AppState) -> Option<std::sync::Arc<RedisService>> {
    state.redis.clone()
}

/// GET /api/jobs — active jobs + global pause flag.
pub async fn get_jobs(State(state): State<AppState>) -> Response {
    let jobs: Vec<Job> =
        sqlx::query_as("SELECT * FROM jobs WHERE status = ANY($1) ORDER BY created_at ASC")
            .bind(ACTIVE_STATUSES)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();

    let is_paused = match redis(&state).await {
        Some(r) => r.queue_paused().await.unwrap_or(false),
        None => false,
    };

    Json(json!({
        "jobs": serde_json::to_value(&jobs).unwrap_or_default(),
        "isPaused": is_paused,
    }))
    .into_response()
}

/// POST /api/jobs/pause
pub async fn pause_queue(State(state): State<AppState>) -> Response {
    if let Some(r) = redis(&state).await {
        let _ = r.set_queue_paused(true).await;
    }
    // Phase 3: sseService.emitEventToAllUsers("queue_paused", ...)
    StatusCode::OK.into_response()
}

/// POST /api/jobs/resume
pub async fn resume_queue(State(state): State<AppState>) -> Response {
    if let Some(r) = redis(&state).await {
        let _ = r.set_queue_paused(false).await;
    }
    // Phase 3: jobCoordinatorService.requeuePendingJobs() + SSE event.
    StatusCode::OK.into_response()
}

const QUEUE_KEYS: [&str; 10] = [
    "queue:panel-detection",
    "queue:ocr",
    "queue:layout",
    "queue:translation",
    "queue:render",
    "queue:qa",
    "queue:qa-re-ocr",
    "queue:region-redo",
    "queue:region-redo-ocr",
    "queue:region-redo-tl",
];

/// DELETE /api/jobs/clear?force=
pub async fn clear_queue(
    State(state): State<AppState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    let force = params.get("force").map(|v| v == "true").unwrap_or(false);
    let statuses: Vec<&str> = if force {
        vec!["PENDING", "PAUSED", "FAILED", "PROCESSING"]
    } else {
        vec!["PENDING", "PAUSED", "FAILED"]
    };

    let result = sqlx::query("DELETE FROM jobs WHERE status = ANY($1)")
        .bind(&statuses)
        .execute(&state.pool)
        .await;

    match result {
        Ok(res) => {
            if let Some(r) = redis(&state).await {
                for key in QUEUE_KEYS {
                    let _ = r.delete(key).await;
                }
            }
            tracing::info!(
                "Cleared queue via API (force={force}): removing {} jobs",
                res.rows_affected()
            );
            // Phase 3: SSE queue_cleared event with clearedCount.
            StatusCode::OK.into_response()
        }
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn find_job(pool: &sqlx::PgPool, id: &str) -> Option<Job> {
    sqlx::query_as("SELECT * FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

/// Re-enqueues a PENDING job's payload onto its type queue when the gate is open.
async fn push_if_unpaused(state: &AppState, job: &Job) {
    let Some(redis) = redis(state).await else {
        return;
    };
    match redis.queue_paused().await {
        Ok(true) => {}
        _ => {
            if let Some(payload) = &job.payload {
                let queue = format!("queue:{}", job.job_type);
                if let Err(err) = redis.push_to_queue(&queue, payload).await {
                    tracing::error!("Failed to push job {} to Redis: {err}", job.id);
                }
            }
        }
    }
    // Phase 3: emitJobUpdateEvent(job).
}

/// POST /api/jobs/{id}/retry — reset to PENDING/error-null/attempt=1.
pub async fn retry_job(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(job) = find_job(&state.pool, &id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    sqlx::query("UPDATE jobs SET status = 'PENDING', error = NULL, attempt = 1 WHERE id = $1")
        .bind(&id)
        .execute(&state.pool)
        .await
        .expect("job retry update");

    let refreshed = find_job(&state.pool, &id).await.unwrap_or(job);
    push_if_unpaused(&state, &refreshed).await;
    StatusCode::OK.into_response()
}

/// POST /api/jobs/{id}/pause — only PENDING may pause (400 text otherwise).
pub async fn pause_job(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(job) = find_job(&state.pool, &id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if job.status != "PENDING" {
        return (
            StatusCode::BAD_REQUEST,
            "Only PENDING jobs can be paused".to_string(),
        )
            .into_response();
    }
    sqlx::query("UPDATE jobs SET status = 'PAUSED' WHERE id = $1")
        .bind(&id)
        .execute(&state.pool)
        .await
        .expect("job pause");
    StatusCode::OK.into_response()
}

/// POST /api/jobs/{id}/resume — PAUSED back to PENDING and re-enqueued.
pub async fn resume_job(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(job) = find_job(&state.pool, &id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if job.status != "PAUSED" {
        return (
            StatusCode::BAD_REQUEST,
            "Only PAUSED jobs can be resumed".to_string(),
        )
            .into_response();
    }
    sqlx::query("UPDATE jobs SET status = 'PENDING' WHERE id = $1")
        .bind(&id)
        .execute(&state.pool)
        .await
        .expect("job resume");
    let refreshed = find_job(&state.pool, &id).await.unwrap_or(job);
    push_if_unpaused(&state, &refreshed).await;
    StatusCode::OK.into_response()
}

/// DELETE /api/jobs/{id}
pub async fn delete_job(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let result = sqlx::query("DELETE FROM jobs WHERE id = $1")
        .bind(&id)
        .execute(&state.pool)
        .await;
    match result {
        Ok(res) if res.rows_affected() > 0 => StatusCode::OK.into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Sub-router mounted under `/api/jobs`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get_jobs_route())
        .route("/pause", post(pause_queue))
        .route("/resume", post(resume_queue))
        .route("/clear", axum::routing::delete(clear_queue))
        .route("/{id}/retry", post(retry_job))
        .route("/{id}/pause", post(pause_job))
        .route("/{id}/resume", post(resume_job))
        .route("/{id}", axum::routing::delete(delete_job))
}

fn get_jobs_route() -> axum::routing::MethodRouter<AppState> {
    axum::routing::get(get_jobs)
}
