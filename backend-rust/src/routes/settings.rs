//! `/api/settings` — port of SettingsController + the cache-independent part of
//! SystemSettingsService.getSettings(). Provider lists/map are EMPTY until the worker
//! publishes its catalog (Java's ProviderConfigCache behaves identically pre-publish).
//! validateOverrides is permissive with an empty cache -> always {"orphaned":[]}.

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

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

    // activeProviders/activeOcrProviders come from the provider cache (Phase 3). Java
    // seeds "local" into OCR providers unless disabled; mirror that much.
    let mut active_ocr_providers: Vec<String> = Vec::new();
    if !disable_local_ocr {
        active_ocr_providers.push("local".into());
    }

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
        localOcrModel: global.local_ocr_model,
        disableLocalLlm: disable_local_llm,
        qaMode: global.qa_mode,
        useFallbackModels: global.use_fallback_models,
        activeProviders: Vec::new(), // Phase 3: worker-published catalog
        activeOcrProviders: active_ocr_providers, // Phase 3 adds published providers
        providerModelsMap: serde_json::json!({}),
    }
}

/// GET /api/settings
pub async fn get_settings(State(state): State<AppState>) -> Response {
    Json(build_dto(&state).await).into_response()
}

/// PUT /api/settings — saves every non-null field, returns the refreshed view.
pub async fn update_settings(
    State(state): State<AppState>,
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

    Json(build_dto(&state).await).into_response()
}

/// GET /api/settings/validate — {"orphaned": []} while no provider catalog is loaded.
pub async fn validate_settings(State(state): State<AppState>) -> Response {
    let _ = state;
    Json(serde_json::json!({ "orphaned": [] })).into_response()
}

/// Sub-router mounted under `/api/settings`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(get_settings).put(update_settings))
        .route("/validate", get(validate_settings))
}
