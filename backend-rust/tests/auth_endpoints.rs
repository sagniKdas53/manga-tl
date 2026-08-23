//! End-to-end tests for /api/auth/** against a REAL Postgres, exercising the exact
//! wire contract captured from the running Java backend (status codes, content types,
//! body shapes, validation messages).
//!
//! Uses throwaway `__auth-e2e-*` accounts and deletes them afterwards.

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

use manga_backend::config::{DatabaseConfig, MinioConfig};
use manga_backend::db;
use manga_backend::jwt::JwtUtils;
use manga_backend::minio::MinioService;
use manga_backend::state::AppState;

const PROBE_EMAIL: &str = "__auth-e2e@example.invalid";
const PROBE_PASSWORD: &str = "probe-password-1";
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

async fn app() -> Option<(Router, sqlx::PgPool)> {
    let pool = db::connect(&db_config_from_env()?).await.ok()?;
    let config = manga_backend::config::Config {
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
        minio: MinioConfig {
            endpoint: "http://localhost:9000".into(),
            external_url: None,
            access_key: Some("minioadmin".into()),
            secret_key: Some("minioadmin".into()),
        },
        redis: manga_backend::config::RedisConfig {
            host: "localhost".into(),
            port: 6379,
        },
    };
    let state = AppState::new(
        config,
        pool,
        JwtUtils::new(SECRET.into(), 3_600_000),
        MinioService::new(&MinioConfig {
            endpoint: "http://localhost:9000".into(),
            external_url: None,
            access_key: Some("minioadmin".into()),
            secret_key: Some("minioadmin".into()),
        }),
        None,
    );
    let pool = state.pool.clone();
    Some((manga_backend::routes::build_router(state), pool))
}

async fn send(
    app: Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    json: Option<String>,
) -> axum::http::Response<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("Authorization", format!("Bearer {token}"));
    }
    if json.is_some() {
        builder = builder.header("Content-Type", "application/json");
    }
    app.oneshot(builder.body(Body::from(json.unwrap_or_default())).unwrap())
        .await
        .unwrap()
}

async fn body_string(response: axum::http::Response<Body>) -> (StatusCode, String, String) {
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        content_type,
        String::from_utf8_lossy(&bytes).to_string(),
    )
}

async fn cleanup(pool: &sqlx::PgPool) {
    sqlx::query("DELETE FROM users WHERE email LIKE '__auth-e2e%'")
        .execute(pool)
        .await
        .expect("cleanup");
}

#[tokio::test]
async fn full_account_lifecycle() {
    let Some((app, pool)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL not set");
        return;
    };
    cleanup(&pool).await;

    // --- setup-required is public JSON ---
    let (status, _, body) = body_string(
        send(
            app.clone(),
            "GET",
            "/tlhub/api/auth/setup-required",
            None,
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("\"setupRequired\""), "{body}");

    // --- register: validation collects ALL field errors, problem+json ---
    let (_, ctype, body) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/auth/register",
            None,
            Some(r#"{"email":"","password":"123","displayName":""}"#.into()),
        )
        .await,
    )
    .await;
    assert_eq!(ctype, "application/problem+json");
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(parsed["title"], "Validation Failed");
    assert_eq!(parsed["errors"]["email"], "Email is required");
    assert_eq!(
        parsed["errors"]["password"],
        "size must be between 6 and 2147483647"
    );
    assert_eq!(parsed["errors"]["displayName"], "Display name is required");

    // --- register: bad email format message ---
    let (_, _, body) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/auth/register",
            None,
            Some(r#"{"email":"not-an-email","password":"long-enough","displayName":"x"}"#.into()),
        )
        .await,
    )
    .await;
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["errors"]["email"],
        "Invalid email format"
    );

    // --- register: admin role rejected once any user exists ---
    let (status, ctype, body) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/auth/register",
            None,
            Some(format!(r#"{{"email":"{PROBE_EMAIL}","password":"{PROBE_PASSWORD}","displayName":"E2E Probe","role":"admin"}}"#)),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(ctype, "text/plain;charset=UTF-8");
    assert_eq!(
        body,
        "Cannot register as Admin. Admin is created on first registration."
    );

    // --- register: success returns AuthResponse with token ---
    let (status, _, body) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/auth/register",
            None,
            Some(format!(r#"{{"email":"{PROBE_EMAIL}","password":"{PROBE_PASSWORD}","displayName":"E2E Probe","role":"translator"}}"#)),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(parsed["email"], PROBE_EMAIL);
    assert_eq!(parsed["displayName"], "E2E Probe");
    assert_eq!(parsed["role"], "translator");
    assert!(parsed["token"].as_str().unwrap().split('.').count() == 3);
    assert!(parsed["id"].as_str().is_some());

    // --- register: duplicate email is plain-text 400 ---
    let (status, ctype, body) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/auth/register",
            None,
            Some(format!(
                r#"{{"email":"{PROBE_EMAIL}","password":"{PROBE_PASSWORD}","displayName":"dup"}}"#
            )),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(ctype, "text/plain;charset=UTF-8");
    assert_eq!(body, "Email already exists");

    // --- login failure: plain text 401 exactly like Java ---
    let (status, ctype, body) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/auth/login",
            None,
            Some(format!(
                r#"{{"email":"{PROBE_EMAIL}","password":"totally-wrong"}}"#
            )),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(ctype, "text/plain;charset=UTF-8");
    assert_eq!(body, "Invalid credentials");

    // --- login success; token works on GET /me (role verbatim, null token) ---
    let (_, _, body) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/auth/login",
            None,
            Some(format!(
                r#"{{"email":"{PROBE_EMAIL}","password":"{PROBE_PASSWORD}"}}"#
            )),
        )
        .await,
    )
    .await;
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    let token = parsed["token"].as_str().unwrap().to_string();

    let (status, _, body) =
        body_string(send(app.clone(), "GET", "/tlhub/api/auth/me", Some(&token), None).await).await;
    assert_eq!(status, StatusCode::OK);
    let me: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        me["token"],
        serde_json::Value::Null,
        "GET /me token must be explicit null"
    );
    assert_eq!(me["email"], PROBE_EMAIL);

    // --- unauthenticated /me is the CONTROLLER's 401 shape, not security's 403 ---
    let (status, ctype, body) =
        body_string(send(app.clone(), "GET", "/tlhub/api/auth/me", None, None).await).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(ctype, "application/json");
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(parsed["message"], "Not authenticated");

    // --- PUT /me updates displayName; blank means no-change ---
    let (status, _, body) = body_string(
        send(
            app.clone(),
            "PUT",
            "/tlhub/api/auth/me",
            Some(&token),
            Some(r#"{"displayName":"Renamed Probe"}"#.into()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["displayName"],
        "Renamed Probe"
    );
    let (status, _, body) = body_string(
        send(
            app.clone(),
            "PUT",
            "/tlhub/api/auth/me",
            Some(&token),
            Some(r#"{"displayName":"   "}"#.into()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["displayName"],
        "Renamed Probe",
        "blank display name must be ignored"
    );

    // --- change-password: wrong current is problem-less 403 JSON; then success ---
    let (status, _, body) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/auth/change-password",
            Some(&token),
            Some(r#"{"currentPassword":"nope","newPassword":"brand-new-pw"}"#.into()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["message"],
        "Current password is incorrect"
    );
    let (status, _, body) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/auth/change-password",
            Some(&token),
            Some(format!(
                r#"{{"currentPassword":"{PROBE_PASSWORD}","newPassword":"brand-new-pw"}}"#
            )),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["message"],
        "Password changed successfully"
    );

    // old password no longer logs in; new one does
    let (status, _, _) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/auth/login",
            None,
            Some(format!(
                r#"{{"email":"{PROBE_EMAIL}","password":"{PROBE_PASSWORD}"}}"#
            )),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (_, _, body) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/auth/login",
            None,
            Some(r#"{"email":"__auth-e2e@example.invalid","password":"brand-new-pw"}"#.into()),
        )
        .await,
    )
    .await;
    assert!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["token"]
            .as_str()
            .is_some()
    );

    // --- DELETE /me removes the account; subsequent login fails ---
    let (status, _, body) = body_string(
        send(
            app.clone(),
            "DELETE",
            "/tlhub/api/auth/me",
            Some(&token),
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["message"],
        "Account deleted successfully"
    );
    let (status, _, _) = body_string(
        send(
            app.clone(),
            "POST",
            "/tlhub/api/auth/login",
            None,
            Some(r#"{"email":"__auth-e2e@example.invalid","password":"brand-new-pw"}"#.into()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    cleanup(&pool).await;
}
