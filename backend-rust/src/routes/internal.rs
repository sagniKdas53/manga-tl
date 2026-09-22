//! `/api/internal/**` — port of InternalJobController: the worker-facing surface.
//!
//! Security (SecurityConfig + InternalAuthFilter): these paths are EXEMPT from JWT
//! authentication but MUST carry `X-Internal-Token` — a wrong or missing header is
//! 401 with the exact body `{"error": "Unauthorized: Invalid internal token"}`.
//!
//! Error shape on handler failure: Spring returned
//! `ResponseEntity.internalServerError().body(e.getMessage())`, i.e. 500 text/plain
//! carrying the exception message.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

use crate::auth::{InternalAuth, check_internal_token, unauthorized_internal_token};
use crate::jobs::coordinator;
use crate::models::{Chapter, Image, Job, Layer, OcrRegion, Page, Panel, Series};
use crate::state::AppState;

const JOB_STATUSES: [&str; 5] = ["PENDING", "PROCESSING", "COMPLETED", "FAILED", "PAUSED"];

/// Every handler starts with this guard.
fn guard(state: &AppState, headers: &HeaderMap) -> Option<Response> {
    let header = headers
        .get("X-Internal-Token")
        .and_then(|v| v.to_str().ok());
    match check_internal_token(state.config.internal_api_token.as_deref(), header) {
        InternalAuth::Ok => None,
        InternalAuth::Invalid => Some(unauthorized_internal_token()),
    }
}

fn internal_error_text(message: impl std::fmt::Display) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        [(
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static("text/plain;charset=UTF-8"),
        )],
        message.to_string(),
    )
        .into_response()
}

/// The four headers that identify which job attempt is speaking.
///
/// The authority is deliberately header-bound rather than read out of the callback JSON. Each
/// stage's body has its own shape and its own history; a body field would also be the thing a
/// superseded attempt happily re-sends verbatim. Headers are set once, by `process_job_rq`, from
/// the payload the backend dispatched, and `backend_headers()` attaches them to every request the
/// attempt makes — so an attempt cannot lend its authority to a newer one, or keep it after the
/// backend has moved on.
///
/// A missing or mismatched header is 409, not 400: to the worker it means "you are not the
/// current attempt", which is terminal for its retry wrapper.
fn callback_identity(
    headers: &HeaderMap,
    expected_job_id: Option<&str>,
) -> Result<coordinator::CallbackIdentity, (StatusCode, String)> {
    let read = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let conflict = |message: String| (StatusCode::CONFLICT, message);
    let job_id = read("X-Job-Id").ok_or_else(|| conflict("Missing X-Job-Id".into()))?;
    if expected_job_id.is_some_and(|expected| expected != job_id) {
        return Err(conflict(
            "X-Job-Id does not match the jobId in the callback body".into(),
        ));
    }
    let parse = |name: &str| {
        read(name)
            .and_then(|v| v.parse::<i32>().ok())
            .ok_or_else(|| conflict(format!("Missing or invalid {name}")))
    };
    Ok(coordinator::CallbackIdentity {
        job_id: job_id.to_owned(),
        attempt: parse("X-Job-Attempt")?,
        input_generation: parse("X-Input-Generation")?,
        lease_token: read("X-Lease-Token")
            .ok_or_else(|| conflict("Missing X-Lease-Token".into()))?
            .to_owned(),
    })
}

// ---------------------------------------------------------------------------
// Job status + fetch
// ---------------------------------------------------------------------------

/// PATCH /api/internal/jobs/{jobId}/status
pub async fn update_job_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
    body: Result<Json<HashMap<String, String>>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if let Some(denied) = guard(&state, &headers) {
        return denied;
    }
    let identity = match callback_identity(&headers, Some(&job_id)) {
        Ok(identity) => identity,
        Err(rejection) => return rejection.into_response(),
    };
    let Ok(Json(payload)) = body else {
        return crate::error::unreadable_body("/api/internal/jobs/{jobId}/status");
    };

    if let Some(status) = payload.get("status") {
        // AUDIT-B8: reject unknown status words rather than persisting them. A non-408/429
        // 4xx is terminal for the worker's retry wrapper — which is what a typo deserves.
        if !JOB_STATUSES.contains(&status.as_str()) {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": format!("Unknown job status: {status}"),
                    "allowed": format!("[{}]", JOB_STATUSES.join(", ")),
                })),
            )
                .into_response();
        }
    }

    let Some(job): Option<Job> = sqlx::query_as(
        "SELECT * FROM jobs WHERE id = $1 AND attempt = $2 AND input_generation = $3 AND lease_token = $4 FOR UPDATE",
    )
        .bind(&job_id)
        .bind(identity.attempt)
        .bind(identity.input_generation)
        .bind(&identity.lease_token)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten()
    else {
        return (StatusCode::CONFLICT, "Stale or unknown job attempt").into_response();
    };

    // R3 transition contract. The row the identity headers matched is the *current* attempt; this
    // table is what that attempt is still allowed to do to it. Anything else is 409 — the worker
    // treats a non-408/429 4xx as terminal, so a superseded attempt stops instead of writing.
    //
    //   PENDING    -> PROCESSING   the start compare-and-swap. Redis may redeliver the same
    //                              payload; only the first delivery wins this transition.
    //   PROCESSING -> PROCESSING   heartbeat only, and only inside JOB_MAX_RUNTIME_SECS of the
    //                              stamped start. A heartbeat thread must not be able to keep a
    //                              hung inference alive forever (handoff, "Liveness bounds").
    //   PROCESSING -> PENDING      the worker's own bounded retry; `attempt` must advance by one
    //                              and the row is re-armed with a fresh lease below.
    //   PROCESSING -> FAILED       attempts exhausted, or a callback the backend rejected.
    //   PROCESSING -> COMPLETED    the ordinary end of a stage.
    //   COMPLETED  -> COMPLETED    idempotent: `claim_callback*` already completed the row inside
    //                              the result transaction, and the worker's own COMPLETED PATCH
    //                              arrives afterwards. Accepting it keeps that PATCH from looking
    //                              like a rejection to the worker.
    //   FAILED     -> PENDING      re-arm after a rejected/failed delivery, same attempt rule.
    //
    // COMPLETED -> PENDING is deliberately absent: a finished stage is not re-armable by a worker.
    let heartbeat = payload
        .get("heartbeat")
        .is_some_and(|value| value == "true");
    let requested_status = payload.get("status").map(String::as_str);
    let allowed = match (requested_status, heartbeat, job.status.as_str()) {
        (Some("PROCESSING"), false, "PENDING") => true,
        (Some("PROCESSING"), true, "PROCESSING") => job.started_at.is_some_and(|started| {
            started
                > chrono::Utc::now() - chrono::Duration::seconds(coordinator::JOB_MAX_RUNTIME_SECS)
        }),
        (Some("PENDING"), false, "PROCESSING" | "FAILED") => true,
        (Some("FAILED"), false, "PROCESSING") => true,
        (Some("COMPLETED"), false, "PROCESSING" | "COMPLETED") => true,
        _ => false,
    };
    if !allowed {
        return (
            StatusCode::CONFLICT,
            format!(
                "Illegal or expired transition {} -> {} for job {job_id}",
                job.status,
                requested_status.unwrap_or("(none)")
            ),
        )
            .into_response();
    }

    let mut new_status = job.status.clone();
    // A retry re-arms the row for a NEW attempt, so everything the abandoned attempt left behind
    // goes with it: its start timestamp (which must not charge the retry), its lease, and its
    // callback claim. Leaving `callback_applied_at` stamped would make the retry's own result
    // look like a duplicate delivery and drop it silently — which is how a cleanup that failed
    // once could never succeed on its second attempt.
    let re_arming = payload
        .get("status")
        .map(|s| s == "PENDING")
        .unwrap_or(false);
    if let Some(status) = payload.get("status") {
        new_status = status.clone();
    }

    // Attempt updates also rewrite the stored payload so retries carry the right number.
    let requested_attempt = payload.get("attempt").and_then(|a| a.parse::<i32>().ok());
    if new_status == "PENDING" && requested_attempt != Some(identity.attempt + 1) {
        return (StatusCode::CONFLICT, "Retry must advance attempt by one").into_response();
    }
    let new_lease = if new_status == "PENDING" {
        Some(Uuid::new_v4().to_string())
    } else {
        None
    };
    let attempt_update =
        requested_attempt
            .zip(job.payload.clone())
            .map(|(attempt, old_payload)| {
                (
                    attempt,
                    new_lease
                        .as_deref()
                        .map(|token| {
                            coordinator::update_payload_attempt_and_lease(
                                &old_payload,
                                attempt,
                                token,
                            )
                        })
                        .unwrap_or_else(|| {
                            coordinator::update_payload_attempt(&old_payload, attempt)
                        }),
                )
            });

    // Liveness and progress are read separately. `heartbeat_at` only says the worker answered;
    // `progress_count`/`progress_at` move when the job reports a unit of work done — one cleanup
    // region, one OCR stage. An inference that hangs keeps heartbeating and stops progressing,
    // and only the second of those can tell them apart. Nothing acts on it automatically yet;
    // it is the operator-visible reading behind the runtime cap.
    let reported_progress = payload
        .get("progress")
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(0);

    let result = sqlx::query(
        "UPDATE jobs SET \
           status = COALESCE($2, status), \
           error = COALESCE($3, error), \
           attempt = COALESCE($4, attempt), \
           payload = COALESCE($5, payload), \
           started_at = CASE WHEN $6 THEN NULL WHEN $7 = 'PROCESSING' AND started_at IS NULL THEN now() ELSE started_at END, \
           lease_token = COALESCE($8, lease_token), \
           callback_applied_at = CASE WHEN $6 THEN NULL ELSE callback_applied_at END, \
           heartbeat_at = CASE WHEN $9 THEN now() ELSE heartbeat_at END, \
           progress_count = CASE WHEN $14 > progress_count THEN $14 ELSE progress_count END, \
           progress_at = CASE WHEN $14 > progress_count THEN now() ELSE progress_at END, \
           lease_expires_at = CASE WHEN $9 OR $7 = 'PROCESSING' \
                                    THEN now() + make_interval(secs => $13) \
                                    ELSE lease_expires_at END, \
           updated_at = now() \
         WHERE id = $1 AND attempt = $10 AND input_generation = $11 AND lease_token = $12",
    )
    .bind(&job_id)
    .bind(payload.get("status").map(String::as_str))
    .bind(payload.get("error").map(String::as_str))
    .bind(attempt_update.as_ref().map(|(attempt, _)| *attempt))
    .bind(attempt_update.as_ref().map(|(_, payload)| payload))
    .bind(re_arming)
    .bind(new_status.as_str())
    .bind(new_lease.as_deref())
    .bind(heartbeat)
    .bind(identity.attempt)
    .bind(identity.input_generation)
    .bind(&identity.lease_token)
    .bind(coordinator::JOB_LEASE_SECS as f64)
    .bind(reported_progress)
    .execute(&state.pool)
    .await;

    if result.is_ok() && job.job_type == "render" {
        let ledger_status = match new_status.as_str() {
            "PENDING" => Some("queued"),
            "PROCESSING" => Some("running"),
            "FAILED" => Some("failed"),
            // Completion means the worker delivered bytes; only the callback may attest the
            // immutable artifact and advance the page pointer.
            "COMPLETED" | "PAUSED" => None,
            _ => None,
        };
        if let Some(ledger_status) = ledger_status
            && let Err(err) = sqlx::query(
                "UPDATE page_render_jobs SET status = $2 WHERE job_id = $1 AND status <> 'succeeded'",
            )
            .bind(&job_id)
            .bind(ledger_status)
            .execute(&state.pool)
            .await
        {
            tracing::error!("Could not mirror render job {job_id} status to immutable ledger: {err}");
        }
    }

    match result {
        Ok(_) => {
            if new_status == "PENDING" {
                let refreshed: Option<Job> = sqlx::query_as("SELECT * FROM jobs WHERE id = $1")
                    .bind(&job_id)
                    .fetch_optional(&state.pool)
                    .await
                    .ok()
                    .flatten();
                if let Some(refreshed) = refreshed
                    && let Some(payload_json) = &refreshed.payload
                {
                    coordinator::push_job_to_redis(&state, &refreshed.job_type, payload_json).await;
                }
            }
            if let Some(image_id) = job.image_id {
                let refreshed: Option<Job> = sqlx::query_as("SELECT * FROM jobs WHERE id = $1")
                    .bind(&job_id)
                    .fetch_optional(&state.pool)
                    .await
                    .ok()
                    .flatten();
                if let Some(refreshed) = refreshed {
                    state
                        .sse
                        .emit_event_for_image(
                            image_id,
                            "job_update",
                            &serde_json::to_string(&refreshed).unwrap_or_default(),
                        )
                        .await;
                }

                // AUDIT-B12 follow-up. QA hands the "Page Processing Complete" notification to its
                // final render, so if that render dies here nobody ever says anything — the page
                // just stops, silently, with layers the export does not match. Say so instead.
                if new_status == "FAILED" && job.job_type == "render" && completes_pipeline(&job) {
                    let ctx = resolve_notification_context(&state, image_id, job.page_id).await;
                    emit_qa_notification(
                        &state,
                        image_id,
                        "ERROR",
                        "Re-render Failed",
                        "QA corrected this page, but re-rendering it failed. The exported image \
                         still shows the uncorrected version.",
                        &ctx,
                    )
                    .await;
                }
            }
            StatusCode::OK.into_response()
        }
        Err(err) => internal_error_text(err),
    }
}

/// Whether a job's stored payload carries QA's `completesPipeline` marker.
fn completes_pipeline(job: &Job) -> bool {
    job.payload
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| {
            value
                .get("completesPipeline")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false)
}

/// GET /api/internal/jobs/{jobId}
pub async fn get_job(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(job_id): Path<String>,
) -> Response {
    if let Some(denied) = guard(&state, &headers) {
        return denied;
    }
    match sqlx::query_as::<_, Job>("SELECT * FROM jobs WHERE id = $1")
        .bind(&job_id)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(job)) => Json(&job).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(err) => internal_error_text(err),
    }
}

// ---------------------------------------------------------------------------
// Worker image metadata
// ---------------------------------------------------------------------------

/// HEAD /api/internal/images/{imageId} — the stale-job guard's existence check.
pub async fn image_exists(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(image_id): Path<Uuid>,
) -> Response {
    if let Some(denied) = guard(&state, &headers) {
        return denied;
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM images WHERE id = $1)")
        .bind(image_id)
        .fetch_one(&state.pool)
        .await
        .unwrap_or(false);
    if exists {
        StatusCode::OK.into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

/// GET /api/internal/images/{imageId}?chapterId=&pageId= — everything the worker needs
/// for one page: presigned URL, panels, active OCR regions, layer elements, series
/// context and conversation groupings.
pub async fn get_image_info(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(image_id): Path<Uuid>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let Some(denied) = guard(&state, &headers) {
        return denied;
    }

    let image: Option<Image> = sqlx::query_as("SELECT * FROM images WHERE id = $1")
        .bind(image_id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
    let Some(image) = image else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let chapter_id = params
        .get("chapterId")
        .and_then(|v| Uuid::parse_str(v).ok());
    let page_id = params.get("pageId").and_then(|v| Uuid::parse_str(v).ok());

    // Java's PageRepository.findByImageId is unordered; note pages has NO created_at
    // column — ordering by it errors and unwrap_or_default would silently hide that.
    let pages: Vec<Page> =
        sqlx::query_as("SELECT * FROM pages WHERE image_id = $1 ORDER BY page_number ASC")
            .bind(image_id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_else(|e| {
                tracing::error!("image-info pages query failed for {image_id}: {e}");
                Vec::new()
            });

    let page = page_id
        .and_then(|pid| pages.iter().find(|p| p.id == pid))
        .or_else(|| chapter_id.and_then(|cid| pages.iter().find(|p| p.chapter_id == cid)))
        .or_else(|| pages.first());

    // OCR regions come only from the LATEST ocr layer's elements (backwards-compat:
    // all regions when no OCR layer exists yet).
    let layers: Vec<Layer> = match page {
        Some(page) => {
            sqlx::query_as("SELECT * FROM layers WHERE page_id = $1 ORDER BY z_order ASC")
                .bind(page.id)
                .fetch_all(&state.pool)
                .await
                .unwrap_or_default()
        }
        None => Vec::new(),
    };
    // The latest *complete* OCR pass: the filter below treats whatever this picks as the
    // definitive set of regions for the page, and an overlay is one bubble.
    let latest_ocr_layer = coordinator::latest_complete_layer(&layers, "ocr");

    let all_regions: Vec<OcrRegion> = match page {
        Some(page) => sqlx::query_as("SELECT * FROM ocr_regions WHERE page_id = $1")
            .bind(page.id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default(),
        None => Vec::new(),
    };

    let ocr_regions: Vec<&OcrRegion> = match latest_ocr_layer {
        Some(layer) => {
            let active_ids: Vec<Uuid> = sqlx::query_scalar::<_, Option<Uuid>>(
                "SELECT region_id FROM layer_elements WHERE layer_id = $1 AND region_id IS NOT NULL",
            )
            .bind(layer.id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default()
            .into_iter()
            .flatten()
            .collect();
            all_regions
                .iter()
                .filter(|r| active_ids.contains(&r.id))
                .collect()
        }
        None => all_regions.iter().collect(),
    };

    let layer_elements: Value = match page {
        Some(page) => {
            let elements: Vec<crate::models::LayerElement> =
                sqlx::query_as::<_, crate::models::LayerElement>(
                    "SELECT * FROM layer_elements WHERE layer_id IN (SELECT id FROM layers WHERE page_id = $1)",
                )
                .bind(page.id)
                .fetch_all(&state.pool)
                .await
                .unwrap_or_default();
            // Java's LayerElement entity exposes derived getters the worker's
            // renderer relies on (render.py fail-closes without them): flatten
            // layerType/layerVisible/regionType onto every element.
            let layer_map: std::collections::HashMap<Uuid, (&str, bool)> = layers
                .iter()
                .map(|l| (l.id, (l.layer_type.as_str(), l.visible.unwrap_or(true))))
                .collect();
            let region_types: std::collections::HashMap<Uuid, String> =
                sqlx::query_as::<_, (Uuid, Option<String>)>(
                    "SELECT id, region_type FROM ocr_regions WHERE page_id = $1 AND region_type IS NOT NULL",
                )
                .bind(page.id)
                .fetch_all(&state.pool)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter_map(|(id, rt)| rt.map(|rt| (id, rt)))
                .collect();
            Value::Array(
                elements
                    .into_iter()
                    .map(|el| {
                        let mut v = serde_json::to_value(&el).unwrap_or_default();
                        if let Some(obj) = v.as_object_mut() {
                            if let Some((layer_type, layer_visible)) = layer_map.get(&el.layer_id) {
                                obj.insert("layerType".into(), json!(layer_type));
                                obj.insert("layerVisible".into(), json!(layer_visible));
                            }
                            if let Some(region_type) =
                                el.region_id.and_then(|rid| region_types.get(&rid))
                            {
                                obj.insert("regionType".into(), json!(region_type));
                            }
                        }
                        v
                    })
                    .collect(),
            )
        }
        None => serde_json::json!([]),
    };

    let panels: Vec<Panel> = sqlx::query_as("SELECT * FROM panels WHERE image_id = $1")
        .bind(image_id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();

    let mut map = serde_json::Map::new();
    map.insert("filename".into(), json!(image.filename));
    map.insert("storagePath".into(), json!(image.storage_path));
    map.insert("id".into(), json!(image.id));
    map.insert(
        "presignedUrl".into(),
        json!(
            state
                .storage
                .presigned_get_url(&image.storage_path)
                .await
                .unwrap_or_default()
        ),
    );
    map.insert(
        "panels".into(),
        serde_json::to_value(&panels).unwrap_or_default(),
    );
    map.insert(
        "ocrRegions".into(),
        serde_json::to_value(&ocr_regions).unwrap_or_default(),
    );
    map.insert("layerElements".into(), layer_elements);

    // Series context for translation memory assembly.
    if let Some(page) = &page {
        let chapter: Option<Chapter> = sqlx::query_as("SELECT * FROM chapters WHERE id = $1")
            .bind(page.chapter_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
        if let Some(chapter) = &chapter {
            let series: Option<Series> = sqlx::query_as("SELECT * FROM series WHERE id = $1")
                .bind(chapter.series_id)
                .fetch_optional(&state.pool)
                .await
                .ok()
                .flatten();
            if let Some(series) = &series {
                map.insert(
                    "seriesMetadata".into(),
                    json!({
                        "title": series.title,
                        "originalLanguage": series.original_language,
                        "readingDirection": series.reading_direction,
                        "metadataJson": series.metadata_json,
                    }),
                );

                if chapter.use_context_memory {
                    if page.page_number > 1 {
                        let prev_text: Vec<String> = sqlx::query_scalar(
                            "SELECT COALESCE(translated_text, text) FROM ocr_regions \
                             WHERE page_id = (SELECT id FROM pages WHERE chapter_id=$1 AND page_number=$2 LIMIT 1)",
                        )
                        .bind(page.chapter_id)
                        .bind(page.page_number - 1)
                        .fetch_all(&state.pool)
                        .await
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(|t: Option<String>| t.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
                        .collect();
                        if !prev_text.is_empty() {
                            map.insert("previousPageText".into(), json!(prev_text.join(" | ")));
                        }
                    }
                    if chapter.chapter_number > 1.0 {
                        let summary: Option<Value> = sqlx::query_scalar(
                            "SELECT summary_json FROM chapters WHERE series_id=$1 AND chapter_number=$2 LIMIT 1",
                        )
                        .bind(chapter.series_id)
                        .bind(chapter.chapter_number - 1.0)
                        .fetch_optional(&state.pool)
                        .await
                        .ok()
                        .flatten();
                        if let Some(summary) = summary {
                            map.insert("chapterSummary".into(), summary);
                        }
                    }
                }
            }
        }

        // Conversations + their ordered regions.
        let conversations: Vec<(Uuid, String)> =
            sqlx::query_as("SELECT id, scene_type FROM conversations WHERE page_id = $1")
                .bind(page.id)
                .fetch_all(&state.pool)
                .await
                .unwrap_or_default();

        let mut conv_list: Vec<Value> = Vec::with_capacity(conversations.len());
        for (id, scene) in &conversations {
            let regions: Vec<(Uuid, i32)> = sqlx::query_as(
                "SELECT region_id, position FROM conversation_regions WHERE conversation_id = $1 ORDER BY position ASC",
            )
            .bind(id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();
            conv_list.push(json!({
                "id": id.to_string(),
                "sceneType": scene,
                "regions": regions.iter()
                    .map(|(rid, pos)| json!({"regionId": rid.to_string(), "position": pos}))
                    .collect::<Vec<_>>(),
            }));
        }
        map.insert("conversations".into(), Value::Array(conv_list));
    }

    Json(Value::Object(map)).into_response()
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

fn job_id_of(payload: &Value) -> Option<&str> {
    payload
        .get("jobId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn page_id_of(payload: &Value) -> Option<Uuid> {
    match payload.get("pageId") {
        Some(Value::String(s)) => Uuid::parse_str(s).ok(),
        Some(Value::Null) | None => None,
        Some(other) => other.as_str().and_then(|s| Uuid::parse_str(s).ok()),
    }
}

fn string_array<'a>(payload: &'a Value, key: &str) -> Vec<&'a Value> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .map(|arr| arr.iter().collect())
        .unwrap_or_default()
}

/// POST /api/internal/jobs/callback/panel
pub async fn panel_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(dto)) = body else {
        return crate::error::unreadable_body("/api/internal/jobs/callback/panel");
    };
    if let Some(denied) = guard(&state, &headers) {
        return denied;
    }
    let identity = match callback_identity(&headers, job_id_of(&dto)) {
        Ok(v) => v,
        Err(rejection) => return rejection.into_response(),
    };
    match coordinator::CALLBACK_IDENTITY
        .scope(
            identity.clone(),
            coordinator::handle_panel_callback(&state, &dto),
        )
        .await
    {
        Ok(()) => StatusCode::OK.into_response(),
        Err(err) => {
            tracing::error!("Error processing panel callback: {err}");
            coordinator::mark_claimed_callback_failed(&state, &identity.job_id, &err).await;
            internal_error_text(err)
        }
    }
}

/// POST /api/internal/jobs/callback/ocr
pub async fn ocr_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(dto)) = body else {
        return crate::error::unreadable_body("/api/internal/jobs/callback/ocr");
    };
    if let Some(denied) = guard(&state, &headers) {
        return denied;
    }
    let identity = match callback_identity(&headers, job_id_of(&dto)) {
        Ok(v) => v,
        Err(rejection) => return rejection.into_response(),
    };
    match coordinator::CALLBACK_IDENTITY
        .scope(
            identity.clone(),
            coordinator::handle_ocr_callback(&state, &dto),
        )
        .await
    {
        Ok(()) => StatusCode::OK.into_response(),
        Err(err) => {
            tracing::error!("Error processing OCR callback: {err}");
            coordinator::mark_claimed_callback_failed(&state, &identity.job_id, &err).await;
            internal_error_text(err)
        }
    }
}

/// POST /api/internal/jobs/callback/layout
pub async fn layout_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = body else {
        return crate::error::unreadable_body("/api/internal/jobs/callback/layout");
    };
    if let Some(denied) = guard(&state, &headers) {
        return denied;
    }
    let identity = match callback_identity(&headers, job_id_of(&payload)) {
        Ok(v) => v,
        Err(rejection) => return rejection.into_response(),
    };
    let Some(image_id) = payload
        .get("imageId")
        .and_then(|v| v.as_str())
        .and_then(|s| Uuid::parse_str(s).ok())
    else {
        return internal_error_text("imageId missing or unparsable");
    };
    let region_types = string_array(&payload, "regionTypes")
        .into_iter()
        .cloned()
        .collect::<Vec<Value>>();
    let conversations = string_array(&payload, "conversations")
        .into_iter()
        .cloned()
        .collect::<Vec<Value>>();

    let combined = serde_json::json!({
        "regionTypes": region_types,
        "conversations": conversations,
    });
    match coordinator::CALLBACK_IDENTITY
        .scope(
            identity,
            coordinator::handle_layout_callback(
                &state,
                job_id_of(&payload),
                image_id,
                page_id_of(&payload),
                &combined,
            ),
        )
        .await
    {
        Ok(()) => StatusCode::OK.into_response(),
        Err(err) => {
            tracing::error!("Error processing layout callback: {err}");
            internal_error_text(err)
        }
    }
}

/// POST /api/internal/jobs/callback/translation
pub async fn translation_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = body else {
        return crate::error::unreadable_body("/api/internal/jobs/callback/translation");
    };
    if let Some(denied) = guard(&state, &headers) {
        return denied;
    }
    let identity = match callback_identity(&headers, job_id_of(&payload)) {
        Ok(v) => v,
        Err(rejection) => return rejection.into_response(),
    };
    let Some(image_id) = payload
        .get("imageId")
        .and_then(|v| v.as_str())
        .and_then(|s| Uuid::parse_str(s).ok())
    else {
        return internal_error_text("imageId missing or unparsable");
    };

    // Inject the echoed pageId into the first translation entry so the coordinator can
    // resolve the right page (an image may back pages in several chapters).
    let raw_page_id = payload
        .get("pageId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut translations: Vec<Value> = string_array(&payload, "translations")
        .into_iter()
        .cloned()
        .collect();
    if translations.is_empty() {
        translations.push(serde_json::json!({}));
    }
    if let Some(raw_page_id) = raw_page_id.filter(|p| p != "null" && !p.is_empty())
        && let Some(first) = translations.first_mut()
    {
        first
            .as_object_mut()
            .map(|obj| obj.insert("pageId".into(), Value::String(raw_page_id)));
    }

    let cost = payload.get("cost").cloned();
    match coordinator::CALLBACK_IDENTITY
        .scope(
            identity.clone(),
            coordinator::handle_translation_callback(
                &state,
                job_id_of(&payload),
                image_id,
                &translations,
                cost.as_ref(),
            ),
        )
        .await
    {
        Ok(()) => StatusCode::OK.into_response(),
        Err(err) => {
            tracing::error!("Error processing translation callback: {err}");
            coordinator::mark_claimed_callback_failed(&state, &identity.job_id, &err).await;
            internal_error_text(err)
        }
    }
}

/// POST /api/internal/jobs/callback/cleanup — per-region cleanup outcomes for one page.
///
/// Translation is dispatched from inside this callback's own transaction, so the decision "every
/// required region was dealt with" and the decision "the next stage exists" cannot disagree. The
/// accounting is against the region list the *backend* dispatched, not the list the worker chose
/// to report: a response that silently omits regions, repeats one, or names a region from another
/// page is a failed cleanup, not a short pass. (That is the same mistake the QA stage made when it
/// logged a pass on 38 verdicts for 63 regions; it is not repeated here.)
pub async fn cleanup_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = body else {
        return crate::error::unreadable_body("/api/internal/jobs/callback/cleanup");
    };
    if let Some(denied) = guard(&state, &headers) {
        return denied;
    }
    let identity = match callback_identity(&headers, job_id_of(&payload)) {
        Ok(identity) => identity,
        Err(rejection) => return rejection.into_response(),
    };
    let Some(image_id) = payload
        .get("imageId")
        .and_then(Value::as_str)
        .and_then(|id| Uuid::parse_str(id).ok())
    else {
        return internal_error_text("imageId missing or unparsable");
    };

    let result = coordinator::CALLBACK_IDENTITY
        .scope(identity, apply_cleanup_callback(&state, image_id, &payload))
        .await;
    match result {
        Ok(()) => StatusCode::OK.into_response(),
        Err(CleanupCallbackError::Superseded) => (
            StatusCode::CONFLICT,
            "This cleanup attempt has been superseded; its result was not applied",
        )
            .into_response(),
        Err(CleanupCallbackError::Failed(err)) => {
            tracing::error!("Error processing cleanup callback: {err}");
            internal_error_text(err)
        }
    }
}

/// Why a cleanup callback was not applied. The distinction reaches the worker as the status code,
/// because the two want opposite things from it: a superseded attempt must stop, while a failure
/// to apply a current attempt's result is worth another delivery.
enum CleanupCallbackError {
    Superseded,
    Failed(String),
}

impl From<String> for CleanupCallbackError {
    fn from(message: String) -> Self {
        CleanupCallbackError::Failed(message)
    }
}

impl From<&str> for CleanupCallbackError {
    fn from(message: &str) -> Self {
        CleanupCallbackError::Failed(message.to_string())
    }
}

/// Every region the cleanup job was dispatched with, as `regionId -> inputDigest`.
fn dispatched_cleanup_regions(parent: &Job) -> HashMap<Uuid, String> {
    parent
        .payload
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| {
            value
                .get("cleanupRegions")
                .and_then(Value::as_array)
                .cloned()
        })
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let id = entry
                .get("regionId")
                .and_then(Value::as_str)
                .and_then(|id| Uuid::parse_str(id).ok())?;
            let digest = entry.get("inputDigest").and_then(Value::as_str)?.to_owned();
            Some((id, digest))
        })
        .collect()
}

async fn apply_cleanup_callback(
    state: &AppState,
    image_id: Uuid,
    payload: &Value,
) -> Result<(), CleanupCallbackError> {
    let job_id = job_id_of(payload).ok_or("cleanup callback missing jobId")?;
    let page = coordinator::resolve_page_for_callback(&state.pool, image_id, page_id_of(payload))
        .await
        .ok_or("cleanup callback page no longer exists")?;

    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
    let parent: Job = sqlx::query_as("SELECT * FROM jobs WHERE id = $1 FOR UPDATE")
        .bind(job_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    match coordinator::claim_callback_tx(&mut tx, Some(job_id), image_id, "cleanup")
        .await
        .map_err(|e| e.to_string())?
    {
        coordinator::ClaimOutcome::Claimed => {}
        // A re-sent delivery of the attempt that already landed: the patches are on the page and
        // translation was dispatched. Acknowledging it is correct.
        coordinator::ClaimOutcome::AlreadyApplied => {
            tx.rollback().await.map_err(|e| e.to_string())?;
            return Ok(());
        }
        // A superseded attempt. Nothing of its work is usable, and telling it "OK" would send it
        // on to report COMPLETED for a stage it no longer owns.
        coordinator::ClaimOutcome::NotCurrent => {
            tx.rollback().await.map_err(|e| e.to_string())?;
            return Err(CleanupCallbackError::Superseded);
        }
    }

    let mut expected = dispatched_cleanup_regions(&parent);
    let mut problems: Vec<String> = Vec::new();

    // The digest the worker echoes binds its whole run to the exact list it was handed. A
    // mismatch means it worked from something else, whatever its per-region statuses say.
    let dispatched_digest = parent
        .payload
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| {
            value
                .get("cleanupInputDigest")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    if dispatched_digest.is_some()
        && dispatched_digest.as_deref() != payload.get("cleanupInputDigest").and_then(Value::as_str)
    {
        problems.push("cleanupInputDigest does not match the dispatched region list".into());
    }

    for outcome in string_array(payload, "regions") {
        let Some(region_id) = outcome
            .get("regionId")
            .and_then(Value::as_str)
            .and_then(|id| Uuid::parse_str(id).ok())
        else {
            problems.push("a cleanup outcome carried no usable regionId".into());
            continue;
        };
        // `remove` is what makes a repeat detectable: the second copy finds nothing left.
        let Some(dispatched_digest) = expected.remove(&region_id) else {
            problems.push(format!(
                "region {region_id} was reported but was not dispatched (or was reported twice)"
            ));
            continue;
        };
        if outcome.get("inputDigest").and_then(Value::as_str) != Some(dispatched_digest.as_str()) {
            problems.push(format!(
                "region {region_id} reported a different inputDigest"
            ));
            continue;
        }
        match outcome.get("status").and_then(Value::as_str).unwrap_or("") {
            // A policy exclusion is a complete outcome, not a missing one.
            "excluded" => {}
            status @ ("complete" | "degraded") => {
                let changed = sqlx::query(
                    "UPDATE ocr_regions SET cleanup_mask_asset_id = $2, cleanup_mask_sha256 = $3, \
                       cleanup_mask_byte_length = $4, cleanup_patch_asset_id = $5, \
                       cleanup_patch_sha256 = $6, cleanup_patch_byte_length = $7, \
                       cleanup_bounds = $8, cleanup_generator_sha256 = $9, \
                       cleanup_diagnostics = $10 \
                     WHERE id = $1 AND page_id = $11",
                )
                .bind(region_id)
                .bind(outcome.get("cleanupMaskAssetId").and_then(Value::as_str))
                .bind(outcome.get("cleanupMaskSha256").and_then(Value::as_str))
                .bind(outcome.get("cleanupMaskByteLength").and_then(Value::as_i64))
                .bind(outcome.get("cleanupPatchAssetId").and_then(Value::as_str))
                .bind(outcome.get("cleanupPatchSha256").and_then(Value::as_str))
                .bind(
                    outcome
                        .get("cleanupPatchByteLength")
                        .and_then(Value::as_i64),
                )
                .bind(outcome.get("cleanupBounds").cloned())
                .bind(
                    outcome
                        .get("cleanupGeneratorSha256")
                        .and_then(Value::as_str),
                )
                .bind(outcome.get("diagnostics").cloned())
                .bind(page.id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                if changed.rows_affected() != 1 {
                    problems.push(format!(
                        "region {region_id} reported {status} but no longer belongs to page {}",
                        page.id
                    ));
                }
            }
            "failed" => problems.push(format!("region {region_id} failed cleanup")),
            other => problems.push(format!(
                "region {region_id} reported unknown status {other:?}"
            )),
        }
    }
    for missing in expected.keys() {
        problems.push(format!(
            "region {missing} was dispatched but never reported"
        ));
    }

    // A failed cleanup withholds translation rather than translating a page whose Japanese is
    // still on it. The job is FAILED explicitly so it shows up as one, and the worker's bounded
    // retry (or a manual page redo) is what tries again.
    let dispatch = if problems.is_empty() {
        Some(
            coordinator::persist_next_job_tx(
                &mut tx,
                &parent,
                "translation",
                image_id,
                &page,
                |_| {},
            )
            .await
            .map_err(|e| e.to_string())?,
        )
    } else {
        tracing::error!(
            "Cleanup for page {} is incomplete; withholding translation: {}",
            page.id,
            problems.join("; ")
        );
        sqlx::query(
            "UPDATE jobs SET status = 'FAILED', error = $2, updated_at = now() WHERE id = $1",
        )
        .bind(job_id)
        .bind(format!(
            "Cleanup incomplete ({} problem(s)); translation withheld. First: {}",
            problems.len(),
            problems[0]
        ))
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        None
    };
    tx.commit().await.map_err(|e| e.to_string())?;

    // Redis publication happens only after the row is durable. A crash in between leaves a PENDING
    // row that startup recovery and `requeue_orphaned_pending_jobs` republish.
    if let Some((next_id, next_payload)) = dispatch {
        coordinator::push_persisted_job_if_queue_running(
            state,
            &next_id,
            "translation",
            &next_payload,
        )
        .await;
    }
    Ok(())
}

/// POST /api/internal/jobs/callback/qa-re-ocr
pub async fn qa_re_ocr_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = body else {
        return crate::error::unreadable_body("/api/internal/jobs/callback/qa-re-ocr");
    };
    if let Some(denied) = guard(&state, &headers) {
        return denied;
    }
    let identity = match callback_identity(&headers, job_id_of(&payload)) {
        Ok(identity) => identity,
        Err(rejection) => return rejection.into_response(),
    };
    let Some(image_id) = payload
        .get("imageId")
        .and_then(|v| v.as_str())
        .and_then(|s| Uuid::parse_str(s).ok())
    else {
        return internal_error_text("imageId missing or unparsable");
    };
    let results = string_array(&payload, "results")
        .into_iter()
        .cloned()
        .collect::<Vec<Value>>();

    match coordinator::CALLBACK_IDENTITY
        .scope(
            identity.clone(),
            coordinator::handle_qa_re_ocr_callback(
                &state,
                job_id_of(&payload),
                image_id,
                page_id_of(&payload),
                &results,
                payload.get("cost"),
            ),
        )
        .await
    {
        Ok(()) => StatusCode::OK.into_response(),
        Err(err) => {
            tracing::error!("Error processing QA Re-OCR callback: {err}");
            coordinator::mark_claimed_callback_failed(&state, &identity.job_id, &err).await;
            internal_error_text(err)
        }
    }
}

/// POST /api/internal/images/{imageId}/qa-hybrid-prepare
pub async fn qa_hybrid_prepare(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(image_id): Path<Uuid>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = body else {
        return crate::error::unreadable_body("/api/internal/images/{imageId}/qa-hybrid-prepare");
    };
    if let Some(denied) = guard(&state, &headers) {
        return denied;
    }
    let qa_results = string_array(&payload, "qaResults")
        .into_iter()
        .cloned()
        .collect::<Vec<Value>>();

    match coordinator::prepare_hybrid_qa(&state, image_id, page_id_of(&payload), &qa_results).await
    {
        Ok(Some(render_payload)) => Json(render_payload).into_response(),
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Err(err) => {
            tracing::error!("Error preparing hybrid QA: {err}");
            internal_error_text(err)
        }
    }
}

/// POST /api/internal/jobs/callback/qa — verdict drives the SSE notification text.
pub async fn qa_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = body else {
        return crate::error::unreadable_body("/api/internal/jobs/callback/qa");
    };
    if let Some(denied) = guard(&state, &headers) {
        return denied;
    }
    let identity = match callback_identity(&headers, job_id_of(&payload)) {
        Ok(identity) => identity,
        Err(rejection) => return rejection.into_response(),
    };
    let Some(image_id) = payload
        .get("imageId")
        .and_then(|v| v.as_str())
        .and_then(|s| Uuid::parse_str(s).ok())
    else {
        return internal_error_text("imageId missing or unparsable");
    };

    let ctx = resolve_notification_context(&state, image_id, page_id_of(&payload)).await;

    let qa_results = string_array(&payload, "qaResults")
        .into_iter()
        .cloned()
        .collect::<Vec<Value>>();
    let cost = payload.get("cost").cloned();

    match coordinator::CALLBACK_IDENTITY
        .scope(
            identity.clone(),
            coordinator::handle_qa_callback(
                &state,
                job_id_of(&payload),
                image_id,
                page_id_of(&payload),
                &qa_results,
                cost.as_ref(),
            ),
        )
        .await
    {
        Ok("COMPLETED") => {
            emit_qa_notification(
                &state,
                image_id,
                "SUCCESS",
                "Page Processing Complete",
                "All processing steps finished successfully.",
                &ctx,
            )
            .await;
            StatusCode::OK.into_response()
        }
        // The final render will emit "Page Processing Complete" once it lands; saying it here
        // would announce corrections the exported PNG does not carry yet.
        Ok("COMPLETED_PENDING_RENDER") => StatusCode::OK.into_response(),
        Ok("COMPLETED_NO_QA") => {
            emit_qa_notification(
                &state,
                image_id,
                "WARNING",
                "Processing Complete, QA Skipped",
                "Processing finished, but QA returned no usable results and was not applied.",
                &ctx,
            )
            .await;
            StatusCode::OK.into_response()
        }
        Ok("MANUAL_REVIEW") => {
            emit_qa_notification(
                &state,
                image_id,
                "WARNING",
                "Manual Review Needed",
                "QA pipeline halted because some regions require manual intervention.",
                &ctx,
            )
            .await;
            StatusCode::OK.into_response()
        }
        Ok(_) => StatusCode::OK.into_response(),
        Err(err) => {
            tracing::error!("Error processing QA callback: {err}");
            coordinator::mark_claimed_callback_failed(&state, &identity.job_id, &err).await;
            emit_qa_notification(
                &state,
                image_id,
                "ERROR",
                "QA Failed",
                "An error occurred during QA checks.",
                &ctx,
            )
            .await;
            internal_error_text(err)
        }
    }
}

/// Series/chapter/page labels appended to callback notifications (" (Series Ch.2 p.14)").
async fn resolve_notification_context(
    state: &AppState,
    image_id: Uuid,
    callback_page_id: Option<Uuid>,
) -> HashMap<String, String> {
    let mut context = HashMap::new();
    let pages: Vec<Page> = sqlx::query_as("SELECT * FROM pages WHERE image_id = $1")
        .bind(image_id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();
    let Some(page) = callback_page_id
        .and_then(|pid| pages.iter().find(|p| p.id == pid))
        .or_else(|| pages.first())
    else {
        return context;
    };
    context.insert("pageNumber".into(), page.page_number.to_string());

    let chapter: Option<Chapter> = sqlx::query_as("SELECT * FROM chapters WHERE id = $1")
        .bind(page.chapter_id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
    if let Some(chapter) = chapter {
        context.insert("chapterNumber".into(), chapter.chapter_number.to_string());
        context.insert("chapterTitle".into(), chapter.title.unwrap_or_default());
        let series: Option<Series> = sqlx::query_as("SELECT * FROM series WHERE id = $1")
            .bind(chapter.series_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
        if let Some(series) = series {
            context.insert("seriesTitle".into(), series.title);
        }
    }
    context
}

fn format_message(base: &str, ctx: &HashMap<String, String>) -> String {
    if ctx.is_empty() {
        return base.to_string();
    }
    let series = ctx.get("seriesTitle").map(String::as_str).unwrap_or("");
    let ch_num = ctx.get("chapterNumber").map(String::as_str).unwrap_or("");
    let p_num = ctx.get("pageNumber").map(String::as_str).unwrap_or("");

    let mut out = String::from(base);
    out.push_str(" (");
    if !series.is_empty() {
        out.push_str(series);
        out.push(' ');
    }
    if !ch_num.is_empty() {
        out.push_str("Ch.");
        out.push_str(ch_num);
        out.push(' ');
    }
    if !p_num.is_empty() {
        out.push_str("p.");
        out.push_str(p_num);
    }
    let formatted = format!("{out})");
    formatted.replace(" )", ")").trim().to_string()
}

async fn emit_qa_notification(
    state: &AppState,
    image_id: Uuid,
    kind: &str,
    title: &str,
    base_message: &str,
    ctx: &HashMap<String, String>,
) {
    let message = format_message(base_message, ctx);
    state
        .sse
        .emit_notification_for_image(image_id, kind, title, &message, Some(ctx))
        .await;
}

/// POST /api/internal/ocr-regions/{id}/callback — single-region redo result.
pub async fn region_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(region_id): Path<Uuid>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = body else {
        return crate::error::unreadable_body("/api/internal/ocr-regions/{id}/callback");
    };
    if let Some(denied) = guard(&state, &headers) {
        return denied;
    }
    // Identity is required only when the body names a job. A region result with no `jobId` is a
    // shape the worker still produces (`handlers/redo.py` sets the field only when it has one),
    // and it is the same shape that already skips the claim below — there is nothing for the
    // identity to fence. A body that DOES name a job must prove it is the current attempt.
    let identity = match callback_identity(&headers, job_id_of(&payload)) {
        Ok(identity) => Some(identity),
        Err(rejection) => {
            if job_id_of(&payload).is_some() {
                return rejection.into_response();
            }
            None
        }
    };

    let obj = payload.as_object();
    let Some(fields) = obj else {
        return internal_error_text("payload must be an object");
    };

    let translated = fields.contains_key("translatedText");

    // Resolved once and reused: the claim below and the cost write both need it.
    let image_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT p.image_id FROM ocr_regions r JOIN pages p ON p.id = r.page_id WHERE r.id = $1",
    )
    .bind(region_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();

    // Claim, region write and history layer go in together or not at all.
    //
    // Claiming first and failing left the delivery flagged applied with nothing written, so the
    // worker's retry was dropped as a duplicate and the result lost. Claiming afterwards was worse
    // in a different way: a stale redelivery of an older job overwrote the canonical text *before*
    // being recognised as a duplicate, so the region carried an old reading while the visible
    // overlay showed the newer one — and the next translation redo read the stale value. A rollback
    // now releases the claim, so a retry can do the work properly.
    let mut tx = match state.pool.begin().await {
        Ok(tx) => tx,
        Err(err) => {
            tracing::error!("Region {region_id} callback could not open a transaction: {err}");
            return internal_error_text(err);
        }
    };

    // Only deduplicate a delivery that names its job: without one there is no safe way to tell
    // which of several in-flight region redos on this image it belongs to.
    let claim_job_id = fields
        .get("jobId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if let (Some(image_id), Some(job_id), Some(identity)) = (image_id, claim_job_id, identity) {
        let job_type = if translated {
            "region-redo-tl"
        } else {
            "region-redo-ocr"
        };
        match coordinator::CALLBACK_IDENTITY
            .scope(
                identity,
                coordinator::claim_callback_tx(&mut tx, Some(job_id), image_id, job_type),
            )
            .await
        {
            Ok(coordinator::ClaimOutcome::Claimed) => {}
            Ok(coordinator::ClaimOutcome::AlreadyApplied) => {
                // Already applied; the first delivery did the work. Nothing written, nothing to undo.
                let _ = tx.rollback().await;
                return StatusCode::OK.into_response();
            }
            Ok(coordinator::ClaimOutcome::NotCurrent) => {
                let _ = tx.rollback().await;
                return (
                    StatusCode::CONFLICT,
                    "This attempt has been superseded; its result was not applied",
                )
                    .into_response();
            }
            Err(err) => {
                tracing::error!("Region {region_id} callback could not claim its job: {err}");
                let _ = tx.rollback().await;
                return internal_error_text(err);
            }
        }
    }

    if let Err(err) = sqlx::query(
        "UPDATE ocr_regions SET \
           text = COALESCE($2, text), \
           detected_language = COALESCE($3, detected_language), \
           translated_text = CASE WHEN $4 THEN $5 ELSE translated_text END, \
           translation_failed = CASE WHEN $4 THEN FALSE WHEN $6 THEN $7 ELSE translation_failed END, \
           confidence = COALESCE($8, confidence) \
         WHERE id = $1",
    )
    .bind(region_id)
    .bind(fields.get("text").and_then(Value::as_str))
    .bind(fields.get("detectedLanguage").and_then(Value::as_str))
    .bind(translated)
    .bind(fields.get("translatedText").and_then(Value::as_str))
    .bind(fields.contains_key("translationFailed"))
    .bind(
        fields
            .get("translationFailed")
            .and_then(Value::as_str)
            .map(|s| s.eq_ignore_ascii_case("true"))
            .or_else(|| fields.get("translationFailed").and_then(Value::as_bool))
            .unwrap_or(false),
    )
    .bind(fields.get("confidence").and_then(Value::as_f64))
    .execute(&mut *tx)
    .await
    {
        tracing::error!("Error processing region callback: {err}");
        let _ = tx.rollback().await;
        return internal_error_text(err);
    }

    // Record the redo as a one-element layer stacked on top rather than overwriting the element in
    // place. The old text used to be destroyed here — the only step in the editor that could not be
    // undone, in the one place a user is most likely to want to compare two readings.
    let (layer_type, new_text) = if translated {
        (
            "translation",
            fields.get("translatedText").and_then(Value::as_str),
        )
    } else {
        ("ocr", fields.get("text").and_then(Value::as_str))
    };
    // Ok(None) means there was nothing to supersede, which is fine. An Err means the history layer
    // genuinely failed to write, and acknowledging that would leave the canonical text changed with
    // no record of what it replaced and no retry able to repair it.
    if let Err(err) = coordinator::create_region_redo_overlay(
        &mut tx,
        region_id,
        new_text,
        layer_type,
        claim_job_id,
    )
    .await
    {
        tracing::error!("Region {region_id} redo overlay could not be written: {err}");
        let _ = tx.rollback().await;
        return internal_error_text(err);
    }

    // The callback claim and its paid-model spend are one delivery. If the cost insert fails,
    // rolling this transaction back leaves the job unclaimed so the worker can retry everything.
    if let Some(cost) = fields.get("cost").filter(|cost| !cost.is_null()) {
        match image_id {
            Some(image_id) => {
                if let Err(err) = coordinator::save_job_costs_tx(
                    &mut tx,
                    image_id,
                    fields.get("jobId").and_then(Value::as_str),
                    cost,
                )
                .await
                {
                    tracing::error!(
                        "Region {region_id} callback could not persist its cost: {err}"
                    );
                    let _ = tx.rollback().await;
                    return internal_error_text(err);
                }
            }
            None => tracing::warn!(
                "Region {region_id} callback carried a cost but no image could be resolved for it"
            ),
        }
    }

    if let Err(err) = tx.commit().await {
        tracing::error!("Region {region_id} callback could not commit: {err}");
        return internal_error_text(err);
    }

    // A re-read invalidates the translation that was made from the old text, so redoing the
    // OCR carries on into a redo of that bubble's translation: one new OCR layer, then one
    // new translation layer. The translation job reads the region's current text, which is
    // why the in-place write above is kept — the layers are the history, `ocr_regions` is
    // what the next stage reads.
    //
    // Redoing a translation on its own does not come back the other way. Asking for a new
    // wording is not a claim that the source text was misread, and re-running OCR would
    // throw away the reading the user was working from.
    //
    // Enqueued after the commit, so it cannot be rolled back once queued. The cost of that
    // ordering is that a failure here leaves a re-read page with its old translation and no
    // retry to fix it — logged loudly, and recoverable by redoing the translation by hand.
    if !translated
        && let Err(err) = coordinator::trigger_redo(&state, region_id, "translation").await
    {
        tracing::error!(
            "Region {region_id} was re-read but its translation could not be requeued ({err}) \
             — the page now shows a new reading with its previous translation, redo the \
             translation for this bubble to resolve it"
        );
    }
    StatusCode::OK.into_response()
}

/// Sub-router mounted under `/api/internal`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/jobs/{jobId}/status",
            axum::routing::patch(update_job_status),
        )
        .route("/jobs/{jobId}", get(get_job))
        .route("/images/{imageId}", get(get_image_info).head(image_exists))
        .route(
            "/images/{imageId}/qa-hybrid-prepare",
            axum::routing::post(qa_hybrid_prepare),
        )
        .route("/jobs/callback/panel", axum::routing::post(panel_callback))
        .route("/jobs/callback/ocr", axum::routing::post(ocr_callback))
        .route(
            "/jobs/callback/cleanup",
            axum::routing::post(cleanup_callback),
        )
        .route(
            "/jobs/callback/layout",
            axum::routing::post(layout_callback),
        )
        .route(
            "/jobs/callback/translation",
            axum::routing::post(translation_callback),
        )
        .route("/jobs/callback/qa", axum::routing::post(qa_callback))
        .route(
            "/jobs/callback/qa-re-ocr",
            axum::routing::post(qa_re_ocr_callback),
        )
        .route(
            "/jobs/callback/render",
            axum::routing::post(render_callback_route),
        )
        .route(
            "/ocr-regions/{id}/callback",
            axum::routing::post(region_callback),
        )
}

async fn render_callback_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    // Was `HashMap<String, String>`; the browser-render callback (tracker R1) also carries the
    // integer page revision and the renderer's layout diagnostics array.
    let Ok(Json(payload)) = body else {
        return crate::error::unreadable_body("/api/internal/jobs/callback/render");
    };
    if let Some(denied) = guard(&state, &headers) {
        return denied;
    }
    let identity = match callback_identity(&headers, job_id_of(&payload)) {
        Ok(identity) => identity,
        Err(rejection) => return rejection.into_response(),
    };
    let Some(image_id) = payload
        .get("imageId")
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok())
    else {
        return internal_error_text("imageId missing or unparsable");
    };
    let page_id = payload
        .get("pageId")
        .and_then(Value::as_str)
        .and_then(|s| Uuid::parse_str(s).ok());
    let diagnostics = payload
        .get("diagnostics")
        .filter(|d| d.is_array())
        .cloned()
        .unwrap_or_else(|| json!([]));
    // Resolved layout per text object (font px, line breaks); tracker R2 (c).
    let layout = payload
        .get("layout")
        .filter(|l| l.is_array())
        .cloned()
        .unwrap_or_else(|| json!([]));

    match coordinator::CALLBACK_IDENTITY
        .scope(
            identity,
            coordinator::handle_render_callback(
                &state,
                payload.get("jobId").and_then(Value::as_str),
                image_id,
                page_id,
                diagnostics,
                layout,
            ),
        )
        .await
    {
        Ok(outcome) => {
            // A callback for an old revision may be valid for its own job, but it must not
            // refresh image-level freshness, regenerate a mutable-path thumbnail, or announce
            // completion for the page's newer scene.
            if outcome.artifact_current {
                let _ = sqlx::query("UPDATE images SET last_rendered_at = now() WHERE id = $1")
                    .bind(image_id)
                    .execute(&state.pool)
                    .await;
            }
            if outcome.completes_pipeline {
                let ctx = resolve_notification_context(&state, image_id, page_id).await;
                emit_qa_notification(
                    &state,
                    image_id,
                    "SUCCESS",
                    "Page Processing Complete",
                    "All processing steps finished successfully.",
                    &ctx,
                )
                .await;
            }
            StatusCode::OK.into_response()
        }
        Err(err) => {
            tracing::error!("Error processing render callback: {err}");
            internal_error_text(err)
        }
    }
}
