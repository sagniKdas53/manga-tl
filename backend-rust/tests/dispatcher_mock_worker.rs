//! WorkerDispatcherServiceTest port: drives real dispatcher cycles against an in-test
//! axum mock worker, mirroring the Java scenarios — 202 started_at stamping,
//! 400/422 permanent FAILED marking, 429 exponential cooldown (10s base), AUDIT-P3
//! single-queue stall isolation and slot/pause gating.
//!
//! Mutates jobs rows ⇒ runs ONLY against JOBS_E2E_DATABASE_URL (throwaway DB),
//! like jobs_endpoints.rs.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::State as AxumState;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};

use manga_backend::config::{DatabaseConfig, MinioConfig};
use manga_backend::db;
use manga_backend::jobs::dispatcher::Dispatcher;
use manga_backend::minio::MinioService;
use manga_backend::redis_service::RedisService;
use manga_backend::state::AppState;
use uuid::Uuid;

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

#[derive(Default, Clone)]
struct MockState {
    capabilities_hits: Arc<AtomicU32>,
    submit_hits: Arc<AtomicU32>,
    bodies: Arc<Mutex<Vec<Value>>>,
    /// Response status per queue_name; "*" is the fallback.
    responses: Arc<Mutex<std::collections::HashMap<String, u16>>>,
    capabilities_body: Arc<Mutex<Value>>,
}

async fn mock_server(state: MockState) -> String {
    async fn capabilities(AxumState(s): AxumState<MockState>) -> Json<Value> {
        s.capabilities_hits.fetch_add(1, Ordering::SeqCst);
        Json(s.capabilities_body.lock().unwrap().clone())
    }

    async fn submit(
        AxumState(s): AxumState<MockState>,
        Json(body): Json<Value>,
    ) -> (StatusCode, &'static str) {
        s.submit_hits.fetch_add(1, Ordering::SeqCst);
        let queue = body["queue_name"].as_str().unwrap_or("").to_string();
        s.bodies.lock().unwrap().push(body);
        let status = {
            let map = s.responses.lock().unwrap();
            map.get(&queue).or_else(|| map.get("*")).copied()
        };
        match status {
            Some(202) => (StatusCode::ACCEPTED, "accepted"),
            Some(400) => (StatusCode::BAD_REQUEST, "bad payload"),
            Some(422) => (StatusCode::UNPROCESSABLE_ENTITY, "unprocessable"),
            _ => (StatusCode::TOO_MANY_REQUESTS, "slow down"),
        }
    }

    let app = Router::new()
        .route("/capabilities", get(capabilities))
        .route("/api/v1/jobs/submit", post(submit))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
    format!("http://{addr}")
}

async fn app_with_mock(mock_url: &str) -> Option<(sqlx::PgPool, Arc<RedisService>, AppState)> {
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
    // SAFETY: test process owns its env; Dispatcher::new reads WORKER_URLS once.
    unsafe { std::env::set_var("WORKER_URLS", mock_url) };
    let state = AppState::new(
        config,
        pool.clone(),
        manga_backend::jwt::JwtUtils::new(
            "test-secret-long-enough-for-hmac-signing-1234567890".into(),
            3_600_000,
        ),
        MinioService::new(&minio),
        Some(redis.clone()),
    );
    Some((pool, redis, state))
}

async fn seed_job(redis: &RedisService, pool: &sqlx::PgPool, id: &str, queue: &str) {
    sqlx::query("DELETE FROM job_costs WHERE job_id = $1")
        .bind(id)
        .execute(pool)
        .await
        .expect("clear costs");
    sqlx::query("DELETE FROM jobs WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .expect("clear job");
    sqlx::query(
        "INSERT INTO jobs (id, type, status, payload, created_at, updated_at) \
         VALUES ($1, 'ocr', 'PENDING', $2, now(), now())",
    )
    .bind(id)
    .bind(json!({ "jobId": id }).to_string())
    .execute(pool)
    .await
    .expect("seed job");
    // Keep queue contents deterministic: drain before the test pushes its probe.
    while redis.pop_from_queue(queue).await.unwrap_or(None).is_some() {}
}

/// Both scenarios share the scratch DB and queue keyspace — serialize them.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn dispatcher_end_to_end_against_mock_worker() {
    let _serial = SERIAL.lock().await;
    let mock = MockState::default();
    *mock.capabilities_body.lock().unwrap() = json!({
        "max_concurrent_jobs": 4,
        "active_jobs": 0,
        "max_heavy_slots": 2,
        "active_heavy_jobs": 0,
        "max_light_slots": 2,
        "active_light_jobs": 0,
    });
    *mock.responses.lock().unwrap() = [("*".to_string(), 202u16)].into_iter().collect();
    let mock_url = mock_server(mock.clone()).await;

    let Some((pool, redis, state)) = app_with_mock(&mock_url).await else {
        eprintln!("skipping: JOBS_E2E_DATABASE_URL/REDIS_TEST_ADDR not set");
        return;
    };

    // Clean every probe queue first so counts are exact.
    for q in [
        "queue:ocr",
        "queue:translation",
        "queue:layout",
        "queue:render",
    ] {
        while redis.pop_from_queue(q).await.unwrap_or(None).is_some() {}
    }

    let dispatcher = Dispatcher::new(state.clone());

    // --- pause gate: nothing happens at all ---
    redis.set_queue_paused(true).await.expect("pause");
    redis
        .push_to_queue(
            "queue:ocr",
            &json!({"jobId": "e2e-dispatch-paused"}).to_string(),
        )
        .await
        .expect("push");
    dispatcher.run_cycle().await;
    assert_eq!(
        mock.capabilities_hits.load(Ordering::SeqCst),
        0,
        "paused gate short-circuits before any worker contact"
    );
    assert_eq!(redis.queue_size("queue:ocr").await.unwrap_or(-1), 1);
    redis.set_queue_paused(false).await.expect("resume");

    // --- 202: submit body shape + started_at stamp + queue drained ---
    seed_job(&redis, &pool, "e2e-dispatch-a", "queue:ocr").await;
    redis
        .push_to_queue("queue:ocr", &json!({"jobId": "e2e-dispatch-a"}).to_string())
        .await
        .expect("push a");
    dispatcher.run_cycle().await;

    let caps_after_202 = mock.capabilities_hits.load(Ordering::SeqCst);
    assert!(caps_after_202 >= 1, "capabilities queried");
    {
        let bodies = mock.bodies.lock().unwrap();
        let submitted = bodies
            .iter()
            .find(|b| b["job_data"]["jobId"] == "e2e-dispatch-a")
            .expect("submit observed");
        assert_eq!(submitted["queue_name"], "queue:ocr");
    }
    let started_at: Option<Option<String>> =
        sqlx::query_scalar("SELECT started_at::text FROM jobs WHERE id = 'e2e-dispatch-a'")
            .fetch_one(&pool)
            .await
            .expect("row");
    assert!(
        started_at.flatten().is_some(),
        "202 stamps started_at on the DB row"
    );
    assert_eq!(
        redis.queue_size("queue:ocr").await.unwrap_or(-1),
        0,
        "accepted job leaves its queue"
    );

    // --- 400: permanent FAILED with error text, NOT re-pushed ---
    mock.responses.lock().unwrap().insert("*".to_string(), 400);
    seed_job(&redis, &pool, "e2e-dispatch-b", "queue:ocr").await;
    redis
        .push_to_queue("queue:ocr", &json!({"jobId": "e2e-dispatch-b"}).to_string())
        .await
        .expect("push b");
    dispatcher.run_cycle().await;

    let row: (String, Option<String>) =
        sqlx::query_as("SELECT status, COALESCE(error,'') FROM jobs WHERE id = 'e2e-dispatch-b'")
            .fetch_one(&pool)
            .await
            .expect("row b");
    assert_eq!(row.0, "FAILED", "permanent rejection marks FAILED");
    assert!(
        row.1.as_deref().unwrap_or("").contains("HTTP 400"),
        "error carries the status code: {}",
        row.1.unwrap_or_default()
    );
    assert_eq!(
        redis.queue_size("queue:ocr").await.unwrap_or(-1),
        0,
        "permanently rejected job is not re-pushed"
    );

    // --- 429: cooldown skips the worker next cycle; job stays queued ---
    mock.responses.lock().unwrap().insert("*".to_string(), 429);
    seed_job(&redis, &pool, "e2e-dispatch-c", "queue:ocr").await;
    redis
        .push_to_queue("queue:ocr", &json!({"jobId": "e2e-dispatch-c"}).to_string())
        .await
        .expect("push c");

    let submits_before = mock.submit_hits.load(Ordering::SeqCst);
    dispatcher.run_cycle().await;
    assert_eq!(
        mock.submit_hits.load(Ordering::SeqCst) - submits_before,
        1,
        "one 429'd submit attempt"
    );
    assert_eq!(
        redis.queue_size("queue:ocr").await.unwrap_or(-1),
        1,
        "429 re-queues the job"
    );

    // Next cycle: worker is cooling down (10s base > poll gap) — zero contact.
    let caps_before_cooldown = mock.capabilities_hits.load(Ordering::SeqCst);
    let submits_before_cooldown = mock.submit_hits.load(Ordering::SeqCst);
    dispatcher.run_cycle().await;
    assert_eq!(
        mock.capabilities_hits.load(Ordering::SeqCst),
        caps_before_cooldown,
        "cooled-down worker gets no capabilities query"
    );
    assert_eq!(
        mock.submit_hits.load(Ordering::SeqCst),
        submits_before_cooldown,
        "no submissions during cooldown"
    );

    // --- slot gating: a saturated worker receives no submissions ---
    *mock.capabilities_body.lock().unwrap() = json!({
        "max_concurrent_jobs": 1,
        "active_jobs": 1,
        "max_heavy_slots": 1,
        "active_heavy_jobs": 1,
        "max_light_slots": 1,
        "active_light_jobs": 1,
    });
    // Cooldown would mask the assertion; wait it out via a fresh Dispatcher instance?
    // Cooldown lives per-instance, so build a new one over the same state.
    let fresh = Dispatcher::new(state.clone());
    let caps_before_slots = mock.capabilities_hits.load(Ordering::SeqCst);
    let submits_before_slots = mock.submit_hits.load(Ordering::SeqCst);
    fresh.run_cycle().await;
    assert!(
        mock.capabilities_hits.load(Ordering::SeqCst) > caps_before_slots,
        "fresh dispatcher queries capabilities"
    );
    assert_eq!(
        mock.submit_hits.load(Ordering::SeqCst),
        submits_before_slots,
        "saturated worker receives no submissions"
    );
    assert_eq!(redis.queue_size("queue:ocr").await.unwrap_or(-1), 1);

    // --- AUDIT-P3 single-queue stall: one queue's rejection must not stop another ---
    *mock.capabilities_body.lock().unwrap() = json!({
        "max_concurrent_jobs": 4,
        "active_jobs": 0,
        "max_heavy_slots": 2,
        "active_heavy_jobs": 0,
        "max_light_slots": 2,
        "active_light_jobs": 0,
    });
    *mock.responses.lock().unwrap() = [
        ("queue:ocr".to_string(), 500u16), // non-cooldown failure → stall THIS queue
        ("*".to_string(), 202u16),         // everything else accepts
    ]
    .into_iter()
    .collect();

    seed_job(&redis, &pool, "e2e-dispatch-d", "queue:translation").await;
    // Exactly one stalled probe in queue:ocr for an exact count assertion.
    while redis
        .pop_from_queue("queue:ocr")
        .await
        .unwrap_or(None)
        .is_some()
    {}
    redis
        .push_to_queue("queue:ocr", &json!({"jobId": "e2e-dispatch-c"}).to_string())
        .await
        .expect("push stalled job");
    redis
        .push_to_queue(
            "queue:translation",
            &json!({"jobId": "e2e-dispatch-d"}).to_string(),
        )
        .await
        .expect("push d");
    let submits_before_p3 = mock.submit_hits.load(Ordering::SeqCst);

    fresh.run_cycle().await;

    let p3_submits = mock.submit_hits.load(Ordering::SeqCst) - submits_before_p3;
    assert!(p3_submits >= 2, "both queues attempted in one cycle");
    let d_row: Option<String> =
        sqlx::query_scalar("SELECT status FROM jobs WHERE id='e2e-dispatch-d'")
            .fetch_one(&pool)
            .await
            .expect("row d");
    assert_ne!(d_row.as_deref(), Some("FAILED"));
    let d_started: Option<Option<String>> =
        sqlx::query_scalar("SELECT started_at::text FROM jobs WHERE id='e2e-dispatch-d'")
            .fetch_one(&pool)
            .await
            .expect("row d");
    assert!(
        d_started.flatten().is_some(),
        "translation queue drained despite ocr stalling"
    );
    assert_eq!(
        redis.queue_size("queue:ocr").await.unwrap_or(-1),
        1,
        "stalled queue keeps its job (requeued to the back)"
    );

    // Cleanup probes.
    for id in [
        "e2e-dispatch-a",
        "e2e-dispatch-b",
        "e2e-dispatch-c",
        "e2e-dispatch-d",
    ] {
        sqlx::query("DELETE FROM job_costs WHERE job_id=$1")
            .bind(id)
            .execute(&pool)
            .await
            .expect("cost cleanup");
        sqlx::query("DELETE FROM jobs WHERE id=$1")
            .bind(id)
            .execute(&pool)
            .await
            .expect("job cleanup");
    }
    for q in ["queue:ocr", "queue:translation"] {
        while redis.pop_from_queue(q).await.unwrap_or(None).is_some() {}
    }
}

// ---------------------------------------------------------------------------
// AUDIT-W13 — a context-injecting chapter translates strictly in page order.
// ---------------------------------------------------------------------------

/// Seeds a two-page chapter and returns `(page1_id, page1_image, page2_id)`.
async fn seed_two_page_chapter(pool: &sqlx::PgPool, context_memory: bool) -> (Uuid, Uuid, Uuid) {
    // Pre-clean, not just post-clean: a failing assertion panics before cleanup_w13 runs, and a
    // leftover probe job would then fail the *next* run for the wrong reason.
    cleanup_w13(pool).await;

    let series_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language) \
         VALUES ($1, now(), now(), '__w13-e2e-series__', 'rightToLeft', 'ja')",
    )
    .bind(series_id)
    .execute(pool)
    .await
    .expect("series");

    let chapter_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO chapters (id, chapter_number, created_at, updated_at, use_context_memory, series_id) \
         VALUES ($1, 1, now(), now(), $2, $3)",
    )
    .bind(chapter_id)
    .bind(context_memory)
    .bind(series_id)
    .execute(pool)
    .await
    .expect("chapter");

    let mut images = Vec::new();
    for page_number in 1..=2i32 {
        let image_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO images (id, created_at, filename, storage_path, hash, width, height) \
             VALUES ($1, now(), $2, $3, $4, 64, 64)",
        )
        .bind(image_id)
        .bind(format!("w13-p{page_number}.png"))
        .bind(format!("originals/w13-p{page_number}.png"))
        .bind(format!("hash-w13-{page_number}"))
        .execute(pool)
        .await
        .expect("image");

        sqlx::query(
            "INSERT INTO pages (id, page_number, chapter_id, image_id) VALUES ($1, $2, $3, $4)",
        )
        .bind(Uuid::new_v4())
        .bind(page_number)
        .bind(chapter_id)
        .bind(image_id)
        .execute(pool)
        .await
        .expect("page");
        images.push(image_id);
    }

    let page_id_at = async |number: i32| {
        sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM pages WHERE chapter_id = $1 AND page_number = $2",
        )
        .bind(chapter_id)
        .bind(number)
        .fetch_one(pool)
        .await
        .expect("page")
    };

    (page_id_at(1).await, images[0], page_id_at(2).await)
}

/// Puts page 2's translation job on the queue, in the DB, and nowhere else.
async fn queue_page_two_translation(
    redis: &RedisService,
    pool: &sqlx::PgPool,
    page2_id: Uuid,
    page2_image: Uuid,
) {
    while redis
        .pop_from_queue("queue:translation")
        .await
        .unwrap_or(None)
        .is_some()
    {}
    sqlx::query("DELETE FROM jobs WHERE id = '__w13-tl-p2'")
        .execute(pool)
        .await
        .expect("clear job");
    sqlx::query(
        "INSERT INTO jobs (id, type, status, image_id, page_id, payload, created_at, updated_at) \
         VALUES ('__w13-tl-p2', 'translation', 'PENDING', $1, $2, $3, now(), now())",
    )
    .bind(page2_image)
    .bind(page2_id)
    .bind(json!({ "jobId": "__w13-tl-p2", "pageId": page2_id.to_string() }).to_string())
    .execute(pool)
    .await
    .expect("seed translation job");
    redis
        .push_to_queue(
            "queue:translation",
            &json!({ "jobId": "__w13-tl-p2", "pageId": page2_id.to_string() }).to_string(),
        )
        .await
        .expect("push");
}

/// How many times the mock was handed this specific job.
fn submits_of(mock: &MockState, job_id: &str) -> usize {
    mock.bodies
        .lock()
        .unwrap()
        .iter()
        .filter(|b| b["job_data"]["jobId"] == job_id)
        .count()
}

async fn cleanup_w13(pool: &sqlx::PgPool) {
    let _ = sqlx::query("DELETE FROM jobs WHERE id IN ('__w13-tl-p2', '__w13-ocr-p1')")
        .execute(pool)
        .await;
    let _ = sqlx::query("DELETE FROM series WHERE title = '__w13-e2e-series__'")
        .execute(pool)
        .await;
}

/// AUDIT-W13. A chapter with context injection on prefixes every page's translation prompt with
/// the previous page's dialogue. Four light slots used to translate four pages at once, so that
/// prefix was read before it existed — and because the context query is
/// `COALESCE(translated_text, text)`, an untranslated predecessor handed back its *Japanese
/// source* labelled as "Previous Page Dialogue".
///
/// The gate blocks on the whole run-up to a translation, not just on translation itself: page 1
/// sitting in OCR is the common case, and it has no translation job to find.
#[tokio::test]
async fn a_context_injecting_chapter_translates_strictly_in_page_order() {
    let _guard = SERIAL.lock().await;
    let mock = MockState::default();
    *mock.capabilities_body.lock().unwrap() = json!({
        "max_concurrent_jobs": 4,
        "active_jobs": 0,
        "max_heavy_slots": 2,
        "active_heavy_jobs": 0,
        "max_light_slots": 2,
        "active_light_jobs": 0,
    });
    *mock.responses.lock().unwrap() = [("*".to_string(), 202u16)].into_iter().collect();
    let url = mock_server(mock.clone()).await;
    let Some((pool, redis, state)) = app_with_mock(&url).await else {
        eprintln!("skipping: JOBS_E2E_DATABASE_URL / REDIS_TEST_ADDR not set");
        return;
    };
    redis.set_queue_paused(false).await.expect("resume");

    let (page1_id, page1_image, page2_id) = seed_two_page_chapter(&pool, true).await;
    let page2_image: Uuid = sqlx::query_scalar("SELECT image_id FROM pages WHERE id = $1")
        .bind(page2_id)
        .fetch_one(&pool)
        .await
        .expect("page 2 image");

    // Page 1 has not reached translation yet — it is still in OCR. That is the case an ordering
    // gate keyed only on translation jobs would wave straight through.
    sqlx::query(
        "INSERT INTO jobs (id, type, status, image_id, page_id, payload, created_at, updated_at) \
         VALUES ('__w13-ocr-p1', 'ocr', 'PENDING', $1, $2, '{}', now(), now())",
    )
    .bind(page1_image)
    .bind(page1_id)
    .execute(&pool)
    .await
    .expect("page 1 ocr job");

    queue_page_two_translation(&redis, &pool, page2_id, page2_image).await;

    let dispatcher = Dispatcher::new(state.clone());
    dispatcher.run_cycle().await;

    // Count this job's own submits, not every submit the mock saw: the test binaries share one
    // Redis keyspace, so an unrelated suite's job can land on queue:translation and be dispatched
    // to this mock in the same cycle.
    assert_eq!(
        submits_of(&mock, "__w13-tl-p2"),
        0,
        "page 2 must not translate while page 1 is still upstream of its own translation"
    );

    // Page 1 finishes. Nothing else changes.
    sqlx::query("UPDATE jobs SET status = 'COMPLETED' WHERE id = '__w13-ocr-p1'")
        .execute(&pool)
        .await
        .expect("complete page 1");

    // Held, not dropped: it comes back off the queue on a later cycle. More than one cycle may be
    // needed because a blocked pop stops that queue's drain for the cycle (AUDIT-P3).
    for _ in 0..4 {
        dispatcher.run_cycle().await;
        if submits_of(&mock, "__w13-tl-p2") > 0 {
            break;
        }
    }
    assert_eq!(
        submits_of(&mock, "__w13-tl-p2"),
        1,
        "with nothing outstanding before it, page 2 dispatches"
    );

    cleanup_w13(&pool).await;
}

/// The gate is scoped to chapters that actually inject context. Everything else keeps translating
/// in parallel, which is the whole point of four light slots.
#[tokio::test]
async fn a_chapter_without_context_injection_is_not_serialised() {
    let _guard = SERIAL.lock().await;
    let mock = MockState::default();
    *mock.capabilities_body.lock().unwrap() = json!({
        "max_concurrent_jobs": 4,
        "active_jobs": 0,
        "max_heavy_slots": 2,
        "active_heavy_jobs": 0,
        "max_light_slots": 2,
        "active_light_jobs": 0,
    });
    *mock.responses.lock().unwrap() = [("*".to_string(), 202u16)].into_iter().collect();
    let url = mock_server(mock.clone()).await;
    let Some((pool, redis, state)) = app_with_mock(&url).await else {
        eprintln!("skipping: JOBS_E2E_DATABASE_URL / REDIS_TEST_ADDR not set");
        return;
    };
    redis.set_queue_paused(false).await.expect("resume");

    let (page1_id, page1_image, page2_id) = seed_two_page_chapter(&pool, false).await;
    let page2_image: Uuid = sqlx::query_scalar("SELECT image_id FROM pages WHERE id = $1")
        .bind(page2_id)
        .fetch_one(&pool)
        .await
        .expect("page 2 image");

    sqlx::query(
        "INSERT INTO jobs (id, type, status, image_id, page_id, payload, created_at, updated_at) \
         VALUES ('__w13-ocr-p1', 'ocr', 'PENDING', $1, $2, '{}', now(), now())",
    )
    .bind(page1_image)
    .bind(page1_id)
    .execute(&pool)
    .await
    .expect("page 1 ocr job");

    queue_page_two_translation(&redis, &pool, page2_id, page2_image).await;

    let dispatcher = Dispatcher::new(state.clone());
    for _ in 0..4 {
        dispatcher.run_cycle().await;
        if submits_of(&mock, "__w13-tl-p2") > 0 {
            break;
        }
    }

    assert_eq!(
        submits_of(&mock, "__w13-tl-p2"),
        1,
        "page 1 being unfinished is irrelevant when the chapter injects no context"
    );

    cleanup_w13(&pool).await;
}

/// AUDIT-W13 review. Uploading the same file twice into one chapter is a supported path:
/// `upload_page` appends a second page at `max+1` pointing at the *existing* image row. So one
/// `image_id` can belong to two pages of the same chapter — and the first cut of this gate joined
/// blockers through `image_id`, which made the later page's own job match the earlier page,
/// satisfy `prev.page_number < me.page_number`, and block itself forever.
#[tokio::test]
async fn a_page_sharing_its_image_with_an_earlier_page_does_not_block_itself() {
    let _guard = SERIAL.lock().await;
    let mock = MockState::default();
    *mock.capabilities_body.lock().unwrap() = json!({
        "max_concurrent_jobs": 4,
        "active_jobs": 0,
        "max_heavy_slots": 2,
        "active_heavy_jobs": 0,
        "max_light_slots": 2,
        "active_light_jobs": 0,
    });
    *mock.responses.lock().unwrap() = [("*".to_string(), 202u16)].into_iter().collect();
    let url = mock_server(mock.clone()).await;
    let Some((pool, redis, state)) = app_with_mock(&url).await else {
        eprintln!("skipping: JOBS_E2E_DATABASE_URL / REDIS_TEST_ADDR not set");
        return;
    };
    redis.set_queue_paused(false).await.expect("resume");

    cleanup_w13(&pool).await;
    let series_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language) \
         VALUES ($1, now(), now(), '__w13-e2e-series__', 'rightToLeft', 'ja')",
    )
    .bind(series_id)
    .execute(&pool)
    .await
    .expect("series");

    let chapter_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO chapters (id, chapter_number, created_at, updated_at, use_context_memory, series_id) \
         VALUES ($1, 1, now(), now(), TRUE, $2)",
    )
    .bind(chapter_id)
    .bind(series_id)
    .execute(&pool)
    .await
    .expect("chapter");

    // One image, two pages — exactly what the duplicate-upload path produces.
    let shared_image = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO images (id, created_at, filename, storage_path, hash, width, height) \
         VALUES ($1, now(), 'dupe.png', 'originals/dupe.png', 'hash-w13-dupe', 64, 64)",
    )
    .bind(shared_image)
    .execute(&pool)
    .await
    .expect("image");

    let mut page_ids = Vec::new();
    for page_number in 1..=2i32 {
        let page_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO pages (id, page_number, chapter_id, image_id) VALUES ($1, $2, $3, $4)",
        )
        .bind(page_id)
        .bind(page_number)
        .bind(chapter_id)
        .bind(shared_image)
        .execute(&pool)
        .await
        .expect("page");
        page_ids.push(page_id);
    }

    // Nothing is outstanding for page 1 — page 2's own job is the only row in play.
    queue_page_two_translation(&redis, &pool, page_ids[1], shared_image).await;

    let dispatcher = Dispatcher::new(state.clone());
    for _ in 0..4 {
        dispatcher.run_cycle().await;
        if submits_of(&mock, "__w13-tl-p2") > 0 {
            break;
        }
    }

    assert_eq!(
        submits_of(&mock, "__w13-tl-p2"),
        1,
        "a page must not count itself as its own predecessor just because it reuses an image"
    );

    cleanup_w13(&pool).await;
}

/// AUDIT-W13 review. A job is inserted PENDING and pushed onto its queue as two separate steps.
/// If the push fails, the row stays PENDING with nothing to pick it up — `recover_stale_processing_jobs`
/// only looks at PROCESSING, and `requeue_pending_jobs` only runs at startup or on resume. That hole
/// predates the ordering gate, but the gate turns "one page never finishes" into "every later page
/// of the chapter waits behind it, indefinitely".
#[tokio::test]
async fn a_pending_job_that_never_reached_redis_is_put_back_on_its_queue() {
    let _guard = SERIAL.lock().await;
    let Some((pool, redis, state)) = app_with_mock("http://127.0.0.1:1").await else {
        eprintln!("skipping: JOBS_E2E_DATABASE_URL / REDIS_TEST_ADDR not set");
        return;
    };
    redis.set_queue_paused(false).await.expect("resume");

    let on_queue = async |id: &str| {
        redis
            .list_range("queue:ocr")
            .await
            .unwrap_or_default()
            .iter()
            .filter(|entry| {
                serde_json::from_str::<Value>(entry)
                    .ok()
                    .and_then(|v| v.get("jobId").and_then(|j| j.as_str()).map(str::to_string))
                    .as_deref()
                    == Some(id)
            })
            .count()
    };

    for id in ["__orphan-lost", "__orphan-queued", "__orphan-inflight"] {
        let _ = sqlx::query("DELETE FROM jobs WHERE id = $1")
            .bind(id)
            .execute(&pool)
            .await;
    }

    // Three PENDING rows, all older than the grace period, differing only in what should happen.
    for (id, started) in [
        ("__orphan-lost", false),
        ("__orphan-queued", false),
        ("__orphan-inflight", true),
    ] {
        sqlx::query(
            "INSERT INTO jobs (id, type, status, payload, started_at, created_at, updated_at) \
             VALUES ($1, 'ocr', 'PENDING', $2, CASE WHEN $3 THEN now() ELSE NULL END, \
                     now() - interval '10 minutes', now() - interval '10 minutes')",
        )
        .bind(id)
        .bind(json!({ "jobId": id }).to_string())
        .bind(started)
        .execute(&pool)
        .await
        .expect("seed pending job");
    }

    // Only this one is actually on the queue.
    redis
        .push_to_queue(
            "queue:ocr",
            &json!({ "jobId": "__orphan-queued" }).to_string(),
        )
        .await
        .expect("push");

    manga_backend::jobs::recovery::requeue_orphaned_pending_jobs(&state).await;

    assert_eq!(
        on_queue("__orphan-lost").await,
        1,
        "a PENDING row on no queue is put back on one"
    );
    assert_eq!(
        on_queue("__orphan-queued").await,
        1,
        "a row already queued is not duplicated"
    );
    assert_eq!(
        on_queue("__orphan-inflight").await,
        0,
        "started_at means the dispatcher already handed it to a worker — not orphaned"
    );

    for id in ["__orphan-lost", "__orphan-queued", "__orphan-inflight"] {
        let _ = sqlx::query("DELETE FROM jobs WHERE id = $1")
            .bind(id)
            .execute(&pool)
            .await;
    }
    while redis
        .pop_from_queue("queue:ocr")
        .await
        .unwrap_or(None)
        .is_some()
    {}
}
