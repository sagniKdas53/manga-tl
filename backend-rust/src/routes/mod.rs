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
use axum::extract::DefaultBodyLimit;
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::compression::CompressionLayer;
use tower_http::trace::TraceLayer;

use crate::state::AppState;

/// Largest request body we accept, matching Spring's
/// `spring.servlet.multipart.max-request-size: 50MB`.
///
/// This is NOT cosmetic. axum applies a 2 MB default body limit to every buffering
/// extractor (`Multipart`, `Json`, `Bytes`) unless a `DefaultBodyLimit` layer says
/// otherwise, so without this the port silently rejected any page scan, chapter ZIP or
/// worker callback payload over 2 MB — well under the size of a routine manga page.
/// Nothing caught it because every upload fixture in the suite is a 1x1 or 64x64 PNG.
pub const MAX_REQUEST_BODY_BYTES: usize = 50 * 1024 * 1024;

/// The built frontend, embedded into the binary (Java copied it into BOOT-INF/classes/static).
/// build.rs guarantees the folder exists even on clean checkouts; the Dockerfile's frontend
/// stage always produces real assets before the Rust stage compiles. In debug builds
/// rust-embed reads from disk at runtime anyway, and `SPA_DIST_DIR` overrides both modes.
#[derive(RustEmbed)]
#[folder = "../frontend/dist"]
struct SpaAssets;

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
        // Spring serves its static welcome page at the context root itself, but axum's
        // nest does not match `{context}/` (trailing slash) or route it to the inner
        // fallback — so both exact spellings get the SPA shell explicitly.
        Router::new()
            .nest(&context_path, inner)
            .route(&context_path, axum::routing::get(|| async { spa_shell() }))
            .route(
                &format!("{context_path}/"),
                axum::routing::get(|| async { spa_shell() }),
            )
    };

    app.layer(CatchPanicLayer::custom(|_panic| {
        crate::error::internal_error("/unknown")
    }))
    .layer(TraceLayer::new_for_http())
    .layer(CompressionLayer::new().compress_when(compressible()))
    .layer(axum::middleware::from_fn(reject_oversized_body))
    .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
}

/// Rejects an over-limit request up front, on `Content-Length`.
///
/// `DefaultBodyLimit` alone is not enough for a clean contract: it surfaces as an
/// extractor rejection, and most handlers here take `Result<Json<T>, JsonRejection>` and
/// collapse every rejection to Boot's 400 "Failed to read request" — so an oversized
/// payload would report as malformed rather than too large. Checking the header before
/// any extractor runs puts one 413 problem+json on every route, JSON and multipart alike,
/// which is also where Tomcat enforced it for Spring. The `DefaultBodyLimit` layer stays
/// as the backstop for chunked requests that declare no length.
async fn reject_oversized_body(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let declared = request
        .headers()
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());

    if declared.is_some_and(|length| length > MAX_REQUEST_BODY_BYTES as u64) {
        return crate::error::payload_too_large(request.uri().path());
    }
    next.run(request).await
}

/// Which responses get gzip/brotli, standing in for Spring's `server.compression`.
///
/// Java compressed responses over 2 KB whose content type was on an allowlist (html, css,
/// javascript, json, xml, plain text). tower-http works the other way round — compress
/// everything except a denylist — so the exclusions below reconstruct the same effective
/// set: `DefaultPredicate` already drops images and `text/event-stream` (the SSE stream
/// must never be buffered through an encoder), and we add the other already-compressed
/// payloads this app serves — export ZIPs, embedded fonts and opaque binaries.
///
/// This matters more here than it did on Spring: the Rust binary serves the embedded SPA
/// itself, and the Traefik router in front of it carries no compress middleware, so
/// without this layer the frontend bundle and every JSON list response ship uncompressed.
fn compressible() -> impl tower_http::compression::Predicate {
    use tower_http::compression::predicate::{
        DefaultPredicate, NotForContentType, Predicate, SizeAbove,
    };

    DefaultPredicate::new()
        // Spring's `server.compression.min-response-size` default.
        .and(SizeAbove::new(2048))
        .and(NotForContentType::new("application/zip"))
        .and(NotForContentType::new("application/octet-stream"))
        .and(NotForContentType::new("font/"))
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
    // `/actuator/**` is a management surface, not a client-side route. Letting it reach
    // the SPA branch below answered `/actuator/metrics` with 200 index.html — an
    // extension-less path looks exactly like a deep link — where Spring returned 403 for
    // anyone without ROLE_ADMIN and 404 for endpoints it did not expose.
    if path.starts_with("/api") || path.starts_with("/actuator") {
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
    // Java layers a static-resource handler IN FRONT of ForwardController: dotted paths
    // are asset lookups served from the SPA dist, while extension-less paths fall
    // through the `/{path:[^\\.]*}` mapping to index.html.
    let last_segment = path.rsplit('/').next().unwrap_or("");
    if !last_segment.contains('.') {
        return spa_shell();
    }

    // Asset lookup within the embedded dist, or the SPA_DIST_DIR dev override
    // (traversal-guarded — irrelevant for the embed, load-bearing on disk).
    if path.split('/').any(|seg| seg == "..") {
        return StatusCode::NOT_FOUND.into_response();
    }
    match spa_asset(path) {
        Some(bytes) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, asset_mime(path))],
            bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Content types for the SPA's built assets (the set Vite actually emits).
fn asset_mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "html" => "text/html;charset=UTF-8",
        "json" | "webmanifest" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// The SPA shell (index.html), shared by the fallback and the context-root routes.
/// Serves the embedded dist; `SPA_DIST_DIR` overrides it for local dev so a fresh
/// `npm run build` is visible without recompiling.
fn spa_shell() -> Response {
    if let Ok(dist_dir) = std::env::var("SPA_DIST_DIR")
        && let Ok(index) = std::fs::read(format!("{dist_dir}/index.html"))
    {
        return (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "text/html;charset=UTF-8")],
            index,
        )
            .into_response();
    }
    match SpaAssets::get("index.html") {
        Some(content) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "text/html;charset=UTF-8")],
            content.data.to_vec(),
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// One built asset by its context-relative path (`/assets/index-*.js`), embedded at
/// compile time unless SPA_DIST_DIR overrides to disk.
fn spa_asset(path: &str) -> Option<Vec<u8>> {
    let rel = path.trim_start_matches('/');
    if let Ok(dist_dir) = std::env::var("SPA_DIST_DIR")
        && let Ok(bytes) = std::fs::read(format!("{dist_dir}/{rel}"))
    {
        return Some(bytes);
    }
    SpaAssets::get(rel).map(|content| content.data.to_vec())
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

    /// Both SPA tests mutate the process-global SPA_DIST_DIR: serialize them.
    static SPA_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// ForwardControllerTest port: extension-less non-API paths get the SPA shell;
    /// paths WITH an extension (assets) do not.
    #[tokio::test]
    async fn spa_fallback_serves_index_for_extension_less_paths() {
        let _spa_env = SPA_ENV_LOCK.lock().await;
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

        // A REAL asset file is served with its content type (Spring static-handler parity).
        std::fs::create_dir_all(dist.join("assets")).expect("assets dir");
        std::fs::write(dist.join("assets/app-1.js"), b"console.log(1)").expect("asset");
        let response = app
            .clone()
            .oneshot(
                Request::get("/tlhub/assets/app-1.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), Status::OK);
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "text/javascript"
        );

        // A missing asset stays a 404.
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

    /// Spring welcome-page parity: GET /tlhub and /tlhub/ serve the SPA shell.
    #[tokio::test]
    async fn context_root_serves_the_spa_shell() {
        let _spa_env = SPA_ENV_LOCK.lock().await;
        let dist = std::env::temp_dir().join(format!("spa-root-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dist).expect("mkdir");
        std::fs::write(dist.join("index.html"), b"<html>root</html>").expect("index");
        // SAFETY: no other test touches SPA_DIST_DIR; test binaries own their process.
        unsafe { std::env::set_var("SPA_DIST_DIR", &dist) };

        for path in ["/tlhub", "/tlhub/"] {
            let app = build_router(test_state("/tlhub"));
            let response = app
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), Status::OK, "{path}");
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            assert_eq!(&bytes[..], b"<html>root</html>", "{path}");
        }

        unsafe { std::env::remove_var("SPA_DIST_DIR") };
        let _ = std::fs::remove_dir_all(&dist);
    }

    /// Without SPA_DIST_DIR the embedded dist answers: shell and assets both come from
    /// SpaAssets (this is what the production image runs with).
    #[tokio::test]
    async fn embedded_assets_serve_when_no_dist_override_is_set() {
        let _spa_env = SPA_ENV_LOCK.lock().await;
        // SAFETY: serialized behind SPA_ENV_LOCK; test binaries own their process.
        unsafe { std::env::remove_var("SPA_DIST_DIR") };

        let app = build_router(test_state("/tlhub"));

        let response = app
            .clone()
            .oneshot(Request::get("/tlhub/login").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), Status::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert!(bytes.starts_with(b"<!doctype html>"), "embedded shell");

        // The stub asset only exists when the frontend has not been built; either way
        // a dotted path must resolve from the embed (200) or 404 — never the shell.
        let response = app
            .oneshot(
                Request::get("/tlhub/assets/definitely-missing.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), Status::NOT_FOUND);
    }

    /// Regression: axum applies a 2 MB default body limit to every buffering extractor
    /// unless a `DefaultBodyLimit` layer overrides it, so before `MAX_REQUEST_BODY_BYTES`
    /// was wired in, ANY request body over 2 MB was rejected — page scans, chapter ZIPs
    /// and worker callbacks alike. Spring's cap was 50 MB.
    ///
    /// Deliberately malformed JSON on a permitAll route: the extractor rejects it before
    /// the handler touches Postgres, so the status isolates the body limit from
    /// everything else. Over the limit the rejection is 413; under it, 400.
    #[tokio::test]
    async fn bodies_between_the_axum_default_and_the_spring_cap_are_accepted() {
        let app = build_router(test_state("/tlhub"));
        let three_mb = vec![b'x'; 3 * 1024 * 1024];

        let response = app
            .oneshot(
                Request::post("/tlhub/api/auth/login")
                    .header("content-type", "application/json")
                    .header("content-length", three_mb.len())
                    .body(Body::from(three_mb))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_ne!(
            response.status(),
            Status::PAYLOAD_TOO_LARGE,
            "a 3 MB body must reach the handler; the 2 MB axum default is not our contract"
        );
        assert_eq!(response.status(), Status::BAD_REQUEST, "malformed JSON");
    }

    #[tokio::test]
    async fn bodies_past_the_spring_cap_are_still_rejected() {
        let app = build_router(test_state("/tlhub"));

        // The guard reads Content-Length and answers before the body is touched, which is
        // the whole point — so the declared length is what the assertion exercises.
        let response = app
            .oneshot(
                Request::post("/tlhub/api/auth/login")
                    .header("content-type", "application/json")
                    .header("content-length", MAX_REQUEST_BODY_BYTES + 1)
                    .body(Body::from(vec![b'x'; 1024]))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), Status::PAYLOAD_TOO_LARGE);
    }

    /// `/actuator/**` used to fall through to the SPA branch, which answers any
    /// extension-less path with 200 index.html. Spring returned 403 to non-admins and
    /// 404 for endpoints it never exposed; either way, never the app shell.
    #[tokio::test]
    async fn unknown_actuator_paths_do_not_serve_the_spa_shell() {
        let app = build_router(test_state("/tlhub"));

        let response = app
            .oneshot(
                Request::get("/tlhub/actuator/metrics")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), Status::NOT_FOUND);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert!(
            !bytes.starts_with(b"<!doctype html>"),
            "actuator paths must not render the SPA"
        );
    }

    /// The loggers endpoint carries Spring's `hasRole(\"ADMIN\")` guard; unauthenticated
    /// callers get the security 403 shape, not a level dump.
    #[tokio::test]
    async fn loggers_endpoint_requires_authentication() {
        let app = build_router(test_state("/tlhub"));

        let response = app
            .oneshot(
                Request::get("/tlhub/actuator/loggers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), Status::FORBIDDEN);
    }

    /// The upload route is where the 2 MB default actually hurt. Without a Bearer token
    /// the request stops at the auth extractor, which is the point: reaching auth at all
    /// proves the 3 MB body was not rejected for its size on the way in.
    #[tokio::test]
    async fn multipart_uploads_over_two_megabytes_reach_the_handler() {
        let app = build_router(test_state("/tlhub"));
        let boundary = "TESTBOUNDARY";
        let mut body = Vec::new();
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; \
                 filename=\"page.png\"\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend(std::iter::repeat_n(b'A', 3 * 1024 * 1024));
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

        let response = app
            .oneshot(
                Request::post("/tlhub/api/images")
                    .header(
                        "content-type",
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .header("content-length", body.len())
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_ne!(response.status(), Status::PAYLOAD_TOO_LARGE);
        assert_eq!(
            response.status(),
            Status::FORBIDDEN,
            "expected the auth extractor, not a body-size rejection"
        );
    }

    /// Spring set `server.compression.enabled: true`; the Rust binary now serves the SPA
    /// itself and Traefik in front carries no compress middleware, so losing this shipped
    /// the whole frontend bundle and every JSON list response uncompressed.
    #[tokio::test]
    async fn large_json_responses_are_compressed_when_the_client_asks() {
        let app = build_router(test_state("/tlhub"));

        let response = app
            .oneshot(
                Request::get("/tlhub/v3/api-docs")
                    .header("accept-encoding", "gzip")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), Status::OK);
        assert_eq!(
            response
                .headers()
                .get("content-encoding")
                .and_then(|value| value.to_str().ok()),
            Some("gzip"),
            "the golden spec is far past the 2 KB threshold"
        );
    }

    /// The SSE stream must never be routed through an encoder, or notifications buffer
    /// instead of arriving as they are emitted. DefaultPredicate excludes it; assert that
    /// rather than trusting the dependency to keep doing so.
    #[tokio::test]
    async fn event_streams_are_never_compressed() {
        use tower_http::compression::Predicate;

        let sse = axum::http::Response::builder()
            .header("content-type", "text/event-stream")
            .body(Body::empty())
            .unwrap();
        assert!(!compressible().should_compress(&sse));

        let zip = axum::http::Response::builder()
            .header("content-type", "application/zip")
            .header("content-length", 5_000_000)
            .body(Body::empty())
            .unwrap();
        assert!(!compressible().should_compress(&zip), "export ZIPs");
    }
}
