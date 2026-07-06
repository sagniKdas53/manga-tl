# TODO — Manga Library

> Last reviewed: 2026-07-04 | All completed items archived below.

## 🔴 Active Bugs

## 🟡 High Priority Features

### Model Picker / Runtime Settings
>
> This is a cross-cutting feature spanning backend, worker, and frontend.

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

### Import and Export issues

- [ ] Currently we can only import zips, add support for ePub import.
- [ ] Also need to check and fix the issue where imported zips have their pages suffled, they need to be displayed in the order they appear in the zip
- [ ] **Full ePub export** — Extend `ChapterExportService.java` (which currently does ZIP only) to support ePub packaging.

---

## 🟡 Medium Priority Improvements

### Cloud Optimization

- [ ] **Parallelize cloud processing** — Currently sequential because OCR is done locally sequentially, this is a massive bottleneck.
  - [ ] When using cloud OCR (VLM) we can parallelize the tasks as TL and QA are already done using cloud providers
  - [ ] Add an environemnt variable which controls the degree of paralleism, default to 1 (i.e. No parallelism) but can be configured to support it
  - [ ] This should still respect the rate-limits of the API
- [ ] **Build slim worker Docker image** — Create a `Dockerfile.slim` without PaddleOCR and local model dependencies for cloud-only deployments. Significantly reduces image size and build time. Only problem that I can think of is even if we pass on the OCR to cloud we will still need a way to actually detect the text regions, bubbles and stuff. Like the YOLO11 and PP-OCR-v6 dtetction may still be required unless we can find a a way to delegate that the the cloud as well
- [ ] **Support remote workers for local OCR** — Allow spinning up dedicated workers on LAN devices for heavy local OCR (PP-OCRv6). Requires worker registration, task routing by capability, and health checking.

### Reliability & Crash Recovery

- [ ] **Persist job queue across restarts** — Currently Redis-only (`RedisPriorityQueue`). If Redis or the host crashes/ restarts, queued jobs are lost. Save queue state so the worker can resume from where it crashed. Keep Redis for fast dequeuing, Postgres as the source of truth.
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

- [x] **Backend-rendered pages don't match frontend** — `RenderingService.py` uses Pillow/PIL, frontend uses HTML5 Canvas with CSS text. The two diverge significantly. Options:
  - Use a headless browser (Playwright) in the worker for pixel-perfect rendering
  - Or accept backend rendering as "draft" and add a frontend "export as seen" button that captures the canvas
- [x] **Verify manual layer edits are included in export** — Export reads from DB, so only *saved* edits are included. Ensure the frontend auto-saves or warns before export.
- [x] **Benchmark alternative cloud OCR models** — `qwen/qwen3-vl-8b-instruct` is fast but misses non-dialog text. Test other models from VLM benchmarks for accuracy vs speed tradeoffs.
- [x] Cost calculation seems wrong — fixed costs.json per million tokens and printing estimated cost
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

- [x] **Cost tracking** - Even when using paid models most job still print `manga-worker     | 2026-07-05 15:45:06,357 [INFO] [QA] VLM QA job estimated cost: $0.00000 (Tokens: in=2268, out=320)`
- [x] The costs.json is indded populated but not useful at all
  - [x] `{"google/gemini-3.1-flash-lite":{"prompt":2.5e-7,"completion":0.0000015,"timestamp":1783171687.58696},"deepseek/deepseek-v4-pro":{"prompt":0.0000013888466666666668,"completion":0.0000027747600000000003,"timestamp":1783171687.58696},"qwen/qwen3-vl-8b-instruct":{"prompt":1.835e-7,"completion":6.025e-7,"timestamp":1783171687.58696},"deepseek/deepseek-v4-flash":{"prompt":1.2800625e-7,"completion":2.572e-7,"timestamp":1783171687.58696}}`
- [x] **Track actual API costs per layer** — Once cost estimation is fixed, log real costs (tokens × price) at the layer level for both OCR and TL and QA
- [x] **Add the costs per layer to `project.json` of each page** —
  - [x] Current layer schema `{"id":"46416817-aefb-40fe-bd7b-22694d977a75","type":"ocr","targetLanguage":null,"visible":true,"metadataJson":{"time":"2026-07-05T15:42:56.831839968Z","model":"MangaOCR/PaddleOCR(PP-OCRv6_medium_rec)","provider":"OCR Worker","confidence":0.9005396515130997,"layer_name":"OCR","layer_order":1,"last_modified":"2026-07-05T15:42:56.833707446Z"},"elements":[{"id":"3fdce379-4c9a-4c4d-865e-a3772a7a83bc","text":"ほら止まポチ!！","font":"Comic Neue","size":null,"autoSize":true,"x":992,"y":20,"maxWidth":124,"maxHeight":234,"rotation":0,"visible":true,"wordWrap":true,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","boxShape":"rectangular","maskPolygon":null,"regionId":"b85eeb0b-a277-4ccf-a237-16ae22b10ffc"},{"id":"b91885bc-871b-49d4-91b2-d7b1267291a6","text":"一月後","font":"Comic Neue","size":null,"autoSize":true,"x":321,"y":0,"maxWidth":183,"maxHeight":68,"rotation":0,"visible":true,"wordWrap":true,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","boxShape":"rectangular","maskPolygon":null,"regionId":"6ccde764-b91e-40e3-ab44-f5660b036901"},{"id":"430c6652-2a8b-4610-8cf5-fe9e31d4d9c4","text":"7","font":"Comic Neue","size":null,"autoSize":true,"x":1072,"y":353,"maxWidth":88,"maxHeight":86,"rotation":0,"visible":true,"wordWrap":true,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","boxShape":"rectangular","maskPolygon":null,"regionId":"b76c04d1-9da0-44fc-bed8-eb8dc4345e6f"},{"id":"60e00cc7-9578-4d24-b11c-c6fee5c0feaf","text":"どうしょう…アタシ本当に…一生このチビのパッド！？","font":"Comic Neue","size":null,"autoSize":true,"x":40,"y":649,"maxWidth":156,"maxHeight":296,"rotation":0,"visible":true,"wordWrap":true,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","boxShape":"rectangular","maskPolygon":null,"regionId":"963c2851-a3c4-421e-abdf-89c4fdd030fd"}]}`
  - [x] Also need to add QA feedback recieved for layers to the layers it was generated for
  - [x] Add to each each layer it's estimated cost, during export we can expect project json to be something like this
  - [x] `{"pageNumber":1,"imageId":"106e431e-b4fe-4874-8b47-c43bbda47dd8","dimensions":{"width":1190,"height":983},"totalCost":"sum-of-cost-of-all-layers","exportedAt":"2026-07-05T16:05:19.307Z","layers":["layers","here"]}`
  - [x] **Update the `meta-data.json` in chapter export ZIP**
    - [x] Current page schema `{"pageNumber":1,"imageId":"106e431e-b4fe-4874-8b47-c43bbda47dd8","modelsUsed":{"translation":"openrouter/deepseek/deepseek-v4-pro","ocr":"MangaOCR/PaddleOCR(PP-OCRv6_medium_rec)"},"cost":{"estimated_cost":7.3102666400000006e-9,"currency":"USD"},"layerCount":2,"hasRendered":true,"activeLayer":{"language":"en","id":"29c72545-b2c2-47b6-8f57-fbdd0242dac9","type":"translation"},"manualChangesDone":false,"manualQaNeeded":false,"originalFilename":"bd1bae9ef130939f1a5cc4263797fe0b.jpg"}`
    - [x] Should include the ideally the entire `project.json` with the correct cost, visibility.
    - [x] The `meta-data.json` has current structure as `{"pages":["pages","json","here"],"chapterTotalCost":{"estimated_cost":1.5578991566666667e-8,"currency":"USD"},"totalPages":3,"exportTimestamp":"2026-07-05T16:12:46.895557125Z","chapterNumber":2,"chapterTitle":"Chapter2","seriesTitle":"Test"}`
    - [x] Once everything is wired in correctly, I believe it should be more more useful and eventually be used to display cost on the frone-end (Long term goal, not right now)

</details>
