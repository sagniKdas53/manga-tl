//! Real-PostgreSQL contract for transactional page-render freshness.

use manga_backend::config::DatabaseConfig;
use manga_backend::{db, page_freshness::advance_page_revision};
use uuid::Uuid;

fn db_config_from_env() -> DatabaseConfig {
    let url = std::env::var("SPRING_DATASOURCE_URL")
        .expect("SPRING_DATASOURCE_URL is required; use scripts/test-env.sh run");
    let rest = url
        .strip_prefix("jdbc:postgresql://")
        .expect("test database URL must be PostgreSQL JDBC form");
    let (hostport, name) = rest
        .split_once('/')
        .expect("test database URL must include database name");
    let (host, port) = match hostport.split_once(':') {
        Some((host, port)) => (
            host.to_string(),
            port.parse::<u16>().expect("test database port"),
        ),
        None => (hostport.to_string(), 5432),
    };
    DatabaseConfig {
        host,
        port,
        name: name.to_string(),
        user: std::env::var("SPRING_DATASOURCE_USERNAME").unwrap_or_else(|_| "postgres".into()),
        password: std::env::var("SPRING_DATASOURCE_PASSWORD").unwrap_or_default(),
    }
}

#[tokio::test]
async fn page_revision_commits_with_its_caller_transaction() {
    let pool = db::connect(&db_config_from_env())
        .await
        .expect("isolated Postgres must be reachable");

    let series_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO series (id, created_at, updated_at, title, reading_direction, original_language) \
         VALUES ($1, now(), now(), $2, 'rightToLeft', 'ja')",
    )
    .bind(series_id)
    .bind(format!("__page-freshness-{series_id}"))
    .execute(&pool)
    .await
    .expect("series");
    let chapter_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO chapters (id, chapter_number, created_at, updated_at, use_context_memory, series_id) \
         VALUES ($1, 1, now(), now(), TRUE, $2)",
    )
    .bind(chapter_id)
    .bind(series_id)
    .execute(&pool)
    .await
    .expect("chapter");
    let image_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO images (id, created_at, filename, storage_path, hash, width, height) \
         VALUES ($1, now(), 'freshness.png', $2, $3, 64, 64)",
    )
    .bind(image_id)
    .bind(format!("originals/freshness-{image_id}.png"))
    .bind(format!("hash-freshness-{image_id}"))
    .execute(&pool)
    .await
    .expect("image");
    let page_id = Uuid::new_v4();
    sqlx::query("INSERT INTO pages (id, page_number, chapter_id, image_id) VALUES ($1, 1, $2, $3)")
        .bind(page_id)
        .bind(chapter_id)
        .bind(image_id)
        .execute(&pool)
        .await
        .expect("page");

    let mut rolled_back = pool.begin().await.expect("transaction");
    assert_eq!(
        advance_page_revision(&mut rolled_back, page_id)
            .await
            .expect("revision increment"),
        1
    );
    rolled_back.rollback().await.expect("rollback");
    let after_rollback: i32 = sqlx::query_scalar("SELECT scene_revision FROM pages WHERE id = $1")
        .bind(page_id)
        .fetch_one(&pool)
        .await
        .expect("revision after rollback");
    let edited_after_rollback: bool =
        sqlx::query_scalar("SELECT last_edited_at IS NOT NULL FROM pages WHERE id = $1")
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .expect("timestamp after rollback");
    assert_eq!(after_rollback, 0, "rollback must not expose a new revision");
    assert!(
        !edited_after_rollback,
        "rollback must not expose an output-freshness timestamp"
    );

    let mut committed = pool.begin().await.expect("transaction");
    assert_eq!(
        advance_page_revision(&mut committed, page_id)
            .await
            .expect("revision increment"),
        1
    );
    committed.commit().await.expect("commit");
    let after_commit: i32 = sqlx::query_scalar("SELECT scene_revision FROM pages WHERE id = $1")
        .bind(page_id)
        .fetch_one(&pool)
        .await
        .expect("revision after commit");
    let edited_after_commit: bool =
        sqlx::query_scalar("SELECT last_edited_at IS NOT NULL FROM pages WHERE id = $1")
            .bind(page_id)
            .fetch_one(&pool)
            .await
            .expect("timestamp after commit");
    assert_eq!(after_commit, 1, "commit exposes the returned revision");
    assert!(
        edited_after_commit,
        "commit stamps the page as output-stale"
    );

    sqlx::query("DELETE FROM series WHERE id = $1")
        .bind(series_id)
        .execute(&pool)
        .await
        .expect("cleanup series");
}
