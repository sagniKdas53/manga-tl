# TODO — Manga Library

> Last reviewed: 2026-07-06 | All completed items archived below.

## 🟡 High Priority Features

### Import and Export

- [ ] Currently we can only import zips, add support for ePub import.
- [ ] Also need to check and fix the issue where imported zips have their pages shuffled, they need to be displayed in the order they appear in the zip
- [ ] **Full ePub export** — Extend `ChapterExportService.java` (which currently does ZIP only) to support ePub packaging.

---

## 🟡 Medium Priority Improvements

### Cloud Optimization

- [ ] **Parallelize cloud processing** — Currently sequential because OCR is done locally sequentially, this is a massive bottleneck.
  - [ ] When using cloud OCR (VLM) we can parallelize the tasks as TL and QA are already done using cloud providers
  - [ ] Add an environment variable which controls the degree of parallelism, default to 1 (i.e. No parallelism) but can be configured to support it
  - [ ] This should still respect the rate-limits of the API
- [ ] **Build slim worker Docker image** — Create a `Dockerfile.slim` without PaddleOCR and local model dependencies for cloud-only deployments. Significantly reduces image size and build time. Only problem that I can think of is even if we pass on the OCR to cloud we will still need a way to actually detect the text regions, bubbles and stuff. Like the YOLO11 and PP-OCR-v6 detection may still be required unless we can find a way to delegate that to the cloud as well
  - [ ] **Cloud-based Text Detection** — Research/integrate Cloud-based Text Detection (e.g., Google Cloud Vision API `DOCUMENT_TEXT_DETECTION` or VLM spatial coordinates) to allow completely cloud-only OCR without local dependencies.
- [ ] **Support remote workers for local OCR** — Allow spinning up dedicated workers on LAN devices for heavy local OCR (PP-OCRv6). Requires worker registration, task routing by capability, and health checking.

### Reliability & Crash Recovery

- [ ] **Persist job queue across restarts** — Currently Redis-only (`RedisPriorityQueue`). If Redis or the host crashes/restarts, queued jobs are lost. Save queue state so the worker can resume from where it crashed. Keep Redis for fast dequeuing, Postgres as the source of truth.
- [ ] **Docker secrets file support** — Add `_FILE` suffix convention support in backend and worker config loaders (e.g., `DB_PASSWORD_FILE=/run/secrets/db_password`). Read secrets from files mounted by Docker Swarm/Compose.

---

## 🔵 Low Priority / Nice-to-Have

- [ ] **Progress Gallery** — Create a visual showcase using `Sample1` showing output quality progression from v1 → v10+.
- [ ] **Chapter & Series Summarization** — Background worker aggregates translated dialogue and generates chapter/series summaries via AI.
- [ ] **Cross-Page Character Memory** — Feed speaker profiles to translation prompts to prevent name/gender drift across pages.
- [ ] **Add draw-to-OCR / draw-to-translate workflow** — Let users draw a rectangle on the image canvas, then trigger OCR or translation for just that region. Requires:
  - Frontend: new tool mode in canvas (similar to free resize but for region capture)
  - Backend: new endpoint accepting image ID + bounding box coordinates
  - Worker: crop-and-process pipeline for the selected region

---

## 🧪 Testing & QA

- [ ] Test intentional bad translations with a weak model to verify QA detection capabilities.
- [ ] Test with very low quality images to observe OCR failure handling and error reporting.
- [ ] Test uploading a KR (Korean) image to a JP (Japanese) series to observe language mismatch behavior.

---

## ✅ Completed (Archive)

<details>
<summary>Click to expand completed items</summary>

### Bugs (Fixed)

- [x] **Hybrid cloud OCR coordinate space mismatch** — In the PP-OCRv6 det + VLM batching path (`DISABLE_LOCAL_OCR=true`), `img_original` was never set in the detector branch, causing YOLO bubble detection and VLM crop extraction to run on the downscaled image while PaddleOCR fragment coordinates were correctly rescaled to original dimensions. Fixed: decode into `img_original` before downscaling so line 434's `img = img_original if img_original is not None else img_decoded` correctly picks the full-resolution image for YOLO and VLM cropping.
- [x] Opening the settings on front-end causes the user to get logged out (most probably due to the context path. Need to check if the context path is changed does this break?).
- [x] Make the model picker options collapsible in the series and chapter dialog boxes.
- [x] Cloud OCR doesn't recognize free floating text that PP-OCR-v5/6 does, it almost always misses those. The bubbles are fine for the most part, check the latest logs for the breakdown
  - [x] There appears to be a yolo11 error in the logs as well, need to check that.
- [x] Delete Page seems to be broken
  - [x] On that note need to add CRUD tests for all levels like series, chapter, page, layer and element in the layers.
- [x] **Backend-rendered pages don't match frontend** — `RenderingService.py` uses Pillow/PIL, frontend uses HTML5 Canvas with CSS text. The two diverge significantly. Options:
  - Use a headless browser (Playwright) in the worker for pixel-perfect rendering
  - Or accept backend rendering as "draft" and add a frontend "export as seen" button that captures the canvas
- [x] **Verify manual layer edits are included in export** — Export reads from DB, so only *saved* edits are included. Ensure the frontend auto-saves or warns before export.
- [x] **Benchmark alternative cloud OCR models** — `qwen/qwen3-vl-8b-instruct` is fast but misses non-dialog text. Test other models from VLM benchmarks for accuracy vs speed tradeoffs.
- [x] Cost calculation seems wrong — fixed costs.json per million tokens and printing estimated cost
- [x] Bubble polygon detection and masking regressions after v9 — fixed, YOLO bubble masks successfully merged and propagated
- [x] Bubble grouping issues after upgrading OCR — fixed, tuned vertical/horizontal proximity algorithm threshold
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

### Backend & Model Picker Features (Done)

- [x] **Backend: `/api/settings` endpoint** — Expose and update model configuration at runtime.
  - [x] Refactor env vars into three groups:
    - `OCR_MODEL_PROVIDER` + `OCR_VLM_MODEL` / `OCR_VLM_MODEL_LIST`
    - `TL_MODEL_PROVIDER` + `PREFERRED_LLM_MODEL` / `PREFERRED_LLM_MODEL_LIST`
    - `QA_MODEL_PROVIDER` + `QA_LLM_MODEL` / `QA_VLM_MODEL` (+ list variants)
  - [x] Load defaults from env vars, allow runtime override via API
  - [x] Support `OCR_PROVIDER: local | cloud` (gray out local if image lacks OCR deps)
  - [x] **Model list / model picker** — `OCR_VLM_MODEL_LIST`, `TL_LLM_MODEL_LIST`, `QA_LLM_MODEL_LIST`, `QA_VLM_MODEL_LIST` are already declared as env var stubs. When the model picker UI is built, populate these lists from the API and treat position 0 as the current default. At that point, the single-model vars (`TL_LLM_MODEL`, `OCR_VLM_MODEL`, etc.) can be deprecated in favour of the list.
- [x] **Backend: Per-chapter/series model selection** — Add model config fields to `Chapter` and `Series` entities. Update APIs so a rough draft chapter can use cheap models and a final chapter uses premium models.
- [x] **Worker: Accept model config per-job** — Infrastructure exists (`ocrProvider`, `preferredModel` in job payload) but values come from global env vars only. Wire up per-chapter settings. Use defaults as safety fallback for invalid/unavailable models.
- [x] **Frontend: Settings panel** — Gear icon in navbar showing active providers + model dropdowns. Initialize from backend defaults, POST user preferences to persist.
  - [x] Add model selection fields to Add/Edit Series and Chapter dialogs
  - [x] Show configured OCR type, models, and providers on Series/Chapter cards
- [x] **Frontend: Red-outline bubbles that failed QA** — `QaResult` data exists in the DB (`qa_results` table with `region_index`, `issue_type`, `severity`). Surface this in the reader canvas by outlining failed OCR/TL regions with red margins.
- [x] **Backend: Embed QA summary in layer metadata** — Currently QA results are in a separate table. Consider denormalizing a summary (pass/fail count, critical issues) into the layer metadata JSON for faster frontend access.
- [x] **Move export button to Chapter view** — Currently only accessible inside the Reader (`ReaderToolbar.jsx`). Add export controls to `ChapterPage.jsx` so users can export without opening the reader.
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
- [x] Fix worker tests failing due to missing Redis — either mock Redis or add a `docker-compose.test.yml` that spins one up.

### Cost Tracking (Done)

- [x] **Cost tracking** - Even when using paid models most jobs still print `$0.00000`
- [x] The costs.json is indeed populated but not useful at all
- [x] **Track actual API costs per layer** — Once cost estimation is fixed, log real costs (tokens × price) at the layer level for both OCR and TL and QA
- [x] **Add the costs per layer to `project.json` of each page**
  - [x] Also need to add QA feedback received for layers to the layers it was generated for
  - [x] Add to each layer its estimated cost; during export we can expect project json to include `totalCost` and per-layer cost breakdown
  - [x] **Update the `meta-data.json` in chapter export ZIP** — Now includes full `project.json` with correct cost, visibility, and the `chapterTotalCost` summary

</details>
