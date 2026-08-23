//! End-to-end coverage of the SSE surface (`POST /api/notifications/ticket`,
//! `GET /api/notifications/stream`) plus service-level behaviour of the SseService
//! port: pending-notification replay, multi-tab delivery and disconnect cleanup.
//!
//! Requires a REAL Postgres (SPRING_DATASOURCE_*) and Valkey (REDIS_TEST_ADDR);
//! skipped otherwise, like the other integration suites.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use futures_util::StreamExt;
use tower::ServiceExt;

use manga_backend::config::{DatabaseConfig, MinioConfig};
use manga_backend::db;
use manga_backend::jwt::JwtUtils;
use manga_backend::minio::MinioService;
use manga_backend::redis_service::RedisService;
use manga_backend::sse::SseService;
use manga_backend::state::AppState;

const SECRET: &str = "test-secret-long-enough-for-hmac-signing-1234567890";
const READ_WINDOW: Duration = Duration::from_secs(5);

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

async fn redis_from_env() -> Option<Arc<RedisService>> {
    let addr = std::env::var("REDIS_TEST_ADDR").ok()?;
    let (host, port) = addr.split_once(':')?;
    let port = port.parse().expect("numeric REDIS_TEST_ADDR port");
    RedisService::connect(host, port).await.ok().map(Arc::new)
}

struct Ctx {
    router: Router,
    pool: sqlx::PgPool,
    redis: Arc<RedisService>,
    sse: Arc<SseService>,
    jwt: JwtUtils,
    email: String,
    user_id: uuid::Uuid,
}

async fn setup(test_suffix: &str) -> Option<Ctx> {
    let pool = db::connect(&db_config_from_env()?).await.ok()?;
    let redis = redis_from_env().await?;

    // Unique probe user per test: parallel suites must not fight over rows.
    let email = format!("__sse-e2e-{test_suffix}@example.invalid");
    sqlx::query("DELETE FROM users WHERE email = $1")
        .bind(&email)
        .execute(&pool)
        .await
        .expect("probe pre-clean");
    let (user_id,) = sqlx::query_as::<_, (uuid::Uuid,)>(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
             VALUES (uuid_generate_v4(), now(), 'SSE E2E', $1, 'mock', 'admin') RETURNING id",
    )
    .bind(&email)
    .fetch_one(&pool)
    .await
    .expect("probe user");

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
        minio: MinioConfig {
            endpoint: "http://localhost:9000".into(),
            external_url: None,
            access_key: Some("minioadmin".into()),
            secret_key: Some("minioadmin".into()),
        },
        redis: manga_backend::config::RedisConfig {
            host: "localhost".into(),
            port: 6379,
        },
    };
    let jwt = JwtUtils::new(SECRET.into(), 3_600_000);
    let storage = MinioService::new(&MinioConfig {
        endpoint: "http://localhost:9000".into(),
        external_url: None,
        access_key: Some("minioadmin".into()),
        secret_key: Some("minioadmin".into()),
    });
    let state = AppState::new(
        config,
        pool.clone(),
        JwtUtils::new(SECRET.into(), 3_600_000),
        storage,
        Some(redis.clone()),
    );
    let sse = state.sse.clone();
    let router = manga_backend::routes::build_router(state);

    Some(Ctx {
        router,
        pool,
        redis,
        sse,
        jwt,
        email,
        user_id,
    })
}

impl Drop for Ctx {
    fn drop(&mut self) {
        let pool = self.pool.clone();
        let email = self.email.clone();
        tokio::spawn(async move {
            let _ = sqlx::query("DELETE FROM users WHERE email = $1")
                .bind(email)
                .execute(&pool)
                .await;
        });
    }
}

impl Ctx {
    fn token(&self) -> String {
        self.jwt.generate_token(&self.email).expect("token mint")
    }

    /// POST /api/notifications/ticket with the probe's Authorization header.
    async fn request_ticket(&self) -> String {
        let response = self
            .router
            .clone()
            .oneshot(
                Request::post("/tlhub/api/notifications/ticket")
                    .header("Authorization", format!("Bearer {}", self.token()))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = http_body_util::BodyExt::collect(response.into_body())
            .await
            .unwrap()
            .to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        json["ticket"].as_str().expect("ticket field").to_string()
    }
}

/// Reads SSE frames until `predicate` matches or the read window closes; returns
/// (status, content-type, accumulated text).
async fn read_stream_response(
    response: axum::http::Response<Body>,
    predicate: impl Fn(&str) -> bool,
) -> (StatusCode, String, String) {
    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let mut stream = response.into_body().into_data_stream();
    let mut text = String::new();
    let _ = tokio::time::timeout(READ_WINDOW, async {
        while let Some(chunk) = stream.next().await {
            if let Ok(bytes) = chunk {
                text.push_str(&String::from_utf8_lossy(&bytes));
            }
            if predicate(&text) {
                break;
            }
        }
    })
    .await;
    (status, content_type, text)
}

async fn get_stream(router: &Router, uri: &str) -> axum::http::Response<Body> {
    router
        .clone()
        .oneshot(Request::get(uri).body(Body::empty()).unwrap())
        .await
        .unwrap()
}

async fn wait_for(condition: impl Fn() -> bool, limit: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        if condition() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return condition();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// ---------------------------------------------------------------------------
// Ticket endpoint + redemption
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ticket_endpoint_requires_authentication() {
    let Some(ctx) = setup("noauth").await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let response = ctx
        .router
        .clone()
        .oneshot(
            Request::post("/tlhub/api/notifications/ticket")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(response.headers()["content-type"], "application/json");
    let bytes = http_body_util::BodyExt::collect(response.into_body())
        .await
        .unwrap()
        .to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(json["status"], 403);
    assert_eq!(json["error"], "Forbidden");
    assert_eq!(json["path"], "/tlhub/api/notifications/ticket");
}

#[tokio::test]
async fn issues_a_distinct_ticket_per_request() {
    let Some(ctx) = setup("distinct").await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let first = ctx.request_ticket().await;
    let second = ctx.request_ticket().await;
    assert_ne!(first, second);
    assert!(first.len() >= 32, "ticket should not be guessable: {first}");
}

#[tokio::test]
async fn ticket_redeems_to_the_issuing_user_exactly_once() {
    let Some(ctx) = setup("redeem").await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let tickets = ctx
        .sse
        .tickets()
        .expect("ticket service present with redis");
    let ticket = tickets.issue(ctx.user_id, None).await.unwrap();

    let redeemed = tickets.redeem(&ticket).await.unwrap().expect("first use");
    assert_eq!(redeemed.user_id, ctx.user_id);
    assert!(redeemed.session_expires_at.is_none());

    // Single use: a ticket recovered from a log after the connection opened is spent.
    assert!(tickets.redeem(&ticket).await.unwrap().is_none());
}

#[tokio::test]
async fn issued_ticket_carries_the_expiry_of_the_presented_jwt() {
    let Some(ctx) = setup("expiry").await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let token = ctx.token();
    let response = ctx
        .router
        .clone()
        .oneshot(
            Request::post("/tlhub/api/notifications/ticket")
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let bytes = http_body_util::BodyExt::collect(response.into_body())
        .await
        .unwrap()
        .to_bytes();
    let ticket: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let ticket = ticket["ticket"].as_str().unwrap();

    let redeemed = ctx
        .sse
        .tickets()
        .unwrap()
        .redeem(ticket)
        .await
        .unwrap()
        .expect("redeemable");
    // The POST is the only point in the handshake where the JWT is visible; if exp
    // stops riding along, the session-expired push silently never arms.
    assert_eq!(
        redeemed.session_expires_at.map(|t| t.timestamp_millis()),
        ctx.jwt
            .expiry_from_token(&token)
            .map(|t| t.timestamp_millis())
    );
}

#[tokio::test]
async fn legacy_shaped_and_garbage_tickets_behave_like_java() {
    let Some(ctx) = setup("legacy").await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let tickets = ctx.sse.tickets().unwrap();

    // The stored shape before AUDIT-F7: bare user id, no expiry — still redeemable.
    ctx.redis
        .set_ex("sse:ticket:manual-legacy", &ctx.user_id.to_string(), 60)
        .await
        .unwrap();
    let redeemed = tickets.redeem("manual-legacy").await.unwrap().unwrap();
    assert_eq!(redeemed.user_id, ctx.user_id);
    assert!(redeemed.session_expires_at.is_none());

    for bogus in ["", "   ", "not-a-real-ticket"] {
        assert!(tickets.redeem(bogus).await.unwrap().is_none(), "{bogus:?}");
    }
}

// ---------------------------------------------------------------------------
// Stream endpoint
// ---------------------------------------------------------------------------

#[tokio::test]
async fn stream_accepts_a_valid_ticket() {
    let Some(ctx) = setup("stream-ok").await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let ticket = ctx.request_ticket().await;
    let response = get_stream(
        &ctx.router,
        &format!("/tlhub/api/notifications/stream?ticket={ticket}"),
    )
    .await;
    let (status, content_type, text) =
        read_stream_response(response, |t| t.contains("connected")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        content_type.starts_with("text/event-stream"),
        "{content_type}"
    );
    assert!(text.contains("event: connected"), "{text}");
    assert!(text.contains("data: SSE Connection Established"), "{text}");
}

#[tokio::test]
async fn stream_rejects_invalid_reused_tickets_and_query_tokens() {
    let Some(ctx) = setup("stream-bad").await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };

    // Bogus ticket → security 403 shape.
    let response = get_stream(
        &ctx.router,
        "/tlhub/api/notifications/stream?ticket=bogus-ticket",
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // A valid ticket works once...
    let ticket = ctx.request_ticket().await;
    let first = get_stream(
        &ctx.router,
        &format!("/tlhub/api/notifications/stream?ticket={ticket}"),
    )
    .await;
    let (status, _, _) = read_stream_response(first, |t| t.contains("connected")).await;
    assert_eq!(status, StatusCode::OK);

    // ...and never twice.
    let reused = get_stream(
        &ctx.router,
        &format!("/tlhub/api/notifications/stream?ticket={ticket}"),
    )
    .await;
    assert_eq!(reused.status(), StatusCode::FORBIDDEN);

    // Session JWT in the query string buys nothing (JwtAuthFilter reads headers only).
    let query_token = get_stream(
        &ctx.router,
        &format!("/tlhub/api/notifications/stream?token={}", ctx.token()),
    )
    .await;
    assert_eq!(query_token.status(), StatusCode::FORBIDDEN);

    // No credential at all → same denial.
    let anonymous = get_stream(&ctx.router, "/tlhub/api/notifications/stream").await;
    assert_eq!(anonymous.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn stream_works_with_a_plain_authorization_header_too() {
    let Some(ctx) = setup("stream-header").await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    // Java kept the header path working for non-EventSource clients; keep it.
    let response = ctx
        .router
        .clone()
        .oneshot(
            Request::get("/tlhub/api/notifications/stream")
                .header("Authorization", format!("Bearer {}", ctx.token()))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let (status, _, text) = read_stream_response(response, |t| t.contains("connected")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(text.contains("event: connected"), "{text}");
}

// ---------------------------------------------------------------------------
// SseService behaviour (service level, no HTTP)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pending_notifications_are_replayed_once_then_delivered_live() {
    let Some(ctx) = setup("replay").await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let queue_key = format!("notifications:user:{}", ctx.user_id);

    // Two notifications arrive while nobody is connected: they must wait in Redis.
    ctx.sse
        .emit_notification_to_user(ctx.user_id, "info", "One", "first")
        .await;
    ctx.sse
        .emit_notification_to_user(ctx.user_id, "info", "Two", "second")
        .await;
    assert_eq!(ctx.redis.queue_size(&queue_key).await.unwrap(), 2);

    // Subscribing replays them right after the connected event...
    let mut rx = ctx.sse.open_connection(ctx.user_id, None).await;
    let mut names = Vec::new();
    for _ in 0..3 {
        let message = tokio::time::timeout(READ_WINDOW, rx.recv())
            .await
            .expect("frame within window")
            .expect("channel alive");
        names.push((message.event, message.data));
    }
    assert_eq!(names[0].0, "connected");
    assert_eq!(names[1].0, "notification");
    assert!(names[1].1.contains("\"title\":\"One\""), "{:?}", names[1]);
    assert_eq!(names[2].0, "notification");
    assert!(names[2].1.contains("\"title\":\"Two\""), "{:?}", names[2]);

    // ...and the drain moved them out of the queue entirely.
    assert_eq!(ctx.redis.queue_size(&queue_key).await.unwrap(), 0);

    // Now a live emit goes straight to the open tab and is NOT re-queued.
    ctx.sse
        .emit_notification_to_user(ctx.user_id, "info", "Live", "third")
        .await;
    let live = tokio::time::timeout(READ_WINDOW, rx.recv())
        .await
        .expect("live frame within window")
        .expect("channel alive");
    assert_eq!(live.event, "notification");
    assert!(live.data.contains("\"title\":\"Live\""));
    assert_eq!(ctx.redis.queue_size(&queue_key).await.unwrap(), 0);
}

#[tokio::test]
async fn second_tab_does_not_evict_the_first_and_closes_clean_up() {
    let Some(ctx) = setup("multitab").await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let mut tab_one = ctx.sse.open_connection(ctx.user_id, None).await;
    let mut tab_two = ctx.sse.open_connection(ctx.user_id, None).await;
    assert_eq!(ctx.sse.connection_count(ctx.user_id), 2);

    ctx.sse
        .emit_event_to_user(ctx.user_id, "job_update", r#"{"id":"j1"}"#);

    for tab in [&mut tab_one, &mut tab_two] {
        // First frame per tab was "connected"; the job_update reaches BOTH tabs.
        let mut got_update = false;
        while !got_update {
            let message = tokio::time::timeout(Duration::from_secs(2), tab.recv())
                .await
                .expect("frame within window")
                .expect("channel alive");
            got_update = message.event == "job_update";
        }
    }

    // Closing one tab leaves the other connected...
    drop(tab_one);
    assert!(
        wait_for(
            || ctx.sse.connection_count(ctx.user_id) == 1,
            Duration::from_secs(2)
        )
        .await
    );
    let still_open = tokio::time::timeout(Duration::from_secs(2), tab_two.recv()).await;
    assert!(
        still_open.is_err(),
        "closed tab must not end the other stream (recv timed out = stream alive)"
    );

    // ...and closing the last one empties the registry entry.
    drop(tab_two);
    assert!(
        wait_for(
            || ctx.sse.connection_count(ctx.user_id) == 0,
            Duration::from_secs(2)
        )
        .await
    );
}
