//! E2 (#180) gate step 5: does the builder draw every page that has no turned region exactly as
//! the stored snapshot does?
//!
//! E2 changed the scene in two places that can touch a page OCR left level: the OCR quad
//! (`quad_for`) and float parsing (`float_roundtrip`). For every page with a snapshot at its
//! current revision, this builds the scene again inside a transaction that is rolled back and
//! compares `scene_content_digest` (what a render draws, ignoring revision and build provenance).
//! A page with a turned region is reported apart: its scene is meant to change after Redo OCR.
//!
//! Read-only for the database; the builder may upload a content-addressed legacy plate.
//!
//! ```text
//! E2_DB_URL=postgres://user:pass@127.0.0.1:55491/manga_library \
//! E2_MINIO_ENDPOINT=http://127.0.0.1:19030 E2_MINIO_SECRET=... \
//!   cargo run --example e2_scene_diff
//! ```

use serde_json::Value;
use uuid::Uuid;

use manga_backend::config::{Config, DatabaseConfig, MinioConfig, RedisConfig};
use manga_backend::jwt::JwtUtils;
use manga_backend::minio::MinioService;
use manga_backend::state::AppState;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db_url = std::env::var("E2_DB_URL")?;
    let pool = sqlx::PgPool::connect(&db_url).await?;
    let minio = MinioConfig {
        endpoint: std::env::var("E2_MINIO_ENDPOINT")?,
        external_url: None,
        access_key: Some("minioadmin".into()),
        secret_key: Some(std::env::var("E2_MINIO_SECRET")?),
    };
    let config = Config {
        context_path: "/tlhub".into(),
        port: 0,
        development: true,
        database: DatabaseConfig {
            host: "unused".into(),
            port: 0,
            name: "unused".into(),
            user: "unused".into(),
            password: "unused".into(),
        },
        jwt_secret: None,
        internal_api_token: None,
        jwt_expiration_ms: 0,
        self_hosted_admin: false,
        minio: minio.clone(),
        redis: RedisConfig {
            host: "unused".into(),
            port: 0,
        },
    };
    let state = AppState::new(
        config,
        pool.clone(),
        JwtUtils::new("unused-secret-long-enough-for-hmac-1234567890".into(), 1),
        MinioService::new(&minio),
        None,
    );

    let pages: Vec<(Uuid, i32, Value, bool)> = sqlx::query_as(
        "SELECT p.id, p.scene_revision, s.scene_json, \
           EXISTS (SELECT 1 FROM ocr_regions r WHERE r.page_id = p.id AND r.text_area_w IS NOT NULL) \
         FROM pages p \
         JOIN page_scene_snapshots s ON s.page_id = p.id AND s.revision = p.scene_revision \
         ORDER BY p.id",
    )
    .fetch_all(&pool)
    .await?;

    let (mut same, mut differ, mut turned, mut failed) = (0, Vec::new(), 0, 0);
    for (page_id, revision, before, has_turned) in &pages {
        if *has_turned {
            turned += 1;
            continue;
        }
        let mut tx = pool.begin().await?;
        let built = manga_backend::page_scene_builder::build_pipeline_scene(
            &state, &mut tx, *page_id, *revision,
        )
        .await;
        tx.rollback().await?;
        let after = match built {
            Ok(scene) => scene.validated.document,
            Err(err) => {
                failed += 1;
                eprintln!("{page_id}: build failed: {err}");
                continue;
            }
        };
        let digest = |scene: &Value| manga_backend::page_scene::scene_content_digest(scene).ok();
        if digest(before) == digest(&after) {
            same += 1;
        } else {
            differ.push(page_id.to_string());
        }
    }
    println!(
        "{} pages: {same} level pages draw the same, {} differ, {failed} failed to build, {turned} with a turned region skipped",
        pages.len(),
        differ.len()
    );
    for page in differ.iter().take(30) {
        println!("  differs: {page}");
    }
    Ok(())
}
