# Translation Pipeline Phases

This document describes the manga translation pipeline: its phases, the QA sub-pipeline, the maximum number of steps a single job can execute, and thumbnail generation.

Backend references below name the owning callback in `backend-rust/src/jobs/coordinator.rs`; line
numbers are intentionally omitted because this orchestration file changes frequently.

## Pipeline Phases (Execution Order)

The pipeline executes as an asynchronous callback chain over Redis job queues. When a worker completes a phase and sends its status callback to `/api/internal/jobs/{id}/status`, the coordinator persists the output and enqueues the subsequent phase.

1. **panel-detection** (`start_pipeline`): Identifies panel boundaries on the manga page. If panels already exist in the database, this step is skipped and the pipeline begins at `ocr`.
2. **ocr** (`handle_panel_callback`): Extracts text regions, polygon contours, and raw source text.
3. **layout** (`handle_ocr_callback`): Classifies region types (`speech`, `narration`, `thought`, `sfx`) and groups related dialogue bubbles.
4. **translation** (`handle_layout_callback`): Translates text regions via configured LLMs. Dispatcher enforces sequential translation when `use_context_memory` is enabled (`AUDIT-W13`).
5. **render** (`handle_translation_callback`): Typesets and inpaints translated text into speech bubbles and caption plates on the page image.
6. **qa** (`handle_render_callback`): Quality assurance evaluation.
7. **render (finalPass)** (`handle_qa_callback`): Enqueued when QA makes direct text edits or rejects false SFX regions (`AUDIT-B12`). Flagged with `finalPass: true` so the subsequent render completion terminates the pipeline rather than re-entering QA.

> **Same-Language Passthrough**: `start_pipeline` always queues panel detection / OCR. If a series' source language matches its target, `handle_layout_callback` short-circuits after layout — it completes the layout job and ends the pipeline, so translation, render, and QA never run.

---

## QA Sub-Pipeline

QA evaluates the rendered output and can request targeted retries.

### Modes (`worker/src/worker/handlers/qa.py`)

- **llm**: Text-only semantic review.
- **vlm**: Visual inspection of the rendered image.
- **hybrid**: Two passes: LLM text check followed by an inline re-render (`render_image_core`) and a VLM visual inspection.
- **none**: Automatic pass for all regions.

### Callback Handling & Retries (`handle_qa_callback`)

- **direct_fix / fixed**: Applies text/font corrections inline and enqueues a `finalPass` render.
- **needsManualIntervention**: Halts the pipeline; marks the affected regions and the QA layer's metadata `manual_review` and returns the `MANUAL_REVIEW` verdict. Accepted edits in the same callback still get a `finalPass` render.
- **needsReOcr**: Enqueues high-priority `qa-re-ocr`, which loops back through translation and render.
- **needsRetry (translatable error)**: Re-enqueues `translation` with reason `qa-re-translate`.
- **Retry budget**: Capped at 2 retries. When the retry limit is reached, remaining errors are logged and the pipeline finishes.

---

## Maximum Step Count for a Single Page

Taking the longest QA loop (`needsReOcr`) across the maximum 2 retries plus a `finalPass` render:

| # | Step | Trigger |
|---|---|---|
| 1 | panel-detection | Ingestion / `start_pipeline` |
| 2 | ocr | Panel callback |
| 3 | layout | OCR callback |
| 4 | translation | Layout callback |
| 5 | render | Translation callback |
| 6 | qa (pass 1) | Render callback -> fails with `needsReOcr` (retry 1) |
| 7 | qa-re-ocr | QA callback |
| 8 | translation | `qa-re-ocr` callback |
| 9 | render | Translation callback |
| 10 | qa (pass 2) | Render callback -> fails with `needsReOcr` (retry 2) |
| 11 | qa-re-ocr | QA callback |
| 12 | translation | `qa-re-ocr` callback |
| 13 | render | Translation callback |
| 14 | qa (pass 3) | Render callback -> retries exhausted, applies `direct_fix` |
| 15 | render (finalPass) | QA callback enqueues terminal render |

Maximum queued worker jobs: **15 jobs** (14 base/retry jobs + 1 terminal `finalPass` render).

---

## Thumbnail Generation

Thumbnail generation is decoupled from the worker pipeline:

1. **Source Thumbnails**: Created inline during image ingestion via `backend-rust/src/thumbnails.rs`. They are encoded as 512px WebP images directly in Rust using the `image` and `webp` crates.
2. **Rendered Thumbnails (`AUDIT-F26`)**: Created upon successful completion of the `render` phase. Stored as 512px WebP variants and served at `GET /api/images/{imageId}/thumbnail/rendered?v=<lastRenderedAt>` to keep grid views up to date without downloading full-resolution PNG artifacts.
