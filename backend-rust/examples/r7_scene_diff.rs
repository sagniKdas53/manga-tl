//! Tracker R7 measurement: does the Inpainting-layer scene builder draw what the pre-R7 builder drew?
//!
//! For every page with a snapshot at its current revision, builds the R7 scene inside a transaction
//! that is rolled back, and compares its draw list with the stored (pre-R7) snapshot:
//! which patch bytes are painted, where, how opaque, in what order, and the text objects.
//! Read-only for the database; the builder may upload a legacy plate to storage, which is
//! content-addressed and is what the pipeline itself would do.
//!
//! Run it against a *copy* of a database the R7 migration was applied to:
//!
//! ```text
//! R7_DB_URL=postgres://postgres@127.0.0.1:55490/r7_dryrun \
//! R7_MINIO_ENDPOINT=http://127.0.0.1:19000 R7_MINIO_SECRET=... \
//!   cargo run --example r7_scene_diff > r7-scene-diff.json
//! ```
//!
//! Buckets (all counted per page, then totalled):
//! - `patch_added` / `patch_removed`: a patch digest painted by one builder and not the other.
//!   `patch_added` must be zero on pages nobody edited; anything there is an R7-D4 leak.
//! - `double_draw_collapsed`: the old builder painted one region's patch once per visible text
//!   element; R7 paints it once. Changes pixels only where a patch has soft alpha.
//! - `reordered`: same patches, different paint order. Matters only where patches overlap.
//! - `moved`: same patch, different rect or opacity.
//! - `png_size_differs`: the patch PNG's size differs from its rect, the only case where R7's
//!   `preserveAspectRatio="none"` changes pixels.
//! - `text_changed`: a text object differs (text, box, style, visibility, order).

use std::collections::{BTreeMap, HashMap};

use serde_json::{Value, json};
use uuid::Uuid;

use manga_backend::config::{Config, DatabaseConfig, MinioConfig, RedisConfig};
use manga_backend::jwt::JwtUtils;
use manga_backend::minio::MinioService;
use manga_backend::state::AppState;

/// `(patch sha256, x, y, width, height, opacity)` in paint order.
type Paint = (String, f64, f64, f64, f64, f64);

fn paints(scene: &Value) -> Vec<Paint> {
    let sha_by_asset: HashMap<&str, &str> = scene["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| Some((a["asset_id"].as_str()?, a["sha256"].as_str()?)))
        .collect();
    scene["cleanup_artifacts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let b = &c["bounds"];
            let n = |v: &Value| v.as_f64().unwrap_or(f64::NAN);
            (
                sha_by_asset
                    .get(c["patch_asset_id"].as_str().unwrap_or(""))
                    .copied()
                    .unwrap_or("?")
                    .to_string(),
                n(&b["x"]),
                n(&b["y"]),
                n(&b["width"]),
                n(&b["height"]),
                c["opacity"].as_f64().unwrap_or(1.0),
            )
        })
        .collect()
}

/// Patch digests the old builder drew as flat plates (its legacy generator digest).
fn legacy_plate_shas(scene: &Value) -> std::collections::HashSet<String> {
    use sha2::Digest;
    let legacy = hex::encode(sha2::Sha256::digest(b"legacy-mask-polygon-fill/v1"));
    let sha_by_asset: HashMap<&str, &str> = scene["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| Some((a["asset_id"].as_str()?, a["sha256"].as_str()?)))
        .collect();
    scene["cleanup_artifacts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["generator_sha256"] == legacy.as_str())
        .filter_map(|c| {
            sha_by_asset
                .get(c["patch_asset_id"].as_str()?)
                .map(|s| s.to_string())
        })
        .collect()
}

fn texts(scene: &Value) -> Vec<Value> {
    let mut objects: Vec<&Value> = scene["objects"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|o| o["kind"] != "manual_cleanup")
        .collect();
    objects.sort_by_key(|o| o["z_index"].as_i64().unwrap_or(0));
    objects
        .into_iter()
        .map(|o| {
            json!({
                "object_id": o["object_id"], "text": o["text"], "transform": o["transform"],
                "style": o["style"], "visible": o["visible"],
            })
        })
        .collect()
}

fn counts(paints: &[Paint]) -> BTreeMap<String, usize> {
    let mut map = BTreeMap::new();
    for paint in paints {
        *map.entry(paint.0.clone()).or_insert(0) += 1;
    }
    map
}

fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    (bytes.len() >= 24 && &bytes[12..16] == b"IHDR").then(|| {
        (
            u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
            u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
        )
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let db_url = std::env::var("R7_DB_URL")?;
    let pool = sqlx::PgPool::connect(&db_url).await?;
    let minio = MinioConfig {
        endpoint: std::env::var("R7_MINIO_ENDPOINT")?,
        external_url: None,
        access_key: Some("minioadmin".into()),
        secret_key: Some(std::env::var("R7_MINIO_SECRET")?),
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

    let pages: Vec<(Uuid, i32, Value)> = sqlx::query_as(
        "SELECT p.id, p.scene_revision, s.scene_json FROM pages p \
         JOIN page_scene_snapshots s ON s.page_id = p.id AND s.revision = p.scene_revision \
         ORDER BY p.id",
    )
    .fetch_all(&pool)
    .await?;

    let mut totals: BTreeMap<&str, usize> = BTreeMap::new();
    let mut findings = Vec::new();
    let mut size_cache: HashMap<(Uuid, String), Option<(u32, u32)>> = HashMap::new();
    for (page_id, revision, before) in &pages {
        let mut tx = pool.begin().await?;
        let built = manga_backend::page_scene_builder::build_pipeline_scene(
            &state, &mut tx, *page_id, *revision,
        )
        .await;
        tx.rollback().await?;
        let after = match built {
            Ok(scene) => scene.validated.document,
            Err(err) => {
                *totals.entry("build_failed").or_insert(0) += 1;
                findings.push(json!({"page_id": page_id, "build_failed": err}));
                continue;
            }
        };
        let (old, new) = (paints(before), paints(&after));
        let (old_counts, new_counts) = (counts(&old), counts(&new));
        let mut page: BTreeMap<&str, Value> = BTreeMap::new();

        let added: Vec<&String> = new_counts
            .keys()
            .filter(|k| !old_counts.contains_key(*k))
            .collect();
        let removed: Vec<&String> = old_counts
            .keys()
            .filter(|k| !new_counts.contains_key(*k))
            .collect();
        let collapsed: Vec<&String> = old_counts
            .iter()
            .filter(|(k, n)| **n > 1 && new_counts.get(*k).is_some_and(|m| m < *n))
            .map(|(k, _)| k)
            .collect();
        if !added.is_empty() {
            page.insert("patch_added", json!(added));
        }
        if !removed.is_empty() {
            page.insert("patch_removed", json!(removed));
        }
        if !collapsed.is_empty() {
            page.insert("double_draw_collapsed", json!(collapsed));
        }
        let dedup = |list: &[Paint]| {
            let mut seen = std::collections::HashSet::new();
            list.iter()
                .filter(|p| seen.insert(p.0.clone()))
                .cloned()
                .collect::<Vec<_>>()
        };
        let (old_first, new_first) = (dedup(&old), dedup(&new));
        let shared = |list: &[Paint]| {
            list.iter()
                .filter(|p| old_counts.contains_key(&p.0) && new_counts.contains_key(&p.0))
                .cloned()
                .collect::<Vec<_>>()
        };
        let (old_shared, new_shared) = (shared(&old_first), shared(&new_first));
        let order = |list: &[Paint]| list.iter().map(|p| p.0.clone()).collect::<Vec<_>>();
        if order(&old_shared) != order(&new_shared) {
            // Flat plates (the legacy fallback) are painted after the patches since R7; the old
            // builder interleaved them. Is the order among the worker patches alone unchanged?
            let plates: std::collections::HashSet<String> = legacy_plate_shas(before);
            let without = |list: &[Paint]| {
                list.iter()
                    .filter(|p| !plates.contains(&p.0))
                    .map(|p| p.0.clone())
                    .collect::<Vec<_>>()
            };
            page.insert(
                "reordered",
                json!({"worker_patch_order_unchanged": without(&old_shared) == without(&new_shared)}),
            );
        }
        let moved: Vec<Value> = new_shared
            .iter()
            .filter_map(|n| {
                let o = old_shared.iter().find(|o| o.0 == n.0)?;
                (o != n).then(|| json!({"sha": n.0, "before": [o.1, o.2, o.3, o.4, o.5], "after": [n.1, n.2, n.3, n.4, n.5]}))
            })
            .collect();
        if !moved.is_empty() {
            page.insert("moved", json!(moved));
        }
        let mut size_mismatch = Vec::new();
        for paint in &new {
            let key = (*page_id, paint.0.clone());
            if !size_cache.contains_key(&key) {
                let path = manga_backend::page_scene_builder::scene_asset_path(*page_id, &paint.0);
                let size = match state.storage.download(&path).await {
                    Ok(stream) => stream
                        .collect()
                        .await
                        .ok()
                        .and_then(|b| png_size(&b.to_vec())),
                    Err(_) => None,
                };
                size_cache.insert(key.clone(), size);
            }
            let size = size_cache[&key];
            if size.map(|(w, h)| (f64::from(w), f64::from(h))) != Some((paint.3, paint.4)) {
                size_mismatch
                    .push(json!({"sha": paint.0, "png": size, "rect": [paint.3, paint.4]}));
            }
        }
        if !size_mismatch.is_empty() {
            page.insert("png_size_differs", json!(size_mismatch));
        }
        let (old_texts, new_texts) = (texts(before), texts(&after));
        if old_texts != new_texts {
            let first = old_texts
                .iter()
                .zip(new_texts.iter())
                .find(|(a, b)| a != b)
                .map(|(a, b)| json!({"before": a, "after": b}))
                .unwrap_or(
                    json!({"count_before": old_texts.len(), "count_after": new_texts.len()}),
                );
            page.insert("text_changed", first);
        }
        for key in page.keys() {
            *totals.entry(key).or_insert(0) += 1;
        }
        *totals.entry("pages").or_insert(0) += 1;
        *totals.entry("patches_before").or_insert(0) += old.len();
        *totals.entry("patches_after").or_insert(0) += new.len();
        if !page.is_empty() {
            let mut entry = json!({"page_id": page_id});
            for (key, value) in page {
                entry[key] = value;
            }
            findings.push(entry);
        }
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({"totals": totals, "pages": findings}))?
    );
    Ok(())
}
