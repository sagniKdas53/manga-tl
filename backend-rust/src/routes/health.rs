//! Health endpoints, byte-compatible with Spring Boot Actuator.
//!
//! The compose healthcheck (`wget --spider http://localhost:8080/tlhub/actuator/health`)
//! and the worker's startup dependency both probe this, so the JSON body and 200 status
//! must match exactly: `{"status":"UP"}`.

use axum::{Json, Router, routing::get};

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

/// Sub-router with the actuator paths. Typed as Router<AppState> so it merges into the
/// app-wide router in mod.rs before `.with_state()` is applied there.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/actuator/health", get(health))
        .route("/actuator/health/liveness", get(health))
        .route("/actuator/health/readiness", get(health))
}
