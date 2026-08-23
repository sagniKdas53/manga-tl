//! `/api/pages`, `/api/images`, `/api/ocr-regions` — port of PageController.
//!
//! PHASE-2 SCOPE (see MIGRATION.md): read paths, streaming variants, page management and
//! the single-image upload are complete. Deferred to Phase 3 because they drive the job
//! pipeline: zip/ePub upload branches, `handleDuplicateImageCloning`'s OCR/translation
//! reuse, `startPipeline` triggers, redo endpoints and import-project.
//!
//! CONTRACT NOTES:
//! - UploadResponse{pageId,imageId,status}: statuses "processing" | "already_exists" |
//!   "duplicate" | "imported" | "zip_imported" | error strings; invalid type -> 400 with
//!   status "Invalid file type. Accepted formats: PNG, JPEG, WebP, BMP".
//! - createPageAndImage clamps the requested number to [1, max+1]; occupied slots SHIFT UP
//!   (two-phase UPDATE to respect the (chapter_id, page_number) unique constraint);
//!   page 1 refreshes the chapter cover.
//! - Duplicate hash: exact slot+image -> idempotent "already_exists"; otherwise appended
//!   at max+1 as "duplicate" (Phase 3 adds the pipeline/clone side effects).
//! - Thumbnails generate SYNCHRONOUSLY here (Java used an async executor); response shape
//!   and eventual state identical, only latency differs. Deviation documented in MIGRATION.md.
//! - Streaming variants send Cache-Control max-age=31536000 public immutable + suffixed
//!   ETag ("{etag}-orig|-reader|-thumb"); /rendered sends neither (plain 200 image/png).
//! - GET /images/{id} falls back to a bare-image payload when no Page row references it.

use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::header;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::error;
use crate::minio::MinioService;
use crate::models::{
    Chapter, Conversation, ConversationRegion, Image, Layer, LayerElement, OcrRegion, Page, Panel,
};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[allow(non_snake_case)]
pub struct UploadResponse {
    pub pageId: Option<Uuid>,
    pub imageId: Option<Uuid>,
    pub status: String,
}

#[derive(Serialize)]
#[allow(non_snake_case)]
pub struct PageDto {
    pub id: Uuid,
    pub pageNumber: i32,
    pub imageId: Uuid,
    pub chapterId: Uuid,
    pub filename: String,
    pub url: String,
    pub thumbnailUrl: String,
}

#[derive(Deserialize)]
#[allow(non_snake_case)]
pub struct Pagination {
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub size: Option<i64>,
    #[serde(default)]
    pub sortDir: Option<String>,
}

const MAX_PAGE_SIZE: i64 = 100;

impl Pagination {
    fn bounds(&self, default_size: i64) -> (i64, i64) {
        let page = self.page.unwrap_or(0).max(0);
        let size = self.size.unwrap_or(default_size).clamp(1, MAX_PAGE_SIZE);
        (page, size)
    }

    fn descending(&self) -> bool {
        matches!(self.sortDir.as_deref(), Some("desc"))
    }
}

fn image_url(state: &AppState, image_id: Uuid) -> String {
    format!("{}/api/images/{image_id}/file", state.config.context_path)
}

fn thumbnail_url(state: &AppState, image_id: Uuid) -> String {
    format!(
        "{}/api/images/{image_id}/thumbnail",
        state.config.context_path
    )
}

// ---------------------------------------------------------------------------
// Validation (validateAndProcessImageBytes port)
// ---------------------------------------------------------------------------

const INVALID_TYPE_MSG: &str = "Invalid file type. Accepted formats: PNG, JPEG, WebP, BMP";

struct ProcessedImage {
    bytes: Vec<u8>,
    extension: String,
    filename: String,
}

fn magic_is_png(b: &[u8]) -> bool {
    b.len() >= 4 && b[0] == 0x89 && b[1] == b'P' && b[2] == b'N' && b[3] == b'G'
}
fn magic_is_jpeg(b: &[u8]) -> bool {
    b.len() >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF
}
fn magic_is_webp(b: &[u8]) -> bool {
    b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP"
}
fn magic_is_bmp(b: &[u8]) -> bool {
    b.len() >= 2 && b[0] == b'B' && b[1] == b'M'
}

/// Extension from filename, lowercased with leading dot; empty when none.
pub fn file_extension_of(filename: Option<&str>) -> String {
    file_extension(filename)
}

fn file_extension(filename: Option<&str>) -> String {
    let Some(name) = filename else {
        return String::new();
    };
    match name.rsplit_once('.') {
        Some((_, ext)) => format!(".{}", ext.to_lowercase()),
        None => String::new(),
    }
}

fn validate_and_process_image_bytes(
    original_filename: Option<&str>,
    file_bytes: Vec<u8>,
) -> Result<ProcessedImage, String> {
    if file_bytes.len() < 16 {
        return Err(INVALID_TYPE_MSG.to_string());
    }
    let lower = original_filename.unwrap_or("").to_lowercase();
    let has_valid_ext = [".png", ".jpg", ".jpeg", ".webp", ".bmp"]
        .iter()
        .any(|ext| lower.ends_with(ext));
    if !has_valid_ext && !lower.is_empty() {
        return Err(INVALID_TYPE_MSG.to_string());
    }

    // BMP is converted to PNG exactly like the Java path (ImageIO round-trip).
    if magic_is_bmp(&file_bytes) {
        let img = image::load_from_memory_with_format(&file_bytes, image::ImageFormat::Bmp)
            .map_err(|_| INVALID_TYPE_MSG.to_string())?;
        let mut png = std::io::Cursor::new(Vec::new());
        img.write_to(&mut png, image::ImageFormat::Png)
            .map_err(|_| INVALID_TYPE_MSG.to_string())?;
        let new_filename = match original_filename.and_then(|f| f.rsplit_once('.')) {
            Some((stem, _)) => format!("{stem}.png"),
            None => "converted.png".to_string(),
        };
        return Ok(ProcessedImage {
            bytes: png.into_inner(),
            extension: ".png".to_string(),
            filename: new_filename,
        });
    }

    let recognized =
        magic_is_png(&file_bytes) || magic_is_jpeg(&file_bytes) || magic_is_webp(&file_bytes);
    if !recognized {
        return Err(INVALID_TYPE_MSG.to_string());
    }

    Ok(ProcessedImage {
        extension: file_extension(original_filename),
        filename: original_filename.unwrap_or("").to_string(),
        bytes: file_bytes,
    })
}

pub fn content_type_by_extension(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else {
        "application/octet-stream"
    }
}

// ---------------------------------------------------------------------------
// Persistence helpers (PageService ports)
// ---------------------------------------------------------------------------

async fn find_chapter(pool: &sqlx::PgPool, id: Uuid) -> Option<Chapter> {
    sqlx::query_as("SELECT * FROM chapters WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

async fn find_image(pool: &sqlx::PgPool, id: Uuid) -> Option<Image> {
    sqlx::query_as("SELECT * FROM images WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

async fn find_page(pool: &sqlx::PgPool, id: Uuid) -> Option<Page> {
    sqlx::query_as("SELECT * FROM pages WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

async fn max_page_number(pool: &sqlx::PgPool, chapter_id: Uuid) -> i32 {
    sqlx::query_scalar("SELECT COALESCE(MAX(page_number), 0) FROM pages WHERE chapter_id = $1")
        .bind(chapter_id)
        .fetch_one(pool)
        .await
        .unwrap_or(0)
}

async fn page_at_slot(pool: &sqlx::PgPool, chapter_id: Uuid, number: i32) -> Option<Page> {
    sqlx::query_as("SELECT * FROM pages WHERE chapter_id = $1 AND page_number = $2")
        .bind(chapter_id)
        .bind(number)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
}

/// shiftPagesUp parity: bump every page at/after the slot by one. Two-phase so the
/// (chapter_id, page_number) unique constraint never trips mid-statement.
async fn shift_pages_up(pool: &sqlx::PgPool, chapter_id: Uuid, starting_number: i32) {
    sqlx::query("UPDATE pages SET page_number = page_number + 10000 WHERE chapter_id = $1 AND page_number >= $2")
        .bind(chapter_id)
        .bind(starting_number)
        .execute(pool)
        .await
        .expect("shift phase 1");
    sqlx::query("UPDATE pages SET page_number = page_number - 9999 WHERE chapter_id = $1 AND page_number > 10000")
        .bind(chapter_id)
        .execute(pool)
        .await
        .expect("shift phase 2");
}

async fn recalculate_chapter_cover(pool: &sqlx::PgPool, chapter_id: Uuid) {
    // Cover of the lowest-numbered chapter that HAS one (PageService.recalculateChapterCover).
    sqlx::query(
        "UPDATE chapters SET cover_image_id = COALESCE((\
             SELECT p.image_id FROM pages p WHERE p.chapter_id = $1 \
             ORDER BY p.page_number ASC LIMIT 1), NULL) \
         WHERE id = $1",
    )
    .bind(chapter_id)
    .execute(pool)
    .await
    .expect("chapter cover recalculation");
}

async fn insert_image(
    pool: &sqlx::PgPool,
    filename: &str,
    storage_path: &str,
    hash: &str,
    created_by: Option<Uuid>,
) -> Image {
    sqlx::query_as(
        "INSERT INTO images (id, created_at, filename, storage_path, hash, created_by) \
         VALUES ($1, now(), $2, $3, $4, $5) RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(filename)
    .bind(storage_path)
    .bind(hash)
    .bind(created_by)
    .fetch_one(pool)
    .await
    .expect("image insert")
}

async fn insert_page(
    pool: &sqlx::PgPool,
    chapter: &Chapter,
    image_id: Uuid,
    requested_number: Option<i32>,
) -> Page {
    let max_existing = max_page_number(pool, chapter.id).await;
    let safe = requested_number
        .map(|n| n.clamp(1, max_existing + 1))
        .unwrap_or(max_existing + 1);

    if page_at_slot(pool, chapter.id, safe).await.is_some() {
        shift_pages_up(pool, chapter.id, safe).await;
    }

    let page: Page = sqlx::query_as(
        "INSERT INTO pages (id, page_number, chapter_id, image_id) VALUES ($1, $2, $3, $4) RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(safe)
    .bind(chapter.id)
    .bind(image_id)
    .fetch_one(pool)
    .await
    .expect("page insert");

    if safe == 1 {
        recalculate_chapter_cover(pool, chapter.id).await;
    }
    page
}

/// Java generated thumbnails on an async executor; we do it inline before responding.
/// Same end state (thumbnail_storage_path set + object uploaded).
/// Public wrapper for the import path (chapter ZIP import reuses the pipeline).
pub async fn generate_thumbnail_pub(
    storage: &MinioService,
    pool: &sqlx::PgPool,
    image_id: Uuid,
    original_bytes: &[u8],
) {
    generate_thumbnail(storage, pool, image_id, original_bytes).await;
}

async fn generate_thumbnail(
    storage: &MinioService,
    pool: &sqlx::PgPool,
    image_id: Uuid,
    original_bytes: &[u8],
) {
    let Ok(output) = crate::thumbnails::generate_thumbnail(original_bytes) else {
        tracing::warn!("thumbnail generation failed for image {image_id}");
        return;
    };
    let path = format!("thumbnails/{image_id}.webp");
    if let Err(err) = storage
        .upload_bytes(&path, output.webp_bytes.clone(), "image/webp")
        .await
    {
        tracing::error!("thumbnail upload failed for image {image_id}: {err}");
        return;
    }
    // Dimensions persist even though they came from decode (Java persists them separately).
    let _ = (output.original_width, output.original_height);
    sqlx::query(
        "UPDATE images SET thumbnail_storage_path = $2, width = $3, height = $4 WHERE id = $1",
    )
    .bind(image_id)
    .bind(&path)
    .bind(output.original_width as i32)
    .bind(output.original_height as i32)
    .execute(pool)
    .await
    .expect("thumbnail path update");
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/// POST /api/images — multipart form: chapterId, pageNumber, file.
pub async fn upload_page(
    State(state): State<AppState>,
    user: AuthUser,
    multipart: Multipart,
) -> Response {
    // ADMIN/TRANSLATOR only (VIEWER denied like @PreAuthorize).
    if user.role.eq_ignore_ascii_case("viewer") {
        return error::access_denied("/api/images");
    }

    let fields = match extract_multipart(multipart).await {
        Ok(fields) => fields,
        Err(response) => return response,
    };

    let Some(MultipartFile { filename, bytes }) = fields.file else {
        return (
            StatusCode::BAD_REQUEST,
            Json(UploadResponse {
                pageId: None,
                imageId: None,
                status: "Missing file".into(),
            }),
        )
            .into_response();
    };
    let chapter_id = match fields.chapter_id {
        Some(id) => id,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(UploadResponse {
                    pageId: None,
                    imageId: None,
                    status: "Missing chapterId".into(),
                }),
            )
                .into_response();
        }
    };
    let page_number: Option<i32> = fields.page_number.as_deref().and_then(|v| v.parse().ok());

    let Some(chapter) = find_chapter(&state.pool, chapter_id).await else {
        return error::not_found(&format!("Chapter not found: {chapter_id}"), "/api/images");
    };

    let lower_name = filename.to_lowercase();
    if lower_name.ends_with(".zip") || lower_name.ends_with(".epub") {
        return upload_zip_archive(
            &state,
            &chapter,
            user.id,
            page_number,
            chapter_id,
            &filename,
            bytes,
        )
        .await;
    }

    // --- standard single image upload ---
    let processed = match validate_and_process_image_bytes(Some(&filename), bytes) {
        Ok(p) => p,
        Err(message) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(UploadResponse {
                    pageId: None,
                    imageId: None,
                    status: message,
                }),
            )
                .into_response();
        }
    };

    let mut hasher = Sha256::new();
    hasher.update(&processed.bytes);
    let file_hash = hex_encode(hasher.finalize());

    // Duplicate detection by content hash.
    let existing: Option<Image> = sqlx::query_as("SELECT * FROM images WHERE hash = $1 LIMIT 1")
        .bind(&file_hash)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None);

    if let Some(existing_image) = existing {
        // Idempotency guard: same image re-uploaded into the same slot.
        let slot_page = match page_number {
            Some(number) => page_at_slot(&state.pool, chapter.id, number).await,
            None => None,
        };
        if let Some(slot_page) = slot_page.filter(|p| p.image_id == existing_image.id) {
            return Json(UploadResponse {
                pageId: Some(slot_page.id),
                imageId: Some(existing_image.id),
                status: "already_exists".into(),
            })
            .into_response();
        }

        // Append at max+1 (Java's duplicate-upload behavior).
        let safe = max_page_number(&state.pool, chapter.id).await + 1;
        let page = insert_page_no_shift(&state.pool, &chapter, existing_image.id, safe).await;
        crate::clone::handle_duplicate_image_cloning(&state, page.id, existing_image.id, &chapter)
            .await;
        state
            .sse
            .map_image_to_user(existing_image.id, user.id)
            .await;

        return Json(UploadResponse {
            pageId: Some(page.id),
            imageId: Some(existing_image.id),
            status: "duplicate".into(),
        })
        .into_response();
    }

    // Fresh image: store original then create records.
    let uuid = Uuid::new_v4();
    let storage_path = format!("originals/{uuid}{}", processed.extension);
    let content_type = content_type_by_extension(&storage_path);
    if let Err(err) = state
        .storage
        .upload_bytes(&storage_path, processed.bytes.clone(), content_type)
        .await
    {
        tracing::error!("original upload failed: {err}");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let image = insert_image(
        &state.pool,
        &processed.filename,
        &storage_path,
        &file_hash,
        Some(user.id),
    )
    .await;
    let page = insert_page(&state.pool, &chapter, image.id, page_number).await;
    generate_thumbnail(&state.storage, &state.pool, image.id, &processed.bytes).await;

    // Pipeline entry (Java uploadPage): fresh images go through panel detection.
    crate::jobs::coordinator::start_pipeline(&state, image.id, Some(page.id), Some(chapter_id))
        .await;
    state.sse.map_image_to_user(image.id, user.id).await;

    Json(UploadResponse {
        pageId: Some(page.id),
        imageId: Some(image.id),
        status: "processing".into(),
    })
    .into_response()
}

/// Duplicate-append variant: no shift needed since the number is max+1 (empty slot).
async fn insert_page_no_shift(
    pool: &sqlx::PgPool,
    chapter: &Chapter,
    image_id: Uuid,
    number: i32,
) -> Page {
    sqlx::query_as(
        "INSERT INTO pages (id, page_number, chapter_id, image_id) VALUES ($1, $2, $3, $4) RETURNING *",
    )
    .bind(Uuid::new_v4())
    .bind(number)
    .bind(chapter.id)
    .bind(image_id)
    .fetch_one(pool)
    .await
    .expect("duplicate page insert")
}

struct MultipartFile {
    filename: String,
    bytes: Vec<u8>,
}

struct MultipartFields {
    chapter_id: Option<Uuid>,
    page_number: Option<String>,
    file: Option<MultipartFile>,
}

/// Multipart extraction itself rejects non-multipart requests before the handler runs;
/// field-level errors surface through the same UploadResponse shape.
#[allow(clippy::result_large_err)]
async fn extract_multipart(mut multipart: Multipart) -> Result<MultipartFields, Response> {
    let mut fields = MultipartFields {
        chapter_id: None,
        page_number: None,
        file: None,
    };
    while let Some(field) = multipart.next_field().await.map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(UploadResponse {
                pageId: None,
                imageId: None,
                status: format!("multipart error: {e}"),
            }),
        )
            .into_response()
    })? {
        match field.name().unwrap_or("") {
            "chapterId" => {
                let text = field.text().await.unwrap_or_default();
                fields.chapter_id = text.parse::<Uuid>().ok();
            }
            "pageNumber" => {
                fields.page_number = Some(field.text().await.unwrap_or_default());
            }
            "file" => {
                let filename = field.file_name().unwrap_or("").to_string();
                let bytes = field.bytes().await.map_err(|e| {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(UploadResponse {
                            pageId: None,
                            imageId: None,
                            status: format!("file read error: {e}"),
                        }),
                    )
                        .into_response()
                })?;
                fields.file = Some(MultipartFile {
                    filename,
                    bytes: bytes.to_vec(),
                });
            }
            _ => {}
        }
    }
    Ok(fields)
}

fn hex_encode(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// GET /api/chapters/{chapterId}/pages — sorted by pageNumber, default asc.
pub async fn list_pages(
    State(state): State<AppState>,
    Path(chapter_id): Path<Uuid>,
    Query(p): Query<Pagination>,
) -> Response {
    let (page, size) = p.bounds(25);
    let direction = if p.descending() { "DESC" } else { "ASC" };

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE chapter_id = $1")
        .bind(chapter_id)
        .fetch_one(&state.pool)
        .await
        .unwrap_or(0);

    #[derive(sqlx::FromRow)]
    struct JoinedRow {
        id: Uuid,
        page_number: i32,
        chapter_id: Uuid,
        image_id: Uuid,
        filename: String,
    }
    let sql = format!(
        "SELECT p.id, p.page_number, p.chapter_id, p.image_id, i.filename \
         FROM pages p JOIN images i ON i.id = p.image_id \
         WHERE p.chapter_id = $1 ORDER BY p.page_number {direction} LIMIT {size} OFFSET {}",
        page * size
    );
    let rows: Vec<JoinedRow> = sqlx::query_as::<_, JoinedRow>(&sql)
        .bind(chapter_id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();

    let content: Vec<PageDto> = rows
        .into_iter()
        .map(|r| PageDto {
            id: r.id,
            pageNumber: r.page_number,
            imageId: r.image_id,
            chapterId: r.chapter_id,
            filename: r.filename,
            url: image_url(&state, r.image_id),
            thumbnailUrl: thumbnail_url(&state, r.image_id),
        })
        .collect();

    Json(crate::routes::series::PagedResponse {
        totalElements: total,
        totalPages: (total + size - 1) / size,
        page,
        size,
        content,
    })
    .into_response()
}

/// Assembles the rich getPage payload (panels, ocrRegions, conversations, layers).
async fn build_page_payload(state: &AppState, page_id: Uuid) -> Option<Response> {
    let page = find_page(&state.pool, page_id).await?;
    let image = find_image(&state.pool, page.image_id).await?;

    let panels: Vec<Panel> =
        sqlx::query_as("SELECT * FROM panels WHERE image_id = $1 ORDER BY reading_order ASC")
            .bind(image.id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();

    let ocr_regions: Vec<OcrRegion> =
        sqlx::query_as("SELECT * FROM ocr_regions WHERE page_id = $1")
            .bind(page_id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();

    let conversations: Vec<Conversation> =
        sqlx::query_as("SELECT * FROM conversations WHERE page_id = $1")
            .bind(page_id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();

    let conv_ids: Vec<Uuid> = conversations.iter().map(|c| c.id).collect();
    let all_conv_regions: Vec<ConversationRegion> = if conv_ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("SELECT * FROM conversation_regions WHERE conversation_id = ANY($1)")
            .bind(&conv_ids)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default()
    };

    let conversations_json: Vec<serde_json::Value> = conversations
        .iter()
        .map(|conv| {
            let regions: Vec<serde_json::Value> = all_conv_regions
                .iter()
                .filter(|cr| cr.conversation_id == conv.id)
                .map(|cr| json!({ "regionId": cr.region_id.to_string(), "position": cr.position }))
                .collect();
            json!({ "id": conv.id.to_string(), "sceneType": conv.scene_type, "regions": regions })
        })
        .collect();

    let layers: Vec<Layer> =
        sqlx::query_as("SELECT * FROM layers WHERE page_id = $1 ORDER BY z_order ASC")
            .bind(page_id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();

    let elements: Vec<LayerElement> =
        sqlx::query_as(
            "SELECT le.* FROM layer_elements le JOIN layers l ON l.id = le.layer_id WHERE l.page_id = $1",
        )
        .bind(page_id)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();

    let layers_json: Vec<serde_json::Value> = layers
        .iter()
        .map(|l| {
            let elements_for_layer: Vec<&LayerElement> =
                elements.iter().filter(|el| el.layer_id == l.id).collect();
            json!({
                "layer": serde_json::to_value(l).unwrap_or_default(),
                "elements": elements_for_layer,
            })
        })
        .collect();

    let payload = json!({
        "page": {
            "id": page.id,
            "pageNumber": page.page_number,
            "imageId": image.id,
            "chapterId": page.chapter_id,
        },
        "image": serde_json::to_value(&image).unwrap_or_default(),
        "url": image_url(state, image.id),
        "panels": serde_json::to_value(&panels).unwrap_or_default(),
        "ocrRegions": serde_json::to_value(&ocr_regions).unwrap_or_default(),
        "conversations": conversations_json,
        "layers": layers_json,
    });

    Some(Json(payload).into_response())
}

/// GET /api/pages/{pageId}
pub async fn get_page(State(state): State<AppState>, Path(page_id): Path<Uuid>) -> Response {
    match build_page_payload(&state, page_id).await {
        Some(response) => response,
        None => error::not_found(&format!("Page not found: {page_id}"), "/api/pages/{pageId}"),
    }
}

/// GET /api/images/{imageId} — page payload when a Page references it; bare otherwise.
pub async fn get_image(State(state): State<AppState>, Path(image_id): Path<Uuid>) -> Response {
    let first_page: Option<Page> =
        sqlx::query_as("SELECT p.* FROM pages p WHERE p.image_id = $1 LIMIT 1")
            .bind(image_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
    if let Some(page) = first_page {
        return build_page_payload(&state, page.id)
            .await
            .unwrap_or_else(|| StatusCode::NOT_FOUND.into_response());
    }

    let Some(image) = find_image(&state.pool, image_id).await else {
        return error::not_found(
            &format!("Image not found: {image_id}"),
            "/api/images/{imageId}",
        );
    };
    let panels: Vec<Panel> =
        sqlx::query_as("SELECT * FROM panels WHERE image_id = $1 ORDER BY reading_order ASC")
            .bind(image_id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();

    Json(json!({
        "image": serde_json::to_value(&image).unwrap_or_default(),
        "url": image_url(&state, image.id),
        "panels": serde_json::to_value(&panels).unwrap_or_default(),
        "ocrRegions": [],
        "conversations": [],
        "layers": [],
    }))
    .into_response()
}

// ---------------------------------------------------------------------------
// Streaming variants
// ---------------------------------------------------------------------------

/// streamCachedImage parity: stat for length/etag, immutable cache headers, streamed body.
async fn stream_cached_image(storage: &MinioService, path: &str, etag_suffix: &str) -> Response {
    let stat = storage.stat(path).await.ok();
    match storage.download(path).await {
        Ok(stream) => {
            let mut headers = HeaderMap::new();
            headers.insert(
                header::CONTENT_TYPE,
                axum::http::HeaderValue::from_static(content_type_by_extension(path)),
            );
            headers.insert(
                header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("max-age=31536000, public, immutable"),
            );
            let etag = stat
                .as_ref()
                .and_then(|s| s.e_tag())
                .map(|e| e.replace('"', ""));
            if let Some(etag) = etag.and_then(|e| {
                axum::http::HeaderValue::from_str(&format!("\"{e}-{etag_suffix}\"")).ok()
            }) {
                headers.insert(header::ETAG, etag);
            }
            // Page images are tens of MB at most; buffering avoids adapter plumbing.
            let bytes = stream.collect().await.expect("body collect").to_vec();
            (StatusCode::OK, headers, Body::from(bytes)).into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// GET /api/pages/{pageId}/rendered — rendered/{imageId}.png falling back to rendered/{pageId}.png.
pub async fn get_page_rendered(
    State(state): State<AppState>,
    Path(page_id): Path<Uuid>,
) -> Response {
    let Some(page) = find_page(&state.pool, page_id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let primary = format!("rendered/{}.png", page.image_id);
    let fallback = format!("rendered/{page_id}.png");
    let path = if state.storage.exists(&primary).await {
        primary
    } else if state.storage.exists(&fallback).await {
        fallback
    } else {
        return StatusCode::NOT_FOUND.into_response();
    };

    match state.storage.download(&path).await {
        Ok(stream) => {
            let bytes = stream.collect().await.expect("body collect").to_vec();
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "image/png")],
                Body::from(bytes),
            )
                .into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// GET /api/images/{imageId}/file — the stored original.
pub async fn get_image_file(State(state): State<AppState>, Path(image_id): Path<Uuid>) -> Response {
    match find_image(&state.pool, image_id).await {
        Some(image) => stream_cached_image(&state.storage, &image.storage_path, "orig").await,
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// GET /api/images/{imageId}/reader — WebP variant or the original fallback.
pub async fn get_image_reader(
    State(state): State<AppState>,
    Path(image_id): Path<Uuid>,
) -> Response {
    match find_image(&state.pool, image_id).await {
        Some(image) => {
            let has_reader = image.reader_storage_path.is_some();
            let path = image
                .reader_storage_path
                .unwrap_or_else(|| image.storage_path.clone());
            let suffix = if has_reader { "reader" } else { "orig" };
            stream_cached_image(&state.storage, &path, suffix).await
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// GET /api/images/{imageId}/thumbnail — NEVER falls back to the original (Java parity).
pub async fn get_image_thumbnail(
    State(state): State<AppState>,
    Path(image_id): Path<Uuid>,
) -> Response {
    match find_image(&state.pool, image_id).await {
        Some(image) => match image.thumbnail_storage_path {
            Some(path) => stream_cached_image(&state.storage, &path, "thumb").await,
            None => StatusCode::NOT_FOUND.into_response(),
        },
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/// DELETE /api/pages/{pageId} — ADMIN/TRANSLATOR; db cascade then MinIO cleanup.
pub async fn delete_page(
    State(state): State<AppState>,
    user: AuthUser,
    Path(page_id): Path<Uuid>,
) -> Response {
    if user.role.eq_ignore_ascii_case("viewer") {
        return error::access_denied("/api/pages/{pageId}");
    }
    let Some(page) = find_page(&state.pool, page_id).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response(); // Java: exception -> 500
    };
    let image = find_image(&state.pool, page.image_id).await;

    // DB deletes rely on schema cascades for layers/elements/regions (same as Java's FKs).
    sqlx::query("DELETE FROM pages WHERE id = $1")
        .bind(page_id)
        .execute(&state.pool)
        .await
        .expect("page delete");
    if let Some(image) = &image {
        // Only remove the image when no other page references it (Java deletes via pageService;
        // its deletePageDb collects paths from the page's own image only).
        let refs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE image_id = $1")
            .bind(image.id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or(1);
        if refs == 0 {
            for path in [
                image.storage_path.clone(),
                image.thumbnail_storage_path.clone().unwrap_or_default(),
                image.reader_storage_path.clone().unwrap_or_default(),
            ]
            .into_iter()
            .filter(|p| !p.is_empty())
            {
                state.storage.delete_quietly(&path).await;
            }
            sqlx::query("DELETE FROM images WHERE id = $1")
                .bind(image.id)
                .execute(&state.pool)
                .await
                .expect("image delete");
        }
    }
    recalculate_chapter_cover(&state.pool, page.chapter_id).await;
    StatusCode::OK.into_response()
}

/// PUT /api/chapters/{chapterId}/pages/reorder — full list of ids in desired order.
pub async fn reorder_pages(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chapter_id): Path<Uuid>,
    body: Result<Json<Vec<Uuid>>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if user.role.eq_ignore_ascii_case("viewer") {
        return error::access_denied("/api/chapters/{chapterId}/pages/reorder");
    }
    let Json(page_ids) = match body {
        Ok(json) => json,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                "Failed to read request".to_string(),
            )
                .into_response();
        }
    };

    let existing: Vec<Page> =
        sqlx::query_as("SELECT * FROM pages WHERE chapter_id = $1 ORDER BY page_number ASC")
            .bind(chapter_id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();

    let valid = page_ids.len() == existing.len()
        && page_ids
            .iter()
            .all(|id| existing.iter().any(|p| &p.id == id));
    if !valid {
        return (
            StatusCode::BAD_REQUEST,
            "Invalid list of page IDs for reordering".to_string(),
        )
            .into_response();
    }

    // Two-phase renumber avoids unique-constraint violations (same trick as Java).
    for (index, id) in page_ids.iter().enumerate() {
        sqlx::query("UPDATE pages SET page_number = $2 WHERE id = $1")
            .bind(id)
            .bind((index as i32) + 1 + 10000)
            .execute(&state.pool)
            .await
            .expect("reorder phase 1");
    }
    for (index, id) in page_ids.iter().enumerate() {
        sqlx::query("UPDATE pages SET page_number = $2 WHERE id = $1")
            .bind(id)
            .bind((index as i32) + 1)
            .execute(&state.pool)
            .await
            .expect("reorder phase 2");
    }
    recalculate_chapter_cover(&state.pool, chapter_id).await;
    StatusCode::OK.into_response()
}

/// PATCH /api/pages/{pageId}/number — {"newNumber": int}.
pub async fn update_page_number(
    State(state): State<AppState>,
    user: AuthUser,
    Path(page_id): Path<Uuid>,
    body: Result<Json<serde_json::Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if user.role.eq_ignore_ascii_case("viewer") {
        return error::access_denied("/api/pages/{pageId}/number");
    }
    let Json(payload) = match body {
        Ok(json) => json,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                "Failed to read request".to_string(),
            )
                .into_response();
        }
    };
    let Some(raw_new) = payload.get("newNumber") else {
        return (
            StatusCode::BAD_REQUEST,
            "Missing 'newNumber' in payload".to_string(),
        )
            .into_response();
    };
    // Java accepts any JSON number or numeric string; invalid -> IllegalArgumentException -> 400.
    let new_number: i32 = match raw_new.as_i64() {
        Some(v) => v as i32,
        None => match raw_new.as_str().and_then(|v| v.parse::<i32>().ok()) {
            Some(v) => v,
            None => {
                return error::bad_request(
                    "Page number cannot be parsed",
                    "/api/pages/{pageId}/number",
                );
            }
        },
    };

    let Some(page) = find_page(&state.pool, page_id).await else {
        // Java throws IllegalArgumentException("Page not found") -> 400 problem+json.
        return error::bad_request(
            &format!("Page not found: {page_id}"),
            "/api/pages/{pageId}/number",
        );
    };
    let old_number = page.page_number;
    if old_number == new_number {
        return StatusCode::OK.into_response();
    }

    let total_pages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages WHERE chapter_id = $1")
        .bind(page.chapter_id)
        .fetch_one(&state.pool)
        .await
        .unwrap_or(0);
    let mut new_number = new_number;
    if new_number == 0 || new_number == -1 {
        new_number = total_pages as i32; // map 0/-1 to end
    } else if new_number < 0 {
        return error::bad_request(
            "Page number cannot be negative",
            "/api/pages/{pageId}/number",
        );
    } else if new_number as i64 > total_pages {
        return error::bad_request(
            "Page number cannot be greater than total pages",
            "/api/pages/{pageId}/number",
        );
    }
    if old_number == new_number {
        return StatusCode::OK.into_response();
    }

    // Temporarily park the moving page beyond the constraint range.
    sqlx::query("UPDATE pages SET page_number = $2 WHERE id = $1")
        .bind(page_id)
        .bind(10000 + new_number)
        .execute(&state.pool)
        .await
        .expect("park page");
    if new_number > old_number {
        sqlx::query(
            "UPDATE pages SET page_number = page_number - 1 \
             WHERE chapter_id = $1 AND id <> $2 AND page_number > $3 AND page_number <= $4",
        )
        .bind(page.chapter_id)
        .bind(page_id)
        .bind(old_number)
        .bind(new_number)
        .execute(&state.pool)
        .await
        .expect("shift down");
    } else {
        sqlx::query(
            "UPDATE pages SET page_number = page_number + 1 \
             WHERE chapter_id = $1 AND id <> $2 AND page_number >= $3 AND page_number < $4",
        )
        .bind(page.chapter_id)
        .bind(page_id)
        .bind(new_number)
        .bind(old_number)
        .execute(&state.pool)
        .await
        .expect("shift up");
    }
    sqlx::query("UPDATE pages SET page_number = $2 WHERE id = $1")
        .bind(page_id)
        .bind(new_number)
        .execute(&state.pool)
        .await
        .expect("final page number");

    if old_number == 1 || new_number == 1 {
        recalculate_chapter_cover(&state.pool, page.chapter_id).await;
    }
    StatusCode::OK.into_response()
}

/// PATCH /api/ocr-regions/{id} — partial update of text/translatedText/approved/confidence.
pub async fn update_ocr_region(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    body: Result<Json<serde_json::Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if user.role.eq_ignore_ascii_case("viewer") {
        return error::access_denied("/api/ocr-regions/{id}");
    }
    let Json(payload) = match body {
        Ok(json) => json,
        Err(_) => return error::unreadable_body("/api/ocr-regions/{id}"),
    };

    let Some(region) = sqlx::query_as::<_, OcrRegion>("SELECT * FROM ocr_regions WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None)
    else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let text = payload
        .get("text")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let translated_text = payload
        .get("translatedText")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let approved = payload.get("approved").and_then(|v| v.as_bool());
    let confidence = payload.get("confidence").and_then(|v| v.as_f64());

    let updated: OcrRegion = sqlx::query_as(
        "UPDATE ocr_regions SET \
         text = COALESCE($2, text), \
         translated_text = COALESCE($3, translated_text), \
         translation_failed = CASE WHEN $3 IS NULL THEN translation_failed ELSE false END, \
         approved = COALESCE($4, approved), \
         confidence = COALESCE($5, confidence) \
         WHERE id = $1 RETURNING *",
    )
    .bind(id)
    .bind(text)
    .bind(translated_text)
    .bind(approved)
    .bind(confidence)
    .fetch_one(&state.pool)
    .await
    .expect("ocr region update");
    let _ = region;

    Json(updated).into_response()
}

// ---------------------------------------------------------------------------
// Redo triggers (Phase 3)
// ---------------------------------------------------------------------------

/// POST /api/ocr-regions/{id}/redo?type=ocr|translation — ADMIN/TRANSLATOR.
/// Enqueues a high-priority region-redo job and maps the image to the caller for SSE.
pub async fn redo_ocr_region(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if !user.role.eq_ignore_ascii_case("admin") && !user.role.eq_ignore_ascii_case("translator") {
        return error::access_denied("/api/ocr-regions/{id}");
    }
    let Some(redo_type) = params.get("type") else {
        return (
            StatusCode::BAD_REQUEST,
            "Required parameter 'type' is not present".to_string(),
        )
            .into_response();
    };

    match crate::jobs::coordinator::trigger_redo(&state, id, redo_type).await {
        Ok(()) => {}
        Err(err) => {
            tracing::error!("Failed to trigger region redo: {err}");
            return (StatusCode::INTERNAL_SERVER_ERROR, err).into_response();
        }
    }

    // Look up image ID to map it to the requesting user (SSE audience).
    if let Ok(Some((image_id,))) = sqlx::query_as::<_, (Uuid,)>(
        "SELECT p.image_id FROM ocr_regions r JOIN pages p ON p.id = r.page_id WHERE r.id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    {
        state.sse.map_image_to_user(image_id, user.id).await;
    }
    Json(serde_json::json!({ "status": "enqueued" })).into_response()
}

/// POST /api/images/{imageId}/redo?type=&chapterId= — ADMIN/TRANSLATOR.
/// Valid types: ocr | translation | layout; anything else → 400 "Invalid redo type".
pub async fn redo_image(
    State(state): State<AppState>,
    user: AuthUser,
    Path(image_id): Path<Uuid>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if !user.role.eq_ignore_ascii_case("admin") && !user.role.eq_ignore_ascii_case("translator") {
        return error::access_denied("/api/images/{imageId}/redo");
    }
    let Some(redo_type) = params.get("type").cloned() else {
        return (
            StatusCode::BAD_REQUEST,
            "Required parameter 'type' is not present".to_string(),
        )
            .into_response();
    };
    let chapter_id = params
        .get("chapterId")
        .and_then(|v| Uuid::parse_str(v).ok());

    match redo_type.as_str() {
        "ocr" | "translation" | "layout" => {
            crate::jobs::coordinator::trigger_image_redo(&state, image_id, &redo_type, chapter_id)
                .await;
            state.sse.map_image_to_user(image_id, user.id).await;
            Json(serde_json::json!({ "status": "enqueued" })).into_response()
        }
        _ => (StatusCode::BAD_REQUEST, "Invalid redo type".to_string()).into_response(),
    }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/// Sub-router mounted under `/api`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/images", post(upload_page))
        .route("/images/{imageId}", get(get_image))
        .route("/images/{imageId}/file", get(get_image_file))
        .route("/images/{imageId}/reader", get(get_image_reader))
        .route("/images/{imageId}/thumbnail", get(get_image_thumbnail))
        .route("/pages/{pageId}", get(get_page).delete(delete_page))
        .route(
            "/pages/{pageId}/number",
            axum::routing::patch(update_page_number),
        )
        .route("/pages/{pageId}/rendered", get(get_page_rendered))
        .route("/chapters/{chapterId}/pages", get(list_pages))
        .route(
            "/chapters/{chapterId}/pages/reorder",
            axum::routing::put(reorder_pages),
        )
        .route("/ocr-regions/{id}", axum::routing::patch(update_ocr_region))
        .route(
            "/ocr-regions/{id}/redo",
            axum::routing::post(redo_ocr_region),
        )
        .route("/images/{imageId}/redo", axum::routing::post(redo_image))
        .route(
            "/chapters/{chapterId}/import-project",
            axum::routing::post(import_project),
        )
}

// ---------------------------------------------------------------------------
// ZIP/ePub upload branches + project import (Phase 3)
// ---------------------------------------------------------------------------

/// The two archive branches of Java's uploadPage:
///   * Case A — a page-level project restore (`project.json` present): restores the
///     original image, layers and elements onto the slot's page.
///   * Case B — a plain image archive: every image becomes a page in the chapter.
pub async fn upload_zip_archive(
    state: &AppState,
    chapter: &Chapter,
    user_id: Uuid,
    page_number: Option<i32>,
    chapter_id: Uuid,
    _filename: &str,
    bytes: Vec<u8>,
) -> Response {
    let contents = match crate::archive::read_archive(&bytes) {
        Ok(c) => c,
        Err(message) => {
            return zip_error(format!("error: {message}"));
        }
    };

    // pageNumber semantics match the single-image path: default max+1.
    // pageNumber semantics match the single-image path: default max+1.
    let requested = match page_number {
        Some(n) => n,
        None => max_page_number(&state.pool, chapter_id).await + 1,
    };

    match contents.project_json {
        Some(project_bytes) => {
            // ---- Case A: page-level project ZIP restore ----
            let Some((original_name, original_bytes)) = contents.original_image.clone() else {
                return zip_error("error: project.json found but no image found in zip".into());
            };

            let processed = match validate_and_process_image_bytes(
                Some(&original_name),
                original_bytes.clone(),
            ) {
                Ok(p) => p,
                Err(message) => return zip_error(message),
            };
            let file_hash = {
                use sha2::Digest;
                hex::encode(sha2::Sha256::digest(&processed.bytes))
            };

            let existing_page = page_at_slot(&state.pool, chapter_id, requested).await;
            let existing_image_by_hash: Option<Image> =
                sqlx::query_as("SELECT * FROM images WHERE hash = $1 LIMIT 1")
                    .bind(&file_hash)
                    .fetch_optional(&state.pool)
                    .await
                    .unwrap_or(None);

            let page = match existing_page {
                Some(existing_page) => {
                    // Clear elements (+history) and layers, then maybe swap the image.
                    clear_page_layers(&state.pool, existing_page.id).await;
                    let old_image: Option<Image> =
                        sqlx::query_as("SELECT * FROM images WHERE id = $1")
                            .bind(existing_page.image_id)
                            .fetch_optional(&state.pool)
                            .await
                            .unwrap_or(None);
                    if old_image
                        .map(|i| i.hash.as_deref() != Some(file_hash.as_str()))
                        .unwrap_or(true)
                    {
                        let new_image_id = match existing_image_by_hash {
                            Some(existing) => existing.id,
                            None => {
                                let ext = file_extension_of(Some(&original_name));
                                let uuid = Uuid::new_v4();
                                let storage_path = format!("originals/{uuid}{ext}");
                                let content_type = content_type_by_extension(&storage_path);
                                if state
                                    .storage
                                    .upload_bytes(
                                        &storage_path,
                                        processed.bytes.clone(),
                                        content_type,
                                    )
                                    .await
                                    .is_err()
                                {
                                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                                }
                                let created = insert_image_public(
                                    &state.pool,
                                    &original_name,
                                    &storage_path,
                                    &file_hash,
                                    Some(user_id),
                                )
                                .await;
                                generate_thumbnail(
                                    &state.storage,
                                    &state.pool,
                                    created.id,
                                    &processed.bytes,
                                )
                                .await;
                                created.id
                            }
                        };
                        sqlx::query("UPDATE pages SET image_id=$2 WHERE id=$1")
                            .bind(existing_page.id)
                            .bind(new_image_id)
                            .execute(&state.pool)
                            .await
                            .expect("page image swap");
                        if existing_page.page_number == 1 {
                            recalculate_chapter_cover(&state.pool, chapter_id).await;
                        }
                    }
                    page_at_slot(&state.pool, chapter_id, existing_page.page_number)
                        .await
                        .unwrap_or(existing_page)
                }
                None => match existing_image_by_hash {
                    Some(existing) => {
                        crate::clone::create_page_with_existing_image(
                            &state.pool,
                            chapter,
                            existing.id,
                            requested,
                        )
                        .await
                    }
                    None => {
                        let ext = file_extension_of(Some(&original_name));
                        let uuid = Uuid::new_v4();
                        let storage_path = format!("originals/{uuid}{ext}");
                        let content_type = content_type_by_extension(&storage_path);
                        if state
                            .storage
                            .upload_bytes(&storage_path, processed.bytes.clone(), content_type)
                            .await
                            .is_err()
                        {
                            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                        }
                        let image = insert_image_public(
                            &state.pool,
                            &original_name,
                            &storage_path,
                            &file_hash,
                            Some(user_id),
                        )
                        .await;
                        generate_thumbnail(&state.storage, &state.pool, image.id, &processed.bytes)
                            .await;
                        crate::clone::create_page_with_existing_image(
                            &state.pool,
                            chapter,
                            image.id,
                            requested,
                        )
                        .await
                    }
                },
            };

            let restored = restore_project_layers(state, page.id, &project_bytes, false).await;
            if restored.is_err() {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }

            Json(UploadResponse {
                pageId: Some(page.id),
                imageId: Some(page.image_id),
                status: "imported".into(),
            })
            .into_response()
        }
        None => {
            // ---- Case B: plain image archive ----
            if contents.images_sorted.is_empty() {
                return zip_error("error: zip contains no images".into());
            }

            let mut first_page: Option<Page> = None;
            for (next_num, (entry_name, entry_bytes)) in
                (requested..).zip(contents.images_sorted.iter())
            {
                let processed =
                    match validate_and_process_image_bytes(Some(entry_name), entry_bytes.clone()) {
                        Ok(p) => p,
                        Err(message) => return zip_error(message),
                    };
                let file_hash = {
                    use sha2::Digest;
                    hex::encode(sha2::Sha256::digest(&processed.bytes))
                };

                let existing: Option<Image> =
                    sqlx::query_as("SELECT * FROM images WHERE hash = $1 LIMIT 1")
                        .bind(&file_hash)
                        .fetch_optional(&state.pool)
                        .await
                        .unwrap_or(None);

                let page = if let Some(existing_image) = existing {
                    let pg = crate::clone::create_page_with_existing_image(
                        &state.pool,
                        chapter,
                        existing_image.id,
                        next_num,
                    )
                    .await;
                    crate::clone::handle_duplicate_image_cloning(
                        state,
                        pg.id,
                        existing_image.id,
                        chapter,
                    )
                    .await;
                    pg
                } else {
                    let uuid = Uuid::new_v4();
                    let storage_path = format!("originals/{uuid}{}", processed.extension);
                    let content_type = content_type_by_extension(&storage_path);
                    if state
                        .storage
                        .upload_bytes(&storage_path, processed.bytes.clone(), content_type)
                        .await
                        .is_err()
                    {
                        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                    }
                    let image = insert_image_public(
                        &state.pool,
                        &processed.filename,
                        &storage_path,
                        &file_hash,
                        Some(user_id),
                    )
                    .await;
                    generate_thumbnail(&state.storage, &state.pool, image.id, &processed.bytes)
                        .await;
                    let pg = crate::clone::create_page_with_existing_image(
                        &state.pool,
                        chapter,
                        image.id,
                        next_num,
                    )
                    .await;
                    crate::jobs::coordinator::start_pipeline(
                        state,
                        image.id,
                        Some(pg.id),
                        Some(chapter_id),
                    )
                    .await;
                    pg
                };

                if first_page.is_none() {
                    first_page = Some(page);
                }
            }

            match first_page {
                Some(first) => Json(UploadResponse {
                    pageId: Some(first.id),
                    imageId: Some(first.image_id),
                    status: "zip_imported".into(),
                })
                .into_response(),
                None => zip_error("error: no pages were created".into()),
            }
        }
    }
}

fn zip_error(status: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(UploadResponse {
            pageId: None,
            imageId: None,
            status,
        }),
    )
        .into_response()
}

/// Removes a page's layer elements (+edit history) and layers before a project restore.
async fn clear_page_layers(pool: &sqlx::PgPool, page_id: Uuid) {
    sqlx::query(
        "DELETE FROM layer_edit_history WHERE layer_element_id IN (\
             SELECT le.id FROM layer_elements le JOIN layers l ON l.id = le.layer_id WHERE l.page_id = $1)",
    )
    .bind(page_id)
    .execute(pool)
    .await
    .ok();
    sqlx::query(
        "DELETE FROM layer_elements WHERE layer_id IN (SELECT id FROM layers WHERE page_id = $1)",
    )
    .bind(page_id)
    .execute(pool)
    .await
    .ok();
    sqlx::query("DELETE FROM layers WHERE page_id = $1")
        .bind(page_id)
        .execute(pool)
        .await
        .ok();
}

pub async fn insert_image_public(
    pool: &sqlx::PgPool,
    filename: &str,
    storage_path: &str,
    hash: &str,
    created_by: Option<Uuid>,
) -> Image {
    insert_image(pool, filename, storage_path, hash, created_by).await
}

/// Restores `layers`/`elements` from a project.json; returns counts on success.
/// `track_manual_edits` stamps the image's last_edited_at when manual edits exist
/// (the chapters/{id}/import-project behaviour).
async fn restore_project_layers(
    state: &AppState,
    page_id: Uuid,
    project_json: &[u8],
    track_manual_edits: bool,
) -> Result<(usize, usize), ()> {
    let root: serde_json::Value = serde_json::from_slice(project_json).map_err(|_| ())?;
    let layers_node = root
        .get("layers")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut imported_layers = 0usize;
    let mut imported_elements = 0usize;
    let mut has_manual_edits = false;

    for layer_node in &layers_node {
        let ltype = layer_node
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("translation")
            .to_string();
        let target_language = layer_node
            .get("targetLanguage")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let visible = !layer_node
            .get("visible")
            .map(|v| v.as_bool() == Some(false))
            .unwrap_or(false);
        let z_order = layer_node
            .get("zOrder")
            .and_then(|v| v.as_i64())
            .unwrap_or(0) as i32;
        let metadata_json = layer_node
            .get("metadataJson")
            .filter(|v| !v.is_null())
            .cloned();

        let layer_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, created_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,now())",
        )
        .bind(layer_id)
        .bind(&ltype)
        .bind(&target_language)
        .bind(visible)
        .bind(z_order)
        .bind(&metadata_json)
        .bind(page_id)
        .execute(&state.pool)
        .await
        .map_err(|_| ())?;
        imported_layers += 1;

        let elements = layer_node
            .get("elements")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for el in &elements {
            let text = el
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let font = el
                .get("font")
                .and_then(|v| v.as_str())
                .unwrap_or("Comic Neue")
                .to_string();
            let size = el.get("size").and_then(|v| v.as_f64()).unwrap_or(16.0);
            let auto_size = !(el
                .get("autoSize")
                .map(|v| v.as_bool() == Some(false))
                .unwrap_or(false));
            let max_width = el.get("maxWidth").and_then(|v| v.as_i64()).unwrap_or(150) as i32;
            let max_height = el.get("maxHeight").and_then(|v| v.as_i64()).unwrap_or(80) as i32;
            let word_wrap = !(el
                .get("wordWrap")
                .map(|v| v.as_bool() == Some(false))
                .unwrap_or(false));
            let rotation = el.get("rotation").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let x = el.get("x").and_then(|v| v.as_f64()).unwrap_or(100.0);
            let y = el.get("y").and_then(|v| v.as_f64()).unwrap_or(100.0);
            let el_visible = !(el
                .get("visible")
                .map(|v| v.as_bool() == Some(false))
                .unwrap_or(false));
            let background_color = el
                .get("backgroundColor")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let text_color = el
                .get("textColor")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let font_weight = el
                .get("fontWeight")
                .and_then(|v| v.as_str())
                .unwrap_or("normal")
                .to_string();
            let font_style = el
                .get("fontStyle")
                .and_then(|v| v.as_str())
                .unwrap_or("normal")
                .to_string();
            let box_shape = el
                .get("boxShape")
                .and_then(|v| v.as_str())
                .unwrap_or("rectangular")
                .to_string();

            // Only import-project tracks isManuallyEdited (the upload branch ignores it).
            let is_manually_edited = if track_manual_edits {
                el.get("isManuallyEdited")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            } else {
                false
            };
            if is_manually_edited {
                has_manual_edits = true;
            }

            let mask_polygon = el.get("maskPolygon").filter(|v| !v.is_null()).map(|v| {
                if v.is_object() || v.is_array() {
                    v.to_string().into()
                } else {
                    v.clone()
                }
            });

            let region_id = el
                .get("regionId")
                .and_then(|v| v.as_str())
                .and_then(|s| Uuid::parse_str(s).ok());

            sqlx::query(
                "INSERT INTO layer_elements (id, text, font, size, auto_size, max_width, max_height, word_wrap, rotation, \
                 x, y, visible, background_color, text_color, font_weight, font_style, box_shape, mask_polygon, \
                 is_manually_edited, layer_id, region_id) \
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)",
            )
            .bind(Uuid::new_v4())
            .bind(text)
            .bind(font)
            .bind(size)
            .bind(auto_size)
            .bind(max_width)
            .bind(max_height)
            .bind(word_wrap)
            .bind(rotation)
            .bind(x)
            .bind(y)
            .bind(el_visible)
            .bind(background_color)
            .bind(text_color)
            .bind(font_weight)
            .bind(font_style)
            .bind(box_shape)
            .bind(mask_polygon)
            .bind(is_manually_edited)
            .bind(layer_id)
            .bind(region_id)
            .execute(&state.pool)
            .await
            .map_err(|_| ())?;
            imported_elements += 1;
        }
    }

    if has_manual_edits && track_manual_edits {
        let image_id: Option<Uuid> = sqlx::query_scalar("SELECT image_id FROM pages WHERE id = $1")
            .bind(page_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
        if let Some(image_id) = image_id {
            let _ = sqlx::query("UPDATE images SET last_edited_at = now() WHERE id = $1")
                .bind(image_id)
                .execute(&state.pool)
                .await;
        }
    }

    Ok((imported_layers, imported_elements))
}

/// POST /api/chapters/{chapterId}/import-project — restore a page-level project export
/// onto the chapter's next slot (or replace the page already occupying it).
pub async fn import_project(
    State(state): State<AppState>,
    user: AuthUser,
    Path(chapter_id): Path<Uuid>,
    multipart: Multipart,
) -> Response {
    let mut multipart = multipart;

    let Some(_chapter) = sqlx::query_as::<_, Chapter>("SELECT * FROM chapters WHERE id = $1")
        .bind(chapter_id)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None)
    else {
        return error::not_found(
            &format!("Chapter not found: {chapter_id}"),
            "/api/chapters/{chapterId}/import-project",
        );
    };

    let mut project_json: Option<Vec<u8>> = None;
    let mut original: Option<(String, Vec<u8>)> = None;

    while let Ok(Some(mut field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name != "file" {
            continue;
        }
        let filename = field.file_name().unwrap_or("").to_string();
        let mut bytes = Vec::new();
        use futures_util::StreamExt;
        while let Some(chunk) = field.next().await {
            match chunk {
                Ok(data) => bytes.extend_from_slice(&data),
                Err(_) => break,
            }
        }
        match crate::archive::read_archive(&bytes) {
            Ok(contents) => {
                project_json = contents.project_json;
                original = contents.original_image;
                let lower = filename.to_lowercase();
                if project_json.is_none() && (lower.ends_with(".json")) {
                    project_json = Some(bytes);
                }
            }
            Err(err) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "message": err })),
                )
                    .into_response();
            }
        }
    }

    let Some(project_bytes) = project_json else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "message": "Invalid zip: project.json missing" })),
        )
            .into_response();
    };

    let page_count: i32 =
        sqlx::query_scalar("SELECT COUNT(*)::int FROM pages WHERE chapter_id = $1")
            .bind(chapter_id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or(0);
    let page_number = page_count + 1;

    // Slot occupied? Replace its contents; otherwise create a fresh page at that slot.
    let existing_page = page_at_slot(&state.pool, chapter_id, page_number).await;
    let page = match &existing_page {
        Some(existing_page) => {
            clear_page_layers(&state.pool, existing_page.id).await;
            if let Some((original_name, original_bytes)) = original {
                let file_hash = hex::encode(sha2::Sha256::digest(&original_bytes));
                let old_hash_matches = sqlx::query_scalar::<_, Option<String>>(
                    "SELECT hash FROM images WHERE id = $1",
                )
                .bind(existing_page.image_id)
                .fetch_optional(&state.pool)
                .await
                .ok()
                .flatten()
                .flatten()
                .map(|h| h == file_hash)
                .unwrap_or(false);

                if !old_hash_matches {
                    let new_image_id = match sqlx::query_as::<_, Image>(
                        "SELECT * FROM images WHERE hash = $1 LIMIT 1",
                    )
                    .bind(&file_hash)
                    .fetch_optional(&state.pool)
                    .await
                    .unwrap_or(None)
                    {
                        Some(existing) => existing.id,
                        None => {
                            let ext = file_extension_of(Some(original_name.as_str()));
                            let uuid = Uuid::new_v4();
                            let storage_path = format!("originals/{uuid}{ext}");
                            let content_type = content_type_by_extension(&storage_path);
                            if state
                                .storage
                                .upload_bytes(&storage_path, original_bytes.clone(), content_type)
                                .await
                                .is_err()
                            {
                                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                            }
                            let created = insert_image_public(
                                &state.pool,
                                original_name.as_str(),
                                &storage_path,
                                &file_hash,
                                Some(user.id),
                            )
                            .await;
                            generate_thumbnail(
                                &state.storage,
                                &state.pool,
                                created.id,
                                &original_bytes,
                            )
                            .await;
                            created.id
                        }
                    };
                    sqlx::query("UPDATE pages SET image_id=$2 WHERE id=$1")
                        .bind(existing_page.id)
                        .bind(new_image_id)
                        .execute(&state.pool)
                        .await
                        .expect("image swap");
                    if existing_page.page_number == 1 {
                        recalculate_chapter_cover(&state.pool, chapter_id).await;
                    }
                }
            }
            page_at_slot(&state.pool, chapter_id, existing_page.page_number)
                .await
                .unwrap_or_else(|| existing_page.clone())
        }
        None => {
            let Some((original_name, original_bytes)) = original else {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "message": "original.png missing in zip" })),
                )
                    .into_response();
            };
            let file_hash = hex::encode(sha2::Sha256::digest(&original_bytes));
            let ext = file_extension_of(Some(&original_name));
            let uuid = Uuid::new_v4();
            let storage_path = format!("originals/{uuid}{ext}");
            let content_type = content_type_by_extension(&storage_path);
            if state
                .storage
                .upload_bytes(&storage_path, original_bytes.clone(), content_type)
                .await
                .is_err()
            {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
            let image = insert_image_public(
                &state.pool,
                &original_name,
                &storage_path,
                &file_hash,
                Some(user.id),
            )
            .await;
            generate_thumbnail(&state.storage, &state.pool, image.id, &original_bytes).await;

            // Always create a NEW image row for imports to prevent layer stacking.
            let chapter: Chapter = sqlx::query_as("SELECT * FROM chapters WHERE id = $1")
                .bind(chapter_id)
                .fetch_one(&state.pool)
                .await
                .expect("chapter");
            crate::clone::create_page_with_existing_image(
                &state.pool,
                &chapter,
                image.id,
                page_number,
            )
            .await
        }
    };

    match restore_project_layers(&state, page.id, &project_bytes, true).await {
        Ok((layers_count, elements_count)) => {
            tracing::info!(
                "Successfully imported project ZIP to chapter {chapter_id}: {layers_count} layers and {elements_count} elements imported."
            );
            Json(json!({
                "status": "success",
                "pageId": page.id.to_string(),
            }))
            .into_response()
        }
        Err(()) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "message": "failed to restore project layers" })),
        )
            .into_response(),
    }
}
