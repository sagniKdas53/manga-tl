//! PageService clone pipeline port: `cloneOcrData`, `cloneTranslationData`,
//! `createPageWithExistingImage`, and PageController's `handleDuplicateImageCloning`.
//!
//! When an image is uploaded a second time, its existing OCR/translation work can be
//! reused — but only when the source and target chapters resolve to the SAME provider/
//! model configuration. Otherwise the stale data would be regenerated under different
//! models, so the whole pipeline re-runs instead.

use std::collections::HashMap;

use sqlx::PgPool;
use uuid::Uuid;

use crate::models::{Chapter, Image, Layer, LayerElement, OcrRegion, Page};
use crate::state::AppState;

/// Java PageService.createPageAndImage minus the image INSERT (caller uploads bytes).
pub async fn create_image(
    pool: &PgPool,
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

async fn max_page_number(pool: &PgPool, chapter_id: Uuid) -> i32 {
    sqlx::query_scalar("SELECT COALESCE(MAX(page_number), 0) FROM pages WHERE chapter_id = $1")
        .bind(chapter_id)
        .fetch_one(pool)
        .await
        .unwrap_or(0)
}

/// createPageWithExistingImage: clamp into [1, max+1], shift up on collision,
/// short-circuit when the slot already holds THIS image.
pub async fn create_page_with_existing_image(
    pool: &PgPool,
    chapter: &Chapter,
    image_id: Uuid,
    requested_number: i32,
) -> Page {
    let max_existing = max_page_number(pool, chapter.id).await;
    let safe = requested_number.clamp(1, max_existing + 1);

    let existing: Option<Page> =
        sqlx::query_as("SELECT * FROM pages WHERE chapter_id = $1 AND page_number = $2")
            .bind(chapter.id)
            .bind(safe)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();

    if let Some(existing_page) = &existing {
        if existing_page.image_id == image_id {
            return existing_page.clone();
        }
        shift_pages_up(pool, chapter.id, safe).await;
    }

    let page: Page = sqlx::query_as(
        "INSERT INTO pages (id, page_number, chapter_id, image_id) VALUES ($1,$2,$3,$4) RETURNING *",
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

async fn shift_pages_up(pool: &PgPool, chapter_id: Uuid, starting_number: i32) {
    sqlx::query(
        "UPDATE pages SET page_number = page_number + 10000 \
         WHERE chapter_id = $1 AND page_number >= $2",
    )
    .bind(chapter_id)
    .bind(starting_number)
    .execute(pool)
    .await
    .expect("shift phase 1");
    sqlx::query(
        "UPDATE pages SET page_number = page_number - 9999 \
         WHERE chapter_id = $1 AND page_number > 10000",
    )
    .execute(pool)
    .await
    .expect("shift phase 2");
}

async fn recalculate_chapter_cover(pool: &PgPool, chapter_id: Uuid) {
    sqlx::query(
        "UPDATE chapters SET cover_image_id = COALESCE((\
             SELECT p.image_id FROM pages p WHERE p.chapter_id = $1 \
             ORDER BY p.page_number ASC LIMIT 1), NULL) WHERE id = $1",
    )
    .bind(chapter_id)
    .execute(pool)
    .await
    .expect("chapter cover recalculation");
}

/// ResolvedPipelineConfig for the duplicate-comparison (AUDIT-P1 task keys).
pub struct ResolvedPipelineConfig {
    pub ocr_provider: String,
    pub ocr_model: String,
    pub tl_provider: String,
    pub tl_model: String,
    pub qa_provider: String,
    pub qa_mode: String,
}

pub async fn resolve_config_for_chapter(
    state: &AppState,
    chapter_id: Uuid,
) -> Option<ResolvedPipelineConfig> {
    use crate::resolve::resolve_model;
    use crate::settings::{PipelineDefaults, load_global_settings};

    let chapter: Chapter = sqlx::query_as("SELECT * FROM chapters WHERE id = $1")
        .bind(chapter_id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten()?;
    let series: Option<crate::models::Series> =
        sqlx::query_as("SELECT * FROM series WHERE id = $1")
            .bind(chapter.series_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
    // Java used a dummy series; None reads behave identically here.
    let (s_ocr_provider, s_ocr_model, s_tl_provider, s_tl_model, s_qa_provider, s_qa_mode) =
        match &series {
            Some(s) => (
                s.ocr_provider.as_deref(),
                s.ocr_model.as_deref(),
                s.tl_provider.as_deref(),
                s.tl_model.as_deref(),
                s.qa_provider.as_deref(),
                s.qa_mode.as_deref(),
            ),
            None => (None, None, None, None, None, None),
        };

    let defaults = PipelineDefaults::from_env();
    let settings = load_global_settings(&state.pool, &defaults).await;
    let empty: Option<&str> = None;

    let resolved_ocr_provider = resolve_model(
        chapter.ocr_provider.as_deref(),
        s_ocr_provider,
        &settings.ocr_provider,
    );
    let mut resolved_ocr_model = crate::resolve::resolve_model_with_check(
        state,
        chapter.ocr_model.as_deref(),
        s_ocr_model,
        &settings.ocr_model,
        &resolved_ocr_provider,
        "ocr",
    );
    if resolved_ocr_provider == "local" {
        resolved_ocr_model = crate::resolve::resolve_model_with_check(
            state,
            chapter.ocr_model.as_deref(),
            s_ocr_model,
            &settings.local_ocr_model,
            &resolved_ocr_provider,
            "ocr",
        );
    }
    let resolved_tl_provider = resolve_model(
        chapter.tl_provider.as_deref(),
        s_tl_provider,
        &settings.tl_provider,
    );
    let resolved_tl_model = crate::resolve::resolve_model_with_check(
        state,
        chapter.tl_model.as_deref(),
        s_tl_model,
        &settings.tl_model,
        &resolved_tl_provider,
        "tl",
    );
    let resolved_qa_provider = resolve_model(
        chapter.qa_provider.as_deref(),
        s_qa_provider,
        &settings.qa_provider,
    );
    let _resolved_qa_llm = crate::resolve::resolve_model_with_check(
        state,
        chapter.qa_llm_model.as_deref(),
        empty,
        &settings.qa_llm_model,
        &resolved_qa_provider,
        "qaLLM",
    );
    let resolved_qa_mode = resolve_model(chapter.qa_mode.as_deref(), s_qa_mode, &settings.qa_mode);

    Some(ResolvedPipelineConfig {
        ocr_provider: resolved_ocr_provider,
        ocr_model: resolved_ocr_model,
        tl_provider: resolved_tl_provider,
        tl_model: resolved_tl_model,
        qa_provider: resolved_qa_provider,
        qa_mode: resolved_qa_mode,
    })
}

fn same(a: &str, b: &str) -> bool {
    a == b
}

/// PageController.handleDuplicateImageCloning: reuse the best-matching source page's
/// OCR (and translation, when configs allow); otherwise run the full pipeline.
pub async fn handle_duplicate_image_cloning(
    state: &AppState,
    new_page_id: Uuid,
    image_id: Uuid,
    target_chapter: &Chapter,
) {
    let pages: Vec<Page> =
        sqlx::query_as("SELECT * FROM pages WHERE image_id = $1 ORDER BY created_at ASC")
            .bind(image_id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();
    if pages.is_empty() {
        return;
    }

    // Prefer same chapter (2), then same series (1), then anything (0); ties break on id.
    #[derive(PartialEq, Eq, PartialOrd, Ord)]
    struct Affinity(i32, Uuid);
    let target_series: Option<Uuid> =
        sqlx::query_scalar("SELECT series_id FROM chapters WHERE id = $1")
            .bind(target_chapter.id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();

    let mut candidates: Vec<(Affinity, &Page)> = Vec::new();
    for p in &pages {
        if p.id == new_page_id {
            continue;
        }
        let has_ocr_layer: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM layers WHERE page_id=$1 AND type ILIKE 'ocr')",
        )
        .bind(p.id)
        .fetch_one(&state.pool)
        .await
        .unwrap_or(false);
        if !has_ocr_layer {
            continue;
        }
        let chapter_of_page: Option<Chapter> =
            sqlx::query_as("SELECT * FROM chapters WHERE id = $1")
                .bind(p.chapter_id)
                .fetch_optional(&state.pool)
                .await
                .ok()
                .flatten();
        let affinity = match (&chapter_of_page, target_series) {
            (Some(ch), _) if ch.id == target_chapter.id => Affinity(2, p.id),
            (Some(ch), Some(series)) if ch.series_id == series => Affinity(1, p.id),
            _ => Affinity(0, p.id),
        };
        candidates.push((affinity, p));
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0)); // reversed comparator

    let Some(source_page) = candidates.first().map(|(_, p)| *p) else {
        crate::jobs::coordinator::start_pipeline(
            state,
            image_id,
            Some(new_page_id),
            Some(target_chapter.id),
        )
        .await;
        return;
    };

    let Some(source_config) = resolve_config_for_chapter(state, source_page.chapter_id).await
    else {
        return;
    };
    let Some(target_config) = resolve_config_for_chapter(state, target_chapter.id).await else {
        return;
    };

    let ocr_matches = same(&source_config.ocr_provider, &target_config.ocr_provider)
        && same(&source_config.ocr_model, &target_config.ocr_model);
    if !ocr_matches {
        crate::jobs::coordinator::start_pipeline(
            state,
            image_id,
            Some(new_page_id),
            Some(target_chapter.id),
        )
        .await;
        return;
    }

    let region_map = clone_ocr_data(&state.pool, source_page.id, new_page_id).await;

    let tl_matches = same(&source_config.tl_provider, &target_config.tl_provider)
        && same(&source_config.tl_model, &target_config.tl_model)
        && same(&source_config.qa_provider, &target_config.qa_provider)
        && same(&source_config.qa_mode, &target_config.qa_mode);

    if tl_matches {
        clone_translation_data(&state.pool, source_page.id, new_page_id, &region_map).await;
        crate::jobs::coordinator::trigger_page_redo(
            state,
            new_page_id,
            "render",
            Some(target_chapter.id),
        )
        .await
        .ok();
    } else {
        crate::jobs::coordinator::trigger_page_redo(
            state,
            new_page_id,
            "translation",
            Some(target_chapter.id),
        )
        .await
        .ok();
    }
}

/// CloneOcrData: copies regions (clearing TL/QA fields) and the newest VISIBLE OCR layer.
pub async fn clone_ocr_data(
    pool: &PgPool,
    source_page_id: Uuid,
    target_page_id: Uuid,
) -> HashMap<Uuid, Uuid> {
    let mut region_map = HashMap::new();

    let source_layers: Vec<Layer> = sqlx::query_as("SELECT * FROM layers WHERE page_id = $1")
        .bind(source_page_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    let Some(source_ocr_layer) = source_layers
        .iter()
        .filter(|l| l.layer_type.eq_ignore_ascii_case("ocr") && l.visible.unwrap_or(false))
        .max_by_key(|l| l.z_order)
    else {
        return region_map;
    };

    let source_regions: Vec<OcrRegion> =
        sqlx::query_as("SELECT * FROM ocr_regions WHERE page_id = $1")
            .bind(source_page_id)
            .fetch_all(pool)
            .await
            .unwrap_or_default();

    for region in &source_regions {
        let cloned_id = Uuid::new_v4();
        let inserted = sqlx::query(
            "INSERT INTO ocr_regions (id, approved, background_color, bbox_x, bbox_y, bbox_w, bbox_h, \
             bubble_x, bubble_y, bubble_w, bubble_h, bubble_id, bubble_reading_order, confidence, detected_language, \
             detection_confidence, mask_polygon, ocr_score, panel_reading_order, qa_feedback, qa_score, qa_status, \
             region_type, rotation, safe_text_x, safe_text_y, safe_text_w, safe_text_h, text, \
             translated_text, translation_failed, translation_score, page_id, panel_id) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29, \
             NULL,FALSE,NULL,$30,$31)",
        )
        .bind(cloned_id)
        .bind(false)
        .bind(&region.background_color)
        .bind(region.bbox_x)
        .bind(region.bbox_y)
        .bind(region.bbox_w)
        .bind(region.bbox_h)
        .bind(region.bubble_x)
        .bind(region.bubble_y)
        .bind(region.bubble_w)
        .bind(region.bubble_h)
        .bind(&region.bubble_id)
        .bind(region.bubble_reading_order)
        .bind(region.confidence)
        .bind(&region.detected_language)
        .bind(region.detection_confidence)
        .bind(&region.mask_polygon)
        .bind(region.ocr_score)
        .bind(region.panel_reading_order)
        .bind::<Option<String>>(None)
        .bind::<Option<f64>>(None)
        .bind("pending")
        .bind(&region.region_type)
        .bind(region.rotation)
        .bind(region.safe_text_x)
        .bind(region.safe_text_y)
        .bind(region.safe_text_w)
        .bind(region.safe_text_h)
        .bind(&region.text)
        .bind(target_page_id)
        .bind(region.panel_id)
        .execute(pool)
        .await;
        if inserted.is_ok() {
            region_map.insert(region.id, cloned_id);
        }
    }

    // Clone the OCR layer itself.
    let cloned_layer_id = Uuid::new_v4();
    let created = sqlx::query(
        "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, created_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())",
    )
    .bind(cloned_layer_id)
    .bind(&source_ocr_layer.layer_type)
    .bind(&source_ocr_layer.target_language)
    .bind(source_ocr_layer.visible)
    .bind(source_ocr_layer.z_order)
    .bind(&source_ocr_layer.metadata_json)
    .bind(target_page_id)
    .execute(pool)
    .await;
    if created.is_err() {
        return region_map;
    }

    let elements: Vec<LayerElement> = sqlx::query_as(
        "SELECT le.* FROM layer_elements le JOIN layers l ON l.id = le.layer_id \
         WHERE l.page_id = $1 AND le.layer_id = $2",
    )
    .bind(source_page_id)
    .bind(source_ocr_layer.id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    for el in elements {
        clone_layer_element(pool, &el, cloned_layer_id, &region_map).await;
    }

    region_map
}

/// CloneTranslationData: copy TL/QA region fields, then the TL layer + its elements.
pub async fn clone_translation_data(
    pool: &PgPool,
    source_page_id: Uuid,
    target_page_id: Uuid,
    region_map: &HashMap<Uuid, Uuid>,
) {
    let source_layers: Vec<Layer> = sqlx::query_as("SELECT * FROM layers WHERE page_id = $1")
        .bind(source_page_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    let Some(source_tl_layer) = source_layers
        .iter()
        .filter(|l| l.layer_type.eq_ignore_ascii_case("translation") && l.visible.unwrap_or(false))
        .max_by_key(|l| l.z_order)
    else {
        return;
    };

    let source_regions: Vec<OcrRegion> =
        sqlx::query_as("SELECT * FROM ocr_regions WHERE page_id = $1")
            .bind(source_page_id)
            .fetch_all(pool)
            .await
            .unwrap_or_default();
    for source in &source_regions {
        if let Some(new_region_id) = region_map.get(&source.id) {
            let _ = sqlx::query(
                "UPDATE ocr_regions SET translated_text=$2, approved=$3, translation_failed=$4, \
                 translation_score=$5, qa_score=$6, qa_feedback=$7, qa_status=$8 WHERE id=$1",
            )
            .bind(new_region_id)
            .bind(&source.translated_text)
            .bind(source.approved)
            .bind(source.translation_failed)
            .bind(source.translation_score)
            .bind(source.qa_score)
            .bind(&source.qa_feedback)
            .bind(&source.qa_status)
            .execute(pool)
            .await;
        }
    }

    let cloned_layer_id = Uuid::new_v4();
    if sqlx::query(
        "INSERT INTO layers (id, type, target_language, visible, z_order, metadata_json, page_id, created_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())",
    )
    .bind(cloned_layer_id)
    .bind(&source_tl_layer.layer_type)
    .bind(&source_tl_layer.target_language)
    .bind(source_tl_layer.visible)
    .bind(source_tl_layer.z_order)
    .bind(&source_tl_layer.metadata_json)
    .bind(target_page_id)
    .execute(pool)
    .await
    .is_err()
    {
        return;
    }

    let elements: Vec<LayerElement> = sqlx::query_as(
        "SELECT le.* FROM layer_elements le JOIN layers l ON l.id = le.layer_id \
         WHERE l.page_id = $1 AND le.layer_id = $2",
    )
    .bind(source_page_id)
    .bind(source_tl_layer.id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    for el in elements {
        clone_layer_element(pool, &el, cloned_layer_id, region_map).await;
    }
}

/// Copies every LayerElement field, repointing region through the map (AUDIT-Q3).
async fn clone_layer_element(
    pool: &PgPool,
    el: &LayerElement,
    target_layer_id: Uuid,
    region_map: &HashMap<Uuid, Uuid>,
) {
    let mapped_region = el.region_id.and_then(|rid| region_map.get(&rid)).copied();
    let _ = sqlx::query(
        "INSERT INTO layer_elements (id, auto_size, background_color, box_shape, font, font_style, font_weight, \
         is_manually_edited, mask_polygon, max_height, max_width, overflow, rotation, size, text, text_color, visible, \
         word_wrap, x, y, edited_at, layer_id, region_id) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)",
    )
    .bind(Uuid::new_v4())
    .bind(el.auto_size)
    .bind(&el.background_color)
    .bind(&el.box_shape)
    .bind(&el.font)
    .bind(&el.font_style)
    .bind(&el.font_weight)
    .bind(el.is_manually_edited)
    .bind(&el.mask_polygon)
    .bind(el.max_height)
    .bind(el.max_width)
    .bind(el.overflow)
    .bind(el.rotation)
    .bind(el.size)
    .bind(&el.text)
    .bind(&el.text_color)
    .bind(el.visible)
    .bind(el.word_wrap)
    .bind(el.x)
    .bind(el.y)
    .bind(el.edited_at)
    .bind(target_layer_id)
    .bind(mapped_region)
    .execute(pool)
    .await;
}
