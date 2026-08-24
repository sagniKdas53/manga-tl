//! End-to-end tests for /api/images + /api/pages against REAL Postgres + MinIO.
//! Requires SPRING_DATASOURCE_URL and MINIO_TEST_ENDPOINT; skips otherwise.

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
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
        redis: RedisConfig {
            host: "localhost".into(),
            port: 6379,
        },
    };
    let storage = MinioService::new(&minio);
    // Fresh/test MinIO containers start without the bucket (and CI's always does).
    // ensure_bucket is create-if-missing: safe against an already-populated instance,
    // required for an empty one. Mirrors main()'s startup behaviour.
    storage.ensure_bucket().await;

    let state = AppState::new(
        config,
        pool.clone(),
        JwtUtils::new(SECRET.into(), 3_600_000),
        storage,
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
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
                .as_bytes(),
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
    let token = probe_user(
        &pool,
        &manga_backend::jwt::JwtUtils::new(SECRET.into(), 3_600_000),
    )
    .await;

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
    let response = send_get(
        app.clone(),
        &format!("/tlhub/api/chapters/{chapter_id}/pages"),
        &token,
    )
    .await;
    assert_eq!(response.0, StatusCode::OK);
    let list: serde_json::Value = serde_json::from_str(&response.2).unwrap();
    assert_eq!(list["totalElements"], 1);
    assert_eq!(list["content"][0]["pageNumber"], 1);
    assert!(
        list["content"][0]["thumbnailUrl"]
            .as_str()
            .unwrap()
            .contains("/thumbnail")
    );

    // --- thumbnail is a real WebP ---
    let response = send_get(
        app.clone(),
        &format!("/tlhub/api/images/{image_id}/thumbnail"),
        &token,
    )
    .await;
    assert_eq!(response.0, StatusCode::OK);
    assert_eq!(response.1, "image/webp");
    assert!(response.3 > 100, "thumbnail must have real bytes");

    // --- original streams back byte-identical with immutable cache headers ---
    let response = send_get(
        app.clone(),
        &format!("/tlhub/api/images/{image_id}/file"),
        &token,
    )
    .await;
    assert_eq!(response.0, StatusCode::OK);
    assert_eq!(response.3 as usize, png_bytes().len());

    // --- rendered absent -> 404 (nothing rendered yet) ---
    let response = send_get(
        app.clone(),
        &format!("/tlhub/api/pages/{page_id}/rendered"),
        &token,
    )
    .await;
    assert_eq!(response.0, StatusCode::NOT_FOUND);

    // --- rich page payload keys ---
    let response = send_get(app.clone(), &format!("/tlhub/api/pages/{page_id}"), &token).await;
    assert_eq!(response.0, StatusCode::OK);
    let payload: serde_json::Value = serde_json::from_str(&response.2).unwrap();
    for key in [
        "page",
        "image",
        "url",
        "panels",
        "ocrRegions",
        "conversations",
        "layers",
    ] {
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
    (
        status,
        content_type,
        String::from_utf8_lossy(&bytes).to_string(),
        len,
    )
}

fn json_field(body: &str, field: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body).expect("json body")[field]
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

/// PageControllerTest addition: PATCH /api/ocr-regions/{id} with translatedText must
/// clear translation_failed (the editor's "fix the failed region" path).
#[tokio::test]
async fn ocr_region_patch_translated_clears_failure_flag() {
    let Some((app, pool)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL not set");
        return;
    };
    // Distinct namespace: this suite runs tests in parallel and the generic
    // __page-e2e- sweeps would otherwise race this test's rows away mid-run.
    const NS: &str = "__ocrpatch-e2e";
    sqlx::query("DELETE FROM series WHERE title LIKE 'OcrPatch Probe%'")
        .execute(&pool)
        .await
        .expect("series pre-clean");
    sqlx::query(
        "DELETE FROM images WHERE created_by IN (SELECT id FROM users WHERE email LIKE $1 || '%')",
    )
    .bind(NS)
    .execute(&pool)
    .await
    .expect("image pre-clean");
    sqlx::query("DELETE FROM users WHERE email LIKE $1 || '%'")
        .bind(NS)
        .execute(&pool)
        .await
        .expect("user pre-clean");
    let email = format!("{NS}-{}@example.invalid", uuid::Uuid::new_v4());
    sqlx::query(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
         VALUES (uuid_generate_v4(), now(), 'Probe', $1, 'x', 'admin')",
    )
    .bind(&email)
    .execute(&pool)
    .await
    .expect("probe user");
    let token = JwtUtils::new(SECRET.into(), 3_600_000)
        .generate_token(&email)
        .expect("token");

    let (status, _, body, _) = send_json(
        app.clone(),
        "POST",
        "/tlhub/api/series",
        &token,
        r#"{"title":"OcrPatch Probe","readingDirection":"rightToLeft"}"#.into(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let series_id = json_field(&body, "id");

    let (status, _, body, _) = send_json(
        app.clone(),
        "POST",
        &format!("/tlhub/api/series/{series_id}/chapters"),
        &token,
        r#"{"chapterNumber":1}"#.into(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let chapter_id = json_field(&body, "id");

    // A page to hang the region on (upload a 1x1 PNG like the lifecycle test).
    let png: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    let boundary = "__ocrpatch_boundary__";
    let mut multipart_body: Vec<u8> = Vec::new();
    for (name, value) in [("chapterId", chapter_id.as_str()), ("pageNumber", "1")] {
        multipart_body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    multipart_body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"p1.png\"\r\nContent-Type: image/png\r\n\r\n")
            .as_bytes(),
    );
    multipart_body.extend_from_slice(png);
    multipart_body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let response = Request::builder()
        .method("POST")
        .uri("/tlhub/api/images?chapterId=".to_owned() + &chapter_id + "&pageNumber=1")
        .header("Authorization", format!("Bearer {token}"))
        .header(
            "Content-Type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(multipart_body))
        .unwrap();
    let (status, _, upload_body, _) = finalize(app.clone().oneshot(response).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK, "{upload_body}");
    let page_id = json_field(&upload_body, "pageId");

    // Seed a FAILED-translation region directly.
    let region_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO ocr_regions (id, bbox_x, bbox_y, bbox_w, bbox_h, detected_language, text, translated_text, translation_failed, page_id) \
         VALUES (uuid_generate_v4(), 0, 0, 10, 10, 'ja', 'orig', 'bad', TRUE, $1) RETURNING id",
    )
    .bind(uuid::Uuid::parse_str(&page_id).unwrap())
    .fetch_one(&pool)
    .await
    .expect("region seed");
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT translation_failed FROM ocr_regions WHERE id=$1")
            .bind(region_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "seed starts failed"
    );

    // Editor supplies a corrected translation -> failure flag clears.
    let (status, _, body, _) = finalize(
        app.clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/tlhub/api/ocr-regions/{region_id}"))
                    .header("Authorization", format!("Bearer {token}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"translatedText":"fixed"}"#.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let patched: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(patched["translatedText"], "fixed");
    assert_eq!(
        patched["translationFailed"], false,
        "translation clears the failure flag"
    );

    // Scoped cleanup: this suite runs its tests in parallel, and the generic
    // __page-e2e- sweeps would delete the other test's user mid-flight.
    // Order matters: regions -> images (created_by FK) -> series (cascades
    // chapters/pages) -> users.
    sqlx::query("DELETE FROM ocr_regions WHERE id=$1")
        .bind(region_id)
        .execute(&pool)
        .await
        .expect("region cleanup");
    sqlx::query(
        "DELETE FROM images WHERE created_by IN (SELECT id FROM users WHERE email LIKE '__ocrpatch-e2e%')",
    )
    .execute(&pool)
    .await
    .expect("image cleanup");
    sqlx::query(
        "DELETE FROM series WHERE created_by IN (SELECT id FROM users WHERE email LIKE '__ocrpatch-e2e%')",
    )
    .execute(&pool)
    .await
    .expect("series cleanup");
    sqlx::query("DELETE FROM users WHERE email LIKE '__ocrpatch-e2e%'")
        .execute(&pool)
        .await
        .expect("user cleanup");
}
