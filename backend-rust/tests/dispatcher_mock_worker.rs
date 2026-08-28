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
