//! F4 (#178): the page's layer history: what Undo and Redo would do, and doing it.
//! The recording and the row work are in [`crate::layer_ops`].

use axum::Json;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error;
use crate::layer_ops::{self, Direction};
use crate::page_freshness::advance_page_revision_by_hand;
use crate::routes::layers::deny_viewer;
use crate::state::AppState;

const STATUS: &str = "/api/pages/{pageId}/layer-history";
const UNDO: &str = "/api/pages/{pageId}/layer-history/undo";
const REDO: &str = "/api/pages/{pageId}/layer-history/redo";

/// GET /api/pages/{pageId}/layer-history — `{undo, redo, undoCount, redoCount, depth}`; `undo` and
/// `redo` are `{id, kind, label, createdAt, blocked}` or null, `blocked` saying why it cannot run.
pub async fn layer_history(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(page_id): Path<Uuid>,
) -> Response {
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(err) => {
            tracing::error!(
                "Could not open a transaction for the layer history of {page_id}: {err}"
            );
            return error::internal_error(STATUS);
        }
    };
    let status = layer_ops::status(&mut tx, page_id).await;
    let _ = tx.rollback().await;
    match status {
        Ok(status) => Json(status).into_response(),
        Err(err) => {
            tracing::error!("Could not read the layer history of {page_id}: {err}");
            error::internal_error(STATUS)
        }
    }
}

/// POST /api/pages/{pageId}/layer-history/undo — undoes the newest layer action. Answers the new
/// history; 409 with the reason when the action can no longer be undone, or there is none.
pub async fn undo(state: State<AppState>, user: AuthUser, path: Path<Uuid>) -> Response {
    step(state, user, path, Direction::Undo, UNDO).await
}

/// POST /api/pages/{pageId}/layer-history/redo — redoes the newest undone layer action.
pub async fn redo(state: State<AppState>, user: AuthUser, path: Path<Uuid>) -> Response {
    step(state, user, path, Direction::Redo, REDO).await
}

async fn step(
    State(state): State<AppState>,
    user: AuthUser,
    Path(page_id): Path<Uuid>,
    direction: Direction,
    instance: &'static str,
) -> Response {
    if let Some(denied) = deny_viewer(&user, instance) {
        return denied;
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(err) => {
            tracing::error!("Could not open a transaction to {direction:?} on {page_id}: {err}");
            return error::internal_error(instance);
        }
    };
    let outcome: Result<Result<serde_json::Value, String>, sqlx::Error> = async {
        layer_ops::lock_page(&mut tx, page_id).await?;
        let Some(op) = layer_ops::next_op(&mut tx, page_id, direction).await? else {
            return Ok(Err(match direction {
                Direction::Undo => "there is no layer action to undo".to_string(),
                Direction::Redo => "there is no layer action to redo".to_string(),
            }));
        };
        if let Some(reason) = layer_ops::blocked(&mut tx, &op.changes, direction).await? {
            return Ok(Err(reason));
        }
        layer_ops::apply(&mut tx, &op.changes, direction).await?;
        layer_ops::mark(&mut tx, op.id, direction).await?;
        advance_page_revision_by_hand(&mut tx, page_id).await?;
        let mut status = layer_ops::status(&mut tx, page_id).await?;
        if let Some(map) = status.as_object_mut() {
            map.insert("applied".into(), serde_json::json!(op.label));
        }
        Ok(Ok(status))
    }
    .await;
    match outcome {
        Ok(Ok(status)) => {
            if let Err(err) = tx.commit().await {
                tracing::error!("Could not commit a layer {direction:?} on {page_id}: {err}");
                return error::internal_error(instance);
            }
            Json(status).into_response()
        }
        Ok(Err(reason)) => {
            let _ = tx.rollback().await;
            error::conflict(&reason, instance)
        }
        Err(err) => {
            tracing::error!("Could not {direction:?} a layer action on {page_id}: {err}");
            let _ = tx.rollback().await;
            error::internal_error(instance)
        }
    }
}
