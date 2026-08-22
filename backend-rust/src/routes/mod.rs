//! Router assembly — the Rust equivalent of Spring's DispatcherServlet setup.
//!
//! Mental model:
//!   * an axum `Router` maps method+path -> handler function
//!   * `nest(prefix, router)` mounts a sub-router under a URL prefix
//!     (this replaces Spring's `server.servlet.context-path=/tlhub`)
//!   * `.with_state(state)` attaches the shared AppState to all handlers in the router
//!   * middleware ("layers") wrap every request; TraceLayer logs method/path/status/duration

pub mod health;

use axum::Router;
use tower_http::trace::TraceLayer;

use crate::state::AppState;

/// Builds the complete application router.
pub fn build_router(state: AppState) -> Router {
    // Config::load already normalized this to "" | "/" | "/something".
    let context_path = state.config.context_path.clone();

    // The inner router holds everything Spring served relative to its context path.
    // Phase 2 will add `.nest("/api", api::router())` here.
    let inner = Router::new().merge(health::router()).with_state(state);

    let app = if context_path == "/" {
        inner
    } else {
        Router::new().nest(&context_path, inner)
    };

    app.layer(TraceLayer::new_for_http())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, DatabaseConfig};
    use axum::body::Body;
    use axum::http::{Request, Response, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt; // adds .oneshot() so tests drive the router without a real port

    fn test_state(context_path: &str) -> AppState {
        // connect_lazy_with builds a pool that performs NO I/O until first used —
        // exactly what router tests want.
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy_with(sqlx::postgres::PgConnectOptions::new().host("localhost"));
        let minio_config = crate::config::MinioConfig {
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
                host: "localhost".to_string(),
                port: 5432,
                name: "test".to_string(),
                user: "postgres".to_string(),
                password: "pw".to_string(),
            },
            jwt_secret: None,
            internal_api_token: None,
            jwt_expiration_ms: 3_600_000,
            redis: crate::config::RedisConfig {
                host: "localhost".into(),
                port: 6379,
            },
            minio: minio_config.clone(),
        };
        AppState::new(
            config,
            pool,
            crate::jwt::JwtUtils::new(
                "test-secret-long-enough-for-hmac-signing-1234".into(),
                3_600_000,
            ),
            crate::minio::MinioService::new(&minio_config),
            None, // RedisService: router tests need no live Redis
        )
    }

    async fn body_string(response: Response<Body>) -> String {
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body collect")
            .to_bytes();
        String::from_utf8(bytes.to_vec()).expect("utf-8 body")
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

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_string(response).await, r#"{"status":"UP"}"#);
    }

    #[tokio::test]
    async fn health_404_outside_context_path() {
        let app = build_router(test_state("/tlhub"));

        let response = app
            .oneshot(
                Request::get("/actuator/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
