//! End-to-end tests for /api/jobs plus the scheduled recovery functions.
//!
//! These endpoints have GLOBAL side effects (queue pause gate, DELETE across statuses,
//! requeue fan-out), so the suite refuses to run against a shared production database:
//! it only boots when JOBS_E2E_DATABASE_URL points at a throwaway database. Redis is
//! shared but safe here: queue keys it touches belong to the scratch DB's jobs, and
//! system:queue:paused is restored to its pre-test value.

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use std::sync::Arc;
use tower::ServiceExt;

use manga_backend::config::{DatabaseConfig, MinioConfig};
use manga_backend::db;
use manga_backend::jwt::JwtUtils;
use manga_backend::minio::MinioService;
use manga_backend::redis_service::RedisService;
use manga_backend::state::AppState;

const SECRET: &str = "test-secret-long-enough-for-hmac-signing-1234567890";

fn db_config_from_jobs_env() -> Option<DatabaseConfig> {
    let url = std::env::var("JOBS_E2E_DATABASE_URL").ok()?;
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

async fn app() -> Option<(Router, sqlx::PgPool, Arc<RedisService>, AppState)> {
    // Refuse shared databases by construction: no dedicated URL, no test.
    if std::env::var("JOBS_E2E_DATABASE_URL").is_err() {
        eprintln!("skipping: JOBS_E2E_DATABASE_URL not set (refusing shared DB)");
        return None;
    }
    let pool = db::connect(&db_config_from_jobs_env()?).await.ok()?;
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
        redis: manga_backend::config::RedisConfig {
            host: "localhost".into(),
            port: 6379,
        },
    };
    let state = AppState::new(
        config,
        pool.clone(),
        JwtUtils::new(SECRET.into(), 3_600_000),
        MinioService::new(&minio),
        Some(redis.clone()),
    );
    Some((
        manga_backend::routes::build_router(state.clone()),
        pool,
        redis,
        state,
    ))
}

/// A throwaway user token for authenticated calls.
async fn auth_token(pool: &sqlx::PgPool) -> String {
    let email = format!("__jobs-e2e-{}@example.invalid", uuid::Uuid::new_v4());
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

async fn cleanup_users(pool: &sqlx::PgPool) {
    let _ = sqlx::query("DELETE FROM users WHERE email LIKE '__jobs-e2e-%'")
        .execute(pool)
        .await;
}

async fn seed_job(
    pool: &sqlx::PgPool,
    status: &str,
    job_type: &str,
    attempt: Option<i32>,
    max_attempts: Option<i32>,
    payload: Option<&str>,
) -> String {
    let id = format!("e2e-{}", uuid::Uuid::new_v4());
    sqlx::query(
        "INSERT INTO jobs (id, type, status, attempt, max_attempts, payload, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, now(), now())",
    )
    .bind(&id)
    .bind(job_type)
    .bind(status)
    .bind(attempt)
    .bind(max_attempts)
    .bind(payload)
    .execute(pool)
    .await
    .expect("seed job");
    id
}

async fn clear_jobs(pool: &sqlx::PgPool) {
    sqlx::query("DELETE FROM job_costs WHERE job_id LIKE 'e2e-%'")
        .execute(pool)
        .await
        .expect("clear job_costs");
    sqlx::query("DELETE FROM jobs WHERE id LIKE 'e2e-%'")
        .execute(pool)
        .await
        .expect("clear jobs");
}

async fn send(app: Router, method: &str, uri: &str, token: &str) -> (StatusCode, String, String) {
    let response = app
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
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

async fn job_status(pool: &sqlx::PgPool, id: &str) -> (String, Option<String>, Option<i32>) {
    sqlx::query_as::<_, (String, Option<String>, Option<i32>)>(
        "SELECT status, error, attempt FROM jobs WHERE id = $1",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .expect("job row")
}

/// Both scenarios share one throwaway database and the queue:* keyspace, so they
/// must never interleave.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn jobs_list_pause_gate_clear_and_per_job_rules() {
    let _serial = SERIAL.lock().await;
    let Some((app, pool, redis, _state)) = app().await else {
        return;
    };
    clear_jobs(&pool).await;
    cleanup_users(&pool).await;
    let token = auth_token(&pool).await;
    let paused_before = redis.get("system:queue:paused").await.ok().flatten();

    // --- GET /api/jobs: active-status envelope; COMPLETED excluded ---
    let pending = seed_job(
        &pool,
        "PENDING",
        "ocr",
        Some(0),
        None,
        Some(r#"{"imageId":"img"}"#),
    )
    .await;
    let failed = seed_job(
        &pool,
        "FAILED",
        "translation",
        Some(3),
        None,
        Some(r#"{"imageId":"img"}"#),
    )
    .await;
    let processing = seed_job(&pool, "PROCESSING", "render", None, None, None).await;
    let completed_id = seed_job(&pool, "COMPLETED", "qa", None, None, None).await;

    let (status, _, body) = send(app.clone(), "GET", "/tlhub/api/jobs", &token).await;
    assert_eq!(status, StatusCode::OK);
    let envelope: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(
        envelope["isPaused"].is_boolean(),
        "envelope carries isPaused"
    );
    let ids: Vec<&str> = envelope["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|j| j["id"].as_str())
        .collect();
    assert!(ids.contains(&pending.as_str()));
    assert!(ids.contains(&failed.as_str()));
    assert!(ids.contains(&processing.as_str()));
    assert!(
        !ids.iter().any(|id| *id == completed_id),
        "COMPLETED jobs are not part of the active envelope"
    );

    // --- pause gate flips Redis and shows in the envelope ---
    let (status, _, _) = send(app.clone(), "POST", "/tlhub/api/jobs/pause", &token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        redis.get("system:queue:paused").await.unwrap().as_deref(),
        Some("true")
    );
    let (_, _, body) = send(app.clone(), "GET", "/tlhub/api/jobs", &token).await;
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["isPaused"],
        true
    );

    // retry while paused resets the row but does NOT push to any queue...
    let queue_len_before = redis.queue_size("queue:ocr").await.unwrap_or(0);
    let (status, _, _) = send(
        app.clone(),
        "POST",
        &format!("/tlhub/api/jobs/{failed}/retry"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (st, err, attempt) = job_status(&pool, &failed).await;
    assert_eq!(st, "PENDING");
    assert_eq!(err, None);
    assert_eq!(attempt, Some(1));
    assert_eq!(
        redis.queue_size("queue:ocr").await.unwrap_or(i64::MAX),
        queue_len_before,
        "paused gate must swallow the retry push"
    );

    // ...and resume requeues PENDING jobs and clears the flag.
    let (status, _, _) = send(app.clone(), "POST", "/tlhub/api/jobs/resume", &token).await;
    assert_eq!(status, StatusCode::OK);
    // set_queue_paused(false) removes the key — same observable gate state as "false".
    assert!(!redis.queue_paused().await.expect("gate read"));
    let queued_now = redis.queue_size("queue:ocr").await.unwrap_or(0);
    assert!(
        queued_now > queue_len_before,
        "resume must requeue pending ocr jobs onto queue:ocr"
    );

    // --- per-job pause rules ---
    let (status, _, _) = send(
        app.clone(),
        "POST",
        &format!("/tlhub/api/jobs/{pending}/pause"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(job_status(&pool, &pending).await.0, "PAUSED");

    let render = seed_job(&pool, "PROCESSING", "ocr", None, None, None).await;
    let (status, ctype, body) = send(
        app.clone(),
        "POST",
        &format!("/tlhub/api/jobs/{render}/pause"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(ctype.starts_with("text/plain"), "{ctype}");
    assert_eq!(body, "Only PENDING jobs can be paused");

    let (status, _, _) = send(
        app.clone(),
        "POST",
        &format!("/tlhub/api/jobs/{}/pause", uuid::Uuid::new_v4()),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // --- per-job resume rules ---
    let (status, _, _) = send(
        app.clone(),
        "POST",
        &format!("/tlhub/api/jobs/{pending}/resume"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(job_status(&pool, &pending).await.0, "PENDING");

    let (status, ctype, body) = send(
        app.clone(),
        "POST",
        &format!("/tlhub/api/jobs/{pending}/resume"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(ctype.starts_with("text/plain"), "{ctype}");
    assert_eq!(body, "Only PAUSED jobs can be resumed");

    // resume pushes the resumed job back onto its queue when the gate is open.
    assert!(redis.queue_size("queue:ocr").await.unwrap_or(0) >= 1);

    // --- clear: without force PROCESSING survives; with force everything goes ---
    seed_job(&pool, "PAUSED", "layout", None, None, None).await;
    let (status, _, _) = send(app.clone(), "DELETE", "/tlhub/api/jobs/clear", &token).await;
    assert_eq!(status, StatusCode::OK);
    let remaining: Vec<(String, String)> =
        sqlx::query_as("SELECT id, status FROM jobs WHERE id LIKE 'e2e-%'")
            .fetch_all(&pool)
            .await
            .unwrap_or_default();
    assert!(
        remaining
            .iter()
            .all(|(_, s)| s == "PROCESSING" || s == "COMPLETED"),
        "non-force clear removes PENDING/PAUSED/FAILED, keeps PROCESSING (+COMPLETED): {remaining:?}"
    );
    assert!(!remaining.is_empty(), "PROCESSING rows still present");

    let (status, _, _) = send(
        app.clone(),
        "DELETE",
        "/tlhub/api/jobs/clear?force=true",
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let remaining: Vec<String> = sqlx::query_as("SELECT status FROM jobs WHERE id LIKE 'e2e-%'")
        .fetch_all(&pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(s,)| s)
        .collect();
    assert!(
        remaining.iter().all(|s| s == "COMPLETED"),
        "force additionally clears PROCESSING (COMPLETED untouched): {remaining:?}"
    );
    // Queue sweep removed our probe payloads from every queue:* key.
    assert_eq!(redis.queue_size("queue:ocr").await.unwrap_or(-1), 0);

    // --- delete single job + 404s ---
    let doomed = seed_job(&pool, "FAILED", "qa", None, None, None).await;
    let (status, _, _) = send(
        app.clone(),
        "DELETE",
        &format!("/tlhub/api/jobs/{doomed}"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = send(
        app.clone(),
        "DELETE",
        &format!("/tlhub/api/jobs/{doomed}"),
        &token,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // restore the global pause flag exactly as we found it.
    match paused_before {
        Some(v) => {
            redis
                .set("system:queue:paused", &v)
                .await
                .expect("restore gate");
        }
        None => {
            redis
                .delete("system:queue:paused")
                .await
                .expect("restore gate");
        }
    }
    clear_jobs(&pool).await;
    cleanup_users(&pool).await;
}

#[tokio::test]
async fn recovery_reset_stale_and_debounced_render() {
    let _serial = SERIAL.lock().await;
    let Some((_app, pool, redis, state)) = app().await else {
        return;
    };
    clear_jobs(&pool).await;

    // --- startup reset: attempt bump + payload attempt refresh ---
    let fresh = seed_job(
        &pool,
        "PROCESSING",
        "ocr",
        Some(0),
        Some(3),
        Some(r#"{"imageId":"img","attempt":0}"#),
    )
    .await;
    let exhausted = seed_job(&pool, "PROCESSING", "tl", Some(3), Some(3), None).await;
    manga_backend::jobs::recovery::reset_processing_jobs_to_pending(&state).await;
    let (st, err, attempt) = job_status(&pool, &fresh).await;
    assert_eq!(st, "PENDING", "fresh PROCESSING resets");
    assert_eq!(err, None);
    assert_eq!(attempt, Some(1));
    let payload: String = sqlx::query_scalar("SELECT payload FROM jobs WHERE id = $1")
        .bind(&fresh)
        .fetch_one(&pool)
        .await
        .expect("payload");
    assert!(
        payload.contains("\"attempt\":1"),
        "payload attempt refreshed: {payload}"
    );
    assert!(
        sqlx::query_scalar::<_, Option<String>>("SELECT started_at::text FROM jobs WHERE id = $1")
            .bind(&fresh)
            .fetch_one(&pool)
            .await
            .expect("started_at")
            .is_none(),
        "started_at cleared on reset"
    );

    let (st, err, _) = job_status(&pool, &exhausted).await;
    assert_eq!(st, "FAILED", "exhausted attempts fail at startup");
    assert_eq!(
        err.as_deref(),
        Some("Max attempts exhausted (3/3) on startup")
    );

    // --- stale sweep: recent PROCESSING untouched; old exhausted FAILED with text ---
    let recent = seed_job(&pool, "PROCESSING", "ocr", Some(2), Some(3), None).await;
    sqlx::query("UPDATE jobs SET updated_at = now() WHERE id = $1")
        .bind(&recent)
        .execute(&pool)
        .await
        .expect("recent timestamp");
    let old_exhausted = seed_job(&pool, "PROCESSING", "render", Some(3), Some(3), None).await;
    sqlx::query("UPDATE jobs SET updated_at = now() - interval '20 minutes' WHERE id = $1")
        .bind(&old_exhausted)
        .execute(&pool)
        .await
        .expect("old timestamp");
    manga_backend::jobs::recovery::recover_stale_processing_jobs(&state).await;
    assert_eq!(
        job_status(&pool, &recent).await.0,
        "PROCESSING",
        "recent job untouched"
    );
    let (st, err, _) = job_status(&pool, &old_exhausted).await;
    assert_eq!(st, "FAILED");
    assert_eq!(
        err.as_deref(),
        Some("Max attempts exhausted after stale recovery")
    );

    clear_jobs(&pool).await;

    // --- debounced renders: threshold query + 5-minute recent-failure skip ---
    let series_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language) \
         VALUES ($1, now(), now(), '__jobs-e2e-render__', 'rightToLeft', 'ja')",
    )
    .bind(series_id)
    .execute(&pool)
    .await
    .expect("series");
    let chapter_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO chapters (id, chapter_number, created_at, updated_at, use_context_memory, series_id) \
         VALUES ($1, 1, now(), now(), TRUE, $2)",
    )
    .bind(chapter_id)
    .bind(series_id)
    .execute(&pool)
    .await
    .expect("chapter");
    let image_id = uuid::Uuid::new_v4();
    sqlx::query(
        "INSERT INTO images (id, created_at, filename, storage_path, hash, width, height) \
         VALUES ($1, now(), 'r.png', 'originals/r.png', 'hash-jobs', 64, 64)",
    )
    .bind(image_id)
    .execute(&pool)
    .await
    .expect("image");
    let page_id = uuid::Uuid::new_v4();
    sqlx::query("INSERT INTO pages (id, page_number, chapter_id, image_id) VALUES ($1, 1, $2, $3)")
        .bind(page_id)
        .bind(chapter_id)
        .bind(image_id)
        .execute(&pool)
        .await
        .expect("page");
    sqlx::query(
        "INSERT INTO page_scene_snapshots \
         (page_id, revision, contract_version, source_sha256, logical_scene_sha256, scene_json) \
         VALUES ($1, 0, 'page-scene/v1', repeat('a', 64), repeat('b', 64), '{}'::jsonb)",
    )
    .bind(page_id)
    .execute(&pool)
    .await
    .expect("immutable scene snapshot");

    // Edited 30s ago, never rendered → qualifies.
    sqlx::query("UPDATE pages SET last_edited_at = now() - interval '30 seconds' WHERE id = $1")
        .bind(page_id)
        .execute(&pool)
        .await
        .expect("edit stamp");
    manga_backend::jobs::recovery::process_pending_renders(&state).await;
    let render_jobs: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE image_id = $1 AND type = 'render'")
            .bind(image_id)
            .fetch_one(&pool)
            .await
            .expect("render count");
    assert_eq!(render_jobs, 1, "debounced render enqueued for stale edit");
    let render_ledger_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_render_jobs WHERE page_id = $1")
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .expect("render ledger count");
    assert_eq!(render_ledger_rows, 1);
    manga_backend::jobs::recovery::process_pending_renders(&state).await;
    let deduplicated_render_jobs: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE image_id = $1 AND type = 'render'")
            .bind(image_id)
            .fetch_one(&pool)
            .await
            .expect("deduplicated render count");
    assert_eq!(deduplicated_render_jobs, 1, "same revision queues once");
    sqlx::query(
        "UPDATE pages SET scene_revision = 1, last_edited_at = now() - interval '30 seconds' WHERE id = $1",
    )
    .bind(page_id)
    .execute(&pool)
    .await
    .expect("newer page revision");
    sqlx::query(
        "INSERT INTO page_scene_snapshots \
         (page_id, revision, contract_version, source_sha256, logical_scene_sha256, scene_json) \
         VALUES ($1, 1, 'page-scene/v1', repeat('a', 64), repeat('c', 64), '{}'::jsonb)",
    )
    .bind(page_id)
    .execute(&pool)
    .await
    .expect("newer immutable scene snapshot");
    manga_backend::jobs::recovery::process_pending_renders(&state).await;
    let queued_revisions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_render_jobs WHERE page_id = $1")
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .expect("queued revision count");
    assert_eq!(
        queued_revisions, 2,
        "an edit during a queued render retains its newer revision"
    );

    // The first callback arrives after a newer scene was saved. It retains its own immutable
    // artifact but cannot advance the page's current pointer or its rendered timestamp.
    let old_job_id: String = sqlx::query_scalar(
        "SELECT job_id FROM page_render_jobs WHERE page_id = $1 AND page_revision = 0",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .expect("old render ledger");
    state
        .storage
        .upload_bytes(
            &format!("rendered/{image_id}.png"),
            b"old revision output".to_vec(),
            "image/png",
        )
        .await
        .expect("stage old render output");
    let old_callback = manga_backend::jobs::coordinator::handle_render_callback(
        &state,
        Some(&old_job_id),
        image_id,
        Some(page_id),
    )
    .await
    .expect("old callback");
    assert!(!old_callback.artifact_current);
    let old_pointer: Option<String> =
        sqlx::query_scalar("SELECT current_render_job_id FROM pages WHERE id = $1")
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .expect("old page pointer");
    assert!(
        old_pointer.is_none(),
        "an old callback must not present its artifact as current"
    );
    let pending_response = manga_backend::routes::page::get_page_rendered(
        axum::extract::State(state.clone()),
        axum::extract::Path(page_id),
    )
    .await;
    assert_eq!(
        pending_response.status(),
        StatusCode::CONFLICT,
        "the page read boundary must not expose the old callback"
    );
    let pending_body = pending_response
        .into_body()
        .collect()
        .await
        .expect("pending response body")
        .to_bytes();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&pending_body).expect("pending response JSON")
            ["status"],
        "pending"
    );

    let current_job_id: String = sqlx::query_scalar(
        "SELECT job_id FROM page_render_jobs WHERE page_id = $1 AND page_revision = 1",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .expect("current render ledger");
    let current_output = b"current revision output".to_vec();
    state
        .storage
        .upload_bytes(
            &format!("rendered/{image_id}.png"),
            current_output.clone(),
            "image/png",
        )
        .await
        .expect("stage current render output");
    let current_callback = manga_backend::jobs::coordinator::handle_render_callback(
        &state,
        Some(&current_job_id),
        image_id,
        Some(page_id),
    )
    .await
    .expect("current callback");
    assert!(current_callback.artifact_current);
    let (current_pointer, artifact_path): (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT p.current_render_job_id, r.rendered_png_storage_path \
         FROM pages p JOIN page_render_jobs r ON r.job_id = p.current_render_job_id \
         WHERE p.id = $1",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .expect("current artifact pointer");
    assert_eq!(current_pointer.as_deref(), Some(current_job_id.as_str()));
    assert_eq!(
        state
            .storage
            .download_bytes(artifact_path.as_deref().expect("artifact path"))
            .await,
        Some(current_output.clone()),
        "the current pointer selects immutable bytes for the current revision"
    );
    let ready_response = manga_backend::routes::page::get_page_rendered(
        axum::extract::State(state.clone()),
        axum::extract::Path(page_id),
    )
    .await;
    assert_eq!(ready_response.status(), StatusCode::OK);
    assert_eq!(
        ready_response
            .into_body()
            .collect()
            .await
            .expect("ready response body")
            .to_bytes()
            .to_vec(),
        current_output,
        "the public page read returns exactly the current immutable artifact"
    );
    let duplicate = manga_backend::jobs::coordinator::handle_render_callback(
        &state,
        Some(&current_job_id),
        image_id,
        Some(page_id),
    )
    .await
    .expect("duplicate callback");
    assert!(
        !duplicate.artifact_current,
        "duplicate completion cannot advance the current artifact again"
    );

    // A failed immutable job is not completion. The next debounce scan may reserve a fresh job
    // for the same current snapshot without disturbing the earlier current artifact.
    sqlx::query(
        "UPDATE pages SET scene_revision = 2, last_edited_at = now() - interval '30 seconds' WHERE id = $1",
    )
    .bind(page_id)
    .execute(&pool)
    .await
    .expect("third page revision");
    sqlx::query(
        "INSERT INTO page_scene_snapshots \
         (page_id, revision, contract_version, source_sha256, logical_scene_sha256, scene_json) \
         VALUES ($1, 2, 'page-scene/v1', repeat('a', 64), repeat('d', 64), '{}'::jsonb)",
    )
    .bind(page_id)
    .execute(&pool)
    .await
    .expect("third immutable scene snapshot");
    manga_backend::jobs::recovery::process_pending_renders(&state).await;
    sqlx::query(
        "UPDATE page_render_jobs SET status = 'failed' \
         WHERE page_id = $1 AND page_revision = 2",
    )
    .bind(page_id)
    .execute(&pool)
    .await
    .expect("fail immutable render job");
    let failed_response = manga_backend::routes::page::get_page_rendered(
        axum::extract::State(state.clone()),
        axum::extract::Path(page_id),
    )
    .await;
    assert_eq!(failed_response.status(), StatusCode::CONFLICT);
    let failed_body = failed_response
        .into_body()
        .collect()
        .await
        .expect("failed response body")
        .to_bytes();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&failed_body).expect("failed response JSON")["status"],
        "failed"
    );
    manga_backend::jobs::recovery::process_pending_renders(&state).await;
    let retry_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM page_render_jobs WHERE page_id = $1 AND page_revision = 2",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .expect("retry ledger count");
    assert_eq!(retry_count, 2, "a failed render job remains retryable");
    let retry_pending_response = manga_backend::routes::page::get_page_rendered(
        axum::extract::State(state.clone()),
        axum::extract::Path(page_id),
    )
    .await;
    assert_eq!(
        retry_pending_response.status(),
        StatusCode::CONFLICT,
        "a retry reservation remains pending until its artifact callback"
    );

    sqlx::query("UPDATE pages SET current_render_job_id = NULL WHERE id = $1")
        .bind(page_id)
        .execute(&pool)
        .await
        .expect("clear current pointer before ledger cleanup");
    // Remove coordinator-created rows too (their ids are uuids, not e2e-prefixed).
    sqlx::query("DELETE FROM job_costs WHERE job_id IN (SELECT id FROM jobs WHERE image_id=$1)")
        .bind(image_id)
        .execute(&pool)
        .await
        .expect("render costs cleanup");
    sqlx::query("DELETE FROM jobs WHERE image_id = $1")
        .bind(image_id)
        .execute(&pool)
        .await
        .expect("renders cleanup");
    sqlx::query("DELETE FROM page_render_jobs WHERE page_id = $1")
        .bind(page_id)
        .execute(&pool)
        .await
        .expect("render ledger cleanup");

    // Recent FAILED render within 5 minutes → skipped this cycle.
    sqlx::query("UPDATE pages SET last_edited_at = now() - interval '30 seconds', last_rendered_at = NULL WHERE id = $1")
        .bind(page_id)
        .execute(&pool)
        .await
        .expect("re-stamp edit");
    seed_job_with_image(&pool, "FAILED", "render", image_id).await;
    manga_backend::jobs::recovery::process_pending_renders(&state).await;
    let render_jobs: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE image_id = $1 AND type = 'render'")
            .bind(image_id)
            .fetch_one(&pool)
            .await
            .expect("render count after skip");
    assert_eq!(
        render_jobs, 1,
        "5-minute failure cooldown suppresses re-trigger"
    );

    // And an old failure does NOT block: backdate it beyond the 5-minute window.
    sqlx::query(
        "UPDATE jobs SET updated_at = now() - interval '10 minutes' WHERE image_id = $1 AND status = 'FAILED'",
    )
    .bind(image_id)
    .execute(&pool)
    .await
    .expect("backdate failure");
    sqlx::query("UPDATE pages SET last_edited_at = now() - interval '30 seconds', last_rendered_at = NULL WHERE id = $1")
        .bind(page_id)
        .execute(&pool)
        .await
        .expect("re-stamp edit again");
    manga_backend::jobs::recovery::process_pending_renders(&state).await;
    let render_jobs: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE image_id = $1 AND type = 'render'")
            .bind(image_id)
            .fetch_one(&pool)
            .await
            .expect("render count after old failure");
    assert_eq!(
        render_jobs, 2,
        "failure older than 5 minutes allows re-trigger"
    );

    // Cleanup: cascade removes pages/chapters with the series; jobs by prefix.
    clear_jobs(&pool).await;
    sqlx::query(
        "DELETE FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1)",
    )
    .bind(series_id)
    .execute(&pool)
    .await
    .expect("pages cleanup");
    sqlx::query("DELETE FROM chapters WHERE series_id=$1")
        .bind(series_id)
        .execute(&pool)
        .await
        .expect("chapters cleanup");
    sqlx::query("DELETE FROM series WHERE id=$1")
        .bind(series_id)
        .execute(&pool)
        .await
        .expect("series cleanup");
    let _ = redis.delete("queue:render").await;
}

/// Seed a render job bound to an image (for cooldown tests).
async fn seed_job_with_image(
    pool: &sqlx::PgPool,
    status: &str,
    job_type: &str,
    image_id: uuid::Uuid,
) -> String {
    let id = format!("e2e-{}", uuid::Uuid::new_v4());
    sqlx::query(
        "INSERT INTO jobs (id, type, status, image_id, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, now(), now())",
    )
    .bind(&id)
    .bind(job_type)
    .bind(status)
    .bind(image_id)
    .execute(pool)
    .await
    .expect("seed image job");
    id
}
