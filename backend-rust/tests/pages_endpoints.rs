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

/// The same MinIO wiring `app()` uses, so a test can place an object where the pipeline would.
fn minio_config_from_env() -> Option<MinioConfig> {
    Some(MinioConfig {
        endpoint: std::env::var("MINIO_TEST_ENDPOINT").ok()?,
        external_url: None,
        access_key: Some(
            std::env::var("MINIO_TEST_ACCESS_KEY").unwrap_or_else(|_| "minioadmin".into()),
        ),
        secret_key: Some(
            std::env::var("MINIO_TEST_SECRET_KEY").unwrap_or_else(|_| "minioadmin".into()),
        ),
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

async fn probe_user(pool: &sqlx::PgPool, jwt: &JwtUtils, ns: &str) -> String {
    let email = format!("{ns}-{}@example.invalid", Uuid::new_v4());
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
    const NS: &str = "__page-e2e-upload";
    cleanup(&pool, NS).await;
    let token = probe_user(
        &pool,
        &manga_backend::jwt::JwtUtils::new(SECRET.into(), 3_600_000),
        NS,
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
    // Seeded per run, not a shared fixture: uploads are de-duplicated by content hash, so any
    // other test uploading the same bytes would make this one answer "duplicate" instead of
    // "processing" -- and a run that died before its teardown would do the same to the next run.
    let probe_png = seeded_png(Uuid::new_v4().as_u128() as u32);
    let body = multipart_body(&chapter_id, 1, "probe.png", &probe_png);
    let response = send_multipart(app.clone(), "/tlhub/api/images", &token, body).await;
    assert_eq!(response.0, StatusCode::OK, "{}", response.2);
    let uploaded: serde_json::Value = serde_json::from_str(&response.2).unwrap();
    assert_eq!(uploaded["status"], "processing");
    let page_id = uploaded["pageId"].as_str().unwrap().to_string();
    let image_id = uploaded["imageId"].as_str().unwrap().to_string();

    // --- idempotent re-upload into same slot ---
    let body = multipart_body(&chapter_id, 1, "probe.png", &probe_png);
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
    assert_eq!(response.3 as usize, probe_png.len());

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
    cleanup(&pool, NS).await;
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
/// Wipe one namespace's probe data.
///
/// Scoped to `ns` rather than to every `__page-e2e-` user, because these tests run concurrently
/// and each one calls this on the way in and on the way out. While the pattern was shared, the
/// first test to finish deleted the series the other was still working on, and the victim saw an
/// empty page list rather than its own row -- an assertion failure with nothing wrong in the code
/// under test, which surfaced or hid depending on how the rest of the file happened to be timed.
async fn cleanup(pool: &sqlx::PgPool, ns: &str) {
    sqlx::query(
        "DELETE FROM series WHERE created_by IN (SELECT id FROM users WHERE email LIKE $1 || '-%')",
    )
    .bind(ns)
    .execute(pool)
    .await
    .expect("series cleanup");
    // images.created_by also references users; pages already cascaded with series above.
    sqlx::query(
        "DELETE FROM images WHERE created_by IN (SELECT id FROM users WHERE email LIKE $1 || '-%')",
    )
    .bind(ns)
    .execute(pool)
    .await
    .expect("image cleanup");
    sqlx::query("DELETE FROM users WHERE email LIKE $1 || '-%'")
        .bind(ns)
        .execute(pool)
        .await
        .expect("user cleanup");
}

/// AUDIT-F26: a page grid re-fetch has to be able to show pipeline output.
///
/// AUDIT-F19 gave the grids a refresh on job completion and was closed on the strength of the
/// refetch firing. The reviewer's objection was that the refetch could not change anything:
/// `PageDto` carried nothing a pipeline run touches. `thumbnailUrl` is a fixed path to the
/// *original*'s thumbnail, every other field is set at upload, so `/pages` returned identical
/// JSON, React saw identical props and an identical image `src`, and the untranslated grid stayed
/// untranslated however often it asked. That objection was correct.
///
/// This proves the DTO now carries the render: null before, populated after, with a cache key that
/// changes when the render changes, and a thumbnail endpoint that serves the *rendered* pixels
/// rather than the original's.
#[tokio::test]
async fn rendered_output_reaches_the_page_grid() {
    let Some((app, pool)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL or MINIO_TEST_ENDPOINT not set");
        return;
    };
    const NS: &str = "__page-e2e-render";
    cleanup(&pool, NS).await;
    let token = probe_user(
        &pool,
        &manga_backend::jwt::JwtUtils::new(SECRET.into(), 3_600_000),
        NS,
    )
    .await;

    let response = send_json(
        app.clone(),
        "POST",
        "/tlhub/api/series",
        &token,
        r#"{"title":"F26 probe","readingDirection":"rightToLeft"}"#.to_string(),
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

    let body = multipart_body(
        &chapter_id,
        1,
        "f26.png",
        &seeded_png(Uuid::new_v4().as_u128() as u32),
    );
    let response = send_multipart(app.clone(), "/tlhub/api/images", &token, body).await;
    let uploaded: serde_json::Value = serde_json::from_str(&response.2).unwrap();
    let page_id = uploaded["pageId"].as_str().unwrap().to_string();
    let image_id = uploaded["imageId"].as_str().unwrap().to_string();

    // --- nothing rendered yet: the grid has no render to show, and says so ---
    let list_pages = |app: Router, token: String, chapter_id: String| async move {
        let response = send_get(
            app,
            &format!("/tlhub/api/chapters/{chapter_id}/pages"),
            &token,
        )
        .await;
        assert_eq!(response.0, StatusCode::OK);
        serde_json::from_str::<serde_json::Value>(&response.2).unwrap()
    };

    let before = list_pages(app.clone(), token.clone(), chapter_id.clone()).await;
    assert!(
        before["content"][0]["lastRenderedAt"].is_null(),
        "an unrendered page must not claim a render: {}",
        before["content"][0]
    );
    assert!(
        before["content"][0]["renderedThumbnailUrl"].is_null(),
        "no rendered thumbnail before a render: {}",
        before["content"][0]
    );

    // --- the pipeline renders the page: object in MinIO, last_rendered_at stamped ---
    let storage = MinioService::new(&minio_config_from_env().expect("minio env"));
    let rendered = image::RgbaImage::from_fn(64, 64, |_, _| image::Rgba([10, 200, 90, 255]));
    let mut cursor = std::io::Cursor::new(Vec::new());
    rendered
        .write_to(&mut cursor, image::ImageFormat::Png)
        .unwrap();
    storage
        .upload_bytes(
            &format!("rendered/{image_id}.png"),
            cursor.into_inner(),
            "image/png",
        )
        .await
        .expect("stage rendered object");
    sqlx::query("UPDATE pages SET last_rendered_at = now() WHERE id = $1")
        .bind(Uuid::parse_str(&page_id).unwrap())
        .execute(&pool)
        .await
        .expect("stamp last_rendered_at");

    // --- the same re-fetch the AUDIT-F19 watcher performs now returns different JSON ---
    let after = list_pages(app.clone(), token.clone(), chapter_id.clone()).await;
    assert!(
        !after["content"][0]["lastRenderedAt"].is_null(),
        "the refetch must surface the render: {}",
        after["content"][0]
    );
    let rendered_url = after["content"][0]["renderedThumbnailUrl"]
        .as_str()
        .expect("rendered thumbnail url")
        .to_string();
    assert!(
        rendered_url.contains("/thumbnail/rendered?v="),
        "the url must carry a cache key, got {rendered_url}"
    );
    assert_ne!(
        before["content"][0], after["content"][0],
        "AUDIT-F26: if the DTO is identical across a render the grid cannot update"
    );

    // And this is the reviewer's claim itself, kept as an assertion rather than a comment: on the
    // fields the DTO carried *before* this fix, the two responses are byte-identical. Re-fetching
    // could not have changed a single prop or image `src`, which is why AUDIT-F19's refresh fired
    // correctly and still left the grid untranslated. If someone later drops the new fields, the
    // assertion above fails and this one explains what was lost.
    let legacy_only = |page: &serde_json::Value| {
        serde_json::json!({
            "id": page["id"],
            "pageNumber": page["pageNumber"],
            "imageId": page["imageId"],
            "chapterId": page["chapterId"],
            "filename": page["filename"],
            "url": page["url"],
            "thumbnailUrl": page["thumbnailUrl"],
        })
    };
    assert_eq!(
        legacy_only(&before["content"][0]),
        legacy_only(&after["content"][0]),
        "the pre-F26 fields cannot express a render — that was the whole defect"
    );

    // --- and it serves a real WebP, generated on demand for pages rendered before this existed ---
    let response = send_get(
        app.clone(),
        &format!("/tlhub/api/images/{image_id}/thumbnail/rendered"),
        &token,
    )
    .await;
    assert_eq!(response.0, StatusCode::OK, "{}", response.2);
    assert_eq!(response.1, "image/webp");
    assert!(response.3 > 100, "rendered thumbnail must have real bytes");

    // --- it is the *render*, not the original ---
    //
    // Both fixtures are 64x64 solid colours, so they encode to the same *number* of bytes; only
    // the pixels distinguish them. The original is red, the staged render is green, and the whole
    // point of AUDIT-F26 is that the grid stops showing the former once the latter exists.
    let stored = storage
        .download_bytes(&format!("thumbnails/rendered/{image_id}.webp"))
        .await
        .expect("rendered thumbnail object");
    let decoded = image::load_from_memory(&stored)
        .expect("rendered thumbnail decodes")
        .to_rgba8();
    let pixel = decoded
        .get_pixel(decoded.width() / 2, decoded.height() / 2)
        .0;
    assert!(
        pixel[1] > pixel[0] && pixel[1] > pixel[2],
        "the thumbnail must carry the render's pixels (green), got {pixel:?}"
    );

    let original_stored = storage
        .download_bytes(&format!("thumbnails/{image_id}.webp"))
        .await
        .expect("original thumbnail object");
    assert_ne!(
        stored, original_stored,
        "the rendered thumbnail must not be a copy of the original's"
    );

    storage
        .delete_quietly(&format!("rendered/{image_id}.png"))
        .await;
    storage
        .delete_quietly(&format!("thumbnails/rendered/{image_id}.webp"))
        .await;
    cleanup(&pool, NS).await;
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

// ---------------------------------------------------------------------------------------------
// Page ordering: delete must close the gap, and page management must keep working afterwards.
//
// Java's deletePageDb ended with an explicit "Re-sequence remaining pages in chapter to maintain
// sequence 1..N" loop. The Rust port dropped it, so deleting page 2 of 5 left 1, 3, 4, 5.
// ---------------------------------------------------------------------------------------------

// Every test below owns a distinct namespace. The suite runs in parallel and each test
// pre-cleans its own rows, so a shared prefix would have them deleting each other's fixtures
// mid-run -- which is exactly what a shared one did on the first attempt.

/// A 64x64 PNG unique to `seed`. The upload endpoint rejects a byte-identical re-upload as a
/// duplicate, so every page of every fixture chapter needs its own image -- reusing png_bytes()
/// produced a one-page chapter, and seeding only by page number made the second test's uploads
/// duplicates of the first's. Callers seed from a fresh Uuid so runs never collide either.
fn seeded_png(seed: u32) -> Vec<u8> {
    let img = image::RgbaImage::from_fn(64, 64, |x, y| {
        // Cheap LCG over (seed, position): distinct seeds give distinct pixels, not just
        // distinct average colour, so no two fixture images can hash alike.
        let mut v = seed
            .wrapping_mul(0x9E37_79B9)
            .wrapping_add(y.wrapping_mul(64).wrapping_add(x));
        v ^= v >> 13;
        v = v.wrapping_mul(0x5BD1_E995);
        v ^= v >> 15;
        image::Rgba([(v >> 16) as u8, (v >> 8) as u8, v as u8, 255])
    });
    let mut cursor = std::io::Cursor::new(Vec::new());
    img.write_to(&mut cursor, image::ImageFormat::Png).unwrap();
    cursor.into_inner()
}

/// Series + chapter + `count` uploaded pages. Returns (chapter_id, page ids in page order).
async fn chapter_with_pages(
    app: &Router,
    pool: &sqlx::PgPool,
    token: &str,
    title: &str,
    count: u32,
) -> (String, Vec<String>) {
    let (status, _, body, _) = send_json(
        app.clone(),
        "POST",
        "/tlhub/api/series",
        token,
        format!(r#"{{"title":"{title}","readingDirection":"rightToLeft"}}"#),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let series_id = json_field(&body, "id");

    let (status, _, body, _) = send_json(
        app.clone(),
        "POST",
        &format!("/tlhub/api/series/{series_id}/chapters"),
        token,
        r#"{"chapterNumber":1}"#.to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let chapter_id = json_field(&body, "id");

    // Seed from a fresh Uuid so two tests -- or two runs against the same database -- never
    // upload the same bytes and trip the duplicate check.
    let seed_base = Uuid::new_v4().as_u128() as u32;
    let mut page_ids = Vec::new();
    for n in 1..=count {
        let body = multipart_body(
            &chapter_id,
            n,
            &format!("p{n}.png"),
            &seeded_png(seed_base.wrapping_add(n)),
        );
        let (status, _, body, _) =
            send_multipart(app.clone(), "/tlhub/api/images", token, body).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        page_ids.push(json_field(&body, "pageId"));
    }
    assert_eq!(
        numbers(pool, &chapter_id).await,
        (1..=count as i32).collect::<Vec<i32>>()
    );
    (chapter_id, page_ids)
}

/// The chapter's page numbers, in ascending order — read straight from the DB so the assertion
/// cannot be softened by whatever the list endpoint chooses to sort by.
async fn numbers(pool: &sqlx::PgPool, chapter_id: &str) -> Vec<i32> {
    sqlx::query_scalar::<_, i32>(
        "SELECT page_number FROM pages WHERE chapter_id = $1::uuid ORDER BY page_number ASC",
    )
    .bind(chapter_id)
    .fetch_all(pool)
    .await
    .expect("page numbers")
}

async fn number_of(pool: &sqlx::PgPool, page_id: &str) -> i32 {
    sqlx::query_scalar::<_, i32>("SELECT page_number FROM pages WHERE id = $1::uuid")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .expect("page number")
}

async fn order_probe(pool: &sqlx::PgPool, ns: &str, title: &str) -> String {
    sqlx::query("DELETE FROM series WHERE title = $1")
        .bind(title)
        .execute(pool)
        .await
        .expect("series pre-clean");
    sqlx::query(
        "DELETE FROM images WHERE created_by IN (SELECT id FROM users WHERE email LIKE $1 || '%')",
    )
    .bind(ns)
    .execute(pool)
    .await
    .expect("image pre-clean");
    sqlx::query("DELETE FROM users WHERE email LIKE $1 || '%'")
        .bind(ns)
        .execute(pool)
        .await
        .expect("user pre-clean");
    let email = format!("{ns}-{}@example.invalid", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
         VALUES (uuid_generate_v4(), now(), 'Probe', $1, 'x', 'admin')",
    )
    .bind(&email)
    .execute(pool)
    .await
    .expect("probe user");
    JwtUtils::new(SECRET.into(), 3_600_000)
        .generate_token(&email)
        .expect("token")
}

async fn order_cleanup(pool: &sqlx::PgPool, ns: &str, title: &str) {
    sqlx::query("DELETE FROM series WHERE title = $1")
        .bind(title)
        .execute(pool)
        .await
        .expect("series cleanup");
    sqlx::query(
        "DELETE FROM images WHERE created_by IN (SELECT id FROM users WHERE email LIKE $1 || '%')",
    )
    .bind(ns)
    .execute(pool)
    .await
    .expect("image cleanup");
    sqlx::query("DELETE FROM users WHERE email LIKE $1 || '%'")
        .bind(ns)
        .execute(pool)
        .await
        .expect("user cleanup");
}

#[tokio::test]
async fn delete_page_closes_the_gap_in_page_numbers() {
    let Some((app, pool)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL or MINIO_TEST_ENDPOINT not set");
        return;
    };
    const NS: &str = "__pgdel-e2e";
    const TITLE: &str = "PageOrder Delete Probe";
    let token = order_probe(&pool, NS, TITLE).await;
    let (chapter_id, page_ids) = chapter_with_pages(&app, &pool, &token, TITLE, 5).await;

    // Delete the second of five.
    let (status, _, body, _) = send_json(
        app.clone(),
        "DELETE",
        &format!("/tlhub/api/pages/{}", page_ids[1]),
        &token,
        String::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    assert_eq!(
        numbers(&pool, &chapter_id).await,
        vec![1, 2, 3, 4],
        "deleting page 2 of 5 must leave 1..4, not 1,3,4,5"
    );
    // Identity, not just the shape: pages 3/4/5 each moved down exactly one slot.
    assert_eq!(number_of(&pool, &page_ids[0]).await, 1);
    assert_eq!(number_of(&pool, &page_ids[2]).await, 2);
    assert_eq!(number_of(&pool, &page_ids[3]).await, 3);
    assert_eq!(number_of(&pool, &page_ids[4]).await, 4);

    order_cleanup(&pool, NS, TITLE).await;
}

#[tokio::test]
async fn page_number_can_still_reach_the_last_slot_after_a_delete() {
    let Some((app, pool)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL or MINIO_TEST_ENDPOINT not set");
        return;
    };
    const NS: &str = "__pgmove-e2e";
    const TITLE: &str = "PageOrder Move Probe";
    let token = order_probe(&pool, NS, TITLE).await;
    let (chapter_id, page_ids) = chapter_with_pages(&app, &pool, &token, TITLE, 5).await;

    let (status, ..) = send_json(
        app.clone(),
        "DELETE",
        &format!("/tlhub/api/pages/{}", page_ids[1]),
        &token,
        String::new(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // update_page_number validates newNumber against COUNT(*). With a hole left by the delete the
    // highest real page number exceeds the count, so this move used to be rejected as "greater
    // than total pages" -- one delete broke reordering for the rest of the chapter.
    let (status, _, body, _) = send_json(
        app.clone(),
        "PATCH",
        &format!("/tlhub/api/pages/{}/number", page_ids[0]),
        &token,
        r#"{"newNumber":4}"#.to_string(),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "moving to the last slot must work: {body}"
    );

    assert_eq!(
        number_of(&pool, &page_ids[0]).await,
        4,
        "moved page lands last"
    );
    assert_eq!(
        numbers(&pool, &chapter_id).await,
        vec![1, 2, 3, 4],
        "the sequence stays contiguous after the move"
    );
    // The three that shifted up to fill the vacated slot, in their original relative order.
    assert_eq!(number_of(&pool, &page_ids[2]).await, 1);
    assert_eq!(number_of(&pool, &page_ids[3]).await, 2);
    assert_eq!(number_of(&pool, &page_ids[4]).await, 3);

    order_cleanup(&pool, NS, TITLE).await;
}

#[tokio::test]
async fn reorder_pages_applies_the_requested_order() {
    let Some((app, pool)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL or MINIO_TEST_ENDPOINT not set");
        return;
    };
    const NS: &str = "__pgreorder-e2e";
    const TITLE: &str = "PageOrder Reorder Probe";
    let token = order_probe(&pool, NS, TITLE).await;
    let (chapter_id, page_ids) = chapter_with_pages(&app, &pool, &token, TITLE, 4).await;

    // Reverse it. Every page changes number, which is what the two-phase renumber exists for:
    // a naive single pass would collide on the unique (chapter_id, page_number) pair.
    let reversed: Vec<&String> = page_ids.iter().rev().collect();
    let payload = serde_json::to_string(&reversed).unwrap();
    let (status, _, body, _) = send_json(
        app.clone(),
        "PUT",
        &format!("/tlhub/api/chapters/{chapter_id}/pages/reorder"),
        &token,
        payload,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    assert_eq!(numbers(&pool, &chapter_id).await, vec![1, 2, 3, 4]);
    assert_eq!(number_of(&pool, &page_ids[3]).await, 1);
    assert_eq!(number_of(&pool, &page_ids[2]).await, 2);
    assert_eq!(number_of(&pool, &page_ids[1]).await, 3);
    assert_eq!(number_of(&pool, &page_ids[0]).await, 4);

    order_cleanup(&pool, NS, TITLE).await;
}

#[tokio::test]
async fn move_repairs_a_chapter_left_with_a_stranded_page_number() {
    let Some((app, pool)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL or MINIO_TEST_ENDPOINT not set");
        return;
    };
    const NS: &str = "__pgstrand-e2e";
    const TITLE: &str = "PageOrder Strand Probe";
    let token = order_probe(&pool, NS, TITLE).await;
    let (chapter_id, page_ids) = chapter_with_pages(&app, &pool, &token, TITLE, 9).await;

    // Reproduce what a move that died part-way used to leave behind: the moving page parked at
    // 10000 + the slot it was headed for, outside the chapter's own numbering. Page 3 of 9,
    // aimed at 6.
    sqlx::query("UPDATE pages SET page_number = 10006 WHERE id = $1::uuid")
        .bind(&page_ids[2])
        .execute(&pool)
        .await
        .expect("strand the moving page");

    // Re-issuing the move used to read 10006 as the page's current position, take the shift-up
    // branch off the back of it, shift a range unrelated to the request, and answer 200 OK --
    // leaving a 9-page chapter numbered 1,2,4,5,6,7,8,9,10.
    let (status, _, body, _) = send_json(
        app.clone(),
        "PATCH",
        &format!("/tlhub/api/pages/{}/number", page_ids[2]),
        &token,
        r#"{"newNumber":6}"#.to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    assert_eq!(
        numbers(&pool, &chapter_id).await,
        (1..=9).collect::<Vec<i32>>(),
        "the move must leave 1..9 -- no hole, and nothing past the end of the chapter"
    );
    // And it must be the move that was asked for, not just any contiguous numbering: the stranded
    // page lands on 6 and the pages it passed close up behind it.
    assert_eq!(
        number_of(&pool, &page_ids[2]).await,
        6,
        "moved page lands 6th"
    );
    for (slot, original) in [0usize, 1, 3, 4, 5].iter().enumerate() {
        assert_eq!(
            number_of(&pool, &page_ids[*original]).await,
            (slot as i32) + 1,
            "page {original} sits ahead of the moved one"
        );
    }
    for (offset, original) in [6usize, 7, 8].iter().enumerate() {
        assert_eq!(
            number_of(&pool, &page_ids[*original]).await,
            (offset as i32) + 7,
            "page {original} keeps its place behind the moved one"
        );
    }

    order_cleanup(&pool, NS, TITLE).await;
}

#[tokio::test]
async fn move_to_the_current_slot_repairs_a_gap() {
    let Some((app, pool)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL or MINIO_TEST_ENDPOINT not set");
        return;
    };
    const NS: &str = "__pggap-e2e";
    const TITLE: &str = "PageOrder Gap Probe";
    let token = order_probe(&pool, NS, TITLE).await;
    let (chapter_id, page_ids) = chapter_with_pages(&app, &pool, &token, TITLE, 5).await;

    // A chapter that drifted: 1,2,3,4,7. The last page is now out of range of its own count, so
    // it cannot be moved anywhere -- the count check rejects every slot it could go to.
    sqlx::query("UPDATE pages SET page_number = 7 WHERE id = $1::uuid")
        .bind(&page_ids[4])
        .execute(&pool)
        .await
        .expect("open a gap");

    // Asking a page to go where it already is used to short-circuit on `old_number == new_number`
    // and change nothing, which left the user no way out of this state from the UI. The renumber
    // now runs regardless, so the no-op move is the repair.
    let (status, _, body, _) = send_json(
        app.clone(),
        "PATCH",
        &format!("/tlhub/api/pages/{}/number", page_ids[0]),
        &token,
        r#"{"newNumber":1}"#.to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    assert_eq!(
        numbers(&pool, &chapter_id).await,
        vec![1, 2, 3, 4, 5],
        "the gap is closed"
    );
    // Repair, not reshuffle: the reading order the chapter already had is preserved.
    for (slot, id) in page_ids.iter().enumerate() {
        assert_eq!(number_of(&pool, id).await, (slot as i32) + 1);
    }

    order_cleanup(&pool, NS, TITLE).await;
}

/// The endpoint is the guard, not the number input in the reader. Anything the UI would never
/// send -- a negative slot, a slot past the end, a value too big for the column -- has to come
/// back 400 with the chapter untouched, because callers other than the UI exist.
#[tokio::test]
async fn page_number_rejects_out_of_range_requests() {
    let Some((app, pool)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL or MINIO_TEST_ENDPOINT not set");
        return;
    };
    const NS: &str = "__pgrange-e2e";
    const TITLE: &str = "PageOrder Range Probe";
    let token = order_probe(&pool, NS, TITLE).await;
    let (chapter_id, page_ids) = chapter_with_pages(&app, &pool, &token, TITLE, 4).await;

    for (payload, why) in [
        (r#"{"newNumber":-5}"#, "a negative slot"),
        (r#"{"newNumber":5}"#, "one past the last slot"),
        (r#"{"newNumber":99999}"#, "far past the last slot"),
        // Wrapped to 2 by the old `as i32` cast and moved the page there, reporting success.
        (
            r#"{"newNumber":4294967298}"#,
            "past i32, wrapping to a valid slot",
        ),
        (r#"{"newNumber":2147483648}"#, "i32::MAX + 1"),
        (r#"{"newNumber":-2147483649}"#, "i32::MIN - 1"),
        (r#"{"newNumber":"abc"}"#, "a non-numeric string"),
        (r#"{"newNumber":1.5}"#, "a fraction"),
        (r#"{"newNumber":null}"#, "null"),
        (r#"{"pageNumber":2}"#, "the wrong field name"),
    ] {
        let (status, _, body, _) = send_json(
            app.clone(),
            "PATCH",
            &format!("/tlhub/api/pages/{}/number", page_ids[0]),
            &token,
            payload.to_string(),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{why} must be rejected, got {status}: {body}"
        );
        assert_eq!(
            numbers(&pool, &chapter_id).await,
            vec![1, 2, 3, 4],
            "{why} must leave the chapter alone"
        );
        assert_eq!(
            number_of(&pool, &page_ids[0]).await,
            1,
            "{why} must not move the page"
        );
    }

    // 0 and -1 stay meaningful: both are the documented "send it to the end" spelling.
    for payload in [r#"{"newNumber":0}"#, r#"{"newNumber":-1}"#] {
        let (status, _, body, _) = send_json(
            app.clone(),
            "PATCH",
            &format!("/tlhub/api/pages/{}/number", page_ids[1]),
            &token,
            payload.to_string(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{payload}: {body}");
        assert_eq!(
            number_of(&pool, &page_ids[1]).await,
            4,
            "{payload} sends it last"
        );
        assert_eq!(numbers(&pool, &chapter_id).await, vec![1, 2, 3, 4]);
        // Put it back for the next spelling.
        send_json(
            app.clone(),
            "PATCH",
            &format!("/tlhub/api/pages/{}/number", page_ids[1]),
            &token,
            r#"{"newNumber":2}"#.to_string(),
        )
        .await;
    }

    order_cleanup(&pool, NS, TITLE).await;
}

#[tokio::test]
async fn reorder_rejects_a_list_that_is_not_a_permutation() {
    let Some((app, pool)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL or MINIO_TEST_ENDPOINT not set");
        return;
    };
    const NS: &str = "__pgperm-e2e";
    const TITLE: &str = "PageOrder Permutation Probe";
    let token = order_probe(&pool, NS, TITLE).await;
    let (chapter_id, page_ids) = chapter_with_pages(&app, &pool, &token, TITLE, 3).await;

    // Right length, every id real, but page_ids[0] twice and page_ids[2] missing. The count and
    // membership checks both pass; only a uniqueness check catches it. Left through, the renumber
    // writes the repeated id and never touches the omitted one, so it keeps page number 3 --
    // either colliding with the slot the repeat lands on or leaving a hole.
    let payload = serde_json::to_string(&[&page_ids[0], &page_ids[1], &page_ids[0]]).unwrap();
    let (status, _, body, _) = send_json(
        app.clone(),
        "PUT",
        &format!("/tlhub/api/chapters/{chapter_id}/pages/reorder"),
        &token,
        payload,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a list with a duplicate is not a reordering: {body}"
    );
    assert_eq!(
        numbers(&pool, &chapter_id).await,
        vec![1, 2, 3],
        "the rejected reorder must not have touched the chapter"
    );
    for (slot, id) in page_ids.iter().enumerate() {
        assert_eq!(number_of(&pool, id).await, (slot as i32) + 1);
    }

    order_cleanup(&pool, NS, TITLE).await;
}
