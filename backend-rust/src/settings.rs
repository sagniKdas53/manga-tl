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
    /// How cleanup rebuilds the background under erased lettering: one of [`CLEANUP_MODES`].
    pub cleanup_mode: String,
    /// OCR grouping threshold in characters; see [`ocr_merge_threshold`].
    pub ocr_merge_threshold: f64,
    /// ProviderConfigCache.getDefaultModel("local","ocr") once Phase 3 lands; until then
    /// only the PADDLEOCR_REC_MODEL fallback path exists (documented deviation).
    pub local_ocr_model: String,
}

/// Cleanup reconstruction modes the worker understands (`cleanup_reconstruct.py`):
/// - `auto`: TELEA on flat interiors, AOT-GAN on structured ones (the R3 default);
/// - `telea` / `aot`: one method everywhere, for comparing them;
/// - `off`: no cleanup — text is drawn over the source with its halo (R2 behaviour).
pub const CLEANUP_MODES: &[&str] = &["auto", "telea", "aot", "off"];

/// A cleanup mode as stored, or `auto` for anything unrecognised.
pub fn cleanup_mode(value: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    if CLEANUP_MODES.contains(&value.as_str()) {
        value
    } else {
        "auto".into()
    }
}

/// OCR fragment grouping: join two fragments when the white space between them is under this many
/// characters. The worker's own `OCR_MERGE_THRESHOLD` (0.35) is the measured default; the floor is
/// `fragment_grouping.MIN_THRESHOLD_RATIO`, which the area gate halves down to.
pub const OCR_MERGE_THRESHOLD_DEFAULT: f64 = 0.35;
pub const OCR_MERGE_THRESHOLD_RANGE: (f64, f64) = (0.05, 3.0);

/// A grouping threshold as sent to the worker: clamped, or the default when not a number.
pub fn ocr_merge_threshold(value: f64) -> f64 {
    if value.is_finite() {
        value.clamp(OCR_MERGE_THRESHOLD_RANGE.0, OCR_MERGE_THRESHOLD_RANGE.1)
    } else {
        OCR_MERGE_THRESHOLD_DEFAULT
    }
}

/// Where text sits inside its box: an inset on every side that scales with the box (a percentage
/// of its shorter side, raised to a min px and capped at a max px), then the share of what is left
/// that text may use.
/// One definition for the editor (via the settings route), the scene builder (per-object
/// `style.padding`) and the renderer (the safety percent rides on each render job).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextBoxGeometry {
    /// 0–50. Zero turns padding off (unless a min px is set).
    pub padding_percent: i32,
    /// 0–64. A floor for small boxes; zero means none. Never more than a quarter of the box's
    /// shorter side, so a tiny box keeps room for text.
    pub padding_min_px: i32,
    /// 0–64. Zero turns padding off; it wins over the min.
    pub padding_max_px: i32,
    /// 1–100.
    pub safety_percent: i32,
}

impl TextBoxGeometry {
    /// Chosen to reproduce the exports as they were before these settings reached the renderer:
    /// a flat 4 px (every box at least 100 px across gets exactly that) and no safety shrink.
    pub const DEFAULT: TextBoxGeometry = TextBoxGeometry {
        padding_percent: 4,
        padding_min_px: 0,
        padding_max_px: 4,
        safety_percent: 100,
    };

    pub fn clamped(
        padding_percent: i32,
        padding_min_px: i32,
        padding_max_px: i32,
        safety_percent: i32,
    ) -> Self {
        TextBoxGeometry {
            padding_percent: padding_percent.clamp(0, 50),
            padding_min_px: padding_min_px.clamp(0, 64),
            padding_max_px: padding_max_px.clamp(0, 64),
            safety_percent: safety_percent.clamp(1, 100),
        }
    }

    /// The inset, in px, for a box of this size.
    pub fn padding_px(&self, width: f64, height: f64) -> f64 {
        let short = width.min(height).max(0.0);
        let scaled = short * f64::from(self.padding_percent) / 100.0;
        let floor = f64::from(self.padding_min_px).min(short / 4.0);
        scaled.max(floor).min(f64::from(self.padding_max_px))
    }
}

async fn int_setting(pool: &PgPool, key: &str, default: i32) -> i32 {
    setting_value(pool, key, &default.to_string())
        .await
        .trim()
        .parse::<i32>()
        .unwrap_or(default)
}

pub async fn text_box_geometry(pool: &PgPool) -> TextBoxGeometry {
    let d = TextBoxGeometry::DEFAULT;
    TextBoxGeometry::clamped(
        int_setting(pool, "textBoxPaddingPercent", d.padding_percent).await,
        int_setting(pool, "textBoxPaddingMinPx", d.padding_min_px).await,
        int_setting(pool, "textBoxPaddingMaxPx", d.padding_max_px).await,
        int_setting(pool, "textBoxSafetyPercent", d.safety_percent).await,
    )
}

/// The owner's custom model IDs (`customModels`, a JSON list); empty when unset or unreadable.
pub async fn custom_models(pool: &PgPool) -> Vec<crate::providers::CustomModel> {
    let raw = setting_value(pool, "customModels", "[]").await;
    let parsed: Vec<crate::providers::CustomModel> = serde_json::from_str(&raw).unwrap_or_default();
    crate::providers::normalize_custom_models(&parsed)
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
        cleanup_mode: cleanup_mode(&setting_value(pool, "cleanupMode", "auto").await),
        ocr_merge_threshold: ocr_merge_threshold(
            setting_value(pool, "ocrMergeThreshold", "")
                .await
                .trim()
                .parse::<f64>()
                .unwrap_or(OCR_MERGE_THRESHOLD_DEFAULT),
        ),
        local_ocr_model: defaults.paddle_rec_model.clone(),
    }
}

#[cfg(test)]
mod text_box_geometry_tests {
    use super::*;

    #[test]
    fn padding_scales_with_the_box_and_stops_at_the_cap() {
        let g = TextBoxGeometry::clamped(6, 0, 12, 95);
        assert!(
            (g.padding_px(40.0, 300.0) - 2.4).abs() < 1e-9,
            "6% of a 40 px short side"
        );
        assert_eq!(g.padding_px(300.0, 400.0), 12.0, "18 px capped at 12");
    }

    #[test]
    fn zero_percent_or_zero_cap_turns_padding_off() {
        assert_eq!(
            TextBoxGeometry::clamped(0, 0, 12, 95).padding_px(300.0, 300.0),
            0.0
        );
        assert_eq!(
            TextBoxGeometry::clamped(6, 0, 0, 95).padding_px(300.0, 300.0),
            0.0
        );
    }

    #[test]
    fn the_default_reproduces_the_old_flat_four_px_on_ordinary_boxes() {
        let d = TextBoxGeometry::DEFAULT;
        assert_eq!(d.padding_px(120.0, 180.0), 4.0);
        assert_eq!(d.safety_percent, 100);
    }

    #[test]
    fn out_of_range_values_are_clamped_and_unknown_modes_are_auto() {
        assert_eq!(
            TextBoxGeometry::clamped(90, -3, 900, 0),
            TextBoxGeometry {
                padding_percent: 50,
                padding_min_px: 0,
                padding_max_px: 64,
                safety_percent: 1
            }
        );
        assert_eq!(cleanup_mode(" AOT "), "aot");
        assert_eq!(cleanup_mode("lama"), "auto");
        assert_eq!(ocr_merge_threshold(0.0), OCR_MERGE_THRESHOLD_RANGE.0);
        assert_eq!(ocr_merge_threshold(9.0), OCR_MERGE_THRESHOLD_RANGE.1);
        assert_eq!(ocr_merge_threshold(f64::NAN), OCR_MERGE_THRESHOLD_DEFAULT);
        assert_eq!(ocr_merge_threshold(0.8), 0.8);
    }

    #[test]
    fn a_min_px_lifts_small_boxes_but_the_max_and_a_quarter_of_the_box_still_win() {
        let g = TextBoxGeometry::clamped(4, 6, 10, 100);
        assert_eq!(g.padding_px(50.0, 300.0), 6.0, "4% of 50 is 2, lifted to 6");
        assert_eq!(
            g.padding_px(200.0, 300.0),
            8.0,
            "4% of 200 is 8, already above the min"
        );
        assert_eq!(g.padding_px(1000.0, 1000.0), 10.0, "capped");
        assert_eq!(g.padding_px(16.0, 40.0), 4.0, "a quarter of a 16 px box");
        let min_over_max = TextBoxGeometry::clamped(4, 12, 5, 100);
        assert_eq!(min_over_max.padding_px(50.0, 50.0), 5.0, "the max wins");
        assert_eq!(
            TextBoxGeometry::DEFAULT.padding_px(50.0, 300.0),
            2.0,
            "default min 0 changes nothing"
        );
    }
}
