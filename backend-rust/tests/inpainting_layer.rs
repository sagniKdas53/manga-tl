//! Tracker R7: the Inpainting layer, end to end against the database and storage.
//!
//! A cleanup pass becomes an Inpainting layer; the scene builder draws each visible patch where the
//! editor left it (moved, resized, faded), follows the region's own verdict (R7-D4), keeps patches
//! decoupled from text, retires an older pass to history (R7-D2/D2b), keeps a region-less patch
//! drawable through a manual_cleanup object, and never draws the old flat plate (2026-10-02).
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
        self_hosted_admin: false,
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

fn sha(fill: char) -> String {
    std::iter::repeat_n(fill, 64).collect()
}

/// Gives `region_id` a worker patch (and puts both objects where the worker would).
async fn give_patch(
    state: &AppState,
    page_id: Uuid,
    region_id: Uuid,
    patch: &str,
    mask: &str,
    (x, y, w, h): (i32, i32, i32, i32),
) {
    for digest in [patch, mask] {
        state
            .storage
            .upload_bytes(
                &manga_backend::page_scene_builder::scene_asset_path(page_id, digest),
                b"png".to_vec(),
                "image/png",
            )
            .await
            .expect("stage cleanup asset");
    }
    sqlx::query(
        "UPDATE ocr_regions SET cleanup_patch_asset_id = 'patch-' || $2, cleanup_patch_sha256 = $2, \
           cleanup_patch_byte_length = 3, cleanup_mask_asset_id = 'mask-' || $3, cleanup_mask_sha256 = $3, \
           cleanup_mask_byte_length = 3, cleanup_bounds = $4, translated_text = 'Hello there' \
         WHERE id = $1",
    )
    .bind(region_id)
    .bind(patch)
    .bind(mask)
    .bind(serde_json::json!({"x": x, "y": y, "width": w, "height": h}))
    .execute(&state.pool)
    .await
    .expect("region patch");
}

async fn record_pass(state: &AppState, page_id: Uuid, regions: &[Uuid]) -> Option<Uuid> {
    let mut tx = state.pool.begin().await.unwrap();
    let layer = manga_backend::inpainting::record_cleanup_pass(&mut tx, page_id, regions)
        .await
        .expect("record pass");
    tx.commit().await.unwrap();
    layer
}

async fn scene(state: &AppState, page_id: Uuid) -> serde_json::Value {
    let mut tx = state.pool.begin().await.unwrap();
    let built = manga_backend::page_scene_builder::build_pipeline_scene(state, &mut tx, page_id, 0)
        .await
        .expect("the built scene validates");
    tx.rollback().await.unwrap();
    built.validated.document
}

fn cleanups(scene: &serde_json::Value) -> &Vec<serde_json::Value> {
    scene["cleanup_artifacts"].as_array().unwrap()
}

fn policy_action(scene: &serde_json::Value, region_id: Uuid) -> &str {
    scene["policies"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["owner_id"] == format!("owner-{region_id}"))
        .and_then(|p| p["action"].as_str())
        .unwrap()
}

fn text_objects(scene: &serde_json::Value) -> Vec<&serde_json::Value> {
    scene["objects"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|o| o["kind"] != "manual_cleanup")
        .collect()
}

async fn patch_element(pool: &sqlx::PgPool, layer_id: Uuid) -> Uuid {
    sqlx::query_scalar("SELECT id FROM layer_elements WHERE layer_id = $1")
        .bind(layer_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_patch_is_drawn_where_the_editor_leaves_it_and_follows_its_region() {
    let Some((_app, pool, state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let (series_id, page_id, _image_id, ocr, tl) = seed_page(&pool).await;
    let region = seed_region(
        &pool,
        page_id,
        (ocr, tl),
        1,
        (20, 30, 60, 40),
        "やあ",
        "Hello there",
        None,
    )
    .await;
    let (patch, mask) = (sha('a'), sha('b'));
    give_patch(&state, page_id, region, &patch, &mask, (18, 28, 64, 44)).await;

    // The pass becomes a visible Inpainting layer with one element at the worker's bounds.
    let layer = record_pass(&state, page_id, &[region])
        .await
        .expect("a layer for the pass");
    let element = patch_element(&pool, layer).await;
    let placed: (String, bool, f64, f64, i32, i32) = sqlx::query_as(
        "SELECT l.type, l.visible, e.x, e.y, e.max_width, e.max_height FROM layer_elements e \
         JOIN layers l ON l.id = e.layer_id WHERE e.id = $1",
    )
    .bind(element)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(placed, ("inpainting".into(), true, 18.0, 28.0, 64, 44));

    let drawn = scene(&state, page_id).await;
    assert_eq!(cleanups(&drawn).len(), 1);
    let artifact = &cleanups(&drawn)[0];
    assert_eq!(artifact["cleanup_id"], format!("cleanup-{element}"));
    assert_eq!(
        artifact["owner_ids"],
        serde_json::json!([format!("owner-{region}")])
    );
    assert_eq!(
        artifact["bounds"],
        serde_json::json!({"x": 18.0, "y": 28.0, "width": 64.0, "height": 44.0})
    );
    assert_eq!(artifact["patch_asset_id"], format!("patch-{patch}"));
    assert!(
        artifact.get("opacity").is_none(),
        "an untouched patch carries no opacity"
    );
    let texts = text_objects(&drawn);
    assert_eq!(texts.len(), 1);
    assert_eq!(texts[0]["kind"], "automatic_text");
    assert_eq!(
        texts[0]["cleanup_ids"],
        serde_json::json!([format!("cleanup-{element}")])
    );

    // Moved, stretched and faded in the editor: the scene follows.
    sqlx::query(
        "UPDATE layer_elements SET x = 40, y = 5.5, max_width = 128, opacity = 0.5 WHERE id = $1",
    )
    .bind(element)
    .execute(&pool)
    .await
    .unwrap();
    let drawn = scene(&state, page_id).await;
    assert_eq!(
        cleanups(&drawn)[0]["bounds"],
        serde_json::json!({"x": 40.0, "y": 5.5, "width": 128.0, "height": 44.0})
    );
    assert_eq!(cleanups(&drawn)[0]["opacity"], 0.5);

    // Every text layer hidden: the cleaned page stays (R7-D4), with no text on it.
    sqlx::query("UPDATE layers SET visible = FALSE WHERE id = $1")
        .bind(tl)
        .execute(&pool)
        .await
        .unwrap();
    let drawn = scene(&state, page_id).await;
    assert_eq!(cleanups(&drawn).len(), 1, "hiding text keeps the patch");
    assert_eq!(policy_action(&drawn, region), "replace");
    assert!(text_objects(&drawn).is_empty());
    sqlx::query("UPDATE layers SET visible = TRUE WHERE id = $1")
        .bind(tl)
        .execute(&pool)
        .await
        .unwrap();

    // Rejected in review: the region has no usable English, so its source stays (R7-D4).
    sqlx::query("UPDATE ocr_regions SET qa_status = 'rejected' WHERE id = $1")
        .bind(region)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE layer_elements SET visible = FALSE WHERE layer_id = $1")
        .bind(tl)
        .execute(&pool)
        .await
        .unwrap();
    let drawn = scene(&state, page_id).await;
    assert!(
        cleanups(&drawn).is_empty(),
        "a rejected region keeps its source pixels"
    );
    assert_eq!(policy_action(&drawn, region), "review");
    // QA judging it a sound effect hides the text but keeps translated_text: same verdict.
    sqlx::query("UPDATE ocr_regions SET qa_status = 'reject_sfx' WHERE id = $1")
        .bind(region)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        cleanups(&scene(&state, page_id).await).is_empty(),
        "a region QA rejected as SFX keeps its source pixels"
    );
    sqlx::query("UPDATE ocr_regions SET qa_status = NULL WHERE id = $1")
        .bind(region)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE layer_elements SET visible = TRUE WHERE layer_id = $1")
        .bind(tl)
        .execute(&pool)
        .await
        .unwrap();

    // The patch hidden: the text stays, over the source, and no flat plate comes back.
    sqlx::query("UPDATE layer_elements SET visible = FALSE WHERE id = $1")
        .bind(element)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE layer_elements SET mask_polygon = '[[20,30],[80,30],[80,70],[20,70]]'::jsonb, background_color = '#ffffff' WHERE layer_id = $1")
        .bind(tl).execute(&pool).await.unwrap();
    let drawn = scene(&state, page_id).await;
    assert!(
        cleanups(&drawn).is_empty(),
        "no patch and no plate for a region that has a worker patch"
    );
    let texts = text_objects(&drawn);
    assert_eq!(
        (texts.len(), texts[0]["kind"].as_str()),
        (1, Some("manual_text"))
    );
    sqlx::query("UPDATE layer_elements SET visible = TRUE WHERE id = $1")
        .bind(element)
        .execute(&pool)
        .await
        .unwrap();

    // A second pass for the region retires the first to history.
    let (patch2, mask2) = (sha('c'), sha('d'));
    give_patch(&state, page_id, region, &patch2, &mask2, (19, 29, 62, 42)).await;
    let second = record_pass(&state, page_id, &[region])
        .await
        .expect("second layer");
    let first_state: (bool, Option<bool>) = sqlx::query_as(
        "SELECT l.visible, e.visible FROM layers l JOIN layer_elements e ON e.layer_id = l.id WHERE l.id = $1",
    )
    .bind(layer)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        first_state,
        (false, Some(false)),
        "the older pass is kept, hidden"
    );
    let drawn = scene(&state, page_id).await;
    assert_eq!(cleanups(&drawn).len(), 1);
    assert_eq!(
        cleanups(&drawn)[0]["patch_asset_id"],
        format!("patch-{patch2}")
    );
    assert_eq!(
        cleanups(&drawn)[0]["cleanup_id"],
        format!("cleanup-{}", patch_element(&pool, second).await)
    );

    // An OCR redo cuts the region link. Turned back on, the old patch is the user's to keep: it is
    // drawn owner-less and a manual_cleanup object authorizes it (contract rule 7).
    sqlx::query("UPDATE layer_elements SET region_id = NULL, visible = TRUE WHERE id = $1")
        .bind(element)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE layers SET visible = TRUE WHERE id = $1")
        .bind(layer)
        .execute(&pool)
        .await
        .unwrap();
    let drawn = scene(&state, page_id).await;
    assert_eq!(cleanups(&drawn).len(), 2);
    let kept = cleanups(&drawn)
        .iter()
        .find(|c| c["cleanup_id"] == format!("cleanup-{element}"))
        .unwrap();
    assert_eq!(kept["owner_ids"], serde_json::json!([]));
    let manual: Vec<_> = drawn["objects"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|o| o["kind"] == "manual_cleanup")
        .collect();
    assert_eq!(manual.len(), 1);
    assert_eq!(
        manual[0]["cleanup_ids"],
        serde_json::json!([format!("cleanup-{element}")])
    );
    // Painted layer by layer: the older layer (lower z) first.
    assert_eq!(
        cleanups(&drawn)[0]["cleanup_id"],
        format!("cleanup-{element}")
    );

    cleanup_series(&pool, series_id).await;
}

/// User review, 2026-10-02 (page 21): a region with no patch got a flat plate in its sampled
/// colour -- the "old type mask" -- which on SFX (excluded from cleanup) showed before QA ran.
/// Now no region gets one: dialogue whose cleanup found nothing is drawn over the source, an SFX
/// is not drawn until it has a patch, and an SFX the user typed by hand is drawn.
#[tokio::test]
async fn a_region_without_a_patch_gets_no_flat_plate_and_an_sfx_is_not_drawn() {
    let Some((_app, pool, state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let (series_id, page_id, _image_id, ocr, tl) = seed_page(&pool).await;
    let region = seed_region(
        &pool,
        page_id,
        (ocr, tl),
        1,
        (20, 30, 60, 40),
        "やあ",
        "Hello",
        None,
    )
    .await;
    sqlx::query("UPDATE layer_elements SET mask_polygon = '[[20,30],[80,30],[80,70],[20,70]]'::jsonb, background_color = '#ffffff' WHERE layer_id = $1")
        .bind(tl).execute(&pool).await.unwrap();
    assert_eq!(
        record_pass(&state, page_id, &[region]).await,
        None,
        "no patch, no layer"
    );

    let drawn = scene(&state, page_id).await;
    assert!(cleanups(&drawn).is_empty(), "no flat plate");
    assert_eq!(text_objects(&drawn).len(), 1);
    assert_eq!(
        text_objects(&drawn)[0]["kind"],
        "manual_text",
        "dialogue with no patch is drawn over the source"
    );

    // The layout stage called it a sound effect: cleanup left it alone, so it is not drawn.
    sqlx::query("UPDATE ocr_regions SET region_type = 'sfx' WHERE id = $1")
        .bind(region)
        .execute(&pool)
        .await
        .unwrap();
    let drawn = scene(&state, page_id).await;
    assert!(cleanups(&drawn).is_empty());
    assert!(
        text_objects(&drawn).is_empty(),
        "an SFX with no patch is not drawn"
    );
    assert_eq!(
        policy_action(&drawn, region),
        "review",
        "nothing replaces its lettering"
    );

    // Typed by hand, it is the user's: drawn over the source.
    sqlx::query("UPDATE layer_elements SET is_manually_edited = TRUE WHERE layer_id = $1")
        .bind(tl)
        .execute(&pool)
        .await
        .unwrap();
    let drawn = scene(&state, page_id).await;
    assert_eq!(
        text_objects(&drawn).len(),
        1,
        "hand-typed SFX text is drawn"
    );
    assert!(cleanups(&drawn).is_empty());
    cleanup_series(&pool, series_id).await;
}

/// A page cloned from an already-processed image carries its source's cleanup: the region
/// columns, the storage objects under its own prefix, and an Inpainting layer the scene draws.
/// A region whose objects are gone is cloned without a patch rather than failing the clone.
#[tokio::test]
async fn a_cloned_page_carries_its_sources_cleanup() {
    let Some((_app, pool, state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let (source_series, source_page, _, ocr, tl) = seed_page(&pool).await;
    let kept = seed_region(
        &pool,
        source_page,
        (ocr, tl),
        1,
        (20, 30, 60, 40),
        "やあ",
        "Hello",
        None,
    )
    .await;
    let lost = seed_region(
        &pool,
        source_page,
        (ocr, tl),
        2,
        (100, 150, 50, 40),
        "ねえ",
        "Hey",
        None,
    )
    .await;
    let (patch, mask) = (sha('c'), sha('d'));
    give_patch(&state, source_page, kept, &patch, &mask, (12, 22, 76, 56)).await;
    give_patch(
        &state,
        source_page,
        lost,
        &sha('e'),
        &sha('f'),
        (92, 142, 66, 56),
    )
    .await;
    state
        .storage
        .delete_quietly(&manga_backend::page_scene_builder::scene_asset_path(
            source_page,
            &sha('f'),
        ))
        .await;

    let (target_series, target_page, _, _, _) = seed_page(&pool).await;
    let region_map = manga_backend::clone::clone_ocr_data(&pool, source_page, target_page).await;
    assert_eq!(region_map.len(), 2);
    let copied = manga_backend::clone::clone_cleanup_data(
        &pool,
        &state.storage,
        source_page,
        target_page,
        &region_map,
    )
    .await
    .expect("clone cleanup");
    assert_eq!(
        copied, 1,
        "only the region whose objects exist gets a patch"
    );

    let patches: Vec<(Uuid, Option<String>)> =
        sqlx::query_as("SELECT id, cleanup_patch_sha256::text FROM ocr_regions WHERE page_id = $1")
            .bind(target_page)
            .fetch_all(&pool)
            .await
            .unwrap();
    let patch_of = |source: Uuid| {
        patches
            .iter()
            .find(|(id, _)| *id == region_map[&source])
            .and_then(|(_, p)| p.clone())
    };
    assert_eq!(patch_of(kept), Some(patch.clone()));
    assert_eq!(patch_of(lost), None);
    for digest in [&patch, &mask] {
        assert!(
            state
                .storage
                .exists(&manga_backend::page_scene_builder::scene_asset_path(
                    target_page,
                    digest
                ))
                .await,
            "the object is copied under the cloned page's own prefix"
        );
    }

    let elements: Vec<(Option<Uuid>, String)> = sqlx::query_as(
        "SELECT e.region_id, e.cleanup_ref->>'patchSha256' FROM layer_elements e \
         JOIN layers l ON l.id = e.layer_id WHERE l.page_id = $1 AND l.type = 'inpainting' AND l.visible",
    )
    .bind(target_page)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(elements, vec![(Some(region_map[&kept]), patch.clone())]);
    // R7-D4: a patch is drawn once its region has English, which the clone's translation step
    // (copied or re-run) supplies next.
    sqlx::query("UPDATE ocr_regions SET translated_text = 'Hello there' WHERE page_id = $1")
        .bind(target_page)
        .execute(&pool)
        .await
        .unwrap();
    let drawn = scene(&state, target_page).await;
    assert!(
        cleanups(&drawn)
            .iter()
            .any(
                |artifact| artifact["patch_asset_id"] == format!("patch-{patch}").as_str()
                    && artifact["bounds"]["x"] == 12.0
                    && artifact["bounds"]["width"] == 76.0
            ),
        "the scene draws the copied patch: {:?} / {}",
        cleanups(&drawn),
        drawn["provenance"]["warnings"]
    );

    cleanup_series(&pool, source_series).await;
    cleanup_series(&pool, target_series).await;
}

async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    token: &str,
    body: serde_json::Value,
) -> (StatusCode, String) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {token}"))
        .body(Body::from(body.to_string()))
        .unwrap();
    finish(app.clone().oneshot(request).await.unwrap()).await
}

#[tokio::test]
async fn a_patch_element_can_only_name_this_pages_assets_and_a_sane_opacity() {
    let Some((app, pool, state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let token = translator(&pool).await;
    let (series_id, page_id, _image_id, ocr, tl) = seed_page(&pool).await;
    let region = seed_region(
        &pool,
        page_id,
        (ocr, tl),
        1,
        (20, 30, 60, 40),
        "やあ",
        "Hello",
        None,
    )
    .await;
    let (patch, mask) = (sha('e'), sha('f'));
    give_patch(&state, page_id, region, &patch, &mask, (18, 28, 64, 44)).await;
    let layer = record_pass(&state, page_id, &[region]).await.unwrap();
    let reference: serde_json::Value =
        sqlx::query_scalar("SELECT cleanup_ref FROM layer_elements WHERE layer_id = $1")
            .bind(layer)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(reference["patchSha256"], patch.as_str());

    let create = |layer: Uuid, reference: serde_json::Value| {
        let app = app.clone();
        let token = token.clone();
        async move {
            send(&app, "POST", &format!("/tlhub/api/layers/{layer}/elements"), &token,
                serde_json::json!({"x": 1, "y": 2, "maxWidth": 64, "maxHeight": 44, "opacity": 0.25, "cleanupRef": reference})).await
        }
    };
    // Undoing a delete re-creates the element from its snapshot.
    let (status, body) = create(layer, reference.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let created: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(created["opacity"], 0.25);
    assert_eq!(created["cleanupRef"]["patchSha256"], patch.as_str());

    let (status, _) = create(tl, reference.clone()).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "only an inpainting layer carries patches"
    );
    let mut elsewhere = reference.clone();
    elsewhere["patchSha256"] = serde_json::json!(sha('9'));
    let (status, _) = create(layer, elsewhere).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "an asset the page does not hold"
    );
    let mut traversal = reference.clone();
    traversal["maskSha256"] = serde_json::json!("../other/x");
    let (status, _) = create(layer, traversal).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let id = created["id"].as_str().unwrap();
    let (status, _) = send(
        &app,
        "PUT",
        &format!("/tlhub/api/layer-elements/{id}"),
        &token,
        serde_json::json!({"opacity": 1.5}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = send(
        &app,
        "PUT",
        &format!("/tlhub/api/layer-elements/{id}"),
        &token,
        serde_json::json!({"opacity": 0.75, "cleanupRef": {"patchSha256": sha('9')}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let updated: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(updated["opacity"], 0.75);
    assert_eq!(
        updated["cleanupRef"]["patchSha256"],
        patch.as_str(),
        "an update never repoints a patch"
    );

    // #237: the editor marks a patch it hid with its region's text, and clears the mark.
    for hidden in [true, false] {
        let (status, body) = send(
            &app,
            "PUT",
            &format!("/tlhub/api/layer-elements/{id}"),
            &token,
            serde_json::json!({"visible": !hidden, "hiddenWithText": hidden}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let updated: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(updated["hiddenWithText"], hidden);
        assert_eq!(updated["visible"], !hidden);
    }

    cleanup_series(&pool, series_id).await;
}

/// A PNG of `w` x `h` whose alpha marks everything (or nothing).
fn mask_png(w: u32, h: u32, marked: bool) -> String {
    let mut buffer = image::RgbaImage::new(w, h);
    for pixel in buffer.pixels_mut() {
        pixel.0 = [255, 255, 255, if marked { 255 } else { 0 }];
    }
    let mut png = std::io::Cursor::new(Vec::new());
    buffer
        .write_to(&mut png, image::ImageFormat::Png)
        .expect("encode mask");
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(png.into_inner())
}

/// The mask editor's endpoint refuses what the worker could not repaint, and queues the rest
/// ahead of the pipeline with the page's current draw list as the underlay.
#[tokio::test]
async fn a_manual_repaint_is_validated_and_queued_ahead_of_the_pipeline() {
    let Some((app, pool, state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    assert_eq!(manga_backend::jobs::HEAVY_QUEUES[0], "queue:manual-cleanup");
    let token = translator(&pool).await;
    let (series_id, page_id, _image_id, ocr, tl) = seed_page(&pool).await;
    let region = seed_region(
        &pool,
        page_id,
        (ocr, tl),
        1,
        (20, 30, 60, 40),
        "やあ",
        "Hello",
        None,
    )
    .await;
    let patch = sha('7');
    give_patch(&state, page_id, region, &patch, &sha('8'), (18, 28, 64, 44)).await;
    record_pass(&state, page_id, &[region]).await.unwrap();
    let uri = format!("/tlhub/api/pages/{page_id}/manual-cleanup");
    let request = |mask: String, bounds: serde_json::Value, method: &str| serde_json::json!({ "mask": mask, "bounds": bounds, "method": method });
    let inside = serde_json::json!({ "x": 10, "y": 20, "width": 12, "height": 8 });

    for (body, why) in [
        (
            request(mask_png(12, 8, true), inside.clone(), "lama"),
            "an unknown method",
        ),
        (
            request(mask_png(12, 8, true), inside.clone(), "flat"),
            "a flat fill with no colour",
        ),
        (
            request(
                mask_png(12, 8, true),
                serde_json::json!({ "x": 195, "y": 0, "width": 12, "height": 8 }),
                "auto",
            ),
            "a mask past the page's right edge",
        ),
        (
            request(mask_png(10, 8, true), inside.clone(), "auto"),
            "a mask not the size of its bounds",
        ),
        (
            request(mask_png(12, 8, false), inside.clone(), "auto"),
            "a mask that marks nothing",
        ),
        (
            request("not base64!".into(), inside.clone(), "auto"),
            "a mask that is not base64",
        ),
    ] {
        let (status, text) = send(&app, "POST", &uri, &token, body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{why}: {text}");
    }
    let (status, _) = send(
        &app,
        "POST",
        &format!("/tlhub/api/pages/{}/manual-cleanup", Uuid::new_v4()),
        &token,
        request(mask_png(12, 8, true), inside.clone(), "auto"),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, text) = send(
        &app,
        "POST",
        &uri,
        &token,
        request(mask_png(12, 8, true), inside.clone(), "auto"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{text}");
    let accepted: serde_json::Value = serde_json::from_str(&text).unwrap();
    let mask_sha = accepted["maskSha256"].as_str().unwrap().to_owned();
    assert!(
        state
            .storage
            .exists(&manga_backend::page_scene_builder::scene_asset_path(
                page_id, &mask_sha
            ))
            .await,
        "the mark is stored under the page's own prefix"
    );
    let payload: String = sqlx::query_scalar(
        "SELECT payload FROM jobs WHERE page_id = $1 AND type = 'manual-cleanup' AND status = 'PENDING'",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .expect("one queued manual-cleanup job");
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(payload["manualMask"]["sha256"], mask_sha.as_str());
    assert_eq!(payload["manualMask"]["width"], 12);
    assert_eq!(payload["method"], "auto");
    assert!(
        payload["imageUrl"]
            .as_str()
            .is_some_and(|url| !url.is_empty())
    );
    let underlay = payload["underlay"].as_array().unwrap();
    assert_eq!(
        underlay.len(),
        1,
        "the one visible patch is the underlay: {underlay:?}"
    );
    assert_eq!(
        underlay[0]["path"],
        manga_backend::page_scene_builder::scene_asset_path(page_id, &patch).as_str()
    );
    assert!(
        payload["underlaySha256"]
            .as_str()
            .is_some_and(|digest| digest.len() == 64),
        "the job carries the digest its callback is fenced on (H2)"
    );
    assert!(
        payload["imageUrl"]
            .as_str()
            .is_some_and(|url| url.contains("X-Amz-Expires=604800")),
        "a queued job's source link lasts 7 days, not 10 minutes"
    );

    // The eraser over an automatic patch: a restore needs no colour and no underlay.
    let _ = sqlx::query("DELETE FROM jobs WHERE page_id = $1")
        .bind(page_id)
        .execute(&pool)
        .await;
    let (status, text) = send(
        &app,
        "POST",
        &uri,
        &token,
        request(mask_png(12, 8, true), inside.clone(), "restore"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{text}");
    let payload: String = sqlx::query_scalar(
        "SELECT payload FROM jobs WHERE page_id = $1 AND type = 'manual-cleanup' AND status = 'PENDING'",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .expect("one queued restore job");
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(payload["method"], "restore");
    assert_eq!(payload["underlay"], serde_json::json!([]));
    assert!(
        payload.get("underlaySha256").is_none(),
        "a restore has nothing to fence"
    );

    let _ = sqlx::query("DELETE FROM jobs WHERE page_id = $1")
        .bind(page_id)
        .execute(&pool)
        .await;
    cleanup_series(&pool, series_id).await;
}

async fn processing_manual_job(pool: &sqlx::PgPool, page_id: Uuid, image_id: Uuid) -> String {
    processing_manual_job_with(pool, page_id, image_id, "{}").await
}

/// A manual job whose stored payload is `payload`, as `queue_manual_cleanup` would have left it.
async fn processing_manual_job_with(
    pool: &sqlx::PgPool,
    page_id: Uuid,
    image_id: Uuid,
    payload: &str,
) -> String {
    let job_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO jobs (id, type, status, image_id, page_id, attempt, max_attempts, payload, \
           input_generation, lease_token, created_at, updated_at) \
         VALUES ($1, 'manual-cleanup', 'PROCESSING', $2, $3, 1, 3, $4, \
           (SELECT input_generation FROM pages WHERE id = $3), 'lease-m', now(), now())",
    )
    .bind(&job_id)
    .bind(image_id)
    .bind(page_id)
    .bind(payload)
    .execute(pool)
    .await
    .expect("manual job");
    job_id
}

async fn manual_callback(
    app: &Router,
    pool: &sqlx::PgPool,
    job_id: &str,
    body: serde_json::Value,
) -> StatusCode {
    let input_generation: i32 =
        sqlx::query_scalar("SELECT input_generation FROM jobs WHERE id = $1")
            .bind(job_id)
            .fetch_one(pool)
            .await
            .unwrap();
    let request = Request::builder()
        .method("POST")
        .uri("/tlhub/api/internal/jobs/callback/manual-cleanup")
        .header("Content-Type", "application/json")
        .header("X-Internal-Token", INTERNAL_TOKEN)
        .header("X-Job-Id", job_id)
        .header("X-Job-Attempt", "1")
        .header("X-Input-Generation", input_generation.to_string())
        .header("X-Lease-Token", "lease-m")
        .body(Body::from(body.to_string()))
        .unwrap();
    finish(app.clone().oneshot(request).await.unwrap()).await.0
}

/// A landed repaint is one region-less, hand-edited patch on a new Inpainting layer above the
/// others, and the scene draws it; a repaint whose objects are missing, or that the worker
/// reports failed, fails its job and adds nothing.
#[tokio::test]
async fn a_manual_repaint_lands_on_a_new_top_inpainting_layer() {
    let Some((app, pool, state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let (series_id, page_id, image_id, ocr, tl) = seed_page(&pool).await;
    let region = seed_region(
        &pool,
        page_id,
        (ocr, tl),
        1,
        (20, 30, 60, 40),
        "やあ",
        "Hello",
        None,
    )
    .await;
    give_patch(
        &state,
        page_id,
        region,
        &sha('1'),
        &sha('2'),
        (18, 28, 64, 44),
    )
    .await;
    let pass = record_pass(&state, page_id, &[region]).await.unwrap();
    let revision_before: i32 = sqlx::query_scalar("SELECT scene_revision FROM pages WHERE id = $1")
        .bind(page_id)
        .fetch_one(&pool)
        .await
        .unwrap();

    let (patch, mask) = (sha('3'), sha('4'));
    for digest in [&patch, &mask] {
        state
            .storage
            .upload_bytes(
                &manga_backend::page_scene_builder::scene_asset_path(page_id, digest),
                b"png".to_vec(),
                "image/png",
            )
            .await
            .unwrap();
    }
    let complete = |patch: &str, mask: &str, job_id: &str| {
        serde_json::json!({
            "jobId": job_id, "imageId": image_id, "pageId": page_id, "status": "complete",
            "cleanupPatchSha256": patch, "cleanupPatchByteLength": 3,
            "cleanupMaskSha256": mask, "cleanupMaskByteLength": 3,
            "cleanupGeneratorSha256": sha('0'),
            "cleanupBounds": { "x": 30, "y": 40, "width": 16, "height": 12 },
            "diagnostics": ["manual repaint: telea (mode=auto)"],
        })
    };

    let job = processing_manual_job(&pool, page_id, image_id).await;
    assert_eq!(
        manual_callback(&app, &pool, &job, complete(&patch, &mask, &job)).await,
        StatusCode::OK
    );
    let (pass_z, status): (i32, String) = (
        sqlx::query_scalar("SELECT z_order FROM layers WHERE id = $1")
            .bind(pass)
            .fetch_one(&pool)
            .await
            .unwrap(),
        sqlx::query_scalar("SELECT status FROM jobs WHERE id = $1")
            .bind(&job)
            .fetch_one(&pool)
            .await
            .unwrap(),
    );
    assert_eq!(status, "COMPLETED");
    let manual: Vec<(i32, bool, Option<Uuid>, bool, String)> = sqlx::query_as(
        "SELECT l.z_order, l.visible, e.region_id, e.is_manually_edited, e.cleanup_ref->>'patchSha256' \
         FROM layers l JOIN layer_elements e ON e.layer_id = l.id \
         WHERE l.page_id = $1 AND l.type = 'inpainting' AND l.id <> $2",
    )
    .bind(page_id)
    .bind(pass)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(manual.len(), 1, "one new layer holding one patch");
    let (z, visible, region_id, hand_edited, drawn) = &manual[0];
    assert!(*z > pass_z && *visible, "above the earlier pass, and shown");
    assert_eq!(
        (region_id, *hand_edited),
        (&None, true),
        "region-less and hand-edited (no QA)"
    );
    assert_eq!(drawn, &patch);
    let revision_after: i32 = sqlx::query_scalar("SELECT scene_revision FROM pages WHERE id = $1")
        .bind(page_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        revision_after > revision_before,
        "the page is marked for re-render"
    );
    let drawn_scene = scene(&state, page_id).await;
    assert!(
        cleanups(&drawn_scene)
            .iter()
            .any(|artifact| artifact["patch_asset_id"] == format!("patch-{patch}").as_str()),
        "the export draws the repaint"
    );

    // Objects that never reached storage: the job fails and nothing is added.
    let missing = processing_manual_job(&pool, page_id, image_id).await;
    assert_eq!(
        manual_callback(
            &app,
            &pool,
            &missing,
            complete(&sha('5'), &sha('6'), &missing)
        )
        .await,
        StatusCode::OK
    );
    // The worker says it could not repaint.
    let refused = processing_manual_job(&pool, page_id, image_id).await;
    assert_eq!(
        manual_callback(
            &app,
            &pool,
            &refused,
            serde_json::json!({ "jobId": refused, "imageId": image_id, "pageId": page_id,
                                "status": "failed", "diagnostics": ["the mark is empty"] }),
        )
        .await,
        StatusCode::OK
    );
    for (job_id, reason) in [
        (&missing, "assets missing"),
        (&refused, "the mark is empty"),
    ] {
        let (status, error): (String, Option<String>) =
            sqlx::query_as("SELECT status, error FROM jobs WHERE id = $1")
                .bind(job_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "FAILED");
        assert!(error.unwrap_or_default().contains(reason));
    }
    let layers: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM layers WHERE page_id = $1 AND type = 'inpainting'",
    )
    .bind(page_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(layers, 2, "only the one landed repaint added a layer");

    let _ = sqlx::query("DELETE FROM jobs WHERE page_id = $1")
        .bind(page_id)
        .execute(&pool)
        .await;
    cleanup_series(&pool, series_id).await;
}

/// H2: a repaint composites the patches under its mark into its own patch. If one of them is
/// hidden while the repaint runs, landing it would bring the hidden patch back, so the callback
/// refuses it. A repaint elsewhere on the page, with nothing changed under it, still lands.
#[tokio::test]
async fn a_repaint_is_refused_when_a_patch_under_it_changed_while_it_ran() {
    let Some((app, pool, state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let (series_id, page_id, image_id, ocr, tl) = seed_page(&pool).await;
    let region = seed_region(
        &pool,
        page_id,
        (ocr, tl),
        1,
        (20, 30, 60, 40),
        "やあ",
        "Hello",
        None,
    )
    .await;
    give_patch(
        &state,
        page_id,
        region,
        &sha('1'),
        &sha('2'),
        (18, 28, 64, 44),
    )
    .await;
    let pass = record_pass(&state, page_id, &[region]).await.unwrap();
    for digest in [sha('3'), sha('4')] {
        state
            .storage
            .upload_bytes(
                &manga_backend::page_scene_builder::scene_asset_path(page_id, &digest),
                b"png".to_vec(),
                "image/png",
            )
            .await
            .unwrap();
    }

    // Two repaints queued now: one over the patch, one in a corner it does not reach.
    let queue = |bounds: manga_backend::routes::manual_cleanup::MaskBounds| {
        let state = state.clone();
        async move {
            let digest =
                manga_backend::routes::manual_cleanup::underlay_sha256(&state, page_id, &bounds)
                    .await
                    .unwrap();
            serde_json::json!({
                "method": "telea",
                "manualMask": { "x": bounds.x, "y": bounds.y, "width": bounds.width, "height": bounds.height },
                "underlaySha256": digest,
            })
            .to_string()
        }
    };
    use manga_backend::routes::manual_cleanup::MaskBounds;
    let over = queue(MaskBounds {
        x: 30,
        y: 40,
        width: 16,
        height: 12,
    })
    .await;
    let corner = queue(MaskBounds {
        x: 0,
        y: 0,
        width: 5,
        height: 5,
    })
    .await;
    let over_job = processing_manual_job_with(&pool, page_id, image_id, &over).await;
    let corner_job = processing_manual_job_with(&pool, page_id, image_id, &corner).await;

    // The user hides the pass while both run.
    sqlx::query("UPDATE layers SET visible = FALSE WHERE id = $1")
        .bind(pass)
        .execute(&pool)
        .await
        .unwrap();

    let complete = |job_id: &str, bounds: (i64, i64, i64, i64)| {
        serde_json::json!({
            "jobId": job_id, "imageId": image_id, "pageId": page_id, "status": "complete",
            "cleanupPatchSha256": sha('3'), "cleanupPatchByteLength": 3,
            "cleanupMaskSha256": sha('4'), "cleanupMaskByteLength": 3,
            "cleanupGeneratorSha256": sha('0'),
            "cleanupBounds": { "x": bounds.0, "y": bounds.1, "width": bounds.2, "height": bounds.3 },
        })
    };
    assert_eq!(
        manual_callback(
            &app,
            &pool,
            &over_job,
            complete(&over_job, (30, 40, 16, 12))
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        manual_callback(
            &app,
            &pool,
            &corner_job,
            complete(&corner_job, (0, 0, 5, 5))
        )
        .await,
        StatusCode::OK
    );

    let status = |job_id: String| {
        let pool = pool.clone();
        async move {
            sqlx::query_as::<_, (String, Option<String>)>(
                "SELECT status, error FROM jobs WHERE id = $1",
            )
            .bind(job_id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let (over_status, over_error) = status(over_job.clone()).await;
    assert_eq!(over_status, "FAILED");
    assert!(
        over_error.unwrap_or_default().contains("mark it again"),
        "the user is told why"
    );
    assert_eq!(status(corner_job.clone()).await.0, "COMPLETED");
    let manual_patches: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM layer_elements e JOIN layers l ON l.id = e.layer_id \
         WHERE l.page_id = $1 AND l.type = 'inpainting' AND l.id <> $2",
    )
    .bind(page_id)
    .bind(pass)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(manual_patches, 1, "only the corner repaint landed");

    let _ = sqlx::query("DELETE FROM jobs WHERE page_id = $1")
        .bind(page_id)
        .execute(&pool)
        .await;
    cleanup_series(&pool, series_id).await;
}

/// A region QA kept without a cleanup patch -- typically a sound effect, which the pipeline's
/// cleanup leaves alone -- was drawn on a flat plate. After QA, such regions get one cleanup of
/// their own; it lands as patches, no translation follows, and the page re-renders as a final pass
/// so QA is not queued again. A region is never sent twice.
#[tokio::test]
async fn regions_qa_kept_without_a_patch_get_one_late_cleanup() {
    let Some((app, pool, state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let (series_id, page_id, image_id, ocr, tl) = seed_page(&pool).await;
    let kept_sfx = seed_region(
        &pool,
        page_id,
        (ocr, tl),
        1,
        (10, 10, 40, 60),
        "シュル",
        "SLUR",
        Some("passed"),
    )
    .await;
    let patched = seed_region(
        &pool,
        page_id,
        (ocr, tl),
        2,
        (60, 10, 40, 60),
        "はい",
        "Yes",
        Some("passed"),
    )
    .await;
    let rejected = seed_region(
        &pool,
        page_id,
        (ocr, tl),
        3,
        (110, 10, 40, 60),
        "ドン",
        "BOOM",
        Some("reject_sfx"),
    )
    .await;
    let review = seed_region(
        &pool,
        page_id,
        (ocr, tl),
        4,
        (10, 100, 40, 60),
        "え",
        "Eh",
        Some("cleanup_review"),
    )
    .await;
    let drawn_sfx = seed_region(
        &pool,
        page_id,
        (ocr, tl),
        5,
        (60, 100, 40, 60),
        "ゴゴ",
        "RUMBLE",
        Some("passed"),
    )
    .await;
    sqlx::query("UPDATE ocr_regions SET region_type = 'sfx' WHERE id = ANY($1)")
        .bind(vec![kept_sfx, rejected, drawn_sfx])
        .execute(&pool)
        .await
        .unwrap();
    give_patch(
        &state,
        page_id,
        patched,
        &sha('1'),
        &sha('2'),
        (60, 10, 40, 60),
    )
    .await;
    record_pass(&state, page_id, &[patched]).await;

    manga_backend::jobs::coordinator::queue_late_patches(&state, Some(page_id)).await;
    manga_backend::jobs::coordinator::queue_late_patches(&state, Some(page_id)).await;
    let jobs: Vec<(String, String)> =
        sqlx::query_as("SELECT id, payload FROM jobs WHERE page_id = $1 AND type = 'cleanup'")
            .bind(page_id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(jobs.len(), 1, "one late cleanup, and only once");
    let (job_id, payload) = &jobs[0];
    let payload: serde_json::Value = serde_json::from_str(payload).unwrap();
    let entries = payload["cleanupRegions"].as_array().unwrap();
    assert_eq!(
        entries.len(),
        2,
        "only the kept regions without a patch: {entries:?}"
    );
    assert_eq!(entries[0]["regionId"], kept_sfx.to_string());
    assert_eq!(entries[1]["regionId"], drawn_sfx.to_string());
    assert_eq!(
        entries[0]["policyAction"], "replace",
        "an SFX is cleaned once QA keeps it"
    );
    assert_eq!(payload["followUp"]["type"], "late-patch");
    let _ = review;

    // The worker runs it.
    sqlx::query("UPDATE jobs SET status = 'PROCESSING', started_at = now() WHERE id = $1")
        .bind(job_id)
        .execute(&pool)
        .await
        .unwrap();
    let (attempt, generation, lease): (Option<i32>, i32, Option<String>) =
        sqlx::query_as("SELECT attempt, input_generation, lease_token FROM jobs WHERE id = $1")
            .bind(job_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let (patch, mask) = (sha('3'), sha('4'));
    for digest in [&patch, &mask] {
        state
            .storage
            .upload_bytes(
                &manga_backend::page_scene_builder::scene_asset_path(page_id, digest),
                b"png".to_vec(),
                "image/png",
            )
            .await
            .unwrap();
    }
    let body = serde_json::json!({
        "jobId": job_id,
        "imageId": image_id,
        "pageId": page_id,
        "cleanupInputDigest": payload["cleanupInputDigest"],
        "regions": [{
            "regionId": kept_sfx,
            "inputDigest": entries[0]["inputDigest"],
            "status": "complete",
            "cleanupPatchAssetId": format!("patch-{patch}"),
            "cleanupPatchSha256": patch,
            "cleanupPatchByteLength": 3,
            "cleanupMaskAssetId": format!("mask-{mask}"),
            "cleanupMaskSha256": mask,
            "cleanupMaskByteLength": 3,
            "cleanupBounds": {"x": 10, "y": 10, "width": 40, "height": 60},
            "diagnostics": ["telea"],
        }, {
            "regionId": drawn_sfx,
            "inputDigest": entries[1]["inputDigest"],
            "status": "uncertain",
            "diagnostics": ["ctd:no-glyphs"],
        }],
    });
    let request = Request::builder()
        .method("POST")
        .uri("/tlhub/api/internal/jobs/callback/cleanup")
        .header("Content-Type", "application/json")
        .header("X-Internal-Token", INTERNAL_TOKEN)
        .header("X-Job-Id", job_id.as_str())
        .header("X-Job-Attempt", attempt.unwrap_or(1).to_string())
        .header("X-Input-Generation", generation.to_string())
        .header("X-Lease-Token", lease.unwrap_or_default())
        .body(Body::from(body.to_string()))
        .unwrap();
    let (status, text) = finish(app.clone().oneshot(request).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK, "{text}");

    let patched_now: Option<String> =
        sqlx::query_scalar("SELECT cleanup_patch_asset_id FROM ocr_regions WHERE id = $1")
            .bind(kept_sfx)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(patched_now.is_some(), "the kept SFX has its patch");
    let verdict: Option<String> =
        sqlx::query_scalar("SELECT qa_status FROM ocr_regions WHERE id = $1")
            .bind(drawn_sfx)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        verdict.as_deref(),
        Some("passed"),
        "finding no lettering does not send a kept region back to review"
    );
    let translations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE page_id = $1 AND type = 'translation'")
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        translations, 0,
        "a late patch is not followed by a translation"
    );
    let render_payload: Option<String> = sqlx::query_scalar(
        "SELECT payload FROM jobs WHERE page_id = $1 AND type = 'render' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(page_id)
    .fetch_optional(&pool)
    .await
    .unwrap();
    let render_payload: serde_json::Value =
        serde_json::from_str(&render_payload.expect("the page re-renders")).unwrap();
    assert_eq!(
        render_payload["finalPass"], true,
        "the re-render does not queue QA"
    );

    manga_backend::jobs::coordinator::queue_late_patches(&state, Some(page_id)).await;
    let cleanups: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE page_id = $1 AND type = 'cleanup'")
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(cleanups, 1, "nothing left to patch, nothing queued");

    let _ = sqlx::query("DELETE FROM page_scene_snapshots WHERE page_id = $1")
        .bind(page_id)
        .execute(&pool)
        .await;
    cleanup_series(&pool, series_id).await;
}
