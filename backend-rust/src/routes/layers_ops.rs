//! Layer delete/update-element-create handlers (split file to keep sizes manageable).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error;
use crate::models::LayerElement;
use crate::routes::layers::{LayerElementInput, deny_viewer, touch_page};
use crate::state::AppState;

/// DELETE /api/layers/{id}
pub async fn delete_layer(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Response {
    if let Some(denied) = deny_viewer(&user, "/api/layers/{id}") {
        return denied;
    }
    let result = sqlx::query("DELETE FROM layers WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await;
    match result {
        Ok(res) if res.rows_affected() > 0 => {
            touch_page(&state.pool, id).await;
            StatusCode::OK.into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// PUT /api/layers/{id} — partial {zOrder?, visible?}.
pub async fn update_layer(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    body: Result<Json<serde_json::Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if let Some(denied) = deny_viewer(&user, "/api/layers/{id}") {
        return denied;
    }
    let Json(payload) = match body {
        Ok(json) => json,
        Err(_) => return error::unreadable_body("/api/layers/{id}"),
    };
    let z_order = crate::routes::layers::z_order_of(payload.get("zOrder"));
    // Java: Boolean.TRUE.equals(value) — non-true values become false.
    let visible = payload.get("visible").map(|v| v.as_bool().unwrap_or(false));

    let updated = sqlx::query(
        "UPDATE layers SET \
           z_order = COALESCE($2, z_order), visible = COALESCE($3, visible) \
         WHERE id = $1 RETURNING id, z_order, visible",
    )
    .bind(id)
    .bind(z_order)
    .bind(visible)
    .execute(&state.pool)
    .await
    .expect("layer update");

    if updated.rows_affected() == 0 {
        return StatusCode::NOT_FOUND.into_response();
    }
    touch_page(&state.pool, id).await;
    StatusCode::OK.into_response()
}

/// POST /api/layers/{layerId}/elements — Java defaults applied for absent fields.
pub async fn create_layer_element(
    State(state): State<AppState>,
    user: AuthUser,
    Path(layer_id): Path<Uuid>,
    body: Result<Json<LayerElementInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let instance = "/api/layers/{layerId}/elements";
    if let Some(denied) = deny_viewer(&user, instance) {
        return denied;
    }
    let Json(dto) = match body {
        Ok(json) => json,
        Err(_) => return error::unreadable_body(instance),
    };
    let layer_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM layers WHERE id = $1)")
            .bind(layer_id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or(false);
    if !layer_exists {
        return StatusCode::NOT_FOUND.into_response();
    }

    let element: LayerElement = sqlx::query_as(
        "INSERT INTO layer_elements (id, auto_size, background_color, box_shape, font, font_style, \
           font_weight, is_manually_edited, mask_polygon, max_height, max_width, overflow, rotation, \
           size, text, text_color, visible, word_wrap, x, y, layer_id, region_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, false, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) \
         RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(dto.autoSize.unwrap_or(false))
    .bind(dto.backgroundColor.clone())
    .bind(dto.boxShape.clone().unwrap_or_else(|| "rectangular".into()))
    .bind(dto.font.clone().unwrap_or_else(|| "Comic Neue".into()))
    .bind(dto.fontStyle.clone().unwrap_or_else(|| "normal".into()))
    .bind(dto.fontWeight.clone().unwrap_or_else(|| "normal".into()))
    .bind(dto.maskPolygon.clone())
    .bind(dto.maxHeight.unwrap_or(80))
    .bind(dto.maxWidth.unwrap_or(150))
    .bind(dto.rotation.unwrap_or(0.0))
    .bind(dto.size.unwrap_or(16.0))
    .bind(dto.text.clone().unwrap_or_default())
    .bind(dto.textColor.clone())
    .bind(dto.visible.unwrap_or(true))
    .bind(dto.wordWrap.unwrap_or(false))
    .bind(dto.x.unwrap_or(100.0))
    .bind(dto.y.unwrap_or(100.0))
    .bind(layer_id)
    .bind(dto.regionId)
    .fetch_one(&state.pool)
    .await
    .expect("element insert");

    touch_page(&state.pool, layer_id).await;
    Json(element).into_response()
}

/// DELETE /api/layer-elements/{id}
pub async fn delete_layer_element(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Response {
    if let Some(denied) = deny_viewer(&user, "/api/layer-elements/{id}") {
        return denied;
    }
    let result = sqlx::query("DELETE FROM layer_elements WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await;
    match result {
        Ok(res) if res.rows_affected() > 0 => {
            sqlx::query(
                "UPDATE pages SET last_edited_at = now() WHERE id IN \
                   (SELECT page_id FROM layers l JOIN layer_elements e ON e.layer_id = l.id WHERE e.id = $1)",
            )
            .bind(id)
            .execute(&state.pool)
            .await
            .ok();
            StatusCode::OK.into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}
