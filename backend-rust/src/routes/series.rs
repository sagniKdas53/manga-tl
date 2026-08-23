//! `/api/series` + `/api/series/chapters/**` CRUD — port of SeriesController minus the
//! import/export quartet (those need the Phase 3 job pipeline; see MIGRATION.md).
//!
//! CONTRACT NOTES (verified against Java source):
//! - Write paths pass every override field through resolveSetting(): "inherit"/"default"/blank
//!   become NULL before storage; targetLanguage falls back "en", original/source "ja".
//! - createChapter/updateChapter return 409 {"message": "..."} JSON on duplicate number;
//!   useContextMemory defaults TRUE when absent on create (update leaves untouched when absent).
//! - updateChapter recalculates the series cover: cover of the lowest-numbered chapter that
//!   HAS one (PageService.recalculateSeriesCover).
//! - deleteSeries is ADMIN-only -> AccessDenied problem+json for other roles; chapter deletes
//!   are any-role. Cascades live in the schema (ON DELETE CASCADE), so plain DELETEs suffice.
//! - List endpoints: ?page=&size=&sortBy=(createdAt|updatedAt|else updatedAt)&sortDir=
//!   with size clamped to 100 (Spring's max-page-size); chapters sort by chapterNumber,
//!   default dir asc (series default desc).
//! - Resolved slots in ChapterDto follow the AUDIT-P1 rules: per-field independent fallback
//!   (never coupled to provider choice); local OCR model comes from settings.localOcrModel;
//!   source label from ANY overridden field at that level.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error;
use crate::models::{Chapter, Series};
use crate::resolve::{resolve_model, resolve_model_with_check, source_of};
use crate::settings::{GlobalSettings, PipelineDefaults, load_global_settings};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// DTOs — camelCase keys, explicit nulls (Jackson parity)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[allow(non_snake_case)]
pub struct SeriesDto {
    pub id: Uuid,
    pub title: String,
    pub originalLanguage: String,
    pub sourceLanguage: Option<String>,
    pub targetLanguage: Option<String>,
    pub readingDirection: Option<String>,
    pub coverImageUrl: Option<String>,
    pub ocrProvider: Option<String>,
    pub ocrModel: Option<String>,
    pub tlProvider: Option<String>,
    pub tlModel: Option<String>,
    pub qaProvider: Option<String>,
    pub qaLlmModel: Option<String>,
    pub qaVlmModel: Option<String>,
    pub qaMode: Option<String>,
    pub routingStrategy: Option<String>,
    pub useFallbackModels: Option<bool>,
    pub resolvedUseFallbackModels: bool,
    pub createdAt: chrono::DateTime<chrono::Utc>,
    pub updatedAt: chrono::DateTime<chrono::Utc>,
}

#[derive(Serialize)]
#[allow(non_snake_case)]
pub struct ResolvedModelSlot {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub source: &'static str,
}

#[derive(Serialize)]
#[allow(non_snake_case)]
pub struct ResolvedQaSlot {
    pub provider: Option<String>,
    pub llmModel: Option<String>,
    pub vlmModel: Option<String>,
    pub mode: Option<String>,
    pub source: &'static str,
}

#[derive(Serialize)]
#[allow(non_snake_case)]
pub struct ChapterDto {
    pub id: Uuid,
    pub seriesId: Option<Uuid>,
    pub chapterNumber: f64,
    pub title: Option<String>,
    pub coverImageUrl: Option<String>,
    pub ocrProvider: Option<String>,
    pub ocrModel: Option<String>,
    pub tlProvider: Option<String>,
    pub tlModel: Option<String>,
    pub qaProvider: Option<String>,
    pub qaLlmModel: Option<String>,
    pub qaVlmModel: Option<String>,
    pub qaMode: Option<String>,
    pub routingStrategy: Option<String>,
    pub useContextMemory: Option<bool>,
    pub useFallbackModels: Option<bool>,
    pub resolvedUseFallbackModels: bool,
    pub pageCount: i64,
    pub createdAt: chrono::DateTime<chrono::Utc>,
    pub updatedAt: chrono::DateTime<chrono::Utc>,
    pub resolvedOcr: ResolvedModelSlot,
    pub resolvedTranslation: ResolvedModelSlot,
    pub resolvedQa: ResolvedQaSlot,
}

#[derive(Serialize)]
#[allow(non_snake_case)]
pub struct PagedResponse<T> {
    pub content: Vec<T>,
    pub page: i64,
    pub size: i64,
    pub totalElements: i64,
    pub totalPages: i64,
}

/// Java SeriesController.resolveSetting: placeholder values become NULL on write.
fn resolve_setting(value: &Option<String>) -> Option<String> {
    match value.as_deref() {
        None => None,
        Some(v) if v == "inherit" || v == "default" || v.trim().is_empty() => None,
        Some(v) => Some(v.to_string()),
    }
}

fn cover_url(state: &AppState, image_id: Option<Uuid>) -> Option<String> {
    image_id.map(|id| format!("{}/api/images/{id}/thumbnail", state.config.context_path))
}

fn to_series_dto(state: &AppState, s: &Series, resolved_use_fallback: bool) -> SeriesDto {
    SeriesDto {
        id: s.id,
        title: s.title.clone(),
        originalLanguage: s.original_language.clone(),
        sourceLanguage: s.source_language.clone(),
        targetLanguage: s.target_language.clone(),
        readingDirection: Some(s.reading_direction.clone()),
        coverImageUrl: cover_url(state, s.cover_image_id),
        ocrProvider: s.ocr_provider.clone(),
        ocrModel: s.ocr_model.clone(),
        tlProvider: s.tl_provider.clone(),
        tlModel: s.tl_model.clone(),
        qaProvider: s.qa_provider.clone(),
        qaLlmModel: s.qa_llm_model.clone(),
        qaVlmModel: s.qa_vlm_model.clone(),
        qaMode: s.qa_mode.clone(),
        routingStrategy: s.routing_strategy.clone(),
        useFallbackModels: s.use_fallback_models,
        resolvedUseFallbackModels: resolved_use_fallback,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
    }
}

async fn page_count(pool: &sqlx::PgPool, chapter_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE chapter_id = $1")
        .bind(chapter_id)
        .fetch_one(pool)
        .await
        .unwrap_or(0)
}

async fn to_chapter_dto(
    state: &AppState,
    chapter: &Chapter,
    series: Option<&Series>,
    global: &GlobalSettings,
) -> ChapterDto {
    let g = global;
    // Java used a dummy Series for the null case; borrowing through Option keeps that
    // spirit without fabricating an entity. All reads go through these locals.
    let (s_ocr_provider, s_ocr_model) = (
        series.and_then(|s| s.ocr_provider.as_deref()),
        series.and_then(|s| s.ocr_model.as_deref()),
    );

    // --- OCR slot ---
    let ocr_prov = resolve_model(
        chapter.ocr_provider.as_deref(),
        series.and_then(|s| s.ocr_provider.as_deref()),
        &g.ocr_provider,
    );
    // enqueueJobDirectly resolves ocrModel WITHOUT a validity check; local collapses to the
    // published local pair value. Mirrored verbatim.
    let ocr_mod = if ocr_prov == "local" {
        g.local_ocr_model.clone()
    } else {
        resolve_model(
            chapter.ocr_model.as_deref(),
            series.and_then(|s| s.ocr_model.as_deref()),
            &g.ocr_model,
        )
    };
    let ocr_src = source_of(
        [&chapter.ocr_provider, &chapter.ocr_model],
        [
            &s_ocr_provider.map(str::to_string),
            &s_ocr_model.map(str::to_string),
        ],
    );

    // --- Translation slot ---
    let tl_prov = resolve_model(
        chapter.tl_provider.as_deref(),
        series.and_then(|s| s.tl_provider.as_deref()),
        &g.tl_provider,
    );
    let tl_mod = resolve_model_with_check(
        state,
        chapter.tl_model.as_deref(),
        series.and_then(|s| s.tl_model.as_deref()),
        &g.tl_model,
        &tl_prov,
        "tl",
    );
    let tl_src = source_of(
        [&chapter.tl_provider, &chapter.tl_model],
        [
            &series.and_then(|s| s.tl_provider.clone()),
            &series.and_then(|s| s.tl_model.clone()),
        ],
    );

    // --- QA slot (task keys must stay providers.json-cased: qaLLM / qaVLM) ---
    let qa_prov = resolve_model(
        chapter.qa_provider.as_deref(),
        series.and_then(|s| s.qa_provider.as_deref()),
        &g.qa_provider,
    );
    let qa_llm = resolve_model_with_check(
        state,
        chapter.qa_llm_model.as_deref(),
        series.and_then(|s| s.qa_llm_model.as_deref()),
        &g.qa_llm_model,
        &qa_prov,
        "qaLLM",
    );
    let qa_vlm = resolve_model_with_check(
        state,
        chapter.qa_vlm_model.as_deref(),
        series.and_then(|s| s.qa_vlm_model.as_deref()),
        &g.qa_vlm_model,
        &qa_prov,
        "qaVLM",
    );
    let qa_mode = resolve_model(
        chapter.qa_mode.as_deref(),
        series.and_then(|s| s.qa_mode.as_deref()),
        &g.qa_mode,
    );
    let qa_src = source_of(
        [
            &chapter.qa_provider,
            &chapter.qa_llm_model,
            &chapter.qa_vlm_model,
            &chapter.qa_mode,
        ],
        [
            &series.and_then(|s| s.qa_provider.clone()),
            &series.and_then(|s| s.qa_llm_model.clone()),
            &series.and_then(|s| s.qa_vlm_model.clone()),
            &series.and_then(|s| s.qa_mode.clone()),
        ],
    );

    // chapter -> series -> global -> true
    let resolved_use_fallback = chapter
        .use_fallback_models
        .or_else(|| series.and_then(|s| s.use_fallback_models))
        .unwrap_or(g.use_fallback_models);

    ChapterDto {
        id: chapter.id,
        seriesId: chapter.series_id.into(),
        chapterNumber: chapter.chapter_number,
        title: chapter.title.clone(),
        coverImageUrl: cover_url(state, chapter.cover_image_id),
        ocrProvider: chapter.ocr_provider.clone(),
        ocrModel: chapter.ocr_model.clone(),
        tlProvider: chapter.tl_provider.clone(),
        tlModel: chapter.tl_model.clone(),
        qaProvider: chapter.qa_provider.clone(),
        qaLlmModel: chapter.qa_llm_model.clone(),
        qaVlmModel: chapter.qa_vlm_model.clone(),
        qaMode: chapter.qa_mode.clone(),
        routingStrategy: chapter.routing_strategy.clone(),
        useContextMemory: chapter.use_context_memory.into(),
        useFallbackModels: chapter.use_fallback_models,
        resolvedUseFallbackModels: resolved_use_fallback,
        pageCount: page_count(&state.pool, chapter.id).await,
        createdAt: chapter.created_at,
        updatedAt: chapter.updated_at,
        resolvedOcr: ResolvedModelSlot {
            provider: Some(ocr_prov),
            model: Some(ocr_mod),
            source: ocr_src,
        },
        resolvedTranslation: ResolvedModelSlot {
            provider: Some(tl_prov),
            model: Some(tl_mod),
            source: tl_src,
        },
        resolvedQa: ResolvedQaSlot {
            provider: Some(qa_prov),
            llmModel: Some(qa_llm),
            vlmModel: Some(qa_vlm),
            mode: Some(qa_mode),
            source: qa_src,
        },
    }
}

// ---------------------------------------------------------------------------
// Request payloads (deserialization is lenient; validation == Java's absence of @Valid here)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[allow(non_snake_case)]
pub struct SeriesInput {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub originalLanguage: Option<String>,
    #[serde(default)]
    pub sourceLanguage: Option<String>,
    #[serde(default)]
    pub targetLanguage: Option<String>,
    #[serde(default)]
    pub readingDirection: Option<String>,
    #[serde(default)]
    pub ocrProvider: Option<String>,
    #[serde(default)]
    pub ocrModel: Option<String>,
    #[serde(default)]
    pub tlProvider: Option<String>,
    #[serde(default)]
    pub tlModel: Option<String>,
    #[serde(default)]
    pub qaProvider: Option<String>,
    #[serde(default)]
    pub qaLlmModel: Option<String>,
    #[serde(default)]
    pub qaVlmModel: Option<String>,
    #[serde(default)]
    pub qaMode: Option<String>,
    #[serde(default)]
    pub routingStrategy: Option<String>,
    #[serde(default)]
    pub useFallbackModels: Option<bool>,
}

#[derive(Deserialize)]
#[allow(non_snake_case)]
pub struct ChapterInput {
    #[serde(default)]
    pub chapterNumber: Option<f64>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub ocrProvider: Option<String>,
    #[serde(default)]
    pub ocrModel: Option<String>,
    #[serde(default)]
    pub tlProvider: Option<String>,
    #[serde(default)]
    pub tlModel: Option<String>,
    #[serde(default)]
    pub qaProvider: Option<String>,
    #[serde(default)]
    pub qaLlmModel: Option<String>,
    #[serde(default)]
    pub qaVlmModel: Option<String>,
    #[serde(default)]
    pub qaMode: Option<String>,
    #[serde(default)]
    pub routingStrategy: Option<String>,
    #[serde(default)]
    pub useContextMemory: Option<bool>,
    #[serde(default)]
    pub useFallbackModels: Option<bool>,
}

#[derive(Deserialize)]
#[allow(non_snake_case)]
pub struct Pagination {
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub size: Option<i64>,
    #[serde(default)]
    pub sortBy: Option<String>,
    #[serde(default)]
    pub sortDir: Option<String>,
}

const MAX_PAGE_SIZE: i64 = 100;

impl Pagination {
    fn bounds(&self, default_size: i64) -> (i64, i64) {
        let page = self.page.unwrap_or(0).max(0);
        let requested = self.size.unwrap_or(default_size);
        // Spring silently caps at spring.data.web.pageable.max-page-size.
        let size = requested.clamp(1, MAX_PAGE_SIZE);
        (page, size)
    }

    /// Whitelisted sort column; anything else falls back (SERIES_SORT_FIELDS parity).
    fn sort_column(&self, allowed: &[&str], fallback: &str) -> String {
        let raw = self.sortBy.as_deref().unwrap_or("");
        allowed
            .iter()
            .find(|c| **c == raw)
            .copied()
            .unwrap_or(fallback)
            .to_string()
    }

    fn descending(&self, default_asc: bool) -> bool {
        match self.sortDir.as_deref() {
            Some("desc") => true,
            Some("asc") => false,
            _ => !default_asc,
        }
    }
}

// ---------------------------------------------------------------------------
// Series handlers
// ---------------------------------------------------------------------------

/// POST /api/series — any authenticated role.
pub async fn create_series(
    State(state): State<AppState>,
    user: AuthUser,
    body: Result<Json<SeriesInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let instance = "/api/series";
    let Json(dto) = match body {
        Ok(json) => json,
        Err(_) => return error::unreadable_body(instance),
    };

    let source_lang = dto
        .sourceLanguage
        .clone()
        .or_else(|| dto.originalLanguage.clone());
    // resolveSetting + language fallbacks ("en"/"ja") exactly as createSeries does.
    let target_lang = resolve_setting(&dto.targetLanguage).unwrap_or_else(|| "en".to_string());
    let orig_lang = resolve_setting(&source_lang).unwrap_or_else(|| "ja".to_string());

    let series: Series = sqlx::query_as(
        "INSERT INTO series (id, created_at, updated_at, title, original_language, \
         source_language, target_language, reading_direction, ocr_provider, ocr_model, \
         tl_provider, tl_model, qa_provider, qa_llm_model, qa_vlm_model, qa_mode, \
         routing_strategy, use_fallback_models, created_by) \
         VALUES ($1, now(), now(), $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, \
                 $14, $15, $16) RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(dto.title.clone())
    .bind(&orig_lang)
    .bind(target_lang)
    .bind(resolve_setting(&dto.readingDirection))
    .bind(resolve_setting(&dto.ocrProvider))
    .bind(resolve_setting(&dto.ocrModel))
    .bind(resolve_setting(&dto.tlProvider))
    .bind(resolve_setting(&dto.tlModel))
    .bind(resolve_setting(&dto.qaProvider))
    .bind(resolve_setting(&dto.qaLlmModel))
    .bind(resolve_setting(&dto.qaVlmModel))
    .bind(resolve_setting(&dto.qaMode))
    .bind(resolve_setting(&dto.routingStrategy))
    .bind(dto.useFallbackModels)
    .bind(user.id)
    .fetch_one(&state.pool)
    .await
    .expect("series insert");

    // resolvedUseFallbackModels falls back to the global setting when unset on the entity.
    let defaults = PipelineDefaults::from_env();
    let global = load_global_settings(&state.pool, &defaults).await;
    let resolved = series
        .use_fallback_models
        .unwrap_or(global.use_fallback_models);
    Json(to_series_dto(&state, &series, resolved)).into_response()
}

/// GET /api/series — paginated, sortable by createdAt|updatedAt only.
pub async fn list_series(State(state): State<AppState>, Query(p): Query<Pagination>) -> Response {
    let (page, size) = p.bounds(10);
    let column = p.sort_column(&["createdAt", "updatedAt"], "updatedAt");
    let direction = if p.descending(false) { "DESC" } else { "ASC" };

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM series")
        .fetch_one(&state.pool)
        .await
        .unwrap_or(0);

    let order_column = if column == "createdAt" {
        "created_at"
    } else {
        "updated_at"
    };
    let rows: Vec<Series> = sqlx::query_as(&format!(
        "SELECT * FROM series ORDER BY {order_column} {direction} LIMIT {size} OFFSET {}",
        page * size
    ))
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let defaults = PipelineDefaults::from_env();
    let global = load_global_settings(&state.pool, &defaults).await;
    let content: Vec<SeriesDto> = rows
        .iter()
        .map(|s| {
            let resolved = s.use_fallback_models.unwrap_or(global.use_fallback_models);
            to_series_dto(&state, s, resolved)
        })
        .collect();

    Json(PagedResponse {
        totalElements: total,
        totalPages: (total + size - 1) / size,
        page,
        size,
        content,
    })
    .into_response()
}

/// GET /api/series/{seriesId}
pub async fn get_series(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    match sqlx::query_as::<_, Series>("SELECT * FROM series WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await
    {
        Ok(Some(series)) => {
            let defaults = PipelineDefaults::from_env();
            let global = load_global_settings(&state.pool, &defaults).await;
            let resolved = series
                .use_fallback_models
                .unwrap_or(global.use_fallback_models);
            Json(to_series_dto(&state, &series, resolved)).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// PUT /api/series/{seriesId} — same field semantics as create.
pub async fn update_series(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    body: Result<Json<SeriesInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let instance = "/api/series/{seriesId}";
    let Json(dto) = match body {
        Ok(json) => json,
        Err(_) => return error::unreadable_body(instance),
    };

    let source_lang = dto
        .sourceLanguage
        .clone()
        .or_else(|| dto.originalLanguage.clone());
    let target_lang = resolve_setting(&dto.targetLanguage).unwrap_or_else(|| "en".to_string());
    let orig_lang = resolve_setting(&source_lang).unwrap_or_else(|| "ja".to_string());

    let updated: Option<Series> = sqlx::query_as(
        "UPDATE series SET title = $2, original_language = $3, source_language = $3, \
         target_language = $4, reading_direction = $5, ocr_provider = $6, ocr_model = $7, \
         tl_provider = $8, tl_model = $9, qa_provider = $10, qa_llm_model = $11, \
         qa_vlm_model = $12, qa_mode = $13, routing_strategy = $14, \
         use_fallback_models = $15, updated_at = now() \
         WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .bind(dto.title.clone())
    .bind(&orig_lang)
    .bind(target_lang)
    .bind(resolve_setting(&dto.readingDirection))
    .bind(resolve_setting(&dto.ocrProvider))
    .bind(resolve_setting(&dto.ocrModel))
    .bind(resolve_setting(&dto.tlProvider))
    .bind(resolve_setting(&dto.tlModel))
    .bind(resolve_setting(&dto.qaProvider))
    .bind(resolve_setting(&dto.qaLlmModel))
    .bind(resolve_setting(&dto.qaVlmModel))
    .bind(resolve_setting(&dto.qaMode))
    .bind(resolve_setting(&dto.routingStrategy))
    .bind(dto.useFallbackModels)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);

    match updated {
        Some(series) => {
            let defaults = PipelineDefaults::from_env();
            let global = load_global_settings(&state.pool, &defaults).await;
            let resolved = series
                .use_fallback_models
                .unwrap_or(global.use_fallback_models);
            Json(to_series_dto(&state, &series, resolved)).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// DELETE /api/series/{seriesId} — ADMIN only (hasRole('ADMIN')).
pub async fn delete_series(
    State(state): State<AppState>,
    instance_uri: axum::http::Uri,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> Response {
    let instance = error::full_path(&state.config.context_path, &instance_uri);
    if !user.role.eq_ignore_ascii_case("admin") {
        return error::access_denied(&instance);
    }
    let result = sqlx::query("DELETE FROM series WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await;
    match result {
        Ok(res) if res.rows_affected() > 0 => StatusCode::OK.into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

// ---------------------------------------------------------------------------
// Chapter handlers
// ---------------------------------------------------------------------------

async fn find_series(pool: &sqlx::PgPool, id: Uuid) -> Option<Series> {
    sqlx::query_as("SELECT * FROM series WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

async fn find_chapter(pool: &sqlx::PgPool, id: Uuid) -> Option<Chapter> {
    sqlx::query_as("SELECT * FROM chapters WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

fn duplicate_message(number: f64) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "message": format!(
                "Chapter {number} already exists in this series. Please select a different chapter number."
            )
        })),
    )
        .into_response()
}

/// POST /api/series/{seriesId}/chapters
pub async fn create_chapter(
    State(state): State<AppState>,
    instance_uri: axum::http::Uri,
    Path(series_id): Path<Uuid>,
    body: Result<Json<ChapterInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let instance = error::full_path(&state.config.context_path, &instance_uri);
    let Json(dto) = match body {
        Ok(json) => json,
        Err(_) => return error::unreadable_body(&instance),
    };
    if find_series(&state.pool, series_id).await.is_none() {
        return not_found_series(series_id, &instance);
    };
    let number = dto.chapterNumber.unwrap_or(0.0);

    let dup_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM chapters WHERE series_id = $1 AND chapter_number = $2)",
    )
    .bind(series_id)
    .bind(number)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(false);
    if dup_exists {
        return duplicate_message(number);
    }

    let chapter: Chapter = sqlx::query_as(
        "INSERT INTO chapters (id, created_at, updated_at, series_id, chapter_number, title, \
         ocr_provider, ocr_model, tl_provider, tl_model, qa_provider, qa_llm_model, \
         qa_vlm_model, qa_mode, routing_strategy, use_context_memory, use_fallback_models) \
         VALUES ($1, now(), now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) \
         RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(series_id)
    .bind(number)
    .bind(dto.title.clone())
    .bind(resolve_setting(&dto.ocrProvider))
    .bind(resolve_setting(&dto.ocrModel))
    .bind(resolve_setting(&dto.tlProvider))
    .bind(resolve_setting(&dto.tlModel))
    .bind(resolve_setting(&dto.qaProvider))
    .bind(resolve_setting(&dto.qaLlmModel))
    .bind(resolve_setting(&dto.qaVlmModel))
    .bind(resolve_setting(&dto.qaMode))
    .bind(resolve_setting(&dto.routingStrategy))
    // create: absent means TRUE (Java: dto.useContextMemory() == null || dto.useContextMemory())
    .bind(dto.useContextMemory.unwrap_or(true))
    .bind(dto.useFallbackModels)
    .fetch_one(&state.pool)
    .await
    .expect("chapter insert");

    respond_with_chapter_dto(&state, chapter).await
}

fn not_found_series(id: Uuid, instance: &str) -> Response {
    // ResourceNotFoundException message shape: "Series not found: <uuid>"
    error::not_found(&format!("Series not found: {id}"), instance)
}

/// GET /api/series/{seriesId}/chapters — sorted by chapterNumber, default asc.
pub async fn list_chapters(
    State(state): State<AppState>,
    Path(series_id): Path<Uuid>,
    Query(p): Query<Pagination>,
) -> Response {
    let (page, size) = p.bounds(15);
    let direction = if p.descending(true) { "DESC" } else { "ASC" };

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chapters WHERE series_id = $1")
        .bind(series_id)
        .fetch_one(&state.pool)
        .await
        .unwrap_or(0);

    let rows: Vec<Chapter> = sqlx::query_as(&format!(
        "SELECT * FROM chapters WHERE series_id = $1 \
         ORDER BY chapter_number {direction} LIMIT {size} OFFSET {}",
        page * size
    ))
    .bind(series_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let mut content = Vec::with_capacity(rows.len());
    for chapter in &rows {
        content.push(build_chapter_dto(&state, chapter).await);
    }

    Json(PagedResponse {
        totalElements: total,
        totalPages: (total + size - 1) / size,
        page,
        size,
        content,
    })
    .into_response()
}

/// GET /api/series/chapters/{chapterId}
pub async fn get_chapter(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    match find_chapter(&state.pool, id).await {
        Some(chapter) => {
            let dto = build_chapter_dto(&state, &chapter).await;
            Json(dto).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// PUT /api/series/chapters/{chapterId}
pub async fn update_chapter(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    body: Result<Json<ChapterInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let instance = "/api/series/chapters/{chapterId}";
    let Json(dto) = match body {
        Ok(json) => json,
        Err(_) => return error::unreadable_body(instance),
    };
    let Some(existing) = find_chapter(&state.pool, id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let number = dto.chapterNumber.unwrap_or(0.0);

    // Duplicate check EXCLUDING self (Java compares ids).
    let conflicting: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM chapters WHERE series_id = $1 AND chapter_number = $2 AND id <> $3",
    )
    .bind(existing.series_id)
    .bind(number)
    .bind(existing.id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or(None);
    if conflicting.is_some() {
        return duplicate_message(number);
    }

    let updated: Chapter = sqlx::query_as(
        "UPDATE chapters SET title = $2, chapter_number = $3, ocr_provider = $4, \
         ocr_model = $5, tl_provider = $6, tl_model = $7, qa_provider = $8, \
         qa_llm_model = $9, qa_vlm_model = $10, qa_mode = $11, routing_strategy = $12, \
         use_fallback_models = $13, use_context_memory = COALESCE($14, use_context_memory), \
         updated_at = now() WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .bind(dto.title.clone())
    .bind(number)
    .bind(resolve_setting(&dto.ocrProvider))
    .bind(resolve_setting(&dto.ocrModel))
    .bind(resolve_setting(&dto.tlProvider))
    .bind(resolve_setting(&dto.tlModel))
    .bind(resolve_setting(&dto.qaProvider))
    .bind(resolve_setting(&dto.qaLlmModel))
    .bind(resolve_setting(&dto.qaVlmModel))
    .bind(resolve_setting(&dto.qaMode))
    .bind(resolve_setting(&dto.routingStrategy))
    .bind(dto.useFallbackModels)
    .bind(dto.useContextMemory)
    .fetch_one(&state.pool)
    .await
    .expect("chapter update");

    // PageService.recalculateSeriesCover parity: cover of lowest-numbered chapter having one.
    sqlx::query(
        "UPDATE series SET cover_image_id = COALESCE((\
             SELECT c.cover_image_id FROM chapters c \
             WHERE c.series_id = $1 AND c.cover_image_id IS NOT NULL \
             ORDER BY c.chapter_number ASC LIMIT 1), NULL) \
         WHERE id = $1",
    )
    .bind(updated.series_id)
    .execute(&state.pool)
    .await
    .expect("series cover recalculation");

    respond_with_chapter_dto(&state, updated).await
}

/// DELETE /api/series/chapters/{chapterId}
pub async fn delete_chapter(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    match sqlx::query("DELETE FROM chapters WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await
    {
        Ok(res) if res.rows_affected() > 0 => StatusCode::OK.into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Loads the chapter's series (Java tolerates a null series via a dummy object) plus
/// global settings, then renders the resolved DTO.
async fn build_chapter_dto(state: &AppState, chapter: &Chapter) -> ChapterDto {
    let series = find_series(&state.pool, chapter.series_id).await;
    let defaults = PipelineDefaults::from_env();
    let global = load_global_settings(&state.pool, &defaults).await;
    to_chapter_dto(state, chapter, series.as_ref(), &global).await
}

async fn respond_with_chapter_dto(state: &AppState, chapter: Chapter) -> Response {
    let dto = build_chapter_dto(state, &chapter).await;
    Json(dto).into_response()
}

/// Sub-router mounted under `/api/series`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", post(create_series).get(list_series))
        .route(
            "/{seriesId}",
            get(get_series).put(update_series).delete(delete_series),
        )
        .route(
            "/{seriesId}/chapters",
            post(create_chapter).get(list_chapters),
        )
        .route(
            "/chapters/{chapterId}",
            get(get_chapter).put(update_chapter).delete(delete_chapter),
        )
}
