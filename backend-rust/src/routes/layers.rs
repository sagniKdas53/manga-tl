//! `/api/layers`, `/api/layer-elements`, layer creation under pages/images.
//! Port of LayerController. All mutating routes are ADMIN/TRANSLATOR only.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error;
use crate::models::{Layer, LayerEditHistory, LayerElement};
use crate::state::AppState;

pub(crate) fn deny_viewer(user: &AuthUser, instance: &str) -> Option<Response> {
    if user.role.eq_ignore_ascii_case("viewer") {
        return Some(error::access_denied(instance));
    }
    None
}

/// `maxWidth`/`maxHeight` are `integer` columns, but the editor derives them from geometry.
///
/// AUDIT-F14: rotating a box runs its corners through `rotatePoint`, which does trigonometry and
/// does not round, so the bounding box of a rotated polygon is fractional. A plain `Option<i32>`
/// made serde reject the entire body, axum turned that into a `JsonRejection`, and the handler
/// answered 400 — so *every* save failed for as long as the box stayed rotated, while dragging
/// (which rounds client-side) kept working. The column is still an integer; the rounding just
/// happens here rather than being demanded of every caller.
fn deserialize_rounded_i32<'de, D>(deserializer: D) -> Result<Option<i32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<f64>::deserialize(deserializer)?;
    Ok(value.map(|v| {
        if v.is_nan() {
            0
        } else {
            v.round().clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
        }
    }))
}

#[derive(Deserialize)]
#[allow(non_snake_case)]
pub struct LayerElementInput {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub font: Option<String>,
    #[serde(default)]
    pub size: Option<f64>,
    #[serde(default)]
    pub autoSize: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_rounded_i32")]
    pub maxWidth: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_rounded_i32")]
    pub maxHeight: Option<i32>,
    #[serde(default)]
    pub wordWrap: Option<bool>,
    #[serde(default)]
    pub rotation: Option<f64>,
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    #[serde(default)]
    pub visible: Option<bool>,
    #[serde(default)]
    pub overflow: Option<bool>,
    #[serde(default)]
    pub backgroundColor: Option<String>,
    #[serde(default)]
    pub textColor: Option<String>,
    #[serde(default)]
    pub fontWeight: Option<String>,
    #[serde(default)]
    pub fontStyle: Option<String>,
    #[serde(default)]
    pub boxShape: Option<String>,
    #[serde(default)]
    pub maskPolygon: Option<serde_json::Value>,
    #[serde(default)]
    pub regionId: Option<Uuid>,
}

/// captureStateMap port.
fn capture_state(el: &LayerElement) -> serde_json::Value {
    json!({
        "text": el.text, "font": el.font, "size": el.size,
        "autoSize": el.auto_size, "maxWidth": el.max_width, "maxHeight": el.max_height,
        "wordWrap": el.word_wrap, "rotation": el.rotation, "x": el.x, "y": el.y,
        "visible": el.visible, "overflow": el.overflow,
        "backgroundColor": el.background_color, "textColor": el.text_color,
        "fontWeight": el.font_weight, "fontStyle": el.font_style, "boxShape": el.box_shape,
        "maskPolygon": el.mask_polygon.as_ref().map(|v| serde_json::Value::String(v.to_string())),
        "regionId": el.region_id.map(|r| r.to_string()),
    })
}

pub(crate) async fn touch_page(pool: &sqlx::PgPool, layer_id: Uuid) {
    sqlx::query(
        "UPDATE pages SET last_edited_at = now() WHERE id = (SELECT page_id FROM layers WHERE id = $1)",
    )
    .bind(layer_id)
    .execute(pool)
    .await
    .expect("page touch");
}

/// PUT /api/layer-elements/{id} — partial update + edit history when state changed.
pub async fn update_layer_element(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    body: Result<Json<LayerElementInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let instance = "/api/layer-elements/{id}";
    if let Some(denied) = deny_viewer(&user, instance) {
        return denied;
    }
    let Json(dto) = match body {
        Ok(json) => json,
        Err(_) => return error::unreadable_body(instance),
    };

    let Some(element) =
        sqlx::query_as::<_, LayerElement>("SELECT * FROM layer_elements WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None)
    else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let prev_json = serde_json::to_value(capture_state(&element)).expect("prev json");

    let updated: LayerElement = sqlx::query_as(
        "UPDATE layer_elements SET \
           text = COALESCE($2, text), font = COALESCE($3, font), size = COALESCE($4, size), \
           auto_size = COALESCE($5, auto_size), max_width = COALESCE($6, max_width), \
           max_height = COALESCE($7, max_height), word_wrap = COALESCE($8, word_wrap), \
           rotation = COALESCE($9, rotation), x = COALESCE($10, x), y = COALESCE($11, y), \
           visible = COALESCE($12, visible), overflow = COALESCE($13, overflow), \
           background_color = COALESCE($14, background_color), \
           text_color = COALESCE($15, text_color), font_weight = COALESCE($16, font_weight), \
           font_style = COALESCE($17, font_style), box_shape = COALESCE($18, box_shape), \
           mask_polygon = COALESCE($19, mask_polygon), \
           region_id = CASE WHEN $20::uuid IS NULL THEN region_id ELSE $20 END, \
           is_manually_edited = true, edited_at = now() \
         WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .bind(dto.text.clone())
    .bind(dto.font.clone())
    .bind(dto.size)
    .bind(dto.autoSize)
    .bind(dto.maxWidth)
    .bind(dto.maxHeight)
    .bind(dto.wordWrap)
    .bind(dto.rotation)
    .bind(dto.x)
    .bind(dto.y)
    .bind(dto.visible)
    .bind(dto.overflow)
    .bind(dto.backgroundColor.clone())
    .bind(dto.textColor.clone())
    .bind(dto.fontWeight.clone())
    .bind(dto.fontStyle.clone())
    .bind(dto.boxShape.clone())
    .bind(
        dto.maskPolygon
            .clone()
            .and_then(crate::models::normalize_mask_polygon),
    )
    .bind(dto.regionId)
    .fetch_one(&state.pool)
    .await
    .expect("layer element update");

    let new_json = serde_json::to_value(capture_state(&updated)).expect("new json");
    if prev_json != new_json {
        sqlx::query(
            "INSERT INTO layer_edit_history (id, edited_at, previous_value_json, new_value_json, edited_by, layer_element_id) \
             VALUES ($1, now(), $2, $3, $4, $5)",
        )
        .bind(Uuid::new_v4())
        .bind(&prev_json)
        .bind(&new_json)
        .bind(user.id)
        .bind(id)
        .execute(&state.pool)
        .await
        .expect("edit history insert");

        // metadata_json.last_modified on the parent layer (only when it is an object).
        sqlx::query(
            "UPDATE layers SET metadata_json = CASE \
               WHEN jsonb_typeof(metadata_json) = 'object' \
                 THEN jsonb_set(metadata_json, '{last_modified}', to_jsonb(now()::text)) \
               ELSE metadata_json END \
             WHERE id = (SELECT layer_id FROM layer_elements WHERE id = $1)",
        )
        .bind(id)
        .execute(&state.pool)
        .await
        .expect("layer metadata bump");
    }
    touch_page(&state.pool, id).await;

    Json(updated).into_response()
}

/// GET /api/layer-elements/{id}/history — newest first.
pub async fn element_history(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Response {
    if let Some(denied) = deny_viewer(&user, "/api/layer-elements/{id}/history") {
        return denied;
    }
    let history: Vec<LayerEditHistory> = sqlx::query_as(
        "SELECT * FROM layer_edit_history WHERE layer_element_id = $1 ORDER BY edited_at DESC",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    Json(history).into_response()
}

/// Narrows a client-supplied integer to the column width without wrapping.
///
/// `as i32` on an `i64` discards the high bits, so `4294967296` arrives as `0` -- an absurd
/// request silently becomes a plausible one, which is the shape of bug that let a page move to
/// the wrong slot and report success. Saturating instead keeps the one property ordering
/// actually depends on: a larger request never produces a smaller stored value.
pub(crate) fn saturating_i32(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

/// Jackson `((Number) raw).intValue()` parity: fractional zOrder values coerce
/// (2.5 → 2) instead of silently falling back to the default.
///
/// Deliberate divergence on one point: Jackson's `intValue()` is a narrowing conversion, so it
/// wraps on anything past `i32`, and `as i32` matched that exactly. Parity is worth keeping for
/// behaviour a caller could sensibly depend on, and nothing depends on `zOrder: 4294967296`
/// sorting to the bottom. It saturates now. (The `as_f64` branch already saturates -- Rust's
/// float-to-int casts are saturating, with NaN mapping to 0.)
pub(crate) fn z_order_of(value: Option<&serde_json::Value>) -> Option<i32> {
    value.and_then(|v| {
        v.as_i64()
            .map(saturating_i32)
            .or_else(|| v.as_f64().map(|f| f as i32))
    })
}

async fn insert_layer(pool: &sqlx::PgPool, page_id: Uuid, payload: &serde_json::Value) -> Layer {
    let layer_type = payload
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("translation");
    let target_language = payload.get("targetLanguage").and_then(|v| v.as_str());
    let visible = payload
        .get("visible")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let z_order = z_order_of(payload.get("zOrder")).unwrap_or(0);
    let metadata = payload.get("metadataJson").cloned();

    sqlx::query_as(
        "INSERT INTO layers (id, created_at, metadata_json, target_language, type, visible, z_order, page_id) \
         VALUES ($1, now(), $2, $3, $4, $5, $6, $7) RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(metadata)
    .bind(target_language)
    .bind(layer_type)
    .bind(visible)
    .bind(z_order)
    .bind(page_id)
    .fetch_one(pool)
    .await
    .expect("layer insert")
}

/// POST /api/pages/{pageId}/layers
pub async fn create_page_layer(
    State(state): State<AppState>,
    user: AuthUser,
    Path(page_id): Path<Uuid>,
    body: Result<Json<serde_json::Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let instance = "/api/pages/{pageId}/layers";
    if let Some(denied) = deny_viewer(&user, instance) {
        return denied;
    }
    let Ok(Json(payload)) = body else {
        return error::unreadable_body(instance);
    };
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pages WHERE id = $1)")
        .bind(page_id)
        .fetch_one(&state.pool)
        .await
        .unwrap_or(false);
    if !exists {
        return error::not_found(&format!("Page not found: {page_id}"), instance);
    }

    let layer = insert_layer(&state.pool, page_id, &payload).await;
    touch_page(&state.pool, layer.id).await;
    Json(layer).into_response()
}

/// POST /api/images/{imageId}/layers — resolves the image's first page, same layer create.
pub async fn create_image_layer(
    State(state): State<AppState>,
    user: AuthUser,
    Path(image_id): Path<Uuid>,
    body: Result<Json<serde_json::Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let instance = "/api/images/{imageId}/layers";
    if let Some(denied) = deny_viewer(&user, instance) {
        return denied;
    }
    let Ok(Json(payload)) = body else {
        return error::unreadable_body(instance);
    };
    let page_id: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM pages WHERE image_id = $1 LIMIT 1")
            .bind(image_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
    let Some(page_id) = page_id else {
        return error::not_found(&format!("No page found for image: {image_id}"), instance);
    };

    let layer = insert_layer(&state.pool, page_id, &payload).await;
    touch_page(&state.pool, layer.id).await;
    Json(layer).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AUDIT-F14. Rotating a box gives it a fractional bounding box, and the editor puts that
    /// straight into `maxWidth`/`maxHeight`. Before this, serde rejected the body and the save
    /// came back 400 — so a rotated element could never be saved again, by any means.
    #[test]
    fn accepts_the_fractional_box_a_rotation_produces() {
        let body = r#"{"maxWidth": 186.43, "maxHeight": 187.91, "rotation": 12.5}"#;
        let dto: LayerElementInput = serde_json::from_str(body).expect("rotated box must parse");
        assert_eq!(dto.maxWidth, Some(186));
        assert_eq!(dto.maxHeight, Some(188));
        assert_eq!(dto.rotation, Some(12.5));
    }

    /// The inspector panel on a rotated element, as reported: every field fractional, and the
    /// save failing outright before AUDIT-F14. Kept with the real numbers because they are the
    /// shape a rotated bounding box actually produces.
    #[test]
    fn takes_the_whole_inspector_payload_of_a_rotated_element() {
        let body = r#"{"x":782.6109316,"y":135.0494769,"maxWidth":399.17451841,"maxHeight":828.5163351,"rotation":37.5,"text":"hi","maskPolygon":"[[1,2],[3,4],[5,6]]"}"#;
        let dto: LayerElementInput = serde_json::from_str(body).expect("must parse");
        assert_eq!(dto.maxWidth, Some(399));
        assert_eq!(dto.maxHeight, Some(829));
        assert_eq!(dto.x, Some(782.6109316));
        assert_eq!(dto.rotation, Some(37.5));
    }

    /// `as i32` discarded the high bits, so these all landed on plausible small numbers --
    /// `4294967296` became 0, i.e. "bottom of the stack" for a request asking for the top.
    /// Saturating keeps the property ordering depends on: bigger in, never smaller out.
    #[test]
    fn an_out_of_range_z_order_saturates_instead_of_wrapping() {
        for (raw, expected, why) in [
            (4294967296i64, i32::MAX, "2^32 wrapped to 0"),
            (4294967298, i32::MAX, "2^32+2 wrapped to 2"),
            (i64::from(i32::MAX) + 1, i32::MAX, "one past the top"),
            (i64::from(i32::MIN) - 1, i32::MIN, "one past the bottom"),
            (i64::MAX, i32::MAX, "the largest integer JSON can carry"),
            (i64::MIN, i32::MIN, "the smallest"),
        ] {
            let value = serde_json::json!(raw);
            assert_eq!(
                z_order_of(Some(&value)),
                Some(expected),
                "zOrder {raw}: {why}"
            );
        }
    }

    /// The clamp must not disturb the values that were always fine, including the Jackson
    /// fractional-coercion parity this helper exists for.
    #[test]
    fn in_range_z_orders_are_untouched() {
        for (body, expected) in [
            ("0", 0),
            ("2", 2),
            ("-7", -7),
            ("2.5", 2),
            ("2147483647", i32::MAX),
        ] {
            let value: serde_json::Value = serde_json::from_str(body).unwrap();
            assert_eq!(z_order_of(Some(&value)), Some(expected), "zOrder {body}");
        }
        assert_eq!(z_order_of(None), None, "absent stays absent");
        assert_eq!(
            z_order_of(Some(&serde_json::json!("nonsense"))),
            None,
            "a non-number is not a zOrder"
        );
    }

    #[test]
    fn still_takes_a_plain_integer_box() {
        let dto: LayerElementInput =
            serde_json::from_str(r#"{"maxWidth": 150, "maxHeight": 80}"#).expect("integers parse");
        assert_eq!(dto.maxWidth, Some(150));
        assert_eq!(dto.maxHeight, Some(80));
    }

    /// A partial update must stay partial: an absent field means "leave it alone" (the SQL is all
    /// `COALESCE`), and an explicit null must not become 0.
    #[test]
    fn absent_and_null_box_dimensions_both_stay_none() {
        let absent: LayerElementInput = serde_json::from_str(r#"{"text": "hi"}"#).expect("parses");
        assert_eq!(absent.maxWidth, None);
        assert_eq!(absent.maxHeight, None);

        let explicit_null: LayerElementInput =
            serde_json::from_str(r#"{"maxWidth": null}"#).expect("parses");
        assert_eq!(explicit_null.maxWidth, None);
    }
}
