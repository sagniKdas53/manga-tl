//! `POST /api/pages/{pageId}/render`: an edited page is rendered in the request, through the
//! page-renderer, not after the debounce and a worker slot (user review, 2026-10-02).
//!
//! The page-renderer is a mock here; what is under test is the backend's side: the job, ledger and
//! artifact land exactly as a worker's render would, Export finds the PNG, and a hand-edited page
//! queues no QA. Requires REAL Postgres + Valkey + MinIO (env-gated like every integration suite).
//! Its own test binary, because it sets `PAGE_RENDERER_URL` for the process.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::Engine as _;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use uuid::Uuid;

use manga_backend::config::{Config, DatabaseConfig, MinioConfig, RedisConfig};
use manga_backend::db;
use manga_backend::jwt::JwtUtils;
use manga_backend::minio::MinioService;
use manga_backend::redis_service::RedisService;
use manga_backend::state::AppState;

const SECRET: &str = "test-secret-long-enough-for-hmac-signing-1234567890";
const PNG: &[u8] = b"\x89PNG rendered by the mock";

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

async fn app() -> Option<(Router, sqlx::PgPool, AppState)> {
    let pool = db::connect(&db_config_from_env()?).await.ok()?;
    let addr = std::env::var("REDIS_TEST_ADDR").ok()?;
    let (host, port) = addr.split_once(':')?;
    let redis = Arc::new(
        RedisService::connect(host, port.parse().expect("numeric port"))
            .await
            .expect("redis connect"),
    );
    let minio = MinioConfig {
        endpoint: std::env::var("MINIO_TEST_ENDPOINT").ok()?,
        external_url: None,
        access_key: Some("minioadmin".into()),
        secret_key: Some("minioadmin".into()),
    };
    let config = Config {
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
        redis: RedisConfig {
            host: "localhost".into(),
            port: 6379,
        },
    };
    let storage = MinioService::new(&minio);
    storage.ensure_bucket().await;
    let state = AppState::new(
        config,
        pool.clone(),
        JwtUtils::new(SECRET.into(), 3_600_000),
        storage,
        Some(redis),
    );
    Some((
        manga_backend::routes::build_router(state.clone()),
        pool,
        state,
    ))
}

/// A page-renderer that answers every scene with [`PNG`], echoing the scene's identity.
async fn mock_renderer(calls: Arc<AtomicUsize>, last: Arc<std::sync::Mutex<Value>>) -> String {
    let router = Router::new().route(
        "/render",
        axum::routing::post(move |axum::Json(request): axum::Json<Value>| {
            let calls = calls.clone();
            let last = last.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                *last.lock().unwrap() = request.clone();
                axum::Json(json!({
                    "pageRevision": request["pageRevision"],
                    "logicalSceneSha256": request["logicalSceneSha256"],
                    "pngBase64": base64::engine::general_purpose::STANDARD.encode(PNG),
                    "pngSha256": hex::encode(Sha256::digest(PNG)),
                    "diagnostics": [],
                    "layout": [],
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    url
}

async fn translator(pool: &sqlx::PgPool) -> String {
    let email = format!("render-now-{}@example.invalid", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
         VALUES (uuid_generate_v4(), now(), 'Editor', $1, 'x', 'translator')",
    )
    .bind(&email)
    .execute(pool)
    .await
    .expect("user");
    JwtUtils::new(SECRET.into(), 3_600_000)
        .generate_token(&email)
        .unwrap()
}

async fn send(app: &Router, method: &str, uri: &str, token: &str) -> (StatusCode, Vec<u8>) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("Authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, bytes.to_vec())
}

#[tokio::test]
async fn an_edited_page_renders_in_the_request_and_queues_no_qa() {
    let calls = Arc::new(AtomicUsize::new(0));
    let last = Arc::new(std::sync::Mutex::new(Value::Null));
    let renderer = mock_renderer(calls.clone(), last.clone()).await;
    // SAFETY: this test binary holds one test, so nothing reads the environment concurrently.
    unsafe { std::env::set_var("PAGE_RENDERER_URL", &renderer) };
    let Some((app, pool, state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let token = translator(&pool).await;

    // A page with one hand-placed English line on its translation layer.
    let source = b"source page bytes".to_vec();
    let source_sha = hex::encode(Sha256::digest(&source));
    let series_id = Uuid::new_v4();
    let chapter_id = Uuid::new_v4();
    let image_id = Uuid::new_v4();
    let page_id = Uuid::new_v4();
    let storage_path = format!("originals/render-now-{image_id}.png");
    state
        .storage
        .upload_bytes(&storage_path, source.clone(), "image/png")
        .await
        .expect("source upload");
    for (sql, binds) in [
        (
            "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language, source_language, target_language) \
             VALUES ($1, now(), now(), 'Render Now E2E', 'rightToLeft', 'ja', 'ja', 'en')",
            vec![series_id],
        ),
        (
            "INSERT INTO chapters (id, chapter_number, created_at, updated_at, series_id) VALUES ($1, 1, now(), now(), $2)",
            vec![chapter_id, series_id],
        ),
    ] {
        let mut query = sqlx::query(sql);
        for bind in binds {
            query = query.bind(bind);
        }
        query.execute(&pool).await.expect("seed");
    }
    sqlx::query(
        "INSERT INTO images (id, created_at, filename, storage_path, hash, width, height) \
         VALUES ($1, now(), 'render-now.png', $2, $3, 200, 300)",
    )
    .bind(image_id)
    .bind(&storage_path)
    .bind(&source_sha)
    .execute(&pool)
    .await
    .expect("image");
    sqlx::query(
        "INSERT INTO pages (id, page_number, chapter_id, image_id, last_edited_at, hand_edited_at) \
         VALUES ($1, 1, $2, $3, now(), now())",
    )
    .bind(page_id)
    .bind(chapter_id)
    .bind(image_id)
    .execute(&pool)
    .await
    .expect("page");
    let layer_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, created_at) \
         VALUES ($1, 'translation', 'en', TRUE, 1, '{}'::jsonb, $2, now())",
    )
    .bind(layer_id)
    .bind(page_id)
    .execute(&pool)
    .await
    .expect("layer");
    sqlx::query(
        "INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, word_wrap, layer_id) \
         VALUES (uuid_generate_v4(), 'Hand-placed line', 20, 20, 120, 40, TRUE, FALSE, $1)",
    )
    .bind(layer_id)
    .execute(&pool)
    .await
    .expect("element");

    // Nothing rendered yet: Export would say "pending".
    let (status, _) = send(
        &app,
        "GET",
        &format!("/tlhub/api/pages/{page_id}/rendered"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/pages/{page_id}/render"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let answer: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(answer["status"], "succeeded");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let sent = last.lock().unwrap().clone();
    assert_eq!(sent["scene"]["textObjects"][0]["text"], "Hand-placed line");

    let (status, png) = send(
        &app,
        "GET",
        &format!("/tlhub/api/pages/{page_id}/rendered"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(png, PNG, "Export serves the render just made");
    let (job_status, ledger_status): (String, String) = sqlx::query_as(
        "SELECT j.status, l.status FROM jobs j JOIN page_render_jobs l ON l.job_id = j.id \
         WHERE j.page_id = $1 AND j.type = 'render'",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (job_status.as_str(), ledger_status.as_str()),
        ("COMPLETED", "succeeded")
    );
    let qa: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE page_id = $1 AND type = 'qa'")
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(qa, 0, "a hand-edited page's render queues no QA");

    // Already current: answered without drawing again.
    let (status, _) = send(
        &app,
        "POST",
        &format!("/tlhub/api/pages/{page_id}/render"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    for statement in [
        "DELETE FROM jobs WHERE page_id = $1",
        "DELETE FROM pages WHERE id = $1",
    ] {
        let _ = sqlx::query(statement).bind(page_id).execute(&pool).await;
    }
    let _ = sqlx::query("DELETE FROM images WHERE id = $1")
        .bind(image_id)
        .execute(&pool)
        .await;
    let _ = sqlx::query("DELETE FROM series WHERE id = $1")
        .bind(series_id)
        .execute(&pool)
        .await;
}
