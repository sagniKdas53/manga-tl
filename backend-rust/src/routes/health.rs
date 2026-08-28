//! Actuator endpoints, byte-compatible with Spring Boot where they overlap.
//!
//! The compose healthcheck (the baked static probe in the Rust image, `wget --spider` in
//! the Java one) and the worker's startup dependency both probe `/actuator/health`, so
//! the JSON body and 200 status must match exactly: `{"status":"UP"}`.
//!
//! `application.yml` exposed `health,loggers,metrics,env` and guarded everything but
//! health with `hasRole("ADMIN")` in SecurityConfig. We serve health and loggers; see
//! `crate::logging` for why loggers is worth carrying, and MIGRATION.md for why `metrics`
//! and `env` are deliberately not ported.

use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router, routing::get};
use serde_json::json;

use crate::auth::AuthUser;
use crate::error;
use crate::logging;
use crate::state::AppState;

/// Response body. `#[derive(serde::Serialize)]` generates the JSON serializer;
/// `&'static str` means "string literal that lives for the whole program" — zero allocation.
#[derive(serde::Serialize)]
struct HealthStatus {
    status: &'static str,
}

/// The handler function. `Json<T>` as a return type sets `Content-Type: application/json`
/// automatically — the equivalent of Spring returning a @ResponseBody object.
async fn health() -> Json<HealthStatus> {
    Json(HealthStatus { status: "UP" })
}

/// SecurityConfig guarded `/actuator/**` (everything past health) with `hasRole("ADMIN")`,
/// answering anyone else with the security 403 shape.
fn require_admin(user: &AuthUser, instance: &str) -> Option<Response> {
    if user.role.eq_ignore_ascii_case("admin") {
        return None;
    }
    Some(error::access_denied(instance))
}

const LOGGERS_PATH: &str = "/actuator/loggers";

/// GET /actuator/loggers — the level catalogue plus every logger carrying an override.
///
/// Spring listed every logger the JVM knew about; a tracing target only exists once it
/// has emitted, so the honest equivalent is ROOT plus whatever has been explicitly set.
async fn list_loggers(user: AuthUser) -> Response {
    if let Some(denied) = require_admin(&user, LOGGERS_PATH) {
        return denied;
    }

    let root = logging::root_level();
    let mut loggers = serde_json::Map::new();
    loggers.insert(
        "ROOT".to_string(),
        json!({ "configuredLevel": root, "effectiveLevel": root }),
    );
    for (target, level) in logging::overrides() {
        loggers.insert(
            target,
            json!({ "configuredLevel": level, "effectiveLevel": level }),
        );
    }

    Json(json!({
        "levels": logging::LEVELS,
        "loggers": loggers,
        "groups": {},
    }))
    .into_response()
}

/// GET /actuator/loggers/{name} — one logger's configured and effective level.
async fn get_logger(user: AuthUser, Path(name): Path<String>) -> Response {
    if let Some(denied) = require_admin(&user, LOGGERS_PATH) {
        return denied;
    }

    // No override means the target inherits ROOT, which is what Spring reported too.
    let configured = logging::level_for(&name);
    let effective = configured.clone().unwrap_or_else(logging::root_level);
    Json(json!({ "configuredLevel": configured, "effectiveLevel": effective })).into_response()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LevelRequest {
    /// `null` resets the logger to ROOT, exactly like Spring's reset payload.
    configured_level: Option<String>,
}

/// POST /actuator/loggers/{name} — set or clear one logger's level, live. 204 on success.
async fn set_logger(
    user: AuthUser,
    Path(name): Path<String>,
    body: Result<Json<LevelRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if let Some(denied) = require_admin(&user, LOGGERS_PATH) {
        return denied;
    }
    let Ok(Json(request)) = body else {
        return error::unreadable_body(LOGGERS_PATH);
    };

    match logging::set_level(&name, request.configured_level.as_deref()) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(message) => error::bad_request(&message, LOGGERS_PATH),
    }
}

/// Sub-router with the actuator paths. Typed as Router<AppState> so it merges into the
/// app-wide router in mod.rs before `.with_state()` is applied there.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/actuator/health", get(health))
        .route("/actuator/health/liveness", get(health))
        .route("/actuator/health/readiness", get(health))
        .route("/actuator/loggers", get(list_loggers))
        .route("/actuator/loggers/{name}", get(get_logger).post(set_logger))
}
