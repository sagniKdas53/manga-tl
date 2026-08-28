//! `/api/notifications` — port of NotificationController plus the ticket path of
//! SseTicketAuthFilter.
//!
//! Handshake (AUDIT-S4): `EventSource` cannot send headers, so the browser POSTs
//! `/ticket` WITH its `Authorization` header and opens `/stream?ticket=<single-use>`.
//! The JWT is visible only on the POST; the stream URL carries a 60-second,
//! GETDEL-on-use ticket instead. A session JWT in the query string (`?token=`) buys
//! nothing: it is simply ignored, exactly like Java's JwtAuthFilter which no longer
//! reads query strings at all.
//!
//! Failure shape: an unredeemable ticket, an unknown user or no credential at all are
//! all "unauthenticated" — Spring's security chain answers those with its 403 Boot
//! error attributes, so we reuse [`crate::auth::forbidden_like_spring`].

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::json;

use crate::auth::{AuthUser, bearer_token, forbidden_like_spring};
use crate::error;
use crate::models::User;
use crate::state::AppState;

/// POST /api/notifications/ticket — exchanges the session JWT for a single-use ticket.
/// The response body is exactly `{"ticket": "..."}`.
pub async fn issue_ticket(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
) -> Response {
    let instance = format!(
        "{}{}",
        state.config.context_path, "/api/notifications/ticket"
    );
    let Some(tickets) = state.sse.tickets() else {
        // No Redis in this process (unit-test builds only); production connects fail-fast.
        return error::internal_error(&instance);
    };

    // Read exp off the raw header rather than declaring it a parameter: the header is
    // required of every authenticated call anyway, and re-parsing here keeps the change
    // out of the authentication path (same reasoning as the Java controller's comment).
    let session_expires_at =
        bearer_token(&headers).and_then(|token| state.jwt.expiry_from_token(&token));

    match tickets.issue(auth.id, session_expires_at).await {
        Ok(ticket) => Json(json!({ "ticket": ticket })).into_response(),
        Err(err) => {
            tracing::error!("Failed to issue SSE ticket: {err}");
            error::internal_error(&instance)
        }
    }
}

/// GET /api/notifications/stream — authenticates via `?ticket=` (preferred) or a plain
/// Authorization header (Java kept both paths working), then holds the connection open.
pub async fn stream(
    State(state): State<AppState>,
    // OriginalUri survives nest-stripping: the 403 body must report the FULL path.
    original_uri: axum::extract::OriginalUri,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let resolved = resolve_stream_user(&state, &headers, &params).await;
    let Some((user, session_expires_at)) = resolved else {
        return forbidden_like_spring(&state, &original_uri.0);
    };
    tracing::info!("Client connected to SSE stream: {}", user.email);
    state.sse.subscribe(user.id, session_expires_at).await
}

/// Ticket first, then header — mirroring the filter-then-controller order in Spring.
/// Every miss collapses to None ⇒ the caller answers with the security 403 shape.
async fn resolve_stream_user(
    state: &AppState,
    headers: &HeaderMap,
    params: &HashMap<String, String>,
) -> Option<(User, Option<chrono::DateTime<chrono::Utc>>)> {
    if let Some(ticket) = params
        .get("ticket")
        .map(String::as_str)
        .filter(|t| !t.trim().is_empty())
    {
        let tickets = state.sse.tickets()?;
        let redeemed = tickets.redeem(ticket).await.ok().flatten()?;
        let user: User = sqlx::query_as("SELECT * FROM users WHERE id = $1")
            .bind(redeemed.user_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()?;
        return Some((user, redeemed.session_expires_at));
    }

    // Header fallback: JwtAuthFilter authenticated plain-header streams in Java too
    // (only the EventSource itself cannot send one).
    let token = bearer_token(headers)?;
    let email = state.jwt.email_from_token(&token).ok()?;
    let user: User = sqlx::query_as("SELECT * FROM users WHERE email = $1")
        .bind(email)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten()?;
    Some((user, state.jwt.expiry_from_token(&token)))
}

/// Sub-router mounted under `/api/notifications`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/ticket", post(issue_ticket))
        .route("/stream", axum::routing::get(stream))
}
