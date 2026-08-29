//! End-to-end pipeline tests: drive the internal worker API exactly like the real
//! Python worker — startPipeline → panel → ocr → layout → translation → render → qa —
//! plus the token guard, job status PATCH and duplicate-callback idempotency.
//!
//! Requires a REAL Postgres + Valkey (env-gated like every integration suite).

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

use manga_backend::config::Config;
use manga_backend::config::{DatabaseConfig, MinioConfig, RedisConfig};
use manga_backend::db;
use manga_backend::jwt::JwtUtils;
use manga_backend::minio::MinioService;
use manga_backend::redis_service::RedisService;
use manga_backend::state::AppState;

const SECRET: &str = "test-secret-long-enough-for-hmac-signing-1234567890";
const INTERNAL_TOKEN: &str = "test-internal-token";

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

async fn app() -> Option<(
    Router,
    sqlx::PgPool,
    Arc<RedisService>,
    manga_backend::state::AppState,
)> {
    let pool = db::connect(&db_config_from_env()?).await.ok()?;
    let addr = std::env::var("REDIS_TEST_ADDR").ok()?;
    let (host, port) = addr.split_once(':')?;
    let redis = Arc::new(
        RedisService::connect(host, port.parse().expect("numeric port"))
            .await
            .expect("redis connect"),
    );

    let minio = MinioConfig {
        endpoint: "http://localhost:9000".into(),
        external_url: None,
        access_key: Some("minioadmin".into()),
        secret_key: Some("minioadmin".into()),
    };
    let mut config = Config {
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
        internal_api_token: Some(INTERNAL_TOKEN.into()),
        jwt_expiration_ms: 3_600_000,
        minio: minio.clone(),
        redis: RedisConfig {
            host: "localhost".into(),
            port: 6379,
        },
    };
    let _ = &mut config;

    let state = AppState::new(
        config,
        pool.clone(),
        JwtUtils::new(SECRET.into(), 3_600_000),
        MinioService::new(&minio),
        Some(redis.clone()),
    );
    let router = manga_backend::routes::build_router(state.clone());
    Some((router, pool, redis, state))
}

async fn request(
    app: &Router,
    method: &str,
    uri: &str,
    token_header: Option<(&str, &str)>,
    body: Option<String>,
) -> (StatusCode, String, String) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some((name, value)) = token_header {
        builder = builder.header(name, value);
    }
    if body.is_some() {
        builder = builder.header("Content-Type", "application/json");
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(body.unwrap_or_default())).unwrap())
        .await
        .unwrap();
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

fn internal(
    token_header: Option<(&'static str, &'static str)>,
) -> Option<(&'static str, &'static str)> {
    token_header.or(Some(("X-Internal-Token", INTERNAL_TOKEN)))
}

/// Seeds series → chapter → page → image; returns their ids.
/// Serialises the tests that touch a job queue.
///
/// `queue:panel-detection`, `queue:ocr` and friends are global Redis lists, and cargo runs
/// the tests in this binary concurrently. Without this, one test pops a sibling's payload
/// (CI run 33264451712 failed exactly that way: the popped `pageId` was another test's
/// page), and `duplicate_callbacks_are_dropped` — which asserts a queue is EMPTY — can see
/// a neighbour's enqueue and fail the opposite way. Every test that pushes or pops holds
/// this for its whole body; the two that never touch a queue stay parallel.
static QUEUE_GUARD: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

async fn seed_pipeline(pool: &sqlx::PgPool) -> (Uuid, Uuid, Uuid, Uuid) {
    use uuid::Uuid;
    let series_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language) \
         VALUES ($1, now(), now(), 'Pipeline E2E', 'rightToLeft', 'ja')",
    )
    .bind(series_id)
    .execute(pool)
    .await
    .expect("series");

    let chapter_id = Uuid::new_v4();
    sqlx::query("INSERT INTO chapters (id, chapter_number, created_at, updated_at, use_context_memory, series_id) \
         VALUES ($1, 1, now(), now(), TRUE, $2)")
        .bind(chapter_id)
        .bind(series_id)
        .execute(pool)
        .await
        .expect("chapter");

    let image_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO images (id, created_at, filename, storage_path, hash, width, height) \
         VALUES ($1, now(), 'probe.png', 'originals/probe.png', 'hash-pipeline', 64, 64)",
    )
    .bind(image_id)
    .execute(pool)
    .await
    .expect("image");

    let page_id = Uuid::new_v4();
    sqlx::query("INSERT INTO pages (id, page_number, chapter_id, image_id) VALUES ($1, 1, $2, $3)")
        .bind(page_id)
        .bind(chapter_id)
        .bind(image_id)
        .execute(pool)
        .await
        .expect("page");

    (series_id, chapter_id, page_id, image_id)
}

/// Cascade delete the seeded series and its dependents.
async fn cleanup_series(pool: &sqlx::PgPool, series_id: Uuid) {
    let _ = sqlx::query(
        "DELETE FROM layer_elements WHERE layer_id IN (SELECT l.id FROM layers l JOIN pages p ON p.id=l.page_id WHERE p.chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM layers WHERE page_id IN (SELECT id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM conversation_regions WHERE conversation_id IN (SELECT id FROM conversations WHERE page_id IN (SELECT id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1)))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM conversations WHERE page_id IN (SELECT id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM ocr_regions WHERE page_id IN (SELECT id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM panels WHERE image_id IN (SELECT image_id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM job_costs WHERE image_id IN (SELECT image_id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM jobs WHERE image_id IN (SELECT image_id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1)",
    )
    .bind(series_id)
    .execute(pool)
    .await;
    let _ = sqlx::query("DELETE FROM chapters WHERE series_id=$1")
        .bind(series_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM series WHERE id=$1")
        .bind(series_id)
        .execute(pool)
        .await;
}

use uuid::Uuid;

#[tokio::test]
async fn internal_token_guard_rejects_with_exact_bytes() {
    let Some((app, _pool, _redis, _state)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    // Missing header.
    let (status, content_type, body) =
        request(&app, "GET", "/tlhub/api/internal/jobs/some-id", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(content_type, "application/json");
    assert_eq!(body, r#"{"error": "Unauthorized: Invalid internal token"}"#);

    // Wrong header.
    let (status, _, body) = request(
        &app,
        "GET",
        "/tlhub/api/internal/jobs/some-id",
        Some(("X-Internal-Token", "wrong")),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, r#"{"error": "Unauthorized: Invalid internal token"}"#);
}

#[tokio::test]
async fn full_pipeline_walks_every_stage() {
    let Some((app, pool, redis, state)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let _queue_guard = QUEUE_GUARD.lock().await;
    let (series_id, chapter_id, page_id, image_id) = seed_pipeline(&pool).await;

    // --- startPipeline: panel-detection job lands in DB and Redis ---
    manga_backend::jobs::coordinator::start_pipeline(
        &state,
        image_id,
        Some(page_id),
        Some(chapter_id),
    )
    .await;
    let queue_item = redis
        .pop_from_queue("queue:panel-detection")
        .await
        .unwrap()
        .expect("queued payload");
    let payload: serde_json::Value = serde_json::from_str(&queue_item).unwrap();
    assert_eq!(payload["type"], "panel-detection");
    assert_eq!(payload["pageId"], page_id.to_string());
    assert_eq!(payload["attempt"], 1);
    assert!(payload["traceId"].as_str().is_some());
    let job_id = payload["jobId"].as_str().unwrap().to_string();

    // Job row exists with PENDING + attempt 1 + trace.
    let row: (String, String) = sqlx::query_as("SELECT status, trace_id FROM jobs WHERE id = $1")
        .bind(&job_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.0, "PENDING");

    // --- worker PATCHes PROCESSING, then posts the panel callback ---
    let (status, _, _) = request(
        &app,
        "PATCH",
        &format!("/tlhub/api/internal/jobs/{job_id}/status"),
        internal(None),
        Some(r#"{"status":"PROCESSING"}"#.into()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let panel_callback = serde_json::json!({
        "jobId": job_id,
        "imageId": image_id.to_string(),
        "pageId": page_id.to_string(),
        "panels": [
            {"x": 0, "y": 0, "width": 40, "height": 60, "gridRow": 1, "gridCol": 1, "readingOrder": 1},
            {"x": 40, "y": 0, "width": 24, "height": 64, "gridRow": 1, "gridCol": 2, "readingOrder": 2}
        ]
    });
    let (status, _, body) = request(
        &app,
        "POST",
        "/tlhub/api/internal/jobs/callback/panel",
        internal(None),
        Some(panel_callback.to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let panels: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM panels WHERE image_id = $1")
        .bind(image_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(panels, 2);

    // OCR job enqueued onto its queue with resolved model fields.
    let ocr_payload_raw = redis
        .pop_from_queue("queue:ocr")
        .await
        .unwrap()
        .expect("ocr queued");
    let ocr_payload: serde_json::Value = serde_json::from_str(&ocr_payload_raw).unwrap();
    assert_eq!(ocr_payload["type"], "ocr");
    assert!(ocr_payload["ocrProvider"].is_string());
    assert!(ocr_payload["qaMode"].is_string());

    // --- OCR callback writes regions + layer + elements, enqueues layout ---
    let ocr_callback = serde_json::json!({
        "jobId": ocr_payload["jobId"],
        "imageId": image_id.to_string(),
        "pageId": page_id.to_string(),
        "modelIdentifier": "local/PP-OCRv6",
        "confidence": 0.97,
        "cost": {"breakdown": [{"provider": "local", "model": "PP-OCRv6", "prompt_tokens": 10, "completion_tokens": 5, "estimated_cost": 0.0001}]},
        "regions": [
            {"text": "こんにちは", "detectedLanguage": "ja", "confidence": 0.98, "rotation": null,
             "x": 5, "y": 5, "width": 30, "height": 20, "bubbleReadingOrder": 1,
             "backgroundColor": "#ffffff", "bubbleId": "b1", "detectionConfidence": 0.9,
             "maskPolygon": "[[0,0],[1,1]]", "safeTextX": 8, "safeTextY": 8, "safeTextW": 24, "safeTextH": 14},
            {"text": "さようなら", "detectedLanguage": "ja", "confidence": 0.91, "rotation": 0.0,
             "x": 42, "y": 5, "width": 20, "height": 18, "bubbleReadingOrder": 2,
             "backgroundColor": "#ffffff"}
        ]
    });
    let (status, _, body) = request(
        &app,
        "POST",
        "/tlhub/api/internal/jobs/callback/ocr",
        internal(None),
        Some(ocr_callback.to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let region_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM ocr_regions WHERE page_id = $1")
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(region_count, 2);

    // Cost recorded.
    let cost_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM job_costs WHERE image_id = $1")
        .bind(image_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(cost_count, 1);

    // Layout job queued.
    let layout_raw = redis
        .pop_from_queue("queue:layout")
        .await
        .unwrap()
        .expect("layout queued");
    let layout_payload: serde_json::Value = serde_json::from_str(&layout_raw).unwrap();

    // --- layout callback creates conversations and hands off to translation ---
    // Fetch a real regionId first so the update hits something.
    let region_id: (Uuid,) =
        sqlx::query_as("SELECT id FROM ocr_regions WHERE page_id = $1 LIMIT 1")
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let layout_callback = serde_json::json!({
        "jobId": layout_payload["jobId"],
        "imageId": image_id.to_string(),
        "pageId": page_id.to_string(),
        "regionTypes": [{"regionId": region_id.0.to_string(), "regionType": "sfx"}],
        "conversations": [{"sceneType": "dialogue", "regionIds": [region_id.0.to_string()]}]
    });
    let (status, _, body) = request(
        &app,
        "POST",
        "/tlhub/api/internal/jobs/callback/layout",
        internal(None),
        Some(layout_callback.to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let conv_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM conversations WHERE page_id = $1")
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(conv_count, 1);

    let tl_raw = redis
        .pop_from_queue("queue:translation")
        .await
        .unwrap()
        .expect("translation queued");
    let tl_payload: serde_json::Value = serde_json::from_str(&tl_raw).unwrap();

    // --- translation callback builds the translation layer + elements, queues render ---
    let translation_callback = serde_json::json!({
        "jobId": tl_payload["jobId"],
        "imageId": image_id.to_string(),
        "pageId": page_id.to_string(),
        "translations": [
            {"regionId": region_id.0.to_string(), "translatedText": "Hello", "translationFailed": false, "translationScore": 0.95, "modelIdentifier": "openai/gpt-4o", "confidence": 0.9}
        ],
        "cost": {"estimated_cost": 0.002, "provider": "openai", "model": "gpt-4o"}
    });
    let (status, _, body) = request(
        &app,
        "POST",
        "/tlhub/api/internal/jobs/callback/translation",
        internal(None),
        Some(translation_callback.to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let layer_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM layers WHERE page_id=$1 AND type='translation'")
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(layer_count, 1);

    let element_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM layer_elements le JOIN layers l ON l.id=le.layer_id WHERE l.page_id=$1 AND l.type='translation'",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(element_count, 1);

    let render_raw = redis
        .pop_from_queue("queue:render")
        .await
        .unwrap()
        .expect("render queued");
    let render_payload: serde_json::Value = serde_json::from_str(&render_raw).unwrap();

    // --- render callback stamps rendered, queues QA ---
    let render_callback = serde_json::json!({
        "jobId": render_payload["jobId"],
        "imageId": image_id.to_string(),
        "pageId": page_id.to_string()
    });
    let (status, _, body) = request(
        &app,
        "POST",
        "/tlhub/api/internal/jobs/callback/render",
        internal(None),
        Some(render_callback.to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let qa_raw = redis
        .pop_from_queue("queue:qa")
        .await
        .unwrap()
        .expect("qa queued");
    let qa_payload: serde_json::Value = serde_json::from_str(&qa_raw).unwrap();
    assert_eq!(qa_payload["qaPass"], 1);

    // --- QA callback passes: pipeline completes, retry counter cleared ---
    let translated_region: (Uuid,) = sqlx::query_as(
        "SELECT id FROM ocr_regions WHERE page_id=$1 AND translated_text IS NOT NULL LIMIT 1",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let qa_callback = serde_json::json!({
        "jobId": qa_payload["jobId"],
        "imageId": image_id.to_string(),
        "pageId": page_id.to_string(),
        "qaResults": [
            {"regionId": translated_region.0.to_string(), "qaStatus": "passed", "qaScore": 0.99, "qaFeedback": ""}
        ]
    });
    let (status, _, body) = request(
        &app,
        "POST",
        "/tlhub/api/internal/jobs/callback/qa",
        internal(None),
        Some(qa_callback.to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // The newest translation layer carries the recorded QA verdict.
    let qa_status: (Option<String>,) = sqlx::query_as(
        "SELECT metadata_json->'qa'->>'status' FROM layers \
         WHERE page_id=$1 AND type='translation' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(qa_status.0.as_deref(), Some("passed"));

    cleanup_series(&pool, series_id).await;
}

/// AUDIT-P4: a second callback for an already-applied job must be dropped entirely.
#[tokio::test]
async fn duplicate_callbacks_are_dropped() {
    let Some((app, pool, redis, state)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let _queue_guard = QUEUE_GUARD.lock().await;
    let (series_id, chapter_id, page_id, image_id) = seed_pipeline(&pool).await;

    manga_backend::jobs::coordinator::start_pipeline(
        &state,
        image_id,
        Some(page_id),
        Some(chapter_id),
    )
    .await;
    let raw = redis
        .pop_from_queue("queue:panel-detection")
        .await
        .unwrap()
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let job_id = payload["jobId"].as_str().unwrap().to_string();

    let panel_callback = serde_json::json!({
        "jobId": job_id,
        "imageId": image_id.to_string(),
        "pageId": page_id.to_string(),
        "panels": [{"x": 1, "y": 1, "width": 10, "height": 10}]
    });

    // First application inserts one panel and enqueues OCR...
    let (status, ..) = request(
        &app,
        "POST",
        "/tlhub/api/internal/jobs/callback/panel",
        internal(None),
        Some(panel_callback.to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        redis.pop_from_queue("queue:ocr").await.unwrap().is_some(),
        "first callback enqueues ocr"
    );

    // ...the duplicate is dropped: no second panel, no second OCR enqueue.
    let (status, ..) = request(
        &app,
        "POST",
        "/tlhub/api/internal/jobs/callback/panel",
        internal(None),
        Some(panel_callback.to_string()),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "duplicate is acknowledged but not reapplied"
    );
    assert!(
        redis.pop_from_queue("queue:ocr").await.unwrap().is_none(),
        "duplicate must NOT enqueue another OCR job"
    );
    let panels: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM panels WHERE image_id = $1")
        .bind(image_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(panels, 1);

    let applied_at: (Option<chrono::DateTime<chrono::Utc>>,) =
        sqlx::query_as("SELECT callback_applied_at FROM jobs WHERE id=$1")
            .bind(&job_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(applied_at.0.is_some(), "claim stamped exactly once");

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn job_status_patch_validates_and_updates() {
    let Some((app, pool, redis, state)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let _queue_guard = QUEUE_GUARD.lock().await;
    let (series_id, chapter_id, page_id, image_id) = seed_pipeline(&pool).await;
    manga_backend::jobs::coordinator::start_pipeline(
        &state,
        image_id,
        Some(page_id),
        Some(chapter_id),
    )
    .await;
    let raw = redis
        .pop_from_queue("queue:panel-detection")
        .await
        .unwrap()
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let job_id = payload["jobId"].as_str().unwrap().to_string();

    // Unknown status → 400 JSON with allowed vocabulary.
    let (status, content_type, body) = request(
        &app,
        "PATCH",
        &format!("/tlhub/api/internal/jobs/{job_id}/status"),
        internal(None),
        Some(r#"{"status":"RUNNING"}"#.into()),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(content_type.starts_with("application/json"));
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(parsed["error"], "Unknown job status: RUNNING");
    assert_eq!(
        parsed["allowed"],
        "[PENDING, PROCESSING, COMPLETED, FAILED, PAUSED]"
    );

    // FAILED with an error message persists both.
    let (status, ..) = request(
        &app,
        "PATCH",
        &format!("/tlhub/api/internal/jobs/{job_id}/status"),
        internal(None),
        Some(r#"{"status":"FAILED","error":"boom"}"#.into()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (db_status, db_error): (String, Option<String>) =
        sqlx::query_as("SELECT status, error FROM jobs WHERE id=$1")
            .bind(&job_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        (db_status.as_str(), db_error.as_deref()),
        ("FAILED", Some("boom"))
    );

    // PENDING re-pushes the payload onto the stage queue and clears started_at.
    sqlx::query("UPDATE jobs SET started_at = now() WHERE id=$1")
        .bind(&job_id)
        .execute(&pool)
        .await
        .unwrap();
    let (status, ..) = request(
        &app,
        "PATCH",
        &format!("/tlhub/api/internal/jobs/{job_id}/status"),
        internal(None),
        Some(r#"{"status":"PENDING"}"#.into()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        redis
            .pop_from_queue("queue:panel-detection")
            .await
            .unwrap()
            .is_some(),
        "PENDING re-enqueues"
    );
    let started_at: (Option<chrono::DateTime<chrono::Utc>>,) =
        sqlx::query_as("SELECT started_at FROM jobs WHERE id=$1")
            .bind(&job_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        started_at.0.is_none(),
        "retry clears the stale attempt's start timestamp"
    );

    // GET unknown job → bare 404.
    let (status, _, body) = request(
        &app,
        "GET",
        "/tlhub/api/internal/jobs/no-such-job",
        internal(None),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body.is_empty());

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn redo_endpoints_enqueue_and_validate() {
    let Some((app, pool, redis, _state)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let _queue_guard = QUEUE_GUARD.lock().await;
    let (series_id, _chapter_id, page_id, image_id) = seed_pipeline(&pool).await;

    // Translator JWT for the ADMIN/TRANSLATOR gate.
    let email = "__pipeline-redo@example.invalid";
    sqlx::query("DELETE FROM users WHERE email=$1")
        .bind(email)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO users (id, created_at, display_name, email, password_hash, role) VALUES (uuid_generate_v4(), now(), 'R', $1, 'x', 'translator')")
        .bind(email)
        .execute(&pool)
        .await
        .unwrap();
    let token = JwtUtils::new(SECRET.into(), 3_600_000)
        .generate_token(email)
        .unwrap();

    // Invalid type → 400 text/plain.
    let (status, content_type, body) = request(
        &app,
        "POST",
        &format!("/tlhub/api/images/{image_id}/redo?type=render"),
        Some(("Authorization", &format!("Bearer {token}"))),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(content_type.starts_with("text/plain"), "{content_type}");
    assert_eq!(body, "Invalid redo type");

    // Valid OCR redo: enqueues + sets the manual-re-ocr reason key.
    let (status, _, body) = request(
        &app,
        "POST",
        &format!("/tlhub/api/images/{image_id}/redo?type=ocr"),
        Some(("Authorization", &format!("Bearer {token}"))),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(parsed["status"], "enqueued");
    assert_eq!(
        redis
            .get(&format!("image:ocr:reason:{image_id}"))
            .await
            .unwrap()
            .as_deref(),
        Some("manual-re-ocr")
    );
    let raw = redis
        .pop_from_queue("queue:ocr")
        .await
        .unwrap()
        .expect("redo queued");
    let redone: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(redone["priority"], "normal");

    // Region redo requires an existing region.
    let region_id = Uuid::new_v4();
    sqlx::query("INSERT INTO ocr_regions (id, detected_language, bbox_x, bbox_y, bbox_w, bbox_h, page_id) VALUES ($1,'ja',0,0,1,1,$2)")
        .bind(region_id)
        .bind(page_id)
        .execute(&pool)
        .await
        .unwrap();
    let (status, _, body) = request(
        &app,
        "POST",
        &format!("/tlhub/api/ocr-regions/{region_id}/redo?type=translation"),
        Some(("Authorization", &format!("Bearer {token}"))),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let raw = redis
        .pop_from_queue("queue:region-redo-tl")
        .await
        .unwrap()
        .expect("region redo queued");
    let redone: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(redone["priority"], "high");
    assert_eq!(redone["regionId"], region_id.to_string());
    assert_eq!(redone["redoType"], "translation");

    sqlx::query("DELETE FROM users WHERE email=$1")
        .bind(email)
        .execute(&pool)
        .await
        .unwrap();
    cleanup_series(&pool, series_id).await;
}

/// InternalJobControllerTest additions: GET image-info must serve regions from the
/// LATEST ocr layer only (all of them when no ocr layer exists) and carry the
/// context-memory fields the translator assembles its prompt from.
#[tokio::test]
async fn image_info_filters_regions_by_latest_ocr_layer_and_carries_context() {
    let Some((app, pool, _redis, _state)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let (series_id, chapter_id, page1_id, image_id) = seed_pipeline(&pool).await;

    // Two pages: page 2 is the one whose info request carries previous-page text.
    let page2_id = Uuid::new_v4();
    sqlx::query("INSERT INTO pages (id, page_number, chapter_id, image_id) VALUES ($1, 2, $2, $3)")
        .bind(page2_id)
        .bind(chapter_id)
        .bind(image_id)
        .execute(&pool)
        .await
        .expect("page 2");

    // Regions on page 1 (previous page for context) and page 2.
    let _prev_region: Uuid = sqlx::query_scalar(
        "INSERT INTO ocr_regions (id, bbox_x, bbox_y, bbox_w, bbox_h, detected_language, text, translated_text, page_id) \
         VALUES (uuid_generate_v4(), 0, 0, 10, 10, 'ja', 'previous page words', 'previous page words', $1) RETURNING id",
    )
    .bind(page1_id)
    .fetch_one(&pool)
    .await
    .expect("prev region");
    let r_old: Uuid = sqlx::query_scalar(
        "INSERT INTO ocr_regions (id, bbox_x, bbox_y, bbox_w, bbox_h, detected_language, text, translated_text, page_id) \
         VALUES (uuid_generate_v4(), 0, 0, 10, 10, 'ja', 'old layer text', 'old layer text', $1) RETURNING id",
    )
    .bind(page2_id)
    .fetch_one(&pool)
    .await
    .expect("r_old");
    let r_new: Uuid = sqlx::query_scalar(
        "INSERT INTO ocr_regions (id, bbox_x, bbox_y, bbox_w, bbox_h, detected_language, text, translated_text, page_id) \
         VALUES (uuid_generate_v4(), 0, 0, 10, 10, 'ja', 'new layer text', 'new layer text', $1) RETURNING id",
    )
    .bind(page2_id)
    .fetch_one(&pool)
    .await
    .expect("r_new");

    // Two OCR layers; the z_order=2 one references only r_new.
    let ocr1: Uuid =
        sqlx::query_scalar("INSERT INTO layers (id, created_at, type, visible, z_order, page_id) VALUES (uuid_generate_v4(), now(), 'ocr', TRUE, 1, $1) RETURNING id")
            .bind(page2_id)
            .fetch_one(&pool)
            .await
            .expect("ocr layer 1");
    let ocr2: Uuid =
        sqlx::query_scalar("INSERT INTO layers (id, created_at, type, visible, z_order, page_id) VALUES (uuid_generate_v4(), now(), 'ocr', TRUE, 2, $1) RETURNING id")
            .bind(page2_id)
            .fetch_one(&pool)
            .await
            .expect("ocr layer 2");
    for (layer, region_id) in [(ocr1, r_old), (ocr2, r_new)] {
        sqlx::query(
            "INSERT INTO layer_elements (id, text, size, font, font_style, font_weight, x, y, auto_size, word_wrap, overflow, visible, is_manually_edited, box_shape, max_width, max_height, rotation, layer_id, region_id) \
             VALUES (uuid_generate_v4(), '', 16.0, 'f', 'normal', 'normal', 0.0, 0.0, FALSE, FALSE, FALSE, TRUE, FALSE, 'rectangular', 10, 10, 0.0, $1, $2)",
        )
        .bind(layer)
        .bind(region_id)
        .execute(&pool)
        .await
        .expect("element link");
    }

    // --- latest-layer filtering ---
    let (status, _, body) = request(
        &app,
        "GET",
        &format!("/tlhub/api/internal/images/{image_id}?chapterId={chapter_id}&pageId={page2_id}"),
        internal(None),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let info: serde_json::Value = serde_json::from_str(&body).unwrap();
    let region_ids: Vec<&str> = info["ocrRegions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        region_ids,
        vec![r_new.to_string().as_str()],
        "only the newest ocr layer's regions are served"
    );

    // Without any OCR layer, ALL regions fall through (backwards-compat branch).
    sqlx::query("DELETE FROM layers WHERE id = ANY($1)")
        .bind(vec![ocr1, ocr2])
        .execute(&pool)
        .await
        .expect("drop ocr layers");
    let (_, _, body) = request(
        &app,
        "GET",
        &format!("/tlhub/api/internal/images/{image_id}?chapterId={chapter_id}&pageId={page2_id}"),
        internal(None),
        None,
    )
    .await;
    let info: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        info["ocrRegions"].as_array().unwrap().len(),
        2,
        "no ocr layer -> every region"
    );

    // --- context memory fields ---
    assert!(
        info.get("seriesMetadata").is_some(),
        "series metadata present"
    );
    assert_eq!(info["seriesMetadata"]["title"], "Pipeline E2E");
    assert_eq!(
        info["previousPageText"], "previous page words",
        "page>1 with context memory carries prior text"
    );

    cleanup_series(&pool, series_id).await;
}
