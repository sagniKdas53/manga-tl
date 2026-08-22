//! End-to-end auth middleware tests against a REAL Postgres (same skip-if-unset contract
//! as db_entities.rs): mint a JWT with JwtUtils, insert a user in a rolled-back
//! transaction, and drive the AuthUser extractor through a probe route.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use http_body_util::BodyExt;
use tower::ServiceExt;

use manga_backend::auth::AuthUser;
use manga_backend::config::DatabaseConfig;
use manga_backend::db;
use manga_backend::jwt::JwtUtils;
use manga_backend::state::AppState;

const SECRET: &str = "test-secret-long-enough-for-hmac-signing-1234567890";

fn db_config_from_env() -> Option<DatabaseConfig> {
    let url = std::env::var("SPRING_DATASOURCE_URL").ok()?;
    let rest = url.strip_prefix("jdbc:postgresql://")?;
    let (hostport, name) = rest.split_once('/')?;
    let (host, port) = match hostport.split_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().ok()?),
        None => (hostport.to_string(), 5432),
    };
    Some(DatabaseConfig {
        host,
        port,
        name: name.to_string(),
        user: std::env::var("SPRING_DATASOURCE_USERNAME").unwrap_or_else(|_| "postgres".into()),
        password: std::env::var("SPRING_DATASOURCE_PASSWORD").unwrap_or_default(),
    })
}

async fn test_state() -> Option<AppState> {
    let pool = db::connect(&db_config_from_env()?).await.ok()?;
    Some(AppState::new(
        test_config(),
        pool,
        JwtUtils::new(SECRET.into(), 3_600_000),
        manga_backend::minio::MinioService::new(&manga_backend::config::MinioConfig {
            endpoint: "http://localhost:9000".into(),
            external_url: None,
            access_key: Some("minioadmin".into()),
            secret_key: Some("minioadmin".into()),
        }),
    ))
}

fn test_config() -> manga_backend::config::Config {
    // Config fields are plain data; tests build them directly instead of reading env.
    manga_backend::config::Config {
        context_path: "/tlhub".into(),
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
        minio: manga_backend::config::MinioConfig {
            endpoint: "http://localhost:9000".into(),
            external_url: None,
            access_key: Some("minioadmin".into()),
            secret_key: Some("minioadmin".into()),
        },
    }
}

async fn probe(user: AuthUser) -> Json<String> {
    Json(format!("{}:{}", user.email, user.role))
}

fn router_with_probe(state: AppState) -> Router {
    Router::new().route("/probe", get(probe)).with_state(state)
}

#[tokio::test]
async fn valid_token_and_existing_user_authenticates() {
    let Some(state) = test_state().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL not set");
        return;
    };

    // The middleware reads through the POOL, so the user row must be committed —
    // a rolled-back transaction would be invisible to it. Delete before and after.
    sqlx::query("DELETE FROM users WHERE email = '__auth-probe@example.invalid'")
        .execute(&state.pool)
        .await
        .expect("pre-clean");
    sqlx::query(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
         VALUES (uuid_generate_v4(), now(), 'Probe User', '__auth-probe@example.invalid', 'x', 'admin')",
    )
    .execute(&state.pool)
    .await
    .expect("insert");

    let token = state
        .jwt
        .generate_token("__auth-probe@example.invalid")
        .unwrap();

    let app = router_with_probe(state.clone());
    let response = app
        .oneshot(
            Request::get("/probe")
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        &body[..],
        &br#""__auth-probe@example.invalid:ADMIN""#[..],
        "role uppercased like Java"
    );

    sqlx::query("DELETE FROM users WHERE email = '__auth-probe@example.invalid'")
        .execute(&state.pool)
        .await
        .expect("cleanup");
}

#[tokio::test]
async fn missing_token_gets_springs_403_shape() {
    let Some(state) = test_state().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL not set");
        return;
    };

    let response = router_with_probe(state)
        .oneshot(Request::get("/probe").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["status"], 403);
    assert_eq!(json["error"], "Forbidden");
    assert_eq!(json["path"], "/tlhub/probe");
    // Millisecond ISO timestamp with explicit +00:00 offset.
    let ts = json["timestamp"].as_str().expect("timestamp string");
    assert!(ts.ends_with("+00:00") && ts.contains('.'), "got {ts}");
}
