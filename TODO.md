# TODO — Manga Library (Master Checklist)

> **Last updated**: 2026-07-12  
> Merged from: `TODO.md` + `docs/More Observations.md`  
> Plans: [Critical Bug Fixes](docs/plan-critical-bugfixes.md) | [Improvements](docs/plan-improvements.md)  
> Status legend: `[ ]` = not started, `[/]` = in progress, `[x]` = done, `[P]` = planned (in a plan doc)

---

## 🔴 Critical Bugs (plan-critical-bugfixes.md)

### Phase 1 — Data Integrity

- [P] **1.1** Shared image cascade delete — deleting a page from one chapter destroys the image in all chapters
  - Root cause: `PageService.deletePageDb()` unconditionally deletes the `Image` entity
  - Evidence: chapter `8bc70d04` in [run-7.log](logs/run-7.log)
- [P] **1.2** Per-chapter model override uses wrong chapter — `findFirst()` picks arbitrary chapter for config resolution
  - Evidence: local OCR ran instead of cloud when re-running OCR on the cloud-override chapter
- [P] **1.3** Re-upload after cross-chapter delete fails with `pages_chapter_id_page_number_key` duplicate key constraint
  - Evidence: chapter `8bc70d04` in [run-7.log](logs/run-7.log)
- [P] **1.4** Allow duplicate images in same chapter (doujin cover page use case)
  - Currently blocked by idempotency check; same hash should still create new page entries

### Phase 2 — Backend API & Export

- [P] **2.1** Chapter export returns 500 — `LazyInitializationException` after OSIV disabled
  - Endpoint: `GET /api/series/chapters/{id}/export?format=zip`
  - Response body is base64-encoded error: `...could not initialize proxy...no Session`
- [P] **2.2** Clear queue API returns `{status: 999}` — missing `@Transactional`, incomplete Redis queue list, deletes PROCESSING jobs
  - Individual job delete works (`DELETE /api/jobs/{id}`)
- [P] **2.3** QA_MODE `auto` not recognized by worker — falls back to auto-pass instead of resolving to vlm/llm/hybrid
  - Worker logs: `[QA] Unknown QA_MODE=auto, falling back to auto-pass`
- [P] **2.4** OCR model identifier string has dead `MangaOCR/` prefix
  - Shows as `MangaOCR/PaddleOCR(PP-OCRv6_medium_rec)` in exports
- [ ] **2.5** Exported ZIP should include rendered translations, not just original images
  - Currently exports only originals; post-processing edits don't sync into rendered output either

### Phase 3 — Upload Validation & Security

- [P] **3.1** Non-image files accepted on upload (`.md`, `.txt` etc.) — no file type validation
  - Evidence: `https://ideapad.tail9ece4.ts.net/tlhub/chapters/.../reader/5` is a `.md` file
  - Accept: PNG, JPEG, WebP, GIF, BMP, TIFF (magic bytes validation + extension check)
- [P] **3.2** Duplicate image idempotency guard for same chapter/same slot
- [P] **3.3** Image file endpoint (`/api/images/{id}/file`) works without auth
  - Thumbnail endpoint should remain public

### Phase 4 — Worker & Pipeline Robustness

- [P] **4.1** Worker health server `BrokenPipeError` clutters logs
  - Evidence: [run-8.log](logs/run-8.log) line 36-61
- [P] **4.2** Translation romanization in outputs from cheap models
  - Examples: `要出发了哦` → `Yào chūfā le o (About to depart!)`, `エルフ!` → `ERUFU (ELF!)`
- [P] **4.3** Job retry counter never increments — frontend always shows `Attempt: 1/3`
  - **Confirmed**: worker `rq_tasks.py` has NO job-level retry. Goes straight PROCESSING→FAILED
  - The "retries" in logs are internal translation batch retries, not job retries
  - Evidence: [run-13-retry-check.log](logs/run-13-retry-check.log), [screenshot](examples/the-retry-count-never-updated.png)
- [P] **4.4** Dockerfile uses non-existent `maven:3-eclipse-temurin-26` tag
  - Fix to `temurin-21` (LTS) or follow [Java upgrade plan](docs/lets-use-java21.md) for Java 25 local + 26 Docker
- [P] **4.5** QA `auto` mode falls back to `none` (skip) instead of trying default models
  - When chapter's provider (ollama) is unreachable, should fall back to global QA models
  - Evidence: [run-13-retry-check.log](logs/run-13-retry-check.log) line 693-695

---

## 🟡 Improvements (plan-improvements.md)

### Phase A — SSE Job System Migration

- [P] **A.1** Replace polling with SSE for job state updates
  - Frontend polls `/api/jobs` and `/api/jobs/status` multiple per second
  - Hybrid: SSE primary + 30s REST heartbeat fallback
- [P] **A.1** Queue-level SSE events: `queue_paused`, `queue_resumed`, `queue_cleared`
- [P] **A.1** Per-job SSE events: `pauseJob`, `resumeJob`, `deleteJob`, `retryJob` with targeted delivery
  - Pausing 1 of 20 jobs must NOT block the other 19
- [P] **A.2** Frontend SSE-driven Queue Manager (replace setInterval polling)
- [P] **A.3** Queue Manager UI redesign per [mockup](examples/redesign-the-job-queue.jpg)
  - Status dots: 🟢 processing, 🔵 pending, 🔴 failed, 🟡 paused
  - Per-job controls: ⏸ Pause, ▶ Resume, 🔄 Retry, ✕ Cancel
  - Confirm modals for destructive actions
  - Show `Series → Ch.N → Page M` context, attempt counter

### Phase B — Reader Auto-Refresh

- [P] **B.1** SSE-driven layer auto-refresh in Reader
  - When pipeline completes (OCR/TL/render/QA), auto-refresh layers for current page
  - Replaces broken polling-based refresh
  - Also covers manual re-OCR, re-TL, region-redo events

### Phase C — Thumbnail & Image Optimization

- [P] **C.1** WebP thumbnails with bicubic interpolation (replacing JPEG + bilinear)
- [P] **C.2** Frontend: use `/thumbnail` URLs everywhere (Dashboard, SeriesDetails)
  - Currently series covers and chapter cards load full `/file` URLs
- [P] **C.3** Async thumbnail generation off the upload request path *(NEW from More Observations)*
  - Move thumbnail gen to `@Async` bounded pool (`thumbnailExecutor`, 2-4 threads)
  - Use `ImageReader` subsampling to avoid full-resolution decode (5000×7000 = 105-140 MB per image)
  - `Image.thumbnailStoragePath` starts `null`; thumbnail endpoint returns placeholder until ready
  - Batch imports benefit most — currently one request thread pinned for minutes

### Phase D — Frontend UI Fixes & Redesign

- [P] **D.1** Remove "Cover Image URL" field from create/edit series dialogs
  - See [mockup](examples/remove-custom-thumbnails.jpg)
- [P] **D.2** Fix settings modal overflow (`max-height: 90vh`, `overflow-y: auto`)
- [P] **D.3** Chapter cards redesign per [mockup](examples/chapter-cards.jpg)
  - Rich metadata: language pair, direction, page count, model info
  - Add chapter description/edit field (optionally injected into model context)
  - Delete chapter button inside chapter page
- [P] **D.4** Dashboard sorting (Created Date ↑↓, Last Updated ↑↓)
- [P] **D.5** Fix Reader full-reload on page switch (likely unstable keys / state reset)
- [P] **D.6** Persist upload widget across navigation (lift to app-level context)
- [P] **D.7** User management modal *(expanded from More Observations)*
  - Profile with avatar, about section (inspired by [nHentai settings](examples/nHentai/user-setting-page.png))
  - Change username and password (not email)
  - Session management, delete profile
  - API keys section (stub/stretch goal)
- [P] **D.8** Theme improvements
  - Dark mode: nHentai palette — see [extracted palette](examples/nHentai/Screenshot%202026-07-12%20at%2014-09-52%20Site%20Palette%20🎨.png)
  - Light mode: Pixiv palette only (not design) — see [extracted palette](examples/pixiv/Screenshot%202026-07-12%20at%2014-11-16%20Site%20Palette%20🎨.png)
- [ ] **D.9** Lazy loading / infinite scroll for series, chapters, and pages *(NEW from More Observations)*
  - Instead of pagination (like [nHentai's paged nav](examples/nHentai/add-paged-navigation-as-the-library-can-big.png)), load more as user scrolls
- [P] **D.10** Model override display — show resolved model instead of `--Inherit--`
  - e.g., `tencent/hy3:free (inherited from series)` instead of `--Inherit--`
- [ ] **D.11** Model override UX redesign — make overrides easier to use and display

### Phase E — Backend Resilience

- [P] **E.1** Cross-provider failover (provider factory for OpenAI API + Anthropic API formats)
  - Direct DeepSeek API provider
  - When provider is down, failover to next in priority list
- [P] **E.2** Strict HTTP timeouts (connect=10s, read=45s) for all cloud LLM calls

---

## 🟡 Medium Priority — Not Yet in Plans

### Output & Rendering Quality

- [ ] Rendered output quality gap vs mangatranslator.ai
  - See [sample 2](examples/sample2/original.jpg): [theirs](examples/sample2/en-mangatranslator.ai.jpg) vs [ours](examples/sample2/en-local.png)
  - See [sample 3](examples/sample3/original.jpg): [theirs](examples/sample3/en-mangatranslator.ai.jpg) vs [ours](examples/sample3/en-local.png)

### ML Models & Prompts *(NEW section requested from More Observations)*

- [ ] **YOLO model upgrade** — current `juithealien/manga109-segmentation-bubble` (yolo11n) appears abandoned, only detects text bubbles
  - See [Model Upgrade Plan](docs/model_upgrade_plan.md)
- [ ] **OCR VLM prompt improvements** — classify text types and reject SFX, gibberish, author handles, already-English text at the OCR stage
  - If doing Re-OCR or Redo-Region-TL with a VLM, inject QA feedback to help the model
- [ ] **Translation prompt improvements** — see [current prompts](docs/models_and_prompts.md)
  - Anti-romanization is handled in plan-critical-bugfixes Phase 4.2
- [ ] **QA prompt improvements** — enhance QA to:
  - Directly update text if it has a better translation
  - Reject SFX/gibberish (hide, never delete elements)
  - Trigger re-OCR or re-TL for specific regions (not loops — one pass only)
  - QA output must be strictly better than input; never send back same text

### Java Upgrade

- [ ] Follow [Java upgrade plan](docs/lets-use-java21.md) — compile Java 25 locally via SDKMAN, run Java 26 in Docker
  - Update `pom.xml`: Spring Boot 3.4.0, `java.version=25`, `release=25`
  - Update Dockerfile: `maven:3-eclipse-temurin-26` + `eclipse-temurin:26-jre-alpine`
  - Update JaCoCo to 0.8.16

### Code Quality

- [ ] Hundreds of `Null type safety` warnings in Java codebase — audit and fix
- [ ] Layer update failure observed — check if reproducible or one-off ([run-8.log](logs/run-8.log))

---

## 🔵 Low Priority / Stretch Goals

- [ ] ePub / CBZ import and export support (currently ZIP only)
- [ ] True cross-page character memory — maintain character/name/place registry across pages (current: inject previous page text only)
- [ ] Draw-to-OCR / draw-to-translate — user draws rectangle, triggers OCR/TL for that region
- [ ] Chapter & series summarization — AI generates summaries from translated dialogue
  - Currently can be added manually; later auto-generate if not provided
- [ ] Description injection into model context — series/chapter descriptions as translation context (booru-style metadata)

---

## 🧪 Testing & QA

- [ ] Test at higher concurrency
- [ ] Make OCR lock dynamic — test if 2 parallel OCR detection runs are feasible
  - Split local OCR: one slot for detection, one for recognition
  - Add worker backpressure — let worker signal it can't accept more jobs (OOM/CPU exhaustion)
- [ ] Reserve CPU/memory for ML container (like Immich does for its ML container)
- [ ] Larger upload optimization (100+ images) — noticeable lag, need to optimize

---

## ✅ Completed (Archive)

<details>
<summary>Click to expand completed items</summary>

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
