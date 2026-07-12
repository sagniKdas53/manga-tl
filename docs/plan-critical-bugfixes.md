# Plan: Critical Bug Fixes

> Priority: **Start Immediately** | Estimated scope: ~15 files across backend, worker, frontend  
> Last updated: 2026-07-12

This plan addresses all broken, data-corrupting, or functionally incorrect behavior documented in `TODO.md`.  
Each phase ends with a **✅ Checkpoint** section listing what to test before moving on.

---

## Phase 1 — Data Integrity Fixes

These are the foundation. Nothing else can be trusted until shared-image deletion and per-chapter config resolution are correct.

### 1.1 Fix Shared Image Deletion (Cross-Chapter Cascade)

**Bug**: Deleting a page from one chapter also destroys the image in every other chapter it appears in.

**Root cause**: `PageService.deletePageDb()` unconditionally deletes the `Image` entity (line 90) without checking if other `Page` records reference it.

**Fix** (`PageService.java`):

- Before deleting the `Image`, count remaining references: `pageRepository.findByImageId(image.getId()).size()`
- Only delete the `Image` + MinIO files if count == 1 (this is the last reference)
- Otherwise, delete only the `Page` record and skip image/MinIO cleanup
- The `rendered/` image is tied to the `Image` entity so it must also be skipped if shared

### 1.2 Fix Per-Chapter Model Override Resolution

**Bug**: When an image belongs to two chapters with different overrides (e.g., local OCR vs cloud OCR), the pipeline uses whichever chapter `findFirst()` returns — typically the one the image was originally added to.

**Root cause**: `JobCoordinatorService.enqueueJobDirectly()` calls `pageRepository.findByImageId(imageId).stream().findFirst()` to resolve the chapter context. This is non-deterministic for shared images.

**Fix** (`JobCoordinatorService.java`):

- Add an optional `UUID chapterId` parameter to `startPipeline()`, `triggerImageRedo()`, `enqueueJob()`, and `enqueueJobDirectly()`
- When `chapterId` is provided, use `pageRepository.findByChapterIdAndImageId(chapterId, imageId)` to find the exact page (add this query to `PageRepository`)
- Fall back to `findFirst()` only when `chapterId` is null (e.g., startup recovery)
- Update all callers in `PageController.java` and `SeriesController.java` to pass the chapter context (which is always available at call sites)

### 1.3 Fix Re-Upload After Cross-Chapter Delete (Duplicate Key Constraint)

**Bug**: After deleting a shared image from one chapter (which incorrectly deletes the `Image` entity), re-uploading the same image to the same chapter fails with `pages_chapter_id_page_number_key` violation.

**Root cause**: The `Page` row for the chapter may have been orphaned (or the delete cascaded oddly), and re-uploading tries to insert a new page at the same `(chapter_id, page_number)`.

**Fix** (`PageController.java` + `PageService.java`):

- In `createPageWithExistingImage()`, check for an existing `Page` at `(chapter_id, page_number)` before inserting
- If one exists pointing to the same image, return it (idempotent)
- If one exists pointing to a different image, shift page numbers up to make room
- In the duplicate-hash upload flow (~line 494), calculate the correct `pageNumber` by finding `max(pageNumber) + 1` for the chapter, instead of trusting the frontend-supplied number blindly

### 1.4 Allow Duplicate Images in Same Chapter (Cover Page Use Case)

**Context**: Doujins often reuse the cover image as an interior page. The system should allow the same image hash to appear multiple times in a chapter.

**Fix** (`PageController.java`):

- When a duplicate hash is detected in the same chapter, still create a new `Page` entry linking to the existing `Image`
- Assign it the next available page number
- Do NOT re-trigger the full pipeline (OCR/TL already done) — only trigger translation if the target language layer is missing

### ✅ Checkpoint 1 — Data Integrity

**Automated tests to add/run:**

- `PageServiceTest`: upload image to Chapter A and Chapter B → delete from A → verify image + layers persist in B
- `PageServiceTest`: upload same image twice to same chapter → verify two pages created, no constraint violations
- `PageServiceTest`: upload image → delete → re-upload same image → verify success
- `JobCoordinatorTest`: share image between chapters with different `ocrProvider` settings → start pipeline from each → verify correct provider in job payload

**Manual checks:**

1. Upload the same image to 2 chapters - ✅ done
2. Delete from one → open the other → image must still display - ✅ done
3. Set Chapter A's OCR to `local` and Chapter B's to `openrouter` → re-run OCR from each → verify in worker logs which provider was used - ❌ needs refinement
4. Re-upload a previously deleted image → must not 500 - ✅ done

**Notes:**

1. The same image has the same hash so it makes sense to re-use the layers across chapters, but in some cause not creating a copy is bad as it causes the images to not be processed how we want
2. Image `b8cfa87c-a792-45a5-824e-f7fb36dcf114` was added to `https://ideapad.tail9ece4.ts.net/tlhub/chapters/f8eb5518-1c4e-47ae-98e8-2f4961dd12ee/local-ocr/reader/1` first and two runs of OCR were done which were correctly done by `MangaOCR/PaddleOCR(PP-OCRv6_medium_rec)`
3. When added to `https://ideapad.tail9ece4.ts.net/tlhub/chapters/51870862-444c-4576-92c7-3df29cd3033c/cloud-ocr/reader/1` this time when a re-ocr was triggered it still used the old OCR `MangaOCR/PaddleOCR(PP-OCRv6_medium_rec)` instead of the new one `google/gemini-2.5-flash` even though the chapter `https://ideapad.tail9ece4.ts.net/tlhub/chapters/51870862-444c-4576-92c7-3df29cd3033c/cloud-ocr/reader/1` was set to use `google/gemini-2.5-flash` as the cloud OCR over-ride
   1. So either the over-ride is not working
   2. Or this multi chapter is causing the ol(first chapters properties to be used instead of the current one)
4. Checkout [logs](../logs/run-14-phase-1.log) and [project](../examples/Sample1/page-1-layers(26)/project.json) to see if you can find the issue

---

## Phase 2 — Backend API & Export Fixes

### 2.1 Fix Chapter Export 500 Error ("no Session")

**Bug**: `GET /api/series/chapters/{id}/export?format=zip` returns 500 with a base64-encoded `LazyInitializationException`.

**Root cause**: After OSIV was disabled, `exportChapter()` in `SeriesController.java:625` accesses lazy-loaded entities (`page.getImage()`, `page.getChapter().getSeries()`) without an active transaction.

**Fix** (`SeriesController.java`):

- Add `@Transactional(readOnly = true)` to `exportChapter()`
- This ensures all lazy associations resolve within the Hibernate session

### 2.2 Fix Clear Queue API (Returns 999)

**Bug**: `DELETE /api/jobs/clear` returns `{"status":999,"error":"None"}` — the 999 status code indicates Spring caught an unhandled exception.

**Root cause**:

1. Missing `@Transactional` on `clearQueue()` — bulk delete fails silently
2. Queue names inconsistent with `requeuePendingJobs()` (missing `region-redo-ocr`, `region-redo-tl`)
3. Deleting `PROCESSING` jobs is dangerous — worker may still be running them

**Fix** (`JobController.java`):

- Add `@Transactional` to `clearQueue()`
- Fix Redis queue list to include ALL queues: `queue:region-redo-ocr`, `queue:region-redo-tl`
- Only clear jobs with status `PENDING`, `PAUSED`, `FAILED` — leave `PROCESSING` jobs alone
- Wrap in try/catch and return a proper error response on failure

### 2.3 Fix QA_MODE "auto" Not Recognized at Runtime

**Bug**: Worker logs `[QA] Unknown QA_MODE=auto, falling back to auto-pass` — QA is silently skipped.

**Root cause**: `config.py` resolves `"auto"` to `"vlm"`/`"llm"`/`"none"` at startup. But the backend sends `qaMode` per-job from chapter/series/global settings. When the resolved value is `"auto"` (literal string), the worker's `process_qa()` doesn't recognize it.

**Fix** (`qa.py` + `render.py`):

- Add `"auto"` as a recognized mode in `process_qa()`
- When `qa_mode_resolved == "auto"`, run the same detection logic inline (check for VLM/LLM capability from the job's provider/model data) to resolve to the correct mode
- Same fix in `render.py` (~line 805) for the render skip decision

### 2.4 Fix OCR Model Identifier String

**Bug**: Exports show `"model": "MangaOCR/PaddleOCR(PP-OCRv6_medium_rec)"` — the `MangaOCR/` prefix is a leftover from the removed MangaOCR dependency.

**Fix** (`ocr.py:1124`):

- Change `f"MangaOCR/PaddleOCR({rec_model})"` → `f"PaddleOCR({rec_model})"`

### ✅ Checkpoint 2 — API & Export

**Automated tests to add/run:**

- `SeriesControllerTest`: export a chapter with pages → verify 200 + valid ZIP with images
- `JobControllerTest`: create PENDING + FAILED + PROCESSING jobs → call clear → verify only PENDING + FAILED deleted, PROCESSING untouched
- `test_qa_extra.py`: add test for `QA_MODE=auto` → verify it resolves to a valid mode
- `test_ocr.py`: verify callback payload has `"PaddleOCR(...)"` without `"MangaOCR/"` prefix

**Manual checks:**

1. Export a chapter as ZIP → should download successfully, open the ZIP → verify images and `meta-data.json` are inside
2. Queue 5 jobs → click "Clear Queue" → verify toast + all non-processing jobs disappear
3. Set chapter QA mode to inherit (let it resolve to "auto") → run pipeline → check worker logs for `mode=vlm` or `mode=llm` (not `mode=auto`)

---

## Phase 3 — Upload Validation & Security

### 3.1 Add File Type Validation on Upload

**Bug**: A `.md` file was accepted as an image upload, created a page, and ran through the entire pipeline finding 0 layers.

**Fix** (`PageController.java`):

- At the top of the upload handler, validate using both:
  1. **Extension check**: Accept `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.bmp`, `.tiff`, `.tif`
  2. **Magic bytes check**: Read first 16 bytes and verify against known image signatures (PNG: `89 50 4E 47`, JPEG: `FF D8 FF`, GIF: `47 49 46 38`, WebP: `52 49 46 46...57 45 42 50`, BMP: `42 4D`, TIFF: `49 49 2A 00` or `4D 4D 00 2A`)
- For BMP/TIFF: accept on upload but convert to PNG internally before storing (ImageIO can read both natively)
- Return `400 Bad Request` with a descriptive error: `"Invalid file type. Accepted formats: PNG, JPEG, WebP, GIF, BMP, TIFF"`
- Apply the same validation inside the ZIP import flow

### 3.2 Duplicate Image Idempotency Guard

**Fix** (`PageController.java`):

- When a duplicate hash is detected and the image already exists in the **exact same chapter at the same page slot**, return `200` with status `"already_exists"` instead of crashing
- This is different from 1.4 (which allows adding a duplicate at a *new* page number) — this specifically handles the re-upload-at-same-slot race condition

### 3.3 Require Auth for Image File Endpoint

**Bug**: `GET /api/images/{id}/file` works without authentication.

**Root cause**: `SecurityConfig.java:44` has `.requestMatchers("/api/images/*/file").permitAll()`.

**Fix** (`SecurityConfig.java`):

- Remove the `/api/images/*/file` permitAll rule
- Keep `/api/images/*/thumbnail` as permitAll (thumbnails are used publicly for previews/covers)

### ✅ Checkpoint 3 — Validation & Security

**Automated tests to add/run:**

- `PageControllerTest`: upload a `.md` file → verify 400 response
- `PageControllerTest`: upload a `.bmp` file → verify 200 (accepted + converted)
- `SecurityConfigTest`: `GET /api/images/{id}/file` without auth → verify 401
- `SecurityConfigTest`: `GET /api/images/{id}/thumbnail` without auth → verify 200

**Manual checks:**

1. Drag-and-drop a `.md` file into the upload widget → should show an error toast, no page created
2. Open an incognito browser → navigate to an image `/file` URL → should get 401
3. Navigate to a thumbnail URL in incognito → should still load

---

## Phase 4 — Worker & Pipeline Robustness

### 4.1 Fix Worker Health Server BrokenPipeError

**Bug**: Health check logs are cluttered with `BrokenPipeError: [Errno 32] Broken pipe` stack traces.

**Root cause**: Docker/orchestrator closes the health check connection before the response is fully written.

**Fix** (`health_server.py`):

- Wrap `self.wfile.write(...)` in `try/except BrokenPipeError: pass`
- Override `log_request()` to suppress these at the log level too

### 4.2 Fix Translation Romanization in Outputs

**Bug**: Some cheap/free models return translations as `"Yào chūfā le o (About to depart!)"` — romanized text with the actual translation in parentheses.

**Fix** (translation prompt templates in `translation.py`):

- Add explicit instruction: `"NEVER include romanized text, pinyin, romaji, or pronunciation guides. Return ONLY the target-language translation."`
- Add negative examples directly in the prompt:

  ```
  BAD: "Yào chūfā le o (About to depart!)"
  GOOD: "About to depart!"
  BAD: "ERUFU (ELF!)"
  GOOD: "ELF!"
  ```

### 4.3 Fix Job Retry Counter (Confirmed Bug)

**Bug**: Frontend always shows `Attempt: 1/3` even when the worker retries internally (confirmed in `run-13-retry-check.log`).

**Root cause** (confirmed via code analysis):

The worker's `rq_tasks.py` has **no job-level retry logic at all**. The flow is:

1. Worker calls `update_job_status(job_id, "PROCESSING")` — sends `{status: "PROCESSING"}` (no attempt field)
2. If handler succeeds → `update_job_status(job_id, "COMPLETED")`
3. If handler fails → `update_job_status(job_id, "FAILED", error)` — goes straight to FAILED, never retries

The "retries" visible in worker logs (e.g., `Retry pass 1`, `Retrying 4 failed items in batch`) are **internal translation batch retries** within a single job execution — they retry individual regions against different models, not the job itself.

The `attempt` field in the job payload is set to `1` at creation time in `enqueueJobDirectly()` and **never incremented**. The backend `updateJobStatus` endpoint also doesn't accept or update `attempt`.

**Fix** (both `rq_tasks.py` + `InternalJobController.java`):

1. **Worker** (`rq_tasks.py`): On failure, instead of immediately marking FAILED:
   - Read `attempt` and `maxAttempts` from `job_data`
   - If `attempt < maxAttempts`: call `PATCH /status` with `{status: "PENDING", attempt: attempt+1}`
   - If `attempt >= maxAttempts`: call `PATCH /status` with `{status: "FAILED", error: ...}`
2. **Backend** (`InternalJobController.java`): Update `updateJobStatus` to:
   - Accept optional `attempt` field in the payload
   - When status is set to `PENDING` with a new attempt, update the DB record AND re-push to Redis
   - When status is set to `PROCESSING`/`COMPLETED`/`FAILED`, include `attempt` in the response for frontend display
3. **Backend** (`Job.java` / `JobController.getJobs()`): Ensure `attempt` and `maxAttempts` are included in the job list response so the frontend can display `2/3`, `3/3`

### 4.4 Fix Dockerfile Java Version Mismatch

**Bug**: `docker compose build` fails with `failed to resolve source metadata for docker.io/library/maven:3-eclipse-temurin-26: no such host`.

**Root cause**: `backend/Dockerfile:17` uses `maven:3-eclipse-temurin-26` and line 33 uses `eclipse-temurin:26-jre-alpine`. Java 26 is not GA — the Docker tags don't exist on Docker Hub. The project compiles with `java.version=17` and `release=17` in `pom.xml`, so there's no need for JDK 26.

**Fix** (`backend/Dockerfile`):

- Change `FROM maven:3-eclipse-temurin-26` → `FROM maven:3-eclipse-temurin-21`
- Change `FROM eclipse-temurin:26-jre-alpine` → `FROM eclipse-temurin:21-jre-alpine`
- Using JDK 21 (LTS) is forward-compatible with the `release=17` compiler target and gives access to virtual threads and other improvements if needed later

### 4.5 Fix QA Skipping Instead of Falling Back to Default Model

**Bug**: From `run-13-retry-check.log` line 693-695:

```
[QA] Processing image: ... (mode=auto)
[QA] Skipping QA (QA_MODE=none) for image: ...
[QA] Unknown QA_MODE=auto, falling back to auto-pass
```

QA is configured as `auto` but when the configured provider (ollama) can't be reached or doesn't have the QA model, it falls back to `none` (skip) instead of trying the globally configured QA models.

**Root cause**: The `auto` resolution in `process_qa()` checks if the job's `qaProvider` is available locally. When `qaProvider=ollama` and the ollama endpoint doesn't have the configured model, it resolves to `none` instead of falling through to the global default QA models from system settings.

**Fix** (`qa.py`):

- When `qa_mode == "auto"`, check available providers in priority order:
  1. Job's `qaProvider` + `qaLlmModel`/`qaVlmModel` — try this first
  2. If that fails, fall back to global system settings QA models
  3. Only resolve to `none` if ALL options are exhausted
- This mirrors how translation already handles the `Falling back to individual translation... using model 'deepseek/deepseek-v4-pro'` pattern seen in the same log

### ✅ Checkpoint 4 — Worker Stability

**Automated tests to add/run:**

- `test_health_server.py`: simulate aborted connection → verify no unhandled exception
- `test_translation_flow_e2e.py`: verify output contains no romanized text for known inputs
- `test_rq_tasks.py`: submit a job that will fail → verify it retries up to maxAttempts with incrementing counter → verify status PATCH includes `attempt: 2`
- `test_qa.py`: set QA mode to `auto` with unreachable provider → verify it falls back to default model, not `none`

**Manual checks:**

1. Run pipeline → check worker logs for absence of BrokenPipeError stack traces
2. Run OCR on a test page → check export → model should say `PaddleOCR(PP-OCRv6_medium_rec)` not `MangaOCR/...`
3. Kill MinIO briefly while a job is running → restart → verify the job retries and shows `Attempt: 2/3` in the frontend
4. `docker compose build` → verify no `temurin-26` resolution failure
5. Set QA provider to unreachable ollama → run pipeline → verify QA uses fallback model (not skipped)

---

## Summary: Files Changed

| Phase | File | Change |
|-------|------|--------|
| 1.1 | `PageService.java` | Check reference count before deleting Image |
| 1.2 | `JobCoordinatorService.java`, `PageRepository.java` | Add chapterId param to pipeline methods |
| 1.2 | `PageController.java`, `SeriesController.java` | Pass chapterId to startPipeline calls |
| 1.3 | `PageService.java`, `PageController.java` | Handle page slot conflicts on re-upload |
| 1.4 | `PageController.java` | Allow duplicate hash in same chapter |
| 2.1 | `SeriesController.java` | Add @Transactional to exportChapter |
| 2.2 | `JobController.java` | Add @Transactional, fix queue names, filter statuses |
| 2.3 | `qa.py`, `render.py` | Handle "auto" QA mode at runtime |
| 2.4 | `ocr.py` | Remove MangaOCR prefix |
| 3.1 | `PageController.java` | File type validation with magic bytes |
| 3.2 | `PageController.java` | Idempotent duplicate handling |
| 3.3 | `SecurityConfig.java` | Remove /file permitAll |
| 4.1 | `health_server.py` | Catch BrokenPipeError |
| 4.2 | `translation.py` | Anti-romanization prompt update |
| 4.3 | `rq_tasks.py`, `InternalJobController.java` | Implement job-level retry with attempt counter |
| 4.4 | `backend/Dockerfile` | Fix Java version: temurin-26 → temurin-21 |
| 4.5 | `qa.py` | QA fallback to default model instead of skipping |
