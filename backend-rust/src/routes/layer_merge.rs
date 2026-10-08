//! F3 (#178): merging layers.
//!
//! Only like layers merge: text with text (Translation and SFX), patches with patches. The
//! elements move into the lowest layer, keeping their ids, and the others are deleted. A merge
//! never changes the page:
//! - text: where two layers have visible text for one region, the upper one stays shown and the
//!   lower ones are hidden, as in any layer stack (owner, D2, 2026-10-07). Their ids are recorded
//!   in the merged layer's `metadata_json.merge_hidden`, and `delete-hidden-texts` removes them;
//! - patches keep their paint order: each upper layer's patches are renumbered after the lower
//!   ones', so they keep painting over them, and each stays its own element (2026-10-01);
//! - layers that are not all shown, or all hidden, are refused: merging a hidden layer into a shown
//!   one would show it.
//!
//! The merged layer keeps the lowest layer's place, group and name. Its pipeline metadata becomes
//! the top layer's, the newest pass (QA status is read from the newest translation layer), and
//! every other layer's metadata, costs included, is kept under `merged_from`.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error;
use crate::layer_tree::MergeKind;
use crate::models::Layer;
use crate::page_freshness::advance_page_revision_by_hand;
use crate::routes::layers::deny_viewer;
use crate::state::AppState;

const MERGE: &str = "/api/pages/{pageId}/layers/merge";
const DELETE_HIDDEN: &str = "/api/layers/{id}/delete-hidden-texts";

/// POST /api/pages/{pageId}/layers/merge — `{"layerIds": [...]}`, two or more like layers.
/// Answers `{layer, mergedLayerIds, hiddenTexts, hiddenRegions}`.
pub async fn merge_layers(
    State(state): State<AppState>,
    user: AuthUser,
    Path(page_id): Path<Uuid>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if let Some(denied) = deny_viewer(&user, MERGE) {
        return denied;
    }
    let Ok(Json(payload)) = body else {
        return error::unreadable_body(MERGE);
    };
    let mut ids: Vec<Uuid> = payload
        .get("layerIds")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter_map(|s| Uuid::parse_str(s).ok())
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    if ids.len() < 2 {
        return error::bad_request("layerIds must name two or more layers", MERGE);
    }

    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(err) => {
            tracing::error!("Could not open a transaction to merge layers on {page_id}: {err}");
            return error::internal_error(MERGE);
        }
    };
    match merge_in(&mut tx, page_id, &ids).await {
        Ok(Ok(outcome)) => {
            if let Err(err) = advance_page_revision_by_hand(&mut tx, page_id).await {
                tracing::error!(
                    "Could not advance page revision after a merge on {page_id}: {err}"
                );
                let _ = tx.rollback().await;
                return error::internal_error(MERGE);
            }
            if let Err(err) = tx.commit().await {
                tracing::error!("Could not commit a merge on {page_id}: {err}");
                return error::internal_error(MERGE);
            }
            Json(outcome).into_response()
        }
        Ok(Err(problem)) => {
            let _ = tx.rollback().await;
            error::bad_request(problem, MERGE)
        }
        Err(err) => {
            tracing::error!("Could not merge layers on {page_id}: {err}");
            let _ = tx.rollback().await;
            error::internal_error(MERGE)
        }
    }
}

async fn merge_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    page_id: Uuid,
    ids: &[Uuid],
) -> Result<Result<Value, &'static str>, sqlx::Error> {
    let layers: Vec<Layer> = sqlx::query_as(
        "SELECT * FROM layers WHERE id = ANY($1) AND page_id = $2 \
         ORDER BY z_order ASC, created_at ASC, id ASC FOR UPDATE",
    )
    .bind(ids)
    .bind(page_id)
    .fetch_all(&mut **tx)
    .await?;
    if layers.len() != ids.len() {
        return Ok(Err("every layer must be on this page"));
    }
    let kinds: Vec<Option<MergeKind>> = layers
        .iter()
        .map(|layer| MergeKind::of(&layer.layer_type))
        .collect();
    let Some(kind) = kinds[0] else {
        return Ok(Err("only text layers and patch layers merge"));
    };
    if kinds.iter().any(|other| *other != Some(kind)) {
        return Ok(Err(
            "only like layers merge: text with text, patches with patches",
        ));
    }
    // A region redo picks a page's translation by its language, so English and French text must
    // not end up in one layer. A layer with no language (an SFX layer) merges with any.
    let language = match merge_language(&layers) {
        Ok(language) => language,
        Err(problem) => return Ok(Err(problem)),
    };
    let mut shown = Vec::with_capacity(layers.len());
    for layer in &layers {
        shown.push(crate::layer_tree::is_shown(tx, layer.id).await?);
    }
    if shown.iter().any(|s| *s != shown[0]) {
        return Ok(Err(
            "show or hide all the layers first: merging a hidden layer into a shown one would show it",
        ));
    }
    // In a hidden group, every layer is hidden whatever its own switch says; the merged layer
    // keeps only the lowest one's switch, so showing the group would then change what shows.
    let own = |layer: &Layer| layer.visible.unwrap_or(false);
    if layers.iter().any(|layer| own(layer) != own(&layers[0])) {
        return Ok(Err(
            "show or hide all the layers first: their own switches differ, and the merged layer \
             keeps only one",
        ));
    }
    // Layers hidden only by their group show again with it, so they keep the check; only layers
    // whose own switch is off may merge across a shown one.
    if own(&layers[0]) && skips_shown_layer(tx, page_id, ids, kind, &layers).await? {
        return Ok(Err(
            "a shown layer of the same kind lies between these layers: merging would move it over \
             the upper layer's elements; merge it too, or hide it first",
        ));
    }

    let target = &layers[0];
    let sources = &layers[1..];
    let source_ids: Vec<Uuid> = sources.iter().map(|layer| layer.id).collect();

    let hidden: Vec<Uuid> = match kind {
        MergeKind::Text => {
            hide_null_text(tx, ids).await?;
            hide_covered_text(tx, &layers).await?
        }
        MergeKind::Patches => {
            renumber_patches(tx, &layers).await?;
            Vec::new()
        }
    };
    let hidden_regions: i64 = if hidden.is_empty() {
        0
    } else {
        sqlx::query_scalar(
            "SELECT COUNT(DISTINCT region_id) FROM layer_elements WHERE id = ANY($1)",
        )
        .bind(&hidden)
        .fetch_one(&mut **tx)
        .await?
    };

    sqlx::query("UPDATE layer_elements SET layer_id = $1 WHERE layer_id = ANY($2)")
        .bind(target.id)
        .bind(&source_ids)
        .execute(&mut **tx)
        .await?;

    let metadata = merged_metadata(&layers, &hidden);
    sqlx::query(
        "UPDATE layers SET metadata_json = $2, \
           target_language = COALESCE(target_language, $3) WHERE id = $1",
    )
    .bind(target.id)
    .bind(&metadata)
    .bind(language)
    .execute(&mut **tx)
    .await?;
    // The sources hold no elements now, so nothing cascades. Their overlay records, if any, stay
    // in `merged_from`; the text they superseded stays hidden under the merged layer's text.
    sqlx::query("DELETE FROM layers WHERE id = ANY($1)")
        .bind(&source_ids)
        .execute(&mut **tx)
        .await?;

    let layer: Layer = sqlx::query_as("SELECT * FROM layers WHERE id = $1")
        .bind(target.id)
        .fetch_one(&mut **tx)
        .await?;
    Ok(Ok(json!({
        "layer": layer,
        "mergedLayerIds": source_ids,
        "hiddenTexts": hidden.len(),
        "hiddenRegions": hidden_regions,
    })))
}

/// Whether a shown like layer that is not being merged lies between the lowest and the highest
/// layer in the stack (`bottom_to_top`'s order). The merged elements would move under it, and the
/// page would change. Patches always paint under text, so only like layers matter.
async fn skips_shown_layer(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    page_id: Uuid,
    ids: &[Uuid],
    kind: MergeKind,
    bottom_to_top: &[Layer],
) -> Result<bool, sqlx::Error> {
    let lowest = &bottom_to_top[0];
    let highest = bottom_to_top.last().expect("two or more layers");
    let types: &[&str] = match kind {
        MergeKind::Text => &["translation", "sfx"],
        MergeKind::Patches => &["inpainting"],
    };
    sqlx::query_scalar(concat!(
        "SELECT EXISTS (SELECT 1 FROM layers l WHERE l.page_id = $1 AND NOT (l.id = ANY($2)) \
           AND LOWER(l.type) = ANY($3) \
           AND (l.z_order, l.created_at, l.id) > ($4, $5, $6) \
           AND (l.z_order, l.created_at, l.id) < ($7, $8, $9) AND ",
        crate::layer_shown!("l"),
        ")"
    ))
    .bind(page_id)
    .bind(ids)
    .bind(types)
    .bind(lowest.z_order)
    .bind(lowest.created_at)
    .bind(lowest.id)
    .bind(highest.z_order)
    .bind(highest.created_at)
    .bind(highest.id)
    .fetch_one(&mut **tx)
    .await
}

/// The one target language the layers share, ignoring layers with none (lower case), or a refusal
/// when two of them name different languages.
fn merge_language(layers: &[Layer]) -> Result<Option<String>, &'static str> {
    let mut found: Option<String> = None;
    for layer in layers {
        let Some(language) = layer.target_language.as_deref().map(str::trim) else {
            continue;
        };
        if language.is_empty() {
            continue;
        }
        let language = language.to_ascii_lowercase();
        match &found {
            Some(seen) if *seen != language => {
                return Err("only text layers in one target language merge");
            }
            Some(_) => {}
            None => found = Some(language),
        }
    }
    Ok(found)
}

/// Writes the canvas's reading of a null switch (hidden, AUDIT-F25) into the merged layers' text,
/// so the scene builder, which still reads a null as shown, draws the merged layer as the canvas
/// does.
async fn hide_null_text(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    ids: &[Uuid],
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE layer_elements SET visible = FALSE WHERE layer_id = ANY($1) AND visible IS NULL",
    )
    .bind(ids)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Hides the lower layers' text wherever an upper layer has visible text for the same region, and
/// returns what it hid. "Visible" is the canvas's rule (AUDIT-F25): an element shows only when it
/// is TRUE, so a null covers nothing, and it has text.
async fn hide_covered_text(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    bottom_to_top: &[Layer],
) -> Result<Vec<Uuid>, sqlx::Error> {
    let rows: Vec<(Uuid, Uuid, Uuid)> = sqlx::query_as(
        "SELECT id, layer_id, region_id FROM layer_elements \
         WHERE layer_id = ANY($1) AND region_id IS NOT NULL \
           AND visible IS TRUE AND COALESCE(TRIM(text), '') <> ''",
    )
    .bind(
        bottom_to_top
            .iter()
            .map(|layer| layer.id)
            .collect::<Vec<_>>(),
    )
    .fetch_all(&mut **tx)
    .await?;
    let rank = |layer_id: Uuid| {
        bottom_to_top
            .iter()
            .position(|layer| layer.id == layer_id)
            .unwrap_or(0)
    };
    let mut top: std::collections::HashMap<Uuid, usize> = std::collections::HashMap::new();
    for (_, layer_id, region_id) in &rows {
        let entry = top.entry(*region_id).or_insert(0);
        *entry = (*entry).max(rank(*layer_id));
    }
    let hidden: Vec<Uuid> = rows
        .iter()
        .filter(|(_, layer_id, region_id)| rank(*layer_id) < top[region_id])
        .map(|(id, _, _)| *id)
        .collect();
    if !hidden.is_empty() {
        sqlx::query("UPDATE layer_elements SET visible = FALSE WHERE id = ANY($1)")
            .bind(&hidden)
            .execute(&mut **tx)
            .await?;
    }
    Ok(hidden)
}

/// Renumbers each upper layer's patches to paint after every patch below it. Only patches whose
/// `cleanup_ref.order` is a whole number are renumbered: any other would fail the cast, or turn the
/// whole ref NULL through `jsonb_set`.
async fn renumber_patches(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    bottom_to_top: &[Layer],
) -> Result<(), sqlx::Error> {
    let mut next: i64 = 0;
    for layer in bottom_to_top {
        let (lowest, highest): (Option<i64>, Option<i64>) = sqlx::query_as(
            "SELECT MIN((cleanup_ref->>'order')::bigint), MAX((cleanup_ref->>'order')::bigint) \
             FROM layer_elements WHERE layer_id = $1 AND cleanup_ref->>'order' ~ '^-?[0-9]+$'",
        )
        .bind(layer.id)
        .fetch_one(&mut **tx)
        .await?;
        let (Some(lowest), Some(highest)) = (lowest, highest) else {
            continue;
        };
        let shift = next - lowest;
        if shift != 0 {
            sqlx::query(
                "UPDATE layer_elements SET cleanup_ref = jsonb_set(cleanup_ref, '{order}', \
                   to_jsonb((cleanup_ref->>'order')::bigint + $2)) \
                 WHERE layer_id = $1 AND cleanup_ref->>'order' ~ '^-?[0-9]+$'",
            )
            .bind(layer.id)
            .bind(shift)
            .execute(&mut **tx)
            .await?;
        }
        next += highest - lowest + 1;
    }
    Ok(())
}

/// What marks a layer as a region-redo overlay (`coordinator::create_region_overlay_layer`).
const OVERLAY_KEYS: &[&str] = &[
    "overlay",
    "region_id",
    "supersedes_layer",
    "superseded_elements",
];

/// The merged layer's metadata: the top layer's pipeline record, the bottom layer's name, and every
/// other layer's record under `merged_from` (oldest merge first).
fn merged_metadata(bottom_to_top: &[Layer], hidden: &[Uuid]) -> Value {
    let as_object = |layer: &Layer| match &layer.metadata_json {
        Some(Value::Object(map)) => map.clone(),
        _ => serde_json::Map::new(),
    };
    let target = &bottom_to_top[0];
    let top = bottom_to_top.last().expect("two or more layers");
    let mut merged = as_object(top);
    // The merged layer is a whole layer, not a redo overlay: kept, these marks would make deleting
    // or hiding it "give back" one region's old text, and the export would skip it as an overlay.
    // An overlay's record is kept under `merged_from` like any other.
    for key in OVERLAY_KEYS {
        merged.remove(*key);
    }
    let mut merged_from: Vec<Value> = Vec::new();
    for layer in bottom_to_top {
        let mut record = as_object(layer);
        // Earlier merges are flattened, so the list is one level deep.
        if let Some(Value::Array(earlier)) = record.remove("merged_from") {
            merged_from.extend(earlier);
        }
        record.remove("merge_hidden");
        if layer.id != top.id || record.contains_key("overlay") {
            merged_from.push(json!({
                "layerId": layer.id,
                "type": layer.layer_type,
                "createdAt": layer.created_at,
                "metadata": Value::Object(record),
            }));
        }
    }
    merged.remove("merged_from");
    if !merged_from.is_empty() {
        merged.insert("merged_from".into(), Value::Array(merged_from));
    }
    let mut hidden_ids: Vec<Value> = bottom_to_top
        .iter()
        .filter_map(|layer| {
            layer
                .metadata_json
                .as_ref()?
                .get("merge_hidden")?
                .as_array()
                .cloned()
        })
        .flatten()
        .collect();
    hidden_ids.extend(hidden.iter().map(|id| json!(id)));
    merged.remove("merge_hidden");
    if !hidden_ids.is_empty() {
        merged.insert("merge_hidden".into(), Value::Array(hidden_ids));
    }
    match as_object(target).get("layer_name") {
        Some(name) => {
            merged.insert("layer_name".into(), name.clone());
        }
        None => {
            merged.remove("layer_name");
        }
    }
    Value::Object(merged)
}

/// POST /api/layers/{id}/delete-hidden-texts — deletes the text a merge hid (D2's follow-up).
/// Answers `{deleted}`. A hidden text the user has since shown again is kept.
pub async fn delete_hidden_texts(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Response {
    if let Some(denied) = deny_viewer(&user, DELETE_HIDDEN) {
        return denied;
    }
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(err) => {
            tracing::error!("Could not open a transaction for layer {id}: {err}");
            return error::internal_error(DELETE_HIDDEN);
        }
    };
    let row: Option<(Uuid, Option<Value>)> =
        match sqlx::query_as("SELECT page_id, metadata_json FROM layers WHERE id = $1 FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(row) => row,
            Err(err) => {
                tracing::error!("Could not read layer {id}: {err}");
                return error::internal_error(DELETE_HIDDEN);
            }
        };
    let Some((page_id, metadata)) = row else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let recorded: Vec<Uuid> = metadata
        .as_ref()
        .and_then(|meta| meta.get("merge_hidden"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter_map(|s| Uuid::parse_str(s).ok())
                .collect()
        })
        .unwrap_or_default();
    let result: Result<u64, sqlx::Error> = async {
        let deleted = sqlx::query(
            "DELETE FROM layer_elements WHERE id = ANY($1) AND layer_id = $2 AND visible = FALSE",
        )
        .bind(&recorded)
        .bind(id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        sqlx::query(
            "UPDATE layers SET metadata_json = metadata_json - 'merge_hidden' WHERE id = $1",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
        Ok(deleted)
    }
    .await;
    let deleted = match result {
        Ok(deleted) => deleted,
        Err(err) => {
            tracing::error!("Could not delete the hidden texts of layer {id}: {err}");
            let _ = tx.rollback().await;
            return error::internal_error(DELETE_HIDDEN);
        }
    };
    if let Err(err) = advance_page_revision_by_hand(&mut tx, page_id).await {
        tracing::error!("Could not advance page revision for layer {id}: {err}");
        let _ = tx.rollback().await;
        return error::internal_error(DELETE_HIDDEN);
    }
    if let Err(err) = tx.commit().await {
        tracing::error!("Could not commit deleting layer {id}'s hidden texts: {err}");
        return error::internal_error(DELETE_HIDDEN);
    }
    Json(json!({ "deleted": deleted })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn layer(id: u128, name: Option<&str>, meta: Value) -> Layer {
        let mut meta = meta;
        if let (Some(name), Some(map)) = (name, meta.as_object_mut()) {
            map.insert("layer_name".into(), json!(name));
        }
        Layer {
            id: Uuid::from_u128(id),
            created_at: Utc::now(),
            metadata_json: Some(meta),
            target_language: Some("en".into()),
            layer_type: "translation".into(),
            visible: Some(true),
            z_order: id as i32,
            page_id: Uuid::nil(),
            parent_id: None,
        }
    }

    #[test]
    fn the_merged_layer_keeps_the_newest_pass_the_bottom_name_and_every_cost() {
        let bottom = layer(
            1,
            Some("Translation (EN)"),
            json!({"qa": {"status": "old"}, "cost": {"estimated_cost": 0.01}}),
        );
        let top = layer(
            2,
            Some("Translation (retry)"),
            json!({"qa": {"status": "new"}, "cost": {"estimated_cost": 0.02}}),
        );
        let hidden = [Uuid::from_u128(9)];
        let merged = merged_metadata(&[bottom, top], &hidden);
        assert_eq!(merged["qa"]["status"], "new");
        assert_eq!(merged["cost"]["estimated_cost"], 0.02);
        assert_eq!(merged["layer_name"], "Translation (EN)");
        let from = merged["merged_from"].as_array().unwrap();
        assert_eq!(from.len(), 1);
        assert_eq!(from[0]["metadata"]["cost"]["estimated_cost"], 0.01);
        assert_eq!(merged["merge_hidden"], json!([Uuid::from_u128(9)]));
    }

    #[test]
    fn a_merged_redo_overlay_is_no_longer_an_overlay() {
        let bottom = layer(1, Some("Translation (EN)"), json!({}));
        let overlay = layer(
            2,
            Some("Translation (region redo)"),
            json!({"overlay": true, "region_id": "r", "supersedes_layer": "l",
                   "superseded_elements": ["e"], "qa": {"status": "new"}}),
        );
        let merged = merged_metadata(&[bottom, overlay], &[]);
        for key in OVERLAY_KEYS {
            assert!(merged.get(*key).is_none(), "{key} kept");
        }
        assert_eq!(merged["qa"]["status"], "new");
        let from = merged["merged_from"].as_array().unwrap();
        assert_eq!(from.len(), 2, "the overlay's record is kept");
        assert_eq!(from[1]["metadata"]["overlay"], true);
    }

    #[test]
    fn layers_in_two_languages_do_not_merge_but_one_without_a_language_does() {
        let lang = |id: u128, language: Option<&str>| {
            let mut l = layer(id, None, json!({}));
            l.target_language = language.map(str::to_string);
            l
        };
        assert_eq!(
            merge_language(&[lang(1, None), lang(2, Some("EN")), lang(3, Some("en"))]),
            Ok(Some("en".into()))
        );
        assert_eq!(merge_language(&[lang(1, None), lang(2, None)]), Ok(None));
        assert!(merge_language(&[lang(1, Some("en")), lang(2, Some("fr"))]).is_err());
    }

    #[test]
    fn a_second_merge_flattens_the_first() {
        let first = merged_metadata(
            &[
                layer(1, None, json!({"cost": {"estimated_cost": 1.0}})),
                layer(2, None, json!({"cost": {"estimated_cost": 2.0}})),
            ],
            &[Uuid::from_u128(7)],
        );
        let mut merged_layer = layer(1, None, json!({}));
        merged_layer.metadata_json = Some(first);
        let second = merged_metadata(
            &[
                merged_layer,
                layer(3, None, json!({"cost": {"estimated_cost": 3.0}})),
            ],
            &[],
        );
        let costs: Vec<f64> = second["merged_from"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["metadata"]["cost"]["estimated_cost"].as_f64().unwrap())
            .collect();
        assert_eq!(costs, vec![1.0, 2.0]);
        assert_eq!(second["cost"]["estimated_cost"], 3.0);
        assert_eq!(second["merge_hidden"], json!([Uuid::from_u128(7)]));
        assert!(second.get("layer_name").is_none());
    }
}
