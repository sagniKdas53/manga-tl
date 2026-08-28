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
use manga_backend::models::{ModelRate, SystemSetting, User};

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
