//! The mask editor's repaint (2026-09-28).
//!
//! The user brushes over what a cleanup pass left behind; `POST /api/pages/{pageId}/manual-cleanup`
//! stores that mark and queues a `manual-cleanup` job. The worker repaints the marked area on the
//! page as the export draws it now (source plus visible patches), and its callback records the
//! result as one region-less patch on a new Inpainting layer above the page's others.
//!
//! The job's queue is first among the heavy queues, so a repaint does not wait behind a chapter's
//! pipeline. The patch element is marked manually edited, so the re-render it causes queues no
//! paid QA pass; the callback renders the page straight away (`render_now`), as an element save
//! does.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::inpainting::{CleanupRef, is_sha256};
use crate::jobs::coordinator;
use crate::models::Job;
use crate::page_scene_builder::scene_asset_path;
use crate::state::AppState;

pub const JOB_TYPE: &str = "manual-cleanup";
/// `restore` is the editor's eraser over an automatic patch: the worker copies the original page
/// back where marked, so it needs no underlay.
pub const METHODS: &[&str] = &["auto", "aot", "telea", "flat", "restore"];

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct MaskBounds {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCleanupRequest {
    /// Base64 PNG (a `data:image/png;base64,` prefix is accepted) whose alpha marks the area,
    /// sized exactly `bounds`.
    pub mask: String,
    pub bounds: MaskBounds,
    pub method: String,
    pub fill_color: Option<String>,
}

fn bad_request(message: impl Into<String>) -> Response {
    (StatusCode::BAD_REQUEST, message.into()).into_response()
}

fn is_hex_colour(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// The mark must be a PNG exactly the size of its bounds that marks at least one pixel.
pub fn validate_mask(png: &[u8], bounds: &MaskBounds) -> Result<(), String> {
    let image = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(|err| format!("the mask is not a PNG: {err}"))?;
    if i64::from(image.width()) != bounds.width || i64::from(image.height()) != bounds.height {
        return Err(format!(
            "the mask is {}x{}, but its bounds are {}x{}",
            image.width(),
            image.height(),
            bounds.width,
            bounds.height
        ));
    }
    if !image.to_rgba8().pixels().any(|pixel| pixel.0[3] > 0) {
        return Err("the mask marks nothing".into());
    }
    Ok(())
}

/// The visible patches the export draws, in its order, as the worker composites them. Taken from
/// the scene builder's own draw list (built in a rolled-back transaction) so the repaint starts
/// from exactly the page the export shows.
async fn underlay(state: &AppState, page_id: Uuid, revision: i32) -> Result<Vec<Value>, String> {
    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
    let artifacts = underlay_in(state, &mut tx, page_id, revision).await;
    tx.rollback().await.map_err(|e| e.to_string())?;
    artifacts
}

/// [`underlay`] read inside `tx`; the builder's writes are undone with a savepoint.
async fn underlay_in(
    state: &AppState,
    tx: &mut Transaction<'_, Postgres>,
    page_id: Uuid,
    revision: i32,
) -> Result<Vec<Value>, String> {
    let mut savepoint = sqlx::Connection::begin(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    let built =
        crate::page_scene_builder::build_pipeline_scene(state, &mut savepoint, page_id, revision)
            .await;
    savepoint.rollback().await.map_err(|e| e.to_string())?;
    let built = built?;
    let artifacts = built.validated.document["cleanup_artifacts"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    Ok(artifacts
        .iter()
        .filter_map(|artifact| {
            let path = built
                .asset_paths
                .get(artifact["patch_asset_id"].as_str()?)?;
            let bounds = &artifact["bounds"];
            Some(json!({
                "path": path,
                "x": bounds["x"],
                "y": bounds["y"],
                "width": bounds["width"],
                "height": bounds["height"],
                "opacity": artifact.get("opacity").cloned().unwrap_or(json!(1.0)),
            }))
        })
        .collect())
}

/// H2: a sha256 over the underlay entries whose bounds meet the mark -- the patches the worker
/// composites into the repaint. The queue stores it in the job; the callback compares it with the
/// page's underlay as it is then, so a patch hidden or changed under the mark while the repaint
/// ran is not brought back by landing it. Patches elsewhere on the page do not count, so two
/// repaints in different places do not refuse each other.
fn underlay_digest(underlay: &[Value], mark: &MaskBounds) -> String {
    let meets = |entry: &&Value| {
        let n = |key: &str| entry[key].as_f64().unwrap_or(0.0);
        let (x, y, w, h) = (n("x"), n("y"), n("width"), n("height"));
        let (mx, my) = (mark.x as f64, mark.y as f64);
        let (mw, mh) = (mark.width as f64, mark.height as f64);
        x < mx + mw && mx < x + w && y < my + mh && my < y + h
    };
    let under: Vec<&Value> = underlay.iter().filter(meets).collect();
    hex::encode(Sha256::digest(
        serde_json::to_vec(&under).expect("the underlay serializes"),
    ))
}

/// [`underlay_digest`] of the page's current underlay under `mark`.
pub async fn underlay_sha256(
    state: &AppState,
    page_id: Uuid,
    mark: &MaskBounds,
) -> Result<String, String> {
    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
    let digest = underlay_sha256_in(state, &mut tx, page_id, mark).await;
    tx.rollback().await.map_err(|e| e.to_string())?;
    digest
}

/// [`underlay_sha256`] inside `tx`, holding the page row's lock until `tx` ends. Every patch and
/// visibility edit advances the page's revision in its own transaction, so none can land between
/// this read and the commit of the patch it fences.
async fn underlay_sha256_in(
    state: &AppState,
    tx: &mut Transaction<'_, Postgres>,
    page_id: Uuid,
    mark: &MaskBounds,
) -> Result<String, String> {
    let revision: i32 =
        sqlx::query_scalar("SELECT scene_revision FROM pages WHERE id = $1 FOR UPDATE")
            .bind(page_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    Ok(underlay_digest(
        &underlay_in(state, tx, page_id, revision).await?,
        mark,
    ))
}

/// The digest and mark a job was queued with. `Ok(None)` for a `restore` (it has no underlay) and
/// for a job queued before the fence existed; those land unchecked, as before. A failed read is an
/// error, not a job without a digest.
async fn queued_underlay(
    tx: &mut Transaction<'_, Postgres>,
    job_id: &str,
) -> Result<Option<(String, MaskBounds)>, String> {
    let payload: Option<Option<String>> =
        sqlx::query_scalar("SELECT payload FROM jobs WHERE id = $1")
            .bind(job_id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    let Some(payload) = payload.flatten() else {
        return Ok(None);
    };
    let Ok(payload) = serde_json::from_str::<Value>(&payload) else {
        return Ok(None);
    };
    let digest = payload.get("underlaySha256").and_then(Value::as_str);
    let mark = payload
        .get("manualMask")
        .and_then(|mark| serde_json::from_value::<MaskBounds>(mark.clone()).ok());
    Ok(digest
        .zip(mark)
        .map(|(digest, mark)| (digest.to_owned(), mark)))
}

/// The page's source image: id, storage path, sha256, width, height, and the page's scene revision.
type PageSource = (Uuid, String, Option<String>, Option<i32>, Option<i32>, i32);

/// POST /api/pages/{pageId}/manual-cleanup — queue a repaint of one hand-marked area.
pub async fn queue_manual_cleanup(
    State(state): State<AppState>,
    user: AuthUser,
    Path(page_id): Path<Uuid>,
    body: Result<Json<ManualCleanupRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    // A repaint lands as a page patch and advances the scene revision: an edit, as region merge
    // and redo are, so the same roles.
    if !user.role.eq_ignore_ascii_case("admin") && !user.role.eq_ignore_ascii_case("translator") {
        return crate::error::access_denied("/api/pages/{pageId}/manual-cleanup");
    }
    let request = match body {
        Ok(Json(request)) => request,
        Err(rejection) => return bad_request(rejection.body_text()),
    };
    let method = request.method.trim().to_lowercase();
    if !METHODS.contains(&method.as_str()) {
        return bad_request(format!("method must be one of {}", METHODS.join(", ")));
    }
    let fill_color = request.fill_color.as_deref().map(str::trim);
    if method == "flat" && !fill_color.is_some_and(is_hex_colour) {
        return bad_request("a flat fill needs fillColor as #rrggbb");
    }

    let page: Option<PageSource> = match sqlx::query_as(
        "SELECT i.id, i.storage_path, i.hash, i.width, i.height, p.scene_revision \
             FROM pages p JOIN images i ON i.id = p.image_id WHERE p.id = $1",
    )
    .bind(page_id)
    .fetch_optional(&state.pool)
    .await
    {
        Ok(page) => page,
        Err(err) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response();
        }
    };
    let Some((image_id, storage_path, hash, page_w, page_h, revision)) = page else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (Some(page_w), Some(page_h)) = (page_w, page_h) else {
        return bad_request("the page's image has no recorded size");
    };
    let bounds = request.bounds;
    // Checked: the four numbers are the client's, and `x + width` can overflow i64 (a panic in a
    // debug build; in release a wrapped, negative sum that passes the page check).
    let fits = |start: i64, len: i64, limit: i32| {
        start >= 0
            && len > 0
            && start
                .checked_add(len)
                .is_some_and(|end| end <= i64::from(limit))
    };
    if !fits(bounds.x, bounds.width, page_w) || !fits(bounds.y, bounds.height, page_h) {
        return bad_request("the mask lies outside the page");
    }

    let encoded = request
        .mask
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(&request.mask);
    let Ok(png) = base64::engine::general_purpose::STANDARD.decode(encoded.trim()) else {
        return bad_request("mask is not base64");
    };
    if let Err(problem) = validate_mask(&png, &bounds) {
        return bad_request(problem);
    }
    let mask_sha = hex::encode(Sha256::digest(&png));
    let mask_path = scene_asset_path(page_id, &mask_sha);
    if !state.storage.exists(&mask_path).await
        && let Err(err) = state
            .storage
            .upload_bytes(&mask_path, png, "image/png")
            .await
    {
        tracing::error!("Could not store manual mask {mask_path}: {err}");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "could not store the mask",
        )
            .into_response();
    }

    let underlay = match if method == "restore" {
        Ok(Vec::new())
    } else {
        underlay(&state, page_id, revision).await
    } {
        Ok(underlay) => underlay,
        Err(err) => {
            tracing::error!(
                "Could not build the page {page_id} draw list for a manual repaint: {err}"
            );
            return (StatusCode::INTERNAL_SERVER_ERROR, err).into_response();
        }
    };
    let image_url = match state.storage.presigned_job_url(&storage_path).await {
        Ok(url) => url,
        Err(err) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("could not presign the source: {err}"),
            )
                .into_response();
        }
    };
    let underlay_sha = (method != "restore").then(|| underlay_digest(&underlay, &bounds));
    let fill_color = fill_color.map(str::to_owned);
    let queued_sha = mask_sha.clone();
    coordinator::enqueue_job_directly(
        &state,
        JOB_TYPE,
        image_id,
        Some(page_id),
        None,
        "high",
        move |job| {
            job.insert("imageUrl".into(), json!(image_url));
            job.insert("sourceSha256".into(), json!(hash.unwrap_or_default()));
            job.insert(
                "manualMask".into(),
                json!({
                    "sha256": queued_sha,
                    "x": bounds.x,
                    "y": bounds.y,
                    "width": bounds.width,
                    "height": bounds.height,
                }),
            );
            job.insert("method".into(), json!(method));
            job.insert("fillColor".into(), json!(fill_color));
            job.insert("underlay".into(), Value::Array(underlay));
            if let Some(digest) = underlay_sha {
                job.insert("underlaySha256".into(), json!(digest));
            }
        },
    )
    .await;
    state.sse.map_image_to_user(image_id, user.id).await;
    (
        StatusCode::ACCEPTED,
        Json(json!({ "queued": true, "pageId": page_id, "maskSha256": mask_sha })),
    )
        .into_response()
}

/// Why a manual-cleanup callback was not applied (same split as cleanup's).
pub enum CallbackError {
    Superseded,
    Failed(String),
}

impl From<String> for CallbackError {
    fn from(message: String) -> Self {
        CallbackError::Failed(message)
    }
}

impl From<&str> for CallbackError {
    fn from(message: &str) -> Self {
        CallbackError::Failed(message.to_string())
    }
}

/// The patch a `complete` callback reports, if every field is usable.
fn reported_patch(payload: &Value) -> Result<CleanupRef, String> {
    let text = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("{key} missing"))
    };
    let length = |key: &str| {
        payload
            .get(key)
            .and_then(Value::as_i64)
            .ok_or_else(|| format!("{key} missing"))
    };
    let reference = CleanupRef {
        patch_sha256: text("cleanupPatchSha256")?,
        patch_byte_length: length("cleanupPatchByteLength")?,
        mask_sha256: text("cleanupMaskSha256")?,
        mask_byte_length: length("cleanupMaskByteLength")?,
        generator_sha256: text("cleanupGeneratorSha256")?,
        bounds: payload
            .get("cleanupBounds")
            .cloned()
            .ok_or("cleanupBounds missing")?,
        order: 0,
    };
    if !is_sha256(&reference.patch_sha256) || !is_sha256(&reference.mask_sha256) {
        return Err("the reported patch or mask is not a sha256".into());
    }
    Ok(reference)
}

/// Applies the worker's outcome: a `complete` repaint becomes the page's newest Inpainting layer
/// and marks the page for a (QA-free) re-render; anything else fails the job visibly.
pub async fn apply_callback(
    state: &AppState,
    image_id: Uuid,
    page_id: Option<Uuid>,
    payload: &Value,
) -> Result<(), CallbackError> {
    let job_id = payload
        .get("jobId")
        .and_then(Value::as_str)
        .ok_or("manual-cleanup callback missing jobId")?;
    let page = coordinator::resolve_page_for_callback(&state.pool, image_id, page_id)
        .await
        .ok_or("manual-cleanup callback page no longer exists")?;

    // Checked before the claim: a missing object is a failed repaint, not a patch that draws nothing.
    let outcome: Result<CleanupRef, String> = match payload.get("status").and_then(Value::as_str) {
        Some("complete") => match reported_patch(payload) {
            Ok(reference) => {
                let mut missing = Vec::new();
                for sha in [&reference.patch_sha256, &reference.mask_sha256] {
                    let path = scene_asset_path(page.id, sha);
                    if !state.storage.exists(&path).await {
                        missing.push(path);
                    }
                }
                if missing.is_empty() {
                    Ok(reference)
                } else {
                    Err(format!(
                        "assets missing from storage: {}",
                        missing.join(", ")
                    ))
                }
            }
            Err(problem) => Err(problem),
        },
        _ => Err(payload
            .get("diagnostics")
            .and_then(Value::as_array)
            .and_then(|d| d.first())
            .and_then(Value::as_str)
            .unwrap_or("the worker reported the repaint failed")
            .to_owned()),
    };
    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
    match coordinator::claim_callback_tx(&mut tx, Some(job_id), image_id, JOB_TYPE)
        .await
        .map_err(|e| e.to_string())?
    {
        coordinator::ClaimOutcome::Claimed => {}
        coordinator::ClaimOutcome::AlreadyApplied => {
            tx.rollback().await.map_err(|e| e.to_string())?;
            return Ok(());
        }
        coordinator::ClaimOutcome::NotCurrent => {
            tx.rollback().await.map_err(|e| e.to_string())?;
            return Err(CallbackError::Superseded);
        }
    }
    // H2, in the transaction that records the patch: the page row stays locked from the check to
    // the commit, so a patch or visibility edit cannot slip in between.
    let outcome = match outcome {
        Ok(reference) => match queued_underlay(&mut tx, job_id).await {
            Ok(None) => Ok(reference),
            Ok(Some((queued, mark))) => {
                match underlay_sha256_in(state, &mut tx, page.id, &mark).await {
                    Ok(now) if now == queued => Ok(reference),
                    Ok(_) => Err(
                        "a cleanup patch under the marked area was hidden or changed \
                                  while it was repainted; mark it again"
                            .to_owned(),
                    ),
                    Err(err) => Err(format!(
                        "could not check the patches under the repaint: {err}"
                    )),
                }
            }
            Err(err) => Err(format!(
                "could not read the repaint's queued underlay: {err}"
            )),
        },
        Err(problem) => Err(problem),
    };
    let applied = match outcome {
        Ok(reference) => {
            match crate::inpainting::record_manual_patch(&mut tx, page.id, &reference)
                .await
                .map_err(|e| e.to_string())?
            {
                Some(_) => {
                    crate::page_freshness::advance_page_revision_by_hand(&mut tx, page.id)
                        .await
                        .map_err(|e| e.to_string())?;
                    Ok(())
                }
                None => Err("the reported bounds are empty".to_owned()),
            }
        }
        Err(problem) => Err(problem),
    };
    if let Err(problem) = &applied {
        sqlx::query(
            "UPDATE jobs SET status = 'FAILED', error = $2, updated_at = now() WHERE id = $1",
        )
        .bind(job_id)
        .bind(format!("Manual repaint failed: {problem}"))
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;

    // The editor reloads the page on this event and shows the new patch (or the failure).
    if let Ok(Some(job)) = sqlx::query_as::<_, Job>("SELECT * FROM jobs WHERE id = $1")
        .bind(job_id)
        .fetch_optional(&state.pool)
        .await
    {
        state
            .sse
            .emit_event_for_image(
                image_id,
                "job_update",
                &serde_json::to_string(&job).unwrap_or_default(),
            )
            .await;
    }
    match applied {
        Err(problem) => {
            tracing::warn!("Manual repaint for page {} failed: {problem}", page.id);
        }
        // The repaint lands long after the editor's request returned, so the editor cannot ask for
        // the render the way an element save does; until now it waited for Export (user review,
        // 2026-10-02). Spawned, so the worker's callback is answered without waiting on Chromium.
        Ok(()) => {
            let state = state.clone();
            let page_id = page.id;
            tokio::spawn(async move {
                match crate::render_now::render_page_now(&state, page_id).await {
                    crate::render_now::RenderNow::Current { .. } => {}
                    crate::render_now::RenderNow::Failed(error)
                    | crate::render_now::RenderNow::Unavailable(error) => {
                        tracing::warn!("Render after the repaint of page {page_id}: {error}");
                    }
                }
            });
        }
    }
    Ok(())
}
