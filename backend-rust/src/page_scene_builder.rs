//! Builds the immutable `page-scene/v1` logical scene for a page out of the pipeline's own rows.
//!
//! Tracker R1 (2026-09-17 realignment). Until this module existed nothing on the live path wrote a
//! `page_scene_snapshots` row: the editor's PUT route validated a client-supplied scene, and the
//! pipeline's translation/QA callbacks enqueued bare `render` jobs that the worker drew with Pillow.
//! The Chromium renderer therefore never received a job. This module derives the scene the contract
//! describes from what the pipeline already persists — `ocr_regions` and the visible translation/sfx
//! `layer_elements` — so a pipeline mutation can snapshot a revision and queue an immutable render.
//!
//! Deliberately a faithful projection, not an improvement: every visible translation element with a
//! mask polygon becomes one cleanup artifact whose patch is that polygon filled with the element's
//! sampled background colour, exactly the pixels the Pillow path painted. That keeps R1 a renderer
//! cutover the reference harness can verify as "no regression"; what a patch *should* be is R2/R3.

use std::collections::BTreeMap;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    models::{Image, Layer, LayerElement, NewPageSceneSnapshot, OcrRegion, Page},
    page_scene::{CONTRACT_VERSION, ValidatedPageScene, validate_page_scene},
    routes::page::content_type_by_extension,
    state::AppState,
};

/// Where content-addressed cleanup assets live. One object per distinct byte sequence; a page's
/// revisions share patches whose polygon and colour did not change.
pub fn scene_asset_path(page_id: Uuid, sha256: &str) -> String {
    format!("scene-assets/{page_id}/{sha256}.png")
}

/// The pinned renderer font. `services/page-renderer/fonts.json` is the source of truth for the
/// digest; the byte length is the size of the same `ComicNeue-Regular.otf` the image installs.
/// `PAGE_SCENE_FONTS_JSON` may override with the same shape as fonts.json plus `byteLength`.
#[derive(Debug, Clone)]
pub struct FontAsset {
    pub font_id: String,
    pub family: String,
    pub sha256: String,
    pub byte_length: i64,
    pub mime_type: String,
}

pub fn configured_fonts() -> Vec<FontAsset> {
    let default = FontAsset {
        font_id: "comic-neue".into(),
        family: "Comic Neue".into(),
        sha256: "2728ee8f303e31934e62bf27b044fd7657b0613412d51f7444db1078cc3a7cb2".into(),
        byte_length: 35628,
        mime_type: "font/otf".into(),
    };
    let Ok(raw) = std::env::var("PAGE_SCENE_FONTS_JSON") else {
        return vec![default];
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(err) => {
            tracing::error!(
                "PAGE_SCENE_FONTS_JSON is not valid JSON ({err}); using the pinned default font"
            );
            return vec![default];
        }
    };
    let fonts: Vec<FontAsset> = parsed
        .get("fonts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|font| {
            Some(FontAsset {
                font_id: font.get("fontId")?.as_str()?.to_owned(),
                family: font.get("family")?.as_str()?.to_owned(),
                sha256: font.get("sha256")?.as_str()?.to_owned(),
                byte_length: font.get("byteLength")?.as_i64()?,
                mime_type: font
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("font/otf")
                    .to_owned(),
            })
        })
        .collect();
    if fonts.is_empty() {
        vec![default]
    } else {
        fonts
    }
}

/// A 64-hex digest for provenance fields; the contract requires one even when unknown, and a
/// zero digest plus a warning is more honest than a made-up commit.
fn commit_digest(env_key: &str, warnings: &mut Vec<String>) -> String {
    match std::env::var(env_key) {
        Ok(value) if value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit()) => {
            value.to_ascii_lowercase()
        }
        Ok(value) if !value.is_empty() => hex::encode(Sha256::digest(value.as_bytes())),
        _ => {
            warnings.push(format!(
                "{env_key} unset; provenance commit is a zero digest"
            ));
            "0".repeat(64)
        }
    }
}

/// The scene plus the storage path of every cleanup asset it references, so the render job can
/// carry presigned URLs the worker fetches by asset id.
pub struct PipelineScene {
    pub validated: ValidatedPageScene,
    pub asset_paths: BTreeMap<String, String>,
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers

#[derive(Debug, Clone, Copy)]
struct Pt {
    x: f64,
    y: f64,
}

/// `mask_polygon` is stored either as a JSON array of `[x, y]` pairs or as a string holding that
/// JSON (the callbacks write it as a string). Both are accepted; anything else is "no mask".
fn parse_polygon(value: Option<&Value>) -> Option<Vec<Pt>> {
    let value = value?;
    let parsed: Value = match value {
        Value::String(text) => serde_json::from_str(text).ok()?,
        other => other.clone(),
    };
    let points: Vec<Pt> = parsed
        .as_array()?
        .iter()
        .filter_map(|pair| {
            let pair = pair.as_array()?;
            Some(Pt {
                x: pair.first()?.as_f64()?,
                y: pair.get(1)?.as_f64()?,
            })
        })
        .filter(|p| p.x.is_finite() && p.y.is_finite())
        .collect();
    (points.len() >= 3).then_some(points)
}

fn parse_hex_colour(value: Option<&str>) -> [u8; 3] {
    let text = value.unwrap_or("#ffffff").trim().trim_start_matches('#');
    if text.len() == 6
        && let Ok(rgb) = u32::from_str_radix(text, 16)
    {
        return [(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8];
    }
    [255, 255, 255]
}

struct Raster {
    x: i64,
    y: i64,
    width: u32,
    height: u32,
    /// `true` for every pixel inside the polygon (even-odd rule).
    inside: Vec<bool>,
}

/// Even-odd scanline fill of a polygon, clamped to the page. Returns `None` when the clamped
/// bounds are empty — a polygon entirely off-page paints nothing and gets no artifact.
fn rasterize_polygon(points: &[Pt], page_w: i64, page_h: i64) -> Option<Raster> {
    let min_x = points
        .iter()
        .map(|p| p.x)
        .fold(f64::INFINITY, f64::min)
        .floor() as i64;
    let min_y = points
        .iter()
        .map(|p| p.y)
        .fold(f64::INFINITY, f64::min)
        .floor() as i64;
    let max_x = points
        .iter()
        .map(|p| p.x)
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil() as i64;
    let max_y = points
        .iter()
        .map(|p| p.y)
        .fold(f64::NEG_INFINITY, f64::max)
        .ceil() as i64;
    let x0 = min_x.max(0);
    let y0 = min_y.max(0);
    let x1 = max_x.min(page_w);
    let y1 = max_y.min(page_h);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let width = (x1 - x0) as u32;
    let height = (y1 - y0) as u32;
    let mut inside = vec![false; (width as usize) * (height as usize)];
    let n = points.len();
    for row in 0..height {
        let sample_y = y0 as f64 + row as f64 + 0.5;
        let mut crossings: Vec<f64> = Vec::new();
        for i in 0..n {
            let a = points[i];
            let b = points[(i + 1) % n];
            if (a.y <= sample_y) != (b.y <= sample_y) {
                let t = (sample_y - a.y) / (b.y - a.y);
                crossings.push(a.x + t * (b.x - a.x));
            }
        }
        crossings.sort_by(|l, r| l.partial_cmp(r).unwrap_or(std::cmp::Ordering::Equal));
        for span in crossings.chunks(2) {
            if let [left, right] = span {
                let from = (left.ceil() as i64).max(x0);
                let to = (right.floor() as i64).min(x1 - 1);
                for col in from..=to {
                    inside[(row as usize) * (width as usize) + (col - x0) as usize] = true;
                }
            }
        }
    }
    Some(Raster {
        x: x0,
        y: y0,
        width,
        height,
        inside,
    })
}

fn encode_png(width: u32, height: u32, rgba: Vec<u8>) -> Result<Vec<u8>, String> {
    use image::ImageEncoder;
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(&rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|err| format!("png encode failed: {err}"))?;
    Ok(out)
}

/// Tracker R2 gate: the largest share of the page one cleanup patch may cover.
pub const MAX_PATCH_PAGE_SHARE: f64 = 0.25;

/// Share of the page a patch's bounds cover, 0..1.
fn patch_page_share(raster: &Raster, page_w: i32, page_h: i32) -> f64 {
    let page = (page_w as f64) * (page_h as f64);
    if page <= 0.0 {
        return 1.0;
    }
    (raster.width as f64) * (raster.height as f64) / page
}

/// `(patch_png, mask_png)` for one legacy mask: the patch is the polygon filled with the sampled
/// background colour, the mask is the same coverage as white-on-transparent.
fn legacy_patch_and_mask(raster: &Raster, colour: [u8; 3]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let pixels = (raster.width as usize) * (raster.height as usize);
    let mut patch = vec![0u8; pixels * 4];
    let mut mask = vec![0u8; pixels * 4];
    for (index, &hit) in raster.inside.iter().enumerate() {
        if hit {
            patch[index * 4..index * 4 + 4]
                .copy_from_slice(&[colour[0], colour[1], colour[2], 255]);
            mask[index * 4..index * 4 + 4].copy_from_slice(&[255, 255, 255, 255]);
        }
    }
    Ok((
        encode_png(raster.width, raster.height, patch)?,
        encode_png(raster.width, raster.height, mask)?,
    ))
}

/// A region's cleanup replaced by a flat plate: what "cover with a plain mask" stores.
pub struct PlainPlate {
    pub mask_asset_id: String,
    pub mask_sha256: String,
    pub mask_byte_length: i64,
    pub patch_asset_id: String,
    pub patch_sha256: String,
    pub patch_byte_length: i64,
    pub bounds: Value,
    pub generator_sha256: String,
}

/// Paints `polygon` flat in `colour` and uploads it as a region's cleanup assets.
///
/// This is the Reader's fallback for a region whose inpainting left lettering behind (or found
/// none): a plain plate of the bubble colour. It is written into the region's `cleanup_*` columns,
/// so the scene, the render, QA and export all treat it as that region's cleanup with no special
/// case, and a later cleanup pass simply replaces it. Assets are content-addressed like the
/// worker's, under the same `mask-<sha>` / `patch-<sha>` ids.
pub async fn plain_plate_cleanup(
    state: &AppState,
    page_id: Uuid,
    polygon: &Value,
    colour: Option<&str>,
    page_w: i32,
    page_h: i32,
) -> Result<PlainPlate, String> {
    let points = parse_polygon(Some(polygon)).ok_or("the mask polygon has fewer than 3 points")?;
    let raster = rasterize_polygon(&points, page_w as i64, page_h as i64)
        .ok_or("the mask lies outside the page")?;
    let (patch_png, mask_png) = legacy_patch_and_mask(&raster, parse_hex_colour(colour))?;
    let patch_sha = hex::encode(Sha256::digest(&patch_png));
    let mask_sha = hex::encode(Sha256::digest(&mask_png));
    for (sha, bytes) in [(&patch_sha, &patch_png), (&mask_sha, &mask_png)] {
        let path = scene_asset_path(page_id, sha);
        if !state.storage.exists(&path).await {
            state
                .storage
                .upload_bytes(&path, bytes.clone(), "image/png")
                .await
                .map_err(|e| format!("could not upload plain mask {path}: {e}"))?;
        }
    }
    Ok(PlainPlate {
        mask_asset_id: format!("mask-{mask_sha}"),
        mask_byte_length: mask_png.len() as i64,
        mask_sha256: mask_sha,
        patch_asset_id: format!("patch-{patch_sha}"),
        patch_byte_length: patch_png.len() as i64,
        patch_sha256: patch_sha,
        bounds: json!({ "x": raster.x, "y": raster.y, "width": raster.width, "height": raster.height }),
        generator_sha256: hex::encode(Sha256::digest(b"plain-mask/v1")),
    })
}

/// R3: the `cleanup_artifact` JSON for a worker-supplied glyph mask + reconstructed patch.
/// `region`'s own `cleanup_generator_sha256` is trusted when present (the worker's own record
/// of which method -- TELEA or AOT -- produced it); `fallback_generator_sha256` only covers a
/// row where that field is somehow absent despite the asset refs being present.
fn worker_cleanup_artifact(
    cleanup_id: &str,
    owner_id: &str,
    source_sha256: &str,
    mask_asset_id: &str,
    patch_asset_id: &str,
    region: &OcrRegion,
    fallback_generator_sha256: &str,
) -> Value {
    json!({
        "cleanup_id": cleanup_id,
        "owner_ids": [owner_id],
        "source_sha256": source_sha256,
        "mask_asset_id": mask_asset_id,
        "patch_asset_id": patch_asset_id,
        "bounds": region.cleanup_bounds.clone().unwrap_or(json!({"x": 0, "y": 0, "width": 0, "height": 0})),
        "generator_sha256": region
            .cleanup_generator_sha256
            .clone()
            .unwrap_or_else(|| fallback_generator_sha256.to_string()),
        "active_set_dependency": "independent",
        "diagnostics": region.cleanup_diagnostics.clone().unwrap_or(json!([])),
    })
}

fn quad_for(region: &OcrRegion) -> Vec<Value> {
    let cx = region.bbox_x as f64 + region.bbox_w as f64 / 2.0;
    let cy = region.bbox_y as f64 + region.bbox_h as f64 / 2.0;
    let radians = region.rotation.unwrap_or(0.0).to_radians();
    let (sin, cos) = radians.sin_cos();
    let hw = region.bbox_w as f64 / 2.0;
    let hh = region.bbox_h as f64 / 2.0;
    [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
        .iter()
        .map(|(dx, dy)| json!({ "x": cx + dx * cos - dy * sin, "y": cy + dx * sin + dy * cos }))
        .collect()
}

fn policy_kind(region_type: Option<&str>) -> &'static str {
    // Mirrors worker/src/worker/services/region_policy.py `_KIND_BY_REGION_TYPE`.
    match region_type.map(str::to_ascii_lowercase).as_deref() {
        Some("speech") => "dialogue",
        Some("sfx") => "sfx",
        Some("caption") => "caption",
        Some("narration") | Some("sign") => "other",
        _ => "unknown",
    }
}

fn weight_for(font_weight: Option<&str>) -> i64 {
    match font_weight.map(str::to_ascii_lowercase).as_deref() {
        Some("bold") => 700,
        Some(digits) if digits.chars().all(|c| c.is_ascii_digit()) => {
            digits.parse::<i64>().unwrap_or(400).clamp(1, 1000)
        }
        _ => 400,
    }
}

// ---------------------------------------------------------------------------------------------
// Building

/// Derives the logical scene for `page_id` at `revision` from current rows and uploads every
/// cleanup asset it references. Pure with respect to the database: nothing is written here.
///
/// Reads go through the caller's transaction, not the pool. The translation callback inserts
/// its layer elements and snapshots in one transaction; the first live R1 run read the rows
/// through a pool connection, saw nothing of the uncommitted pass, and rendered every page one
/// translation behind (revision 1 had zero objects, revision 3 drew pass 2's text).
pub async fn build_pipeline_scene(
    state: &AppState,
    tx: &mut Transaction<'_, Postgres>,
    page_id: Uuid,
    revision: i32,
) -> Result<PipelineScene, String> {
    let geometry = crate::settings::text_box_geometry(&state.pool).await;
    let page: Page = sqlx::query_as("SELECT * FROM pages WHERE id = $1")
        .bind(page_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("page {page_id} does not exist"))?;
    let image: Image = sqlx::query_as("SELECT * FROM images WHERE id = $1")
        .bind(page.image_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("image {} for page {page_id} does not exist", page.image_id))?;
    let source_sha256 = image
        .hash
        .clone()
        .filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| {
            format!(
                "image {} has no SHA-256 hash; cannot build an immutable scene",
                image.id
            )
        })?;
    let (page_w, page_h) = match (image.width, image.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => (w, h),
        _ => return Err(format!("image {} has no pixel dimensions", image.id)),
    };
    let mime_type = content_type_by_extension(&image.storage_path);

    let regions: Vec<OcrRegion> = sqlx::query_as(
        "SELECT * FROM ocr_regions WHERE page_id = $1 \
         ORDER BY panel_reading_order NULLS LAST, bubble_reading_order NULLS LAST, id",
    )
    .bind(page_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;

    // Same selection rule as the Pillow path it replaces: visible elements on visible
    // translation/sfx layers, painted in layer z-order.
    let layers: Vec<Layer> = sqlx::query_as(
        "SELECT * FROM layers WHERE page_id = $1 AND visible = TRUE \
         AND LOWER(type) IN ('translation', 'sfx') ORDER BY z_order ASC, created_at ASC",
    )
    .bind(page_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    let mut elements: Vec<(i32, LayerElement)> = Vec::new();
    for layer in &layers {
        let rows: Vec<LayerElement> = sqlx::query_as(
            "SELECT * FROM layer_elements WHERE layer_id = $1 AND COALESCE(visible, TRUE) = TRUE ORDER BY id",
        )
        .bind(layer.id)
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        elements.extend(rows.into_iter().map(|e| (layer.z_order, e)));
    }

    let mut warnings: Vec<String> = Vec::new();
    let fonts = configured_fonts();
    let font = fonts.first().expect("configured_fonts never returns empty");

    let mut fragments = Vec::with_capacity(regions.len());
    let mut owners = Vec::with_capacity(regions.len());
    let mut policies = Vec::with_capacity(regions.len());
    let mut assets: Vec<Value> = fonts
        .iter()
        .map(|f| {
            json!({
                "asset_id": f.font_id,
                "kind": "font",
                "sha256": f.sha256,
                "byte_length": f.byte_length,
                "mime_type": f.mime_type,
            })
        })
        .collect();
    let mut cleanup_artifacts: Vec<Value> = Vec::new();
    let mut objects: Vec<Value> = Vec::new();
    let mut asset_paths: BTreeMap<String, String> = BTreeMap::new();

    // Which regions end up replaced: any visible element with non-empty text. Everything else is
    // `review`, which the contract reads as "pixels untouched, visibly unresolved".
    let mut replaced: std::collections::HashSet<Uuid> = std::collections::HashSet::new();
    for (_, element) in &elements {
        if let Some(region_id) = element.region_id
            && element
                .text
                .as_deref()
                .is_some_and(|t| !t.trim().is_empty())
        {
            replaced.insert(region_id);
        }
    }

    let mut owner_by_region: BTreeMap<Uuid, String> = BTreeMap::new();
    for region in &regions {
        let fragment_id = format!("fragment-{}", region.id);
        let owner_id = format!("owner-{}", region.id);
        fragments.push(json!({
            "fragment_id": fragment_id,
            "quad": quad_for(region),
            "text": region.text.clone().unwrap_or_default(),
            "confidence": region.confidence.unwrap_or(0.0).clamp(0.0, 1.0),
            "detector_to_source": [1, 0, 0, 0, 1, 0, 0, 0, 1],
            "glyph_evidence": Value::Null,
        }));
        owners.push(json!({
            "owner_id": owner_id,
            "fragment_ids": [fragment_id],
            "container_id": region.bubble_id.clone(),
            "panel_id": region.panel_id.map(|id| id.to_string()),
            "grouping_evidence": ["pipeline-ocr-region"],
            "vetoes": [],
        }));
        let action = if replaced.contains(&region.id) {
            "replace"
        } else {
            "review"
        };
        policies.push(json!({
            "owner_id": owner_id,
            "kind": policy_kind(region.region_type.as_deref()),
            "confidence": region.confidence.unwrap_or(0.0).clamp(0.0, 1.0),
            "reason": if action == "replace" { "pipeline-translation-element" } else { "no-visible-translation" },
            "action": action,
            "user_override": Value::Null,
        }));
        owner_by_region.insert(region.id, owner_id);
    }

    let generator_sha256 = hex::encode(Sha256::digest(b"legacy-mask-polygon-fill/v1"));
    let mut z_index: i64 = 1;
    for (layer_z, element) in &elements {
        let text = element.text.clone().unwrap_or_default();
        if text.trim().is_empty() {
            continue;
        }
        let Some(region_id) = element.region_id else {
            // A manual element with no region has no owner and no pipeline cleanup; the contract
            // models it as manual text. It is drawn, but it authorises no patch.
            objects.push(json!({
                "object_id": format!("text-{}", element.id),
                "kind": "manual_text",
                "owner_id": Value::Null,
                "cleanup_ids": [],
                "text": text,
                "allowed_container_id": Value::Null,
                "transform": transform_for(element),
                "writing_mode": "horizontal-tb",
                "alignment": "center",
                "style": style_for(element, &font.font_id, &geometry),
                "visible": true,
                "z_index": *layer_z as i64 * 1000 + z_index,
            }));
            z_index += 1;
            continue;
        };
        let Some(owner_id) = owner_by_region.get(&region_id).cloned() else {
            warnings.push(format!(
                "element {} references region {region_id} that is not on this page",
                element.id
            ));
            continue;
        };
        let region = regions
            .iter()
            .find(|r| r.id == region_id)
            .expect("owner_by_region is built from regions");

        let mut cleanup_ids: Vec<String> = Vec::new();

        // R3: the worker computes the real glyph mask + reconstructed patch and uploads them
        // itself (same content-addressed `scene-assets/{page_id}/{sha256}.png` path this
        // function already uses below); here we only register what it already put there. A
        // missing ref, or a ref whose object never actually landed in storage, falls through
        // to the pre-R3 raster/`legacy_patch_and_mask` path untouched -- never a worse result.
        let worker_cleanup = match (
            region.cleanup_mask_asset_id.as_deref(),
            region.cleanup_mask_sha256.as_deref(),
            region.cleanup_patch_asset_id.as_deref(),
            region.cleanup_patch_sha256.as_deref(),
        ) {
            (Some(mask_asset_id), Some(mask_sha), Some(patch_asset_id), Some(patch_sha)) => {
                let mask_path = scene_asset_path(page_id, mask_sha);
                let patch_path = scene_asset_path(page_id, patch_sha);
                if state.storage.exists(&mask_path).await && state.storage.exists(&patch_path).await
                {
                    Some((
                        mask_asset_id,
                        mask_sha,
                        mask_path,
                        patch_asset_id,
                        patch_sha,
                        patch_path,
                    ))
                } else {
                    warnings.push(format!(
                        "element {} region {region_id} has cleanup asset refs but the objects are missing \
                         from storage; falling back to the legacy patch",
                        element.id
                    ));
                    None
                }
            }
            _ => None,
        };

        if let Some((mask_asset_id, mask_sha, mask_path, patch_asset_id, patch_sha, patch_path)) =
            worker_cleanup
        {
            assets.push(json!({
                "asset_id": mask_asset_id,
                "kind": "glyph_mask",
                "sha256": mask_sha,
                "byte_length": region.cleanup_mask_byte_length.unwrap_or(0),
                "mime_type": "image/png",
            }));
            asset_paths.insert(mask_asset_id.to_string(), mask_path);
            assets.push(json!({
                "asset_id": patch_asset_id,
                "kind": "cleanup_patch",
                "sha256": patch_sha,
                "byte_length": region.cleanup_patch_byte_length.unwrap_or(0),
                "mime_type": "image/png",
            }));
            asset_paths.insert(patch_asset_id.to_string(), patch_path);

            let cleanup_id = format!("cleanup-{}", element.id);
            cleanup_artifacts.push(worker_cleanup_artifact(
                &cleanup_id,
                &owner_id,
                &source_sha256,
                mask_asset_id,
                patch_asset_id,
                region,
                &generator_sha256,
            ));
            cleanup_ids.push(cleanup_id);
        } else {
            let raster = parse_polygon(element.mask_polygon.as_ref())
                .and_then(|points| rasterize_polygon(&points, page_w as i64, page_h as i64));
            if let Some(raster) = raster.filter(|raster| {
                // Tracker R2 gate: no patch larger than a quarter of the page. The worker's merge
                // no longer produces such a region, so this only fires on old rows or a wrong
                // detector mask -- and then the text is drawn over the source rather than the page
                // being flattened under one plate.
                let share = patch_page_share(raster, page_w, page_h);
                if share > MAX_PATCH_PAGE_SHARE {
                    warnings.push(format!(
                        "element {} patch refused: {:.1} % of the page exceeds the {:.0} % gate; text drawn over source",
                        element.id,
                        share * 100.0,
                        MAX_PATCH_PAGE_SHARE * 100.0
                    ));
                    false
                } else {
                    true
                }
            }) {
                let colour = parse_hex_colour(element.background_color.as_deref());
                let (patch_png, mask_png) = legacy_patch_and_mask(&raster, colour)?;
                let patch_sha = hex::encode(Sha256::digest(&patch_png));
                let mask_sha = hex::encode(Sha256::digest(&mask_png));
                let patch_id = format!("patch-{}", element.id);
                let mask_id = format!("mask-{}", element.id);
                for (id, sha, bytes) in [
                    (&patch_id, &patch_sha, &patch_png),
                    (&mask_id, &mask_sha, &mask_png),
                ] {
                    let path = scene_asset_path(page_id, sha);
                    if !state.storage.exists(&path).await {
                        state
                            .storage
                            .upload_bytes(&path, bytes.clone(), "image/png")
                            .await
                            .map_err(|e| format!("could not upload scene asset {path}: {e}"))?;
                    }
                    assets.push(json!({
                        "asset_id": id,
                        "kind": if id == &patch_id { "cleanup_patch" } else { "glyph_mask" },
                        "sha256": sha,
                        "byte_length": bytes.len(),
                        "mime_type": "image/png",
                    }));
                    asset_paths.insert(id.clone(), path);
                }
                let cleanup_id = format!("cleanup-{}", element.id);
                cleanup_artifacts.push(json!({
                    "cleanup_id": cleanup_id,
                    "owner_ids": [owner_id],
                    "source_sha256": source_sha256,
                    "mask_asset_id": mask_id,
                    "patch_asset_id": patch_id,
                    "bounds": { "x": raster.x, "y": raster.y, "width": raster.width, "height": raster.height },
                    "generator_sha256": generator_sha256,
                    "active_set_dependency": "independent",
                    "diagnostics": [],
                }));
                cleanup_ids.push(cleanup_id);
            } else if element.mask_polygon.is_some() {
                warnings.push(format!(
                    "element {} has a mask polygon that does not rasterize; text is drawn over source pixels",
                    element.id
                ));
            }
            // A NULL mask is the R2 free-standing-text case, not a defect: the worker returns no
            // plate for text with no container, and the text goes over the untouched source with
            // its halo.
        }

        objects.push(json!({
            "object_id": format!("text-{}", element.id),
            "kind": if cleanup_ids.is_empty() { "manual_text" } else { "automatic_text" },
            "owner_id": owner_id,
            "cleanup_ids": cleanup_ids,
            "text": text,
            "allowed_container_id": region.bubble_id.clone(),
            "transform": transform_for(element),
            "writing_mode": "horizontal-tb",
            "alignment": "center",
            "style": style_for(element, &font.font_id, &geometry),
            "visible": true,
            "z_index": *layer_z as i64 * 1000 + z_index,
        }));
        z_index += 1;
    }

    let app_commit = commit_digest("APP_COMMIT_SHA", &mut warnings);
    let document = json!({
        "contract_version": CONTRACT_VERSION,
        "scene_kind": "logical",
        "page": {
            "page_id": page_id.to_string(),
            "revision": revision,
            "source": {
                "sha256": source_sha256,
                "width": page_w,
                "height": page_h,
                "mime_type": mime_type,
            },
        },
        "provenance": {
            "app_commit": app_commit,
            "worker_commit": "0".repeat(64),
            "renderer_commit": "0".repeat(64),
            "models": [],
            "configuration_sha256": generator_sha256,
            "fonts": fonts.iter().map(|f| json!({ "font_id": f.font_id, "sha256": f.sha256 })).collect::<Vec<_>>(),
            "runtime": { "os": std::env::consts::OS, "architecture": std::env::consts::ARCH, "execution_provider": "cpu" },
            "timings_ms": {},
            "warnings": warnings,
        },
        "fragments": fragments,
        "owners": owners,
        "policies": policies,
        "assets": assets,
        "cleanup_artifacts": cleanup_artifacts,
        "objects": objects,
    });
    let validated =
        validate_page_scene(document).map_err(|e| format!("built scene is invalid: {e}"))?;
    Ok(PipelineScene {
        validated,
        asset_paths,
    })
}

fn transform_for(element: &LayerElement) -> Value {
    json!({
        "x": element.x,
        "y": element.y,
        "width": element.max_width.filter(|w| *w > 0).unwrap_or(1) as f64,
        "height": element.max_height.filter(|h| *h > 0).unwrap_or(1) as f64,
        "rotation_degrees": element.rotation.filter(|r| r.is_finite()).unwrap_or(0.0),
    })
}

fn style_for(
    element: &LayerElement,
    font_id: &str,
    geometry: &crate::settings::TextBoxGeometry,
) -> Value {
    let width = element.max_width.filter(|w| *w > 0).unwrap_or(1) as f64;
    let height = element.max_height.filter(|h| *h > 0).unwrap_or(1) as f64;
    json!({
        "font_id": font_id,
        "fill": element.text_color.clone().filter(|c| !c.trim().is_empty()).unwrap_or_else(|| "#000000".into()),
        // Tracker R2, user decision 2 (2026-09-17): text is drawn with a thick stroke in the
        // local background colour under the fill -- the halo that makes unenclosed lettering
        // read against artwork. The width is the renderer's (packages/page-scene) as a fraction
        // of the resolved font px; the colour is the worker's local-background sample.
        "stroke": element.background_color.clone().filter(|c| !c.trim().is_empty()).unwrap_or_default(),
        "weight": weight_for(element.font_weight.as_deref()),
        // The inset from System Settings (percent of the box's shorter side, capped), resolved to
        // px for this box so the frozen contract's single number carries it. It used to be a
        // literal 4.0 whatever the settings said; only the editor read them.
        "padding": geometry.padding_px(width, height),
    })
}

// ---------------------------------------------------------------------------------------------
// Persisting

/// Snapshots the page's current rows as the next revision, inside `tx`, and advances the page.
/// Mirrors `put_page_scene`'s write order so the render ledger's foreign keys hold. Returns the
/// snapshot plus asset paths for the render job. The caller commits.
pub async fn snapshot_pipeline_scene(
    state: &AppState,
    tx: &mut Transaction<'_, Postgres>,
    page_id: Uuid,
) -> Result<(NewPageSceneSnapshot, BTreeMap<String, String>), String> {
    let current: i32 =
        sqlx::query_scalar("SELECT scene_revision FROM pages WHERE id = $1 FOR UPDATE")
            .bind(page_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    let revision = current + 1;
    let built = build_pipeline_scene(state, tx, page_id, revision).await?;
    let snapshot = built.validated.snapshot_for_page(page_id);

    sqlx::query(
        "INSERT INTO page_scene_snapshots \
         (page_id, revision, contract_version, source_sha256, logical_scene_sha256, scene_json) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(snapshot.page_id)
    .bind(snapshot.revision)
    .bind(&snapshot.contract_version)
    .bind(&snapshot.source_sha256)
    .bind(&snapshot.logical_scene_sha256)
    .bind(&snapshot.scene_json)
    .execute(&mut **tx)
    .await
    .map_err(|e| format!("could not insert pipeline scene snapshot: {e}"))?;
    for owner in &built.validated.owners {
        sqlx::query(
            "INSERT INTO page_scene_owners \
             (page_id, revision, owner_id, policy_kind, policy_action, policy_override) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(page_id)
        .bind(revision)
        .bind(&owner.owner_id)
        .bind(&owner.policy_kind)
        .bind(&owner.policy_action)
        .bind(&owner.policy_override)
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("could not insert pipeline scene owner: {e}"))?;
    }
    for asset in &built.validated.assets {
        sqlx::query(
            "INSERT INTO page_scene_assets \
             (page_id, revision, asset_id, asset_kind, asset_sha256, byte_length, mime_type, storage_path) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(page_id)
        .bind(revision)
        .bind(&asset.asset_id)
        .bind(&asset.asset_kind)
        .bind(&asset.asset_sha256)
        .bind(asset.byte_length)
        .bind(&asset.mime_type)
        .bind(built.asset_paths.get(&asset.asset_id))
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("could not insert pipeline scene asset: {e}"))?;
    }
    let advanced = crate::page_freshness::advance_page_revision(tx, page_id)
        .await
        .map_err(|e| e.to_string())?;
    if advanced != revision {
        return Err(format!(
            "page {page_id} revision moved to {advanced} while snapshotting {revision}"
        ));
    }
    Ok((snapshot, built.asset_paths))
}

/// Snapshots the page in its own transaction and returns the immutable render payload — the same
/// fields a queued `render` job carries — for a caller that renders synchronously (hybrid QA's
/// interim VLM check) instead of through the queue. No `page_render_jobs` row is written: an
/// interim render is not a current artifact; the final-pass render after QA is.
pub async fn snapshot_render_payload(
    state: &AppState,
    page_id: Uuid,
    image_id: Uuid,
) -> Result<Value, String> {
    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
    let (snapshot, asset_paths) = snapshot_pipeline_scene(state, &mut tx, page_id).await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    let mut asset_urls = serde_json::Map::new();
    for (asset_id, path) in asset_paths {
        let url = state
            .storage
            .presigned_get_url(&path)
            .await
            .map_err(|err| format!("could not presign scene asset {path}: {err}"))?;
        asset_urls.insert(asset_id, json!(url));
    }
    Ok(json!({
        "imageId": image_id,
        "pageId": page_id,
        "pageRevision": snapshot.revision,
        "logicalSceneSha256": snapshot.logical_scene_sha256,
        "logicalScene": snapshot.scene_json,
        "renderAssetUrls": Value::Object(asset_urls),
    }))
}

/// Storage paths of the cleanup assets referenced by the page's current snapshot, keyed by asset
/// id — what a queued render job needs to hand the worker presigned URLs.
pub async fn current_asset_paths(
    pool: &PgPool,
    page_id: Uuid,
    revision: i32,
) -> Result<BTreeMap<String, String>, String> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT asset_id, storage_path FROM page_scene_assets \
         WHERE page_id = $1 AND revision = $2 AND asset_kind IN ('cleanup_patch', 'glyph_mask', 'manual_cleanup_patch')",
    )
    .bind(page_id)
    .bind(revision)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, path)| path.map(|p| (id, p)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polygon_parses_from_string_and_array() {
        let as_string = json!("[[0,0],[10,0],[10,10],[0,10]]");
        let as_array = json!([[0, 0], [10, 0], [10, 10], [0, 10]]);
        assert_eq!(parse_polygon(Some(&as_string)).unwrap().len(), 4);
        assert_eq!(parse_polygon(Some(&as_array)).unwrap().len(), 4);
        assert!(parse_polygon(Some(&json!("[[0,0],[1,1]]"))).is_none());
        assert!(parse_polygon(None).is_none());
    }

    #[test]
    fn rasterizes_a_square_and_clamps_to_page() {
        let square = [
            Pt { x: 2.0, y: 2.0 },
            Pt { x: 6.0, y: 2.0 },
            Pt { x: 6.0, y: 6.0 },
            Pt { x: 2.0, y: 6.0 },
        ];
        let raster = rasterize_polygon(&square, 100, 100).unwrap();
        assert_eq!(
            (raster.x, raster.y, raster.width, raster.height),
            (2, 2, 4, 4)
        );
        assert!(raster.inside.iter().all(|&hit| hit));
        let clipped = rasterize_polygon(&square, 4, 4).unwrap();
        assert_eq!((clipped.width, clipped.height), (2, 2));
        assert!(rasterize_polygon(&square, 1, 1).is_none());
    }

    #[test]
    fn patch_and_mask_are_valid_png_of_raster_size() {
        let square = [
            Pt { x: 0.0, y: 0.0 },
            Pt { x: 8.0, y: 0.0 },
            Pt { x: 8.0, y: 8.0 },
            Pt { x: 0.0, y: 8.0 },
        ];
        let raster = rasterize_polygon(&square, 8, 8).unwrap();
        let (patch, mask) = legacy_patch_and_mask(&raster, [1, 2, 3]).unwrap();
        for png in [&patch, &mask] {
            let decoded = image::load_from_memory(png).unwrap().to_rgba8();
            assert_eq!(decoded.dimensions(), (8, 8));
        }
        let decoded = image::load_from_memory(&patch).unwrap().to_rgba8();
        assert_eq!(decoded.get_pixel(3, 3).0, [1, 2, 3, 255]);
    }

    #[test]
    fn colour_and_weight_parsing_have_safe_defaults() {
        assert_eq!(parse_hex_colour(Some("#aaf2fe")), [0xaa, 0xf2, 0xfe]);
        assert_eq!(parse_hex_colour(Some("nonsense")), [255, 255, 255]);
        assert_eq!(weight_for(Some("bold")), 700);
        assert_eq!(weight_for(Some("600")), 600);
        assert_eq!(weight_for(None), 400);
        assert_eq!(policy_kind(Some("speech")), "dialogue");
        assert_eq!(policy_kind(Some("SFX")), "sfx");
        assert_eq!(policy_kind(None), "unknown");
    }

    fn region_with_cleanup(
        cleanup_bounds: Option<Value>,
        cleanup_generator_sha256: Option<String>,
        cleanup_diagnostics: Option<Value>,
    ) -> OcrRegion {
        OcrRegion {
            id: Uuid::nil(),
            approved: None,
            background_color: None,
            bbox_x: 10,
            bbox_y: 20,
            bbox_w: 30,
            bbox_h: 40,
            bubble_x: None,
            bubble_y: None,
            bubble_w: None,
            bubble_h: None,
            bubble_id: None,
            bubble_reading_order: None,
            confidence: None,
            detected_language: "ja".to_string(),
            detection_confidence: None,
            mask_polygon: None,
            ocr_score: None,
            ownership_provenance: None,
            panel_reading_order: None,
            qa_feedback: None,
            qa_score: None,
            qa_status: None,
            region_type: None,
            rotation: None,
            safe_text_x: None,
            safe_text_y: None,
            safe_text_w: None,
            safe_text_h: None,
            text: None,
            translated_text: None,
            translation_failed: None,
            translation_score: None,
            page_id: Uuid::nil(),
            panel_id: None,
            cleanup_mask_asset_id: None,
            cleanup_mask_sha256: None,
            cleanup_mask_byte_length: None,
            cleanup_patch_asset_id: None,
            cleanup_patch_sha256: None,
            cleanup_patch_byte_length: None,
            cleanup_bounds,
            cleanup_generator_sha256,
            cleanup_diagnostics,
        }
    }

    #[test]
    fn worker_cleanup_artifact_uses_the_regions_own_bounds_generator_and_diagnostics() {
        // The live `validate_page_scene` runtime validator does not check bounds/generator_sha256/
        // diagnostics (only the offline JSON-Schema fixture runner does) -- this is the test that
        // would actually catch a mistake in populating them from the worker-supplied region.
        let region = region_with_cleanup(
            Some(json!({"x": 12, "y": 34, "width": 56, "height": 78})),
            Some("a".repeat(64)),
            Some(json!([
                "reconstruction method: aot (pixel_spread=25.0)",
                "residual ink: 3.0%"
            ])),
        );
        let artifact = worker_cleanup_artifact(
            "cleanup-1",
            "owner-1",
            "b".repeat(64).as_str(),
            "mask-1",
            "patch-1",
            &region,
            "fallback-sha",
        );

        assert_eq!(artifact["cleanup_id"], json!("cleanup-1"));
        assert_eq!(artifact["owner_ids"], json!(["owner-1"]));
        assert_eq!(artifact["source_sha256"], json!("b".repeat(64)));
        assert_eq!(artifact["mask_asset_id"], json!("mask-1"));
        assert_eq!(artifact["patch_asset_id"], json!("patch-1"));
        assert_eq!(
            artifact["bounds"],
            json!({"x": 12, "y": 34, "width": 56, "height": 78})
        );
        assert_eq!(artifact["generator_sha256"], json!("a".repeat(64)));
        assert_eq!(artifact["active_set_dependency"], json!("independent"));
        assert_eq!(
            artifact["diagnostics"],
            json!([
                "reconstruction method: aot (pixel_spread=25.0)",
                "residual ink: 3.0%"
            ])
        );
    }

    #[test]
    fn worker_cleanup_artifact_falls_back_when_the_region_lacks_optional_fields() {
        // A row with the asset refs present but somehow missing bounds/generator/diagnostics
        // (should not happen from the worker, but the field is nullable) must not panic or
        // silently produce a malformed artifact.
        let region = region_with_cleanup(None, None, None);
        let artifact = worker_cleanup_artifact(
            "cleanup-2",
            "owner-2",
            "c".repeat(64).as_str(),
            "mask-2",
            "patch-2",
            &region,
            "fallback-sha",
        );

        assert_eq!(
            artifact["bounds"],
            json!({"x": 0, "y": 0, "width": 0, "height": 0})
        );
        assert_eq!(artifact["generator_sha256"], json!("fallback-sha"));
        assert_eq!(artifact["diagnostics"], json!([]));
    }

    #[test]
    fn a_patch_over_a_quarter_of_the_page_is_over_the_r2_gate() {
        // sample83's plate: 1011x1617 on 1412x2000 = 57.9 % of the page.
        let rect = |w: f64, h: f64| {
            [
                Pt { x: 0.0, y: 0.0 },
                Pt { x: w, y: 0.0 },
                Pt { x: w, y: h },
                Pt { x: 0.0, y: h },
            ]
        };
        let plate = rasterize_polygon(&rect(1011.0, 1617.0), 1412, 2000).unwrap();
        assert!(patch_page_share(&plate, 1412, 2000) > MAX_PATCH_PAGE_SHARE);
        // A balloon-sized patch is not.
        let balloon = rasterize_polygon(&rect(300.0, 400.0), 1412, 2000).unwrap();
        assert!(patch_page_share(&balloon, 1412, 2000) < MAX_PATCH_PAGE_SHARE);
        assert_eq!(patch_page_share(&balloon, 0, 0), 1.0);
    }
}
