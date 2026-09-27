//! Tracker R7: the Inpainting layer, end to end against the database and storage.
//!
//! A cleanup pass becomes an Inpainting layer; the scene builder draws each visible patch where the
//! editor left it (moved, resized, faded), follows the region's own verdict (R7-D4), keeps patches
//! decoupled from text, retires an older pass to history (R7-D2/D2b), keeps a region-less patch
//! drawable through a manual_cleanup object, and keeps the flat plate only as the fallback.
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

#[tokio::test]
async fn a_region_whose_cleanup_produced_nothing_keeps_its_flat_plate() {
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
    assert_eq!(cleanups(&drawn).len(), 1, "the plate is the fallback");
    assert_eq!(
        cleanups(&drawn)[0]["bounds"],
        serde_json::json!({"x": 20, "y": 30, "width": 60, "height": 40})
    );
    assert_eq!(text_objects(&drawn)[0]["kind"], "automatic_text");
    cleanup_series(&pool, series_id).await;
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

    cleanup_series(&pool, series_id).await;
}
