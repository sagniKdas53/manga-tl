# Archive

> Status legend: `[ ]` = not started, `[/]` = in progress, `[x]` = done, `[P]` = planned (in a plan doc), `[D]` = deferred

## Failed (Failed & Reverted)

### ML Models & Providers

- [D] **F.1 YOLO model upgrade** (Failed & Reverted) — current `juithealien/manga109-segmentation-bubble` (yolo11n) appears abandoned, only detects text bubbles. Upgrade to multi-class model (e.g. `ShadowB/Manga109-panel-balloon-text-yolov26-segmentation`) with size filtering fix.
  - **Re-evaluated 2026-08-03; do not retry as specified.** The exported artifact
    (`yolo26s_manga109.onnx`) is still in the worker model cache and was measured directly against
    yolo11n on 180 speech regions yolo11n missed. It recovers **4/180 (2.2%) at conf 0.25** vs
    yolo11n's 1/180, and **every region it recovered the contour search already recovered** — no
    additive value. It is not a size-filtering problem: yolo26s classes the irregular thought clouds
    as `text` (class 1), not `balloon` (class 2), so both models simply have not been trained on
    this shape. A future attempt needs a differently-*trained* detector, not a bigger one.
  - Integration note for whoever tries next: the two models have incompatible output layouts.
    yolo11n is `[1, 37, 33600]` (anchors last, single class, needs NMS); yolo26s is
    `[1, 300, 38]` end-to-end — `xyxy, score, class_id, 32 mask coeffs`, already NMS'd. The current
    `detect_bubbles_yolo` postprocess only understands the former, which is the likely reason the
    original attempt read as "failed".

## ✅ Completed (Archive)

### Issues Board Audit (`issues.md` → archived 2026-08-01)

Each item below was re-verified against current code/docs (not just taken on the word of the original "(done)" tag) before being moved out of `issues.md`.

- [x] **CI failing** — both failures fixed. Backend: `backend/pom.xml` pins `java.version=25` and `.github/workflows/ci-maven.yml` matches (`java-version: "25"`, `distribution: temurin`), resolving the "release version 25 not supported" error. Frontend: the flaky `AssertionError: expected false to be true` test was scoped inside `waitFor` in the Reader component test (commit `0a5296a`). **Correction 2026-08-03:** that did not fix it — the test flaked again in CI, and the cause was a product bug in `Reader.tsx`, not test timing. See "Reader lost-invalidation race" below.
- [x] **Same-image handling had not worked for a long time** — the full intelligent-cloning architecture is implemented and documented end-to-end in [duplicate_handling.md](./duplicate_handling.md): source-page scoring for cloning candidates, OCR/translation config-matched layer cloning, image-scoped panels vs. page-scoped everything-else, and page-scoped job routing so a shared image backing pages in different chapters no longer resolves the wrong chapter's model config (commits `7f080ea`, `5e2d5ce`, `72d8a4f`).
- [x] **`index.js` is still too big** — `frontend/vite.config.ts` now splits the bundle via `manualChunks` (`vendor-react`, `vendor-mui`, `vendor-router`, `lib-jszip`, `lib-zod`); the before/after build logs pasted into the original issue show the single ~375 KB `index-*.js` dropping to a ~23 KB main chunk with the rest cached in stable vendor chunks (commit `849cb81`).
- [x] **UI fixes needed**:
  - Lazy-loading thumbnails across series/chapter/page surfaces, fixing the earlier bug where the "lazy" loader still fetched full images (commit `6a94e97`).
  - Reader bi-directional cache with a soft cap — verified in `frontend/src/components/Reader.tsx` (~L668-719): a `[-2, +3]` sliding window prefetches both page details and images in *both* directions and evicts on window slide, with no hand-rolled memory-size cap (the earlier hard-cap calculation was removed; eviction is now purely window-based and lets the browser manage image memory).
  - Every-chapter-shows-spinner (component remount on cached data) fixed.
  - The Firefox-crashing regression was reverted (`5511ce8`) and the same features (lazy loading, bi-directional cache) were redone incrementally and safely (`e9567e7` → `6a94e97` → `48ba3a5` → `8f66c1f`).
- [x] **Add an export rendered PNG button** — `handleExportRenderedPng` implemented in `Reader.tsx` (~L2233) and wired into `ReaderRightSidebar` (commit `8f00564`). (The screenshot originally linked from this entry was removed from `docs/` in an unrelated cleanup; this entry is kept text-only.)

### Reader lost-invalidation race (2026-08-03)

- [x] **A `job_update` that arrived while page details were still loading was silently swallowed.**
  Diagnosed from a CI failure of `"reloads layers and shows toast on job_update SSE event"` — the
  same test `0a5296a` had already tried to de-flake by widening the assertion into `waitFor`. It was
  never a timing problem: in the losing interleaving the refetch is *never* issued, so `waitFor` can
  only time out.

  The SSE handler busts `pageDetailsCache` and nulls `loadedImageId` to force a refetch. If the
  initial `/api/pages/{id}` request was still in flight, its `.then` landed afterwards, rewrote the
  cache entry that had just been cleared and set `loadedImageId` back to the page id — so the effect
  saw nothing to do. The guard that should have caught this, `if (selectedPage.id === currentPageId)`,
  compared two values from the same closure and was always true, so every late response applied
  unconditionally.

  User-visible symptom: the "New layers available — refreshed" toast appears, and the reader keeps
  showing stale layers until you navigate away and back.

  Fixed with a cache-invalidation epoch (`cacheEpochRef` + a `cacheEpoch` state entry in the effect's
  dependencies): the SSE handler bumps it, `fetchPageDetails` refuses to write a response whose epoch
  is stale, and the tautological guard is replaced by `isCurrentRequest()`, which checks both the
  epoch and the most recently requested page id — so a late response for a page you navigated away
  from is dropped too. Reproduced deterministically with a 30 ms mocked response before the fix, and
  that case is now a regression test. The test file's `useParams` mock is also reset per-test; it was
  being set with `mockReturnValue` inside individual tests, which persists file-wide and made the
  suite order-dependent.

### Reader page images broke on the AUDIT-S4 deploy (2026-08-03)

- [x] **Every full-size reader image returned 403 after `?token=` was removed.** S4 correctly took
  the query-string credential path out of `JwtAuthFilter` (it is header-only now,
  `JwtAuthFilter.java:75-81`), but `Reader.tsx` still built image URLs as
  `` `${page.url}?token=${jwt}` `` in two places — the displayed `<img>` and the prefetch warm-up.
  An `<img>` cannot set an `Authorization` header, so the credential was simply ignored.

  Confirmed against the running backend rather than inferred: `/api/images/{id}/file?token=…` and
  the same URL with no credential at all both return **403**, while `/api/images/{id}/thumbnail`
  returns **200** because it is the one image route left `permitAll` in `SecurityConfig.java:48`.
  That asymmetry is exactly what the bug looked like — galleries kept working, the reader did not.

  Fixed in `frontend/src/utils/authImage.ts`: the bytes are fetched with the header and handed to
  `<img>` as a blob URL, so no credential reaches the URL, the access log or the referrer — the
  property S4 was protecting. The cache pins the image currently on screen so a neighbouring
  prefetch cannot evict it, dedupes in-flight loads, and revokes on eviction and on logout.
  `prefetchAuthImage` replaces the `new Image()` warm-up, which had depended on an unauthenticated
  `<img>` reaching the browser HTTP cache.

  **The Reader tests could not have caught this**: they mocked `safeFetch` without a `blob()`, so
  the component silently rendered its error state and no assertion touched the image. They now
  return blobs, and a regression test asserts the image loads via header with no `token=` in any
  request URL (commit `02d9185`).

### The QA silent-pass chain (2026-08-03)

Found while investigating a `NullPointerException` in run `20260803-084755`. One truncated model
response produced four independent silent failures, each of which on its own turned a broken QA pass
into a clean one.

- [x] **A QA result with no `regionId` NPE'd, and the swallowed exception scored as a pass.**
  `UUID.fromString(null)` at `JobCoordinatorService.handleQaCallback` threw inside the per-result
  `catch`, which logged and continued — leaving every counter at zero. Zero counters then computed
  `status = "passed"`, so the backend logged *"QA passed for image e3e52903. Pipeline complete!"*
  off a single unusable result and completed the pipeline with QA never applied.

  Results without a `regionId` are now discarded explicitly and counted. A callback that scores
  nothing reports `status: "error"` with `discarded_results`, returns `COMPLETED_NO_QA`, and raises
  a **WARNING** notification instead of a success one (commit `14bed1e`).

- [x] **QA metadata was written to every translation layer on the page.** With a QA retry cycle
  leaving several translation layers behind, the final callback stamped its verdict over the results
  already recorded for the earlier cycles. Verified on an image whose QA *did* parse: all three of
  `1f546be9`'s layers carry the same `last_qa_at` to the microsecond. On `e3e52903` the last, broken
  callback left all three layers reading `passed / total_regions: 0`. It now writes only to the
  newest translation layer.

- [x] **The truncation was invisible to the worker.** The model hit its output cap mid-word
  (`out=3408`); OpenRouter's `response-healing` plugin (`llm_client.py`) closed the JSON, so
  `json.loads` succeeded and returned `[{"qaFeedback": "…"}]`. `LLMResponse` did not carry
  `finish_reason`, so nothing downstream could tell a complete answer from a guillotined one. It is
  captured now, with a `truncated` helper and a warning log. Separately, `max_tokens` was only ever
  sent for Anthropic — every other provider inherited whatever the routed model defaulted to; all
  providers now get an explicit `DEFAULT_MAX_OUTPUT_TOKENS = 8192`.

- [x] **The worker auto-passed every region when QA produced nothing.** Three identical
  `"[QA] Falling back to default PASS for all regions."` blocks in `handlers/qa.py` fabricated a
  `passed` verdict for each region whenever parsing failed or the provider was dead — making a
  broken QA provider indistinguishable from a clean page. Replaced by `_sanitize_qa_results`, which
  drops entries that are malformed, unidentified or reference an unknown region, and reports an
  empty verdict instead of a fabricated one. This composes with the backend change above: empty now
  means "QA did not run" and is recorded as such. One existing test
  (`test_process_qa_vlm_local_fallback`) was asserting the old fabricated pass and was updated.

- [x] **`directFix` and `escalation` were optional and the model never emitted them.** The run
  produced `qaStatus: "direct_fix"` **10 times with zero `directFix` payloads** and
  `qaStatus: "failed"` **10 times with zero `escalation` blocks**. Both consuming branches in
  `JobCoordinatorService` are keyed on the object being present, so direct fixes were never applied
  and `needsReOcr` never routed — which is why every failure fell through to a blind re-translation
  of the same bad OCR. QA's own prose said *"Please re-OCR and then re-translate"*; with no flag set,
  the pipeline re-translated. Both objects are now `required` at the item level with fully-specified
  inner fields (also what OpenAI-style `strict` structured output demands), and all four QA prompts
  state explicitly that the objects are always present and that prose has no routing effect. If a
  provider rejects the schema, `LLMClient` already degrades to `json_object` and retries.
  **Emission is not yet confirmed against a live provider** — see the open item in `issues.md`.

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

### Java 25 Upgrade

- [x] Follow Java upgrade plan — compile Java 25 locally via SDKMAN, run Java 26 in Docker (we are sticking to 25 for now, will go to 27 when it comes out)
  - Update `pom.xml`: `java.version=25`, `release=25`
  - Update Dockerfile: `maven:3-eclipse-temurin-25` + `eclipse-temurin:25-jre-alpine`

---

## 📁 Archived Plans & Research Documentation Summaries

Summary of historical plans, architecture designs, and Root Cause Analyses (RCAs) previously stored in `docs/archive/`:

### Architecture & Infrastructure Plans

#### 1. Decoupled Architecture Plan (`decoupled_architecture_plan.md`)

Strategic blueprint for decoupling the monolithic setup into independent microservices:

- **Frontend Service:** Extracted Vite/React SPA served via a lightweight NGINX Alpine container, proxying REST (`/tlhub/api`) and WebSocket/SSE requests.
- **Backend Service:** Pure Spring Boot REST API without embedded static web assets, generating presigned S3 URLs for asset storage.
- **Worker Pool:** Support for local and remote cloud GPU nodes (RunPod, Vast.ai, AWS) accessing input/output assets via presigned S3 GET/PUT URLs and communicating status back via secure HTTPS callbacks with Bearer token authentication.

#### 2. Java Upgrade Plan (`java-upgrade-plan.md`)

Guide for host machine and container environment Java version alignment:

- Upgraded host development environment via SDKMAN (Java 26 SDK, Maven 3.9+).
- Updated `pom.xml` (`spring-boot-starter-parent` 3.4.0, `java.version` 25, `release` 25, JaCoCo 0.8.16).
- Updated backend runtime Dockerfile to `eclipse-temurin:25-jre-alpine` / `eclipse-temurin:26-jre-alpine`.

#### 3. Model Upgrade Plan (`model_upgrade_plan.md`)

Evaluation and replacement strategy for YOLO segmentation models:

- Diagnosed limitation of single-class model `juithealien/manga109-segmentation-bubble` (text bubbles only).
- Evaluated and recommended 3-class Ultralytics YOLO26s-seg model `ShadowB/Manga109-panel-balloon-text-yolov26-segmentation` (`frame`, `text`, `balloon`).
- Enabled downstream pipeline branching: typesetting inside dialogue balloons, position-anchored overlays for free-standing SFX text, and panel boundary detection for right-to-left reading order reconstruction.

---

### Feature Implementation & System Plans

#### 4. Provider-Aware Model Mapping & Key Verification (`implementation_plan_better_providers.md`)

Robust mapping and normalization architecture across AI providers:

- **Backend:** Dynamic API key inspection (`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY`, etc.) in `SystemSettingsService` to filter active providers and populate `providerModelsMap`.
- **Frontend:** Dynamic filtering in `SettingsModal` to match model choices strictly with selected providers while removing redundant `-- Default / Inherit Env --` entries.
- **Worker:** Model name normalization in `llm_client.py` to strip provider prefixes (`google/`, `neurometric/`) and `:free` suffixes before making native provider API calls.

#### 5. Master Improvements & UI Redesign Plan (`plan-improvements.md`)

Multi-phase blueprint covering performance, system architecture, and UI overhauls:

- **Phase 0 (CI Foundation):** Integrated static analysis for Python workers using Ruff (linting/formatting) and Pyright (type checking).
- **Phase A (SSE Job System):** Migrated from high-frequency REST polling to real-time SSE `job_update` events with interactive Queue Manager controls (pause, resume, retry, clear).
- **Phase B (Reader Auto-Refresh):** Implemented real-time layer auto-refresh in the reader upon SSE job completion.
- **Phase C (Thumbnail & Image Optimization):** Added non-blocking `@Async` WebP thumbnail generation using `ImageReader` subsampling and bicubic downscaling.
- **Phase D (MUI v9 Migration & Render Hygiene):** Full migration to Material UI v9, render hygiene optimizations (context memoization, prop stabilization, `React.memo` exports), user management modal, and stacked MUI Snackbars.

#### 6. Extended Improvements Plan (`plan-more-improvements.md`)

System reliability, performance, and contract verification checklist:

- **Testing:** Integration testing with Testcontainers and real PostgreSQL instances to catch schema, proxy serialization, and DDL issues.
- **Render Loop Protection:** Failure tracking on entities in `DebouncedRenderService` to prevent infinite render retry loops when manual edits fail.
- **Latency & Caching:** N+1 query elimination via `findByConversationIdIn` batching, sliding window page caching (`[N-1, N, N+1, N+2]`) in `Reader.tsx`, JWT session auto-refresh (`/api/auth/refresh`), and pipeline quality gates.

#### 7. Material UI Migration Detailed Strategy (`plan-mui-migration.md`)

Incremental 9-phase migration from glassmorphism CSS to Material UI (MUI v9):

- Dual theme palette definitions: nHentai-inspired dark mode (`#1f1f1f` / `#ee2553`) and Pixiv-inspired light mode (`#f5f5f5` / `#0197fc`).
- Component conversions for AppBar navigation, MUI Dialog modals, MUI Drawer/Table Queue Manager, MUI Cards for Dashboard/Series, MUI TextField form inputs, and stacked Snackbar toasts.
- Targeted Reader fixes: splitting shared redo loading states (7.4.1) and disabling Redo-OCR on translation layers (7.4.2).

---

### Bug Fix Plans & Root Cause Analyses (RCAs)

#### 8. Phased Implementation Plan for All Issues (`implementation_plan.md`)

Action plan to resolve issues documented in `issues-found.md`:

- **Phase 1:** Preserved all 9 override fields during series creation in `SeriesController.java`.
- **Phase 2:** Added `useFallbackModels` toggle per series/chapter (preventing fallback cascade when set to `false`), enhanced worker routing logs, handled budget provider 400 errors (`json_schema` -> `json_object` fallback), replaced deprecated model slugs.
- **Phase 3:** Expanded color picker presets, split chapter card export buttons with overflow menus, added provider/routing chips.
- **Phase 4:** Returned 410 Gone for expired exports, downgraded SSE disconnect logs to WARN, added `routingStrategy` and `useFallbackModels` to export metadata.

#### 9. Issues Inventory (`issues-found.md`)

Raw bug log and operational audit capturing issue descriptions across provider key filtering, first-load default settings population, duplicate `(free)(free)` model labels, chapter/series model mapping bugs, non-JP OCR quality degradation, out-of-bounds page creation, S3 rendered image `NoSuchKey` errors, SSE logging noise, AMOLED dark theme contrast, reader page state flash, and missing heartbeat logs.

#### 10. Initial Root Cause Analysis (`issues_rca.md`)

Technical RCA and targeted fixes for items in `issues-found.md`:

- Addressed CORS `PATCH` method support in `SecurityConfig.java`.
- Cleared stale `pages` state in `Reader.tsx` on chapter navigation.
- Defensive bounds checking in `PageController` for page creation.
- Unified S3 rendered image keys (`imageId` vs `pageId`).
- Passed chapter provider/model overrides to individual region translation fallbacks (`translate_text`).
- Standardized MUI Paper surface elevation and fixed Queue Manager column widths.

#### 11. Improved RCA Execution Plan (`issues_rca_improved.md`)

Detailed 10-phase execution guide with precise file paths and verification commands:

- Docker compose environment fallback parameters (`${VAR:-default}`).
- CORS `PATCH` method configuration.
- Provider fallback removal in `SystemSettingsService.java`.
- Model name `(free)` suffix deduplication in `providers.json`.
- Dynamic model dropdown mapping in series/chapter dialogs.
- Operational heartbeat logging (`HealthReporter`) and cache key logging in worker handlers.

#### 12. Critical Bug Fixes Plan (`plan-critical-bugfixes.md`)

Foundational data integrity, security, and pipeline stability plan:

- **Phase 1 (Data Integrity):** Shared image reference-counting before deletion, explicit `chapterId` propagation in job dispatch, duplicate key constraint prevention on re-upload, multi-chapter image layer reuse fixes.
- **Phase 2 (Backend API & Export):** Added `@Transactional(readOnly=true)` on export endpoints, fixed clear queue API, handled runtime `QA_MODE=auto` resolution, added debounced re-render service for manual edits, export ZIP caching and metadata enrichment.
- **Phase 3 (Security & Upload):** Image magic byte validation (PNG, JPEG, WebP, BMP), required Bearer auth for `/api/images/{id}/file`, updated cover URLs to use `/thumbnail`.
- **Phase 4 (Worker & Pipeline):** Worker health server `BrokenPipeError` suppression, anti-romanization prompt guards, job-level retry logic with attempt counters, automated lint/pytest fixes.

#### 13. Details API 500 Root Cause Fix (`plan-fix-details-api-500.md`)

Root cause analysis and resolution of repeated 500 errors on `GET /api/pages/{pageId}/details`:

- **Root Cause:** `Reader.tsx` prefetch loop passed `imageId` instead of `pageId` to `fetchPageDetails`, causing page lookup failures. Secondary cache key mismatch between `pageId` and `imageId` evicted active cache entries.
- **Fix:** Restructured `fetchPageDetails` in `Reader.tsx` to strictly consume `pageId`, updated prefetch loop and eviction window keys, added `GlobalExceptionHandler` with `ResourceNotFoundException` mapping 404s with descriptive JSON bodies.

---

### Configuration & Architecture Specifications

#### 14. Provider Restructuring & Inheritance Specification (`restructure.md`)

Specification for provider configuration restructuring and model inheritance:

- Replaced `api_keys.json` with `secrets/llm_config.json` defining provider defaults, priority, rate limits, free-tier flags, supported model lists (TL, QA LLM, QA VLM, OCR), and per-task cost structures.
- Formalized 6-tier model resolution fallback hierarchy (`P0` chapter overrides -> `P1` series inherited -> `P2` series overrides -> `P3` global inherited -> `P4` global overrides -> `P5` system settings defaults).
- Documented API reference curl payloads for Cloudflare Workers AI, Neurometric, Nvidia Nemotron, and Google AI Studio.
