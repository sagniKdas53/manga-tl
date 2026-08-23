//! ChapterExportService port: builds a chapter ZIP (rendered-or-original pages +
//! meta-data.json), caches it in MinIO under a deterministic content-hash id, notifies
//! the requesting user over SSE, plus the scheduled cleanups.
//!
//! The export id is `{chapterId}_{sha256(canonical metadata)}`: identical chapter
//! content maps to the same object key, so a rebuild is a cache hit unless `force`.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::models::{Chapter, Image, JobCost, Layer, LayerElement, Page};
use crate::state::AppState;

/// Port of ChapterExportService.buildAndUploadExport — runs as a background task after
/// POST .../export returns 202. All failures notify instead of erroring anywhere.
pub async fn build_and_upload_export(
    state: AppState,
    chapter_id: Uuid,
    user_id: Option<Uuid>,
    force: bool,
) {
    if let Err(notify) = try_build(&state, chapter_id, user_id, force).await {
        tracing::error!(
            "Failed to build export for chapter {chapter_id}: {}",
            notify.message
        );
        if let Some(user_id) = user_id {
            state
                .sse
                .emit_notification_to_user(
                    user_id,
                    "EXPORT_ERROR",
                    "Export Failed",
                    &notify.message,
                )
                .await;
        }
    }
}

struct ExportFailure {
    message: String,
}

async fn try_build(
    state: &AppState,
    chapter_id: Uuid,
    user_id: Option<Uuid>,
    force: bool,
) -> Result<(), ExportFailure> {
    let db_err = |e: sqlx::Error| ExportFailure {
        message: format!("database error: {e}"),
    };

    let chapter: Chapter = sqlx::query_as("SELECT * FROM chapters WHERE id = $1")
        .bind(chapter_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(db_err)?
        .ok_or_else(|| ExportFailure {
            message: format!("Chapter not found: {chapter_id}"),
        })?;

    let pages: Vec<Page> =
        sqlx::query_as("SELECT * FROM pages WHERE chapter_id = $1 ORDER BY page_number ASC")
            .bind(chapter_id)
            .fetch_all(&state.pool)
            .await
            .map_err(db_err)?;
    if pages.is_empty() {
        return Err(ExportFailure {
            message: "No pages in chapter".into(),
        });
    }

    // ---- canonical metadata (hashed BEFORE exportTimestamp is added) ----
    let chapter_meta = build_chapter_meta(state, &chapter, &pages).await?;

    let hash = {
        let canonical = serde_json::to_vec(&chapter_meta).unwrap_or_default();
        let digest = Sha256::digest(&canonical);
        hex::encode(digest)
    };
    let hash_export_id = format!("{chapter_id}_{hash}");

    let series_title =
        match sqlx::query_scalar::<_, String>("SELECT title FROM series WHERE id = $1")
            .bind(chapter.series_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
        {
            Some(title) => title,
            None => "Unknown Series".to_string(),
        };
    let ctx = json!({
        "exportId": hash_export_id,
        "seriesTitle": series_title,
        "chapterNumber": chapter.chapter_number.to_string(),
        "chapterTitle": chapter.title,
    })
    .as_object()
    .cloned()
    .map(Value::Object)
    .unwrap_or_default();

    let cache_key = format!("exports/{hash_export_id}.zip");
    if !force && state.storage.file_exists(&cache_key).await {
        tracing::info!("Cache hit for export ZIP: {hash_export_id}");
        if let Some(user_id) = user_id {
            state
                .sse
                .emit_notification_to_user_with_context(
                    user_id,
                    "EXPORT_SUCCESS",
                    "Export Ready",
                    "Your chapter export is ready for download.",
                    None,
                    Some(&string_map_of(&ctx)),
                )
                .await;
        }
        return Ok(());
    }

    // ---- build the archive ----
    let timestamped_meta = {
        let mut meta = chapter_meta.clone();
        meta["exportTimestamp"] = json!(chrono::Utc::now().to_rfc3339());
        serde_json::to_vec_pretty(&meta).unwrap_or_default()
    };

    let mut zip_buf = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut zip_buf);
        let options: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        for page in &pages {
            let image: Image = sqlx::query_as("SELECT * FROM images WHERE id = $1")
                .bind(page.image_id)
                .fetch_one(&state.pool)
                .await
                .map_err(|e| ExportFailure {
                    message: format!("image lookup failed: {e}"),
                })?;
            let filename = if image.filename.trim().is_empty() {
                format!("page_{}.png", page.page_number)
            } else {
                image.filename.clone()
            };

            // Prefer the rendered variant; fall back to the original upload.
            let bytes = match state
                .storage
                .download_bytes(&format!("rendered/{}.png", image.id))
                .await
            {
                Some(bytes) => Some(bytes),
                None => state.storage.download_bytes(&image.storage_path).await,
            };
            let Some(bytes) = bytes else {
                tracing::error!(
                    "Failed to download original/rendered image for page {}",
                    page.id
                );
                continue;
            };

            let ext = filename.rsplit('.').next().unwrap_or("png").to_string();
            let entry_name = format!("{:03}.{}", page.page_number, ext);
            writer
                .start_file(entry_name, options)
                .map_err(|e| ExportFailure {
                    message: format!("zip write failed: {e}"),
                })?;
            std::io::Write::write_all(&mut writer, &bytes).map_err(|e| ExportFailure {
                message: format!("zip write failed: {e}"),
            })?;
        }

        writer
            .start_file("meta-data.json", options)
            .map_err(|e| ExportFailure {
                message: format!("zip write failed: {e}"),
            })?;
        std::io::Write::write_all(&mut writer, &timestamped_meta).map_err(|e| ExportFailure {
            message: format!("zip write failed: {e}"),
        })?;
        writer.finish().map_err(|e| ExportFailure {
            message: format!("zip finish failed: {e}"),
        })?;
    }

    state
        .storage
        .upload_bytes(&cache_key, zip_buf.into_inner(), "application/zip")
        .await
        .map_err(|e| ExportFailure {
            message: format!("upload failed: {e}"),
        })?;

    if let Some(user_id) = user_id {
        state
            .sse
            .emit_notification_to_user_with_context(
                user_id,
                "EXPORT_SUCCESS",
                "Export Ready",
                "Your chapter export is ready for download.",
                None,
                Some(&string_map_of(&ctx)),
            )
            .await;
    }
    Ok(())
}

/// The full per-chapter metadata document (pages, layers, costs, manual flags).
async fn build_chapter_meta(
    state: &AppState,
    chapter: &Chapter,
    pages: &[Page],
) -> Result<Value, ExportFailure> {
    let mut page_metadata_list: Vec<Value> = Vec::with_capacity(pages.len());
    let mut chapter_total_cost = 0.0f64;
    let mut chapter_has_cost = false;

    for page in pages {
        let image: Image = sqlx::query_as("SELECT * FROM images WHERE id = $1")
            .bind(page.image_id)
            .fetch_one(&state.pool)
            .await
            .map_err(|e| ExportFailure {
                message: format!("image lookup failed: {e}"),
            })?;
        let filename = if image.filename.trim().is_empty() {
            format!("page_{}.png", page.page_number)
        } else {
            image.filename.clone()
        };

        let has_rendered = state
            .storage
            .file_exists(&format!("rendered/{}.png", page.id))
            .await
            || state
                .storage
                .file_exists(&format!("rendered/{}.png", image.id))
                .await;

        let layers: Vec<Layer> =
            sqlx::query_as("SELECT * FROM layers WHERE page_id = $1 ORDER BY z_order ASC")
                .bind(page.id)
                .fetch_all(&state.pool)
                .await
                .map_err(|e| ExportFailure {
                    message: format!("layer query failed: {e}"),
                })?;

        let mut models_used: HashMap<String, HashSet<String>> = HashMap::new();
        for key in ["ocr", "translation", "qa"] {
            models_used.insert(key.to_string(), HashSet::new());
        }

        let mut layers_meta_list: Vec<Value> = Vec::with_capacity(layers.len());
        let mut page_total_cost = 0.0f64;
        let mut page_has_cost = false;

        for layer in &layers {
            let mut layer_meta = json!({
                "id": layer.id.to_string(),
                "type": layer.layer_type,
                "visible": layer.visible.unwrap_or(true),
            });
            if let Some(lang) = &layer.target_language {
                layer_meta["targetLanguage"] = json!(lang);
            }
            if let Some(meta) = &layer.metadata_json {
                layer_meta["metadataJson"] = meta.clone();
            }

            let elements: Vec<LayerElement> =
                sqlx::query_as("SELECT * FROM layer_elements WHERE layer_id = $1")
                    .bind(layer.id)
                    .fetch_all(&state.pool)
                    .await
                    .map_err(|e| ExportFailure {
                        message: format!("element query failed: {e}"),
                    })?;
            layer_meta["elements"] = serde_json::to_value(&elements).unwrap_or_default();

            if let Some(meta) = layer.metadata_json.as_ref().and_then(Value::as_object) {
                if let Some(model) = meta.get("model").and_then(Value::as_str) {
                    layer_meta["model"] = json!(model);
                    models_used
                        .entry(layer.layer_type.to_lowercase())
                        .or_default()
                        .insert(model.to_string());
                }

                let mut accumulated = 0.0f64;
                let mut cost_found = false;
                let mut absorb = |cost_node: &Value, target: &mut HashSet<String>| {
                    let Some(obj) = cost_node.as_object() else {
                        return;
                    };
                    if let Some(cost) = obj.get("estimated_cost").and_then(Value::as_f64) {
                        cost_found = true;
                        accumulated += cost;
                    }
                    if let Some(breakdown) = obj.get("breakdown").and_then(Value::as_array) {
                        for item in breakdown {
                            if let Some(m) = item.get("model").and_then(Value::as_str) {
                                target.insert(m.to_string());
                            }
                            if let Some(m) = item.get("model_identifier").and_then(Value::as_str) {
                                target.insert(m.to_string());
                            }
                        }
                    }
                };

                if let Some(cost) = meta.get("cost") {
                    absorb(
                        cost,
                        models_used
                            .entry(layer.layer_type.to_lowercase())
                            .or_default(),
                    );
                }
                if let Some(qa_cost) = meta
                    .get("qa")
                    .and_then(|qa| qa.get("cost"))
                    .filter(|c| !c.is_null())
                {
                    absorb(qa_cost, models_used.entry("qa".into()).or_default());
                }
                if let Some(tl_cost) = meta
                    .get("tl")
                    .and_then(|tl| tl.get("cost"))
                    .filter(|c| !c.is_null())
                {
                    absorb(
                        tl_cost,
                        models_used.entry("translation".into()).or_default(),
                    );
                }

                if cost_found {
                    layer_meta["estimated_cost"] = json!(accumulated);
                    page_total_cost += accumulated;
                    page_has_cost = true;
                }
            }

            layers_meta_list.push(layer_meta);
        }

        // Database-recorded costs win over layer-metadata-derived ones.
        let db_costs: Vec<JobCost> = sqlx::query_as("SELECT * FROM job_costs WHERE image_id = $1")
            .bind(image.id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();
        let (total, source): (f64, &str) = if !db_costs.is_empty() {
            (
                db_costs.iter().filter_map(|c| c.estimated_cost).sum(),
                "database",
            )
        } else {
            (page_total_cost, "layer-metadata")
        };
        if !db_costs.is_empty() {
            let recorded: HashSet<String> =
                db_costs.iter().filter_map(|c| c.model.clone()).collect();
            models_used.insert("recorded".into(), recorded);
        }

        let display = format_cost(total);
        let mut page_meta = json!({
            "pageNumber": page.page_number,
            "imageId": image.id.to_string(),
            "originalFilename": filename,
            "hasRendered": has_rendered,
            "layerCount": layers.len(),
            "layers": layers_meta_list,
            "modelsUsed": models_used.iter().map(|(k, v)| (k.clone(), json!(v))).collect::<HashMap<String, Value>>(),
            "totalCost": { "estimated_cost": total, "display": display, "currency": "USD" },
        });
        page_meta["costSource"] = json!(source);
        if page_has_cost {
            chapter_total_cost += total;
            chapter_has_cost = true;
        }

        // Active visible translation layer drives the manual flags.
        let active_layer = layers.iter().find(|l| {
            l.layer_type.eq_ignore_ascii_case("translation") && l.visible.unwrap_or(false)
        });
        match active_layer {
            Some(active) => {
                page_meta["activeLayer"] = json!({
                    "id": active.id.to_string(),
                    "type": active.layer_type,
                    "language": active.target_language,
                });
                let manual_qa_needed = active
                    .metadata_json
                    .as_ref()
                    .and_then(|m| m.get("qa"))
                    .and_then(|qa| qa.get("status"))
                    .and_then(Value::as_str)
                    .map(|s| s.eq_ignore_ascii_case("manual_review"))
                    .unwrap_or(false);
                page_meta["manualQaNeeded"] = json!(manual_qa_needed);

                let manual_changes_done: bool = sqlx::query_scalar(
                    "SELECT COUNT(*) > 0 FROM layer_elements \
                     WHERE is_manually_edited = TRUE AND layer_id IN (SELECT id FROM layers WHERE page_id = $1)",
                )
                .bind(page.id)
                .fetch_one(&state.pool)
                .await
                .unwrap_or(false);
                let needs_re_render = manual_changes_done
                    && page
                        .last_edited_at
                        .zip(page.last_rendered_at)
                        .map(|(edited, rendered)| edited > rendered)
                        .unwrap_or(false);
                page_meta["manualChangesDone"] = json!(manual_changes_done);
                page_meta["needsReRender"] = json!(needs_re_render);
            }
            None => {
                page_meta["manualChangesDone"] = json!(false);
                page_meta["needsReRender"] = json!(false);
                page_meta["manualQaNeeded"] = json!(false);
            }
        }

        page_metadata_list.push(page_meta);
    }

    // Chapter-level header.
    let series: Option<crate::models::Series> =
        sqlx::query_as("SELECT * FROM series WHERE id = $1")
            .bind(chapter.series_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();

    let mut chapter_meta = serde_json::Map::new();
    chapter_meta.insert("totalPages".into(), json!(pages.len()));
    chapter_meta.insert("chapterNumber".into(), json!(chapter.chapter_number));
    chapter_meta.insert("chapterTitle".into(), json!(chapter.title));
    if let Some(series) = &series {
        chapter_meta.insert("seriesTitle".into(), json!(series.title));
        let routing = chapter
            .routing_strategy
            .clone()
            .filter(|r| !r.is_empty())
            .or_else(|| series.routing_strategy.clone());
        if let Some(routing) = routing.filter(|r| !r.is_empty()) {
            chapter_meta.insert("routingStrategy".into(), json!(routing));
        }
        let fallback = chapter.use_fallback_models.or(series.use_fallback_models);
        chapter_meta.insert(
            "useFallbackModels".into(),
            json!(!matches!(fallback, Some(false))),
        );
    }
    if chapter_has_cost {
        chapter_meta.insert(
            "totalCost".into(),
            json!({
                "estimated_cost": chapter_total_cost,
                "display": format_cost(chapter_total_cost),
                "currency": "USD",
            }),
        );
    }
    chapter_meta.insert("pages".into(), Value::Array(page_metadata_list));

    Ok(Value::Object(chapter_meta))
}

fn string_map_of(value: &Value) -> HashMap<String, String> {
    value
        .as_object()
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn format_cost(cost: f64) -> String {
    if cost < 0.0001 && cost > 0.0 {
        return "< $0.0001".to_string();
    }
    format!("${cost:.4}")
}

/// DELETE .../exports backend: remove every cached export for this chapter.
pub async fn clear_chapter_exports(state: &AppState, chapter_id: Uuid) {
    if let Err(err) = state
        .storage
        .delete_by_prefix(&format!("exports/{chapter_id}_"))
        .await
    {
        tracing::error!("Failed to clear chapter exports: {err}");
    }
}

/// ChapterExportService.cleanupStaleExports — daily sweep of exports older than 7 days.
pub async fn cleanup_stale_exports(state: &AppState) {
    tracing::info!("Running scheduled cleanup for stale exports in MinIO...");
    const RETENTION_DAYS: chrono::Duration = chrono::Duration::days(7);
    if let Err(err) = state
        .storage
        .delete_older_than("exports/", RETENTION_DAYS)
        .await
    {
        tracing::error!("Failed to cleanup stale exports: {err}");
    }
}

/// ExportCleanupService.cleanupOldExports — daily cron (02:00) with a configurable
/// retention window (`app.export.retention.days`, default 7). We run it on the same
/// daily loop; the two Java jobs were near-duplicates.
pub async fn cleanup_old_exports(state: &AppState) {
    let retention_days: u64 = std::env::var("APP_EXPORT_RETENTION_DAYS")
        .or_else(|_| std::env::var("app.export.retention.days"))
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(7);
    tracing::info!("Starting scheduled cleanup of old chapter exports in MinIO...");
    if let Err(err) = state
        .storage
        .delete_older_than("exports/", chrono::Duration::days(retention_days as i64))
        .await
    {
        tracing::error!("Failed to clean up old exports in MinIO: {err}");
    }
}
