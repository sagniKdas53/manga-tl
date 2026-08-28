//! ChapterExportService parity tests (ChapterExportServiceTest port): the ZIP carries
//! page images + meta-data.json with layer model/cost/qa metadata, the export id is a
//! content hash (identical rebuild = cache hit, no second upload), and success/failure
//! reaches the user as EXPORT_SUCCESS / EXPORT_ERROR pending notifications.
//!
//! Requires REAL Postgres + Valkey + the throwaway MinIO on :19000.

use axum::Router;
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

fn minio_from_env() -> Option<MinioConfig> {
    let endpoint = std::env::var("MINIO_TEST_ENDPOINT").ok()?;
    Some(MinioConfig {
        endpoint,
        external_url: None,
        access_key: Some("minioadmin".into()),
        secret_key: Some("minioadmin".into()),
    })
}

async fn app() -> Option<(Router, sqlx::PgPool, AppState, RedisService)> {
    let pool = db::connect(&db_config_from_env()?).await.ok()?;
    let addr = std::env::var("REDIS_TEST_ADDR").ok()?;
    let (host, port) = addr.split_once(':')?;
    let redis = RedisService::connect(host, port.parse().expect("numeric port"))
        .await
        .expect("redis connect");
    let minio = minio_from_env()?;
    let storage = MinioService::new(&minio);
    storage.ensure_bucket().await;
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
        storage,
        Some(std::sync::Arc::new(redis.clone())),
    );
    Some((
        manga_backend::routes::build_router(state.clone()),
        pool,
        state,
        redis,
    ))
}

/// Minimal 1x1 PNG.
fn png_bytes() -> Vec<u8> {
    const BASE64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(BASE64)
        .expect("png fixture")
}

async fn seed_chapter_with_page(pool: &sqlx::PgPool, storage: &MinioService) -> (Uuid, Uuid, Uuid) {
    sqlx::query("DELETE FROM series WHERE title LIKE '__export-e2e-%'")
        .execute(pool)
        .await
        .expect("pre-cleanup");

    let series_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language, target_language) \
         VALUES ($1, now(), now(), '__export-e2e-series__', 'rightToLeft', 'ja', 'en')",
    )
    .bind(series_id)
    .execute(pool)
    .await
    .expect("series");

    let chapter_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO chapters (id, chapter_number, title, created_at, updated_at, use_context_memory, series_id) \
         VALUES ($1, 3.0, 'Exported Chapter', now(), now(), TRUE, $2)",
    )
    .bind(chapter_id)
    .bind(series_id)
    .execute(pool)
    .await
    .expect("chapter");

    let image_id = Uuid::new_v4();
    let storage_path = format!("originals/{image_id}.png");
    sqlx::query(
        "INSERT INTO images (id, created_at, filename, storage_path, hash, width, height) \
         VALUES ($1, now(), '001.png', $2, 'hash-export', 1, 1)",
    )
    .bind(image_id)
    .bind(&storage_path)
    .execute(pool)
    .await
    .expect("image");

    // The original bytes the export will package.
    storage
        .upload_bytes(&storage_path, png_bytes(), "image/png")
        .await
        .expect("upload original");

    let page_id = Uuid::new_v4();
    sqlx::query("INSERT INTO pages (id, page_number, chapter_id, image_id) VALUES ($1, 1, $2, $3)")
        .bind(page_id)
        .bind(chapter_id)
        .bind(image_id)
        .execute(pool)
        .await
        .expect("page");

    // A translation layer carrying model/cost/qa metadata like the pipeline leaves it.
    let layer_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO layers (id, created_at, metadata_json, target_language, type, visible, z_order, page_id) \
         VALUES ($1, now(), $2, 'en', 'translation', TRUE, 1, $3)",
    )
    .bind(layer_id)
    .bind(serde_json::json!({
        "model": "test-model",
        "cost": {"estimated_cost": 0.05},
        "qa": {"status": "manual_review"}
    }))
    .bind(page_id)
    .execute(pool)
    .await
    .expect("layer");

    sqlx::query(
        "INSERT INTO layer_elements (id, text, size, font, font_style, font_weight, x, y, auto_size, word_wrap, overflow, visible, is_manually_edited, box_shape, max_width, max_height, rotation, layer_id) \
         VALUES ($1, 'Hello', 16.0, 'Comic Neue', 'normal', 'normal', 10.0, 20.0, FALSE, FALSE, FALSE, TRUE, FALSE, 'rectangular', 150, 80, 0.0, $2)",
    )
    .bind(Uuid::new_v4())
    .bind(layer_id)
    .execute(pool)
    .await
    .expect("element");

    (series_id, chapter_id, image_id)
}

async fn cleanup_series(pool: &sqlx::PgPool, series_id: Uuid) {
    let _ = sqlx::query(
        "DELETE FROM layer_elements WHERE layer_id IN (SELECT l.id FROM layers l JOIN pages p ON p.id=l.page_id WHERE p.chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
    ).bind(series_id).execute(pool).await;
    let _ = sqlx::query(
        "DELETE FROM layers WHERE page_id IN (SELECT id FROM pages WHERE chapter_id IN (SELECT id FROM chapters WHERE series_id=$1))",
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

async fn pending_notifications(redis: &RedisService, user_id: Uuid) -> Vec<serde_json::Value> {
    redis
        .list_range(&format!("notifications:user:{user_id}"))
        .await
        .unwrap_or_default()
        .iter()
        .filter_map(|j| serde_json::from_str(j).ok())
        .collect()
}

#[tokio::test]
async fn export_zip_metadata_cache_hit_and_notifications() {
    let Some((_app, pool, state, redis)) = app().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL/REDIS_TEST_ADDR/MINIO_TEST_ENDPOINT not set");
        return;
    };

    let user_id = Uuid::new_v4();
    let (series_id, chapter_id, _image_id) = seed_chapter_with_page(&pool, &state.storage).await;
    let _ = redis.delete(&format!("notifications:user:{user_id}")).await;

    // --- first build: uploads exports/{chapter}_{hash}.zip ---
    manga_backend::export::build_and_upload_export(state.clone(), chapter_id, Some(user_id), false)
        .await;

    let keys = state
        .storage
        .list_keys_under_prefix(&format!("exports/{chapter_id}_"))
        .await;
    assert_eq!(keys.len(), 1, "exactly one cached zip: {keys:?}");
    let cache_key = keys[0].clone();
    assert!(cache_key.ends_with(".zip"));
    let hash_part = cache_key
        .rsplit('_')
        .next()
        .unwrap()
        .trim_end_matches(".zip");
    assert_eq!(hash_part.len(), 64, "export id embeds a sha256 hex digest");

    // ZIP contents: the page image plus meta-data.json.
    let zip_bytes = state
        .storage
        .download_bytes(&cache_key)
        .await
        .expect("cached zip");
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).expect("zip opens");
    assert_eq!(archive.len(), 2, "one page entry + meta-data.json");
    assert!(archive.file_names().any(|n| n == "meta-data.json"));
    assert!(archive.file_names().any(|n| n.ends_with(".png")));
    let meta_json = archive.by_name("meta-data.json").expect("meta entry");
    let meta: serde_json::Value =
        serde_json::from_reader(std::io::BufReader::new(meta_json)).expect("meta-data.json parses");
    assert_eq!(meta["chapterNumber"], 3.0);
    assert_eq!(meta["chapterTitle"], "Exported Chapter");
    assert_eq!(
        meta["seriesTitle"], "__export-e2e-series__",
        "series title resolved for the document"
    );
    let pages = meta["pages"].as_array().expect("pages array");
    assert_eq!(pages.len(), 1);
    let layers = pages[0]["layers"].as_array().expect("page layers array");
    assert_eq!(layers.len(), 1);
    assert_eq!(layers[0]["model"], "test-model", "layer model recorded");
    assert_eq!(
        layers[0]["estimated_cost"], 0.05,
        "layer cost accumulated from metadata"
    );
    assert_eq!(
        layers[0]["metadataJson"]["qa"]["status"], "manual_review",
        "qa verdict travels inside metadataJson"
    );

    // Success notification queued for the offline user.
    let notes = pending_notifications(&redis, user_id).await;
    assert!(
        notes.iter().any(|n| n["type"] == "EXPORT_SUCCESS"),
        "EXPORT_SUCCESS pending: {notes:?}"
    );
    let _ = redis.delete(&format!("notifications:user:{user_id}")).await;

    // --- identical rebuild is a CACHE HIT: same object, no second upload ---
    state
        .storage
        .delete_quietly(&format!("originals/{_image_id}.png"))
        .await;
    manga_backend::export::build_and_upload_export(state.clone(), chapter_id, Some(user_id), false)
        .await;
    let keys_after = state
        .storage
        .list_keys_under_prefix(&format!("exports/{chapter_id}_"))
        .await;
    assert_eq!(
        keys_after,
        vec![cache_key.clone()],
        "cache hit keeps the object"
    );
    let notes = pending_notifications(&redis, user_id).await;
    assert!(
        notes.iter().any(|n| n["type"] == "EXPORT_SUCCESS"),
        "cache hit still notifies"
    );
    let _ = redis.delete(&format!("notifications:user:{user_id}")).await;

    // --- failure paths notify with EXPORT_ERROR ---
    let unknown = Uuid::new_v4();
    manga_backend::export::build_and_upload_export(state.clone(), unknown, Some(user_id), false)
        .await;
    let notes = pending_notifications(&redis, user_id).await;
    let error_note = notes
        .iter()
        .find(|n| n["type"] == "EXPORT_ERROR")
        .expect("EXPORT_ERROR for missing chapter");
    assert!(
        error_note["message"]
            .as_str()
            .unwrap()
            .starts_with("Chapter not found"),
        "error message names the problem: {error_note}"
    );
    let _ = redis.delete(&format!("notifications:user:{user_id}")).await;

    // Chapter without pages fails too.
    let empty_series = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language) \
         VALUES ($1, now(), now(), '__export-e2e-empty__', 'rightToLeft', 'ja')",
    )
    .bind(empty_series)
    .execute(&pool)
    .await
    .expect("empty series");
    let empty_chapter = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO chapters (id, chapter_number, created_at, updated_at, use_context_memory, series_id) \
         VALUES ($1, 1, now(), now(), TRUE, $2)",
    )
    .bind(empty_chapter)
    .bind(empty_series)
    .execute(&pool)
    .await
    .expect("empty chapter");
    manga_backend::export::build_and_upload_export(
        state.clone(),
        empty_chapter,
        Some(user_id),
        false,
    )
    .await;
    let notes = pending_notifications(&redis, user_id).await;
    let error_note = notes
        .iter()
        .find(|n| n["type"] == "EXPORT_ERROR")
        .expect("EXPORT_ERROR for empty chapter");
    assert_eq!(error_note["message"], "No pages in chapter");

    // --- clearChapterExports lists under the chapter-embedded prefix ---
    manga_backend::export::clear_chapter_exports(&state, chapter_id).await;
    let keys_after_clear = state
        .storage
        .list_keys_under_prefix(&format!("exports/{chapter_id}_"))
        .await;
    assert!(keys_after_clear.is_empty(), "clear removes the cached zip");

    let _ = redis.delete(&format!("notifications:user:{user_id}")).await;
    cleanup_series(&pool, series_id).await;
    cleanup_series(&pool, empty_series).await;
}
