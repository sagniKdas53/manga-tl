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

use axum::extract::{Multipart, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
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

    // PageService.recalculateSeriesCover parity via the shared cascade helper.
    crate::clone::recalculate_series_cover(&state.pool, updated.series_id).await;

    respond_with_chapter_dto(&state, updated).await
}

/// DELETE /api/series/chapters/{chapterId}
pub async fn delete_chapter(State(state): State<AppState>, Path(id): Path<Uuid>) -> Response {
    let series_id: Option<Uuid> =
        sqlx::query_scalar("SELECT series_id FROM chapters WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
    match sqlx::query("DELETE FROM chapters WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await
    {
        // SeriesController.java:563-571 recalculates after a successful delete so
        // removing the covered chapter cannot leave a dangling cover image id.
        Ok(res) if res.rows_affected() > 0 => {
            if let Some(series_id) = series_id {
                crate::clone::recalculate_series_cover(&state.pool, series_id).await;
            }
            StatusCode::OK.into_response()
        }
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
        .route("/{seriesId}/chapters/import", post(import_chapter))
        .route("/chapters/{chapterId}/export", get(export_chapter))
        .route(
            "/chapters/{chapterId}/exports",
            axum::routing::delete(clear_exports),
        )
        .route(
            "/chapters/exports/{exportId}/download",
            get(download_export),
        )
}

// ---------------------------------------------------------------------------
// Chapter import + export (Phase 3)
// ---------------------------------------------------------------------------

struct ImportFields {
    chapter_number: Option<f64>,
    title: Option<String>,
    ocr_provider: Option<String>,
    ocr_model: Option<String>,
    tl_provider: Option<String>,
    tl_model: Option<String>,
    qa_provider: Option<String>,
    qa_llm_model: Option<String>,
    qa_vlm_model: Option<String>,
    qa_mode: Option<String>,
    routing_strategy: Option<String>,
    use_fallback_models: Option<bool>,
    file: Option<(String, Vec<u8>)>,
}

/// POST /api/series/{seriesId}/chapters/import — ZIP of images becomes a new chapter;
/// duplicates reuse existing images (cloning pipeline data), fresh ones enter the pipeline.
pub async fn import_chapter(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(series_id): Path<Uuid>,
    mut multipart: Multipart,
) -> Response {
    let mut fields = ImportFields {
        chapter_number: None,
        title: None,
        ocr_provider: None,
        ocr_model: None,
        tl_provider: None,
        tl_model: None,
        qa_provider: None,
        qa_llm_model: None,
        qa_vlm_model: None,
        qa_mode: None,
        routing_strategy: None,
        use_fallback_models: None,
        file: None,
    };

    const INSTANCE: &str = "/api/series/{seriesId}/chapters/import";
    loop {
        // See the matching note in page.rs import_project: swallowing the error here made
        // an over-limit or truncated chapter ZIP look like a well-formed short one.
        let mut field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(err) if error::is_payload_too_large(&err) => {
                return error::payload_too_large(INSTANCE);
            }
            Err(err) => return error::bad_request(&format!("multipart error: {err}"), INSTANCE),
        };
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => {
                let filename = field.file_name().unwrap_or("import.zip").to_string();
                let mut bytes = Vec::new();
                use futures_util::StreamExt;
                while let Some(chunk) = field.next().await {
                    match chunk {
                        Ok(data) => bytes.extend_from_slice(&data),
                        Err(err) if error::is_payload_too_large(&err) => {
                            return error::payload_too_large(INSTANCE);
                        }
                        Err(err) => {
                            return error::bad_request(
                                &format!("file read error: {err}"),
                                INSTANCE,
                            );
                        }
                    }
                }
                fields.file = Some((filename, bytes));
            }
            "chapterNumber" => {
                fields.chapter_number = read_text(field).await.and_then(|v| v.parse().ok());
            }
            "title" => fields.title = read_text(field).await,
            "useFallbackModels" => {
                fields.use_fallback_models = read_text(field).await.map(|v| v == "true");
            }
            "ocrProvider" => fields.ocr_provider = read_text(field).await,
            "ocrModel" => fields.ocr_model = read_text(field).await,
            "tlProvider" => fields.tl_provider = read_text(field).await,
            "tlModel" => fields.tl_model = read_text(field).await,
            "qaProvider" => fields.qa_provider = read_text(field).await,
            "qaLlmModel" => fields.qa_llm_model = read_text(field).await,
            "qaVlmModel" => fields.qa_vlm_model = read_text(field).await,
            "qaMode" => fields.qa_mode = read_text(field).await,
            "routingStrategy" => fields.routing_strategy = read_text(field).await,
            _ => {}
        }
    }

    let Some(chapter_number) = fields.chapter_number else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"message": "chapterNumber is required"})),
        )
            .into_response();
    };
    let Some(title) = fields.title.clone() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"message": "title is required"})),
        )
            .into_response();
    };
    let Some((_, archive_bytes)) = fields.file.take() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"message": "file is required"})),
        )
            .into_response();
    };

    tracing::info!("Importing chapter {title} (num={chapter_number}) for series {series_id}");

    // Series must exist.
    let Some(_series) = find_series(&state.pool, series_id).await else {
        return not_found_series(series_id, "/api/series");
    };

    // Duplicate chapter number → 409 with the exact message shape.
    let dup_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM chapters WHERE series_id=$1 AND chapter_number=$2)",
    )
    .bind(series_id)
    .bind(chapter_number)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(false);
    if dup_exists {
        return (
            axum::http::StatusCode::CONFLICT,
            Json(json!({ "message": format!("Chapter {chapter_number} already exists in this series.") })),
        )
            .into_response();
    }

    // Read the archive BEFORE creating the chapter row (Java deleted the chapter when
    // the archive had no images; we simply refuse earlier).
    let contents = match crate::archive::read_archive(&archive_bytes) {
        Ok(c) => c,
        Err(message) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "message": message })),
            )
                .into_response();
        }
    };
    if contents.images_sorted.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "message": "Archive contains no valid image files." })),
        )
            .into_response();
    }

    // Create the chapter with resolved overrides.
    let chapter_id = Uuid::new_v4();
    let result = sqlx::query(
        "INSERT INTO chapters (id, chapter_number, title, created_at, updated_at, \
         ocr_provider, ocr_model, tl_provider, tl_model, qa_provider, qa_llm_model, qa_vlm_model, qa_mode, \
         routing_strategy, use_fallback_models, use_context_memory, series_id) \
         VALUES ($1,$2,$3,now(),now(),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,TRUE,$14)",
    )
    .bind(chapter_id)
    .bind(chapter_number)
    .bind(&title)
    .bind(resolve_setting(&fields.ocr_provider))
    .bind(resolve_setting(&fields.ocr_model))
    .bind(resolve_setting(&fields.tl_provider))
    .bind(resolve_setting(&fields.tl_model))
    .bind(resolve_setting(&fields.qa_provider))
    .bind(resolve_setting(&fields.qa_llm_model))
    .bind(resolve_setting(&fields.qa_vlm_model))
    .bind(resolve_setting(&fields.qa_mode))
    .bind(resolve_setting(&fields.routing_strategy))
    .bind(fields.use_fallback_models)
    .bind(series_id)
    .execute(&state.pool)
    .await;

    if result.is_err() {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "message": "failed to create chapter" })),
        )
            .into_response();
    }
    let Some(chapter) = find_chapter(&state.pool, chapter_id).await else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "message": "chapter vanished after insert" })),
        )
            .into_response();
    };

    let mut page_number = 1i32;
    for (entry_name, bytes) in &contents.images_sorted {
        let file_hash = {
            use sha2::Digest;
            let digest = sha2::Sha256::digest(bytes);
            hex::encode(digest)
        };

        // Duplicate image? Attach it and clone pipeline data where configs allow.
        let existing: Option<crate::models::Image> =
            sqlx::query_as("SELECT * FROM images WHERE hash = $1 LIMIT 1")
                .bind(&file_hash)
                .fetch_optional(&state.pool)
                .await
                .unwrap_or(None);

        if let Some(existing_image) = existing {
            let page = crate::clone::create_page_with_existing_image(
                &state.pool,
                &chapter,
                existing_image.id,
                page_number,
            )
            .await;
            crate::clone::handle_duplicate_image_cloning(
                &state,
                page.id,
                existing_image.id,
                &chapter,
            )
            .await;
            page_number += 1;
            continue;
        }

        let extension = crate::routes::page::file_extension_of(Some(entry_name));
        let uuid = Uuid::new_v4();
        let storage_path = format!("originals/{uuid}{extension}");
        let content_type = crate::routes::page::content_type_by_extension(&storage_path);
        if state
            .storage
            .upload_bytes(&storage_path, bytes.clone(), content_type)
            .await
            .is_err()
        {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "message": format!("upload failed for {entry_name}") })),
            )
                .into_response();
        }

        let image =
            crate::clone::create_image(&state.pool, entry_name, &storage_path, &file_hash, None)
                .await;
        let page = crate::clone::create_page_with_existing_image(
            &state.pool,
            &chapter,
            image.id,
            page_number,
        )
        .await;
        // Thumbnails generate synchronously here (documented Phase-2 deviation).
        crate::routes::page::generate_thumbnail_pub(&state.storage, &state.pool, image.id, bytes)
            .await;
        crate::jobs::coordinator::start_pipeline(&state, image.id, Some(page.id), Some(chapter.id))
            .await;
        page_number += 1;
    }

    let dto = build_chapter_dto(&state, &chapter).await;
    Json(dto).into_response()
}

async fn read_text(field: axum::extract::multipart::Field<'_>) -> Option<String> {
    let bytes = field.bytes().await.ok()?;
    String::from_utf8(bytes.to_vec()).ok()
}

/// GET /api/series/chapters/{chapterId}/export — accepts the job, builds in background.
pub async fn export_chapter(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chapter_id): Path<Uuid>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    // Chapter must exist (404 otherwise).
    if find_chapter(&state.pool, chapter_id).await.is_none() {
        return error::not_found(
            &format!("Chapter not found: {chapter_id}"),
            "/api/series/chapters/{chapterId}/export",
        );
    }

    let pages_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE chapter_id = $1")
        .bind(chapter_id)
        .fetch_one(&state.pool)
        .await
        .unwrap_or(0);
    if pages_count == 0 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "message": "No pages in chapter" })),
        )
            .into_response();
    }

    let force = params.get("force").map(|v| v == "true").unwrap_or(false);
    // NOTE: like Java, the response's exportId is a RANDOM id; the real cache key is the
    // content hash carried in the SSE notification's context.exportId.
    let export_id = Uuid::new_v4();

    tokio::spawn(async move {
        crate::export::build_and_upload_export(state, chapter_id, Some(user.id), force).await;
    });

    (
        StatusCode::ACCEPTED,
        Json(json!({
            "status": "accepted",
            "exportId": export_id.to_string(),
            "message": "Export started in the background. You will be notified when it is ready.",
        })),
    )
        .into_response()
}

/// DELETE /api/series/chapters/{chapterId}/exports
pub async fn clear_exports(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(chapter_id): Path<Uuid>,
) -> Response {
    crate::export::clear_chapter_exports(&state, chapter_id).await;
    Json(json!({ "message": "Cleared exports for chapter" })).into_response()
}

/// GET /api/series/chapters/exports/{exportId}/download
pub async fn download_export(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(export_id): Path<String>,
) -> Response {
    let key = format!("exports/{export_id}.zip");
    if !state.storage.file_exists(&key).await {
        return (
            StatusCode::GONE,
            Json(json!({ "message": "Export expired, please re-export to download." })),
        )
            .into_response();
    }

    match state.storage.download_bytes(&key).await {
        Some(bytes) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::CONTENT_DISPOSITION,
                header::HeaderValue::from_str(&format!(
                    "attachment; filename=export_{export_id}.zip"
                ))
                .unwrap_or(header::HeaderValue::from_static("attachment")),
            );
            headers.insert(
                header::CONTENT_TYPE,
                header::HeaderValue::from_static("application/zip"),
            );
            (StatusCode::OK, headers, bytes).into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
