# TODO — Manga Library

> Last reviewed: 2026-07-04 | All completed items archived below.

## 🔴 Active Bugs

### Cost calculation seems wrong

- [ ] The cost stored in costs.json seems to be wrong, it should be saved as per million tokens and then calculated dynamically based on the job
- [ ] Also we are not printing the estimayed cost after every job that uses a cloud model

### Export Quality Discrepancy (This also affects the VLM QA, I think)

- [x] **Backend-rendered pages don't match frontend** — `RenderingService.py` uses Pillow/PIL, frontend uses HTML5 Canvas with CSS text. The two diverge significantly. Options:
  - Use a headless browser (Playwright) in the worker for pixel-perfect rendering
  - Or accept backend rendering as "draft" and add a frontend "export as seen" button that captures the canvas
- [x] **Verify manual layer edits are included in export** — Export reads from DB, so only *saved* edits are included. Ensure the frontend auto-saves or warns before export.

---

## 🟡 High Priority Features

### Model Picker / Runtime Settings
>
> This is a cross-cutting feature spanning backend, worker, and frontend.

- [ ] **Backend: `/api/settings` endpoint** — Expose and update model configuration at runtime.
  - [ ] Refactor env vars into three groups:
    - `OCR_MODEL_PROVIDER` + `OCR_VLM_MODEL` / `OCR_VLM_MODEL_LIST`
    - `TL_MODEL_PROVIDER` + `PREFERRED_LLM_MODEL` / `PREFERRED_LLM_MODEL_LIST`
    - `QA_MODEL_PROVIDER` + `QA_LLM_MODEL` / `QA_VLM_MODEL` (+ list variants)
  - [ ] Load defaults from env vars, allow runtime override via API
  - [ ] Support `OCR_PROVIDER: local | cloud` (gray out local if image lacks OCR deps)
  - [ ] **Model list / model picker** — `OCR_VLM_MODEL_LIST`, `TL_LLM_MODEL_LIST`, `QA_LLM_MODEL_LIST`, `QA_VLM_MODEL_LIST` are already declared as env var stubs. When the model picker UI is built, populate these lists from the API and treat position 0 as the current default. At that point, the single-model vars (`TL_LLM_MODEL`, `OCR_VLM_MODEL`, etc.) can be deprecated in favour of the list.
- [ ] **Backend: Per-chapter/series model selection** — Add model config fields to `Chapter` and `Series` entities. Update APIs so a rough draft chapter can use cheap models and a final chapter uses premium models.
- [ ] **Worker: Accept model config per-job** — Infrastructure exists (`ocrProvider`, `preferredModel` in job payload) but values come from global env vars only. Wire up per-chapter settings. Use defaults as safety fallback for invalid/unavailable models.
- [ ] **Frontend: Settings panel** — Gear icon in navbar showing active providers + model dropdowns. Initialize from backend defaults, POST user preferences to persist.
  - [ ] Add model selection fields to Add/Edit Series and Chapter dialogs
  - [ ] Show configured OCR type, models, and providers on Series/Chapter cards

### QA Feedback Integration

- [x] **Frontend: Red-outline bubbles that failed QA** — `QaResult` data exists in the DB (`qa_results` table with `region_index`, `issue_type`, `severity`). Surface this in the reader canvas by outlining failed OCR/TL regions with red margins.
- [x] **Backend: Embed QA summary in layer metadata** — Currently QA results are in a separate table. Consider denormalizing a summary (pass/fail count, critical issues) into the layer metadata JSON for faster frontend access.

### Export Improvements

- [ ] **Move export button to Chapter view** — Currently only accessible inside the Reader (`ReaderToolbar.jsx`). Add export controls to `ChapterPage.jsx` so users can export without opening the reader.
- [ ] **Add `meta-data.json` to chapter export ZIP** — Include: page order, layer counts, active layer per page, QA status, manual changes flag, OCR/TL models used, per-page and total cost.
- [ ] **Full ePub export** — Extend `ChapterExportService.java` (which currently does ZIP only) to support ePub packaging.

### Manual Region Selection

- [ ] **Add draw-to-OCR / draw-to-translate workflow** — Let users draw a rectangle on the image canvas, then trigger OCR or translation for just that region. Requires:
  - Frontend: new tool mode in canvas (similar to free resize but for region capture)
  - Backend: new endpoint accepting image ID + bounding box coordinates
  - Worker: crop-and-process pipeline for the selected region

---

## 🟡 Medium Priority Improvements

### Cloud OCR Optimization

- [ ] **Parallelize cloud OCR processing** — Currently sequential. When using cloud OCR (OpenRouter VLM), process multiple pages concurrently with configurable parallelism (e.g., 3-5 concurrent requests).
- [ ] **Benchmark alternative cloud OCR models** — `qwen/qwen3-vl-8b-instruct` is fast but misses non-dialog text. Test other models from VLM benchmarks for accuracy vs speed tradeoffs.
- [ ] **Build slim worker Docker image** — Create a `Dockerfile.slim` without PaddleOCR and local model dependencies for cloud-only deployments. Significantly reduces image size and build time.

### Reliability & Crash Recovery

- [ ] **Persist job queue in Postgres** — Currently Redis-only (`RedisPriorityQueue`). If Redis or the host crashes/ restarts, queued jobs are lost. Save queue state to Postgres so the worker can resume from where it crashed. Keep Redis for fast dequeuing, Postgres as the source of truth.
- [ ] **Docker secrets file support** — Add `_FILE` suffix convention support in backend and worker config loaders (e.g., `DB_PASSWORD_FILE=/run/secrets/db_password`). Read secrets from files mounted by Docker Swarm/Compose.

### Cost Tracking

- [ ] **Track actual API costs per layer** — Once cost estimation is fixed, log real costs (tokens × price) at the layer level for both OCR and TL/QA. Surface per-chapter and per-series totals in the UI.

### Distributed Workers

- [ ] **Support remote workers for local OCR** — Allow spinning up dedicated workers on AWS EC2 or LAN mini-PCs for heavy local OCR (PP-OCRv5/v6). Requires worker registration, task routing by capability, and health checking.

---

## 🔵 Low Priority / Nice-to-Have

- [ ] **Progress Gallery** — Create a visual showcase using `Sample1` showing output quality progression from v1 → v10+.
- [ ] **Chapter & Series Summarization** — Background worker aggregates translated dialogue and generates chapter/series summaries via AI.
- [ ] **Cross-Page Character Memory** — Feed speaker profiles to translation prompts to prevent name/gender drift across pages.

---

## 🧪 Testing & QA

- [ ] Test intentional bad translations with a weak model to verify QA detection capabilities.
- [ ] Test with very low quality images to observe OCR failure handling and error reporting.
- [ ] Test uploading a KR (Korean) image to a JP (Japanese) series to observe language mismatch behavior.
- [ ] Fix worker tests failing due to missing Redis — either mock Redis or add a `docker-compose.test.yml` that spins one up.

---

## ✅ Completed (Archive)

<details>
<summary>Click to expand completed items</summary>

### Bugs (Fixed)

- [x] Bubble polygon detection and masking regressions after v9 — fixed, YOLO bubble masks successfully merged and propagated
- [x] Bubble grouping issues after upgrading OCR — fixed, tunedVertical/horizontal proximity algorithm threshold
- [x] Redo Page OCR was replacing old layer instead of creating new pass — fixed, preserves original
- [x] OCR layer visible when Clean Scanlation toggled — fixed, layer hidden appropriately
- [x] Layer stacking and numbering — fixed, layers numbered in stack order
- [x] Translated text breaking out of bounding box — fixed
- [x] Free resize mode not working — fixed
- [x] Clone layer added at wrong position — fixed, clone inserts above source layer; reorder via ↑↓ buttons and Shift+↑/↓
- [x] Undo doesn't work for bubble dragging — fixed
- [x] Delete confirmation dialogs don't respect light theme — fixed, uses CSS variables
- [x] Toast doesn't respect light theme — fixed, global ToastProvider with theme-aware styling
- [x] Deleting first image leaves series thumbnailless — fixed
- [x] Fix SSE user-image mapping expiry — fallback to DB on Redis miss
- [x] Clean up all Minio artifacts on page delete — added rendered image cleanup
- [x] Increase JWT access token TTL — updated to 24 hours in application.yml
- [x] Fix `CostEstimationService.java` — implemented dynamic cost estimation for OpenRouter API with filesystem and Redis caching, legacy code obsolete

### Backend Features (Done)

- [x] Async job queue with retry & exponential backoff
- [x] Image deduplication via hashing
- [x] Unified LLM provider integration (LiteLLM)
- [x] Layer metadata tracks OCR/TL model identifiers
- [x] Worker observability & structured logging
- [x] Live updates via SSE (implemented, but has the Redis mapping bug above)
- [x] Full ZIP/ePub import for project setup
- [x] Layer project re-hydration from exported archives
- [x] Redo-OCR — fixed duplicate bubbles and ordering
- [x] Redo-Translation — fixed blank layer creation
- [x] PP-OCRv5/v6 server integration
- [x] OpenRouter cloud OCR investigation (works but quality varies by model)
- [x] Nemotron OCR v2 investigated — neither fast nor reliable, rejected
- [x] Notifications/toasts made more informative (include image/chapter/series context)

### Worker Enhancements & Improvements (Done)

- [x] Fail translation job/verify YOLO on start instead of falling back to OpenCV silently when yolo11 model is missing
- [x] Remove MangaOCR and EasyOCR dependencies to optimize worker footprint and memory
- [x] Update default local OCR models to PP-OCRv6 medium
- [x] Document OCR_MERGE_THRESHOLD in README.md for tuning bubble grouping
- [x] Implement proper model seeding on worker startup before accepting jobs

</details>
