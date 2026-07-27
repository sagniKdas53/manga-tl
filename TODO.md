# TODO — Manga Library (Master Checklist)

> **Last updated**: 2026-07-26  
> Audited via Git history & GitNexus analysis  
> Status legend: `[ ]` = not started, `[/]` = in progress, `[x]` = done, `[P]` = planned (in a plan doc), `[D]` = deferred

---

## 🟢 Current Goals

### Java 25 Upgrade

- [x] Follow [Java upgrade plan](docs/archive/java-upgrade-plan.md) — compile Java 25 locally via SDKMAN, run Java 26 in Docker (we are sticking to 25 for now, will go to 27 when it comes out)
  - Update `pom.xml`: `java.version=25`, `release=25`
  - Update Dockerfile: `maven:3-eclipse-temurin-25` + `eclipse-temurin:25-jre-alpine`

### Output & Rendering Quality

- [ ] Rendered output quality gap vs mangatranslator.ai
  - See Example 1:
    - Original: <br/><img src="examples/sample2/original.jpg" alt="original" width="600"/>
    - mangatranslator.ai: <br/><img src="examples/sample2/en-mangatranslator.ai.jpg" alt="mangatranslator.ai" width="600"/>
    - Ours: <br/><img src="examples/sample2/en-local.png" alt="ours" width="600"/>
- [ ] **Multimodal VLM Quality Benchmarks & Render Tuning** — use VLMs (e.g. Kimi K2.7/K3, Qwen-VL) to analyze translation and typesetting output against competitor benchmarks and refine `render.py` text fitting and inpainting algorithms.

---

## 🟡 Medium Priority — Not Yet in Plans

### ML Models & Providers

- [D] **F.1 YOLO model upgrade** (Failed & Reverted) — current `juithealien/manga109-segmentation-bubble` (yolo11n) appears abandoned, only detects text bubbles. Upgrade to multi-class model (e.g. `ShadowB/Manga109-panel-balloon-text-yolov26-segmentation`) with size filtering fix.

---

## 🔵 Low Priority / Stretch Goals

- [ ] ePub / CBZ import and export support (currently ZIP only)
- [ ] Draw-to-OCR / draw-to-translate — user draws rectangle, triggers OCR/TL for that region
- [ ] **Rich Translation Context & Character Memory** — maintain series/chapter descriptions (booru-style metadata) and a cross-page character/name/place registry, injecting them alongside previous page text into LLM translation context.
- [ ] **AI-Generated Chapter & Series Summarization** — auto-generate summaries from translated dialogue.
- [ ] **Pagination & Infinite Scroll** — two-phase approach for series, chapters, and pages:
  - **Phase 1**: Add backend & frontend pagination support (e.g. paged navigation).
  - **Phase 2**: Implement lazy loading / infinite scroll on top of paginated API endpoints to load more items as user scrolls.
- [ ] **Standalone NGINX & Decoupled Topology** — package frontend into standalone NGINX Alpine container and extract git submodules for remote GPU worker deployments.

---

## 🧪 Testing & QA

- [ ] Test at higher concurrency
- [ ] Make OCR lock dynamic — test if 2 parallel OCR detection runs are feasible
  - Split local OCR: one slot for detection, one for recognition
  - Add worker backpressure — let worker signal it can't accept more jobs (OOM/CPU exhaustion)
- [ ] Reserve CPU/memory for ML container (like Immich does for its ML container)
- [ ] Larger upload optimization (100+ images) — noticeable lag, need to optimize
- [ ] **Playwright End-to-End Pipeline Integration Test Suite** — create end-to-end Playwright test suite that uploads test manga images, triggers full OCR/TL/Render pipeline, and asserts layer correctness.

---

## ✅ Completed (Archive)

<details>
<summary>Click to expand completed items</summary>

### Audited & Verified Completed Items (Git History & Code Base Audit)

- [x] **Cloudflare Workers AI Integration** — added Cloudflare Workers AI provider to worker (`providers.json` & `llm_client.py`) with schema validation and session affinity support (commits `14532cf`, `f90902f`).
- [x] **RFC 7807 Problem Details Error Formatting** — implemented in `GlobalExceptionHandler.java` using Spring 6 `ProblemDetail` for all 4xx/5xx exceptions (commit `9a8a14b`).
- [x] **Spring Boot OpenAPI Annotations & DTO Refactoring** — annotated controllers with `@Tag` and `@Operation`, migrated DTOs to Java Records (`f07f49a`), and auto-generated TypeScript schema definitions (`schema.d.ts`) via `springdoc-openapi` (commits `ae6b69e`, `4077116`, `87fe269`).
- [x] **Null Type Safety Warnings Audit** — resolved via Java Records migration (`f07f49a`) and SpotBugs exclusion filtering (`c8bfc07`).
- [x] **Layer Update Failure Audit ([run-8.log])** — obsolete/resolved; transactional layer saving and history tracking verified, stale log removed (`b928608`).
- [x] **Presigned S3 Asset URLs & Worker Bearer Auth** — worker downloads input images and uploads outputs via presigned S3 URLs; authenticated via `WORKER_API_SECRET` Bearer token (`8be6f09`).

### Critical Bugs (plan-critical-bugfixes.md)

#### Phase 1 — Data Integrity

- [x] **1.1** Shared image cascade delete — deleting a page from one chapter destroys the image in all chapters
- [x] **1.2** Per-chapter model override uses wrong chapter — `findFirst()` picks arbitrary chapter for config resolution
- [x] **1.3** Re-upload after cross-chapter delete fails with `pages_chapter_id_page_number_key` duplicate key constraint
- [x] **1.4** Allow duplicate images in same chapter (doujin cover page use case)
- [x] **1.5** Image hash reuse causing unintended layer sharing across chapters, leading to incorrect processing.
- [x] **1.6** `project.json` `metadataJson` showing single model (e.g. PaddleOCR) instead of list of models (e.g. PaddleOCR + Gemini), and Gemini costs not captured.

#### Phase 2 — Backend API & Export

- [x] **2.1** Chapter export returns 500 — `LazyInitializationException` after OSIV disabled
- [x] **2.2** Clear queue API returns `{status: 999}` — missing `@Transactional`, incomplete Redis queue list, deletes PROCESSING jobs
- [x] **2.3** QA_MODE `auto` not recognized by worker — falls back to auto-pass instead of resolving to vlm/llm/hybrid
- [x] **2.4** OCR model identifier string has dead `MangaOCR/` prefix
- [x] **2.5** Exported ZIP should include rendered translations, not just original images
- [x] **2.6** Aggregated `modelsUsed` from cost breakdowns across QA and Translation in ChapterExportService.
- [x] **2.7** Added `needsReRender` flag based on lastEditedAt vs lastRenderedAt in ChapterExportService.
- [x] **2.8** Added padding to `LayerElement` bounds during OCR to Layout generation to improve `render.py` text fitting.
- [x] **2.9** Checked for manual edits before enqueueing QA on Render callback, avoiding costly QA on manual re-renders.
- [x] **2.10** Removed Image hash deduplication on Project Import to prevent layers stacking on existing pages.
- [x] **2.11** Separated QA models from Translation models in export metadata `modelsUsed` payload and guaranteed base keys.

#### Phase 3 — Upload Validation & Security

- [x] **3.1** Non-image files accepted on upload (`.md`, `.txt` etc.) — no file type validation
- [x] **3.2** Duplicate image idempotency guard for same chapter/same slot
- [x] **3.3** Image file endpoint (`/api/images/{id}/file`) works without auth

#### Phase 4 — Worker & Pipeline Robustness

- [x] **4.1** Worker health server `BrokenPipeError` clutters logs
- [x] **4.2** Translation romanization in outputs from cheap models
- [x] **4.3** Job retry counter never increments — frontend always shows `Attempt: 1/3`
- [x] **4.4** Dockerfile uses non-existent `maven:3-eclipse-temurin-26` tag (Skipped)
- [x] **4.5** QA `auto` mode falls back to `none` (skip) instead of trying default models (Skipped)
- [x] **4.8** Linting and parallel test execution issues across components

### Improvements (plan-improvements.md)

#### Phase 0 — CI Foundation

- [x] **0.1** Add static analysis to Python CI (ruff check, pyright)

#### Phase A — SSE Job System Migration

- [x] **A.1** Replace polling with SSE for job state updates (Queue/Per-job events)
- [x] **A.2** Frontend SSE-driven Queue Manager
- [x] **A.3** Queue Manager UI redesign

#### Phase B — Reader Auto-Refresh

- [x] **B.1** SSE-driven layer auto-refresh in Reader

#### Phase C — Thumbnail & Image Optimization

- [x] **C.1** WebP thumbnails with bicubic interpolation
- [x] **C.2** Frontend: use `/thumbnail` URLs everywhere
- [x] **C.3** Async thumbnail generation off the upload request path

#### Phase D — Frontend UI Fixes & Redesign

- [x] **D.1** Remove "Cover Image URL" field from create/edit series dialogs
- [x] **D.2** Fix settings modal overflow
- [x] **D.3** Chapter cards redesign
- [x] **D.4** Dashboard sorting
- [x] **D.5** Fix Reader full-reload on page switch (sliding window caching)
- [x] **D.6** Persist upload widget across navigation
- [x] **D.7** User management modal
- [x] **D.8** Theme improvements
- [x] **D.10** Model override display — show resolved model instead of `--Inherit--`
- [x] **D.11** Model override UX redesign
- [x] **D.12** Migrate frontend to Material UI (MUI)

#### Phase E — Backend Resilience

- [x] **E.1** Cross-provider failover
- [x] **E.2** Strict HTTP timeouts
- [x] **E.3** Move cost tracking from `costs.json` filesystem to PostgreSQL
- [x] **E.4** Remove `rendered_cache` QA images
- [x] **E.5** Chapter export cleanup
- [x] **E.6** Cost-Aware Provider Routing (OpenRouter)
- [x] **E.7** Model Routing Strategy Selector (UI + Backend)

#### Phase F — ML Models & Prompts

- [x] **F.2** OCR VLM prompt improvements
- [x] **F.3** Translation prompt improvements
- [x] **F.4** QA prompt improvements

#### Phase G — Concurrency & Slot Allocation

- [x] **G.1** Dual-Slot Dispatcher (Heavy/Light queues)
- [x] **G.2** Configurable Worker Slots (MAX_HEAVY_SLOTS / MAX_LIGHT_SLOTS)
- [x] **G.3** Deployment & Documentation

### More Improvements & Infrastructure (plan-more-improvements.md, decoupled_architecture_plan.md, implementation_plan.md)

- [x] **Details API 500 Root Cause Fix** — resolved `IllegalArgumentException` on `/api/pages/{pageId}/details` by updating Reader.tsx prefetch signature and adding 404 exception handling.
- [x] **Series Overrides Persistence** — preserved 9 override fields during series creation in `SeriesController.java`.
- [x] **`useFallbackModels` Override Toggle** — added boolean flag to disable global/local fallbacks on per-series/chapter basis.
- [x] **OpenRouter Strategy Logging** — added explicit logs for `lowest-cost` and `highest-throughput` provider ordering in worker.
- [x] **Response Format 400 Degradation** — worker gracefully falls back from `json_schema` to `json_object` when budget providers reject schema parameters.
- [x] **Provider-Aware Model Mapping** — added `providerModelsMap` to SystemSettingsDto and dynamically filtered model dropdowns per provider in `SettingsModal.tsx`.
- [x] **API Key Verification per Provider** — backend dynamically inspects environment API keys before populating active provider lists.
- [x] **Worker Model Name Normalization** — worker automatically strips provider prefixes (`google/`) and `:free` tags when dispatching requests to native APIs.
- [x] **Dynamic `providers.json` Config Architecture** — restructured provider configuration for generic OpenAI-compatible APIs (Neurometric, Nvidia, Cloudflare, Google AI Studio).
- [x] **Docker Compose Environment Defaults** — added `${VAR:-default}` bash parameter expansions across `docker-compose.yml` to prevent blank string overrides.
- [x] **Security CORS PATCH Support** — added `PATCH` method to allowed CORS methods in `SecurityConfig.java`.
- [x] **Reader Stale Chapter Clearing** — cleared pages state on `chapterId` change to prevent flash of previous chapter content.
- [x] **Out-of-Bounds Page Number Guard** — added defensive sequence bounds checking in `PageController.java`.
- [x] **S3 Rendered Image Naming Unification** — unified rendered image storage key naming (`imageId`) between worker rendering and QA passes.
- [x] **Individual Region Provider Inheritance** — ensured individual region translation fallback respects chapter/series provider overrides instead of defaulting to global env vars.
- [x] **Heartbeat Endpoint Logging** — added debug logging to `JobController.getJobs()` for heartbeat visibility.
- [x] **Queue Manager & Dark Mode UI Polish** — fixed table column layout jumping and applied MUI elevation paper styling across components.
- [x] **Testcontainers Integration Tests** — added real PostgreSQL integration tests for controllers and repository mapping.
- [x] **OpenAPI Spec Auto-Generation** — integrated springdoc-openapi to expose live OpenAPI JSON spec at `/tlhub/v3/api-docs`.

### Bugs (Fixed)

- [x] Hybrid cloud OCR coordinate space mismatch
- [x] Settings page causes logout
- [x] Model picker options collapsible
- [x] Cloud OCR misses free-floating text
- [x] Delete Page broken
- [x] Backend-rendered pages don't match frontend (Playwright fix)
- [x] Manual layer edits not included in export
- [x] Benchmark alternative cloud OCR models
- [x] Cost calculation wrong
- [x] Bubble polygon detection regressions
- [x] Bubble grouping issues after OCR upgrade
- [x] Redo Page OCR replacing old layer
- [x] OCR layer visible when Clean Scanlation toggled
- [x] Layer stacking and numbering
- [x] Translated text breaking out of bounding box
- [x] Free resize mode not working
- [x] Clone layer at wrong position
- [x] Undo doesn't work for bubble dragging
- [x] Delete confirmation dialogs don't respect light theme
- [x] Toast doesn't respect light theme
- [x] Deleting first image leaves series thumbnailless
- [x] SSE user-image mapping expiry
- [x] Clean up Minio artifacts on page delete
- [x] Increase JWT access token TTL
- [x] Fix `CostEstimationService.java`

### Backend & Features (Done)

- [x] `/api/settings` endpoint with runtime model config
- [x] Per-chapter/series model selection
- [x] Worker accepts model config per-job
- [x] Frontend settings panel
- [x] Red-outline bubbles that failed QA
- [x] QA summary in layer metadata
- [x] Export button in Chapter view
- [x] Async job queue with retry & backoff
- [x] Image dedup via hashing
- [x] Unified LLM provider (LiteLLM)
- [x] Layer metadata tracks model identifiers
- [x] Worker observability & structured logging
- [x] Live updates via SSE
- [x] ZIP/ePub import
- [x] Layer project re-hydration from archives
- [x] Redo-OCR / Redo-Translation fixes
- [x] PP-OCRv5/v6 integration
- [x] OpenRouter cloud OCR
- [x] Nemotron OCR v2 (rejected)
- [x] Notifications with image/chapter/series context
- [x] Chapter-level memory toggle
- [x] Disable OSIV
- [x] Clean up JVM Unsafe warnings
- [x] Persist job queue across restarts
- [x] Queue management (pause/resume/clear UI)
- [x] Docker secrets file support
- [x] Hybrid QA mode (LLM + VLM)
- [x] Model picker improvements (provider filtering, format mapping, fallbacks)
- [x] Worker: model seeding, test fixes, MangaOCR/EasyOCR removal
- [x] Cost tracking per layer in exports
- [x] Parallelized processing with configurable concurrency

</details>
