//! The Reader's quick resolutions for a region, end to end through their HTTP routes: plain mask,
//! keep translation, and merging fragments into one block (merge → one-region cleanup → that
//! region's translation → a page revision the render picks up).
//!
//! Requires REAL Postgres + Valkey + MinIO (env-gated like every integration suite).

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;
use uuid::Uuid;

use manga_backend::config::{Config, DatabaseConfig, MinioConfig, RedisConfig};
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
        internal_api_token: Some(INTERNAL_TOKEN.into()),
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

async fn translator(pool: &sqlx::PgPool) -> String {
    let email = format!("review-{}@example.invalid", Uuid::new_v4());
    sqlx::query(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
         VALUES (uuid_generate_v4(), now(), 'Reviewer', $1, 'x', 'translator')",
    )
    .bind(&email)
    .execute(pool)
    .await
    .expect("user");
    JwtUtils::new(SECRET.into(), 3_600_000)
        .generate_token(&email)
        .unwrap()
}

async fn post(
    app: &Router,
    uri: &str,
    token: &str,
    body: serde_json::Value,
) -> (StatusCode, String) {
    let request = Request::builder()
        .method("POST")
        .uri(uri)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {token}"))
        .body(Body::from(body.to_string()))
        .unwrap();
    finish(app.clone().oneshot(request).await.unwrap()).await
}

/// A worker callback for `job_id`, speaking for the attempt its row currently holds.
async fn worker_post(
    app: &Router,
    pool: &sqlx::PgPool,
    uri: &str,
    job_id: &str,
    body: serde_json::Value,
) -> (StatusCode, String) {
    let (lease, generation): (String, i32) = sqlx::query_as(
        "UPDATE jobs SET status = 'PROCESSING', started_at = now(), \
           lease_expires_at = now() + interval '120 seconds' \
         WHERE id = $1 RETURNING lease_token, input_generation",
    )
    .bind(job_id)
    .fetch_one(pool)
    .await
    .expect("job row");
    let request = Request::builder()
        .method("POST")
        .uri(uri)
        .header("Content-Type", "application/json")
        .header("X-Internal-Token", INTERNAL_TOKEN)
        .header("X-Job-Id", job_id)
        .header("X-Job-Attempt", "1")
        .header("X-Input-Generation", generation.to_string())
        .header("X-Lease-Token", lease)
        .body(Body::from(body.to_string()))
        .unwrap();
    finish(app.clone().oneshot(request).await.unwrap()).await
}

async fn render_jobs(pool: &sqlx::PgPool, image_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE image_id = $1 AND type = 'render'")
        .bind(image_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn finish(response: axum::http::Response<Body>) -> (StatusCode, String) {
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).to_string())
}

/// series → chapter → 200×300 page, with an OCR and a translation layer.
async fn seed_page(pool: &sqlx::PgPool) -> (Uuid, Uuid, Uuid, Uuid, Uuid) {
    let series_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language, source_language, target_language) \
         VALUES ($1, now(), now(), 'Review E2E', 'rightToLeft', 'ja', 'ja', 'en')",
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
         VALUES ($1, now(), 'review.png', 'originals/review.png', $2, 200, 300)",
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
    let mut layers = Vec::new();
    for (kind, z) in [("ocr", 1), ("translation", 2)] {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, created_at) \
             VALUES ($1, $2, CASE WHEN $2 = 'translation' THEN 'en' END, TRUE, $3, '{}'::jsonb, $4, now())",
        )
        .bind(id)
        .bind(kind)
        .bind(z)
        .bind(page_id)
        .execute(pool)
        .await
        .expect("layer");
        layers.push(id);
    }
    (series_id, page_id, image_id, layers[0], layers[1])
}

/// One region with an OCR element and a visible translation element.
#[allow(clippy::too_many_arguments)]
async fn seed_region(
    pool: &sqlx::PgPool,
    page_id: Uuid,
    (ocr_layer, tl_layer): (Uuid, Uuid),
    order: i32,
    (x, y, w, h): (i32, i32, i32, i32),
    text: &str,
    translation: &str,
    qa_status: Option<&str>,
) -> Uuid {
    let region_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO ocr_regions (id, text, detected_language, bbox_x, bbox_y, bbox_w, bbox_h, page_id, \
           bubble_reading_order, background_color, qa_status, region_type) \
         VALUES ($1, $2, 'ja', $3, $4, $5, $6, $7, $8, '#fdfdfd', $9, 'speech')",
    )
    .bind(region_id)
    .bind(text)
    .bind(x)
    .bind(y)
    .bind(w)
    .bind(h)
    .bind(page_id)
    .bind(order)
    .bind(qa_status)
    .execute(pool)
    .await
    .expect("region");
    for (layer, body) in [(ocr_layer, text), (tl_layer, translation)] {
        sqlx::query(
            "INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, word_wrap, layer_id, region_id) \
             VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, TRUE, FALSE, $6, $7)",
        )
        .bind(body)
        .bind(f64::from(x))
        .bind(f64::from(y))
        .bind(w)
        .bind(h)
        .bind(layer)
        .bind(region_id)
        .execute(pool)
        .await
        .expect("element");
    }
    region_id
}

/// `(id, text, x, y, w, h, qa_status)` of a region.
type RegionRow = (Uuid, String, i32, i32, i32, i32, Option<String>);

async fn revision(pool: &sqlx::PgPool, page_id: Uuid) -> i32 {
    sqlx::query_scalar("SELECT scene_revision FROM pages WHERE id = $1")
        .bind(page_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn cleanup_series(pool: &sqlx::PgPool, series_id: Uuid) {
    for statement in [
        "DELETE FROM layer_elements WHERE layer_id IN (SELECT l.id FROM layers l JOIN pages p ON p.id = l.page_id WHERE p.chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
        "DELETE FROM layers WHERE page_id IN (SELECT id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
        "DELETE FROM ocr_regions WHERE page_id IN (SELECT id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
        "DELETE FROM jobs WHERE image_id IN (SELECT image_id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
        "DELETE FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1)",
        "DELETE FROM chapters WHERE series_id=$1",
        "DELETE FROM series WHERE id=$1",
    ] {
        let _ = sqlx::query(statement).bind(series_id).execute(pool).await;
    }
}

/// "Cover with a plain mask": the plate becomes the region's cleanup (so the render uses it) and
/// the translation element gets the same polygon in the bubble colour (so the Reader draws it).
#[tokio::test]
async fn plain_mask_becomes_the_regions_cleanup() {
    let Some((app, pool, state)) = app().await else {
        return;
    };
    let (series_id, page_id, _, ocr, tl) = seed_page(&pool).await;
    let region = seed_region(
        &pool,
        page_id,
        (ocr, tl),
        1,
        (40, 50, 60, 24),
        "テキスト",
        "Text",
        Some("cleanup_review"),
    )
    .await;
    // A hidden history layer drawing the same region must be left as it was.
    let history = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, created_at) \
         VALUES ($1, 'translation', 'en', FALSE, 0, '{}'::jsonb, $2, now())",
    )
    .bind(history)
    .bind(page_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, word_wrap, layer_id, region_id) \
         VALUES (uuid_generate_v4(), 'Old', 40, 50, 60, 24, FALSE, FALSE, $1, $2)",
    )
    .bind(history)
    .bind(region)
    .execute(&pool)
    .await
    .unwrap();
    let before = revision(&pool, page_id).await;
    let token = translator(&pool).await;

    let (status, body) = post(
        &app,
        &format!("/tlhub/api/ocr-regions/{region}/review"),
        &token,
        serde_json::json!({"action": "mask"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (patch, patch_sha, qa_status): (Option<String>, Option<String>, Option<String>) =
        sqlx::query_as(
            "SELECT cleanup_patch_asset_id, cleanup_patch_sha256, qa_status FROM ocr_regions WHERE id = $1",
        )
        .bind(region)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(patch.is_some_and(|id| id.starts_with("patch-")));
    assert_eq!(qa_status.as_deref(), Some("fixed"));
    let path = manga_backend::page_scene_builder::scene_asset_path(page_id, &patch_sha.unwrap());
    assert!(state.storage.exists(&path).await, "the plate is in storage");

    let (mask, colour, plate_on, visible): (Option<serde_json::Value>, Option<String>, Option<bool>, Option<bool>) =
        sqlx::query_as(
            "SELECT mask_polygon, background_color, word_wrap, visible FROM layer_elements WHERE layer_id = $1",
        )
        .bind(tl)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        mask,
        Some(serde_json::json!([
            [36, 46],
            [104, 46],
            [104, 78],
            [36, 78]
        ]))
    );
    assert_eq!(colour.as_deref(), Some("#fdfdfd"));
    assert_eq!((plate_on, visible), (Some(true), Some(true)));
    assert!(revision(&pool, page_id).await > before);
    let untouched: (Option<serde_json::Value>, Option<bool>) =
        sqlx::query_as("SELECT mask_polygon, visible FROM layer_elements WHERE layer_id = $1")
            .bind(history)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        untouched,
        (None, Some(false)),
        "history layers keep what they had"
    );

    cleanup_series(&pool, series_id).await;
}

/// "Keep translation": a QA flag is dismissed and the translation shown.
#[tokio::test]
async fn keeping_the_translation_clears_the_flag() {
    let Some((app, pool, _state)) = app().await else {
        return;
    };
    let (series_id, page_id, _, ocr, tl) = seed_page(&pool).await;
    let region = seed_region(
        &pool,
        page_id,
        (ocr, tl),
        1,
        (10, 10, 40, 20),
        "テキスト",
        "Text",
        Some("manual_review"),
    )
    .await;
    sqlx::query("UPDATE layer_elements SET visible = FALSE WHERE layer_id = $1")
        .bind(tl)
        .execute(&pool)
        .await
        .unwrap();
    let token = translator(&pool).await;

    let (status, body) = post(
        &app,
        &format!("/tlhub/api/ocr-regions/{region}/review"),
        &token,
        serde_json::json!({"action": "accept"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let qa_status: Option<String> =
        sqlx::query_scalar("SELECT qa_status FROM ocr_regions WHERE id = $1")
            .bind(region)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(qa_status.as_deref(), Some("passed"));
    let visible: Option<bool> =
        sqlx::query_scalar("SELECT visible FROM layer_elements WHERE layer_id = $1")
            .bind(tl)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(visible, Some(true));

    cleanup_series(&pool, series_id).await;
}

/// Merging three fragments of one sentence: one region with the union box and the text in reading
/// order; its cleanup is queued for the new box alone and carries on into that region's
/// translation, not the page's; the redone translation advances the page so it renders.
#[tokio::test]
async fn merged_fragments_are_cleaned_and_translated_as_one_block() {
    let Some((app, pool, state)) = app().await else {
        return;
    };
    let (series_id, page_id, image_id, ocr, tl) = seed_page(&pool).await;
    let layers = (ocr, tl);
    let first = seed_region(
        &pool,
        page_id,
        layers,
        4,
        (37, 174, 236, 102),
        "課外活動",
        "a",
        None,
    )
    .await;
    let second = seed_region(
        &pool,
        page_id,
        layers,
        5,
        (38, 284, 235, 16),
        "なければ",
        "b",
        Some("manual_review"),
    )
    .await;
    let third = seed_region(
        &pool,
        page_id,
        layers,
        6,
        (37, 309, 199, 20),
        "だろう",
        "c",
        None,
    )
    .await;
    // A hidden history layer that drew the first two fragments before.
    let history = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, created_at) \
         VALUES ($1, 'translation', 'en', FALSE, 0, '{}'::jsonb, $2, now())",
    )
    .bind(history)
    .bind(page_id)
    .execute(&pool)
    .await
    .unwrap();
    for (region, text) in [(first, "Old a"), (second, "Old b")] {
        sqlx::query(
            "INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, word_wrap, layer_id, region_id) \
             VALUES (uuid_generate_v4(), $1, 1, 2, 3, 4, FALSE, FALSE, $2, $3)",
        )
        .bind(text)
        .bind(history)
        .bind(region)
        .execute(&pool)
        .await
        .unwrap();
    }
    // The chapter's cleanup-mode override travels on the block's cleanup job.
    sqlx::query("UPDATE chapters SET cleanup_mode = 'telea' WHERE series_id = $1")
        .bind(series_id)
        .execute(&pool)
        .await
        .unwrap();
    let before = revision(&pool, page_id).await;
    let token = translator(&pool).await;

    // A dry run shows the order and the text and changes nothing.
    let (status, body) = post(
        &app,
        &format!("/tlhub/api/pages/{page_id}/regions/merge"),
        &token,
        serde_json::json!({"regionIds": [third, first, second], "dryRun": true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let preview: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        preview["order"],
        serde_json::json!([first.to_string(), second.to_string(), third.to_string()])
    );
    assert_eq!(preview["text"], "課外活動なければだろう");
    let untouched: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ocr_regions WHERE page_id = $1")
        .bind(page_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(untouched, 3, "a dry run writes nothing");
    assert_eq!(revision(&pool, page_id).await, before);

    let (status, body) = post(
        &app,
        &format!("/tlhub/api/pages/{page_id}/regions/merge"),
        &token,
        serde_json::json!({"regionIds": [third, first, second]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let history_rows: Vec<(Option<String>, Option<Uuid>, i32)> = sqlx::query_as(
        "SELECT text, region_id, max_height FROM layer_elements WHERE layer_id = $1 ORDER BY text",
    )
    .bind(history)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        history_rows,
        vec![
            (Some("Old a".to_string()), Some(first), 4),
            (Some("Old b".to_string()), None, 4)
        ],
        "history keeps what it drew; the absorbed fragment's row is detached, not deleted"
    );

    // While the block is still being cleaned and translated, the page is not rendered (and so not
    // judged by QA) however long ago it was edited.
    sqlx::query("UPDATE pages SET last_edited_at = now() - interval '1 hour' WHERE id = $1")
        .bind(page_id)
        .execute(&pool)
        .await
        .unwrap();
    manga_backend::jobs::recovery::process_pending_renders(&state).await;
    assert_eq!(render_jobs(&pool, image_id).await, 0, "no render mid-merge");
    // However long the cleanup has queued behind other pages.
    sqlx::query("UPDATE jobs SET created_at = now() - interval '2 hours', updated_at = NULL WHERE image_id = $1 AND type = 'cleanup'")
        .bind(image_id)
        .execute(&pool)
        .await
        .unwrap();
    manga_backend::jobs::recovery::process_pending_renders(&state).await;
    assert_eq!(
        render_jobs(&pool, image_id).await,
        0,
        "a long-queued cleanup still holds the render"
    );

    let regions: Vec<RegionRow> = sqlx::query_as(
        "SELECT id, text, bbox_x, bbox_y, bbox_w, bbox_h, qa_status FROM ocr_regions WHERE page_id = $1",
    )
    .bind(page_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        regions,
        vec![(
            first,
            "課外活動なければだろう".to_string(),
            37,
            174,
            236,
            155,
            None
        )],
        "the first fragment survives with the union box and the text in reading order"
    );
    let elements: Vec<(Option<String>, Option<bool>, i32)> =
        sqlx::query_as("SELECT text, visible, max_height FROM layer_elements WHERE layer_id = $1")
            .bind(tl)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(
        elements,
        vec![(None, Some(false), 155)],
        "one translation row, waiting for the block's own translation"
    );
    assert!(revision(&pool, page_id).await > before);
    let texts: serde_json::Value = sqlx::query_scalar(
        "SELECT ownership_provenance->'mergedTexts' FROM ocr_regions WHERE id = $1",
    )
    .bind(first)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        texts,
        serde_json::json!(["課外活動", "なければ", "だろう"]),
        "the pieces are kept, in reading order, for the translator"
    );

    let (cleanup_job, payload): (String, String) =
        sqlx::query_as("SELECT id, payload FROM jobs WHERE image_id = $1 AND type = 'cleanup'")
            .bind(image_id)
            .fetch_one(&pool)
            .await
            .expect("one cleanup job");
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(payload["followUp"]["regionId"], first.to_string());
    assert_eq!(payload["cleanupMode"], "telea");
    let entries = payload["cleanupRegions"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "only the merged box is cleaned again");

    // The worker reports the merged box cleaned.
    let (status, body) = worker_post(
        &app,
        &pool,
        "/tlhub/api/internal/jobs/callback/cleanup",
        &cleanup_job,
        serde_json::json!({
            "jobId": cleanup_job,
            "imageId": image_id.to_string(),
            "pageId": page_id.to_string(),
            "cleanupInputDigest": payload["cleanupInputDigest"],
            "regions": [{
                "regionId": first.to_string(),
                "inputDigest": entries[0]["inputDigest"],
                "status": "complete",
                "cleanupMaskAssetId": "mask-a", "cleanupMaskSha256": "a".repeat(64),
                "cleanupPatchAssetId": "patch-b", "cleanupPatchSha256": "b".repeat(64),
                "cleanupBounds": {"x": 37, "y": 174, "width": 236, "height": 155},
            }],
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let queued: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, type FROM jobs WHERE image_id = $1 AND type IN ('translation', 'region-redo-tl')",
    )
    .bind(image_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(queued.len(), 1, "{queued:?}");
    assert_eq!(
        queued[0].1, "region-redo-tl",
        "the block alone is translated"
    );
    let after_cleanup = revision(&pool, page_id).await;

    // Its translation lands as an overlay, and the page advances so the render picks it up.
    let (status, body) = worker_post(
        &app,
        &pool,
        &format!("/tlhub/api/internal/ocr-regions/{first}/callback"),
        &queued[0].0,
        serde_json::json!({"jobId": queued[0].0, "translatedText": "One whole sentence."}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let shown: Vec<String> = sqlx::query_scalar(
        "SELECT e.text FROM layer_elements e JOIN layers l ON l.id = e.layer_id \
         WHERE l.page_id = $1 AND l.type = 'translation' AND l.visible AND e.visible",
    )
    .bind(page_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(shown, vec!["One whole sentence.".to_string()]);
    assert!(revision(&pool, page_id).await > after_cleanup);

    // Once the work is done the page renders, once.
    sqlx::query(
        "UPDATE jobs SET status = 'COMPLETED' WHERE image_id = $1 AND status IN ('PENDING', 'PROCESSING')",
    )
    .bind(image_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE pages SET last_edited_at = now() - interval '1 hour' WHERE id = $1")
        .bind(page_id)
        .execute(&pool)
        .await
        .unwrap();
    manga_backend::jobs::recovery::process_pending_renders(&state).await;
    assert_eq!(
        render_jobs(&pool, image_id).await,
        1,
        "one render after the merge settles"
    );

    sqlx::query("DELETE FROM page_render_jobs WHERE page_id = $1")
        .bind(page_id)
        .execute(&pool)
        .await
        .unwrap();
    cleanup_series(&pool, series_id).await;
}
