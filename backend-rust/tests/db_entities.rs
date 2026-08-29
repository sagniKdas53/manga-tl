//! Schema-mapping integration tests.
//!
//! These run against a REAL Postgres (CI service container or your local compose db)
//! and prove the Phase-1 entity structs decode actual rows — guarding against column
//! drift between `database/init.sql` and `src/models.rs`, the same job Java's
//! InitScriptReconciliationTest + Hibernate `ddl-auto: validate` do on the other side.
//!
//! Each test writes probe rows inside a transaction and ROLLS BACK, leaving zero trace.
//!
//! Skipped automatically (prints "skipping") when SPRING_DATASOURCE_URL is unset, so
//! plain `cargo test` with no database still passes.

use manga_backend::config::DatabaseConfig;
use manga_backend::db;
use manga_backend::models::{ModelRate, Page, SystemSetting, User};

/// Builds a DatabaseConfig from the standard env vars; None when not configured.
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

async fn test_pool() -> Option<sqlx::PgPool> {
    let config = db_config_from_env()?;
    match db::connect(&config).await {
        Ok(pool) => Some(pool),
        Err(err) => {
            eprintln!("skipping: cannot reach database: {err}");
            None
        }
    }
}

#[tokio::test]
async fn system_setting_roundtrip_in_rolled_back_tx() {
    let Some(pool) = test_pool().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL not set");
        return;
    };

    let mut tx = pool.begin().await.expect("begin tx");
    sqlx::query(
        "INSERT INTO system_settings (setting_key, setting_value, updated_at) \
         VALUES ('__rust_probe', 'rust-was-here', now())",
    )
    .execute(&mut *tx)
    .await
    .expect("insert");

    // query_as maps the row through our struct — this is where column drift would fail.
    let setting: SystemSetting =
        sqlx::query_as("SELECT * FROM system_settings WHERE setting_key = '__rust_probe'")
            .fetch_one(&mut *tx)
            .await
            .expect("select as SystemSetting");
    assert_eq!(setting.setting_value, "rust-was-here");

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn model_rate_roundtrip_covers_f64_and_uuidless_key() {
    let Some(pool) = test_pool().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL not set");
        return;
    };

    let mut tx = pool.begin().await.expect("begin tx");
    sqlx::query(
        "INSERT INTO model_rates (model_id, provider, prompt_price, completion_price, updated_at) \
         VALUES ('__rust-probe-model', 'probe', 0.25, 0.75, now())",
    )
    .execute(&mut *tx)
    .await
    .expect("insert");

    let rate: ModelRate =
        sqlx::query_as("SELECT * FROM model_rates WHERE model_id = '__rust-probe-model'")
            .fetch_one(&mut *tx)
            .await
            .expect("select as ModelRate");
    assert_eq!(rate.prompt_price, Some(0.25));
    assert_eq!(rate.completion_price, Some(0.75));
    assert!(rate.updated_at.is_some());

    tx.rollback().await.expect("rollback");
}

#[tokio::test]
async fn user_roundtrip_covers_uuid_and_timestamptz() {
    let Some(pool) = test_pool().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL not set");
        return;
    };

    let mut tx = pool.begin().await.expect("begin tx");
    sqlx::query(
        "INSERT INTO users (id, created_at, display_name, email, password_hash, role) \
         VALUES (uuid_generate_v4(), now(), 'Rust Probe', '__rust-probe@example.invalid', 'x', 'ADMIN')",
    )
    .execute(&mut *tx)
    .await
    .expect("insert");

    let user: User =
        sqlx::query_as("SELECT * FROM users WHERE email = '__rust-probe@example.invalid'")
            .fetch_one(&mut *tx)
            .await
            .expect("select as User");
    assert_eq!(user.display_name, "Rust Probe");
    assert_eq!(user.role, "ADMIN");

    tx.rollback().await.expect("rollback");
}

/// The lookups that find a page from its image must actually RUN against the real schema.
///
/// `pages` has no `created_at` column, so `ORDER BY created_at` errored at the database.
/// Both call sites swallowed that (`unwrap_or_default()` / `.ok().flatten()`), turning a
/// broken query into "this image has no pages" — which silently disabled duplicate-image
/// cloning entirely and made every re-import of an already-known image skip the pipeline.
/// A query that cannot fail loudly has to be pinned by a test that talks to Postgres.
///
/// This one calls `resolve_page_for_callback` itself rather than restating its SQL, so
/// reverting the ORDER BY in the source fails the test. It seeds through the pool (the
/// function takes `&PgPool`, so a rolled-back tx is not visible to it) and cleans up its
/// own `__rust-probe-pageorder` rows afterwards.
#[tokio::test]
async fn page_lookups_by_image_order_by_a_column_that_exists() {
    const PROBE: &str = "__rust-probe-pageorder";

    let Some(pool) = test_pool().await else {
        eprintln!("skipping: SPRING_DATASOURCE_URL not set");
        return;
    };

    let series_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language) \
         VALUES (uuid_generate_v4(), now(), now(), $1, 'RTL', 'ja') RETURNING id",
    )
    .bind(PROBE)
    .fetch_one(&pool)
    .await
    .expect("insert series");

    let chapter_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO chapters (id, created_at, updated_at, chapter_number, title, series_id) \
         VALUES (uuid_generate_v4(), now(), now(), 1, $1, $2) RETURNING id",
    )
    .bind(PROBE)
    .bind(series_id)
    .fetch_one(&pool)
    .await
    .expect("insert chapter");

    let image_id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO images (id, created_at, filename, storage_path, hash) \
         VALUES (uuid_generate_v4(), now(), '2.webp', 'originals/probe.webp', $1) RETURNING id",
    )
    .bind(PROBE)
    .fetch_one(&pool)
    .await
    .expect("insert image");

    sqlx::query(
        "INSERT INTO pages (id, page_number, chapter_id, image_id) \
         VALUES (uuid_generate_v4(), 1, $1, $2)",
    )
    .bind(chapter_id)
    .bind(image_id)
    .execute(&pool)
    .await
    .expect("insert page");

    // The real function, with no page_id, so it takes the by-image branch.
    let resolved =
        manga_backend::jobs::coordinator::resolve_page_for_callback(&pool, image_id, None).await;

    // The shape clone::handle_duplicate_image_cloning depends on: a page-bearing image
    // must never come back as an empty Vec, or its is_empty() guard skips the pipeline.
    let all: Result<Vec<Page>, _> =
        sqlx::query_as("SELECT * FROM pages WHERE image_id = $1 ORDER BY page_number ASC")
            .bind(image_id)
            .fetch_all(&pool)
            .await;

    // Clean up before asserting, so a failure cannot leave probe rows behind.
    let _ = sqlx::query("DELETE FROM series WHERE title = $1")
        .bind(PROBE)
        .execute(&pool)
        .await;
    let _ = sqlx::query("DELETE FROM images WHERE hash = $1")
        .bind(PROBE)
        .execute(&pool)
        .await;

    assert!(
        resolved.is_some(),
        "a callback with no page_id must still resolve its page"
    );
    assert_eq!(
        all.expect("pages-by-image must not error").len(),
        1,
        "the seeded page must come back, not an empty Vec"
    );
}
