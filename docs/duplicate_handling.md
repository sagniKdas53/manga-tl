# Duplicate Image Handling

This document explains how the Manga Library backend handles duplicate image uploads and outlines the planned future architecture for model testing across chapters.

## Current Behavior

When an image is uploaded, the system computes its SHA-256 hash. If an image with that hash already exists in the database, the system behaves differently depending on the upload context.

### 1. Standard Single Image Upload

- **Idempotency Guard**: If the system detects that a page already exists in the *same chapter* at the *exact requested page number*, and it points to this identical image, it silently accepts it and returns `200 OK` with `status: "already_exists"`. This prevents race conditions when re-uploading at the same slot.
- **Different Slot (New Page)**: If the page doesn't exist at that exact slot, the system ignores the requested `pageNumber`, calculates a `safePageNumber` (the maximum page number in the chapter + 1), and appends the image to the end of the chapter. It returns `200 OK` with `status: "duplicate"`.

### 2. Multi-Image ZIP/EPUB Upload

- For each duplicate image, if a page already exists at the expected sequence number with the identical image, it is accepted.
- If the sequence number is taken by a *different* image, the system shifts all subsequent pages up by 1 and inserts the duplicate.

### 3. Page-Level ZIP Restore

- When restoring a `project.json` backup for a specific slot, the system deletes all existing layers/elements for that slot.
- If the uploaded image hash is the same as the existing image, it reuses the image and rebuilds the layers.

## Architecture & Intelligent Cloning

Because `Layer`, `Panel`, and `OcrRegion` entities are tied to the **`Page`** entity (not the `Image`), duplicate images uploaded to different chapters (or different slots) result in a brand new `Page` entity.

To save time, cost, and storage, the system performs **intelligent layer cloning** when a duplicate image is detected. The process follows these steps:

1. **Source Page Selection**: The system searches all existing pages that use the identical image to find a source to clone from. It prioritizes the best candidate by scoring them: pages from the *same chapter* are preferred first (score 2), followed by pages from the *same series* (score 1), and finally pages from any other series (score 0). Ties are broken on the lowest page id, so the choice is stable across retries. If no existing page has successfully run the OCR pipeline, cloning is skipped.

2. **OCR Data Cloning**: The system compares the new chapter's OCR configuration (provider, model) against the source page's configuration. If they match, the system clones all `OcrRegion` entities to the new page. If they differ, the OCR layer is not cloned, and a full pipeline run is triggered to generate new OCR regions.
3. **Translation Data Cloning**: If the OCR data was successfully cloned, the system also checks the Translation configuration (provider, model, QA mode, QA provider, QA LLM/VLM models). If these perfectly match, the Translation layers and all their corresponding `LayerElement`s are cloned.
4. **Pipeline Triggering**:
   - If both OCR and Translation are successfully cloned, the system skips downstream heavy AI tasks and only triggers the **Render** job for the new page.
   - If OCR is cloned but Translation configs do not match, the system enqueues a **Translation** job for the new page.
   - If OCR configs do not match, the entire AI pipeline starts from the beginning.

This cloning operates securely: it deep-copies all layout and text data (assigning new UUIDs to the new layers and regions) while correctly remapping element references. Thus, modifying layers on the original page will not affect the duplicated page in another chapter, and vice-versa, allowing independent testing and edits.

## Image-Scoped vs Page-Scoped State

Two pieces of state deliberately live on the **`Image`** rather than the **`Page`**, and the pipeline has to respect that:

- **`Panel`s** are attached to the `Image`. Panel detection is a purely geometric step whose output is identical for every page reusing that image, and `OcrRegion.panel_id` — including regions belonging to *other* chapters' pages — points at those rows. Therefore panels are detected exactly once per image: `startPipeline` skips the panel-detection stage when panels already exist and starts at OCR instead, and the panel callback reuses existing panels rather than replacing them. Replacing them would violate the `ocr_regions → panels` foreign key and abort the callback transaction, killing the pipeline for the duplicate before OCR ever ran.
- **The rendered output and the source file** are shared, as expected for identical bytes.

Everything else — layers, elements, OCR regions, conversations, QA retry counters — is page-scoped.

## Page-Scoped Job Routing

Because one image can back pages in several chapters with *different* provider/model configurations, every job carries the `pageId` it was queued for, and each stage hand-off (panel → OCR → layout → translation → render → QA) passes that `pageId` to the next stage. The job payload's configuration (providers, models, QA mode, chapter/series titles) is resolved from that page's chapter.

Without this, a job resolves its configuration from "the first page that uses this image", which for a duplicate is another chapter's page — the queue would show, and the worker would run, the *original* chapter's models. Workers echo `pageId` back in their callbacks so the results are attributed to the right page.
