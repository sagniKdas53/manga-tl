//! F3 (#178): layer groups and merging, end to end against the database and storage.
//!
//! A hidden group hides what is in it without touching its layers' own switches, a redo overlay in
//! a hidden group gives back the text it superseded, and a merge changes nothing on the page: the
//! upper text wins, the lower is hidden and can be deleted, patches keep their paint order, and
//! unlike or half-hidden layers are refused.
//!
//! Requires REAL Postgres + Valkey + MinIO (env-gated like every integration suite).
#![allow(dead_code)]

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

fn texts(scene: &serde_json::Value) -> Vec<String> {
    let mut texts: Vec<String> = text_objects(scene)
        .iter()
        .filter_map(|o| o["text"].as_str().map(str::to_string))
        .collect();
    texts.sort();
    texts
}

async fn visible(pool: &sqlx::PgPool, element: Uuid) -> Option<bool> {
    sqlx::query_scalar("SELECT visible FROM layer_elements WHERE id = $1")
        .bind(element)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn element_of(pool: &sqlx::PgPool, layer: Uuid, region: Uuid) -> Uuid {
    sqlx::query_scalar("SELECT id FROM layer_elements WHERE layer_id = $1 AND region_id = $2")
        .bind(layer)
        .bind(region)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn groups_hide_what_they_hold_and_merges_leave_the_page_as_it_was() {
    let Some((app, pool, state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let token = translator(&pool).await;
    let (series_id, page_id, _image, ocr, base) = seed_page(&pool).await;
    let one = seed_region(
        &pool,
        page_id,
        (ocr, base),
        1,
        (10, 10, 60, 40),
        "いち",
        "one",
        None,
    )
    .await;
    let two = seed_region(
        &pool,
        page_id,
        (ocr, base),
        2,
        (100, 10, 60, 40),
        "に",
        "two",
        None,
    )
    .await;

    // A re-translation of region one on its own layer, above.
    let (status, body) = send(&app, "POST", &format!("/tlhub/api/pages/{page_id}/layers"), &token,
        serde_json::json!({"type": "translation", "targetLanguage": "en", "zOrder": 3, "name": "Translation (retry)"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let retry: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(retry["metadataJson"]["layer_name"], "Translation (retry)");
    let retry = Uuid::parse_str(retry["id"].as_str().unwrap()).unwrap();
    let (status, body) = send(&app, "POST", &format!("/tlhub/api/layers/{retry}/elements"), &token,
        serde_json::json!({"x": 10, "y": 10, "maxWidth": 60, "maxHeight": 40, "text": "one again", "regionId": one})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        texts(&scene(&state, page_id).await),
        ["one", "one again", "two"]
    );

    // Fold it into a group, created with its layer in one step.
    let (status, body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layers"),
        &token,
        serde_json::json!({"type": "group", "zOrder": 4, "name": "Re-runs", "childIds": [retry]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let group: serde_json::Value = serde_json::from_str(&body).unwrap();
    let group = Uuid::parse_str(group["id"].as_str().unwrap()).unwrap();
    let parent: Option<Uuid> = sqlx::query_scalar("SELECT parent_id FROM layers WHERE id = $1")
        .bind(retry)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(parent, Some(group));
    assert_eq!(
        texts(&scene(&state, page_id).await),
        ["one", "one again", "two"]
    );

    // Hiding the group hides what it holds; the layer's own switch is left alone.
    let (status, _) = send(
        &app,
        "PUT",
        &format!("/tlhub/api/layers/{group}"),
        &token,
        serde_json::json!({"visible": false}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(texts(&scene(&state, page_id).await), ["one", "two"]);
    let own: Option<bool> = sqlx::query_scalar("SELECT visible FROM layers WHERE id = $1")
        .bind(retry)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(own, Some(true));
    let (status, _) = send(
        &app,
        "PUT",
        &format!("/tlhub/api/layers/{group}"),
        &token,
        serde_json::json!({"visible": true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        texts(&scene(&state, page_id).await),
        ["one", "one again", "two"]
    );

    // Groups do not nest, and only a group can hold a layer.
    let (_, body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layers"),
        &token,
        serde_json::json!({"type": "group", "zOrder": 5}),
    )
    .await;
    let other: serde_json::Value = serde_json::from_str(&body).unwrap();
    let other = other["id"].as_str().unwrap().to_string();
    for (layer, parent) in [
        (other.clone(), group.to_string()),
        (base.to_string(), base.to_string()),
        (base.to_string(), retry.to_string()),
    ] {
        let (status, body) = send(
            &app,
            "PUT",
            &format!("/tlhub/api/layers/{layer}"),
            &token,
            serde_json::json!({"parentId": parent}),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{layer} into {parent}: {body}"
        );
    }
    let (status, _) = send(
        &app,
        "PUT",
        &format!("/tlhub/api/layers/{base}"),
        &token,
        serde_json::json!({"name": "Translation (EN)"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // A text layer never merges with a patch layer or an OCR layer, and a hidden layer never
    // merges into a shown one.
    let (status, _) = send(
        &app,
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layers/merge"),
        &token,
        serde_json::json!({"layerIds": [base, ocr]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layers"),
        &token,
        serde_json::json!({"type": "translation", "zOrder": 6, "visible": false}),
    )
    .await;
    let hidden_layer: serde_json::Value = serde_json::from_str(&body).unwrap();
    let (status, _) = send(
        &app,
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layers/merge"),
        &token,
        serde_json::json!({"layerIds": [base, hidden_layer["id"]]}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Merge the re-run down: the page is unchanged, the lower "one" is kept hidden.
    let base_one = element_of(&pool, base, one).await;
    let (status, body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layers/merge"),
        &token,
        serde_json::json!({"layerIds": [retry, base]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let merged: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(merged["hiddenTexts"], 1);
    assert_eq!(merged["hiddenRegions"], 1);
    assert_eq!(merged["layer"]["id"], base.to_string());
    assert_eq!(
        merged["layer"]["metadataJson"]["layer_name"],
        "Translation (EN)"
    );
    assert_eq!(
        merged["layer"]["metadataJson"]["merge_hidden"],
        serde_json::json!([base_one])
    );
    assert_eq!(texts(&scene(&state, page_id).await), ["one again", "two"]);
    assert_eq!(visible(&pool, base_one).await, Some(false));
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM layers WHERE id = $1")
        .bind(retry)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);

    // D2's follow-up: delete the hidden texts.
    let (status, body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/layers/{base}/delete-hidden-texts"),
        &token,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&body).unwrap()["deleted"],
        1
    );
    let gone: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM layer_elements WHERE id = $1")
        .bind(base_one)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(gone, 0);
    assert_eq!(texts(&scene(&state, page_id).await), ["one again", "two"]);

    // A redo overlay inside a group: hiding the group gives back the text it superseded.
    let base_two = element_of(&pool, base, two).await;
    let overlay = Uuid::new_v4();
    sqlx::query("INSERT INTO layers (id, type, visible, z_order, metadata_json, page_id, created_at, parent_id) VALUES ($1,'translation',TRUE,7,$2,$3,now(),$4)")
        .bind(overlay)
        .bind(serde_json::json!({"overlay": true, "region_id": two.to_string(), "superseded_elements": [base_two.to_string()]}))
        .bind(page_id)
        .bind(group)
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, layer_id, region_id) VALUES (uuid_generate_v4(),'two redone',100,10,60,40,TRUE,$1,$2)")
        .bind(overlay).bind(two).execute(&pool).await.unwrap();
    sqlx::query("UPDATE layer_elements SET visible = FALSE WHERE id = $1")
        .bind(base_two)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        texts(&scene(&state, page_id).await),
        ["one again", "two redone"]
    );
    let (status, _) = send(
        &app,
        "PUT",
        &format!("/tlhub/api/layers/{group}"),
        &token,
        serde_json::json!({"visible": false}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(texts(&scene(&state, page_id).await), ["one again", "two"]);
    let (status, _) = send(
        &app,
        "PUT",
        &format!("/tlhub/api/layers/{group}"),
        &token,
        serde_json::json!({"visible": true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        texts(&scene(&state, page_id).await),
        ["one again", "two redone"]
    );
    // Deleting the group keeps its layers, out of the group.
    let (status, _) = send(
        &app,
        "DELETE",
        &format!("/tlhub/api/layers/{group}"),
        &token,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let parent: Option<Uuid> = sqlx::query_scalar("SELECT parent_id FROM layers WHERE id = $1")
        .bind(overlay)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(parent, None);
    assert_eq!(
        texts(&scene(&state, page_id).await),
        ["one again", "two redone"]
    );

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn merged_patch_layers_keep_every_patch_in_paint_order() {
    let Some((app, pool, state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let token = translator(&pool).await;
    let (series_id, page_id, _image, ocr, base) = seed_page(&pool).await;
    let one = seed_region(
        &pool,
        page_id,
        (ocr, base),
        1,
        (10, 10, 60, 40),
        "いち",
        "one",
        None,
    )
    .await;
    let two = seed_region(
        &pool,
        page_id,
        (ocr, base),
        2,
        (20, 20, 60, 40),
        "に",
        "two",
        None,
    )
    .await;
    give_patch(&state, page_id, one, &sha('1'), &sha('a'), (10, 10, 60, 40)).await;
    give_patch(&state, page_id, two, &sha('2'), &sha('b'), (20, 20, 60, 40)).await;
    // One pass per region, so both layers stay shown.
    let lower = record_pass(&state, page_id, &[one]).await.unwrap();
    let upper = record_pass(&state, page_id, &[two]).await.unwrap();
    let before: Vec<String> = cleanups(&scene(&state, page_id).await)
        .iter()
        .map(|c| c["patch_asset_id"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(before.len(), 2);

    let (status, body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layers/merge"),
        &token,
        serde_json::json!({"layerIds": [lower, upper]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let orders: Vec<(Option<Uuid>, i64)> = sqlx::query_as(
        "SELECT region_id, (cleanup_ref->>'order')::bigint FROM layer_elements WHERE layer_id = $1 ORDER BY 2")
        .bind(lower).fetch_all(&pool).await.unwrap();
    assert_eq!(orders, vec![(Some(one), 0), (Some(two), 1)]);
    let after: Vec<String> = cleanups(&scene(&state, page_id).await)
        .iter()
        .map(|c| c["patch_asset_id"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(after, before, "the same patches, painted in the same order");

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn a_merge_that_would_skip_a_shown_like_layer_is_refused() {
    let Some((app, pool, _state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let token = translator(&pool).await;
    let (series_id, page_id, _image, _ocr, base) = seed_page(&pool).await;
    let mut above = Vec::new();
    for z in [3, 4] {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, created_at) \
             VALUES ($1, 'translation', 'en', TRUE, $2, '{}'::jsonb, $3, now())",
        )
        .bind(id)
        .bind(z)
        .bind(page_id)
        .execute(&pool)
        .await
        .expect("layer");
        above.push(id);
    }
    let (middle, top) = (above[0], above[1]);
    let merge = |ids: Vec<Uuid>| {
        let app = app.clone();
        let token = token.clone();
        async move {
            send(
                &app,
                "POST",
                &format!("/tlhub/api/pages/{page_id}/layers/merge"),
                &token,
                serde_json::json!({ "layerIds": ids }),
            )
            .await
        }
    };

    // top's text would move under middle's.
    let (status, body) = merge(vec![base, top]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.contains("lies between"), "{body}");

    // With middle hidden it paints nothing, so the merge changes nothing on the page.
    sqlx::query("UPDATE layers SET visible = FALSE WHERE id = $1")
        .bind(middle)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = merge(vec![base, top]).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn a_patch_whose_order_is_not_a_number_is_left_alone_by_a_merge() {
    let Some((app, pool, state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let token = translator(&pool).await;
    let (series_id, page_id, _image, ocr, base) = seed_page(&pool).await;
    let one = seed_region(
        &pool,
        page_id,
        (ocr, base),
        1,
        (10, 10, 60, 40),
        "いち",
        "one",
        None,
    )
    .await;
    let two = seed_region(
        &pool,
        page_id,
        (ocr, base),
        2,
        (20, 20, 60, 40),
        "に",
        "two",
        None,
    )
    .await;
    give_patch(&state, page_id, one, &sha('1'), &sha('a'), (10, 10, 60, 40)).await;
    give_patch(&state, page_id, two, &sha('2'), &sha('b'), (20, 20, 60, 40)).await;
    let lower = record_pass(&state, page_id, &[one]).await.unwrap();
    let upper = record_pass(&state, page_id, &[two]).await.unwrap();
    let bad = patch_element(&pool, upper).await;
    sqlx::query(
        "UPDATE layer_elements SET cleanup_ref = jsonb_set(cleanup_ref, '{order}', '\"x\"') WHERE id = $1",
    )
    .bind(bad)
    .execute(&pool)
    .await
    .unwrap();

    let (status, body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layers/merge"),
        &token,
        serde_json::json!({"layerIds": [lower, upper]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let order: Option<String> =
        sqlx::query_scalar("SELECT cleanup_ref->>'order' FROM layer_elements WHERE id = $1")
            .bind(bad)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(order.as_deref(), Some("x"), "the ref is kept, not nulled");

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn layers_in_a_hidden_group_merge_only_with_the_same_own_switch() {
    let Some((app, pool, _state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let token = translator(&pool).await;
    let (series_id, page_id, _image, _ocr, _base) = seed_page(&pool).await;
    let group = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO layers (id, type, visible, z_order, metadata_json, page_id, created_at) \
         VALUES ($1, 'group', FALSE, 9, '{}'::jsonb, $2, now())",
    )
    .bind(group)
    .bind(page_id)
    .execute(&pool)
    .await
    .expect("group");
    let mut held = Vec::new();
    for (z, own) in [(3, true), (4, false)] {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, parent_id, created_at) \
             VALUES ($1, 'translation', 'en', $2, $3, '{}'::jsonb, $4, $5, now())",
        )
        .bind(id)
        .bind(own)
        .bind(z)
        .bind(page_id)
        .bind(group)
        .execute(&pool)
        .await
        .expect("layer");
        held.push(id);
    }
    // Both are hidden while the group is, but showing the group would show only one of them.
    let (status, body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layers/merge"),
        &token,
        serde_json::json!({"layerIds": held}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.contains("own switches differ"), "{body}");

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn layers_hidden_only_by_their_group_may_not_skip_a_shown_like_layer() {
    let Some((app, pool, _state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let token = translator(&pool).await;
    let (series_id, page_id, _image, _ocr, _base) = seed_page(&pool).await;
    let group = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO layers (id, type, visible, z_order, metadata_json, page_id, created_at) \
         VALUES ($1, 'group', FALSE, 9, '{}'::jsonb, $2, now())",
    )
    .bind(group)
    .bind(page_id)
    .execute(&pool)
    .await
    .expect("group");
    let mut held = Vec::new();
    for (z, parent) in [(3, Some(group)), (4, None), (5, Some(group))] {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, parent_id, created_at) \
             VALUES ($1, 'translation', 'en', TRUE, $2, '{}'::jsonb, $3, $4, now())",
        )
        .bind(id)
        .bind(z)
        .bind(page_id)
        .bind(parent)
        .execute(&pool)
        .await
        .expect("layer");
        if parent.is_some() {
            held.push(id);
        }
    }
    let merge = || {
        let (app, token, held) = (app.clone(), token.clone(), held.clone());
        async move {
            send(
                &app,
                "POST",
                &format!("/tlhub/api/pages/{page_id}/layers/merge"),
                &token,
                serde_json::json!({ "layerIds": held }),
            )
            .await
        }
    };

    // Showing the group would put the upper layer's text under the loose layer between them.
    let (status, body) = merge().await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body.contains("lies between"), "{body}");

    // With their own switches off, showing the group shows neither, so the merge may go ahead.
    sqlx::query("UPDATE layers SET visible = FALSE WHERE id = ANY($1)")
        .bind(&held)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = merge().await;
    assert_eq!(status, StatusCode::OK, "{body}");

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn text_the_canvas_hides_covers_nothing_in_a_merge() {
    let Some((app, pool, state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let token = translator(&pool).await;
    let (series_id, page_id, _image, ocr, base) = seed_page(&pool).await;
    let region = seed_region(
        &pool,
        page_id,
        (ocr, base),
        1,
        (10, 10, 60, 40),
        "いち",
        "one",
        None,
    )
    .await;
    let upper = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, created_at) \
         VALUES ($1, 'translation', 'en', TRUE, 3, '{}'::jsonb, $2, now())",
    )
    .bind(upper)
    .bind(page_id)
    .execute(&pool)
    .await
    .expect("layer");
    // A null switch is hidden (AUDIT-F25): the canvas, the hidden count and the worker skip it.
    sqlx::query(
        "INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, layer_id, region_id) \
         VALUES (uuid_generate_v4(), 'one again', 10, 10, 60, 40, NULL, $1, $2)",
    )
    .bind(upper)
    .bind(region)
    .execute(&pool)
    .await
    .expect("element");
    let lower = element_of(&pool, base, region).await;

    let (status, body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layers/merge"),
        &token,
        serde_json::json!({ "layerIds": [base, upper] }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let merged: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(merged["hiddenTexts"], 0);
    assert_eq!(visible(&pool, lower).await, Some(true));
    // The export draws what the canvas does: the merge wrote the null down as hidden, so the scene
    // builder (which still reads a null as shown) leaves it out of the merged layer too.
    assert_eq!(texts(&scene(&state, page_id).await), ["one"]);

    cleanup_series(&pool, series_id).await;
}

// ---------------------------------------------------------------------------------------------
// F4 (#178): layer undo and redo that survive a reload.
// ---------------------------------------------------------------------------------------------

/// Every layer and element row of the page, without what the pipeline rewrites on its own
/// (`size`, `metadata_json.last_modified`), keyed by table and id.
async fn page_rows(
    pool: &sqlx::PgPool,
    page_id: Uuid,
) -> std::collections::BTreeMap<String, serde_json::Value> {
    let rows: Vec<(String, serde_json::Value)> = sqlx::query_as(
        "SELECT 'layer:' || l.id, to_jsonb(l) #- '{metadata_json,last_modified}' \
         FROM layers l WHERE l.page_id = $1 \
         UNION ALL \
         SELECT 'element:' || e.id, to_jsonb(e) - 'size' \
         FROM layer_elements e JOIN layers l ON l.id = e.layer_id WHERE l.page_id = $1",
    )
    .bind(page_id)
    .fetch_all(pool)
    .await
    .unwrap();
    rows.into_iter().collect()
}

async fn history(app: &Router, token: &str, page_id: Uuid) -> serde_json::Value {
    let (status, body) = send(
        app,
        "GET",
        &format!("/tlhub/api/pages/{page_id}/layer-history"),
        token,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_str(&body).unwrap()
}

async fn step(app: &Router, token: &str, page_id: Uuid, which: &str) -> (StatusCode, String) {
    send(
        app,
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layer-history/{which}"),
        token,
        serde_json::json!({}),
    )
    .await
}

async fn add_text_layer(pool: &sqlx::PgPool, page_id: Uuid, z: i32) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, created_at) \
         VALUES ($1, 'translation', 'en', TRUE, $2, '{}'::jsonb, $3, now())",
    )
    .bind(id)
    .bind(z)
    .bind(page_id)
    .execute(pool)
    .await
    .expect("layer");
    id
}

#[tokio::test]
async fn undo_puts_a_merge_back_row_for_row_and_redo_merges_again() {
    let Some((app, pool, state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let token = translator(&pool).await;
    let (series_id, page_id, _image, ocr, base) = seed_page(&pool).await;
    let one = seed_region(
        &pool,
        page_id,
        (ocr, base),
        1,
        (10, 10, 60, 40),
        "いち",
        "one",
        None,
    )
    .await;
    let two = seed_region(
        &pool,
        page_id,
        (ocr, base),
        2,
        (100, 10, 60, 40),
        "に",
        "two",
        None,
    )
    .await;
    // A re-translation over region one: merging hides base's lower text.
    let upper = add_text_layer(&pool, page_id, 3).await;
    sqlx::query("INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, layer_id, region_id) VALUES (uuid_generate_v4(),'one again',10,10,60,40,TRUE,$1,$2)")
        .bind(upper).bind(one).execute(&pool).await.unwrap();
    // A null switch, which the merge writes down as hidden: undo must put the null back.
    sqlx::query("INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, layer_id) VALUES (uuid_generate_v4(),'never shown',200,10,60,40,NULL,$1)")
        .bind(upper).execute(&pool).await.unwrap();
    // A redo overlay over region two, superseding base's text.
    let base_two = element_of(&pool, base, two).await;
    let overlay = Uuid::new_v4();
    sqlx::query("INSERT INTO layers (id, type, visible, z_order, metadata_json, page_id, created_at) VALUES ($1,'translation',TRUE,7,$2,$3,now())")
        .bind(overlay)
        .bind(serde_json::json!({"overlay": true, "region_id": two.to_string(), "superseded_elements": [base_two.to_string()]}))
        .bind(page_id)
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, layer_id, region_id) VALUES (uuid_generate_v4(),'two redone',100,10,60,40,TRUE,$1,$2)")
        .bind(overlay).bind(two).execute(&pool).await.unwrap();
    sqlx::query("UPDATE layer_elements SET visible = FALSE WHERE id = $1")
        .bind(base_two)
        .execute(&pool)
        .await
        .unwrap();
    // Two patch layers.
    give_patch(&state, page_id, one, &sha('1'), &sha('a'), (10, 10, 60, 40)).await;
    give_patch(
        &state,
        page_id,
        two,
        &sha('2'),
        &sha('b'),
        (100, 10, 60, 40),
    )
    .await;
    let lower_patches = record_pass(&state, page_id, &[one]).await.unwrap();
    let upper_patches = record_pass(&state, page_id, &[two]).await.unwrap();

    let start = page_rows(&pool, page_id).await;
    let scene_start = texts(&scene(&state, page_id).await);
    let merge = |ids: Vec<Uuid>| {
        let app = app.clone();
        let token = token.clone();
        async move {
            send(
                &app,
                "POST",
                &format!("/tlhub/api/pages/{page_id}/layers/merge"),
                &token,
                serde_json::json!({ "layerIds": ids }),
            )
            .await
        }
    };
    let (status, body) = merge(vec![base, upper, overlay]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let text_merged = page_rows(&pool, page_id).await;
    let never_shown: Option<bool> = sqlx::query_scalar(
        "SELECT visible FROM layer_elements WHERE layer_id = $1 AND text = 'never shown'",
    )
    .bind(base)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(never_shown, Some(false), "the merge wrote the null down");
    let (status, body) = merge(vec![lower_patches, upper_patches]).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let both_merged = page_rows(&pool, page_id).await;

    // What the render callback and an element save do on their own: not edits.
    sqlx::query("UPDATE layer_elements SET size = 33 WHERE layer_id = $1")
        .bind(base)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE layers SET metadata_json = jsonb_set(metadata_json, '{last_modified}', '\"later\"') WHERE id = $1")
        .bind(base).execute(&pool).await.unwrap();

    let sized: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM layer_elements e JOIN layers l ON l.id = e.layer_id WHERE l.page_id = $1 AND e.size = 33")
        .bind(page_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let status_now = history(&app, &token, page_id).await;
    assert_eq!(status_now["undo"]["label"], "merge 2 layers");
    assert_eq!(status_now["undo"]["blocked"], serde_json::Value::Null);
    assert_eq!(status_now["undoCount"], 2);

    let (status, body) = step(&app, &token, page_id, "undo").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        page_rows(&pool, page_id).await,
        text_merged,
        "the patch merge is undone"
    );
    let (status, body) = step(&app, &token, page_id, "undo").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        page_rows(&pool, page_id).await,
        start,
        "every layer and element is back as it was"
    );
    assert_eq!(texts(&scene(&state, page_id).await), scene_start);
    // What the pipeline wrote since is kept: undo puts back what the action changed, not the fit.
    let still_sized: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM layer_elements e JOIN layers l ON l.id = e.layer_id WHERE l.page_id = $1 AND e.size = 33")
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(still_sized, sized, "undo kept the render callback's sizes");
    let modified: Option<String> =
        sqlx::query_scalar("SELECT metadata_json->>'last_modified' FROM layers WHERE id = $1")
            .bind(base)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(modified.as_deref(), Some("later"));
    let (status, body) = step(&app, &token, page_id, "undo").await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(body.contains("no layer action to undo"), "{body}");

    let (status, body) = step(&app, &token, page_id, "redo").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(page_rows(&pool, page_id).await, text_merged);
    let (status, body) = step(&app, &token, page_id, "redo").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        page_rows(&pool, page_id).await,
        both_merged,
        "redo merges again"
    );
    let status_now = history(&app, &token, page_id).await;
    assert_eq!(status_now["redo"], serde_json::Value::Null);

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn an_action_whose_rows_changed_since_says_why_it_cannot_be_undone() {
    let Some((app, pool, _state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let token = translator(&pool).await;
    let (series_id, page_id, _image, ocr, base) = seed_page(&pool).await;
    let one = seed_region(
        &pool,
        page_id,
        (ocr, base),
        1,
        (10, 10, 60, 40),
        "いち",
        "one",
        None,
    )
    .await;
    let upper = add_text_layer(&pool, page_id, 3).await;
    // Text for region one on the upper layer, so the merge moves it and hides base's.
    let moved = Uuid::new_v4();
    sqlx::query("INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, layer_id, region_id) VALUES ($1,'one again',10,10,60,40,TRUE,$2,$3)")
        .bind(moved).bind(upper).bind(one).execute(&pool).await.unwrap();
    let (status, body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layers/merge"),
        &token,
        serde_json::json!({"layerIds": [base, upper]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Showing or hiding the merged layer: switch it back and the undo works again.
    for visible in [false, true] {
        let (status, _) = send(
            &app,
            "PUT",
            &format!("/tlhub/api/layers/{base}"),
            &token,
            serde_json::json!({"visible": visible}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let blocked = history(&app, &token, page_id).await["undo"]["blocked"].clone();
        if visible {
            assert_eq!(blocked, serde_json::Value::Null);
        } else {
            assert!(
                blocked.as_str().unwrap().contains("shown or hidden since"),
                "{blocked}"
            );
        }
    }
    // An edit to a text the merge moved.
    let element = moved;
    let (status, body) = send(
        &app,
        "PUT",
        &format!("/tlhub/api/layer-elements/{element}"),
        &token,
        serde_json::json!({"text": "edited"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let blocked = history(&app, &token, page_id).await["undo"]["blocked"].clone();
    assert!(
        blocked.as_str().unwrap().contains("edited since"),
        "{blocked}"
    );
    let (status, body) = step(&app, &token, page_id, "undo").await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(body.contains("edited since"), "{body}");

    // A layer added, then given content: undoing the add would delete that content.
    let (status, body) = send(&app, "POST", &format!("/tlhub/api/pages/{page_id}/layers"), &token, serde_json::json!({"type": "translation", "targetLanguage": "en", "zOrder": 9, "visible": true})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let added: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        history(&app, &token, page_id).await["undo"]["label"],
        "add a layer"
    );
    let added = added["id"].as_str().unwrap().to_string();
    let (status, body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/layers/{added}/elements"),
        &token,
        serde_json::json!({"text": "new", "x": 1.0, "y": 1.0, "maxWidth": 10, "maxHeight": 10}),
    )
    .await;
    assert!(status.is_success(), "{status} {body}");
    let blocked = history(&app, &token, page_id).await["undo"]["blocked"].clone();
    assert!(
        blocked.as_str().unwrap().contains("content added since"),
        "{blocked}"
    );

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn the_history_keeps_twenty_actions_and_one_reorder_is_one() {
    let Some((app, pool, _state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let token = translator(&pool).await;
    let (series_id, page_id, _image, ocr, base) = seed_page(&pool).await;
    for n in 0..22 {
        let (status, _) = send(
            &app,
            "PUT",
            &format!("/tlhub/api/layers/{base}"),
            &token,
            serde_json::json!({"name": format!("TL {n}")}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    let now = history(&app, &token, page_id).await;
    assert_eq!(now["undoCount"], 20);
    assert_eq!(now["undo"]["label"], "rename a layer");
    // A visibility switch is not an action.
    let (status, _) = send(
        &app,
        "PUT",
        &format!("/tlhub/api/layers/{ocr}"),
        &token,
        serde_json::json!({"visible": false}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(history(&app, &token, page_id).await["undoCount"], 20);

    // A swap sent as two requests with one batch id is one step.
    let put_z = |layer: Uuid, z: i32| {
        let app = app.clone();
        let token = token.clone();
        async move {
            let request = Request::builder()
                .method("PUT")
                .uri(format!("/tlhub/api/layers/{layer}"))
                .header("Content-Type", "application/json")
                .header("Authorization", format!("Bearer {token}"))
                .header("X-Layer-Op-Batch", "swap-1")
                .body(Body::from(serde_json::json!({"zOrder": z}).to_string()))
                .unwrap();
            finish(app.oneshot(request).await.unwrap()).await
        }
    };
    let z_of = |layer: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, i32>("SELECT z_order FROM layers WHERE id = $1")
                .bind(layer)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    let (ocr_z, base_z) = (z_of(ocr).await, z_of(base).await);
    assert_eq!(put_z(ocr, base_z).await.0, StatusCode::OK);
    assert_eq!(put_z(base, ocr_z).await.0, StatusCode::OK);
    let now = history(&app, &token, page_id).await;
    assert_eq!(now["undo"]["label"], "reorder layers");
    assert_eq!(now["undoCount"], 20);
    let (status, body) = step(&app, &token, page_id, "undo").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        (z_of(ocr).await, z_of(base).await),
        (ocr_z, base_z),
        "both layers move back"
    );
    // A new action drops what was undone.
    assert_eq!(history(&app, &token, page_id).await["redoCount"], 1);
    let (status, _) = send(
        &app,
        "PUT",
        &format!("/tlhub/api/layers/{base}"),
        &token,
        serde_json::json!({"name": "after"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(history(&app, &token, page_id).await["redoCount"], 0);

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn undoing_an_overlay_delete_hides_the_text_it_had_given_back() {
    let Some((app, pool, state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let token = translator(&pool).await;
    let (series_id, page_id, _image, ocr, base) = seed_page(&pool).await;
    let two = seed_region(
        &pool,
        page_id,
        (ocr, base),
        1,
        (100, 10, 60, 40),
        "に",
        "two",
        None,
    )
    .await;
    let base_two = element_of(&pool, base, two).await;
    let overlay = Uuid::new_v4();
    sqlx::query("INSERT INTO layers (id, type, visible, z_order, metadata_json, page_id, created_at) VALUES ($1,'translation',TRUE,7,$2,$3,now())")
        .bind(overlay)
        .bind(serde_json::json!({"overlay": true, "region_id": two.to_string(), "superseded_elements": [base_two.to_string()]}))
        .bind(page_id)
        .execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, layer_id, region_id) VALUES (uuid_generate_v4(),'two redone',100,10,60,40,TRUE,$1,$2)")
        .bind(overlay).bind(two).execute(&pool).await.unwrap();
    sqlx::query("UPDATE layer_elements SET visible = FALSE WHERE id = $1")
        .bind(base_two)
        .execute(&pool)
        .await
        .unwrap();
    let start = page_rows(&pool, page_id).await;

    let (status, _) = send(
        &app,
        "DELETE",
        &format!("/tlhub/api/layers/{overlay}"),
        &token,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        texts(&scene(&state, page_id).await),
        ["two"],
        "the delete gave base's text back"
    );
    assert_eq!(
        history(&app, &token, page_id).await["undo"]["label"],
        "delete a layer"
    );

    let (status, body) = step(&app, &token, page_id, "undo").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(page_rows(&pool, page_id).await, start);
    assert_eq!(texts(&scene(&state, page_id).await), ["two redone"]);
    assert_eq!(visible(&pool, base_two).await, Some(false));

    cleanup_series(&pool, series_id).await;
}

#[tokio::test]
async fn a_switch_that_lands_during_an_undo_is_never_written_over() {
    let Some((app, pool, _state)) = app().await else {
        eprintln!(
            "skipping: SPRING_DATASOURCE_URL / REDIS_TEST_ADDR / MINIO_TEST_ENDPOINT not set"
        );
        return;
    };
    let token = translator(&pool).await;
    let (series_id, page_id, _image, ocr, base) = seed_page(&pool).await;
    let one = seed_region(
        &pool,
        page_id,
        (ocr, base),
        1,
        (10, 10, 60, 40),
        "いち",
        "one",
        None,
    )
    .await;
    let upper = add_text_layer(&pool, page_id, 3).await;
    sqlx::query("INSERT INTO layer_elements (id, text, x, y, max_width, max_height, visible, layer_id, region_id) VALUES (uuid_generate_v4(),'one again',10,10,60,40,TRUE,$1,$2)")
        .bind(upper).bind(one).execute(&pool).await.unwrap();
    let (status, body) = send(
        &app,
        "POST",
        &format!("/tlhub/api/pages/{page_id}/layers/merge"),
        &token,
        serde_json::json!({"layerIds": [base, upper]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // A show/hide (no history lock) is in flight when the undo starts.
    let mut switch = pool.begin().await.unwrap();
    sqlx::query("UPDATE layers SET visible = FALSE WHERE id = $1")
        .bind(base)
        .execute(&mut *switch)
        .await
        .unwrap();
    let switch_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *switch)
        .await
        .unwrap();
    let undo = {
        let (app, token) = (app.clone(), token.clone());
        tokio::spawn(async move { step(&app, &token, page_id, "undo").await })
    };
    // Commit only once the undo is seen waiting on the switch's row lock.
    let mut waited = false;
    for _ in 0..100 {
        waited = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)))",
        )
        .bind(switch_pid)
        .fetch_one(&pool)
        .await
        .unwrap();
        if waited {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(waited, "the undo never waited on the switch");
    switch.commit().await.unwrap();
    let (status, body) = undo.await.unwrap();
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(body.contains("shown or hidden since"), "{body}");
    let visible: Option<bool> = sqlx::query_scalar("SELECT visible FROM layers WHERE id = $1")
        .bind(base)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(visible, Some(false), "the switch stands");

    cleanup_series(&pool, series_id).await;
}
