//! R3 reliability gate: the recovery and attempt-safety cases the phase-separation handoff
//! requires before cleanup can be trusted to run as its own stage.
//!
//! Each test drives ONE of the named cases end to end against a real Postgres + Valkey:
//! healthy work outliving the old ten-minute staleness rule, death before the callback, death
//! after the result committed but before the next stage reached Redis, a superseded attempt
//! answering late, and inputs replaced (page redo, page deletion) while a stage is in flight.
//!
//! Requires REAL Postgres + Valkey (env-gated like every integration suite).

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;
use uuid::Uuid;

use manga_backend::config::{Config, DatabaseConfig, MinioConfig, RedisConfig};
use manga_backend::db;
use manga_backend::jobs::coordinator;
use manga_backend::jwt::JwtUtils;
use manga_backend::minio::MinioService;
use manga_backend::redis_service::RedisService;
use manga_backend::state::AppState;

const SECRET: &str = "test-secret-long-enough-for-hmac-signing-1234567890";
const INTERNAL_TOKEN: &str = "test-internal-token";

/// The stage queues are global Redis lists shared with every other suite, so these tests hold
/// one lock for their whole body and only ever look for their own page's entries.
static QUEUE_GUARD: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

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

async fn app() -> Option<(Router, sqlx::PgPool, Arc<RedisService>, AppState)> {
    let pool = db::connect(&db_config_from_env()?).await.ok()?;
    let addr = std::env::var("REDIS_TEST_ADDR").ok()?;
    let (host, port) = addr.split_once(':')?;
    let redis = Arc::new(
        RedisService::connect(host, port.parse().expect("numeric port"))
            .await
            .expect("redis connect"),
    );
    let minio = MinioConfig {
        endpoint: std::env::var("MINIO_TEST_ENDPOINT")
            .unwrap_or_else(|_| "http://localhost:9000".into()),
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
        internal_api_token: Some(INTERNAL_TOKEN.into()),
        jwt_expiration_ms: 3_600_000,
        minio: minio.clone(),
        redis: RedisConfig {
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
    let router = manga_backend::routes::build_router(state.clone());
    Some((router, pool, redis, state))
}

async fn seed_pipeline(pool: &sqlx::PgPool) -> (Uuid, Uuid, Uuid, Uuid) {
    let series_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language, source_language, target_language) \
         VALUES ($1, now(), now(), 'Recovery E2E', 'rightToLeft', 'ja', 'ja', 'en')",
    )
    .bind(series_id)
    .execute(pool)
    .await
    .expect("series");

    let chapter_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO chapters (id, chapter_number, created_at, updated_at, use_context_memory, series_id) \
         VALUES ($1, 1, now(), now(), TRUE, $2)",
    )
    .bind(chapter_id)
    .bind(series_id)
    .execute(pool)
    .await
    .expect("chapter");

    let image_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO images (id, created_at, filename, storage_path, hash, width, height) \
         VALUES ($1, now(), 'recovery.png', 'originals/recovery.png', $2, 64, 64)",
    )
    .bind(image_id)
    .bind(format!("{:0>64}", image_id.simple().to_string()))
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

async fn cleanup_series(pool: &sqlx::PgPool, series_id: Uuid) {
    for statement in [
        "DELETE FROM ocr_regions WHERE page_id IN (SELECT id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
        "DELETE FROM jobs WHERE image_id IN (SELECT image_id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
        "DELETE FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1)",
        "DELETE FROM chapters WHERE series_id=$1",
        "DELETE FROM series WHERE id=$1",
    ] {
        let _ = sqlx::query(statement).bind(series_id).execute(pool).await;
    }
}

/// One OCR region on the page, so a cleanup job has something to be dispatched for.
async fn seed_region(pool: &sqlx::PgPool, page_id: Uuid) -> Uuid {
    let region_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO ocr_regions (id, text, detected_language, bbox_x, bbox_y, bbox_w, bbox_h, page_id) \
         VALUES ($1, 'こんにちは', 'ja', 5, 5, 30, 20, $2)",
    )
    .bind(region_id)
    .bind(page_id)
    .execute(pool)
    .await
    .expect("region");
    region_id
}

/// A PROCESSING job whose attempt is alive: lease in the future, heartbeat just now.
async fn seed_live_job(
    pool: &sqlx::PgPool,
    job_type: &str,
    image_id: Uuid,
    page_id: Uuid,
) -> String {
    let job_id = format!("{job_type}-{}", Uuid::new_v4());
    let input_generation: i32 =
        sqlx::query_scalar("SELECT input_generation FROM pages WHERE id=$1")
            .bind(page_id)
            .fetch_one(pool)
            .await
            .unwrap_or(0);
    let payload = serde_json::json!({
        "jobId": job_id,
        "type": job_type,
        "imageId": image_id.to_string(),
        "pageId": page_id.to_string(),
        "attempt": 1,
        "maxAttempts": 3,
        "inputGeneration": input_generation,
        "leaseToken": job_id,
    })
    .to_string();
    sqlx::query(
        "INSERT INTO jobs (id, type, status, image_id, page_id, attempt, max_attempts, payload, \
           input_generation, lease_token, lease_expires_at, heartbeat_at, started_at, created_at, updated_at) \
         VALUES ($1,$2,'PROCESSING',$3,$4,1,3,$5,$6,$1, now() + interval '120 seconds', now(), now(), now(), now())",
    )
    .bind(&job_id)
    .bind(job_type)
    .bind(image_id)
    .bind(page_id)
    .bind(&payload)
    .bind(input_generation)
    .execute(pool)
    .await
    .expect("live job");
    job_id
}

fn identity_of(job_id: &str, attempt: i32, input_generation: i32) -> coordinator::CallbackIdentity {
    coordinator::CallbackIdentity {
        job_id: job_id.to_string(),
        attempt,
        input_generation,
        lease_token: job_id.to_string(),
    }
}

async fn post_callback(
    app: &Router,
    uri: &str,
    identity: &coordinator::CallbackIdentity,
    body: &serde_json::Value,
) -> (StatusCode, String) {
    let request = Request::builder()
        .method("POST")
        .uri(uri)
        .header("Content-Type", "application/json")
        .header("X-Internal-Token", INTERNAL_TOKEN)
        .header("X-Job-Id", &identity.job_id)
        .header("X-Job-Attempt", identity.attempt.to_string())
        .header("X-Input-Generation", identity.input_generation.to_string())
        .header("X-Lease-Token", &identity.lease_token)
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).to_string())
}

async fn job_row(pool: &sqlx::PgPool, job_id: &str) -> (String, Option<i32>, Option<String>) {
    sqlx::query_as("SELECT status, attempt, lease_token FROM jobs WHERE id = $1")
        .bind(job_id)
        .fetch_one(pool)
        .await
        .expect("job row")
}

/// The body a worker sends when every dispatched region came back clean.
fn cleanup_response(
    job_id: &str,
    image_id: Uuid,
    page_id: Uuid,
    region_id: Uuid,
) -> serde_json::Value {
    serde_json::json!({
        "jobId": job_id,
        "imageId": image_id.to_string(),
        "pageId": page_id.to_string(),
        "regions": [{
            "regionId": region_id.to_string(),
            "inputDigest": "unused-when-nothing-was-dispatched",
            "status": "complete",
        }],
    })
}

// ---------------------------------------------------------------------------

/// Healthy work spanning the old ten-minute threshold.
///
/// Cleanup pages spend many minutes inside one CTD call. Under the previous rule — ten minutes of
/// silence on `updated_at` — the sweeper requeued them mid-flight and the finished attempt's
/// result was then discarded as a duplicate. A renewed lease is what says "still working".
#[tokio::test]
async fn a_leased_job_survives_the_old_ten_minute_staleness_rule() {
    let Some((_app, pool, _redis, state)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let _guard = QUEUE_GUARD.lock().await;
    let (series_id, _chapter_id, page_id, image_id) = seed_pipeline(&pool).await;
    let job_id = seed_live_job(&pool, "cleanup", image_id, page_id).await;

    // Twenty minutes since the row was last *written*, but the lease was renewed a moment ago.
    sqlx::query("UPDATE jobs SET updated_at = now() - interval '20 minutes' WHERE id = $1")
        .bind(&job_id)
        .execute(&pool)
        .await
        .unwrap();

    manga_backend::jobs::recovery::recover_stale_processing_jobs(&state).await;

    let (status, attempt, _) = job_row(&pool, &job_id).await;
    assert_eq!(
        (status.as_str(), attempt),
        ("PROCESSING", Some(1)),
        "a job with a live lease is working, not stale"
    );

    cleanup_series(&pool, series_id).await;
}

/// Death before the callback: the worker process is gone, so nothing renews the lease.
///
/// Recovery re-arms the row for a new attempt, rotates the lease token, rewrites the payload the
/// dispatcher will hand out, and republishes it.
#[tokio::test]
async fn an_expired_lease_is_re_armed_with_a_fresh_attempt_and_republished() {
    let Some((_app, pool, redis, state)) = app().await else {
        return;
    };
    let _guard = QUEUE_GUARD.lock().await;
    let (series_id, _chapter_id, page_id, image_id) = seed_pipeline(&pool).await;
    let job_id = seed_live_job(&pool, "cleanup", image_id, page_id).await;

    sqlx::query(
        "UPDATE jobs SET lease_expires_at = now() - interval '5 seconds', \
           callback_applied_at = now() WHERE id = $1",
    )
    .bind(&job_id)
    .execute(&pool)
    .await
    .unwrap();

    manga_backend::jobs::recovery::recover_stale_processing_jobs(&state).await;

    let (status, attempt, lease) = job_row(&pool, &job_id).await;
    assert_eq!((status.as_str(), attempt), ("PENDING", Some(2)));
    assert_ne!(
        lease.as_deref(),
        Some(job_id.as_str()),
        "recovery rotates the lease so the dead attempt cannot come back"
    );
    let claimed: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT callback_applied_at FROM jobs WHERE id = $1")
            .bind(&job_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        claimed.is_none(),
        "re-arming releases the claim, or the retry's own result would read as a duplicate"
    );

    let payload: Option<String> = sqlx::query_scalar("SELECT payload FROM jobs WHERE id = $1")
        .bind(&job_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&payload.unwrap()).unwrap();
    assert_eq!(payload["attempt"], 2);
    assert_eq!(payload["leaseToken"], lease.clone().unwrap());

    let mut republished = false;
    let mut put_back = Vec::new();
    while let Some(raw) = redis.pop_from_queue("queue:cleanup").await.unwrap() {
        let queued: serde_json::Value = serde_json::from_str(&raw).unwrap();
        if queued["jobId"] == job_id {
            republished = true;
            break;
        }
        put_back.push(raw);
    }
    for raw in put_back {
        redis.push_to_queue("queue:cleanup", &raw).await.unwrap();
    }
    assert!(republished, "a re-armed job goes back on its stage queue");

    cleanup_series(&pool, series_id).await;
}

/// The superseded attempt answering after recovery has moved on.
///
/// This is the case job-ID deduplication alone cannot cover: the job id is right, the row exists,
/// and the old process has a complete, plausible result to write.
#[tokio::test]
async fn a_recovered_attempt_locks_out_the_one_it_replaced() {
    let Some((app, pool, _redis, state)) = app().await else {
        return;
    };
    let _guard = QUEUE_GUARD.lock().await;
    let (series_id, _chapter_id, page_id, image_id) = seed_pipeline(&pool).await;
    let region_id = seed_region(&pool, page_id).await;
    let job_id = seed_live_job(&pool, "cleanup", image_id, page_id).await;
    let doomed = identity_of(&job_id, 1, 0);

    sqlx::query("UPDATE jobs SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1")
        .bind(&job_id)
        .execute(&pool)
        .await
        .unwrap();
    manga_backend::jobs::recovery::recover_stale_processing_jobs(&state).await;

    let (status, body) = post_callback(
        &app,
        "/tlhub/api/internal/jobs/callback/cleanup",
        &doomed,
        &cleanup_response(&job_id, image_id, page_id, region_id),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "the replaced attempt must not be able to write its result: {body}"
    );

    let patched: Option<String> =
        sqlx::query_scalar("SELECT cleanup_patch_asset_id FROM ocr_regions WHERE id = $1")
            .bind(region_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(patched.is_none(), "no patch from a superseded attempt");
    let translations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE image_id=$1 AND type='translation'")
            .bind(image_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(translations, 0, "and no stage advanced on its word");

    cleanup_series(&pool, series_id).await;
}

/// Death after the result committed but before the next stage reached Redis.
///
/// The `jobs` row IS the durable dispatch intent, so the successor exists in the database even
/// though nothing published it. The reconciler is what closes the gap; without it the page waits
/// forever, and with chapter context injection on, every later page waits behind it.
#[tokio::test]
async fn a_next_stage_that_never_reached_redis_is_reconciled() {
    let Some((_app, pool, redis, state)) = app().await else {
        return;
    };
    let _guard = QUEUE_GUARD.lock().await;
    let (series_id, _chapter_id, page_id, image_id) = seed_pipeline(&pool).await;

    // Exactly what `persist_next_job_tx` leaves behind when the process dies before publishing:
    // PENDING, never dispatched, on no queue. The two-minute age is the reconciler's grace
    // period, which keeps it off the heels of an enqueue that is still in progress.
    let job_id = format!("translation-{}", Uuid::new_v4());
    let payload = serde_json::json!({
        "jobId": job_id,
        "type": "translation",
        "imageId": image_id.to_string(),
        "pageId": page_id.to_string(),
        "attempt": 1,
        "leaseToken": job_id,
    })
    .to_string();
    sqlx::query(
        "INSERT INTO jobs (id, type, status, image_id, page_id, attempt, max_attempts, payload, \
           input_generation, lease_token, created_at, updated_at) \
         VALUES ($1,'translation','PENDING',$2,$3,1,3,$4,0,$1, now() - interval '5 minutes', now() - interval '5 minutes')",
    )
    .bind(&job_id)
    .bind(image_id)
    .bind(page_id)
    .bind(&payload)
    .execute(&pool)
    .await
    .expect("stranded successor");

    manga_backend::jobs::recovery::requeue_orphaned_pending_jobs(&state).await;

    let mut found = false;
    let mut put_back = Vec::new();
    while let Some(raw) = redis.pop_from_queue("queue:translation").await.unwrap() {
        let queued: serde_json::Value = serde_json::from_str(&raw).unwrap();
        if queued["jobId"] == job_id {
            found = true;
            break;
        }
        put_back.push(raw);
    }
    for raw in put_back {
        redis
            .push_to_queue("queue:translation", &raw)
            .await
            .unwrap();
    }
    assert!(
        found,
        "a committed-but-unpublished stage must not strand the page"
    );

    cleanup_series(&pool, series_id).await;
}

/// A page redo while cleanup is in flight: new source geometry, so the running attempt's patches
/// describe boxes that no longer exist.
///
/// The generation — not the job id, not the attempt — is what fences this. The old attempt's job
/// row is still PROCESSING and still holds its lease; only `input_generation` has moved.
#[tokio::test]
async fn a_page_redo_supersedes_the_cleanup_that_was_already_running() {
    let Some((app, pool, _redis, _state)) = app().await else {
        return;
    };
    let _guard = QUEUE_GUARD.lock().await;
    let (series_id, _chapter_id, page_id, image_id) = seed_pipeline(&pool).await;
    let region_id = seed_region(&pool, page_id).await;
    let job_id = seed_live_job(&pool, "cleanup", image_id, page_id).await;
    let in_flight = identity_of(&job_id, 1, 0);

    let generation =
        manga_backend::page_freshness::advance_page_input_generation_pool(&pool, page_id)
            .await
            .expect("redo advances the page's inputs");
    assert_eq!(generation, 1);

    let (status, body) = post_callback(
        &app,
        "/tlhub/api/internal/jobs/callback/cleanup",
        &in_flight,
        &cleanup_response(&job_id, image_id, page_id, region_id),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "cleanup for superseded geometry must not be accepted: {body}"
    );
    let patched: Option<String> =
        sqlx::query_scalar("SELECT cleanup_patch_asset_id FROM ocr_regions WHERE id = $1")
            .bind(region_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(patched.is_none());

    cleanup_series(&pool, series_id).await;
}

/// The other half of the same case: the superseded attempt simply dies instead of answering.
///
/// Recovery must not re-arm it. That job carries the region list and geometry of a generation
/// the page has left behind, so every re-dispatch is a full CTD pass whose callback the fence
/// will refuse — up to `max_attempts` of them.
#[tokio::test]
async fn recovery_abandons_a_job_whose_page_inputs_were_replaced() {
    let Some((_app, pool, redis, state)) = app().await else {
        return;
    };
    let _guard = QUEUE_GUARD.lock().await;
    let (series_id, _chapter_id, page_id, image_id) = seed_pipeline(&pool).await;
    seed_region(&pool, page_id).await;
    let job_id = seed_live_job(&pool, "cleanup", image_id, page_id).await;

    manga_backend::page_freshness::advance_page_input_generation_pool(&pool, page_id)
        .await
        .expect("redo advances the page's inputs");
    sqlx::query("UPDATE jobs SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1")
        .bind(&job_id)
        .execute(&pool)
        .await
        .unwrap();

    manga_backend::jobs::recovery::recover_stale_processing_jobs(&state).await;

    let (status, attempt, _) = job_row(&pool, &job_id).await;
    assert_eq!(
        (status.as_str(), attempt),
        ("FAILED", Some(1)),
        "an obsolete job is failed explicitly, not retried against inputs that are gone"
    );
    let mut requeued = false;
    let mut put_back = Vec::new();
    while let Some(raw) = redis.pop_from_queue("queue:cleanup").await.unwrap() {
        let queued: serde_json::Value = serde_json::from_str(&raw).unwrap();
        if queued["jobId"] == job_id {
            requeued = true;
            break;
        }
        put_back.push(raw);
    }
    for raw in put_back {
        redis.push_to_queue("queue:cleanup", &raw).await.unwrap();
    }
    assert!(!requeued, "and it does not go back on the queue");

    cleanup_series(&pool, series_id).await;
}

/// A page deleted while its cleanup ran. There is nothing left to write the result onto, and the
/// callback must say so rather than quietly succeeding and advancing a stage for a missing page.
#[tokio::test]
async fn a_deleted_page_has_no_acceptable_cleanup_callback() {
    let Some((app, pool, _redis, _state)) = app().await else {
        return;
    };
    let _guard = QUEUE_GUARD.lock().await;
    let (series_id, _chapter_id, page_id, image_id) = seed_pipeline(&pool).await;
    let region_id = seed_region(&pool, page_id).await;
    let job_id = seed_live_job(&pool, "cleanup", image_id, page_id).await;
    let in_flight = identity_of(&job_id, 1, 0);

    sqlx::query("DELETE FROM ocr_regions WHERE page_id = $1")
        .bind(page_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE jobs SET page_id = NULL WHERE page_id = $1")
        .bind(page_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM pages WHERE id = $1")
        .bind(page_id)
        .execute(&pool)
        .await
        .unwrap();

    let (status, _) = post_callback(
        &app,
        "/tlhub/api/internal/jobs/callback/cleanup",
        &in_flight,
        &cleanup_response(&job_id, image_id, page_id, region_id),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "a deleted page's callback is an explicit failure, not a silent success"
    );
    let translations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE image_id=$1 AND type='translation'")
            .bind(image_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(translations, 0);

    cleanup_series(&pool, series_id).await;
}
