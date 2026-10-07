//! Layer delete/update-element-create handlers (split file to keep sizes manageable).

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error;
use crate::models::LayerElement;
use crate::page_freshness::advance_page_revision_by_hand;
use crate::routes::layers::{LayerElementInput, deny_viewer};
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
    // Deleting a redo overlay has to give back what it hid, or the bubble it patched vanishes: the
    // overlay held the new text and the element underneath is still flagged invisible. The two go
    // in one transaction — a restore that failed quietly while the delete succeeded would cascade
    // the overlay's element away and leave the region permanently blank, with no overlay left to
    // toggle back.
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(err) => {
            tracing::error!("Could not open a transaction to delete layer {id}: {err}");
            return error::internal_error("/api/layers/{id}");
        }
    };
    let row: Option<(Uuid, String)> =
        sqlx::query_as("SELECT page_id, type FROM layers WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .unwrap_or(None);
    let page_id = row.as_ref().map(|(page_id, _)| *page_id);
    // F4: the delete (an ungroup, for a group) is one undoable step with what it gives back.
    let recorder = match page_id {
        None => None,
        Some(page_id) => match crate::layer_ops::Recorder::start(&mut tx, page_id).await {
            Ok(recorder) => Some(recorder),
            Err(err) => {
                tracing::error!("Could not start recording on {page_id}: {err}");
                let _ = tx.rollback().await;
                return error::internal_error("/api/layers/{id}");
            }
        },
    };
    let is_group = row
        .as_ref()
        .is_some_and(|(_, kind)| kind.eq_ignore_ascii_case(crate::layer_tree::GROUP_TYPE));
    if let Err(err) = crate::jobs::coordinator::sync_superseded_elements(&mut tx, id, false).await {
        tracing::error!(
            "Could not restore what overlay {id} superseded, refusing to delete: {err}"
        );
        let _ = tx.rollback().await;
        return error::internal_error("/api/layers/{id}");
    }
    if let Err(err) = crate::jobs::coordinator::relink_overlay_successors(&mut tx, id).await {
        tracing::error!("Could not relink successors of overlay {id}, refusing to delete: {err}");
        let _ = tx.rollback().await;
        return error::internal_error("/api/layers/{id}");
    }
    // F3: deleting a group keeps its layers; the foreign key takes them out of it.
    let members: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM layers WHERE parent_id = $1")
        .bind(id)
        .fetch_all(&mut *tx)
        .await
        .unwrap_or_default();
    let result = sqlx::query("DELETE FROM layers WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await;
    match result {
        Ok(res) if res.rows_affected() > 0 => {
            let page_id = page_id.expect("deleted layer must have an owning page");
            for member in members {
                if let Err(err) = crate::layer_tree::sync_overlays(&mut tx, member).await {
                    tracing::error!("Could not sync overlay {member} out of group {id}: {err}");
                    let _ = tx.rollback().await;
                    return error::internal_error("/api/layers/{id}");
                }
            }
            if let Some(recorder) = recorder {
                let (kind, label) = if is_group {
                    ("ungroup", "ungroup")
                } else {
                    ("delete", "delete a layer")
                };
                if let Err(err) = recorder
                    .finish(&mut tx, kind, label, &user.email, None)
                    .await
                {
                    tracing::error!("Could not record deleting layer {id}: {err}");
                    let _ = tx.rollback().await;
                    return error::internal_error("/api/layers/{id}");
                }
            }
            if let Err(err) = advance_page_revision_by_hand(&mut tx, page_id).await {
                tracing::error!("Could not advance page revision for deleted layer {id}: {err}");
                let _ = tx.rollback().await;
                return error::internal_error("/api/layers/{id}");
            }
            if let Err(err) = tx.commit().await {
                tracing::error!("Could not commit deletion of layer {id}: {err}");
                return error::internal_error("/api/layers/{id}");
            }
            StatusCode::OK.into_response()
        }
        _ => {
            let _ = tx.rollback().await;
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

/// PUT /api/layers/{id} — partial {zOrder?, visible?, name?, parentId?}.
///
/// F3 (#178): `name` sets `metadata_json.layer_name`, which the panel shows and the project ZIP
/// carries. `parentId` puts the layer in a group (a layer of type `group` on the same page), or
/// takes it out with `null`. Groups do not nest, so a group never gets a parent.
pub async fn update_layer(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    headers: axum::http::HeaderMap,
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
    let name = match payload.get("name") {
        None => None,
        Some(serde_json::Value::String(name)) if !name.trim().is_empty() => {
            Some(name.trim().chars().take(120).collect::<String>())
        }
        Some(_) => {
            return error::bad_request("name must be a non-empty string", "/api/layers/{id}");
        }
    };
    // Some(None) takes the layer out of its group.
    let parent = match payload.get("parentId") {
        None => None,
        Some(serde_json::Value::Null) => Some(None),
        Some(serde_json::Value::String(raw)) => match Uuid::parse_str(raw) {
            Ok(parent) => Some(Some(parent)),
            Err(_) => {
                return error::bad_request("parentId must be a uuid or null", "/api/layers/{id}");
            }
        },
        Some(_) => {
            return error::bad_request("parentId must be a uuid or null", "/api/layers/{id}");
        }
    };

    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(err) => {
            tracing::error!("Could not open a transaction for layer {id}: {err}");
            return error::internal_error("/api/layers/{id}");
        }
    };

    // F4: renaming, moving in or out of a group and reordering are undoable. Showing or hiding a
    // layer is not recorded (it is a view switch), though it still counts as a later change.
    let recorded = if name.is_some() {
        Some(("rename", "rename a layer"))
    } else if let Some(group) = parent {
        Some(if group.is_some() {
            ("group-move", "move a layer into a group")
        } else {
            ("group-move", "take a layer out of its group")
        })
    } else if z_order.is_some() {
        Some(("reorder", "reorder layers"))
    } else {
        None
    };
    let recorder = match recorded {
        None => None,
        Some(_) => {
            let page_id: Option<Uuid> =
                match sqlx::query_scalar("SELECT page_id FROM layers WHERE id = $1")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await
                {
                    Ok(page_id) => page_id,
                    Err(err) => {
                        tracing::error!("Could not read layer {id}: {err}");
                        let _ = tx.rollback().await;
                        return error::internal_error("/api/layers/{id}");
                    }
                };
            let Some(page_id) = page_id else {
                let _ = tx.rollback().await;
                return StatusCode::NOT_FOUND.into_response();
            };
            match crate::layer_ops::Recorder::start(&mut tx, page_id).await {
                Ok(recorder) => Some(recorder),
                Err(err) => {
                    tracing::error!("Could not start recording on {page_id}: {err}");
                    let _ = tx.rollback().await;
                    return error::internal_error("/api/layers/{id}");
                }
            }
        }
    };
    // The requests of one reorder carry one batch id and make one undo step.
    let batch = headers
        .get("x-layer-op-batch")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.chars().take(64).collect::<String>());

    if let Some(Some(parent_id)) = parent {
        match check_parent(&mut tx, id, parent_id).await {
            Ok(None) => {}
            Ok(Some(problem)) => {
                let _ = tx.rollback().await;
                return error::bad_request(problem, "/api/layers/{id}");
            }
            Err(err) => {
                tracing::error!("Could not check group {parent_id} for layer {id}: {err}");
                let _ = tx.rollback().await;
                return error::internal_error("/api/layers/{id}");
            }
        }
    }

    let page_id = sqlx::query_scalar(
        "UPDATE layers SET \
           z_order = COALESCE($2, z_order), visible = COALESCE($3, visible), \
           metadata_json = CASE WHEN $4::text IS NULL THEN metadata_json \
             ELSE jsonb_set(CASE WHEN jsonb_typeof(metadata_json) = 'object' THEN metadata_json \
               ELSE '{}'::jsonb END, '{layer_name}', to_jsonb($4::text)) END, \
           parent_id = CASE WHEN $5 THEN $6 ELSE parent_id END \
         WHERE id = $1 RETURNING page_id",
    )
    .bind(id)
    .bind(z_order)
    .bind(visible)
    .bind(name)
    .bind(parent.is_some())
    .bind(parent.flatten())
    .fetch_optional(&mut *tx)
    .await;

    let page_id = match page_id {
        Ok(Some(page_id)) => page_id,
        Ok(None) => {
            let _ = tx.rollback().await;
            return StatusCode::NOT_FOUND.into_response();
        }
        Err(err) => {
            tracing::error!("Could not update layer {id}: {err}");
            let _ = tx.rollback().await;
            return error::internal_error("/api/layers/{id}");
        }
    };
    // Toggling a redo overlay off restores the reading it replaced, and toggling it back on hides
    // that reading again — so the layer switch actually compares the two, which is what it looks
    // like it should do. The flag and the restore share the transaction: flipping `visible` while
    // the restore failed would leave the bubble blank with the overlay already switched off, and
    // nothing left to toggle to bring it back. F3: a group's switch, and moving a layer in or out
    // of a hidden group, change what is shown the same way.
    if (visible.is_some() || parent.is_some())
        && let Err(err) = crate::layer_tree::sync_overlays(&mut tx, id).await
    {
        tracing::error!("Could not sync what overlay {id} superseded: {err}");
        let _ = tx.rollback().await;
        return error::internal_error("/api/layers/{id}");
    }

    if let (Some(recorder), Some((kind, label))) = (recorder, recorded)
        && let Err(err) = recorder
            .finish(&mut tx, kind, label, &user.email, batch.as_deref())
            .await
    {
        tracing::error!("Could not record the update to layer {id}: {err}");
        let _ = tx.rollback().await;
        return error::internal_error("/api/layers/{id}");
    }
    if let Err(err) = advance_page_revision_by_hand(&mut tx, page_id).await {
        tracing::error!("Could not advance page revision for layer {id}: {err}");
        let _ = tx.rollback().await;
        return error::internal_error("/api/layers/{id}");
    }
    if let Err(err) = tx.commit().await {
        tracing::error!("Could not commit the update to layer {id}: {err}");
        return error::internal_error("/api/layers/{id}");
    }
    StatusCode::OK.into_response()
}

/// Why `layer_id` may not go into `parent_id`, or None when it may.
async fn check_parent(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    layer_id: Uuid,
    parent_id: Uuid,
) -> Result<Option<&'static str>, sqlx::Error> {
    let rows: Vec<(Uuid, String, Uuid)> =
        sqlx::query_as("SELECT id, type, page_id FROM layers WHERE id = ANY($1)")
            .bind(vec![layer_id, parent_id])
            .fetch_all(&mut **tx)
            .await?;
    let find = |id: Uuid| rows.iter().find(|row| row.0 == id);
    let (Some(layer), Some(group)) = (find(layer_id), find(parent_id)) else {
        return Ok(Some("the layer or the group does not exist"));
    };
    let is_group =
        |layer_type: &str| layer_type.eq_ignore_ascii_case(crate::layer_tree::GROUP_TYPE);
    Ok(if layer_id == parent_id {
        Some("a layer cannot be its own group")
    } else if !is_group(&group.1) {
        Some("parentId must name a group")
    } else if is_group(&layer.1) {
        Some("groups do not nest")
    } else if layer.2 != group.2 {
        Some("the group is on another page")
    } else {
        None
    })
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
    let opacity = match dto.checked_opacity() {
        Ok(opacity) => opacity,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    let layer: Option<(Uuid, String)> =
        sqlx::query_as("SELECT page_id, type FROM layers WHERE id = $1")
            .bind(layer_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
    let Some((layer_page_id, layer_type)) = layer else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Tracker R7: a patch may only name assets this page already holds, so an element can never
    // make the renderer (or the asset route) reach into another page's storage.
    let cleanup_ref = match dto.cleanupRef.as_ref() {
        None => None,
        Some(value) => {
            if !layer_type.eq_ignore_ascii_case(crate::inpainting::LAYER_TYPE) {
                return (
                    StatusCode::BAD_REQUEST,
                    "cleanupRef is only allowed on an inpainting layer",
                )
                    .into_response();
            }
            let Some(reference) = crate::inpainting::CleanupRef::parse(Some(value)) else {
                return (StatusCode::BAD_REQUEST, "cleanupRef is malformed").into_response();
            };
            for sha in [&reference.patch_sha256, &reference.mask_sha256] {
                let path = crate::page_scene_builder::scene_asset_path(layer_page_id, sha);
                if !state.storage.exists(&path).await {
                    return (
                        StatusCode::BAD_REQUEST,
                        "cleanupRef names an asset this page does not have",
                    )
                        .into_response();
                }
            }
            Some(serde_json::to_value(reference).expect("CleanupRef serializes"))
        }
    };

    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(err) => {
            tracing::error!(
                "Could not open a transaction for layer element create {layer_id}: {err}"
            );
            return error::internal_error(instance);
        }
    };
    let page_id: Option<Uuid> = sqlx::query_scalar("SELECT page_id FROM layers WHERE id = $1")
        .bind(layer_id)
        .fetch_optional(&mut *tx)
        .await
        .unwrap_or(None);
    let Some(page_id) = page_id else {
        let _ = tx.rollback().await;
        return StatusCode::NOT_FOUND.into_response();
    };
    // #237: Undo of a deleted patch re-creates it with the mark it had. Only a patch carries one.
    let hidden_with_text = cleanup_ref.as_ref().and(dto.hiddenWithText);
    let element: LayerElement = sqlx::query_as(
        "INSERT INTO layer_elements (id, auto_size, background_color, box_shape, font, font_style, \
           font_weight, is_manually_edited, mask_polygon, max_height, max_width, overflow, rotation, \
           size, text, text_color, visible, word_wrap, x, y, layer_id, region_id, cleanup_ref, opacity, \
           hidden_with_text) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, false, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) \
         RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(dto.autoSize.unwrap_or(false))
    .bind(dto.backgroundColor.clone())
    .bind(dto.boxShape.clone().unwrap_or_else(|| "rectangular".into()))
    .bind(dto.font.clone().unwrap_or_else(|| "Comic Neue".into()))
    .bind(dto.fontStyle.clone().unwrap_or_else(|| "normal".into()))
    .bind(dto.fontWeight.clone().unwrap_or_else(|| "normal".into()))
    .bind(dto.maskPolygon.clone().and_then(crate::models::normalize_mask_polygon))
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
    .bind(cleanup_ref)
    .bind(opacity)
    .bind(hidden_with_text)
    .fetch_one(&mut *tx)
    .await
    .expect("element insert");

    if let Err(err) = advance_page_revision_by_hand(&mut tx, page_id).await {
        tracing::error!("Could not advance page revision for layer {layer_id}: {err}");
        let _ = tx.rollback().await;
        return error::internal_error(instance);
    }
    if let Err(err) = tx.commit().await {
        tracing::error!("Could not commit layer element create {layer_id}: {err}");
        return error::internal_error(instance);
    }
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
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(err) => {
            tracing::error!("Could not open a transaction to delete layer element {id}: {err}");
            return error::internal_error("/api/layer-elements/{id}");
        }
    };
    let page_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT l.page_id FROM layers l JOIN layer_elements e ON e.layer_id = l.id WHERE e.id = $1",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await
    .unwrap_or(None);
    let Some(page_id) = page_id else {
        let _ = tx.rollback().await;
        return StatusCode::NOT_FOUND.into_response();
    };
    let result = sqlx::query("DELETE FROM layer_elements WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await;
    match result {
        Ok(res) if res.rows_affected() > 0 => {
            if let Err(err) = advance_page_revision_by_hand(&mut tx, page_id).await {
                tracing::error!("Could not advance page revision for layer element {id}: {err}");
                let _ = tx.rollback().await;
                return error::internal_error("/api/layer-elements/{id}");
            }
            if let Err(err) = tx.commit().await {
                tracing::error!("Could not commit deletion of layer element {id}: {err}");
                return error::internal_error("/api/layer-elements/{id}");
            }
            StatusCode::OK.into_response()
        }
        _ => {
            let _ = tx.rollback().await;
            StatusCode::NOT_FOUND.into_response()
        }
    }
}
