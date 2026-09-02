//! `/api/settings` — port of SettingsController + the cache-independent part of
//! SystemSettingsService.getSettings(). Provider lists/map are EMPTY until the worker
//! publishes its catalog (Java's ProviderConfigCache behaves identically pre-publish).
//! validateOverrides is permissive with an empty cache -> always {"orphaned":[]}.

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::settings::{PipelineDefaults, load_global_settings, save_setting, setting_value};
use crate::state::AppState;

#[derive(Serialize, Deserialize)]
#[allow(non_snake_case)]
pub struct SystemSettingsDto {
    pub ocrVlmModelList: Vec<String>,
    pub tlLlmModelList: Vec<String>,
    pub qaLlmModelList: Vec<String>,
    pub qaVlmModelList: Vec<String>,
    pub routingStrategy: String,
    pub ocrProvider: String,
    pub ocrModel: String,
    pub tlProvider: String,
    pub tlModel: String,
    pub qaProvider: String,
    pub qaLlmModel: String,
    pub qaVlmModel: String,
    pub disableLocalOcr: bool,
    pub localOcrModel: String,
    pub disableLocalLlm: bool,
    pub qaMode: String,
    pub useFallbackModels: bool,
    pub activeProviders: Vec<String>,
    pub activeOcrProviders: Vec<String>,
    pub providerModelsMap: serde_json::Value,
    /// AUDIT-R1/F16: the inset applied to an element's box before text is fitted into it.
    /// Lives here rather than as a literal in each renderer, because there used to be three
    /// different answers in the frontend alone and a fourth in `render.py`.
    ///
    /// `serde(default)` because this struct is both the GET response and the PUT body: a client
    /// that predates these fields — including a browser holding an older bundle — must still be
    /// able to save its settings rather than getting a 400 for omitting a field it has never
    /// heard of. Serialization always emits a number, so the GET side is unaffected.
    #[serde(default = "default_text_box_padding_px")]
    pub textBoxPaddingPx: i32,
    /// Percent of what remains after the padding that text may use; 95 leaves a 5% safety
    /// margin so glyphs do not touch the balloon outline.
    #[serde(default = "default_text_box_safety_percent")]
    pub textBoxSafetyPercent: i32,
}

async fn build_dto(state: &AppState) -> SystemSettingsDto {
    let defaults = PipelineDefaults::from_env();
    let global = load_global_settings(&state.pool, &defaults).await;
    let disable_local_ocr = std::env::var("DISABLE_LOCAL_OCR")
        .map(|v| v == "true")
        .unwrap_or(false);
    let disable_local_llm = std::env::var("DISABLE_LOCAL_LLM")
        .map(|v| v == "true")
        .unwrap_or(false);

    // Provider catalog from the worker-published cache. activeProviders = providers
    // offering "tl"; OCR providers start with "local" (unless disabled), then every
    // published ocr provider except local, deduplicated.
    let active_providers = state.providers.get_providers_for_task("tl");
    let mut active_ocr_providers: Vec<String> = Vec::new();
    if !disable_local_ocr {
        active_ocr_providers.push("local".into());
    }
    for provider in state.providers.get_providers_for_task("ocr") {
        if provider != "local" && !active_ocr_providers.contains(&provider) {
            active_ocr_providers.push(provider);
        }
    }

    // Which local pair the UI shows as selected: worker-published default first,
    // PADDLEOCR_REC_MODEL env fallback second.
    let local_ocr_model = state
        .providers
        .get_default_model("local", "ocr")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(global.local_ocr_model);

    SystemSettingsDto {
        ocrVlmModelList: defaults.ocr_model_list.clone(),
        tlLlmModelList: defaults.tl_model_list.clone(),
        qaLlmModelList: defaults.qa_llm_model_list.clone(),
        qaVlmModelList: defaults.qa_vlm_model_list.clone(),
        routingStrategy: setting_value(&state.pool, "routingStrategy", "lowest-cost").await,
        ocrProvider: global.ocr_provider,
        ocrModel: global.ocr_model,
        tlProvider: global.tl_provider,
        tlModel: global.tl_model,
        qaProvider: global.qa_provider,
        qaLlmModel: global.qa_llm_model,
        qaVlmModel: global.qa_vlm_model,
        disableLocalOcr: disable_local_ocr,
        localOcrModel: local_ocr_model,
        disableLocalLlm: disable_local_llm,
        qaMode: global.qa_mode,
        useFallbackModels: global.use_fallback_models,
        activeProviders: active_providers,
        activeOcrProviders: active_ocr_providers,
        providerModelsMap: state.providers.get_provider_models_map(),
        textBoxPaddingPx: clamped_setting(&state.pool, "textBoxPaddingPx", 4, 0, 64).await,
        textBoxSafetyPercent: clamped_setting(&state.pool, "textBoxSafetyPercent", 95, 1, 100)
            .await,
    }
}

fn default_text_box_padding_px() -> i32 {
    4
}

fn default_text_box_safety_percent() -> i32 {
    95
}

/// An integer setting, defaulted and clamped.
///
/// The clamps are not decoration: a safety percent of 0 fits every element into a zero-width box
/// and a padding wider than the box does the same, so a typo in the settings form would silently
/// stop the whole library typesetting.
async fn clamped_setting(pool: &sqlx::PgPool, key: &str, default: i32, low: i32, high: i32) -> i32 {
    setting_value(pool, key, &default.to_string())
        .await
        .parse::<i32>()
        .unwrap_or(default)
        .clamp(low, high)
}

/// GET /api/settings
pub async fn get_settings(State(state): State<AppState>, _user: AuthUser) -> Response {
    Json(build_dto(&state).await).into_response()
}

/// PUT /api/settings — saves every non-null field, returns the refreshed view.
pub async fn update_settings(
    State(state): State<AppState>,
    _user: AuthUser,
    body: Result<Json<SystemSettingsDto>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(dto)) = body else {
        return crate::error::unreadable_body("/api/settings");
    };

    save_setting(&state.pool, "ocrProvider", &dto.ocrProvider).await;
    save_setting(&state.pool, "ocrModel", &dto.ocrModel).await;
    save_setting(&state.pool, "tlProvider", &dto.tlProvider).await;
    save_setting(&state.pool, "tlModel", &dto.tlModel).await;
    save_setting(&state.pool, "qaProvider", &dto.qaProvider).await;
    save_setting(&state.pool, "qaLlmModel", &dto.qaLlmModel).await;
    save_setting(&state.pool, "qaVlmModel", &dto.qaVlmModel).await;
    save_setting(&state.pool, "qaMode", &dto.qaMode).await;
    save_setting(&state.pool, "routingStrategy", &dto.routingStrategy).await;
    // useFallbackModels is Boolean in Java; null skips the write.
    save_setting(
        &state.pool,
        "useFallbackModels",
        &dto.useFallbackModels.to_string(),
    )
    .await;

    save_setting(
        &state.pool,
        "textBoxPaddingPx",
        &dto.textBoxPaddingPx.clamp(0, 64).to_string(),
    )
    .await;
    save_setting(
        &state.pool,
        "textBoxSafetyPercent",
        &dto.textBoxSafetyPercent.clamp(1, 100).to_string(),
    )
    .await;

    Json(build_dto(&state).await).into_response()
}

/// GET /api/settings/validate — every chapter/series model override is checked against
/// the provider catalog; overrides the provider no longer serves are reported DEPRECATED.
pub async fn validate_settings(State(state): State<AppState>, _user: AuthUser) -> Response {
    #[derive(sqlx::FromRow)]
    struct OverrideRow {
        entity_id: Uuid,
        title: Option<String>,
        chapter_number: Option<f64>,
        ocr_model: Option<String>,
        ocr_provider: Option<String>,
        tl_model: Option<String>,
        tl_provider: Option<String>,
        qa_llm_model: Option<String>,
        qa_provider: Option<String>,
        qa_vlm_model: Option<String>,
    }

    let mut orphaned: Vec<serde_json::Value> = Vec::new();

    // Java's fallback when an override has no provider of its own: the GLOBAL TL provider.
    let global_tl_provider = setting_value(&state.pool, "tlProvider", "openrouter").await;

    let mut check_row = |row: &OverrideRow, entity_type: &str, entity_name: String| {
        let slots = [
            (
                "tlModel",
                row.tl_model.as_deref(),
                row.tl_provider.as_deref(),
                "tl",
            ),
            (
                "ocrModel",
                row.ocr_model.as_deref(),
                row.ocr_provider.as_deref(),
                "ocr",
            ),
            (
                "qaLlmModel",
                row.qa_llm_model.as_deref(),
                row.qa_provider.as_deref(),
                "qaLLM",
            ),
            (
                "qaVlmModel",
                row.qa_vlm_model.as_deref(),
                row.qa_provider.as_deref(),
                "qaVLM",
            ),
        ];
        for (field, model, provider, task) in slots {
            let Some(model_val) = model
                .map(str::trim)
                .filter(|m| !m.is_empty() && *m != "inherit" && *m != "default")
            else {
                continue;
            };
            let prov = provider
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .unwrap_or(&global_tl_provider);
            if !state
                .providers
                .is_valid_provider_model(prov, model_val, task)
            {
                orphaned.push(json!({
                    "entityType": entity_type,
                    "entityId": row.entity_id.to_string(),
                    "entityName": entity_name.clone(),
                    "field": field,
                    "value": model_val,
                    "status": "DEPRECATED",
                }));
            }
        }
    };

    let series_rows: Vec<OverrideRow> = sqlx::query_as(
        "SELECT id AS entity_id, title, NULL AS chapter_number, ocr_model, ocr_provider, \
         tl_model, tl_provider, qa_llm_model, qa_provider, qa_vlm_model FROM series",
    )
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    for row in &series_rows {
        let name = row.title.clone().unwrap_or_default();
        check_row(row, "SERIES", name);
    }

    let chapter_rows: Vec<OverrideRow> = sqlx::query_as(
        "SELECT id AS entity_id, title, chapter_number, ocr_model, ocr_provider, \
         tl_model, tl_provider, qa_llm_model, qa_provider, qa_vlm_model FROM chapters",
    )
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    for row in &chapter_rows {
        let name = row
            .title
            .clone()
            .unwrap_or_else(|| format!("Chapter {}", row.chapter_number.unwrap_or(0.0)));
        check_row(row, "CHAPTER", name);
    }

    Json(json!({ "orphaned": orphaned })).into_response()
}

/// Sub-router mounted under `/api/settings`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(get_settings).put(update_settings))
        .route("/validate", get(validate_settings))
}
