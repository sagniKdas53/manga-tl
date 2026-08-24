//! Router assembly — the Rust equivalent of Spring's DispatcherServlet setup.
//!
//! Mental model:
//!   * an axum `Router` maps method+path -> handler function
//!   * `nest(prefix, router)` mounts a sub-router under a URL prefix
//!     (this replaces Spring's `server.servlet.context-path=/tlhub`)
//!   * `.with_state(state)` attaches the shared AppState to all handlers in the router
//!   * middleware ("layers") wrap every request; TraceLayer logs, CatchPanic turns panics
//!     into GlobalExceptionHandler-shaped 500s
//!
//! The `fallback` handler ports ForwardController: unmatched non-API paths serve the SPA's
//! index.html, unmatched `/api/**` paths are real 404s.

pub mod auth;
pub mod health;
pub mod internal;
pub mod jobs;
pub mod layers;
pub mod layers_ops;
pub mod notifications;
pub mod page;
pub mod series;
pub mod settings;

use axum::Router;
use axum::response::{IntoResponse, Response};
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::trace::TraceLayer;

use crate::state::AppState;

/// The frozen OpenAPI contract, embedded at compile time from `spec/golden-openapi.json`
/// (Phase 4 step 1). Serving these exact bytes at `/v3/api-docs` replaces springdoc: the
/// HTTP surface is frozen, so the static copy IS the truth and the frontend's
/// `npm run generate-api` keeps working unchanged.
const GOLDEN_OPENAPI: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/spec/golden-openapi.json"
));

async fn openapi_docs() -> impl IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "application/json")],
        GOLDEN_OPENAPI,
    )
}

/// Builds the complete application router.
pub fn build_router(state: AppState) -> Router {
    let context_path = state.config.context_path.clone();

    // Everything Spring served relative to its context path.
    let inner = Router::new()
        .merge(health::router())
        .route("/v3/api-docs", axum::routing::get(openapi_docs))
        .nest("/api/auth", auth::router())
        .nest("/api/series", series::router())
        .nest("/api/jobs", jobs::router())
        .nest("/api/settings", settings::router())
        .nest("/api/notifications", notifications::router())
        .nest("/api/internal", internal::router())
        .nest("/api", page::router())
        .nest("/api", layer_routes())
        .fallback(spa_fallback)
        .with_state(state);

    let app = if context_path == "/" {
        inner
    } else {
        Router::new().nest(&context_path, inner)
    };

    app.layer(CatchPanicLayer::custom(|_panic| {
        crate::error::internal_error("/unknown")
    }))
    .layer(TraceLayer::new_for_http())
}

/// All layer-related routes in one table (kept beside their handlers' two modules).
fn layer_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/layers/{id}",
            axum::routing::put(layers_ops::update_layer).delete(layers_ops::delete_layer),
        )
        .route(
            "/layers/{layerId}/elements",
            axum::routing::post(layers_ops::create_layer_element),
        )
        .route(
            "/layer-elements/{id}",
            axum::routing::put(layers::update_layer_element)
                .delete(layers_ops::delete_layer_element),
        )
        .route(
            "/layer-elements/{id}/history",
            axum::routing::get(layers::element_history),
        )
        .route(
            "/pages/{pageId}/layers",
            axum::routing::post(layers::create_page_layer),
        )
        .route(
            "/images/{imageId}/layers",
            axum::routing::post(layers::create_image_layer),
        )
}

/// ForwardController port. Unmatched paths: `/api/**` -> Boot-style 404 JSON; anything
/// without a file extension -> the SPA shell so client-side routing works.
async fn spa_fallback(uri: axum::http::Uri) -> Response {
    let path = uri.path();
    if path.starts_with("/api") {
        return (
            StatusCode::NOT_FOUND,
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            format!(
                "{{\"timestamp\":\"{}\",\"status\":404,\"error\":\"Not Found\",\"path\":\"{path}\"}}",
                chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3f+00:00")
            ),
        )
            .into_response();
    }

    // Phase 4 embeds the frontend dist into the binary; until then read it from disk
    // (the Dockerfile copies dist next to the binary, matching today's layout).
    //
    // Java's ForwardController maps ONLY extension-less paths (`/{path:[^\\.]*}`) to the
    // SPA shell; a dotted path is an asset lookup and must stay a real 404.
    let last_segment = path.rsplit('/').next().unwrap_or("");
    if last_segment.contains('.') {
        return StatusCode::NOT_FOUND.into_response();
    }
    let dist_dir = std::env::var("SPA_DIST_DIR").unwrap_or_else(|_| "../frontend/dist".into());
    if let Ok(index) = std::fs::read(format!("{dist_dir}/index.html")) {
        return (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "text/html;charset=UTF-8")],
            index,
        )
            .into_response();
    }
    StatusCode::NOT_FOUND.into_response()
}

use axum::http::StatusCode;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, DatabaseConfig, MinioConfig};
    use axum::body::Body;
    use axum::http::{Request, StatusCode as Status};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_state(context_path: &str) -> AppState {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy_with(sqlx::postgres::PgConnectOptions::new().host("localhost"));
        let minio_config = MinioConfig {
            endpoint: "http://localhost:9000".into(),
            external_url: None,
            access_key: Some("minioadmin".into()),
            secret_key: Some("minioadmin".into()),
        };
        let config = Config {
            context_path: context_path.to_string(),
            port: 0,
            development: true,
            database: DatabaseConfig {
                host: "localhost".into(),
                port: 5432,
                name: "test".into(),
                user: "postgres".into(),
                password: "pw".into(),
            },
            jwt_secret: None,
            internal_api_token: None,
            jwt_expiration_ms: 3_600_000,
            minio: minio_config.clone(),
            redis: crate::config::RedisConfig {
                host: "localhost".into(),
                port: 6379,
            },
        };
        AppState::new(
            config,
            pool,
            crate::jwt::JwtUtils::new(
                "test-secret-long-enough-for-hmac-signing-1234".into(),
                3_600_000,
            ),
            crate::minio::MinioService::new(&minio_config),
            None,
        )
    }

    #[tokio::test]
    async fn health_served_under_context_path() {
        let app = build_router(test_state("/tlhub"));
        let response = app
            .oneshot(
                Request::get("/tlhub/actuator/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), Status::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], &br#"{"status":"UP"}"#[..]);
    }

    #[tokio::test]
    async fn unknown_api_paths_are_real_404_json() {
        let app = build_router(test_state("/tlhub"));
        let response = app
            .oneshot(
                Request::get("/tlhub/api/nonexistent")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), Status::NOT_FOUND);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "application/json"
        );
    }

    /// OpenApiSpecTest port (Phase 4 step 1): the served spec must be byte-identical to
    /// the frozen golden contract.
    #[tokio::test]
    async fn openapi_docs_served_byte_for_byte() {
        let app = build_router(test_state("/tlhub"));
        let response = app
            .oneshot(
                Request::get("/tlhub/v3/api-docs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), Status::OK);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "application/json"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], GOLDEN_OPENAPI);
    }

    /// The behavioral half of OpenApiSpecTest: valid JSON, and every core path the
    /// frontend consumes is present under /api.
    #[tokio::test]
    async fn openapi_docs_contains_core_contract_paths() {
        let spec: serde_json::Value = serde_json::from_slice(GOLDEN_OPENAPI).unwrap();
        assert!(spec.get("openapi").is_some());
        let paths = spec.get("paths").expect("paths object");
        for path in [
            "/api/series",
            "/api/series/{seriesId}",
            "/api/series/{seriesId}/chapters",
            "/api/pages/{pageId}",
            "/api/jobs",
            "/api/settings",
        ] {
            assert!(paths.get(path).is_some(), "missing contract path {path}");
        }
    }

    /// ForwardControllerTest port: extension-less non-API paths get the SPA shell;
    /// paths WITH an extension (assets) do not.
    #[tokio::test]
    async fn spa_fallback_serves_index_for_extension_less_paths() {
        let dist = std::env::temp_dir().join(format!("spa-e2e-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dist).expect("mkdir");
        std::fs::write(dist.join("index.html"), "<html><body>SPA</body></html>").expect("index");

        // SAFETY: no other test touches SPA_DIST_DIR; test binaries own their process.
        unsafe { std::env::set_var("SPA_DIST_DIR", &dist) };
        let app = build_router(test_state("/tlhub"));

        // Extension-less client-side route -> index.html.
        let response = app
            .clone()
            .oneshot(
                Request::get("/tlhub/series/some-series")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), Status::OK);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "text/html;charset=UTF-8"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], b"<html><body>SPA</body></html>");

        // An asset-looking path is NOT rewritten to index.html.
        let response = app
            .oneshot(
                Request::get("/tlhub/assets/nope.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), Status::NOT_FOUND);

        unsafe { std::env::remove_var("SPA_DIST_DIR") };
        let _ = std::fs::remove_dir_all(&dist);
    }
}
