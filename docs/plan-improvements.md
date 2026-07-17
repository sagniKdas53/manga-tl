# Plan: Improvements & UI Redesign

> Priority: **Ready to Start** | Prerequisite `plan-critical-bugfixes.md`: ✅ Completed  
> Last updated: 2026-07-17 (Phase D checkpoint — see progress summary at end of this section)

This plan covers performance improvements, UI redesign, and quality-of-life enhancements from `TODO.md`.  
All critical bug fixes from `plan-critical-bugfixes.md` (Phases 1–4) have been completed — this plan is now unblocked.

---

## 🔒 Quality Gate Reference

> [!IMPORTANT]
> **Every phase must pass the full quality gate before manual testing begins.**
> Run these checks from the project root after completing each phase. All must exit 0.

> [!WARNING]
> **This PC is not very powerful. Do NOT run too many tasks in parallel during the quality gate, otherwise it will lock up and waste all the effort. Run checks sequentially.**

### Backend (Java) — `cd backend`

```bash
# 1. Format code (auto-fix)
mvn spotless:apply

# 2. Compile + unit tests + PMD + SpotBugs + JaCoCo coverage gate (≥80% expected)
mvn clean verify -DforkCount=1 -DreuseForks=true

# (Optional) Generate HTML coverage report explicitly at target/site/jacoco/index.html
mvn jacoco:report

# 3. Verify formatting (CI parity check — must match what CI runs)
mvn spotless:check
```

**What each tool catches:**

| Tool | What it detects | Bound to |
|------|----------------|----------|
| **Spotless** | Formatting (Google Java Format), unused imports, trailing whitespace | Manual / pre-commit |
| **PMD 3.28.0** | God classes, complex methods, dead code, copy-paste, style violations | `mvn verify` |
| **SpotBugs 4.10.2** | Null pointer bugs, resource leaks, concurrency issues, bad practices (bytecode analysis) | `mvn verify` |
| **JaCoCo 0.8.15** | Line coverage gate — fails build if coverage < 80% | `mvn verify` |
| **Surefire** | Unit test failures | `mvn verify` |

### Frontend (React/TypeScript) — `cd frontend`

```bash
# 1. Lint (ESLint — catches unused vars, type errors, React issues)
npm run lint

# 2. Unit tests with HTML coverage (minimum 80% expected)
npm run test:coverage

# 3. Production build (catches TypeScript compilation errors, dead imports)
npm run build
```

### Worker (Python) — `cd unified-workers`

```bash
# 1. Lint (catches bugs, unused imports, style issues)
ruff check .

# 2. Auto-fix safe lint issues + format
ruff check . --fix && ruff format .

# 3. Static type checking (catches type errors, None misuse, missing attrs)
pyright .

# 4. Unit tests with coverage (minimum 80% expected)
pytest tests/ --cov=. --cov-report=xml --cov-report=html
```

---

## Phase 0 — CI Foundation (Do First) ✅ Completed

> [!IMPORTANT]
> Complete this phase **before starting any other phase**. Every worker change in Phases A–F will benefit from having ruff + pyright catching bugs automatically.

### 0.1 Add Static Analysis to Python CI

> [!WARNING]
> The backend CI catches bugs **before they ship** via PMD (code patterns) and SpotBugs (bytecode analysis). The Python worker CI currently **only runs `pytest`** — no linting, no formatting checks, no type checking. This means bugs like the `vlm_model_used` scoping issue (fixed in bugfixes Phase 4) could have been caught automatically.

**Files**: `unified-workers/.github/workflows/ci-python.yml`, `unified-workers/requirements.txt`, new `unified-workers/pyproject.toml`

- **Create `pyproject.toml`** with ruff configuration:

  ```toml
  [tool.ruff]
  target-version = "py313"
  line-length = 120

  [tool.ruff.lint]
  select = [
      "E",    # pycodestyle errors
      "W",    # pycodestyle warnings
      "F",    # pyflakes (unused imports, undefined names, etc.)
      "I",    # isort (import ordering)
      "B",    # flake8-bugbear (common bug patterns)
      "UP",   # pyupgrade (Python version upgrade suggestions)
      "SIM",  # flake8-simplify (simplifiable code)
      "RUF",  # Ruff-specific rules
  ]
  ```

- **Add `pyright`** for static type checking:
  - Install: `pip install pyright`
  - Create `pyrightconfig.json` with `typeCheckingMode: "basic"` (not strict — avoids noise on untyped dependencies like `paddleocr`)
  - Catches: `None` dereferences, missing attributes, wrong argument types, unreachable code
- **Update CI workflow** (`ci-python.yml`):

  ```yaml
  - name: Install dev tools
    run: pip install ruff pyright

  - name: Lint (ruff)
    run: ruff check .

  - name: Format check (ruff)
    run: ruff format --check .

  - name: Type check (pyright)
    run: pyright .

  - name: Run test suite
    run: pytest tests/ --cov=. --cov-report=xml
  ```

- **Add to `requirements.txt`** (dev section or separate `requirements-dev.txt`):

  ```
  ruff
  pyright
  ```

**Parity with backend CI:**

| Python tool | Equivalent to (Java) | What it catches |
|-------------|---------------------|------------------|
| **ruff check** | PMD | Dead code, unused imports, bug patterns, complexity |
| **ruff format** | Spotless | Formatting consistency |
| **pyright** | SpotBugs | Type errors, None misuse, missing attributes |
| **pytest** | Surefire | Unit test failures |
| pytest-cov | JaCoCo | Coverage reporting (no gate yet — add later) |

### ✅ Checkpoint 0 — CI Foundation (Completed)

**Verification:**

1. Run `ruff check .` locally in `unified-workers/` — fix all violations
2. Run `ruff format --check .` — fix all formatting issues
3. Run `pyright .` — fix all type errors (or add targeted `# type: ignore` for untyped third-party libs)
4. Run `pytest tests/` — all tests pass
5. Push to a PR branch — verify the updated `ci-python.yml` workflow runs all 4 steps and passes

**🔒 Quality Gate:**

```bash
cd unified-workers && ruff check . && ruff format --check . && pyright . && pytest tests/ --cov=. --cov-report=xml
```

### Bugs and fixes (phase 0)

During the implementation of Phase 0, setting up strict static analysis for Python workers uncovered several latent issues:

1. **Undeclared Loop Variables**: In `model_manager.py`, some loop variables were referenced outside of the loop scope or undeclared, causing potential runtime `NameError` exceptions.
2. **Incorrect `sys.exit()` Calls**: Found `sys.exit()` calls placed incorrectly outside of functions or main execution blocks, which could lead to unexpected script terminations during imports.
3. **Type Mismatches & Missing Annotations**: Pyright detected multiple type mismatches and missing `Optional` / `None` type annotations across the codebase.
4. **Duplicate Coverage Reports**: Cleaned up the test coverage scripts so they export to a single unified `frontend/coverage` folder instead of duplicating reports.

---

## Phase A — SSE Job System Migration ✅ Completed

> [!NOTE]
> This replaces the current multi-per-second REST polling with a hybrid approach:
> **one initial REST fetch** for the full snapshot + **SSE for real-time deltas**.
> If no SSE events arrive within 60s, a single heartbeat REST fallback fires to ensure consistency.

### A.1 Backend: Emit Job State Change Events via SSE

**Files**: `SseService.java`, `JobCoordinatorService.java`, `InternalJobController.java`

- Add a new SSE event type `"job_update"` alongside the existing `"notification"` event
- Payload: `{ jobId, type, status, imageId, attempt, maxAttempts, error, chapterTitle, seriesTitle, pageNumber }`
- Emit `job_update` from:
  - `enqueueJobDirectly()` → status: `PENDING`
  - `InternalJobController.updateJobStatus()` → status: `PROCESSING`, `COMPLETED`, `FAILED`
  - **Queue-level events** (broadcast to all connected emitters):
    - `pauseQueue()` / `resumeQueue()` → `{ event: "queue_paused" }` / `{ event: "queue_resumed" }`
    - `clearQueue()` → `{ event: "queue_cleared", clearedCount: N }`
  - **Per-job events** (targeted to the job's owner via image→user mapping):
    - `pauseJob()` → `{ event: "job_update", jobId, status: "PAUSED" }`
    - `resumeJob()` → `{ event: "job_update", jobId, status: "PENDING" }`
    - `deleteJob()` → `{ event: "job_update", jobId, status: "DELETED" }`
    - `retryJob()` → `{ event: "job_update", jobId, status: "PENDING", attempt: 1 }`
- Use `emitNotificationForImage()` to route per-job events to the correct user
- Use a new `emitToAllUsers()` method for queue-level events (pause/resume/clear)

### A.2 Frontend: SSE-Driven Queue Manager

**Files**: `useSSE.ts`, `QueueManager.tsx`

- In `useSSE.ts`:
  - Add listener for `"job_update"` SSE events
  - Expose a `jobUpdates` reactive list that components can subscribe to
  - Track a `lastEventTime` timestamp

- In `QueueManager.tsx`:
  - On mount: fetch `GET /api/jobs` once for the full initial snapshot
  - Listen to SSE `job_update` events and patch the local state (add/update/remove jobs)
  - **Heartbeat fallback**: If no SSE event (of any kind) received in 30s, re-fetch `GET /api/jobs` once as a consistency check
  - Remove the current `setInterval` polling loop entirely

### A.3 Frontend: Queue Manager UI Redesign

Per the annotated mockup in `examples/redesign-the-job-queue.jpg`:

**Files**: `QueueManager.tsx`, `index.css`

- **Status dots** — color-coded indicator per job card:
  - 🟢 Green = PROCESSING (currently active)
  - 🔵 Blue = PENDING (queued)
  - 🔴 Red = FAILED
  - 🟡 Yellow = PAUSED
- **Confirm dialogs** — use `ConfirmModal` component (not `window.confirm`) for:
  - Clear Queue
  - Pause Queue (with note: "all queued jobs will be paused")
- **Play/Pause toggle** — replace text buttons with ▶/⏸ icon buttons
- **Per-job controls** — each job card gets:
  - ⏸ Pause button (only for PENDING jobs → sets to PAUSED, SSE confirms immediately)
  - ▶ Resume button (only for PAUSED jobs → sets to PENDING, SSE confirms)
  - 🔄 Retry button (only for FAILED jobs → resets to PENDING, SSE confirms)
  - ✕ Cancel/Delete button (with confirm, SSE sends `DELETED` event)
  - When any per-job action is taken, the frontend should optimistically update the UI and then confirm via the SSE event
  - Other paused jobs should NOT block processing — only that specific job is paused
- **Job card improvements**:
  - Show `Series → Ch.N → Page M` context
  - Make status dot larger and more prominent
  - Show attempt counter: `Attempt 1/3`
- **Series → Chapter → Page level controls**:
  - On the series detail page: show total pending/processing/failed counts
  - Progress bar based on pipeline phase (panel detection → OCR → layout → translation → render → QA)
  - Per-chapter play/pause/clear buttons

### ✅ Checkpoint A — SSE & Queue

**Automated tests:**

- `SseServiceTest`: emit `job_update` → verify SSE listener receives it
- `QueueManagerTest`: mock SSE stream → verify UI updates without polling

**Manual checks:**

1. Open Queue Manager → upload a page → verify job cards appear in real-time (no page refresh)
2. Click Pause Queue → verify toast/confirm modal → verify SSE delivers `queue_paused` event → all PENDING jobs show yellow dots
3. Click Resume → verify SSE delivers `queue_resumed` → jobs resume processing and turn green/blue
4. Click Clear Queue → confirm modal → verify cleared count toast
5. Kill the backend briefly → restart → verify the heartbeat fallback re-fetches state within 30s
6. Open two browser tabs → one uploads, the other should see job updates via SSE simultaneously
7. **Per-job pause**: Queue 20 jobs → pause job #2 → verify the other 19 continue processing → verify job #2 shows yellow dot
8. **Per-job resume**: Resume the paused job #2 → verify it goes back to blue → gets picked up for processing
9. **Per-job retry**: Let a job fail → click retry → verify SSE sends `PENDING` event with `attempt: 1` → job reappears in queue

**🔒 Quality Gate** (run before manual checks — see [reference](#-quality-gate-reference)):

```bash
# Backend (SSE + job controller changes)
cd backend && mvn spotless:apply && mvn clean verify -DforkCount=1 -DreuseForks=true
# Frontend (SSE hook + QueueManager changes)
cd frontend && npm run lint && npm run test:coverage && npm run build
```

### Bugs and fixes (phase A)

As we integrated the SSE-based Job Queue system, we resolved several critical real-time bugs in the frontend and backend:

1. **Duplicate Job Cards**
   - **Bug**: Every incoming SSE event spawned a brand new job card in the queue instead of updating the existing one.
   - **Fix**: The backend was emitting raw data maps that lacked proper job IDs. We updated the backend to serialize and emit the full `Job` object, allowing the frontend to find the existing job by its ID and patch it in place.
2. **Cards Stuck Saying Only "PROCESSING"**
   - **Bug**: When a job updated, it lost its visual metadata (like attempt counts, series title, and chapter info) and just displayed "PROCESSING".
   - **Fix**: We updated `QueueManager.tsx` to properly merge the incoming SSE data with the existing job state so the UI retains all relevant metadata across renders.
3. **Missed Notifications for Fast Events**
   - **Bug**: If multiple jobs (e.g., 3 pages) finished simultaneously, the UI only showed a notification for the last one.
   - **Fix**: Resolved a React race condition in `useSSE` where incoming events were written to a single `lastEvent` state. We rewrote the hook to use a robust **Subscriber Pattern** (passing an `onMessage` callback) so every single event is caught and processed synchronously.
4. **Paused Jobs Jumping to the Bottom**
   - **Bug**: Pausing a job instantly threw it to the bottom of the list, losing its place in the queue.
   - **Fix**: The sorting algorithm in `QueueManager.tsx` penalized `PAUSED` jobs by giving them a lower priority weight. We adjusted the sorting weights so `PAUSED` and `PENDING` jobs are treated equally, keeping them in their natural chronological order.
5. **Unclear Global Pause State**
   - **Bug**: When the entire global queue was paused, pending jobs stayed blue, making them look active.
   - **Fix**: Added conditional logic to the color/text renderers. If the global queue is paused, all `PENDING` jobs instantly turn yellow and display the text `"PAUSED"`.
6. **API Consolidation**
   - **Bug**: Having both `/api/jobs` and `/api/jobs/status` was redundant and increased polling overhead.
   - **Fix**: Merged these into a single `/api/jobs` endpoint that returns a unified `{ isPaused, jobs }` object, updated the frontend, and refactored the test suite to match.
7. **Confusing Per-Job Play/Pause Buttons during Global Pause**
   - **Bug**: Even when the entire queue was paused globally, individual job cards still displayed active pause buttons, incorrectly implying they could be interacted with.
   - **Fix**: Updated `QueueManager.tsx` to visually disable these per-job buttons (opacity reduction, not-allowed cursor) and display a play icon with a "Queue is globally paused" tooltip whenever `isPaused` is true.

---

## Phase B — Reader Auto-Refresh via SSE ✅ Completed

### B.1 Reader Layer Auto-Refresh

**Files**: `Reader.tsx`, `useSSE.ts`

- Subscribe to `job_update` events in the Reader
- When a `COMPLETED` event arrives for the current page's `imageId` with type `ocr`, `translation`, `region-redo-ocr`, `region-redo-tl`:
  - Auto-refresh the layers panel
  - Show a subtle toast: "New layers available — refreshed"
- Remove any existing manual "Refresh Gallery" button dependency

### ✅ Checkpoint B — Reader SSE

**Manual checks:**

1. Open Reader on a freshly uploaded page → watch layers populate in real-time as pipeline completes
2. Open Reader on a page → trigger "Redo OCR" from the detail panel → new OCR layer should appear without manual refresh

**🔒 Quality Gate** (run before manual checks):

```bash
cd frontend && npm run lint && npm run test:coverage && npm run build
```

---

## Phase C — Thumbnail & Image Serving ✅ Completed

### C.1 Upgrade Thumbnail Generation to WebP ✅ Completed (migration skipped for now)

> [!NOTE]
> **Why WebP over AVIF?**  
>
> - AVIF gives ~20-50% better compression but encoding is **5-10× slower** per image — significant for batch uploads of 40+ page chapters
> - Java AVIF support requires JNI native bindings (`libavif`) which add Docker build complexity
> - WebP encoding is highly optimized, has universal browser support, and the `webp-imageio` plugin is a pure drop-in for `ImageIO`
> - For small thumbnails (~300px wide), the compression difference is negligible (a few KB)

**Files**: `PageService.java`, `pom.xml`

- Add `webp-imageio` Maven dependency (or `twelvemonkeys-webp`)
- In `generateThumbnail()`:
  - Switch interpolation from `BILINEAR` to `BICUBIC` (line 130)
  - Change output format from `"jpg"` to `"webp"` via ImageIO writer
  - Set quality to 80% (configurable)
- Update storage path from `thumbnails/{uuid}.jpg` → `thumbnails/{uuid}.webp`
- Update content type from `image/jpeg` → `image/webp` at all upload sites
- In `getImageThumbnail()`: update fallback content type to `image/webp`
- **Migration**: Existing JPEG thumbnails continue to work — the endpoint already serves based on the stored path
- **Cleanup**: Existing thumbnails in the MinIO bucket are still `.jpg` (see [screenshot](../examples/thumbs-still-in-jpg-not-webp.png)). Add a one-time migration task or startup job that re-generates thumbnails as WebP for all images that still have a `.jpg` thumbnail path. This can run on the `thumbnailExecutor` pool (C.3) in the background at low priority.

### C.2 Frontend: Use Thumbnail URLs Everywhere ✅ Completed

**Files**: `Dashboard.tsx`, `SeriesDetails.tsx`, `ChapterGallery.tsx`

- Audit all places that display series covers, chapter cover thumbnails, or page previews in gallery view
- Replace any use of `/api/images/{id}/file` with `/api/images/{id}/thumbnail` for preview contexts
- The full `/file` endpoint should only be used in the Reader for full-resolution viewing

### C.3 Move Thumbnail Generation Off the Upload Request Path ✅ Completed

> [!IMPORTANT]
> The WebP + bicubic change alone won't fix the performance bottleneck. The real issue is the **full-resolution decode + 2 sequential MinIO round trips** blocking the servlet thread. A 5000×7000 image = 105-140 MB `BufferedImage` in heap. With 200 concurrent uploads (Tomcat default), this risks OOM and thread-pool starvation.

**Files**: `PageService.java`, `PageController.java`, `SeriesController.java`

**Current flow** (synchronous, blocking):

```
Upload → file.getBytes() → ImageIO.read (full decode) → bilinear resize → ImageIO.write(jpg)
      → MinIO.put(original) → MinIO.put(thumbnail) → HTTP response → startPipeline()
```

**Proposed flow** (async, non-blocking):

```
Upload → file.getBytes() → MinIO.put(original) → HTTP response → startPipeline()
                                                                ↳ @Async thumbnailPool:
                                                                  ImageReader.subsampled()
                                                                  → bicubic resize → WebP
                                                                  → MinIO.put(thumbnail)
                                                                  → update Image.thumbnailStoragePath
```

- Use `ImageReader` subsampling to avoid full-resolution decode (read at 1/4 or 1/8 scale directly)
- Create a bounded `@Async` thread pool (`thumbnailExecutor`, size 2-4)
- `Image.thumbnailStoragePath` starts as `null`; thumbnail endpoint returns a placeholder/original until ready
- For batch imports (`importProject`/`importChapter`): queue all thumbnails to the async pool instead of blocking per-file
- Existing behavior is already resilient: thumbnail failure doesn't block upload (lines 546-548)

### C.4 Future Optimization: Denormalize Cover Image Paths

> [!NOTE]
> Currently, the backend dynamically calculates the default cover image for Series and Chapters on the fly. When fetching `GET /api/series` or `GET /api/series/{id}`, it runs heavy SQL subqueries (e.g., `SELECT p.image.thumbnailStoragePath ... WHERE p.pageNumber = (SELECT MIN...)`) to find the first page of the first chapter.
>
> **Why this is problematic:** As the library grows, running these nested `MIN()` queries on the `Page` table across thousands of pages becomes an unnecessary bottleneck for something that is essentially static.
>
> **Future Optimization Plan:**
>
> 1. Add a `cover_image_id` or `cover_image_url` column directly to the `Series` and `Chapter` tables.
> 2. When a new `Page` is uploaded and determined to be the "first" page (e.g., Chapter 1, Page 1), have the `PageService` / `PageController` directly update the `cover_image_id` of the parent `Chapter` and `Series`.
> 3. Update the `SeriesController` and `ChapterController` to simply read this pre-computed column, eliminating the heavy SQL joins entirely.

### C.5 Future Optimization: Background Image Decoding for Instant Transitions

> [!NOTE]
> Currently, we pre-fetch the next 2 pages in JavaScript using `new Image().src = ...`. This downloads the file in the background, but the browser often defers *decoding/rendering* it until it's actually shown on screen.
>
> **The Tradeoff:**
>
> - **Current approach (JS fetch only):** Keeps memory usage low and provides progressive rendering visual feedback (the image loads top-to-bottom like "assembling parts") which users on slower connections prefer to see.
> - **Future approach (Hidden DOM elements):** If we ever want 100% instant, seamless transitions, we could render hidden `<img />` tags for the pre-fetched pages in the DOM. This forces the browser to do the heavy decoding and rasterizing early.
>
> For now, we are intentionally sticking to the lightweight JS fetch to retain progressive rendering, but this is documented here as an easy switch if the UX requirements change.

### ✅ Checkpoint C — Thumbnails

**Bugs Found & Resolved:**

- **Bug**: WebP thumbnails were pixelated and aliased due to aggressive image subsampling (`setSourceSubsampling`) in Java before downscaling.
- **Fix**: Replaced pure subsampling with a hybrid approach (subsample up to 3x target size, then use `Image.SCALE_SMOOTH` area-averaging) for crisp, high-quality thumbnails. Also updated the python migration script to use `LANCZOS` filter.
- **Bug**: The async WebP generation crashed in the background thread with `IllegalStateException: No compression type set!`, causing thumbnails to never generate. This resulted in missing `thumbnail_storage_path` values in the DB, causing Chapter/Series views to have no covers.
- **Fix**: Added explicit `setCompressionType()` call before setting the compression quality in `PageService.java`.
- **Bug**: Fallback `processing-thumbnail.webp` looked ugly and didn't match the standard UI pattern for uninitialized items.
- **Fix**: Removed the static fallback logic. If a thumbnail isn't generated yet, the backend correctly omits the URL or returns `404 Not Found`, prompting the frontend to seamlessly render its CSS `manga-cover-placeholder` element instead.
- **Bug**: Thumbnail propagation issue where navigating from a chapter back to the series details view resulted in a stale series object (missing its thumbnail) because the frontend cached the old series object based on route IDs, AND the backend `GET /api/series/{id}` endpoint silently swallowed a `LazyInitializationException` when trying to eagerly fetch the lazy `Image` entity to resolve the series cover.
- **Fix**: First, rewrote the `useEffect` hooks in `App.tsx` that load Series and Chapter route data to ensure fresh asynchronous data fetches whenever the user navigates the hierarchy. Second, fixed `SeriesController.toDto` in the backend to use the existing JPQL `Object[]` projection query (`findFirstPageImageIdsBySeriesId`) instead of fetching `Page`/`Image` entities, completely eliminating the `LazyInitializationException` and ensuring the series cover URL is always populated.
- **Bug**: Stale or incorrect cover thumbnails were displayed when the first image of a chapter was replaced via ZIP import, when pages were reordered, when the first page was deleted, or when the first chapter was updated/deleted. The denormalized `coverImageId` optimization (C.4) failed to update under these edge cases.
- **Fix**: Implemented comprehensive cache invalidation hooks. Created `recalculateChapterCover` and `recalculateSeriesCover` in `PageService` to resync the denormalized `coverImageId` fields, and integrated these hooks across `PageService`, `PageController`, and `SeriesController` to trigger automatically whenever the cover dependencies change. Also added extensive integration/unit tests across the service and controller layers to guarantee cover resyncs on these exact edge cases.

**Automated tests:**

- `PageServiceTest`: generate thumbnail from test PNG → verify output is valid WebP
- `PageControllerTest`: upload image → `GET /thumbnail` → verify `Content-Type: image/webp`
- `PageServiceTest`: upload with async thumbnail → verify `thumbnailStoragePath` is populated within 5s

**Manual checks:**

1. Upload a new page → check MinIO storage → thumbnails should be `.webp` files
2. Open Dashboard → inspect network tab → series covers should load from `/thumbnail` not `/file`
3. Compare visual quality: old JPEG thumbnail vs new WebP thumbnail
4. Upload 40 pages in batch → verify upload response returns quickly (< 2s per page) → thumbnails populate asynchronously

**🔒 Quality Gate** (run before manual checks):

```bash
cd backend && mvn spotless:apply && mvn clean verify -DforkCount=1 -DreuseForks=true
```

---

## Phase D — Frontend UI Fixes & Redesign

> [!IMPORTANT]
> **Recommended execution order**: D.14 (render-hygiene foundation) → D.12 Phase 0 (MUI v9 setup) → D.12 Phase 2 (modals) → Phase 1 (nav) → Phase 8 (auth) → Phase 5 (forms/settings: D.2, D.10, D.11) → Phase 4 (dashboard/cards: D.1, D.3, D.4) → Phase 6 (stacked toasts: D.13) → Phase 3 (queue: MUI Table) → Phase 7 (reader + bugs 7.4.1/7.4.2) → D.9 (infinite scroll, needs backend) → Phase 9 (cleanup) → D.15 (mobile, stretch goal)
>
> **Audited decisions (2026-07-17)**: MUI **v9** (not v7 — TS 6 compat) · toasts stay **stacked** (not single-queue) · Queue Manager uses **MUI Table** (not DataGrid/Cards) · D.10 resolves **client-side** (no new endpoint; backend enrichment planned separately) · Reader bugs **7.4.1 + 7.4.2 only** (7.4.3 deferred — it is a backend change) · D.14 **re-scoped** to context memoization + prop stabilization + memo (see D.14)

### D.1 Remove Cover Image URL Field from Dialogs

Per `examples/remove-custom-thumbnails.jpg`:

**Files**: `Dashboard.tsx`, `SeriesController.java`

- Remove "Cover Image URL (Optional)" input from Create Series and Edit Series dialogs
- Remove `coverImageUrl` setter from `createSeries()` and `updateSeries()` in the backend
- The cover is auto-derived from the first page's thumbnail — this field is misleading

### D.2 Fix Settings Modal Overflow

**Files**: `SettingsModal.tsx`, `index.css`

- Add `max-height: 90vh` and `overflow-y: auto` to the settings modal container
- Fix the scrollbar appearance per the annotated mockup

### D.3 Chapter Cards Redesign

Per `examples/chapter-cards.jpg`:

**Files**: `SeriesDetails.tsx`, `ChapterGallery.tsx`, `index.css`

- **Chapter header redesign** — show rich metadata:
  - Language pair: `ja → en`
  - Reading direction: `RTL`
  - Page count: `40 pages`
  - Model info: e.g., `OCR: PaddleOCR | TL: gemini-2.5-flash (inherited)`
  - Context memory status
- Add chapter description/edit field
- Add delete chapter button (with confirm modal)
- Remove "(ZIP/ePub)" from import button text → just "Import Chapter (ZIP)"

### D.4 Dashboard Sorting

**Files**: `Dashboard.tsx`

- Add sorting dropdown: `Created Date ↑↓`, `Last Updated ↑↓`
- Default to `Last Updated ↓` (newest first)
- Persist sort preference in localStorage

### D.5 Fix Reader Full-Reload on Page Switch

**Files**: `Reader.tsx`

- Investigate why the entire Reader component re-mounts when navigating between pages
- Likely cause: the page list component uses unstable keys or the router re-mounts on URL change
- Fix: use React `useMemo` / stable keys, ensure only the image + layers data changes

### D.6 Persist Upload Widget Across Navigation

**Files**: `App.tsx` (or new `UploadContext.tsx`), `ChapterGallery.tsx`

- Lift the upload progress widget state to app-level context
- Opening the Reader or navigating to Series page should not destroy the upload progress indicator
- The widget should float in a corner and survive route changes

### D.7 User Management Modal

**Files**: `[NEW] UserManagement.tsx`, `Navbar.tsx`

Inspired by [nHentai settings page](../examples/nHentai/user-setting-page.png):

- Clickable username in navbar → opens user management modal/page
- **Profile section**: avatar (upload or generate from initials), about/bio field
- **Account section**: change username, change password (requires current password), email shown but not editable
- **Session management**: list active sessions, ability to revoke
- **Delete profile**: with confirmation
- **API keys** (stretch goal): stub the UI design now, implement later
- Do NOT include: favourite tags, blocked tags (not relevant to our app)

### D.8 Theme Improvements

**Files**: `index.css`

- **Dark mode**: Use extracted [nHentai palette](../examples/nHentai/Screenshot%202026-07-12%20at%2014-09-52%20Site%20Palette%20🎨.png) for color scheme
- **Light mode**: Use extracted [Pixiv palette](../examples/pixiv/Screenshot%202026-07-12%20at%2014-11-16%20Site%20Palette%20🎨.png) — palette only, NOT Pixiv's design/layout
- Ensure all components respect the theme toggle

### D.9 Lazy Loading / Infinite Scroll

**Files**: `Dashboard.tsx`, `SeriesDetails.tsx`, `ChapterGallery.tsx`

- Instead of pagination (like [nHentai's paged navigation](../examples/nHentai/add-paged-navigation-as-the-library-can-big.png)), implement infinite scroll
- Load initial batch (e.g., 20 series / 10 chapters / 30 pages) → load more as user scrolls near the bottom
- Use `IntersectionObserver` API for scroll detection
- Requires backend pagination support: `GET /api/series?page=1&size=20&sort=updatedAt,desc`

### D.10 Model Override Display — Show Resolved Model

**Files**: `SettingsModal.tsx` (or model picker components), `SeriesDetails.tsx`, `ChapterGallery.tsx`

- Currently, when a chapter/series inherits a model setting, the UI shows `--Inherit--` with no indication of what model is actually being used
- **Change**: resolve the inheritance chain and display the effective model name with provenance:
  - e.g., `tencent/hy3:free (inherited from series)` or `google/gemini-2.5-flash (inherited from global)`
- **Decision (2026-07-17)**: resolve the chain **client-side** for now — a `resolveModel(chain)` frontend utility with unit tests, using settings + series/chapter data the UI already fetches. No new backend endpoint in this phase. The series/chapter APIs are planned to return resolved settings directly **later**; when they do, the utility becomes a one-line delete — do not build further logic on top of it.
- In the model picker dropdowns:
  - The `--Inherit--` option should show a subtitle with the resolved model name
  - When a chapter inherits from series, and series inherits from global, display the full chain
- In chapter cards (D.3) and Reader metadata:
  - Display the resolved model name for OCR, Translation, and QA
  - Use a subtle label like `(inherited)` or `(global)` to indicate the source
- Backend may need a new endpoint or enrichment: `GET /api/chapters/{id}/resolved-settings` — **superseded by the client-side decision above**; a future backend enrichment (series/chapter DTOs carrying resolved settings) will be planned as its own item outside Phase D

### D.11 Model Override UX Redesign

**Files**: `SettingsModal.tsx`, model picker components, `SeriesDetails.tsx`

- The current model override system (global → series → chapter) is functional but confusing for users
- **Goals**:
  - Make it visually clear which level is setting each model
  - Show a visual hierarchy: Global defaults → Series overrides → Chapter overrides
  - Allow quick "reset to inherited" action per setting
  - Group related settings (OCR provider + model, TL provider + model, QA provider + model) into logical sections
- **Proposed UX changes**:
  - Use an accordion or tabbed layout per override level
  - Color-code or badge settings that differ from their parent level
  - Add a "Reset to Default" button per setting that clears the override
  - Show a summary view: "This chapter uses 2 custom overrides, inherits 4 from series"
  - Consider a diff-style view showing what's overridden vs inherited
- This builds on D.10 (resolved display) — D.10 should be completed first

### D.12 Migrate Frontend to Material UI (MUI)

> [!IMPORTANT]
> This is a **foundational change** that affects all of Phase D. It should be tackled early (ideally first in Phase D) so that subsequent UI items (D.1–D.11) are built on MUI components rather than vanilla CSS that will be replaced later.
>
> **Full plan**: [docs/plan-mui-migration.md](plan-mui-migration.md) — 9-phase incremental migration with component mapping, palette extraction, CSS tracking sheet, performance analysis, mobile plan, and phase dependency graph.

**Files**: `package.json`, all `.tsx` components, `index.css` → MUI theme files

### D.14 Render-Hygiene Foundation (Performance Fix — Do First)

**Files**: `App.tsx`, `ToastContext.tsx`, `NotificationContext.tsx`, the 4 route component files

- **Problem**: `App.tsx` holds 8 `useState` hooks and passes all state as props. When *any* state changes, **every route component re-renders** — even if its specific props didn't change. This is the primary cause of the "laggy tab" experience.
- **Why a bare `React.memo` wrap does NOT fix it** (audit, 2026-07-17 — original "zero-risk one-liner" framing was wrong):
  1. `ChapterGallery` receives `onSelectPage={() => {}}` (App.tsx:535, :552) — a new function identity every render, defeating memo on that route.
  2. Both context values are unmemoized inline literals (`ToastContext.tsx:99`, `NotificationContext.tsx:82–89`), and both providers render inside `AppContent`. **Any** AppContent state change re-renders every `useToast`/`useNotifications` consumer (Reader, QueueManager, Dashboard, SeriesDetails, ChapterGallery) regardless of memo — context propagation bypasses it.
  3. Route components are `React.lazy` (App.tsx:29–34); `React.memo(Dashboard)` in App.tsx doesn't compose — memo must be applied at each component's export site.
  4. `NotificationProvider` owns the app's only EventSource — a remount drops the SSE connection (Phase A/B behavior at risk).
- **Fix (in order)**:
  1. **Memoize context values** — `useMemo` the `ToastContext` value; `useMemo` + `useCallback` (`markAsRead`, `markAllAsRead`, `clearAll` — currently plain functions) for the `NotificationContext` value.
  2. **Stabilize props** — hoist `onSelectPage` to a module-level `noop` constant; `useCallback` for SettingsModal `onClose`. Do **not** wrap setState dispatches in `useCallback` — they are already referentially stable.
  3. **Memo at export sites** — `export default React.memo(Dashboard)` (same for SeriesDetails, ChapterGallery, Reader) inside each component file, composing cleanly with `React.lazy`.
  4. **SSE remount guard** — `NotificationProvider` stays mounted above `<Routes>`; no `key` props; token changes only on login/logout. Rule applies to all later phases (D.6's `UploadContext` must ship with a memoized value from day one).
- **Impact**: 60-80% fewer re-renders on route navigation — but only with steps 1–2 done; memo alone delivers a fraction of it.
- **Verification**: React DevTools Profiler — Dashboard render count stays flat while Reader state changes (Checkpoint D item 13 is a *measured* check).
- **Do this BEFORE any MUI migration** to establish a solid rendering baseline.

- **Motivation**: The current transparent/glassmorphism design doesn't feel polished. Adopting MUI gives us a battle-tested component library with consistent design language.
- **Dependencies** (updated 2026-07-17 — target **v9**, the current stable; v7 predates TypeScript 6.0):
  - [`@mui/material@^9`](https://mui.com/material-ui/getting-started/) — core components
  - [`@mui/icons-material@^9`](https://mui.com/material-ui/material-icons/) — icon library (import via direct paths, e.g. `@mui/icons-material/PlayArrow` — no barrel imports)
  - `@emotion/react`, `@emotion/styled` — MUI's styling engine
- **Theme setup**:
  - Create a custom MUI `ThemeProvider` with two themes:
    - **Dark mode**: nHentai palette (from D.8) applied as MUI theme tokens
    - **Light mode**: Pixiv palette (from D.8) applied as MUI theme tokens
  - This replaces the manual CSS variable approach in D.8 — the palettes are now injected via `createTheme()`
  - Persist theme preference in `localStorage` (integrate with existing dark/light toggle)
- **Migration strategy** — incremental, not big-bang:
  1. Install MUI + wrap `App.tsx` in `ThemeProvider`
  2. Replace primitive elements first: buttons → `Button`, inputs → `TextField`, dialogs → `Dialog`, modals → `Modal`
  3. Replace layout: use `Container`, `Grid`, `Card`, `AppBar`, `Drawer` for page structure
  4. Replace feedback: toasts → **stacked** `Snackbar`/`Alert` (preserve current multi-toast behavior — see Phase 6 of the migration plan), confirms → `Dialog`, loading → `CircularProgress`/`Skeleton`
  5. Use MUI **`Table` (`size="small"`)** for the Queue Manager (A.3) — decision 2026-07-17: **not** DataGrid (extra `@mui/x-data-grid` dependency, doesn't fit a dropdown), **not** Cards; the dropdown widens or converts to a right-anchored `Drawer` — see migration plan Phase 3
  6. Use MUI `Select`, `Accordion`, `Tabs` for model overrides (D.10, D.11)
- **Use pre-built MUI components wherever possible** to reduce custom CSS and offload design decisions to MUI's defaults
- **Remove** most of `index.css` once migration is complete — keep only truly custom styles
- D.8 (theme improvements) is **subsumed** by this item — the palette work becomes MUI theme configuration

### D.13 Global Toast Notifications for Deletion Restrictions

**Files**: `SeriesDetails.tsx`, `Dashboard.tsx`, `ChapterGallery.tsx`, `Reader.tsx`, `QueueManager.tsx`, `utils.ts`

- Improved feedback when users attempt unauthorized deletions (e.g., when a user lacking the `TRANSLATOR` role tries to delete a chapter/series/page)
- Migrated all `alert()` usage in deletion workflows to the custom `useToast()` hook.
- Modified `safeFetch` to only auto-logout on `401 Unauthorized` responses instead of `403 Forbidden`, preventing abrupt logouts and allowing the application to display a clear toast message explaining the permission issue instead.

### ~~D.15 Mobile: tl-hub Lite (Stretch Goal)~~

> [!NOTE]
> The full desktop Reader (5292 lines, SVG overlays, polygon editing, dual sidebars, floating toolbars, zoom/pan/drag) is fundamentally unsuitable for mobile. This is a separate single-purpose flow, not responsive desktop.

**New file**: `frontend/src/components/MobileApp.tsx`

- **New route**: `/mobile` → independent component, no dependency on Reader/Dashboard
- **Flow**: Upload image → SSE progress bar (6 pipeline dots) → side-by-side preview → download rendered PNG
- **Components**: MUI `MobileStepper` + `LinearProgress` + `CardMedia` + `Button`
- **Reuses existing APIs**: `POST /api/images`, SSE notification stream, `GET /api/series/chapters/{id}/export`
- **Excludes**: No layer editing, no sidebars, no OCR regions, no zoom/pan — pure upload → process → export

---

## Phase D Progress (2026-07-17 checkpoint)

### Completed

| Item | Status | Notes |
|------|--------|-------|
| **D.14** | ✅ Done | Re-scoped from "4 one-liners" to ~30 lines across 7 files. `ToastContext.tsx` value memoized; `NotificationContext.tsx` callbacks + value memoized; `App.tsx` onSelectPage → stable NOOP, handleSettingsClose → useCallback; 4 route components → `export default React.memo()`. SSE remount guard verified (NotificationProvider stays above Routes). |
| **D.12 P0** | ✅ Done | `@mui/material@9.2.0` + `@mui/icons-material@9.2.0` + Emotion installed. `theme.ts` created as `themeObj(mode)` factory (yt-diff pattern — no `colorSchemes`, no `cssVariables`). `App.tsx` wraps in `<ThemeProvider theme={appliedTheme}>` + `<Box sx={{ bgcolor: "background.default" }}>`. `App.css` deleted. Body radial gradients removed from `index.css`. |
| **D.12 P2** | ✅ Done | `ConfirmModal.tsx` → MUI Dialog (same props API, removes hand-rolled focus/ESC/backdrop). `InfoModal.tsx` → MUI Dialog + Alert. `CreateSeriesDialog.tsx` (new, 280 lines) and `CreateChapterDialog.tsx` (new, 280 lines) extracted from `Dashboard.tsx` and `SeriesDetails.tsx` — MUI Dialog with internal form state, key-based remounting. |
| **D.12 P1** | ✅ Done | Nav bar → MUI `AppBar position="sticky"` + `Toolbar variant="dense"` (48px) + `IconButton` (DarkMode/LightMode/Settings) + `Badge` (QueueManager/NotificationCenter). |
| **D.12 P8** | ✅ Done | `Auth.tsx` → MUI `Container maxWidth="xs"` + `Card` + `TextField` + `Button` + `Alert`. Form inputs, select, and error display all MUI. |
| **D.12 P5** | ✅ Done | `SettingsModal.tsx` → MUI `Dialog` + `DialogContent dividers` (D.2 overflow auto-fixed). `Grid v2 size={{ xs: 12, sm: 6 }}` layout. Native `<select>` elements → MUI `FormControl` + `Select` + `MenuItem`. Saves via PUT `/api/settings`. |
| **D.12 P4** | ✅ Done | Dashboard cards → MUI `Card` + `CardMedia` + `CardContent` + `CardActions`. Language/direction → `Chip` badges. Edit/delete → MUI `IconButton` with `EditIcon`/`DeleteIcon`. Grid via `Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}`. "New Series" → MUI `Button variant="contained" startIcon={<AddIcon />}`. |
| **D.1** | ✅ Done (subsumed by P4) | "Cover Image URL" field removed from Create/Edit dialogs — gone when dialogs were extracted to MUI. |
| **D.2** | ✅ Done (subsumed by P5) | Settings modal overflow fixed by MUI `DialogContent dividers` — scrollable inner content, no window scrollbar. |
| **D.3 partial** | 🟡 Chapter cards restyled but metadata enrichment pending | Import button text shortened to "Import Chapter (ZIP)". Buttons converted to MUI `Button` with `startIcon`. Card spacing reduced. Rich metadata (language pair, model info, context memory status) not yet added. |
| **D.13** | ✅ Done (subsumed by P2+P8) | ConfirmModal/InfoModal → MUI Dialog with proper focus trap and ARIA. ToastContext value memoized (D.14). SafeFetch 401-only auto-logout preserved. |
| **Theme + CSS** | ✅ Done | **Deviation from plan**: yt-diff design patterns adopted retroactively. `MuiPaper backgroundImage: "none"` + conditional `boxShadow`. `MuiTableCell` border override. `MuiTable defaultProps size="small"`. Custom scrollbar (6px, dark). All `backdrop-filter`/glass/transparency removed — solid backgrounds everywhere. Pixiv palette applied to `:root.light` CSS vars. nHentai dark mode palette (#0d0d0d background). Button hover backgrounds made 2.4× more visible. Nav bar + series container + chapter grid padding/margins reduced ~25–40%. All 4 barrel MUI imports converted to direct-path (tree-shakeable). |
| **Back/action buttons** | ✅ Done | "← Back to Library/Series" + "Add Chapter" + "Edit Series" + "Delete Series" + "Import/Export/Upload" all converted to MUI Button components with `startIcon`. `mb-8` dead wrapper divs removed (32px wasted margin). |

### Resume from here

| Item | Reason |
|------|--------|
| **D.4** (Dashboard sorting) | Inputs are now MUI Button/Select; backend pagination (D.9) should precede sorting by arbitrary fields. |
| **D.5** (Reader full-reload fix) | Reader is excluded from coverage; will fix alongside Phase 7. |
| **D.6** (UploadContext persist) | Needs app-level context (new provider). Deferred to follow D.14 memoization pattern. |
| **D.7** (User management modal) | New component. Lowest priority among remaining D items. |
| **D.9** (Infinite scroll) (will do this later, skip for now) | Requires backend pagination support (`GET /api/series?page=&size=`). Backend dependency. |
| **D.10** (Resolved model display) | Client-side `resolveModel(chain)` utility planned but not yet implemented. Backend enrichment coming later. |
| **D.11** (Model override UX) | Builds on D.10. Accordion/Tabs redesign deferred. |
| **D.3 rich metadata** | Language pair, model info, context memory badges on chapter cards — not yet added. |
| **D.12 P6** (Stacked toasts) | `ToastContext.tsx` still uses manual rendering. Conversion to stacked MUI Snackbar deferred. |
| **D.12 P3** (Queue Manager → Table) | Still styled with inline elements. MUI Table conversion deferred. Phase A behavior contract documented in migration plan. |
| **D.12 P7** (Reader) | 5292-line component, highest risk. JSX swap + 7.4.1/7.4.2 with tests deferred. |
| **D.12 P9** (CSS cleanup) | index.css still ~1800 lines. Cleanup happens after all MUI phases complete. |
| **D.15** (Mobile) (will do this later, skip for now) | Stretch goal. |

### Design decisions with rationale

1. **MUI v9, not v7**: The plan originally pinned `@mui/material@^7.x` to match React 19 + TypeScript 6. Audit found v9.2.0 is current stable with TS 6 fixes. Switched before Phase 0 setup.
2. **`themeObj(mode)` factory, not `colorSchemes` + `cssVariables`**: The `colorSchemes` approach used `data-mui-color-scheme` attribute selectors that broke the dark background (light mode won when the attribute was missing). The yt-diff project uses the simpler `createTheme({ palette: { mode } })` factory with `useMemo` — battle-tested, no CSS variable fragility. Adopted this pattern.
3. **`<Box bgcolor="background.default">` not `CssBaseline`**: CssBaseline + `cssVariables` required a fragile inline script to set `data-mui-color-scheme`. Replaced with explicit `Box` background. Same approach as yt-diff.
4. **Key-based Dialog remount instead of useEffect state sync**: MUI Dialogs transition out slowly in jsdom. Using `key={editingSeries?.id ?? 'new-${counter}'}` forces clean remount on mode change, eliminating `set-state-in-effect` lint violations. Added `createCounter` state per dialog.
5. **Toasts stay stacked, not single-queue**: Phase A bugfix #3 was "missed notifications for fast events" — a single Snackbar queue would regress this. Decision: keep current multi-toast stacking. MUI conversion to stacked Snackbars planned for Phase 6.
6. **Queue Manager → MUI Table, not Cards/DataGrid**: `@mui/x-data-grid` is a separate large dependency. Cards in a 360px dropdown waste space. Resolved to `Table size="small"` in a right-anchored `Drawer` (Phase 3).
7. **D.10 client-side, not a new endpoint**: Adding `GET /api/chapters/{id}/resolved-settings` would violate the "UI only" constraint. Frontend will resolve the global→series→chapter chain via a `resolveModel(chain)` utility. Backend enrichment planned as a separate item.
8. **Reader 7.4.3 deferred to backend workstream**: The redo-region "create new layer" fix requires backend changes. 7.4.1 (split redo spinner) and 7.4.2 (disable Redo-OCR on TL layer) are frontend-only and ship with Phase 7.**

### ✅ Checkpoint D — UI Polish

**Manual checks:**

1. Create Series → verify no "Cover Image URL" field
2. Open Settings → verify modal doesn't overflow, has internal scrollbar
3. Open a chapter → verify header shows language, direction, page count, model info
4. Upload 5 pages → navigate to Series page mid-upload → verify upload widget persists
5. In Reader: navigate between pages → verify smooth transition without full reload
6. Dashboard: toggle sort options → verify order changes
7. Toggle dark/light mode → verify both themes look polished (MUI theme switch)
8. Click username → verify user profile modal opens with avatar, password change, session list
9. Add 50+ series → scroll Dashboard → verify more series load dynamically
10. Open chapter/series settings → model picker should show resolved model name next to `--Inherit--` (e.g., `google/gemini-2.5-flash (global)`)
11. Verify model overrides show a clear hierarchy and "Reset to Default" works
12. Verify all major components render as MUI components (buttons, dialogs, inputs, cards) — no vanilla HTML elements for interactive controls
13. Open React DevTools → check that Dashboard doesn't re-render when Reader state changes (D.14)
14. Visit `/mobile` on a phone-width viewport → upload → verify progress bar → export result

**🔒 Quality Gate** (run before manual checks):

```bash
# Frontend (all D-phase changes are frontend)
cd frontend && npm run lint && npm run test:coverage && npm run build
```

---

## Phase E — Backend Resilience

### E.1 Cross-Provider Failover

**Files**: new `ProviderChain.py` (worker), `config.py`

- Create an abstract provider interface that wraps cloud AI calls
- When all models within a provider fail (rate limit, timeout, 500), fall through to the next provider in a configurable priority list
- Priority chain: configured primary → OpenRouter → DeepSeek → Gemini → local fallback
- Add direct DeepSeek API support

### E.2 Strict HTTP Timeouts

**Files**: all cloud LLM call sites in worker

- Set `connect_timeout=10s`, `read_timeout=45s` for all outbound HTTP requests
- On `TimeoutError`, trigger the failover chain from E.1
- Log timeout events with the provider + model + duration for debugging

### E.3 Move Cost Tracking from Filesystem to Database

**Files**: worker `rq_tasks.py` / cost utilities, `JobCoordinatorService.java`, new DB migration

- **Current problem**: Costs are stored in `costs.json` files under `data/worker/rendered_cache/`. This adds filesystem I/O overhead on every job completion, is fragile (no transactions, no backup), and can't be queried.
- **Fix**:
  - Add a `costs` table (or `job_costs` / `layer_costs` columns) in PostgreSQL to store per-job and per-layer cost breakdowns
  - Worker should POST cost data to the backend API (alongside the existing status callback) instead of writing to `costs.json`
  - Backend `InternalJobController` or `JobCoordinatorService` persists costs to DB on job completion
  - Update `ChapterExportService` to read costs from DB instead of `costs.json`
  - Keep a brief transition period where both sources are checked (DB preferred, `costs.json` fallback)
  - Once migration is verified, remove the filesystem cost storage entirely
- **Benefits**: queryable cost analytics, survives container restarts, no filesystem coupling

### E.4 Remove Worker `rendered_cache` QA Images

**Files**: `render.py`, `qa.py`, Docker volume config

- **Current problem**: All images rendered for QA are saved to `data/worker/rendered_cache/`. This is no longer needed since rendered images are already stored in MinIO and can be viewed via the MinIO web GUI.
- **Fix**:
  - Remove the local file writes in `render.py` / `qa.py` that save to `rendered_cache/`
  - The rendered images in MinIO (`rendered/{imageId}.png`) serve as the single source of truth
  - Remove the `rendered_cache` volume mapping from `docker-compose.yml` (or repurpose it for truly temporary processing only)
  - Add cleanup logic: on worker startup, delete any stale files in `rendered_cache/` older than 24h
- **Note**: `costs.json` files in `rendered_cache/` are addressed separately in E.3

### E.5 Chapter Export Cleanup

**Files**: `ChapterExportService.java`, new `ExportCleanupService.java`

- **Current problem**: Exported chapter ZIPs are cached in MinIO under `exports/<hash>.zip` (added in the bugfixes plan) but there is no way to clean up old exports (see [screenshot](../examples/no-way-to-clean-up-old-chapter-exports.png)). Over time, this accumulates stale ZIP files.
- **Fix**:
  - Add a scheduled cleanup service (`@Scheduled` or manual trigger) that:
    1. Lists all objects in the `exports/` MinIO prefix
    2. Deletes ZIPs older than a configurable retention period (default: 7 days)
    3. Invalidates the hash in the DB/cache so the next export regenerates
  - Add a "Clear Exports" button in the admin/settings UI (or per-series)
  - Add a per-chapter "Re-export" button that forces regeneration (deletes cached ZIP + rebuilds)
  - Consider showing export cache size in the settings/admin panel

### ✅ Checkpoint E — Resilience

**Automated tests:**

- `test_provider_chain.py`: mock primary provider 500 → verify fallback to secondary
- `test_provider_chain.py`: mock timeout → verify failover triggers
- `JobCoordinatorServiceTest`: complete a job with costs → verify costs persisted to DB
- `ExportCleanupServiceTest`: create old exports → run cleanup → verify deleted

**Manual checks:**

1. Set primary OCR provider to an invalid key → run pipeline → verify it fails over to next provider in chain
2. Set very low timeout (1s) → verify timeout is logged and failover triggers
3. Run a full pipeline → verify no `costs.json` written to `rendered_cache/` → verify costs appear in DB
4. Run a full pipeline → verify no QA images saved to `rendered_cache/` → verify rendered images accessible in MinIO GUI
5. Export a chapter → wait past retention → verify cleanup removes the old ZIP → re-export regenerates it

**🔒 Quality Gate** (run before manual checks):

```bash
# Backend (E.3, E.5 changes)
cd backend && mvn spotless:apply && mvn clean verify -DforkCount=1 -DreuseForks=true
# Worker (E.1, E.2, E.4 changes)
cd unified-workers && ruff check . && ruff format --check . && pyright . && pytest tests/ --cov=. --cov-report=xml
```

---

## Phase F — ML Model & Prompt Upgrades

*Independent of other phases. Can be parallelized.*

### F.1 YOLO Model Upgrade

**Files**: worker model download scripts, `bubble_detector.py`

- Current model `juithealien/manga109-segmentation-bubble` (yolo11n) is abandoned and only detects text bubbles
- Evaluate successors from [Model Upgrade Plan](../docs/model_upgrade_plan.md)
- Goal: detect SFX regions, narration boxes, and other text containers beyond speech bubbles

### F.2 OCR VLM Prompt Improvements

**Files**: `ocr.py` (VLM prompt templates)

- Classify text types at OCR stage: reject SFX, gibberish, author handles, already-English text
- When doing Re-OCR or Redo-Region-TL with a VLM, inject QA feedback to help the model:
  - If manually triggered by user → "user rejected previous result, do a clean redo"
  - If triggered by QA → include what QA didn't like

### F.3 QA Prompt Enhancements

**Files**: `qa.py`, `qa_re_ocr.py`

- Allow QA to directly update text if it has a better translation
- Reject SFX/gibberish (hide elements, never delete)
- Trigger re-OCR or re-TL for specific bad regions (via `redo-region-*` queues)
- QA output must be strictly better than input — never send back the same text
- One pass only, no loops (prevent re-OCR → re-TL → re-OCR cycles)

### F.4 Translation Prompt Improvements

**Files**: `translation.py` (prompt templates)

- Review and improve [current prompts](../docs/models_and_prompts.md)
- Anti-romanization already handled in critical bugfixes Phase 4.2
- Additional improvements: tone consistency, character name preservation, context injection

### ✅ Checkpoint F — ML Upgrades

**Manual checks:**

1. Upload a page with SFX text → verify OCR doesn't try to translate SFX
2. Run QA on a page with known bad translations → verify QA proposes fixes, not just flags
3. Compare bubble detection accuracy between old and new YOLO model

**🔒 Quality Gate** (run before manual checks):

```bash
cd unified-workers && ruff check . && ruff format --check . && pyright . && pytest tests/ --cov=. --cov-report=xml
```

---

## Phase G — Concurrency & Slot Allocation ✅ Completed

To maximize throughput and prevent heavy local GPU tasks (like OCR) from blocking light, fast cloud API tasks (like translation), we implemented a dual-slot concurrency model.

### G.1 Dual-Slot Dispatcher

**Files**: `WorkerDispatcherService.java`, `WorkerDispatcherServiceTest.java`

- Split the flat `QUEUES` list into `HEAVY_QUEUES` and `LIGHT_QUEUES`.
- Refactored `dispatchJobs()` to call `dispatchFromSlot()` independently for each slot type.
- A `429 Too Many Requests` response from a worker on a heavy job dispatch no longer blocks light job dispatch, and vice versa.

### G.2 Configurable Worker Slots

**Files**: `health_server.py`, `test_health_server.py`

- Removed the legacy `queue:region-redo` queue.
- Added `MAX_HEAVY_SLOTS` and `MAX_LIGHT_SLOTS` environment variables (defaulting to 1 heavy slot, and the remainder of `CONCURRENT_JOBS` as light slots).
- Slot checks now use configurable limits rather than a hardcoded capacity.
- Updated the capabilities endpoint to report slot allocation info.

### G.3 Deployment & Documentation

**Files**: `.env.example`, `docker-compose.yml`, `configuration_guide.md`, `slot-allocation.md`

- Passed new environment variables `MAX_HEAVY_SLOTS` and `MAX_LIGHT_SLOTS` to the worker container in `docker-compose.yml`.
- Added detailed slot allocation documentation to `configuration_guide.md` and created an independent `slot-allocation.md` guide.

### ✅ Checkpoint G — Concurrency & Slot Allocation

**Verification:**

1. Run backend tests: `WorkerDispatcherServiceTest` (12/12 pass) — verifies heavy/light independent dispatch.
2. Run worker tests: `test_health_server.py` (10/10 pass) — verifies slot limit parsing and capabilities reports.

---

## Summary: Files Changed

| Phase | File | Change |
|-------|------|--------|
| A.1 | `SseService.java` | Add `job_update`, queue/job-level event types |
| A.1 | `JobCoordinatorService.java` | Emit SSE on job state transitions |
| A.1 | `JobController.java` | Emit SSE on per-job pause/resume/retry/delete |
| A.1 | `InternalJobController.java` | Emit SSE on status update |
| A.2 | `useSSE.ts` | Add `job_update` listener, 30s heartbeat fallback |
| A.3 | `QueueManager.tsx` | Redesign with SSE, status dots, per-job controls |
| B.1 | `Reader.tsx` | Subscribe to SSE for layer auto-refresh |
| C.1 | `PageService.java`, `pom.xml` | WebP thumbnails with bicubic interpolation |
| C.2 | `Dashboard.tsx`, `SeriesDetails.tsx` | Use thumbnail URLs for previews |
| C.3 | `PageService.java`, `PageController.java` | Async thumbnail generation |
| D.1 | `Dashboard.tsx`, `SeriesController.java` | Remove cover image URL field (subsumed by MUI dialog extraction) |
| D.2 | `SettingsModal.tsx` | Fix modal overflow (subsumed by MUI Dialog dividers) |
| D.3 | `SeriesDetails.tsx`, `ChapterGallery.tsx` | Chapter cards restyled (MUI Buttons, compact layout); rich metadata deferred |
| D.4 | `Dashboard.tsx` | Sorting dropdown (deferred — backend pagination first) |
| D.5 | `Reader.tsx` | Fix page switch reload (deferred to Phase 7) |
| D.6 | `App.tsx` / `UploadContext.tsx` | Persist upload widget (deferred — needs UploadContext) |
| D.7 | `[NEW] UserManagement.tsx` | User profile with avatar, sessions, API keys stub (deferred) |
| D.8 | `index.css` → `theme.ts` | nHentai dark + Pixiv light palettes applied via MUI theme + :root.light CSS vars ✅ |
| D.9 | `Dashboard.tsx`, `SeriesDetails.tsx` | Lazy loading / infinite scroll (deferred — needs backend) |
| D.10 | `SettingsModal.tsx`, model picker components | Show resolved model names with inheritance source (client-side util deferred) |
| D.11 | `SettingsModal.tsx`, model picker components | Model override UX redesign (deferred) |
| D.12 | All `.tsx` components, `package.json` | Migrate to MUI **v9**: P0 ✅ · P2 (modals) ✅ · P1 (nav) ✅ · P8 (auth) ✅ · P5 (settings) ✅ · P4 (dashboard cards) ✅ · P6/P3/P7/P9 deferred |
| D.13 | `SeriesDetails.tsx`, `utils.ts`, etc. | Global toast notifications (subsumed by ConfirmModal→Dialog, existing useToast pattern) ✅ |
| D.14 | `App.tsx`, `ToastContext.tsx`, `NotificationContext.tsx`, 4 route components | Render-hygiene foundation ✅ |
| D.15 | `[NEW] MobileApp.tsx` | tl-hub Lite (deferred — stretch goal) |
| E.1 | `[NEW] ProviderChain.py`, `config.py` | Cross-provider failover |
| E.2 | Worker HTTP call sites | Strict timeouts |
| E.3 | Worker cost utils, `JobCoordinatorService.java` | Move cost tracking from `costs.json` to PostgreSQL |
| E.4 | `render.py`, `qa.py`, `docker-compose.yml` | Remove `rendered_cache` QA image writes |
| E.5 | `[NEW] ExportCleanupService.java` | Scheduled cleanup of stale chapter export ZIPs |
| 0.1 | `ci-python.yml`, `pyproject.toml`, `pyrightconfig.json` | Add ruff + pyright static analysis to Python CI |
| F.1 | `bubble_detector.py` | YOLO model upgrade |
| F.2 | `ocr.py` | VLM prompt improvements |
| F.3 | `qa.py`, `qa_re_ocr.py` | QA prompt enhancements |
| F.4 | `translation.py` | Translation prompt improvements |
| G.1 | `WorkerDispatcherService.java`, `WorkerDispatcherServiceTest.java` | Split queues into heavy/light, refactored independent dispatch |
| G.2 | `health_server.py`, `test_health_server.py` | Configure heavy/light slots with env vars, capabilities endpoint |
| G.3 | `.env.example`, `docker-compose.yml`, `configuration_guide.md` | Document and configure slot allocation parameters |
| G.3 | `docs/slot-allocation.md` | Independent documentation file detailing slot behavior |
