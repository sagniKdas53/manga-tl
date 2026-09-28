//! One-off backfill (2026-09-28): pages cloned from an already-processed image before
//! `clone::clone_cleanup_data` existed got their OCR regions but no cleanup, so they were
//! translated with the Japanese still on them. This copies each page's cleanup from a sibling page
//! of the same image through the same function the clone path now uses.
//!
//! Regions are paired by identical box (the clone copies it verbatim; later passes may rewrite
//! the text). A page that
//! already has a patch is skipped, so re-running is harmless.
//!
//!   backfill_clone_cleanup --chapter <uuid> [--dry-run] [--rerender] <page_number>...
//!
//! Reads the same environment as the backend (run it inside the backend container). `--rerender`
//! advances each changed page's revision, which queues a render and so a paid QA pass.

use std::collections::HashMap;

use manga_backend::config::Config;
use manga_backend::models::OcrRegion;
use sqlx::PgPool;
use uuid::Uuid;

struct Plan {
    source_page: Uuid,
    region_map: HashMap<Uuid, Uuid>,
    patched_matches: usize,
}

/// The box only: QA re-OCR and region redo rewrite a cloned region's text in place, but never its
/// box, and the patch belongs to the box.
fn key(region: &OcrRegion) -> (i32, i32, i32, i32) {
    (region.bbox_x, region.bbox_y, region.bbox_w, region.bbox_h)
}

async fn regions(pool: &PgPool, page_id: Uuid) -> Vec<OcrRegion> {
    sqlx::query_as("SELECT * FROM ocr_regions WHERE page_id = $1")
        .bind(page_id)
        .fetch_all(pool)
        .await
        .expect("regions")
}

/// The sibling page whose patched regions pair with the most of this page's regions.
async fn plan_for(pool: &PgPool, target_page: Uuid, image_id: Uuid) -> Option<Plan> {
    let targets = regions(pool, target_page).await;
    let siblings: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM pages WHERE image_id = $1 AND id <> $2 ORDER BY id")
            .bind(image_id)
            .bind(target_page)
            .fetch_all(pool)
            .await
            .expect("siblings");
    let mut best: Option<Plan> = None;
    for sibling in siblings {
        let sources = regions(pool, sibling).await;
        let mut region_map = HashMap::new();
        let mut patched_matches = 0;
        for target in &targets {
            let matching: Vec<&OcrRegion> =
                sources.iter().filter(|s| key(s) == key(target)).collect();
            if let [source] = matching.as_slice() {
                region_map.insert(source.id, target.id);
                if source.cleanup_patch_sha256.is_some() {
                    patched_matches += 1;
                }
            }
        }
        if patched_matches > best.as_ref().map_or(0, |b| b.patched_matches) {
            best = Some(Plan {
                source_page: sibling,
                region_map,
                patched_matches,
            });
        }
    }
    best
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let (mut chapter, mut dry_run, mut rerender, mut numbers) = (None, false, false, Vec::new());
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--chapter" => chapter = args.next().and_then(|v| v.parse::<Uuid>().ok()),
            "--dry-run" => dry_run = true,
            "--rerender" => rerender = true,
            n => numbers.push(n.parse::<i32>().expect("page numbers are integers")),
        }
    }
    let chapter = chapter.expect("--chapter <uuid> is required");

    let config = Config::load().unwrap_or_else(|problems| panic!("config: {problems:?}"));
    let pool = manga_backend::db::connect(&config.database)
        .await
        .expect("database");
    let storage = manga_backend::minio::MinioService::new(&config.minio);

    for number in numbers {
        let Some((page_id, image_id)): Option<(Uuid, Uuid)> = sqlx::query_as(
            "SELECT id, image_id FROM pages WHERE chapter_id = $1 AND page_number = $2",
        )
        .bind(chapter)
        .bind(number)
        .fetch_optional(&pool)
        .await
        .expect("page") else {
            println!("page {number}: not found");
            continue;
        };
        let already: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM ocr_regions WHERE page_id = $1 AND cleanup_patch_sha256 IS NOT NULL)",
        )
        .bind(page_id)
        .fetch_one(&pool)
        .await
        .expect("patched check");
        if already {
            println!("page {number}: already has cleanup, skipped");
            continue;
        }
        let Some(plan) = plan_for(&pool, page_id, image_id).await else {
            println!("page {number}: no sibling page has cleanup to copy");
            continue;
        };
        let total = regions(&pool, page_id).await.len();
        if dry_run {
            println!(
                "page {number}: would copy {} patch(es) for {total} region(s) from page {}",
                plan.patched_matches, plan.source_page
            );
            continue;
        }
        match manga_backend::clone::clone_cleanup_data(
            &pool,
            &storage,
            plan.source_page,
            page_id,
            &plan.region_map,
        )
        .await
        {
            Ok(copied) => {
                println!(
                    "page {number}: copied {copied} patch(es) for {total} region(s) from page {}",
                    plan.source_page
                );
                if rerender && copied > 0 {
                    let mut tx = pool.begin().await.expect("tx");
                    manga_backend::page_freshness::advance_page_revision(&mut tx, page_id)
                        .await
                        .expect("advance revision");
                    tx.commit().await.expect("commit");
                    println!("page {number}: queued for re-render");
                }
            }
            Err(err) => println!("page {number}: FAILED: {err}"),
        }
    }
}
