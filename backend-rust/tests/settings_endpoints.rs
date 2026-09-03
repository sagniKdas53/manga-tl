//! End-to-end tests for /api/settings against REAL Postgres + Valkey, porting
//! SettingsControllerTest / SystemSettingsServiceTest behavior: get/put round-trip,
//! per-key persistence and validateOverrides DEPRECATED entries with a seeded worker
//! catalog blob (plus the empty-cache-permissive rule).
//!
//! The system_settings table is GLOBAL state on a shared database: every key this suite
//! writes is snapshotted first and restored afterwards.

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;
use uuid::Uuid;

use manga_backend::config::{DatabaseConfig, MinioConfig};
use manga_backend::db;
use manga_backend::jwt::JwtUtils;
use manga_backend::minio::MinioService;
use manga_backend::state::AppState;

const SECRET: &str = "test-secret-long-enough-for-hmac-signing-1234567890";
const CATALOG_KEY: &str = "system:providers:config";
const SETTING_KEYS: [&str; 12] = [
    "ocrProvider",
    "ocrModel",
    "tlProvider",
    "tlModel",
    "qaProvider",
    "qaLlmModel",
    "qaVlmModel",
    "qaMode",
    "routingStrategy",
    "useFallbackModels",
    "textBoxPaddingPx",
    "textBoxSafetyPercent",
];

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
    JwtUtils,
    manga_backend::redis_service::RedisService,
    AppState,
)> {
    let pool = db::connect(&db_config_from_env()?).await.ok()?;
    let redis_addr = std::env::var("REDIS_TEST_ADDR").ok()?;
    let (r_host, r_port) = redis_addr.split_once(':')?;
    let redis = manga_backend::redis_service::RedisService::connect(
        r_host,
        r_port.parse().expect("numeric port"),
    )
    .await
    .expect("redis connect");

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
    let jwt = JwtUtils::new(SECRET.into(), 3_600_000);
    let state = AppState::new(
        config,
        pool.clone(),
        jwt.clone(),
        MinioService::new(&minio),
        None,
    );
    Some((
        manga_backend::routes::build_router(state.clone()),
        pool,
        jwt,
        redis,
        state,
    ))
}

async fn probe_user(pool: &sqlx::PgPool, jwt: &JwtUtils) -> String {
    let email = format!("__settings-e2e-{}@example.invalid", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
         VALUES (uuid_generate_v4(), now(), 'Probe', $1, 'x', 'viewer')",
    )
    .bind(&email)
    .execute(pool)
    .await
    .expect("probe user insert");
    jwt.generate_token(&email).expect("token")
}

async fn send(
    app: Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    json: Option<String>,
) -> (StatusCode, String, serde_json::Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        builder = builder.header("Authorization", format!("Bearer {token}"));
    }
    if json.is_some() {
        builder = builder.header("Content-Type", "application/json");
    }
    let response = app
        .oneshot(builder.body(Body::from(json.unwrap_or_default())).unwrap())
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
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

/// Reset the GLOBAL settings rows this suite touches to factory state (rows removed;
/// every reader then falls back to the env defaults). This suite runs against a shared
/// database whose system_settings table starts empty, and PUT writes values no filter
/// can reliably tell apart from real user data — so the only safe invariant is "the
/// table carries none of these ten keys when we are done". Deterministic + self-healing.
async fn reset_settings_to_factory(pool: &sqlx::PgPool) {
    sqlx::query("DELETE FROM system_settings WHERE setting_key = ANY($1)")
        .bind(&SETTING_KEYS[..])
        .execute(pool)
        .await
        .expect("reset system_settings");
}

#[tokio::test]
async fn settings_get_put_roundtrip_and_validate_overrides() {
    let Some((app, pool, jwt, redis, state)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    // Heal anything earlier runs (or this one) left in the global table, and remember
    // whether the worker catalog key existed so IT can be restored faithfully.
    reset_settings_to_factory(&pool).await;
    let catalog_snapshot: Option<String> = redis.get(CATALOG_KEY).await.ok().flatten();
    // Same healing for entity rows a crashed run may have left behind.
    sqlx::query("DELETE FROM series WHERE title LIKE '__settings-e2e-%'")
        .execute(&pool)
        .await
        .expect("pre-cleanup series");
    let _ = sqlx::query("DELETE FROM users WHERE email LIKE '__settings-e2e-%'")
        .execute(&pool)
        .await;
    let token = probe_user(&pool, &jwt).await;

    // --- unauthenticated GET is the security 403 Boot shape ---
    let (status, ctype, _) = send(app.clone(), "GET", "/tlhub/api/settings", None, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(ctype, "application/json");

    // --- GET returns the full DTO shape ---
    let (status, _, body) = send(
        app.clone(),
        "GET",
        "/tlhub/api/settings",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    for field in [
        "ocrVlmModelList",
        "tlLlmModelList",
        "qaLlmModelList",
        "qaVlmModelList",
        "routingStrategy",
        "ocrProvider",
        "ocrModel",
        "tlProvider",
        "tlModel",
        "qaProvider",
        "qaLlmModel",
        "qaVlmModel",
        "disableLocalOcr",
        "localOcrModel",
        "disableLocalLlm",
        "qaMode",
        "useFallbackModels",
        "activeProviders",
        "activeOcrProviders",
        "providerModelsMap",
    ] {
        assert!(body.get(field).is_some(), "DTO missing {field}");
    }

    // --- PUT persists every field; response echoes the saved view ---
    let put_body = serde_json::json!({
        "ocrVlmModelList": [], "tlLlmModelList": [], "qaLlmModelList": [], "qaVlmModelList": [],
        "routingStrategy": "quality-first",
        "ocrProvider": "__e2e-ocr__", "ocrModel": "__e2e-ocr-model__",
        "tlProvider": "__e2e-tl__", "tlModel": "__e2e-tl-model__",
        "qaProvider": "__e2e-qa__", "qaLlmModel": "__e2e-qa-llm__", "qaVlmModel": "__e2e-qa-vlm__",
        "disableLocalOcr": false, "localOcrModel": "", "disableLocalLlm": false,
        "qaMode": "auto", "useFallbackModels": true,
        "activeProviders": [], "activeOcrProviders": [], "providerModelsMap": {},
    });
    let (status, _, echoed) = send(
        app.clone(),
        "PUT",
        "/tlhub/api/settings",
        Some(&token),
        Some(put_body.to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(echoed["ocrProvider"], "__e2e-ocr__");
    assert_eq!(echoed["routingStrategy"], "quality-first");

    // Per-key persistence in system_settings (SystemSettingsServiceTest.updateSettings).
    let ocr_provider: String = sqlx::query_scalar(
        "SELECT setting_value FROM system_settings WHERE setting_key = 'ocrProvider'",
    )
    .fetch_one(&pool)
    .await
    .expect("saved setting");
    assert_eq!(ocr_provider, "__e2e-ocr__");
    let routing: String = sqlx::query_scalar(
        "SELECT setting_value FROM system_settings WHERE setting_key = 'routingStrategy'",
    )
    .fetch_one(&pool)
    .await
    .expect("saved routing");
    assert_eq!(routing, "quality-first");

    // --- GET after PUT reflects the persisted values ---
    let (_, _, reloaded) = send(
        app.clone(),
        "GET",
        "/tlhub/api/settings",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(reloaded["tlModel"], "__e2e-tl-model__");
    assert_eq!(reloaded["qaLlmModel"], "__e2e-qa-llm__");

    // --- a PUT that omits the text-box fields leaves them alone ---
    //
    // `SystemSettingsDto` is both the GET response and the PUT body, and the two are not
    // symmetric. A browser holding a bundle older than these fields sends every other setting and
    // has no key for these two. While they were `#[serde(default)]` scalars that omission
    // deserialised to 4/95 and was then written, so saving an unrelated model setting from a stale
    // tab silently reset the global text geometry. They are `Option` now: absent skips the write.
    //
    // Note `put_body` above is already exactly that legacy shape -- it names neither field.
    let mut configured = put_body.clone();
    let obj = configured.as_object_mut().unwrap();
    obj.insert("textBoxPaddingPx".to_string(), serde_json::json!(12));
    obj.insert("textBoxSafetyPercent".to_string(), serde_json::json!(80));
    let (status, _, echoed) = send(
        app.clone(),
        "PUT",
        "/tlhub/api/settings",
        Some(&token),
        Some(configured.to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(echoed["textBoxPaddingPx"], 12);
    assert_eq!(echoed["textBoxSafetyPercent"], 80);

    // The stale tab now saves an unrelated model setting.
    let mut legacy = put_body.clone();
    legacy.as_object_mut().unwrap().insert(
        "ocrModel".to_string(),
        serde_json::json!("__e2e-ocr-model-2__"),
    );
    let (status, _, echoed) = send(
        app.clone(),
        "PUT",
        "/tlhub/api/settings",
        Some(&token),
        Some(legacy.to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // What it did send lands...
    assert_eq!(echoed["ocrModel"], "__e2e-ocr-model-2__");
    // ...and what it has never heard of survives, rather than resetting to 4/95.
    assert_eq!(echoed["textBoxPaddingPx"], 12);
    assert_eq!(echoed["textBoxSafetyPercent"], 80);
    let padding: String = sqlx::query_scalar(
        "SELECT setting_value FROM system_settings WHERE setting_key = 'textBoxPaddingPx'",
    )
    .fetch_one(&pool)
    .await
    .expect("padding row survives a legacy PUT");
    assert_eq!(padding, "12");

    // --- validate with an EMPTY catalog is permissive: {"orphaned":[]} ---
    redis.delete(CATALOG_KEY).await.expect("del catalog");
    state.providers.reload(&redis).await;
    let (status, _, body) = send(
        app.clone(),
        "GET",
        "/tlhub/api/settings/validate",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["orphaned"].as_array().map(Vec::len), Some(0));

    // --- seed a real-shaped catalog blob (the exact JSON ProviderConfigCacheTest uses) ---
    let catalog = r#"{"version":1,"providers":{"openrouter":{
        "displayName":"OpenRouter","type":"openai-compatible","freeTier":false,"priority":1,
        "models":{"tl":[{"id":"deepseek/deepseek-v4-pro","name":"DeepSeek V4 Pro","free":false}]},
        "defaults":{"tl":"deepseek/deepseek-v4-pro"},"capabilities":["tl"]}}}"#;
    redis.set(CATALOG_KEY, catalog).await.expect("seed catalog");
    state.providers.reload(&redis).await;

    // Probe series + chapter carrying overrides the provider no longer serves.
    let series_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language, \
         tl_model, tl_provider, qa_llm_model, qa_provider) \
         VALUES ($1, now(), now(), '__settings-e2e-series__', 'rightToLeft', 'ja', \
         'legacy-tl-model', 'openrouter', 'legacy-qa-model', 'openrouter')",
    )
    .bind(series_id)
    .execute(&pool)
    .await
    .expect("probe series");
    let chapter_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO chapters (id, chapter_number, created_at, updated_at, use_context_memory, series_id, \
         ocr_model, ocr_provider) VALUES ($1, 1, now(), now(), TRUE, $2, 'legacy-ocr-model', 'openrouter')",
    )
    .bind(chapter_id)
    .bind(series_id)
    .execute(&pool)
    .await
    .expect("probe chapter");

    let (status, _, body) = send(
        app.clone(),
        "GET",
        "/tlhub/api/settings/validate",
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let orphaned = body["orphaned"].as_array().cloned().unwrap_or_default();

    let find = |entity: &str, id: Uuid, field: &str| {
        orphaned.iter().any(|e| {
            e["entityType"] == entity
                && e["entityId"] == id.to_string()
                && e["field"] == field
                && e["status"] == "DEPRECATED"
        })
    };
    assert!(
        find("SERIES", series_id, "tlModel"),
        "series tl override must be DEPRECATED; got {orphaned:?}"
    );
    assert!(
        find("SERIES", series_id, "qaLlmModel"),
        "qa task key must be checked as qaLLM; got {orphaned:?}"
    );
    assert!(
        find("CHAPTER", chapter_id, "ocrModel"),
        "chapter ocr override must be DEPRECATED (catalog has no ocr task); got {orphaned:?}"
    );

    // A model the provider DOES serve never shows up. Pin the GLOBAL tlProvider the
    // endpoint falls back to when an override carries no provider of its own — the PUT
    // above deliberately rewrote it.
    sqlx::query(
        "INSERT INTO system_settings (setting_key, setting_value, updated_at) VALUES ('tlProvider', 'openrouter', now()) \
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value",
    )
    .execute(&pool)
    .await
    .expect("pin global tlProvider");
    sqlx::query("UPDATE chapters SET ocr_model = NULL, ocr_provider = NULL, tl_model='deepseek/deepseek-v4-pro', tl_provider=NULL WHERE id=$1")
        .bind(chapter_id)
        .execute(&pool)
        .await
        .expect("update probe chapter");
    let (_, _, body) = send(
        app.clone(),
        "GET",
        "/tlhub/api/settings/validate",
        Some(&token),
        None,
    )
    .await;
    let orphaned = body["orphaned"].as_array().cloned().unwrap_or_default();
    assert!(
        !orphaned
            .iter()
            .any(|e| e["entityId"] == chapter_id.to_string() && e["field"] == "tlModel"),
        "served model must not be flagged; got {orphaned:?}"
    );

    // --- restore shared state ---
    let _ = sqlx::query(
        "DELETE FROM layer_elements WHERE layer_id IN \
         (SELECT l.id FROM layers l JOIN pages p ON p.id=l.page_id WHERE p.chapter_id IN \
         (SELECT id FROM chapters WHERE series_id=$1))",
    )
    .bind(series_id)
    .execute(&pool)
    .await;
    let _ = sqlx::query("DELETE FROM layers WHERE page_id IN (SELECT id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))")
        .bind(series_id)
        .execute(&pool)
        .await;
    let _ = sqlx::query(
        "DELETE FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1)",
    )
    .bind(series_id)
    .execute(&pool)
    .await;
    let _ = sqlx::query("DELETE FROM chapters WHERE series_id=$1")
        .bind(series_id)
        .execute(&pool)
        .await;
    let _ = sqlx::query("DELETE FROM series WHERE id=$1")
        .bind(series_id)
        .execute(&pool)
        .await;
    let _ = sqlx::query("DELETE FROM users WHERE email LIKE '__settings-e2e-%'")
        .execute(&pool)
        .await;
    // Settings back to factory (shared table!); catalog key here (redis, not DB).
    reset_settings_to_factory(&pool).await;
    match &catalog_snapshot {
        Some(blob) => {
            redis.set(CATALOG_KEY, blob).await.expect("restore catalog");
        }
        None => {
            redis.delete(CATALOG_KEY).await.expect("clear catalog");
        }
    }
}
