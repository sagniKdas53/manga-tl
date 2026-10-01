//! Render an edited page in the request, instead of after the debounce and a worker slot.
//!
//! An editor edit used to reach the stored render (what Export, the reader and the chapter ZIP
//! use) only after the page had sat unedited for `RENDER_DEBOUNCE_SECONDS` (30) and then a worker's
//! light slot came free, which on a busy queue meant waiting behind QA passes of 50-200 s each.
//! Export said "render still pending" in the meantime (user review, 2026-10-02).
//!
//! The pixels do not change: the render is queued exactly as the debounce sweep queues it (same
//! snapshot, job and ledger rows), the backend wins that job's start compare-and-swap itself, sends
//! the scene to the same pinned page-renderer the worker uses, stores the PNG where the worker
//! would, and applies it through the ordinary render callback (`handle_render_callback`). If a
//! worker started the job first, this waits for that render instead. The queued payload is then
//! dropped by the dispatcher, which sends only PENDING jobs.
//!
//! The protocol mirrors the worker's `page_scene_renderer.render_page_scene`; keep them in step.

use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::jobs::coordinator::{self, CALLBACK_IDENTITY, CallbackIdentity};
use crate::models::Page;
use crate::state::AppState;

/// What [`render_page_now`] did.
#[derive(Debug)]
pub enum RenderNow {
    /// The page's current revision has a finished render (perhaps just made).
    Current { revision: i32 },
    /// The render failed; the message says why.
    Failed(String),
    /// The renderer cannot be reached or stayed busy; the job went back to the queue.
    Unavailable(String),
}

/// `(attempt, input_generation, lease_token, payload, image_id)` of a render job this request won.
type ClaimedJob = (
    Option<i32>,
    i32,
    Option<String>,
    Option<String>,
    Option<Uuid>,
);

/// How long a busy renderer (HTTP 503) is waited for, and how long a render a worker started is
/// waited for, before answering.
const WAIT: Duration = Duration::from_secs(60);

pub async fn render_page_now(state: &AppState, page_id: Uuid) -> RenderNow {
    match render(state, page_id).await {
        Ok(outcome) => outcome,
        Err(err) => RenderNow::Failed(err),
    }
}

async fn load_page(state: &AppState, page_id: Uuid) -> Result<Page, String> {
    sqlx::query_as("SELECT * FROM pages WHERE id = $1")
        .bind(page_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("page {page_id} not found"))
}

/// The ledger row for the page's current snapshot: `(job_id, status)`.
async fn current_ledger(
    state: &AppState,
    page: &Page,
    digest: &str,
) -> Result<Option<(String, String)>, String> {
    sqlx::query_as(
        "SELECT job_id, status FROM page_render_jobs \
         WHERE page_id = $1 AND page_revision = $2 AND logical_scene_sha256 = $3 \
           AND status IN ('queued', 'running', 'succeeded') \
         ORDER BY created_at ASC LIMIT 1",
    )
    .bind(page.id)
    .bind(page.scene_revision)
    .bind(digest)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())
}

async fn render(state: &AppState, page_id: Uuid) -> Result<RenderNow, String> {
    let mut page = load_page(state, page_id).await?;

    // An edit advances the revision and leaves the snapshot to the debounce; take it now.
    if crate::page_scene::current_snapshot(&state.pool, page.id)
        .await
        .map_err(|e| e.to_string())?
        .is_none()
    {
        let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
        crate::page_scene_builder::snapshot_pipeline_scene(state, &mut tx, page.id).await?;
        tx.commit().await.map_err(|e| e.to_string())?;
        page = load_page(state, page_id).await?;
    }
    let snapshot = crate::page_scene::current_snapshot(&state.pool, page.id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("the page has no scene snapshot")?;
    let revision = snapshot.revision;

    if crate::jobs::recovery::reuse_unchanged_render(state, &page).await? {
        return Ok(RenderNow::Current { revision });
    }
    if current_ledger(state, &page, &snapshot.logical_scene_sha256)
        .await?
        .is_none()
    {
        crate::jobs::recovery::enqueue_current_snapshot_render(state, &page, Map::new()).await?;
    }
    let Some((job_id, status)) =
        current_ledger(state, &page, &snapshot.logical_scene_sha256).await?
    else {
        return Err("the render job could not be queued".into());
    };
    if status == "succeeded" {
        return Ok(RenderNow::Current { revision });
    }

    // Win the start compare-and-swap the worker would win; a worker that already has the job
    // keeps it, and this waits for its result.
    let claimed: Option<ClaimedJob> = sqlx::query_as(
        "UPDATE jobs SET status = 'PROCESSING', started_at = now(), heartbeat_at = now(), \
               lease_expires_at = now() + make_interval(secs => $2), updated_at = now() \
             WHERE id = $1 AND status = 'PENDING' \
             RETURNING attempt, input_generation, lease_token, payload, image_id",
    )
    .bind(&job_id)
    .bind(coordinator::JOB_LEASE_SECS as f64)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    let Some((attempt, input_generation, lease_token, payload, image_id)) = claimed else {
        return wait_for(state, &job_id, revision).await;
    };
    let _ = sqlx::query(
        "UPDATE page_render_jobs SET status = 'running' WHERE job_id = $1 AND status <> 'succeeded'",
    )
    .bind(&job_id)
    .execute(&state.pool)
    .await;
    let identity = CallbackIdentity {
        job_id: job_id.clone(),
        attempt: attempt.unwrap_or(1),
        input_generation,
        lease_token: lease_token.unwrap_or_default(),
    };
    let image_id = image_id.unwrap_or(page.image_id);
    let payload: Value = payload
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or(Value::Null);

    match draw(state, &page, &snapshot, image_id, &identity, &payload).await {
        Ok(result) => {
            let outcome = CALLBACK_IDENTITY
                .scope(
                    identity,
                    coordinator::handle_render_callback(
                        state,
                        Some(&job_id),
                        image_id,
                        Some(page.id),
                        result.diagnostics,
                        result.layout,
                        result.artifact,
                    ),
                )
                .await?;
            if outcome.artifact_current {
                let _ = sqlx::query("UPDATE images SET last_rendered_at = now() WHERE id = $1")
                    .bind(image_id)
                    .execute(&state.pool)
                    .await;
            }
            Ok(RenderNow::Current { revision })
        }
        Err(DrawError::Unavailable(reason)) => {
            // Not this scene's fault: hand the job back to the queue for a worker.
            let _ = sqlx::query(
                "UPDATE jobs SET status = 'PENDING', started_at = NULL, heartbeat_at = NULL, \
                   lease_expires_at = NULL, updated_at = now() \
                 WHERE id = $1 AND status = 'PROCESSING'",
            )
            .bind(&job_id)
            .execute(&state.pool)
            .await;
            let _ = sqlx::query(
                "UPDATE page_render_jobs SET status = 'queued' WHERE job_id = $1 AND status = 'running'",
            )
            .bind(&job_id)
            .execute(&state.pool)
            .await;
            if let Some(raw) = payload.as_object().map(|_| payload.to_string()) {
                coordinator::push_job_to_redis(state, "render", &raw).await;
            }
            Ok(RenderNow::Unavailable(reason))
        }
        Err(DrawError::Failed(reason)) => {
            let _ = sqlx::query(
                "UPDATE jobs SET status = 'FAILED', error = $2, updated_at = now() \
                 WHERE id = $1 AND status = 'PROCESSING'",
            )
            .bind(&job_id)
            .bind(&reason)
            .execute(&state.pool)
            .await;
            let _ = sqlx::query(
                "UPDATE page_render_jobs SET status = 'failed' WHERE job_id = $1 AND status <> 'succeeded'",
            )
            .bind(&job_id)
            .execute(&state.pool)
            .await;
            Ok(RenderNow::Failed(reason))
        }
    }
}

/// Wait for a render a worker is drawing.
async fn wait_for(state: &AppState, job_id: &str, revision: i32) -> Result<RenderNow, String> {
    let deadline = Instant::now() + WAIT;
    loop {
        let status: Option<String> =
            sqlx::query_scalar("SELECT status FROM page_render_jobs WHERE job_id = $1")
                .bind(job_id)
                .fetch_optional(&state.pool)
                .await
                .map_err(|e| e.to_string())?;
        match status.as_deref() {
            Some("succeeded") => return Ok(RenderNow::Current { revision }),
            Some("failed") | None => return Ok(RenderNow::Failed("the render failed".into())),
            _ if Instant::now() >= deadline => {
                return Ok(RenderNow::Unavailable(
                    "a worker is still drawing this page".into(),
                ));
            }
            _ => tokio::time::sleep(Duration::from_millis(500)).await,
        }
    }
}

enum DrawError {
    Unavailable(String),
    Failed(String),
}

struct Drawn {
    artifact: Value,
    diagnostics: Value,
    layout: Value,
}

fn data_url(mime_type: &str, bytes: &[u8]) -> String {
    use base64::Engine as _;
    format!(
        "data:{mime_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// The worker's `_render_input_digest`: compact JSON with sorted keys.
fn render_input_digest(
    scene_digest: &str,
    source_sha256: &str,
    mut asset_sha256s: Vec<String>,
    safety_percent: &Value,
) -> String {
    asset_sha256s.sort();
    // Sorted keys, as Python's `sort_keys=True`. Not `json!`: this build keeps serde_json maps in
    // insertion order (`preserve_order`).
    let canonical: std::collections::BTreeMap<&str, Value> = [
        ("logicalSceneSha256", json!(scene_digest)),
        ("sourceSha256", json!(source_sha256)),
        ("assetSha256s", json!(asset_sha256s)),
        ("textBoxSafetyPercent", safety_percent.clone()),
    ]
    .into_iter()
    .collect();
    sha256_hex(
        serde_json::to_string(&canonical)
            .unwrap_or_default()
            .as_bytes(),
    )
}

async fn draw(
    state: &AppState,
    page: &Page,
    snapshot: &crate::models::PageSceneSnapshot,
    image_id: Uuid,
    identity: &CallbackIdentity,
    payload: &Value,
) -> Result<Drawn, DrawError> {
    let failed = |message: String| DrawError::Failed(message);
    let renderer_url = std::env::var("PAGE_RENDERER_URL")
        .ok()
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| DrawError::Unavailable("PAGE_RENDERER_URL is not set".into()))?;
    let document = &snapshot.scene_json;
    let source = &document["page"]["source"];

    let storage_path: Option<String> =
        sqlx::query_scalar("SELECT storage_path FROM images WHERE id = $1")
            .bind(page.image_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| failed(e.to_string()))?;
    let source_bytes = match storage_path {
        Some(path) => state.storage.download_bytes(&path).await,
        None => None,
    }
    .ok_or_else(|| failed("the page's source image is unavailable".into()))?;
    if Some(sha256_hex(&source_bytes).as_str()) != source["sha256"].as_str() {
        return Err(failed("immutable scene source digest mismatch".into()));
    }

    let asset_paths =
        crate::page_scene_builder::current_asset_paths(&state.pool, page.id, snapshot.revision)
            .await
            .map_err(failed)?;
    let assets: Vec<&Value> = document["assets"]
        .as_array()
        .map(|items| items.iter().collect())
        .unwrap_or_default();
    let asset_record = |asset_id: &str| {
        assets
            .iter()
            .find(|asset| asset["asset_id"].as_str() == Some(asset_id))
            .copied()
    };
    let mut cleanup_assets = Vec::new();
    for (index, cleanup) in document["cleanup_artifacts"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let patch_id = cleanup["patch_asset_id"].as_str().unwrap_or_default();
        let record = asset_record(patch_id)
            .ok_or_else(|| failed(format!("cleanup asset {patch_id} is not in the scene")))?;
        let path = asset_paths
            .get(patch_id)
            .ok_or_else(|| failed(format!("missing immutable cleanup asset {patch_id}")))?;
        let bytes = state
            .storage
            .download_bytes(path)
            .await
            .ok_or_else(|| failed(format!("cleanup asset {patch_id} is unavailable")))?;
        if Some(sha256_hex(&bytes).as_str()) != record["sha256"].as_str()
            || Some(bytes.len() as u64) != record["byte_length"].as_u64()
        {
            return Err(failed(format!(
                "cleanup asset {patch_id} does not match the digest recorded in the scene"
            )));
        }
        let bounds = &cleanup["bounds"];
        cleanup_assets.push(json!({
            "cleanupId": cleanup["cleanup_id"],
            "href": data_url(record["mime_type"].as_str().unwrap_or("image/png"), &bytes),
            "x": bounds["x"],
            "y": bounds["y"],
            "width": bounds["width"],
            "height": bounds["height"],
            "zIndex": index,
            "visible": true,
            "opacity": cleanup.get("opacity").cloned().unwrap_or(json!(1)),
        }));
    }

    let safety_percent = match payload.get("textBoxSafetyPercent") {
        Some(value) if value.is_number() => {
            json!(value.as_f64().unwrap_or(100.0).clamp(1.0, 100.0))
        }
        _ => json!(100),
    };
    // Keep an integral value integral, as Python's json.dumps does for the digest.
    let safety_percent = match safety_percent.as_f64() {
        Some(value) if value.fract() == 0.0 => json!(value as i64),
        _ => safety_percent,
    };
    let mut font_ids = std::collections::BTreeSet::new();
    let mut text_objects = Vec::new();
    for item in document["objects"].as_array().into_iter().flatten() {
        if item["kind"] == "manual_cleanup" {
            continue;
        }
        let style = &item["style"];
        if let Some(font) = style["font_id"].as_str() {
            font_ids.insert(font.to_string());
        }
        let transform = &item["transform"];
        text_objects.push(json!({
            "objectId": item["object_id"],
            "text": item["text"],
            "transform": {
                "x": transform["x"],
                "y": transform["y"],
                "width": transform["width"],
                "height": transform["height"],
                "rotationDegrees": transform["rotation_degrees"],
            },
            "writingMode": item["writing_mode"],
            "alignment": item["alignment"],
            "style": {
                "fontFamily": style["font_id"],
                "fill": style["fill"],
                "stroke": style["stroke"],
                "weight": style["weight"],
                "padding": style["padding"],
                "safetyPercent": safety_percent,
            },
            "visible": item["visible"],
            "zIndex": item["z_index"],
        }));
    }
    let asset_sha256s = assets
        .iter()
        .filter_map(|asset| asset["sha256"].as_str().map(str::to_string))
        .collect();
    let request = json!({
        "contractVersion": "page-scene/v1",
        "pageRevision": snapshot.revision,
        "logicalSceneSha256": snapshot.logical_scene_sha256,
        "renderInputSha256": render_input_digest(
            &snapshot.logical_scene_sha256,
            source["sha256"].as_str().unwrap_or_default(),
            asset_sha256s,
            &safety_percent,
        ),
        "requiredFontIds": font_ids.into_iter().collect::<Vec<_>>(),
        "scene": {
            "source": {
                "href": data_url(source["mime_type"].as_str().unwrap_or("image/png"), &source_bytes),
                "width": source["width"],
                "height": source["height"],
            },
            "cleanupAssets": cleanup_assets,
            "textObjects": text_objects,
        },
    });

    let rendered = post_render(&renderer_url, &request).await?;
    if rendered["logicalSceneSha256"].as_str() != Some(snapshot.logical_scene_sha256.as_str())
        || rendered["pageRevision"].as_i64() != Some(i64::from(snapshot.revision))
    {
        return Err(failed(
            "renderer returned a mismatched immutable identity".into(),
        ));
    }
    let png = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(rendered["pngBase64"].as_str().unwrap_or_default())
            .map_err(|e| failed(format!("renderer PNG is not base64: {e}")))?
    };
    let png_sha256 = sha256_hex(&png);
    if rendered["pngSha256"].as_str() != Some(png_sha256.as_str()) {
        return Err(failed("renderer PNG digest mismatch".into()));
    }
    // Where the worker puts an attempt's PNG; the render callback reads it back from here.
    let storage_path = format!(
        "rendered/{image_id}/jobs/{}/attempts/{}/{png_sha256}.png",
        identity.job_id, identity.attempt
    );
    let byte_length = png.len();
    state
        .storage
        .upload_bytes(&storage_path, png, "image/png")
        .await
        .map_err(|e| DrawError::Unavailable(format!("could not store the render: {e}")))?;
    Ok(Drawn {
        artifact: json!({
            "storagePath": storage_path,
            "sha256": png_sha256,
            "byteLength": byte_length,
            "contentType": "image/png",
        }),
        diagnostics: rendered
            .get("diagnostics")
            .filter(|d| d.is_array())
            .cloned()
            .unwrap_or_else(|| json!([])),
        layout: rendered
            .get("layout")
            .filter(|l| l.is_array())
            .cloned()
            .unwrap_or_else(|| json!([])),
    })
}

/// POST the scene, waiting out "busy" (503) answers for up to [`WAIT`].
async fn post_render(renderer_url: &str, request: &Value) -> Result<Value, DrawError> {
    let client = reqwest::Client::new();
    let url = format!("{}/render", renderer_url.trim_end_matches('/'));
    let deadline = Instant::now() + WAIT;
    let mut delay = Duration::from_millis(500);
    loop {
        let response = client
            .post(&url)
            .json(request)
            .timeout(Duration::from_secs(180))
            .send()
            .await
            .map_err(|e| {
                DrawError::Unavailable(format!(
                    "page renderer at {renderer_url} is unreachable: {e}"
                ))
            })?;
        let status = response.status();
        if status.as_u16() == 503 {
            if Instant::now() + delay > deadline {
                return Err(DrawError::Unavailable(
                    "the page renderer stayed busy".into(),
                ));
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(5));
            continue;
        }
        let body: Value = response.json().await.map_err(|e| {
            DrawError::Failed(format!("page renderer answered {status} with no JSON: {e}"))
        })?;
        if !status.is_success() {
            return Err(DrawError::Failed(format!(
                "page renderer rejected the scene ({status}): {}",
                body["error"].as_str().unwrap_or_default()
            )));
        }
        return Ok(body);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same canonical form as the worker's `_render_input_digest` (sorted keys, no spaces).
    #[test]
    fn render_input_digest_matches_the_workers_canonical_json() {
        let canonical = r#"{"assetSha256s":["a","b"],"logicalSceneSha256":"s","sourceSha256":"src","textBoxSafetyPercent":100}"#;
        assert_eq!(
            render_input_digest("s", "src", vec!["b".into(), "a".into()], &json!(100)),
            sha256_hex(canonical.as_bytes())
        );
    }
}
