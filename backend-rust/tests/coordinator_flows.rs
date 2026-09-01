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
async fn callback_claim_does_not_consume_another_images_job() {
    let Some((pool, _redis, _state)) = app().await else {
        return;
    };
    let (series_id, _chapter_id, _page_id, current_image) =
        seed_pipeline(&pool, Some("ja"), Some("en")).await;
    let other_image = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO images (id, created_at, filename, storage_path, hash, width, height) \
         VALUES ($1, now(), 'other.png', 'originals/other.png', $2, 64, 64)",
    )
    .bind(other_image)
    .bind(format!("hash-other-{other_image}"))
    .execute(&pool)
    .await
    .expect("other image");
    let job_id = format!("redo-other-{other_image}");
    sqlx::query(
        "INSERT INTO jobs (id, type, status, image_id, attempt, max_attempts, created_at, updated_at) \
         VALUES ($1,'region-redo-tl','PROCESSING',$2,1,3,now(),now())",
    )
    .bind(&job_id)
    .bind(other_image)
    .execute(&pool)
    .await
    .expect("job");

    let mut tx = pool.begin().await.expect("transaction");
    assert!(
        manga_backend::jobs::coordinator::claim_callback_tx(
            &mut tx,
            Some(&job_id),
            current_image,
            "region-redo-tl",
        )
        .await
        .expect("mismatched claim")
    );
    tx.commit().await.expect("commit mismatch");
    let claimed: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT callback_applied_at FROM jobs WHERE id = $1")
            .bind(&job_id)
            .fetch_one(&pool)
            .await
            .expect("claim state");
    assert!(
        claimed.is_none(),
        "another image's job must remain unclaimed"
    );

    let mut tx = pool.begin().await.expect("transaction");
    assert!(
        manga_backend::jobs::coordinator::claim_callback_tx(
            &mut tx,
            Some(&job_id),
            other_image,
            "region-redo-tl",
        )
        .await
        .expect("matching claim")
    );
    tx.commit().await.expect("commit claim");
    let claimed: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT callback_applied_at FROM jobs WHERE id = $1")
            .bind(&job_id)
            .fetch_one(&pool)
            .await
            .expect("claim state");
    assert!(
        claimed.is_some(),
        "the owning image must still be able to claim its job"
    );

    sqlx::query("DELETE FROM jobs WHERE id = $1")
        .bind(&job_id)
        .execute(&pool)
        .await
        .expect("delete job");
    sqlx::query("DELETE FROM images WHERE id = $1")
        .bind(other_image)
        .execute(&pool)
        .await
        .expect("delete image");
    cleanup_series(&pool, series_id).await;
}

async fn insert_translation_version(
    pool: &sqlx::PgPool,
    page_id: Uuid,
    region_id: Uuid,
    z_order: i32,
    text: &str,
    element_visible: bool,
    predecessor: Option<Uuid>,
) -> (Uuid, Uuid) {
    let layer_id = Uuid::new_v4();
    let element_id = Uuid::new_v4();
    let metadata = match predecessor {
        Some(predecessor) => serde_json::json!({
            "layer_name": format!("redo {z_order}"),
            "overlay": true,
            "region_id": region_id.to_string(),
            "superseded_elements": [predecessor.to_string()],
        }),
        None => serde_json::json!({"layer_name": "Translation"}),
    };
    sqlx::query(
        "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, created_at) \
         VALUES ($1,'translation','en',TRUE,$2,$3,$4,now())",
    )
    .bind(layer_id)
    .bind(z_order)
    .bind(metadata)
    .bind(page_id)
    .execute(pool)
    .await
    .expect("translation layer");
    sqlx::query(
        "INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, layer_id, region_id) \
         VALUES ($1,$2,10,20,100,50,$3,$4,$5)",
    )
    .bind(element_id)
    .bind(text)
    .bind(element_visible)
    .bind(layer_id)
    .bind(region_id)
    .execute(pool)
    .await
    .expect("translation element");
    (layer_id, element_id)
}

#[tokio::test]
async fn full_translation_pass_restores_overlay_predecessors() {
    let Some((pool, _redis, state)) = app().await else {
        return;
    };
    let (series_id, _chapter_id, page_id, image_id) =
        seed_pipeline(&pool, Some("ja"), Some("en")).await;
    let region_id: Uuid = sqlx::query_scalar(
        "INSERT INTO ocr_regions (id, text, translated_text, detected_language, bbox_x, bbox_y, bbox_w, bbox_h, page_id) \
         VALUES (uuid_generate_v4(),'原文','base','ja',10,20,100,50,$1) RETURNING id",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .expect("region");
    let (base_layer, base_element) =
        insert_translation_version(&pool, page_id, region_id, 0, "base", false, None).await;
    let (first_overlay, first_overlay_element) = insert_translation_version(
        &pool,
        page_id,
        region_id,
        1,
        "redo A",
        false,
        Some(base_element),
    )
    .await;
    let (second_overlay, second_overlay_element) = insert_translation_version(
        &pool,
        page_id,
        region_id,
        2,
        "redo B",
        true,
        Some(first_overlay_element),
    )
    .await;

    manga_backend::jobs::coordinator::handle_translation_callback(
        &state,
        None,
        image_id,
        &[serde_json::json!({
            "regionId": region_id.to_string(),
            "pageId": page_id.to_string(),
            "translatedText": "fresh pass",
            "translationFailed": false,
        })],
        None,
    )
    .await
    .expect("translation callback");

    let old_layer_visibility: Vec<(Uuid, Option<bool>)> =
        sqlx::query_as("SELECT id, visible FROM layers WHERE id = ANY($1) ORDER BY id")
            .bind([base_layer, first_overlay, second_overlay])
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(
        old_layer_visibility
            .iter()
            .all(|(_, visible)| *visible == Some(false))
    );
    let old_element_visibility: Vec<(Uuid, Option<bool>)> =
        sqlx::query_as("SELECT id, visible FROM layer_elements WHERE id = ANY($1) ORDER BY id")
            .bind([base_element, first_overlay_element, second_overlay_element])
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(old_element_visibility.contains(&(base_element, Some(true))));
    assert!(old_element_visibility.contains(&(first_overlay_element, Some(true))));
    assert!(old_element_visibility.contains(&(second_overlay_element, Some(true))));

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn qa_direct_fix_edits_only_the_rendered_overlay() {
    let Some((pool, _redis, state)) = app().await else {
        return;
    };
    let (series_id, _chapter_id, page_id, image_id) =
        seed_pipeline(&pool, Some("ja"), Some("en")).await;
    let region_id: Uuid = sqlx::query_scalar(
        "INSERT INTO ocr_regions (id, text, translated_text, detected_language, bbox_x, bbox_y, bbox_w, bbox_h, page_id) \
         VALUES (uuid_generate_v4(),'原文','base','ja',10,20,100,50,$1) RETURNING id",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .expect("region");
    let (_base_layer, base_element) =
        insert_translation_version(&pool, page_id, region_id, 0, "base", false, None).await;
    let (_first_layer, first_element) = insert_translation_version(
        &pool,
        page_id,
        region_id,
        1,
        "redo A",
        false,
        Some(base_element),
    )
    .await;
    let (_second_layer, second_element) = insert_translation_version(
        &pool,
        page_id,
        region_id,
        2,
        "redo B",
        true,
        Some(first_element),
    )
    .await;

    let result = serde_json::json!({
        "regionId": region_id.to_string(),
        "qaStatus": "direct_fix",
        "qaScore": 0.9,
        "directFix": {"correctedText": "normal QA fixed"},
    });
    manga_backend::jobs::coordinator::handle_qa_callback(
        &state,
        None,
        image_id,
        Some(page_id),
        std::slice::from_ref(&result),
        None,
    )
    .await
    .expect("QA callback");

    let texts = |pool: sqlx::PgPool| async move {
        sqlx::query_as::<_, (Uuid, Option<String>)>(
            "SELECT id, text FROM layer_elements WHERE id = ANY($1) ORDER BY id",
        )
        .bind([base_element, first_element, second_element])
        .fetch_all(&pool)
        .await
        .unwrap()
    };
    let after_normal = texts(pool.clone()).await;
    assert!(after_normal.contains(&(base_element, Some("base".into()))));
    assert!(after_normal.contains(&(first_element, Some("redo A".into()))));
    assert!(after_normal.contains(&(second_element, Some("normal QA fixed".into()))));

    sqlx::query("UPDATE layer_elements SET text='redo B' WHERE id=$1")
        .bind(second_element)
        .execute(&pool)
        .await
        .unwrap();
    let hybrid_result = serde_json::json!({
        "regionId": region_id.to_string(),
        "qaStatus": "direct_fix",
        "qaScore": 0.9,
        "directFix": {"correctedText": "hybrid QA fixed"},
    });
    manga_backend::jobs::coordinator::prepare_hybrid_qa(
        &state,
        image_id,
        Some(page_id),
        &[hybrid_result],
    )
    .await
    .expect("hybrid QA prepare");
    let after_hybrid = texts(pool.clone()).await;
    assert!(after_hybrid.contains(&(base_element, Some("base".into()))));
    assert!(after_hybrid.contains(&(first_element, Some("redo A".into()))));
    assert!(after_hybrid.contains(&(second_element, Some("hybrid QA fixed".into()))));

    cleanup_series(&pool, series_id).await;
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

/// A region the worker gave up on must not produce a visible element.
///
/// The worker reports it as translationFailed:true with a null translatedText, having already
/// tried the batch, a retry pass and a per-region fallback. The coordinator read that flag onto
/// ocr_regions but created the layer element with a hardcoded visible=TRUE, so the element kept
/// the region's mask_polygon and no text: it erased the artwork and drew nothing back. That is
/// the "empty bubble" — measured on 40 of 123 corpus pages.
#[tokio::test]
async fn failed_translation_does_not_create_a_visible_masking_element() {
    let Some((pool, _redis, state)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL / REDIS not set");
        return;
    };
    let (series_id, _chapter_id, page_id, image_id) = seed_pipeline(&pool, None, Some("en")).await;

    async fn region(pool: &sqlx::PgPool, page_id: Uuid, text: &str) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO ocr_regions (id, bbox_x, bbox_y, bbox_w, bbox_h, detected_language, text, \
             mask_polygon, region_type, page_id) \
             VALUES (uuid_generate_v4(), 10, 10, 80, 40, 'ja', $1, '[[10,10],[90,10],[90,50],[10,50]]', 'speech', $2) \
             RETURNING id",
        )
        .bind(text)
        .bind(page_id)
        .fetch_one(pool)
        .await
        .expect("region")
    }
    let ok_region = region(&pool, page_id, "こんにちは").await;
    let failed_region = region(&pool, page_id, "違うんです").await;

    let translations = vec![
        serde_json::json!({
            "regionId": ok_region.to_string(),
            "pageId": page_id.to_string(),
            "translatedText": "Hello",
            "translationFailed": false,
        }),
        serde_json::json!({
            "regionId": failed_region.to_string(),
            "pageId": page_id.to_string(),
            "translatedText": null,
            "translationFailed": true,
        }),
    ];

    manga_backend::jobs::coordinator::handle_translation_callback(
        &state,
        None,
        image_id,
        &translations,
        None,
    )
    .await
    .expect("translation callback");

    // mask_polygon is JSONB, so it decodes as Value rather than String.
    async fn element(
        pool: &sqlx::PgPool,
        region_id: Uuid,
    ) -> (bool, Option<String>, Option<serde_json::Value>) {
        sqlx::query_as::<_, (bool, Option<String>, Option<serde_json::Value>)>(
            "SELECT e.visible, e.text, e.mask_polygon FROM layer_elements e \
             JOIN layers l ON l.id = e.layer_id \
             WHERE e.region_id = $1 AND l.type = 'translation' LIMIT 1",
        )
        .bind(region_id)
        .fetch_one(pool)
        .await
        .expect("element")
    }

    let (ok_visible, ok_text, _) = element(&pool, ok_region).await;
    assert!(ok_visible, "a translated region stays visible");
    assert_eq!(ok_text.as_deref(), Some("Hello"));

    let (failed_visible, failed_text, failed_mask) = element(&pool, failed_region).await;
    assert!(
        !failed_visible,
        "a region the worker gave up on must be hidden, or its mask erases the artwork \
         and puts nothing back"
    );
    assert!(failed_text.is_none() || failed_text.as_deref() == Some(""));
    assert!(
        failed_mask.is_some(),
        "the element still carries the mask — visibility is the only thing keeping it off the page"
    );

    cleanup_series(&pool, series_id).await;
}
