//! JobCoordinatorService flow tests that the endpoint suites cannot reach directly:
//! QA retry-budget exhaustion, hybrid-QA visibility sweep and the reader-mode
//! short-circuit (JobCoordinatorServiceTest additions from the Phase-4 matrix).
//!
//! Requires REAL Postgres + Valkey.

use std::sync::Arc;
use uuid::Uuid;

use manga_backend::config::{DatabaseConfig, MinioConfig};
use manga_backend::db;
use manga_backend::jwt::JwtUtils;
use manga_backend::minio::MinioService;
use manga_backend::redis_service::RedisService;
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

async fn app() -> Option<(sqlx::PgPool, Arc<RedisService>, AppState)> {
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
    Some((pool, redis, state))
}

/// Seeds series → chapter → page → image; series languages configurable.
async fn seed_pipeline(
    pool: &sqlx::PgPool,
    source_language: Option<&str>,
    target_language: Option<&str>,
) -> (Uuid, Uuid, Uuid, Uuid) {
    let series_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language, source_language, target_language) \
         VALUES ($1, now(), now(), 'Coordinator E2E', 'rightToLeft', $2, $3, $4)",
    )
    .bind(series_id)
    .bind(source_language.unwrap_or("ja"))
    .bind(source_language)
    .bind(target_language)
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
         VALUES ($1, now(), 'coord.png', 'originals/coord.png', 'hash-coord', 64, 64)",
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

#[tokio::test]
async fn qa_retry_budget_exhaustion_completes_without_retranslate() {
    let Some((pool, redis, state)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR not set");
        return;
    };
    let (series_id, _chapter_id, page_id, image_id) =
        seed_pipeline(&pool, Some("ja"), Some("en")).await;

    // Budget already spent: two retries on record.
    redis
        .set(&format!("page:qa:retries:{page_id}"), "2")
        .await
        .expect("seed retry counter");

    // A failed QA verdict WITHOUT manual intervention asks for a retry.
    let result = manga_backend::jobs::coordinator::handle_qa_callback(
        &state,
        None,
        image_id,
        Some(page_id),
        &[serde_json::json!({
            "regionId": Uuid::new_v4().to_string(),
            "qaStatus": "failed",
            "qaScore": 0.2,
        })],
        None,
    )
    .await
    .expect("qa callback handled");

    assert_eq!(
        result, "COMPLETED",
        "exhausted budget completes the pipeline"
    );

    // No retranslation job was enqueued for this image.
    let translations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE image_id=$1 AND type='translation'")
            .bind(image_id)
            .fetch_one(&pool)
            .await
            .unwrap_or(0);
    assert_eq!(translations, 0, "budget exhausted -> no translation retry");

    // Counter cleared with the pipeline.
    let counter = redis
        .get(&format!("page:qa:retries:{page_id}"))
        .await
        .unwrap();
    assert!(counter.is_none(), "retry counter reset after completion");

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn qa_retry_within_budget_retranslates() {
    let Some((pool, redis, state)) = app().await else {
        return;
    };
    let (series_id, _chapter_id, page_id, image_id) =
        seed_pipeline(&pool, Some("ja"), Some("en")).await;

    // Fresh budget (no key): a plain failure must RETRY via translation.
    let result = manga_backend::jobs::coordinator::handle_qa_callback(
        &state,
        None,
        image_id,
        Some(page_id),
        &[serde_json::json!({
            "regionId": Uuid::new_v4().to_string(),
            "qaStatus": "failed",
            "qaScore": 0.3,
        })],
        None,
    )
    .await
    .expect("qa callback handled");
    assert_eq!(result, "RETRIED");

    let translations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE image_id=$1 AND type='translation'")
            .bind(image_id)
            .fetch_one(&pool)
            .await
            .unwrap_or(0);
    assert_eq!(
        translations, 1,
        "in-budget failure triggers one translation job"
    );
    let counter: String = redis
        .get(&format!("page:qa:retries:{page_id}"))
        .await
        .unwrap()
        .expect("counter incremented");
    assert_eq!(counter, "1", "retry recorded");

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn hybrid_prepare_visibility_sweep() {
    let Some((pool, _redis, state)) = app().await else {
        return;
    };
    let (series_id, _chapter_id, page_id, image_id) =
        seed_pipeline(&pool, Some("ja"), Some("en")).await;

    async fn insert_layer(
        pool: &sqlx::PgPool,
        z: i32,
        ltype: &str,
        visible: bool,
        page_id: Uuid,
    ) -> Uuid {
        sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO layers (id, created_at, type, visible, z_order, page_id) \
             VALUES (uuid_generate_v4(), now(), $1, $2, $3, $4) RETURNING id",
        )
        .bind(ltype)
        .bind(visible)
        .bind(z)
        .bind(page_id)
        .fetch_one(pool)
        .await
        .expect("layer insert")
    }
    // Older translation (visible), newest translation (visible), OCR (visible), SFX (hidden).
    let old_tl = insert_layer(&pool, 1, "translation", true, page_id).await;
    let new_tl = insert_layer(&pool, 2, "translation", true, page_id).await;
    let ocr_layer = insert_layer(&pool, 1, "ocr", true, page_id).await;
    let sfx = insert_layer(&pool, 1, "sfx", false, page_id).await;

    // One region so reject_sfx has something to act on.
    let region_id: Uuid = sqlx::query_scalar(
        "INSERT INTO ocr_regions (id, bbox_x, bbox_y, bbox_w, bbox_h, detected_language, text, page_id) \
         VALUES (uuid_generate_v4(), 0, 0, 10, 10, 'ja', 'hey', $1) RETURNING id",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .expect("region");
    sqlx::query(
        "INSERT INTO layer_elements (id, text, size, font, font_style, font_weight, x, y, auto_size, word_wrap, overflow, visible, is_manually_edited, box_shape, max_width, max_height, rotation, layer_id, region_id) \
         VALUES (uuid_generate_v4(), '', 16.0, 'f', 'normal', 'normal', 0.0, 0.0, FALSE, FALSE, FALSE, TRUE, FALSE, 'rectangular', 10, 10, 0.0, $1, $2)",
    )
    .bind(new_tl)
    .bind(region_id)
    .execute(&pool)
    .await
    .expect("element in new tl");

    manga_backend::jobs::coordinator::prepare_hybrid_qa(&state, image_id, Some(page_id), &[])
        .await
        .expect("hybrid prepare runs");

    let visibility = |id: Uuid| {
        sqlx::query_scalar::<_, bool>("SELECT COALESCE(visible, TRUE) FROM layers WHERE id=$1")
            .bind(id)
            .fetch_one(&pool)
    };
    // Newest translation stays visible; older ones become history.
    assert!(
        visibility(new_tl).await.unwrap(),
        "newest translation visible"
    );
    assert!(
        !visibility(old_tl).await.unwrap(),
        "older translation hidden"
    );
    assert!(!visibility(ocr_layer).await.unwrap(), "ocr layer hidden");
    assert!(visibility(sfx).await.unwrap(), "sfx forced visible");

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn reader_mode_short_circuits_after_layout() {
    let Some((pool, _redis, state)) = app().await else {
        return;
    };
    // Reader mode == source language equals target language.
    let (series_id, _chapter_id, page_id, image_id) =
        seed_pipeline(&pool, Some("en"), Some("en")).await;

    manga_backend::jobs::coordinator::handle_layout_callback(
        &state,
        None,
        image_id,
        Some(page_id),
        &serde_json::json!({ "panels": [] }),
    )
    .await
    .expect("layout callback handled");

    let downstream: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM jobs WHERE image_id=$1 AND type IN ('translation','render','qa')",
    )
    .bind(image_id)
    .fetch_one(&pool)
    .await
    .unwrap_or(0);
    assert_eq!(
        downstream, 0,
        "reader mode must not enqueue translation/render/qa"
    );

    cleanup_series(&pool, series_id).await;
}
