//! Tracker R7: the Inpainting layer.
//!
//! Each worker cleanup patch becomes its own element on a `layers.type = 'inpainting'` layer, so
//! the editor can move, resize, hide, fade or delete it without touching the text, and the scene
//! builder paints exactly what the editor shows. The element's x/y/max_width/max_height are where
//! the patch is drawn now; `cleanup_ref` names the content-addressed assets it draws.
//!
//! One layer per cleanup pass (user decision R7-D2b). A pass hides the older patches of the
//! regions it re-cleaned, and an older layer left with nothing visible is hidden with them, so a
//! whole-page pass retires the previous layer while a one-region pass (a merge) leaves the rest of
//! the page alone. Old layers are kept as history (R7-D2), like old Translation layers.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::models::OcrRegion;

pub const LAYER_TYPE: &str = "inpainting";

/// What an Inpainting element draws. Stored as `layer_elements.cleanup_ref`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRef {
    pub patch_sha256: String,
    pub patch_byte_length: i64,
    pub mask_sha256: String,
    pub mask_byte_length: i64,
    pub generator_sha256: String,
    /// The worker's bounds for the patch: where "reset" would put it back.
    pub bounds: Value,
    /// Paint position within the layer. Stored rather than derived because region links vanish
    /// on an OCR redo or an import, and the order of overlapping patches must not change then.
    pub order: i64,
}

impl CleanupRef {
    pub fn parse(value: Option<&Value>) -> Option<Self> {
        let parsed: Self = serde_json::from_value(value?.clone()).ok()?;
        (is_sha256(&parsed.patch_sha256) && is_sha256(&parsed.mask_sha256)).then_some(parsed)
    }
}

pub fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The drawn rect for a patch: the worker's bounds, rounded out to whole pixels.
fn rect_of(bounds: &Value) -> Option<(f64, f64, i32, i32)> {
    let number = |key: &str| {
        bounds
            .get(key)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
    };
    let (x, y, w, h) = (
        number("x")?,
        number("y")?,
        number("width")?,
        number("height")?,
    );
    let (w, h) = (w.round() as i32, h.round() as i32);
    (w > 0 && h > 0).then_some((x, y, w, h))
}

/// The region's current worker (or plain-plate) patch, if it has a complete one.
pub fn cleanup_ref_for_region(region: &OcrRegion, order: i64) -> Option<CleanupRef> {
    let reference = CleanupRef {
        patch_sha256: region.cleanup_patch_sha256.clone()?,
        patch_byte_length: region.cleanup_patch_byte_length.unwrap_or(0),
        mask_sha256: region.cleanup_mask_sha256.clone()?,
        mask_byte_length: region.cleanup_mask_byte_length.unwrap_or(0),
        generator_sha256: region
            .cleanup_generator_sha256
            .clone()
            .unwrap_or_else(|| "0".repeat(64)),
        bounds: region.cleanup_bounds.clone()?,
        order,
    };
    (is_sha256(&reference.patch_sha256) && is_sha256(&reference.mask_sha256)).then_some(reference)
}

/// Page regions in reading order, the order a pass paints its patches in.
async fn regions_in_reading_order(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    page_id: Uuid,
) -> Result<Vec<OcrRegion>, sqlx::Error> {
    sqlx::query_as(
        "SELECT * FROM ocr_regions WHERE page_id = $1 \
         ORDER BY panel_reading_order NULLS LAST, bubble_reading_order NULLS LAST, id",
    )
    .bind(page_id)
    .fetch_all(&mut **tx)
    .await
}

/// Hides every older Inpainting element of these regions, then hides any Inpainting layer left
/// with no visible element.
async fn retire_older_patches(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    page_id: Uuid,
    region_ids: &[Uuid],
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE layer_elements e SET visible = FALSE FROM layers l \
         WHERE e.layer_id = l.id AND l.page_id = $1 AND LOWER(l.type) = 'inpainting' \
           AND e.region_id = ANY($2)",
    )
    .bind(page_id)
    .bind(region_ids)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "UPDATE layers l SET visible = FALSE \
         WHERE l.page_id = $1 AND LOWER(l.type) = 'inpainting' AND l.visible IS NOT FALSE \
           AND NOT EXISTS (SELECT 1 FROM layer_elements e \
                           WHERE e.layer_id = l.id AND e.visible IS TRUE)",
    )
    .bind(page_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_patch_element(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    layer_id: Uuid,
    region_id: Option<Uuid>,
    reference: &CleanupRef,
) -> Result<bool, sqlx::Error> {
    let Some((x, y, w, h)) = rect_of(&reference.bounds) else {
        return Ok(false);
    };
    sqlx::query(
        "INSERT INTO layer_elements (id, x, y, max_width, max_height, rotation, visible, auto_size, \
           word_wrap, overflow, is_manually_edited, layer_id, region_id, cleanup_ref, opacity) \
         VALUES ($1, $2, $3, $4, $5, 0, TRUE, FALSE, FALSE, FALSE, FALSE, $6, $7, $8, NULL)",
    )
    .bind(Uuid::new_v4())
    .bind(x)
    .bind(y)
    .bind(w)
    .bind(h)
    .bind(layer_id)
    .bind(region_id)
    .bind(serde_json::to_value(reference).expect("CleanupRef serializes"))
    .execute(&mut **tx)
    .await?;
    Ok(true)
}

/// A new, visible Inpainting layer above the page's other Inpainting layers.
async fn create_layer(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    page_id: Uuid,
    source: &str,
) -> Result<Uuid, sqlx::Error> {
    let layer_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO layers (id, created_at, type, visible, z_order, page_id, metadata_json) \
         VALUES ($1, now(), $2, TRUE, \
           COALESCE((SELECT MAX(z_order) + 1 FROM layers WHERE page_id = $3 AND LOWER(type) = 'inpainting'), \
                    (SELECT MIN(z_order) - 1 FROM layers WHERE page_id = $3), 0), \
           $3, $4)",
    )
    .bind(layer_id)
    .bind(LAYER_TYPE)
    .bind(page_id)
    .bind(serde_json::json!({ "source": source }))
    .execute(&mut **tx)
    .await?;
    Ok(layer_id)
}

/// The newest visible Inpainting layer, or a new one.
async fn newest_visible_layer(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    page_id: Uuid,
    source: &str,
) -> Result<Uuid, sqlx::Error> {
    let newest: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM layers WHERE page_id = $1 AND LOWER(type) = 'inpainting' AND visible \
         ORDER BY z_order DESC, created_at DESC LIMIT 1",
    )
    .bind(page_id)
    .fetch_optional(&mut **tx)
    .await?;
    match newest {
        Some(layer_id) => Ok(layer_id),
        None => create_layer(tx, page_id, source).await,
    }
}

/// Records one cleanup pass: a new, visible Inpainting layer holding the current patch of each of
/// `region_ids` that has one. Returns the layer id, or `None` when no region had a patch (then no
/// layer is made, but the regions' older patches are still retired: the pass replaced them).
pub async fn record_cleanup_pass(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    page_id: Uuid,
    region_ids: &[Uuid],
) -> Result<Option<Uuid>, sqlx::Error> {
    if region_ids.is_empty() {
        return Ok(None);
    }
    retire_older_patches(tx, page_id, region_ids).await?;
    let patches: Vec<(Uuid, CleanupRef)> = regions_in_reading_order(tx, page_id)
        .await?
        .iter()
        .enumerate()
        .filter(|(_, region)| region_ids.contains(&region.id))
        .filter_map(|(index, region)| {
            cleanup_ref_for_region(region, index as i64).map(|reference| (region.id, reference))
        })
        .collect();
    if patches.is_empty() {
        return Ok(None);
    }
    let layer_id = create_layer(tx, page_id, "cleanup-pass").await?;
    for (region_id, reference) in &patches {
        insert_patch_element(tx, layer_id, Some(*region_id), reference).await?;
    }
    Ok(Some(layer_id))
}

/// A plain mask applied in review is not a pipeline pass: its patch joins the newest visible
/// Inpainting layer (or starts one) instead of adding a layer per click.
pub async fn record_region_patch(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    page_id: Uuid,
    region_id: Uuid,
) -> Result<(), sqlx::Error> {
    retire_older_patches(tx, page_id, &[region_id]).await?;
    let regions = regions_in_reading_order(tx, page_id).await?;
    let Some(reference) = regions
        .iter()
        .position(|region| region.id == region_id)
        .and_then(|index| cleanup_ref_for_region(&regions[index], index as i64))
    else {
        return Ok(());
    };
    let layer_id = newest_visible_layer(tx, page_id, "plain-mask").await?;
    insert_patch_element(tx, layer_id, Some(region_id), &reference).await?;
    Ok(())
}

/// A hand-marked repaint from the mask editor (2026-09-28): one region-less patch on a new
/// Inpainting layer above the page's others, so it paints over every earlier patch and under all
/// text. The element is marked manually edited, which keeps the page's re-renders from queuing a
/// paid QA pass. Returns the layer and element ids, or `None` for unusable bounds.
pub async fn record_manual_patch(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    page_id: Uuid,
    reference: &CleanupRef,
) -> Result<Option<(Uuid, Uuid)>, sqlx::Error> {
    let Some((x, y, w, h)) = rect_of(&reference.bounds) else {
        return Ok(None);
    };
    let layer_id = create_layer(tx, page_id, "manual").await?;
    let element_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO layer_elements (id, x, y, max_width, max_height, rotation, visible, auto_size, \
           word_wrap, overflow, is_manually_edited, edited_at, layer_id, region_id, cleanup_ref, opacity) \
         VALUES ($1, $2, $3, $4, $5, 0, TRUE, FALSE, FALSE, FALSE, TRUE, now(), $6, NULL, $7, NULL)",
    )
    .bind(element_id)
    .bind(x)
    .bind(y)
    .bind(w)
    .bind(h)
    .bind(layer_id)
    .bind(serde_json::to_value(reference).expect("CleanupRef serializes"))
    .execute(&mut **tx)
    .await?;
    Ok(Some((layer_id, element_id)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reference() -> CleanupRef {
        CleanupRef {
            patch_sha256: "a".repeat(64),
            patch_byte_length: 10,
            mask_sha256: "b".repeat(64),
            mask_byte_length: 5,
            generator_sha256: "c".repeat(64),
            bounds: json!({"x": 4, "y": 5.5, "width": 20, "height": 10}),
            order: 3,
        }
    }

    #[test]
    fn a_cleanup_ref_round_trips_through_its_stored_json() {
        let stored = serde_json::to_value(reference()).unwrap();
        assert_eq!(stored["patchSha256"], "a".repeat(64));
        assert_eq!(stored["order"], 3);
        assert_eq!(CleanupRef::parse(Some(&stored)), Some(reference()));
    }

    #[test]
    fn a_ref_with_a_malformed_sha_is_refused() {
        let mut stored = serde_json::to_value(reference()).unwrap();
        stored["patchSha256"] = json!("../../other-page/x");
        assert_eq!(CleanupRef::parse(Some(&stored)), None);
        assert_eq!(CleanupRef::parse(None), None);
    }

    #[test]
    fn the_drawn_rect_is_the_bounds_with_whole_pixel_size() {
        assert_eq!(rect_of(&reference().bounds), Some((4.0, 5.5, 20, 10)));
        assert_eq!(
            rect_of(&json!({"x": 0, "y": 0, "width": 0, "height": 3})),
            None
        );
    }
}
