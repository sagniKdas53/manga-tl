# Translation Pipeline Phases

This document describes the manga translation pipeline: its phases, the QA sub-pipeline, the maximum number of steps a single job can execute, and thumbnail generation.

All backend line references refer to `backend-rust/src/jobs/coordinator.rs` unless otherwise noted.

## Pipeline Phases (Execution Order)

The pipeline executes as an asynchronous callback chain over Redis job queues. When a worker completes a phase and sends its status callback to `/api/internal/jobs/{id}/status`, the coordinator persists the output and enqueues the subsequent phase.

1. **panel-detection** (`coordinator.rs:299`): Identifies panel boundaries on the manga page. Enqueued by `start_pipeline`. If panels already exist in the database, this step is skipped and the pipeline begins at `ocr`.
2. **ocr** (`coordinator.rs:779`): Extracts text regions, polygon contours, and raw source text. Triggered by `handle_panel_detection_callback`.
3. **layout** (`coordinator.rs:832`): Classifies region types (`speech`, `narration`, `thought`, `sfx`) and groups related dialogue bubbles. Triggered by `handle_ocr_callback`.
4. **translation** (`coordinator.rs:927`): Translates text regions via configured LLMs. Triggered by `handle_layout_callback`. Dispatcher enforces sequential translation when `use_context_memory` is enabled (`AUDIT-W13`).
5. **render** (`coordinator.rs:1365`): Typesets and inpaints translated text into speech bubbles and caption plates on the page image. Triggered by `handle_translation_callback`.
6. **qa** (`coordinator.rs:2039`): Quality assurance evaluation. Triggered by `handle_render_callback`.
7. **render (finalPass)** (`coordinator.rs:2075`): Enqueued when QA makes direct text edits or rejects false SFX regions (`AUDIT-B12`). Flagged with `finalPass: true` so the subsequent render completion terminates the pipeline rather than re-entering QA.

> **Same-Language Passthrough**: If a series source language matches target language, translation, render, and QA phases are skipped (`coordinator.rs:372`).

---

## QA Sub-Pipeline

QA evaluates the rendered output and can request targeted retries.

### Modes (`worker/src/worker/handlers/qa.py:70`)

- **llm**: Text-only semantic review.
- **vlm**: Visual inspection of the rendered image.
- **hybrid**: Two passes: LLM text check followed by an inline re-render (`render_image_core`) and a VLM visual inspection.
- **none**: Automatic pass for all regions.

### Callback Handling & Retries (`coordinator.rs:3270`)

- **direct_fix / fixed**: Applies text/font corrections inline and enqueues a `finalPass` render.
- **needsManualIntervention**: Halts the pipeline and sets page status to `MANUAL_REVIEW`.
- **needsReOcr**: Enqueues high-priority `qa-re-ocr`, which loops back through translation and render.
- **needsRetry (translatable error)**: Re-enqueues `translation` with reason `qa-re-translate`.
- **Retry budget**: Capped at 2 retries. When the retry limit is reached, remaining errors are logged and the pipeline finishes.

---

## Maximum Step Count for a Single Page

Taking the longest QA loop (`needsReOcr`) across the maximum 2 retries plus a `finalPass` render:

| # | Step | Trigger |
|---|---|---|
| 1 | panel-detection | Ingestion / `start_pipeline` (`:299`) |
| 2 | ocr | Panel callback (`:779`) |
| 3 | layout | OCR callback (`:832`) |
| 4 | translation | Layout callback (`:927`) |
| 5 | render | Translation callback (`:1365`) |
| 6 | qa (pass 1) | Render callback (`:2039`) -> fails with `needsReOcr` (retry 1) |
| 7 | qa-re-ocr | QA callback (`:3347`) |
| 8 | translation | `qa-re-ocr` callback (`:853`) |
| 9 | render | Translation callback (`:1365`) |
| 10 | qa (pass 2) | Render callback (`:2039`) -> fails with `needsReOcr` (retry 2) |
| 11 | qa-re-ocr | QA callback (`:3347`) |
| 12 | translation | `qa-re-ocr` callback (`:853`) |
| 13 | render | Translation callback (`:1365`) |
| 14 | qa (pass 3) | Render callback (`:2039`) -> retries exhausted, applies `direct_fix` |
| 15 | render (finalPass) | QA callback enqueues terminal render (`:2075`) |

Maximum queued worker jobs: **15 jobs** (14 base/retry jobs + 1 terminal `finalPass` render).

---

## Thumbnail Generation

Thumbnail generation is decoupled from the worker pipeline:

1. **Source Thumbnails**: Created during image ingestion via `backend-rust/src/thumbnails.rs`. Encoded as 512px WebP images directly in Rust using the `image` and `webp` crates under Tokio `spawn_blocking` pools.
2. **Rendered Thumbnails (`AUDIT-F26`)**: Created upon successful completion of the `render` phase. Stored as 512px WebP variants and served at `GET /api/pages/{id}/rendered/thumbnail?v=<lastRenderedAt>` to keep grid views up to date without downloading full-resolution PNG artifacts.
