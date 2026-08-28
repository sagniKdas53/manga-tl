//! Import/export integration coverage: chapter ZIP import (fresh images enter the
//! pipeline), image-archive upload through POST /api/images, project restore, and the
//! export lifecycle endpoints (202/GONE/clear).
//!
//! Requires a REAL Postgres + Valkey + MinIO test container.

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
    if std::env::var("MINIO_TEST_ENDPOINT").is_err() || std::env::var("REDIS_TEST_ADDR").is_err() {
        return None;
    }
    let pool = db::connect(&db_config_from_env()?).await.ok()?;
    let minio = MinioConfig {
        endpoint: std::env::var("MINIO_TEST_ENDPOINT").ok()?,
        external_url: None,
        access_key: Some("minioadmin".into()),
        secret_key: Some("minioadmin".into()),
    };
    let storage = MinioService::new(&minio);
    storage.ensure_bucket().await;

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
        internal_api_token: Some("test-internal-token".into()),
        jwt_expiration_ms: 3_600_000,
        minio: minio.clone(),
        redis: manga_backend::config::RedisConfig {
            host: "localhost".into(),
            port: 6379,
        },
    };
    let state = AppState::new(
        config,
        pool.clone(),
        JwtUtils::new(SECRET.into(), 3_600_000),
        storage,
        None,
    );
    Some((manga_backend::routes::build_router(state), pool))
}

/// Minimal valid PNG built in-process.
fn png_bytes(colour: [u8; 3]) -> Vec<u8> {
    let img = image::RgbaImage::from_fn(48, 48, |_, _| {
        image::Rgba([colour[0], colour[1], colour[2], 255])
    });
    let mut cursor = std::io::Cursor::new(Vec::new());
    img.write_to(&mut cursor, image::ImageFormat::Png).unwrap();
    cursor.into_inner()
}

fn multipart(fields: &[(&str, String)], file_field: Option<(&str, &str, &[u8])>) -> Vec<u8> {
    let boundary = "__import_boundary__";
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    if let Some((name, filename, bytes)) = file_field {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: application/zip\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

fn zip_of(entries: Vec<(String, Vec<u8>)>, project_json: Option<&str>) -> Vec<u8> {
    let cursor = std::io::Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in entries {
        writer.start_file(name, options).unwrap();
        std::io::Write::write_all(&mut writer, &bytes).unwrap();
    }
    if let Some(project) = project_json {
        writer.start_file("project.json", options).unwrap();
        std::io::Write::write_all(&mut writer, project.as_bytes()).unwrap();
    }
    let cursor = writer.finish().unwrap();
    cursor.into_inner()
}

async fn probe_user(pool: &sqlx::PgPool) -> String {
    let email = format!("__impexp-{}@example.invalid", uuid::Uuid::new_v4());
    sqlx::query(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
         VALUES (uuid_generate_v4(), now(), 'ImportExport', $1, 'x', 'translator')",
    )
    .bind(&email)
    .execute(pool)
    .await
    .expect("probe user");
    JwtUtils::new(SECRET.into(), 3_600_000)
        .generate_token(&email)
        .unwrap()
}

async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    token: &str,
    content_type: Option<&str>,
    body: Vec<u8>,
) -> (StatusCode, String, Vec<u8>) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("Authorization", format!("Bearer {token}"));
    if let Some(ct) = content_type {
        builder = builder.header("Content-Type", ct);
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(body)).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let ct = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, ct, bytes.to_vec())
}

async fn json_field(body: &[u8], field: &str) -> String {
    let parsed: serde_json::Value = serde_json::from_slice(body).unwrap();
    parsed[field].as_str().expect(field).to_string()
}

#[tokio::test]
async fn chapter_import_and_export_lifecycle() {
    let Some((app, pool)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR/MINIO_TEST_ENDPOINT not set");
        return;
    };
    let token = probe_user(&pool).await;

    // Series to import into.
    let (status, _, body) = send(
        &app,
        "POST",
        "/tlhub/api/series",
        &token,
        Some("application/json"),
        br#"{"title":"ImpExp","readingDirection":"rightToLeft"}"#.to_vec(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let series_id = json_field(&body, "id").await;

    // --- chapter import from an image archive ---
    let red = png_bytes([200, 10, 10]);
    let blue = png_bytes([10, 10, 200]);
    let archive = zip_of(
        vec![("002_b.png".into(), blue), ("001_a.png".into(), red)],
        None,
    );

    let body = multipart(
        &[("chapterNumber", "7".into()), ("title", "Imported".into())],
        Some(("file", "chapter.zip", &archive)),
    );
    let (status, _, resp_body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/series/{series_id}/chapters/import"),
        &token,
        Some("multipart/form-data; boundary=__import_boundary__"),
        body,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&resp_body)
    );
    let chapter_id = json_field(&resp_body, "id").await;

    // Two pages created in alphabetical order, pipeline started for both.
    let page_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE chapter_id=$1")
        .bind(uuid::Uuid::parse_str(&chapter_id).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(page_count, 2);

    let pipeline_jobs: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE type='panel-detection' AND payload LIKE '%' || (SELECT image_id FROM pages WHERE chapter_id=$1 AND page_number=1) || '%'")
            .bind(uuid::Uuid::parse_str(&chapter_id).unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        pipeline_jobs >= 1,
        "first imported page must have entered the pipeline"
    );

    // Duplicate chapter number conflicts with Java's exact message.
    let archive2 = zip_of(vec![("a.png".into(), png_bytes([5, 5, 5]))], None);
    let body = multipart(
        &[("chapterNumber", "7".into()), ("title", "Dup".into())],
        Some(("file", "chapter.zip", &archive2)),
    );
    let (status, _, resp_body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/series/{series_id}/chapters/import"),
        &token,
        Some("multipart/form-data; boundary=__import_boundary__"),
        body,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let parsed: serde_json::Value = serde_json::from_slice(&resp_body).unwrap();
    assert_eq!(
        parsed["message"],
        "Chapter 7 already exists in this series."
    );

    // Archive without images is rejected and creates no chapter.
    let empty_archive = zip_of(vec![], None);
    let body = multipart(
        &[("chapterNumber", "9".into()), ("title", "Empty".into())],
        Some(("file", "empty.zip", &empty_archive)),
    );
    let (status, _, resp_body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/series/{series_id}/chapters/import"),
        &token,
        Some("multipart/form-data; boundary=__import_boundary__"),
        body,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let parsed: serde_json::Value = serde_json::from_slice(&resp_body).unwrap();
    assert_eq!(parsed["message"], "Archive contains no valid image files.");

    // --- export lifecycle ---
    let (status, _, resp_body) = send(
        &app,
        "GET",
        &format!("/tlhub/api/series/chapters/{chapter_id}/export"),
        &token,
        None,
        vec![],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let parsed: serde_json::Value = serde_json::from_slice(&resp_body).unwrap();
    assert_eq!(parsed["status"], "accepted");

    // Downloading an unknown export id reports GONE with the expiry message.
    let (status, _, resp_body) = send(
        &app,
        "GET",
        "/tlhub/api/series/chapters/exports/00000000-0000-0000-0000-000000000000/download",
        &token,
        None,
        vec![],
    )
    .await;
    assert_eq!(status, StatusCode::GONE);
    let parsed: serde_json::Value = serde_json::from_slice(&resp_body).unwrap();
    assert_eq!(
        parsed["message"],
        "Export expired, please re-export to download."
    );

    // Clear succeeds regardless.
    let (status, _, resp_body) = send(
        &app,
        "DELETE",
        &format!("/tlhub/api/series/chapters/{chapter_id}/exports"),
        &token,
        None,
        vec![],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&resp_body).unwrap();
    assert_eq!(parsed["message"], "Cleared exports for chapter");

    cleanup(&pool).await;
}

#[tokio::test]
async fn image_archive_upload_and_project_restore() {
    let Some((app, pool)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR/MINIO_TEST_ENDPOINT not set");
        return;
    };
    let token = probe_user(&pool).await;

    let (_, _, body) = send(
        &app,
        "POST",
        "/tlhub/api/series",
        &token,
        Some("application/json"),
        br#"{"title":"ZipUp","readingDirection":"rightToLeft"}"#.to_vec(),
    )
    .await;
    let series_id = json_field(&body, "id").await;
    let (_, _, body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/series/{series_id}/chapters"),
        &token,
        Some("application/json"),
        br#"{"chapterNumber":1}"#.to_vec(),
    )
    .await;
    let chapter_id = json_field(&body, "id").await;

    // --- Case B: plain image archive through POST /api/images ---
    let archive = zip_of(
        vec![
            ("b.png".into(), png_bytes([9, 90, 9])),
            ("a.png".into(), png_bytes([90, 9, 9])),
        ],
        None,
    );
    let body = multipart(
        &[("chapterId", chapter_id.clone())],
        Some(("file", "images.zip", &archive)),
    );
    let (status, _, resp_body) = send(
        &app,
        "POST",
        "/tlhub/api/images",
        &token,
        Some("multipart/form-data; boundary=__import_boundary__"),
        body,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&resp_body)
    );
    let parsed: serde_json::Value = serde_json::from_slice(&resp_body).unwrap();
    assert_eq!(parsed["status"], "zip_imported");

    let page_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE chapter_id=$1")
        .bind(uuid::Uuid::parse_str(&chapter_id).unwrap())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(page_count, 2);

    // --- Case A: page-level project restore onto the next slot ---
    let project = r#"{"layers":[{"type":"translation","targetLanguage":"en","visible":true,"zOrder":3,"elements":[{"text":"Restored text","font":"Comic Neue","size":18,"x":10,"y":12,"maxWidth":120,"maxHeight":40,"visible":true}]}]}"#;
    let project_zip = {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        writer.start_file("original.png", options).unwrap();
        std::io::Write::write_all(&mut writer, &png_bytes([40, 40, 240])).unwrap();
        writer.start_file("project.json", options).unwrap();
        std::io::Write::write_all(&mut writer, project.as_bytes()).unwrap();
        let cursor = writer.finish().unwrap();
        cursor.into_inner()
    };

    let body = multipart(&[], Some(("file", "page.zip", &project_zip)));
    let (status, _, resp_body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/chapters/{chapter_id}/import-project"),
        &token,
        Some("multipart/form-data; boundary=__import_boundary__"),
        body,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&resp_body)
    );
    let parsed: serde_json::Value = serde_json::from_slice(&resp_body).unwrap();
    assert_eq!(parsed["status"], "success");
    let restored_page_id = parsed["pageId"].as_str().unwrap();

    // Restored translation layer + element landed on the new page.
    let element_text: (Option<String>,) = sqlx::query_as(
        "SELECT le.text FROM layer_elements le JOIN layers l ON l.id=le.layer_id WHERE l.page_id=$1 AND l.type='translation' LIMIT 1",
    )
    .bind(uuid::Uuid::parse_str(restored_page_id).unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(element_text.0.as_deref(), Some("Restored text"));

    cleanup(&pool).await;
}

async fn cleanup(pool: &sqlx::PgPool) {
    sqlx::query("DELETE FROM users WHERE email LIKE '__impexp-%'")
        .execute(pool)
        .await
        .ok();
}
