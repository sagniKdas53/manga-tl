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
use sqlx::AssertSqlSafe;
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
    pub cleanupMode: Option<String>,
    pub ocrMergeThreshold: Option<f64>,
    pub ocrTextAngle: Option<bool>,
    pub useFallbackModels: Option<bool>,
    pub resolvedUseFallbackModels: bool,
    pub createdAt: chrono::DateTime<chrono::Utc>,
    pub updatedAt: chrono::DateTime<chrono::Utc>,
    /// #226: `series` or `oneshot`.
    pub kind: String,
    /// #226: a one-shot's only chapter, so the library card can open it directly. NULL for a
    /// regular series.
    pub oneshotChapterId: Option<Uuid>,
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
    pub cleanupMode: Option<String>,
    pub ocrMergeThreshold: Option<f64>,
    pub ocrTextAngle: Option<bool>,
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

/// A cleanup-mode override: one of [`crate::settings::CLEANUP_MODES`], or NULL (inherit). An
/// unknown value is stored as NULL rather than handed to the worker to guess at.
fn cleanup_mode_setting(value: &Option<String>) -> Option<String> {
    resolve_setting(value)
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| crate::settings::CLEANUP_MODES.contains(&v.as_str()))
}

/// A grouping-threshold override, clamped like the global one, or NULL (inherit).
fn merge_threshold_setting(value: Option<f64>) -> Option<f64> {
    value
        .filter(|v| v.is_finite())
        .map(crate::settings::ocr_merge_threshold)
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

pub const KIND_SERIES: &str = "series";
pub const KIND_ONESHOT: &str = "oneshot";

/// A series row plus its one-shot chapter, for the DTO's `oneshotChapterId`.
#[derive(sqlx::FromRow)]
struct SeriesRow {
    #[sqlx(flatten)]
    series: Series,
    oneshot_chapter_id: Option<Uuid>,
}

/// `SELECT` of [`SeriesRow`]; callers append `WHERE`/`ORDER BY` on alias `s`.
const SERIES_ROW_SELECT: &str = "SELECT s.*, \
     (SELECT c.id FROM chapters c WHERE c.series_id = s.id AND s.kind = 'oneshot' \
      ORDER BY c.chapter_number LIMIT 1) AS oneshot_chapter_id \
     FROM series s";

async fn find_series_row(pool: &sqlx::PgPool, id: Uuid) -> Option<SeriesRow> {
    sqlx::query_as(AssertSqlSafe(format!(
        "{SERIES_ROW_SELECT} WHERE s.id = $1"
    )))
    .bind(id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

fn to_series_dto(
    state: &AppState,
    s: &Series,
    resolved_use_fallback: bool,
    oneshot_chapter_id: Option<Uuid>,
) -> SeriesDto {
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
        cleanupMode: s.cleanup_mode.clone(),
        ocrMergeThreshold: s.ocr_merge_threshold,
        ocrTextAngle: s.ocr_text_angle,
        useFallbackModels: s.use_fallback_models,
        resolvedUseFallbackModels: resolved_use_fallback,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        // Empty only when the row was read before the upgrade script added the column.
        kind: if s.kind.is_empty() {
            KIND_SERIES.to_string()
        } else {
            s.kind.clone()
        },
        oneshotChapterId: oneshot_chapter_id,
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
        cleanupMode: chapter.cleanup_mode.clone(),
        ocrMergeThreshold: chapter.ocr_merge_threshold,
        ocrTextAngle: chapter.ocr_text_angle,
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
    pub cleanupMode: Option<String>,
    #[serde(default)]
    pub ocrMergeThreshold: Option<f64>,
    /// E2 (#180): NULL (absent) = inherit.
    #[serde(default)]
    pub ocrTextAngle: Option<bool>,
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
    pub cleanupMode: Option<String>,
    #[serde(default)]
    pub ocrMergeThreshold: Option<f64>,
    /// E2 (#180): NULL (absent) = inherit.
    #[serde(default)]
    pub ocrTextAngle: Option<bool>,
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

    /// AUDIT-T4: `page * size` is an `i64` multiply on a client-supplied number, bounded below
    /// but not above, so `?page=9223372036854775807&size=100` overflowed — 500 in a debug build,
    /// and in release a wrapped *negative* OFFSET that Postgres rejects, which
    /// `unwrap_or_default()` then served as an empty list beside an honest `totalElements`.
    /// Saturating keeps the requested page in the envelope and reads as what it is: past the end.
    fn offset(&self, size: i64) -> i64 {
        self.page.unwrap_or(0).max(0).saturating_mul(size)
    }

    /// AUDIT-T4: matched `"desc"`/`"asc"` exactly, so `?sortDir=DESC` — which Spring's
    /// `Sort.Direction.fromString` accepted, being case-insensitive — silently fell through to
    /// the endpoint's default. The worst shape of parity break: 200, with plausible data.
    fn descending(&self, default_asc: bool) -> bool {
        match self.sortDir.as_deref() {
            Some(d) if d.eq_ignore_ascii_case("desc") => true,
            Some(d) if d.eq_ignore_ascii_case("asc") => false,
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
         routing_strategy, use_fallback_models, created_by, cleanup_mode, ocr_merge_threshold, \
         ocr_text_angle) \
         VALUES ($1, now(), now(), $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, \
                 $14, $15, $16, $17, $18, $19) RETURNING *",
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
    .bind(cleanup_mode_setting(&dto.cleanupMode))
    .bind(merge_threshold_setting(dto.ocrMergeThreshold))
    .bind(dto.ocrTextAngle)
    .fetch_one(&state.pool)
    .await
    .expect("series insert");

    // resolvedUseFallbackModels falls back to the global setting when unset on the entity.
    let defaults = PipelineDefaults::from_env();
    let global = load_global_settings(&state.pool, &defaults).await;
    let resolved = series
        .use_fallback_models
        .unwrap_or(global.use_fallback_models);
    Json(to_series_dto(&state, &series, resolved, None)).into_response()
}

#[derive(Deserialize)]
pub struct SeriesFilter {
    #[serde(default)]
    pub kind: Option<String>,
}

/// GET /api/series — paginated, sortable by createdAt|updatedAt only. `?kind=series|oneshot`
/// narrows the list (#226); absent or anything else lists both, like the sort whitelist.
pub async fn list_series(
    State(state): State<AppState>,
    Query(p): Query<Pagination>,
    Query(filter): Query<SeriesFilter>,
) -> Response {
    let (page, size) = p.bounds(10);
    let column = p.sort_column(&["createdAt", "updatedAt"], "updatedAt");
    let direction = if p.descending(false) { "DESC" } else { "ASC" };
    let kind: Option<&str> = filter
        .kind
        .as_deref()
        .filter(|k| *k == KIND_SERIES || *k == KIND_ONESHOT);

    let total: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM series WHERE ($1::text IS NULL OR kind = $1)")
            .bind(kind)
            .fetch_one(&state.pool)
            .await
            .unwrap_or(0);

    let order_column = if column == "createdAt" {
        "created_at"
    } else {
        "updated_at"
    };
    // AssertSqlSafe audit (sqlx 0.9): no client text reaches this statement.
    // `order_column` and `direction` are `&'static str` literals picked by the
    // branches above; `size` is clamped to 1..=100 by `bounds`, and `offset` is a
    // saturating, non-negative i64. `kind` is bound, never formatted in.
    let rows: Vec<SeriesRow> = sqlx::query_as(AssertSqlSafe(format!(
        "{SERIES_ROW_SELECT} WHERE ($1::text IS NULL OR s.kind = $1) \
         ORDER BY s.{order_column} {direction} LIMIT {size} OFFSET {}",
        p.offset(size)
    )))
    .bind(kind)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let defaults = PipelineDefaults::from_env();
    let global = load_global_settings(&state.pool, &defaults).await;
    let content: Vec<SeriesDto> = rows
        .iter()
        .map(|row| {
            let s = &row.series;
            let resolved = s.use_fallback_models.unwrap_or(global.use_fallback_models);
            to_series_dto(&state, s, resolved, row.oneshot_chapter_id)
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
    match find_series_row(&state.pool, id).await {
        Some(row) => {
            let defaults = PipelineDefaults::from_env();
            let global = load_global_settings(&state.pool, &defaults).await;
            let resolved = row
                .series
                .use_fallback_models
                .unwrap_or(global.use_fallback_models);
            Json(to_series_dto(
                &state,
                &row.series,
                resolved,
                row.oneshot_chapter_id,
            ))
            .into_response()
        }
        None => StatusCode::NOT_FOUND.into_response(),
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
         use_fallback_models = $15, cleanup_mode = $16, ocr_merge_threshold = $17, \
         ocr_text_angle = $18, updated_at = now() WHERE id = $1 RETURNING *",
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
    .bind(cleanup_mode_setting(&dto.cleanupMode))
    .bind(merge_threshold_setting(dto.ocrMergeThreshold))
    .bind(dto.ocrTextAngle)
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
            let oneshot_chapter_id = match series.kind.as_str() {
                KIND_ONESHOT => find_series_row(&state.pool, id)
                    .await
                    .and_then(|row| row.oneshot_chapter_id),
                _ => None,
            };
            Json(to_series_dto(&state, &series, resolved, oneshot_chapter_id)).into_response()
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
    let result = delete_with_page_jobs(
        &state.pool,
        "DELETE FROM series WHERE id = $1",
        id,
        crate::jobs::coordinator::DeletedPages::Series(id),
    )
    .await;
    match result {
        Ok(res) if res.rows_affected() > 0 => StatusCode::OK.into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Runs `delete` (a series or chapter DELETE bound to `id`) together with the deletion of its
/// pages' unfinished jobs, in one transaction. The pages go by cascade; their queued jobs would
/// not (`drop_unfinished_page_jobs`).
async fn delete_with_page_jobs(
    pool: &sqlx::PgPool,
    delete: &'static str,
    id: Uuid,
    pages: crate::jobs::coordinator::DeletedPages,
) -> Result<sqlx::postgres::PgQueryResult, sqlx::Error> {
    let mut tx = pool.begin().await?;
    crate::jobs::coordinator::drop_unfinished_page_jobs(&mut tx, pages).await?;
    let result = sqlx::query(delete).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(result)
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

/// Why a chapter can't be added to a series (see [`lock_series_for_new_chapter`]).
enum NewChapterRefusal {
    NoSeries,
    OneshotFull,
    Db(sqlx::Error),
}

const ONESHOT_FULL_MESSAGE: &str = "A one-shot holds one chapter. Move it into a series first.";

/// Locks the series row for the rest of `tx` and refuses a second chapter in a one-shot
/// (#226). The database can't hold that rule (a CHECK can't look at another table), so every
/// chapter INSERT goes through here; the row lock keeps two concurrent adds from both passing.
async fn lock_series_for_new_chapter(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    series_id: Uuid,
) -> Result<(), NewChapterRefusal> {
    let kind: Option<String> =
        sqlx::query_scalar("SELECT kind FROM series WHERE id = $1 FOR UPDATE")
            .bind(series_id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(NewChapterRefusal::Db)?;
    let Some(kind) = kind else {
        return Err(NewChapterRefusal::NoSeries);
    };
    if kind == KIND_ONESHOT {
        let has_chapter: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chapters WHERE series_id = $1)")
                .bind(series_id)
                .fetch_one(&mut **tx)
                .await
                .map_err(NewChapterRefusal::Db)?;
        if has_chapter {
            return Err(NewChapterRefusal::OneshotFull);
        }
    }
    Ok(())
}

fn oneshot_full() -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({ "message": ONESHOT_FULL_MESSAGE })),
    )
        .into_response()
}

/// The chapter INSERT shared by create, import and the one-shot routes. `useContextMemory`
/// absent means TRUE (Java: dto.useContextMemory() == null || dto.useContextMemory()).
async fn insert_chapter(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    series_id: Uuid,
    number: f64,
    dto: &ChapterInput,
) -> Result<Chapter, sqlx::Error> {
    sqlx::query_as(
        "INSERT INTO chapters (id, created_at, updated_at, series_id, chapter_number, title, \
         ocr_provider, ocr_model, tl_provider, tl_model, qa_provider, qa_llm_model, \
         qa_vlm_model, qa_mode, routing_strategy, use_context_memory, use_fallback_models, cleanup_mode, \
         ocr_merge_threshold, ocr_text_angle) \
         VALUES ($1, now(), now(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) \
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
    .bind(dto.useContextMemory.unwrap_or(true))
    .bind(dto.useFallbackModels)
    .bind(cleanup_mode_setting(&dto.cleanupMode))
    .bind(merge_threshold_setting(dto.ocrMergeThreshold))
    .bind(dto.ocrTextAngle)
    .fetch_one(&mut **tx)
    .await
}

async fn chapter_number_taken(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    series_id: Uuid,
    number: f64,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM chapters WHERE series_id = $1 AND chapter_number = $2)",
    )
    .bind(series_id)
    .bind(number)
    .fetch_one(&mut **tx)
    .await
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
    let number = dto.chapterNumber.unwrap_or(0.0);

    let chapter = async {
        let mut tx = state.pool.begin().await.map_err(NewChapterRefusal::Db)?;
        lock_series_for_new_chapter(&mut tx, series_id).await?;
        if chapter_number_taken(&mut tx, series_id, number)
            .await
            .map_err(NewChapterRefusal::Db)?
        {
            return Ok(None);
        }
        let chapter = insert_chapter(&mut tx, series_id, number, &dto)
            .await
            .map_err(NewChapterRefusal::Db)?;
        tx.commit().await.map_err(NewChapterRefusal::Db)?;
        Ok(Some(chapter))
    }
    .await;

    match chapter {
        Ok(Some(chapter)) => respond_with_chapter_dto(&state, chapter).await,
        Ok(None) => duplicate_message(number),
        Err(NewChapterRefusal::NoSeries) => not_found_series(series_id, &instance),
        Err(NewChapterRefusal::OneshotFull) => oneshot_full(),
        Err(NewChapterRefusal::Db(err)) => {
            tracing::error!("create chapter in series {series_id}: {err}");
            error::internal_error(&instance)
        }
    }
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

    // AssertSqlSafe audit (sqlx 0.9): no client text reaches this statement.
    // `direction` is a `&'static str` literal picked by the branch above; `size` is
    // clamped to 1..=100 by `bounds`, and `offset` is a saturating, non-negative i64.
    let rows: Vec<Chapter> = sqlx::query_as(AssertSqlSafe(format!(
        "SELECT * FROM chapters WHERE series_id = $1 \
         ORDER BY chapter_number {direction} LIMIT {size} OFFSET {}",
        p.offset(size)
    )))
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
         cleanup_mode = $15, ocr_merge_threshold = $16, ocr_text_angle = $17, updated_at = now() \
         WHERE id = $1 RETURNING *",
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
    .bind(cleanup_mode_setting(&dto.cleanupMode))
    .bind(merge_threshold_setting(dto.ocrMergeThreshold))
    .bind(dto.ocrTextAngle)
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
    match delete_with_page_jobs(
        &state.pool,
        "DELETE FROM chapters WHERE id = $1",
        id,
        crate::jobs::coordinator::DeletedPages::Chapter(id),
    )
    .await
    {
        // SeriesController.java:563-571 recalculates after a successful delete so
        // removing the covered chapter cannot leave a dangling cover image id.
        Ok(res) if res.rows_affected() > 0 => {
            if let Some(series_id) = series_id {
                // #226: a one-shot is its chapter, so it goes too rather than staying in the
                // library as an empty card. A regular series is never deleted here.
                let removed = sqlx::query(
                    "DELETE FROM series WHERE id = $1 AND kind = 'oneshot' \
                     AND NOT EXISTS (SELECT 1 FROM chapters WHERE series_id = $1)",
                )
                .bind(series_id)
                .execute(&state.pool)
                .await
                .map(|r| r.rows_affected() > 0)
                .unwrap_or(false);
                if !removed {
                    crate::clone::recalculate_series_cover(&state.pool, series_id).await;
                }
            }
            StatusCode::OK.into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

// ---------------------------------------------------------------------------
// Moving a chapter (#226, for #218's Move dialog)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[allow(non_snake_case)]
pub struct MoveChapterInput {
    /// The series to move into. Exactly one of this and `oneshot`.
    #[serde(default)]
    pub seriesId: Option<Uuid>,
    /// Move out to the library as a new one-shot.
    #[serde(default)]
    pub oneshot: bool,
    /// The number in the destination; absent keeps the current one (a one-shot is always 1).
    #[serde(default)]
    pub chapterNumber: Option<f64>,
    /// Write onto the chapter the values it resolved to before the move, wherever the new series
    /// would resolve it differently, so it keeps behaving the same.
    #[serde(default)]
    pub keepSettings: bool,
}

#[derive(Serialize)]
#[allow(non_snake_case)]
pub struct MoveChapterDto {
    pub chapter: ChapterDto,
    /// The series the chapter is in now.
    pub series: SeriesDto,
    /// The one-shot the move emptied and deleted, if any.
    pub removedSeriesId: Option<Uuid>,
}

/// The chapter's settings columns, in the order `move_chapter`'s UPDATE binds them.
#[derive(Clone, Debug, PartialEq)]
struct ChapterSettings {
    ocr_provider: Option<String>,
    ocr_model: Option<String>,
    tl_provider: Option<String>,
    tl_model: Option<String>,
    qa_provider: Option<String>,
    qa_llm_model: Option<String>,
    qa_vlm_model: Option<String>,
    qa_mode: Option<String>,
    routing_strategy: Option<String>,
    cleanup_mode: Option<String>,
    ocr_merge_threshold: Option<f64>,
    ocr_text_angle: Option<bool>,
    use_fallback_models: Option<bool>,
}

impl ChapterSettings {
    fn of_chapter(c: &Chapter) -> Self {
        Self {
            ocr_provider: c.ocr_provider.clone(),
            ocr_model: c.ocr_model.clone(),
            tl_provider: c.tl_provider.clone(),
            tl_model: c.tl_model.clone(),
            qa_provider: c.qa_provider.clone(),
            qa_llm_model: c.qa_llm_model.clone(),
            qa_vlm_model: c.qa_vlm_model.clone(),
            qa_mode: c.qa_mode.clone(),
            routing_strategy: c.routing_strategy.clone(),
            cleanup_mode: c.cleanup_mode.clone(),
            ocr_merge_threshold: c.ocr_merge_threshold,
            ocr_text_angle: c.ocr_text_angle,
            use_fallback_models: c.use_fallback_models,
        }
    }

    fn of_series(s: &Series) -> Self {
        Self {
            ocr_provider: s.ocr_provider.clone(),
            ocr_model: s.ocr_model.clone(),
            tl_provider: s.tl_provider.clone(),
            tl_model: s.tl_model.clone(),
            qa_provider: s.qa_provider.clone(),
            qa_llm_model: s.qa_llm_model.clone(),
            qa_vlm_model: s.qa_vlm_model.clone(),
            qa_mode: s.qa_mode.clone(),
            routing_strategy: s.routing_strategy.clone(),
            cleanup_mode: s.cleanup_mode.clone(),
            ocr_merge_threshold: s.ocr_merge_threshold,
            ocr_text_angle: s.ocr_text_angle,
            use_fallback_models: s.use_fallback_models,
        }
    }

    fn of_global(g: &GlobalSettings) -> Self {
        let text = |v: &str| Some(v.to_string()).filter(|v| !v.trim().is_empty());
        Self {
            ocr_provider: text(&g.ocr_provider),
            ocr_model: text(&g.ocr_model),
            tl_provider: text(&g.tl_provider),
            tl_model: text(&g.tl_model),
            qa_provider: text(&g.qa_provider),
            qa_llm_model: text(&g.qa_llm_model),
            qa_vlm_model: text(&g.qa_vlm_model),
            qa_mode: text(&g.qa_mode),
            routing_strategy: text(&g.routing_strategy),
            cleanup_mode: text(&g.cleanup_mode),
            ocr_merge_threshold: Some(g.ocr_merge_threshold),
            ocr_text_angle: Some(g.ocr_text_angle),
            use_fallback_models: Some(g.use_fallback_models),
        }
    }
}

/// `keepSettings`: for each setting the chapter leaves unset, the value it resolves to through
/// `from` (chapter -> series -> global) is written onto it when resolving through `to` would give
/// something else. Settings the chapter sets itself, and ones both series resolve alike, stay as
/// they are, so the chapter still follows later System Settings changes where it can.
fn pin_settings(
    chapter: &ChapterSettings,
    from: &ChapterSettings,
    to: &ChapterSettings,
    global: &ChapterSettings,
) -> ChapterSettings {
    fn pin<T: Clone + PartialEq>(
        chapter: &Option<T>,
        from: &Option<T>,
        to: &Option<T>,
        global: &Option<T>,
    ) -> Option<T> {
        if chapter.is_some() {
            return chapter.clone();
        }
        let before = from.clone().or_else(|| global.clone());
        let after = to.clone().or_else(|| global.clone());
        if before != after { before } else { None }
    }
    ChapterSettings {
        ocr_provider: pin(
            &chapter.ocr_provider,
            &from.ocr_provider,
            &to.ocr_provider,
            &global.ocr_provider,
        ),
        ocr_model: pin(
            &chapter.ocr_model,
            &from.ocr_model,
            &to.ocr_model,
            &global.ocr_model,
        ),
        tl_provider: pin(
            &chapter.tl_provider,
            &from.tl_provider,
            &to.tl_provider,
            &global.tl_provider,
        ),
        tl_model: pin(
            &chapter.tl_model,
            &from.tl_model,
            &to.tl_model,
            &global.tl_model,
        ),
        qa_provider: pin(
            &chapter.qa_provider,
            &from.qa_provider,
            &to.qa_provider,
            &global.qa_provider,
        ),
        qa_llm_model: pin(
            &chapter.qa_llm_model,
            &from.qa_llm_model,
            &to.qa_llm_model,
            &global.qa_llm_model,
        ),
        qa_vlm_model: pin(
            &chapter.qa_vlm_model,
            &from.qa_vlm_model,
            &to.qa_vlm_model,
            &global.qa_vlm_model,
        ),
        qa_mode: pin(
            &chapter.qa_mode,
            &from.qa_mode,
            &to.qa_mode,
            &global.qa_mode,
        ),
        routing_strategy: pin(
            &chapter.routing_strategy,
            &from.routing_strategy,
            &to.routing_strategy,
            &global.routing_strategy,
        ),
        cleanup_mode: pin(
            &chapter.cleanup_mode,
            &from.cleanup_mode,
            &to.cleanup_mode,
            &global.cleanup_mode,
        ),
        ocr_merge_threshold: pin(
            &chapter.ocr_merge_threshold,
            &from.ocr_merge_threshold,
            &to.ocr_merge_threshold,
            &global.ocr_merge_threshold,
        ),
        ocr_text_angle: pin(
            &chapter.ocr_text_angle,
            &from.ocr_text_angle,
            &to.ocr_text_angle,
            &global.ocr_text_angle,
        ),
        use_fallback_models: pin(
            &chapter.use_fallback_models,
            &from.use_fallback_models,
            &to.use_fallback_models,
            &global.use_fallback_models,
        ),
    }
}

/// Why a move was refused.
enum MoveRefusal {
    Response(Response),
    Db(sqlx::Error),
}

impl From<sqlx::Error> for MoveRefusal {
    fn from(err: sqlx::Error) -> Self {
        MoveRefusal::Db(err)
    }
}

/// The lowest whole number above every chapter number in `series_id` (1 for an empty series).
async fn next_free_chapter_number(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    series_id: Uuid,
) -> Result<f64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT COALESCE(FLOOR(MAX(chapter_number)), 0) + 1 FROM chapters WHERE series_id = $1",
    )
    .bind(series_id)
    .fetch_one(&mut **tx)
    .await
}

/// POST /api/series/chapters/{chapterId}/move — into another series (`seriesId`) or out to the
/// library as a one-shot (`oneshot: true`). One transaction: the chapter row and both series rows
/// are locked. Leaving a one-shot deletes it (never a regular series). Pages, layers, renders and
/// jobs are not touched and nothing re-renders.
pub async fn move_chapter(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chapter_id): Path<Uuid>,
    body: Result<Json<MoveChapterInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    const INSTANCE: &str = "/api/series/chapters/{chapterId}/move";
    let Json(dto) = match body {
        Ok(json) => json,
        Err(_) => return error::unreadable_body(INSTANCE),
    };
    if dto.seriesId.is_some() == dto.oneshot {
        return error::bad_request("Send either seriesId or oneshot: true.", INSTANCE);
    }
    if dto
        .chapterNumber
        .is_some_and(|n| !n.is_finite() || n <= 0.0)
    {
        return error::bad_request("chapterNumber must be a positive number.", INSTANCE);
    }
    let defaults = PipelineDefaults::from_env();
    let global = load_global_settings(&state.pool, &defaults).await;

    let moved = async {
        let mut tx = state.pool.begin().await?;
        let chapter: Option<Chapter> =
            sqlx::query_as("SELECT * FROM chapters WHERE id = $1 FOR UPDATE")
                .bind(chapter_id)
                .fetch_optional(&mut *tx)
                .await?;
        let Some(chapter) = chapter else {
            return Err(MoveRefusal::Response(error::not_found(
                &format!("Chapter not found: {chapter_id}"),
                INSTANCE,
            )));
        };
        let source_id = chapter.series_id;

        // Lock in id order, so two moves between the same pair of series can't deadlock.
        let mut ids = vec![source_id];
        if let Some(target_id) = dto.seriesId {
            if target_id == source_id {
                return Err(MoveRefusal::Response(error::bad_request(
                    "The chapter is already in that series.",
                    INSTANCE,
                )));
            }
            ids.push(target_id);
        }
        let locked: Vec<Series> =
            sqlx::query_as("SELECT * FROM series WHERE id = ANY($1) ORDER BY id FOR UPDATE")
                .bind(&ids)
                .fetch_all(&mut *tx)
                .await?;
        let Some(source) = locked.iter().find(|s| s.id == source_id).cloned() else {
            return Err(MoveRefusal::Response(not_found_series(source_id, INSTANCE)));
        };

        let target = match dto.seriesId {
            Some(target_id) => {
                let Some(target) = locked.iter().find(|s| s.id == target_id).cloned() else {
                    return Err(MoveRefusal::Response(not_found_series(target_id, INSTANCE)));
                };
                if target.kind == KIND_ONESHOT {
                    let has_chapter: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM chapters WHERE series_id = $1)",
                    )
                    .bind(target.id)
                    .fetch_one(&mut *tx)
                    .await?;
                    if has_chapter {
                        return Err(MoveRefusal::Response(oneshot_full()));
                    }
                }
                target
            }
            None => {
                if source.kind == KIND_ONESHOT {
                    return Err(MoveRefusal::Response(error::bad_request(
                        "The chapter is already a one-shot.",
                        INSTANCE,
                    )));
                }
                // The new one-shot takes the source series' languages and reading direction, and
                // the chapter's title (or "<series> — Chapter <n>").
                let title = chapter
                    .title
                    .as_deref()
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        format!("{} — Chapter {}", source.title, chapter.chapter_number)
                    });
                sqlx::query_as(
                    "INSERT INTO series (id, created_at, updated_at, title, original_language, \
                     source_language, target_language, reading_direction, created_by, kind) \
                     VALUES ($1, now(), now(), $2, $3, $4, $5, $6, $7, 'oneshot') RETURNING *",
                )
                .bind(Uuid::new_v4())
                .bind(&title)
                .bind(&source.original_language)
                .bind(&source.source_language)
                .bind(&source.target_language)
                .bind(&source.reading_direction)
                .bind(user.id)
                .fetch_one(&mut *tx)
                .await?
            }
        };

        let number = if dto.oneshot {
            ONESHOT_CHAPTER_NUMBER
        } else {
            dto.chapterNumber.unwrap_or(chapter.chapter_number)
        };
        if chapter_number_taken(&mut tx, target.id, number).await? {
            let next = next_free_chapter_number(&mut tx, target.id).await?;
            return Err(MoveRefusal::Response(
                (
                    StatusCode::CONFLICT,
                    Json(json!({
                        "message": format!("Chapter {number} already exists in {}.", target.title),
                        "nextFreeNumber": next,
                    })),
                )
                    .into_response(),
            ));
        }

        let own = ChapterSettings::of_chapter(&chapter);
        let settings = if dto.keepSettings {
            pin_settings(
                &own,
                &ChapterSettings::of_series(&source),
                &ChapterSettings::of_series(&target),
                &ChapterSettings::of_global(&global),
            )
        } else {
            own
        };
        let moved: Chapter = sqlx::query_as(
            "UPDATE chapters SET series_id = $2, chapter_number = $3, ocr_provider = $4, \
             ocr_model = $5, tl_provider = $6, tl_model = $7, qa_provider = $8, \
             qa_llm_model = $9, qa_vlm_model = $10, qa_mode = $11, routing_strategy = $12, \
             cleanup_mode = $13, ocr_merge_threshold = $14, ocr_text_angle = $15, \
             use_fallback_models = $16, updated_at = now() WHERE id = $1 RETURNING *",
        )
        .bind(chapter.id)
        .bind(target.id)
        .bind(number)
        .bind(&settings.ocr_provider)
        .bind(&settings.ocr_model)
        .bind(&settings.tl_provider)
        .bind(&settings.tl_model)
        .bind(&settings.qa_provider)
        .bind(&settings.qa_llm_model)
        .bind(&settings.qa_vlm_model)
        .bind(&settings.qa_mode)
        .bind(&settings.routing_strategy)
        .bind(&settings.cleanup_mode)
        .bind(settings.ocr_merge_threshold)
        .bind(settings.ocr_text_angle)
        .bind(settings.use_fallback_models)
        .fetch_one(&mut *tx)
        .await?;

        // After the chapter has left: deleting first would take it along by cascade.
        let removed = sqlx::query(
            "DELETE FROM series WHERE id = $1 AND kind = 'oneshot' \
             AND NOT EXISTS (SELECT 1 FROM chapters WHERE series_id = $1)",
        )
        .bind(source.id)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            > 0;
        sqlx::query("UPDATE series SET updated_at = now() WHERE id = ANY($1)")
            .bind(vec![source.id, target.id])
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok((
            moved,
            target.id,
            (!removed).then_some(source.id),
            removed.then_some(source.id),
        ))
    }
    .await;

    let (chapter, target_id, source_left, removed) = match moved {
        Ok(moved) => moved,
        Err(MoveRefusal::Response(response)) => return response,
        Err(MoveRefusal::Db(err)) => {
            tracing::error!("move chapter {chapter_id}: {err}");
            return error::internal_error(INSTANCE);
        }
    };
    // Covers use the pool, so they follow the commit.
    crate::clone::recalculate_series_cover(&state.pool, target_id).await;
    if let Some(source_id) = source_left {
        crate::clone::recalculate_series_cover(&state.pool, source_id).await;
    }

    let Some(row) = find_series_row(&state.pool, target_id).await else {
        return error::internal_error(INSTANCE);
    };
    let chapter = find_chapter(&state.pool, chapter.id)
        .await
        .unwrap_or(chapter);
    let resolved = row
        .series
        .use_fallback_models
        .unwrap_or(global.use_fallback_models);
    let chapter_dto = to_chapter_dto(&state, &chapter, Some(&row.series), &global).await;
    Json(MoveChapterDto {
        chapter: chapter_dto,
        series: to_series_dto(&state, &row.series, resolved, row.oneshot_chapter_id),
        removedSeriesId: removed,
    })
    .into_response()
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
        .route("/oneshots", post(create_oneshot))
        .route("/oneshots/import", post(import_oneshot))
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
        .route("/chapters/{chapterId}/move", post(move_chapter))
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
    cleanup_mode: Option<String>,
    ocr_merge_threshold: Option<f64>,
    ocr_text_angle: Option<bool>,
    use_fallback_models: Option<bool>,
    // One-shot import only (#226): the one-shot series carries the languages and direction.
    source_language: Option<String>,
    target_language: Option<String>,
    reading_direction: Option<String>,
    file: Option<(String, Vec<u8>)>,
}

impl ImportFields {
    /// The chapter's own fields, for [`insert_chapter`]. An import always uses context memory.
    fn chapter_input(&self, title: &str) -> ChapterInput {
        ChapterInput {
            chapterNumber: self.chapter_number,
            title: Some(title.to_string()),
            ocrProvider: self.ocr_provider.clone(),
            ocrModel: self.ocr_model.clone(),
            tlProvider: self.tl_provider.clone(),
            tlModel: self.tl_model.clone(),
            qaProvider: self.qa_provider.clone(),
            qaLlmModel: self.qa_llm_model.clone(),
            qaVlmModel: self.qa_vlm_model.clone(),
            qaMode: self.qa_mode.clone(),
            routingStrategy: self.routing_strategy.clone(),
            cleanupMode: self.cleanup_mode.clone(),
            ocrMergeThreshold: self.ocr_merge_threshold,
            ocrTextAngle: self.ocr_text_angle,
            useContextMemory: Some(true),
            useFallbackModels: self.use_fallback_models,
        }
    }
}

/// Reads an import's multipart form. Unknown fields are ignored.
#[allow(clippy::result_large_err)]
async fn read_import_fields(
    multipart: &mut Multipart,
    instance: &str,
) -> Result<ImportFields, Response> {
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
        cleanup_mode: None,
        ocr_merge_threshold: None,
        ocr_text_angle: None,
        use_fallback_models: None,
        source_language: None,
        target_language: None,
        reading_direction: None,
        file: None,
    };

    loop {
        // See the matching note in page.rs import_project: swallowing the error here made
        // an over-limit or truncated chapter ZIP look like a well-formed short one.
        let mut field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(err) if error::is_payload_too_large(&err) => {
                return Err(error::payload_too_large(instance));
            }
            Err(err) => {
                return Err(error::bad_request(
                    &format!("multipart error: {err}"),
                    instance,
                ));
            }
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
                            return Err(error::payload_too_large(instance));
                        }
                        Err(err) => {
                            return Err(error::bad_request(
                                &format!("file read error: {err}"),
                                instance,
                            ));
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
            "cleanupMode" => fields.cleanup_mode = read_text(field).await,
            "ocrMergeThreshold" => {
                fields.ocr_merge_threshold =
                    read_text(field).await.and_then(|v| v.trim().parse().ok());
            }
            // "true"/"false"; anything else ("inherit", empty) leaves the chapter inheriting.
            "ocrTextAngle" => {
                fields.ocr_text_angle = read_text(field).await.and_then(|v| v.trim().parse().ok());
            }
            // `originalLanguage` is the older name; `sourceLanguage` wins when both are sent.
            "sourceLanguage" => fields.source_language = read_text(field).await,
            "originalLanguage" => {
                let value = read_text(field).await;
                if fields.source_language.is_none() {
                    fields.source_language = value;
                }
            }
            "targetLanguage" => fields.target_language = read_text(field).await,
            "readingDirection" => fields.reading_direction = read_text(field).await,
            _ => {}
        }
    }
    Ok(fields)
}

/// Reads the archive before anything is created (Java deleted the chapter when the archive
/// had no images; we refuse earlier).
#[allow(clippy::result_large_err)]
fn read_import_archive(bytes: &[u8]) -> Result<crate::archive::ArchiveContents, Response> {
    let contents = crate::archive::read_archive(bytes).map_err(|message| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "message": message })),
        )
            .into_response()
    })?;
    if contents.images_sorted.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "message": "Archive contains no valid image files." })),
        )
            .into_response());
    }
    Ok(contents)
}

/// Adds the archive's images to `chapter` as pages in order. Duplicates reuse existing images
/// (cloning pipeline data); fresh ones are uploaded and enter the pipeline. The importing user
/// owns the images. Not transactional: each page is committed, uploaded and queued as it goes.
#[allow(clippy::result_large_err)]
async fn import_pages(
    state: &AppState,
    user_id: Uuid,
    chapter: &Chapter,
    contents: &crate::archive::ArchiveContents,
) -> Result<(), Response> {
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
                chapter,
                existing_image.id,
                page_number,
            )
            .await;
            crate::clone::handle_duplicate_image_cloning(
                state,
                page.id,
                existing_image.id,
                chapter,
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
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "message": format!("upload failed for {entry_name}") })),
            )
                .into_response());
        }

        let image =
            // The importer owns the image. Job events go only to an image's owner
            // (`SseService::emit_event_for_image`), so an ownerless import never reached anyone's
            // queue until a reload refetched `/api/jobs` (#212).
            crate::clone::create_image(
                &state.pool,
                entry_name,
                &storage_path,
                &file_hash,
                Some(user_id),
            )
            .await;
        let page = crate::clone::create_page_with_existing_image(
            &state.pool,
            chapter,
            image.id,
            page_number,
        )
        .await;
        // Thumbnails generate synchronously here (documented Phase-2 deviation).
        crate::routes::page::generate_thumbnail_pub(&state.storage, &state.pool, image.id, bytes)
            .await;
        crate::jobs::coordinator::start_pipeline(state, image.id, Some(page.id), Some(chapter.id))
            .await;
        page_number += 1;
    }

    Ok(())
}

fn missing_field(message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "message": message })),
    )
        .into_response()
}

/// POST /api/series/{seriesId}/chapters/import — ZIP of images becomes a new chapter;
/// duplicates reuse existing images (cloning pipeline data), fresh ones enter the pipeline.
pub async fn import_chapter(
    State(state): State<AppState>,
    user: AuthUser,
    Path(series_id): Path<Uuid>,
    mut multipart: Multipart,
) -> Response {
    const INSTANCE: &str = "/api/series/{seriesId}/chapters/import";
    let mut fields = match read_import_fields(&mut multipart, INSTANCE).await {
        Ok(fields) => fields,
        Err(response) => return response,
    };

    let Some(chapter_number) = fields.chapter_number else {
        return missing_field("chapterNumber is required");
    };
    let Some(title) = fields.title.clone() else {
        return missing_field("title is required");
    };
    let Some((_, archive_bytes)) = fields.file.take() else {
        return missing_field("file is required");
    };

    tracing::info!("Importing chapter {title} (num={chapter_number}) for series {series_id}");

    let contents = match read_import_archive(&archive_bytes) {
        Ok(contents) => contents,
        Err(response) => return response,
    };

    let chapter = async {
        let mut tx = state.pool.begin().await.map_err(NewChapterRefusal::Db)?;
        lock_series_for_new_chapter(&mut tx, series_id).await?;
        if chapter_number_taken(&mut tx, series_id, chapter_number)
            .await
            .map_err(NewChapterRefusal::Db)?
        {
            return Ok(None);
        }
        let chapter = insert_chapter(
            &mut tx,
            series_id,
            chapter_number,
            &fields.chapter_input(&title),
        )
        .await
        .map_err(NewChapterRefusal::Db)?;
        tx.commit().await.map_err(NewChapterRefusal::Db)?;
        Ok(Some(chapter))
    }
    .await;

    let chapter = match chapter {
        Ok(Some(chapter)) => chapter,
        // Duplicate chapter number → 409 with the exact message shape.
        Ok(None) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({ "message": format!("Chapter {chapter_number} already exists in this series.") })),
            )
                .into_response();
        }
        Err(NewChapterRefusal::NoSeries) => return not_found_series(series_id, "/api/series"),
        Err(NewChapterRefusal::OneshotFull) => return oneshot_full(),
        Err(NewChapterRefusal::Db(err)) => {
            tracing::error!("import chapter into series {series_id}: {err}");
            return missing_field("failed to create chapter");
        }
    };

    if let Err(response) = import_pages(&state, user.id, &chapter, &contents).await {
        return response;
    }

    let dto = build_chapter_dto(&state, &chapter).await;
    Json(dto).into_response()
}

// ---------------------------------------------------------------------------
// One-shots (#226): a series of kind `oneshot` holding exactly one chapter
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[allow(non_snake_case)]
pub struct OneshotInput {
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
    /// The model overrides. They go on the chapter, not the one-shot series: the chapter is the
    /// thing the user made, and it keeps them if it is later moved into a series.
    #[serde(flatten)]
    pub chapter: ChapterInput,
}

#[derive(Serialize)]
pub struct OneshotDto {
    pub series: SeriesDto,
    pub chapter: ChapterDto,
}

/// A one-shot's chapter is always number 1.
const ONESHOT_CHAPTER_NUMBER: f64 = 1.0;

/// Inserts the `oneshot` series row. Languages fall back like `create_series` ("ja" → "en");
/// the reading direction falls back to "rtl", the create dialog's default, since the column is
/// NOT NULL.
async fn insert_oneshot_series(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    title: &str,
    source_language: &Option<String>,
    target_language: &Option<String>,
    reading_direction: &Option<String>,
) -> Result<Series, sqlx::Error> {
    sqlx::query_as(
        "INSERT INTO series (id, created_at, updated_at, title, original_language, \
         source_language, target_language, reading_direction, created_by, kind) \
         VALUES ($1, now(), now(), $2, $3, $3, $4, $5, $6, 'oneshot') RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(title)
    .bind(resolve_setting(source_language).unwrap_or_else(|| "ja".to_string()))
    .bind(resolve_setting(target_language).unwrap_or_else(|| "en".to_string()))
    .bind(resolve_setting(reading_direction).unwrap_or_else(|| "rtl".to_string()))
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await
}

async fn oneshot_response(state: &AppState, series: Series, chapter: Chapter) -> Response {
    let defaults = PipelineDefaults::from_env();
    let global = load_global_settings(&state.pool, &defaults).await;
    let resolved = series
        .use_fallback_models
        .unwrap_or(global.use_fallback_models);
    let chapter_dto = to_chapter_dto(state, &chapter, Some(&series), &global).await;
    Json(OneshotDto {
        series: to_series_dto(state, &series, resolved, Some(chapter.id)),
        chapter: chapter_dto,
    })
    .into_response()
}

/// POST /api/series/oneshots — a one-shot series and its chapter 1, in one transaction.
pub async fn create_oneshot(
    State(state): State<AppState>,
    user: AuthUser,
    body: Result<Json<OneshotInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    const INSTANCE: &str = "/api/series/oneshots";
    let Json(dto) = match body {
        Ok(json) => json,
        Err(_) => return error::unreadable_body(INSTANCE),
    };
    let title = dto.title.trim().to_string();
    if title.is_empty() {
        return error::bad_request("title is required", INSTANCE);
    }
    let source_language = dto
        .sourceLanguage
        .clone()
        .or_else(|| dto.originalLanguage.clone());
    let mut chapter_input = dto.chapter;
    chapter_input.title = Some(title.clone());

    let created = async {
        let mut tx = state.pool.begin().await?;
        let series = insert_oneshot_series(
            &mut tx,
            user.id,
            &title,
            &source_language,
            &dto.targetLanguage,
            &dto.readingDirection,
        )
        .await?;
        let chapter =
            insert_chapter(&mut tx, series.id, ONESHOT_CHAPTER_NUMBER, &chapter_input).await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>((series, chapter))
    }
    .await;

    match created {
        Ok((series, chapter)) => oneshot_response(&state, series, chapter).await,
        Err(err) => {
            tracing::error!("create one-shot {title:?}: {err}");
            error::internal_error(INSTANCE)
        }
    }
}

/// The title a ZIP import gets when none is sent: the file name without its extension.
fn title_from_file_name(file_name: &str) -> String {
    let base = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    let stem = match base.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem,
        _ => base,
    };
    stem.trim().to_string()
}

/// POST /api/series/oneshots/import (multipart) — a ZIP becomes a one-shot: the series and its
/// chapter are committed together, then the pages are added as in `import_chapter`.
///
/// The page loop can't share that transaction: it uploads to MinIO and queues pipeline jobs
/// page by page, and neither rolls back with Postgres. So a failure part-way deletes the new
/// one-shot instead (pages and their unfinished jobs go with it), and no empty series is left.
/// Originals already uploaded for earlier pages stay in storage.
pub async fn import_oneshot(
    State(state): State<AppState>,
    user: AuthUser,
    mut multipart: Multipart,
) -> Response {
    const INSTANCE: &str = "/api/series/oneshots/import";
    let mut fields = match read_import_fields(&mut multipart, INSTANCE).await {
        Ok(fields) => fields,
        Err(response) => return response,
    };
    let Some((file_name, archive_bytes)) = fields.file.take() else {
        return missing_field("file is required");
    };
    let title = fields
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| title_from_file_name(&file_name));
    if title.is_empty() {
        return error::bad_request("title is required", INSTANCE);
    }

    let contents = match read_import_archive(&archive_bytes) {
        Ok(contents) => contents,
        Err(response) => return response,
    };
    tracing::info!(
        "Importing one-shot {title} ({} images)",
        contents.images_sorted.len()
    );

    let created = async {
        let mut tx = state.pool.begin().await?;
        let series = insert_oneshot_series(
            &mut tx,
            user.id,
            &title,
            &fields.source_language,
            &fields.target_language,
            &fields.reading_direction,
        )
        .await?;
        let chapter = insert_chapter(
            &mut tx,
            series.id,
            ONESHOT_CHAPTER_NUMBER,
            &fields.chapter_input(&title),
        )
        .await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>((series, chapter))
    }
    .await;
    let (series, chapter) = match created {
        Ok(created) => created,
        Err(err) => {
            tracing::error!("import one-shot {title:?}: {err}");
            return missing_field("failed to create chapter");
        }
    };

    if let Err(response) = import_pages(&state, user.id, &chapter, &contents).await {
        if let Err(err) = delete_with_page_jobs(
            &state.pool,
            "DELETE FROM series WHERE id = $1",
            series.id,
            crate::jobs::coordinator::DeletedPages::Series(series.id),
        )
        .await
        {
            tracing::error!(
                "import one-shot {title:?}: failed, and removing one-shot {} failed too: {err}",
                series.id
            );
        }
        return response;
    }

    // The pages set the covers; re-read so the response carries them.
    let series = find_series(&state.pool, series.id).await.unwrap_or(series);
    let chapter = find_chapter(&state.pool, chapter.id)
        .await
        .unwrap_or(chapter);
    oneshot_response(&state, series, chapter).await
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

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(tl_model: Option<&str>, qa_mode: Option<&str>) -> ChapterSettings {
        ChapterSettings {
            ocr_provider: None,
            ocr_model: None,
            tl_provider: None,
            tl_model: tl_model.map(str::to_string),
            qa_provider: None,
            qa_llm_model: None,
            qa_vlm_model: None,
            qa_mode: qa_mode.map(str::to_string),
            routing_strategy: None,
            cleanup_mode: None,
            ocr_merge_threshold: None,
            ocr_text_angle: None,
            use_fallback_models: None,
        }
    }

    #[test]
    fn keep_settings_pins_only_what_the_move_would_change() {
        let global = settings(Some("global/tl"), Some("auto"));

        // The old series set the model, the new one doesn't: pin the old series' value.
        let pinned = pin_settings(
            &settings(None, None),
            &settings(Some("old/tl"), None),
            &settings(None, None),
            &global,
        );
        assert_eq!(pinned.tl_model.as_deref(), Some("old/tl"));
        // Both resolve QA mode to the global value: left unset, so it still follows the global.
        assert_eq!(pinned.qa_mode, None);

        // The old series inherited the global, the new one overrides: pin the global value.
        let pinned = pin_settings(
            &settings(None, None),
            &settings(None, None),
            &settings(Some("new/tl"), Some("off")),
            &global,
        );
        assert_eq!(pinned.tl_model.as_deref(), Some("global/tl"));
        assert_eq!(pinned.qa_mode.as_deref(), Some("auto"));

        // The chapter's own value always stays.
        let pinned = pin_settings(
            &settings(Some("mine/tl"), None),
            &settings(Some("old/tl"), None),
            &settings(Some("new/tl"), None),
            &global,
        );
        assert_eq!(pinned.tl_model.as_deref(), Some("mine/tl"));
    }
}
