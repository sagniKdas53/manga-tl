//! End-to-end tests for /api/images + /api/pages against REAL Postgres + MinIO.
//! Requires SPRING_DATASOURCE_URL and MINIO_TEST_ENDPOINT; skips otherwise.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use tower::ServiceExt;
use uuid::Uuid;

use manga_backend::config::{DatabaseConfig, MinioConfig, RedisConfig};
use manga_backend::db;
use manga_backend::jwt::JwtUtils;
use manga_backend::minio::MinioService;
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

async fn app() -> Option<(Router, sqlx::PgPool)> {
    let pool = db::connect(&db_config_from_env()?).await.ok()?;
    let minio = MinioConfig {
        endpoint: std::env::var("MINIO_TEST_ENDPOINT").ok()?,
        external_url: None,
        access_key: Some(
            std::env::var("MINIO_TEST_ACCESS_KEY").unwrap_or_else(|_| "minioadmin".into()),
        ),
        secret_key: Some(
            std::env::var("MINIO_TEST_SECRET_KEY").unwrap_or_else(|_| "minioadmin".into()),
        ),
    };
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
        minio: minio.clone(),
        redis: RedisConfig { host: "localhost".into(), port: 6379 },
    };
    let state = AppState::new(
        config,
        pool.clone(),
        JwtUtils::new(SECRET.into(), 3_600_000),
        MinioService::new(&minio),
        None,
    );
    Some((manga_backend::routes::build_router(state), pool))
}

async fn probe_user(pool: &sqlx::PgPool, jwt: &JwtUtils) -> String {
    let email = format!("__page-e2e-{}@example.invalid", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
         VALUES (uuid_generate_v4(), now(), 'Probe', $1, 'x', 'translator')",
    )
    .bind(&email)
    .execute(pool)
    .await
    .expect("probe user");
    jwt.generate_token(&email).unwrap()
}

/// Minimal valid PNG built in-process (64x64 solid colour).
fn png_bytes() -> Vec<u8> {
    let img = image::RgbaImage::from_fn(64, 64, |_, _| image::Rgba([120, 40, 40, 255]));
    let mut cursor = std::io::Cursor::new(Vec::new());
    img.write_to(&mut cursor, image::ImageFormat::Png).unwrap();
    cursor.into_inner()
}

/// Builds a multipart/form-data body for the upload endpoint.
fn multipart_body(chapter_id: &str, page_number: u32, filename: &str, png: &[u8]) -> Vec<u8> {
    let boundary = "__rust_probe_boundary__";
    let mut body = Vec::new();
    for (name, value) in [
        ("chapterId", chapter_id.to_string()),
        ("pageNumber", page_number.to_string()),
    ] {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes(),
        );
    }
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n\
             Content-Type: image/png\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(png);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

#[tokio::test]
async fn upload_stream_delete_lifecycle() {
    let Some((app, pool)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL or MINIO_TEST_ENDPOINT not set");
        return;
    };
    cleanup(&pool).await;
    let token =
        probe_user(&pool, &manga_backend::jwt::JwtUtils::new(SECRET.into(), 3_600_000)).await;

    // Chapter to upload into (series cascade cleans everything at the end).
    let response = send_json(
        app.clone(),
        "POST",
        "/tlhub/api/series",
        &token,
        r#"{"title":"Page E2E","readingDirection":"rightToLeft"}"#.to_string(),
    )
    .await;
    assert_eq!(response.0, StatusCode::OK);
    let series_id = json_field(&response.2, "id");

    let response = send_json(
        app.clone(),
        "POST",
        &format!("/tlhub/api/series/{series_id}/chapters"),
        &token,
        r#"{"chapterNumber":1}"#.to_string(),
    )
    .await;
    assert_eq!(response.0, StatusCode::OK);
    let chapter_id = json_field(&response.2, "id");

    // --- upload ---
    let body = multipart_body(&chapter_id, 1, "probe.png", &png_bytes());
    let response = send_multipart(app.clone(), "/tlhub/api/images", &token, body).await;
    assert_eq!(response.0, StatusCode::OK, "{}", response.2);
    let uploaded: serde_json::Value = serde_json::from_str(&response.2).unwrap();
    assert_eq!(uploaded["status"], "processing");
    let page_id = uploaded["pageId"].as_str().unwrap().to_string();
    let image_id = uploaded["imageId"].as_str().unwrap().to_string();

    // --- idempotent re-upload into same slot ---
    let body = multipart_body(&chapter_id, 1, "probe.png", &png_bytes());
    let response = send_multipart(app.clone(), "/tlhub/api/images", &token, body).await;
    let again: serde_json::Value = serde_json::from_str(&response.2).unwrap();
    assert_eq!(again["status"], "already_exists", "{}", response.2);

    // --- list pages ---
    let response = send_get(app.clone(), &format!("/tlhub/api/chapters/{chapter_id}/pages"), &token).await;
    assert_eq!(response.0, StatusCode::OK);
    let list: serde_json::Value = serde_json::from_str(&response.2).unwrap();
    assert_eq!(list["totalElements"], 1);
    assert_eq!(list["content"][0]["pageNumber"], 1);
    assert!(list["content"][0]["thumbnailUrl"].as_str().unwrap().contains("/thumbnail"));

    // --- thumbnail is a real WebP ---
    let response =
        send_get(app.clone(), &format!("/tlhub/api/images/{image_id}/thumbnail"), &token).await;
    assert_eq!(response.0, StatusCode::OK);
    assert_eq!(response.1, "image/webp");
    assert!(response.3 > 100, "thumbnail must have real bytes");

    // --- original streams back byte-identical with immutable cache headers ---
    let response = send_get(app.clone(), &format!("/tlhub/api/images/{image_id}/file"), &token).await;
    assert_eq!(response.0, StatusCode::OK);
    assert_eq!(response.3 as usize, png_bytes().len());

    // --- rendered absent -> 404 (nothing rendered yet) ---
    let response =
        send_get(app.clone(), &format!("/tlhub/api/pages/{page_id}/rendered"), &token).await;
    assert_eq!(response.0, StatusCode::NOT_FOUND);

    // --- rich page payload keys ---
    let response = send_get(app.clone(), &format!("/tlhub/api/pages/{page_id}"), &token).await;
    assert_eq!(response.0, StatusCode::OK);
    let payload: serde_json::Value = serde_json::from_str(&response.2).unwrap();
    for key in ["page", "image", "url", "panels", "ocrRegions", "conversations", "layers"] {
        assert!(payload.get(key).is_some(), "missing {key}");
    }

    // --- teardown cascades chapters/pages/images with the series ---
    cleanup(&pool).await;
}

/// keep the unused-var lint quiet for ids consumed implicitly above.
#[allow(dead_code)]
fn _ids(_a: &str, _b: &str) {}

// ---- tiny helpers ------------------------------------------------------------

type SendResult = (StatusCode, String, String, usize);

async fn send_json(app: Router, method: &str, uri: &str, token: &str, body: String) -> SendResult {
    let response = app
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    finalize(response).await
}

async fn send_get(app: Router, uri: &str, token: &str) -> SendResult {
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    finalize(response).await
}

async fn send_multipart(app: Router, uri: &str, token: &str, body: Vec<u8>) -> SendResult {
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("Authorization", format!("Bearer {token}"))
                .header(
                    "Content-Type",
                    "multipart/form-data; boundary=__rust_probe_boundary__",
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    finalize(response).await
}

async fn finalize(response: axum::http::Response<Body>) -> SendResult {
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let len = bytes.len();
    (status, content_type, String::from_utf8_lossy(&bytes).to_string(), len)
}

fn json_field(body: &str, field: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .expect("json body")[field]
        .as_str()
        .expect(field)
        .to_string()
}

/// Sweeps ALL probe-owned series then users — safe against leftovers from earlier
/// runs that died mid-test (the FK blocks user deletion while any series remains).
async fn cleanup(pool: &sqlx::PgPool) {
    sqlx::query(
        "DELETE FROM series WHERE created_by IN (SELECT id FROM users WHERE email LIKE '__page-e2e-%')",
    )
    .execute(pool)
    .await
    .expect("series cleanup");
    // images.created_by also references users; pages already cascaded with series above.
    sqlx::query(
        "DELETE FROM images WHERE created_by IN (SELECT id FROM users WHERE email LIKE '__page-e2e-%')",
    )
    .execute(pool)
    .await
    .expect("image cleanup");
    sqlx::query("DELETE FROM users WHERE email LIKE '__page-e2e-%'")
        .execute(pool)
        .await
        .expect("user cleanup");
}
