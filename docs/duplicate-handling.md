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

## The Model Testing Issue

Because `Layer`, `Panel`, and `OcrRegion` entities are currently tied to the `Image` entity (not the `Page`), and because we completely deduplicate `Image` entities (reusing the exact same database row when the hash matches), a structural limitation exists:

If an identical image is uploaded to a different chapter (for example, to test a different OCR/Translation model on the same raw page), it will reuse the existing `Image` entity. Consequently, it inherits the exact same layers and won't get re-processed. If it were re-processed, it would overwrite the layers for the original chapter.

## Proposed Future Fix

To fix this without a massive architectural rewrite, we should change how we deduplicate. Instead of reusing the `Image` **entity** (the database row), we should only deduplicate the **MinIO file**.

**Proposed Flow for Duplicate Hashes:**
1. Create a brand new `Image` entity with a new UUID.
2. Set its `storagePath` to the exact same path as the existing file in MinIO.
3. This new `Image` entity will get its own fresh set of `Layer`, `Panel`, and `OcrRegion` rows in the database.

This allows the new chapter to run its own pipeline with different models (e.g., Gemini vs Local OCR), while still saving storage space since the raw file is only stored once in MinIO.
