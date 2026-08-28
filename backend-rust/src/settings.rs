//! Global pipeline settings — the slice of `SystemSettingsService` the series/chapters
//! endpoints need: key/value lookups against `system_settings` plus the env-provided
//! defaults (`@Value("${OCR_MODEL_PROVIDER:openrouter}")` etc.).
//!
//! NOT here (deliberately): the full getSettings() DTO and validateOverrides() depend on
//! ProviderConfigCache (providers.json + worker-published Redis config); they land with
//! the SettingsController slice.
//!
//! Effective-model rule mirrored from getSettings(): when the env default model is empty,
//! the first entry of its model LIST becomes the effective default.

use sqlx::PgPool;

/// Env-derived defaults, captured once at startup like Spring's @Value injection.
#[derive(Debug, Clone)]
pub struct PipelineDefaults {
    pub ocr_provider: String,
    pub ocr_model: String,
    pub ocr_model_list: Vec<String>,
    pub tl_provider: String,
    pub tl_model: String,
    pub tl_model_list: Vec<String>,
    pub qa_provider: String,
    pub qa_llm_model: String,
    pub qa_llm_model_list: Vec<String>,
    pub qa_vlm_model: String,
    pub qa_vlm_model_list: Vec<String>,
    /// PADDLEOCR_REC_MODEL fallback for the local OCR pair display value.
    pub paddle_rec_model: String,
}

impl PipelineDefaults {
    pub fn from_env() -> Self {
        Self {
            ocr_provider: std::env::var("OCR_MODEL_PROVIDER").unwrap_or_default(),
            ocr_model: std::env::var("OCR_VLM_MODEL").unwrap_or_default(),
            ocr_model_list: parse_list(&std::env::var("OCR_VLM_MODEL_LIST").unwrap_or_default()),
            tl_provider: std::env::var("TL_MODEL_PROVIDER").unwrap_or_default(),
            tl_model: std::env::var("TL_LLM_MODEL").unwrap_or_default(),
            tl_model_list: parse_list(&std::env::var("TL_LLM_MODEL_LIST").unwrap_or_default()),
            qa_provider: std::env::var("QA_MODEL_PROVIDER").unwrap_or_default(),
            qa_llm_model: std::env::var("QA_LLM_MODEL").unwrap_or_default(),
            qa_llm_model_list: parse_list(&std::env::var("QA_LLM_MODEL_LIST").unwrap_or_default()),
            qa_vlm_model: std::env::var("QA_VLM_MODEL").unwrap_or_default(),
            qa_vlm_model_list: parse_list(&std::env::var("QA_VLM_MODEL_LIST").unwrap_or_default()),
            paddle_rec_model: std::env::var("PADDLEOCR_REC_MODEL")
                .unwrap_or_else(|_| "PP-OCRv6_medium_rec".into()),
        }
    }
}

fn parse_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

fn or_default(value: String, default: &str) -> String {
    if value.is_empty() {
        default.to_string()
    } else {
        value
    }
}

fn effective(default_model: &str, list: &[String]) -> String {
    if !default_model.is_empty() {
        default_model.to_string()
    } else {
        list.first().cloned().unwrap_or_default()
    }
}

/// The global settings values ChapterDto resolution needs. Field names mirror the
/// SystemSettingsDto accessors used inside SeriesController.
#[derive(Debug, Clone)]
pub struct GlobalSettings {
    pub ocr_provider: String,
    pub ocr_model: String,
    pub tl_provider: String,
    pub tl_model: String,
    pub qa_provider: String,
    pub qa_llm_model: String,
    pub qa_vlm_model: String,
    pub qa_mode: String,
    /// Global routing strategy (system_settings row; env has no default for it).
    pub routing_strategy: String,
    pub use_fallback_models: bool,
    /// ProviderConfigCache.getDefaultModel("local","ocr") once Phase 3 lands; until then
    /// only the PADDLEOCR_REC_MODEL fallback path exists (documented deviation).
    pub local_ocr_model: String,
}

pub async fn setting_value(pool: &PgPool, key: &str, default: &str) -> String {
    sqlx::query_scalar::<_, String>(
        "SELECT setting_value FROM system_settings WHERE setting_key = $1",
    )
    .bind(key)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .unwrap_or_else(|| default.to_string())
}

/// Upsert mirroring saveSetting(): nulls are skipped by CALLERS (Java checks before calling).
pub async fn save_setting(pool: &PgPool, key: &str, value: &str) {
    sqlx::query(
        "INSERT INTO system_settings (setting_key, setting_value, updated_at) \
         VALUES ($1, $2, now()) \
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = now()",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await
    .expect("settings upsert");
}

pub async fn load_global_settings(pool: &PgPool, defaults: &PipelineDefaults) -> GlobalSettings {
    // Compose ships these two env vars with real values; application.yml defaults are
    // openrouter/auto. Empty env falls back to those same constants.
    let ocr_provider = or_default(defaults.ocr_provider.clone(), "openrouter");
    let tl_provider = or_default(defaults.tl_provider.clone(), "openrouter");
    let qa_provider = or_default(defaults.qa_provider.clone(), "openrouter");
    let qa_mode_env = or_default(defaults.paddle_rec_model.clone(), ""); // placeholder guard
    let _ = qa_mode_env;

    GlobalSettings {
        ocr_model: setting_value(
            pool,
            "ocrModel",
            &effective(&defaults.ocr_model, &defaults.ocr_model_list),
        )
        .await,
        ocr_provider: setting_value(pool, "ocrProvider", &ocr_provider).await,
        tl_model: setting_value(
            pool,
            "tlModel",
            &effective(&defaults.tl_model, &defaults.tl_model_list),
        )
        .await,
        tl_provider: setting_value(pool, "tlProvider", &tl_provider).await,
        qa_llm_model: setting_value(
            pool,
            "qaLlmModel",
            &effective(&defaults.qa_llm_model, &defaults.qa_llm_model_list),
        )
        .await,
        qa_mode: setting_value(pool, "qaMode", "auto").await,
        qa_provider: setting_value(pool, "qaProvider", &qa_provider).await,
        qa_vlm_model: setting_value(
            pool,
            "qaVlmModel",
            &effective(&defaults.qa_vlm_model, &defaults.qa_vlm_model_list),
        )
        .await,
        routing_strategy: setting_value(pool, "routingStrategy", "lowest-cost").await,
        use_fallback_models: setting_value(pool, "useFallbackModels", "true").await == "true",
        local_ocr_model: defaults.paddle_rec_model.clone(),
    }
}
