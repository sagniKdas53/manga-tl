//! Database entities — one struct per table, mapped 1:1 from `database/init.sql`.
//!
//! Phase-1 note: these structs are declared before the repositories that query them
//! (Phase 2), so "never constructed" warnings are expected and silenced once, here.

#![allow(dead_code)]
//!
//! Rust refresher:
//! - `#[derive(...)]` generates trait implementations for free:
//!     * `sqlx::FromRow` -> lets sqlx build this struct from a `SELECT *` row
//!       (column names must match field names)
//!     * `serde::Serialize` / `Deserialize` <-> JSON (our Jackson replacement)
//!     * `Debug` (println), `Clone` (.clone())
//! - `Option<T>` marks nullable columns exactly like `@Nullable`.
//! - `Uuid`, `DateTime<Utc>` map to Postgres `uuid` / `timestamptz` via sqlx's
//!   `uuid` and `chrono` features.
//! - Columns named `type` collide with the Rust keyword, so fields are called
//!   `job_type`/`layer_type` and renamed back to `"type"` for both SQL and JSON,
//!   keeping the wire format identical to the Java backend.
//!
//! NOTE ON PARITY: these mirror Hibernate entities, but every repository query is
//! hand-written against THIS schema (the Java side runs `ddl-auto: validate` with
//! init.sql as the single source of truth — same philosophy here).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

// ---------------------------------------------------------------- users

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub display_name: String,
    pub email: String,
    /// Never serialized to API responses — controllers must expose a DTO without it.
    #[serde(skip_serializing)]
    pub password_hash: String,
    pub role: String,
}

// ---------------------------------------------------------------- series

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Series {
    pub id: Uuid,
    pub cover_image_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub metadata_json: Option<serde_json::Value>,
    pub ocr_model: Option<String>,
    pub ocr_provider: Option<String>,
    pub original_language: String,
    pub qa_llm_model: Option<String>,
    pub qa_mode: Option<String>,
    pub qa_provider: Option<String>,
    pub qa_vlm_model: Option<String>,
    pub reading_direction: String,
    pub source_language: Option<String>,
    pub target_language: Option<String>,
    pub title: String,
    pub tl_model: Option<String>,
    pub tl_provider: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub routing_strategy: Option<String>,
    pub use_fallback_models: Option<bool>,
    pub created_by: Option<Uuid>,
}

// ---------------------------------------------------------------- chapters

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub id: Uuid,
    pub chapter_number: f64,
    pub cover_image_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub ocr_model: Option<String>,
    pub ocr_provider: Option<String>,
    pub qa_llm_model: Option<String>,
    pub qa_mode: Option<String>,
    pub qa_provider: Option<String>,
    pub qa_vlm_model: Option<String>,
    pub summary_generated_at: Option<DateTime<Utc>>,
    pub summary_json: Option<serde_json::Value>,
    pub title: Option<String>,
    pub tl_model: Option<String>,
    pub tl_provider: Option<String>,
    pub updated_at: DateTime<Utc>,
    pub use_context_memory: bool,
    pub use_fallback_models: Option<bool>,
    pub routing_strategy: Option<String>,
    pub series_id: Uuid,
}

// ---------------------------------------------------------------- pages

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: Uuid,
    pub page_number: i32,
    pub chapter_id: Uuid,
    pub image_id: Uuid,
    pub last_edited_at: Option<DateTime<Utc>>,
    pub last_rendered_at: Option<DateTime<Utc>>,
}

// ---------------------------------------------------------------- images

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub filename: String,
    pub hash: Option<String>,
    pub height: Option<i32>,
    pub width: Option<i32>,
    pub last_edited_at: Option<DateTime<Utc>>,
    pub last_rendered_at: Option<DateTime<Utc>>,
    pub storage_path: String,
    pub thumbnail_storage_path: Option<String>,
    pub reader_storage_path: Option<String>,
    pub created_by: Option<Uuid>,
}

// ---------------------------------------------------------------- panels

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Panel {
    pub id: Uuid,
    pub bbox_x: i32,
    pub bbox_y: i32,
    pub bbox_w: i32,
    pub bbox_h: i32,
    pub grid_col: Option<i32>,
    pub grid_row: Option<i32>,
    pub reading_order: i32,
    pub image_id: Uuid,
}

// ---------------------------------------------------------------- ocr regions

/// OCR region: one speech balloon / SFX block detected by the worker.
/// This is the table the whole translation pipeline revolves around.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct OcrRegion {
    pub id: Uuid,
    pub approved: Option<bool>,
    pub background_color: Option<String>,
    pub bbox_x: i32,
    pub bbox_y: i32,
    pub bbox_w: i32,
    pub bbox_h: i32,
    pub bubble_x: Option<i32>,
    pub bubble_y: Option<i32>,
    pub bubble_w: Option<i32>,
    pub bubble_h: Option<i32>,
    pub bubble_id: Option<String>,
    pub bubble_reading_order: Option<i32>,
    pub confidence: Option<f64>,
    pub detected_language: String,
    pub detection_confidence: Option<f64>,
    pub mask_polygon: Option<serde_json::Value>,
    pub ocr_score: Option<f64>,
    pub panel_reading_order: Option<i32>,
    pub qa_feedback: Option<String>,
    pub qa_score: Option<f64>,
    pub qa_status: Option<String>,
    pub region_type: Option<String>,
    pub rotation: Option<f64>,
    pub safe_text_x: Option<i32>,
    pub safe_text_y: Option<i32>,
    pub safe_text_w: Option<i32>,
    pub safe_text_h: Option<i32>,
    pub text: Option<String>,
    pub translated_text: Option<String>,
    pub translation_failed: Option<bool>,
    pub translation_score: Option<f64>,
    pub page_id: Uuid,
    pub panel_id: Option<Uuid>,
}

// ---------------------------------------------------------------- layers

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub metadata_json: Option<serde_json::Value>,
    pub target_language: Option<String>,
    /// DB column and JSON field are both `"type"`; see module docs about keywords.
    #[sqlx(rename = "type")]
    #[serde(rename = "type")]
    pub layer_type: String,
    pub visible: Option<bool>,
    pub z_order: i32,
    pub page_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct LayerElement {
    pub id: Uuid,
    pub auto_size: Option<bool>,
    pub background_color: Option<String>,
    pub box_shape: Option<String>,
    pub edited_at: Option<DateTime<Utc>>,
    pub font: Option<String>,
    pub font_style: Option<String>,
    pub font_weight: Option<String>,
    pub is_manually_edited: Option<bool>,
    pub mask_polygon: Option<serde_json::Value>,
    pub max_height: Option<i32>,
    pub max_width: Option<i32>,
    pub overflow: Option<bool>,
    pub rotation: Option<f64>,
    pub size: Option<f64>,
    pub text: Option<String>,
    pub text_color: Option<String>,
    pub visible: Option<bool>,
    pub word_wrap: Option<bool>,
    pub x: f64,
    pub y: f64,
    pub layer_id: Uuid,
    pub region_id: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct LayerEditHistory {
    pub id: Uuid,
    pub edited_at: DateTime<Utc>,
    pub new_value_json: Option<serde_json::Value>,
    pub previous_value_json: Option<serde_json::Value>,
    pub edited_by: Option<Uuid>,
    pub layer_element_id: Uuid,
}

// ---------------------------------------------------------------- conversations

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: Uuid,
    pub scene_type: String,
    pub page_id: Uuid,
}

/// Join table ordering conversations within a scene.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRegion {
    pub conversation_id: Uuid,
    pub region_id: Uuid,
    pub position: i32,
}

// ---------------------------------------------------------------- jobs

/// Pipeline job row. Note: `id` is a varchar (worker-assigned), NOT a uuid.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub attempt: Option<i32>,
    pub callback_applied_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
    pub image_id: Option<Uuid>,
    pub page_id: Option<Uuid>,
    pub max_attempts: Option<i32>,
    /// Raw JSON payload sent to the worker, stored as text.
    pub payload: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub status: String,
    pub trace_id: Option<String>,
    #[sqlx(rename = "type")]
    #[serde(rename = "type")]
    pub job_type: String,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct JobCost {
    pub id: Uuid,
    pub job_id: Option<String>,
    pub image_id: Uuid,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub prompt_tokens: Option<i32>,
    pub completion_tokens: Option<i32>,
    pub estimated_cost: Option<f64>,
    pub created_at: DateTime<Utc>,
}

// ---------------------------------------------------------------- settings

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct SystemSetting {
    pub setting_key: String,
    pub setting_value: String,
    pub updated_at: DateTime<Utc>,
}

/// Per-model token pricing used by CostEstimationService.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ModelRate {
    pub model_id: String,
    pub provider: Option<String>,
    pub prompt_price: Option<f64>,
    pub completion_price: Option<f64>,
    pub updated_at: Option<DateTime<Utc>>,
}
