# Plan: Improvements & UI Redesign

> Priority: **After Critical Bug Fixes** | Depends on: `plan-critical-bugfixes.md` being completed  
> Last updated: 2026-07-12

This plan covers performance improvements, UI redesign, and quality-of-life enhancements from `TODO.md`.

---

## Phase A — SSE Job System Migration

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

---

## Phase B — Reader Auto-Refresh via SSE

### B.1 Reader Layer Auto-Refresh

**Files**: `Reader.tsx`, `useSSE.ts`

- Subscribe to `job_update` events in the Reader
- When a `COMPLETED` event arrives for the current page's `imageId` with type `ocr`, `translation`, `render`, or `qa`:
  - Auto-refresh the layers panel
  - Show a subtle toast: "New layers available — refreshed"
- Remove any existing manual "Refresh Gallery" button dependency

### ✅ Checkpoint B — Reader SSE

**Manual checks:**

1. Open Reader on a freshly uploaded page → watch layers populate in real-time as pipeline completes
2. Open Reader on a page → trigger "Redo OCR" from the detail panel → new OCR layer should appear without manual refresh

---

## Phase C — Thumbnail & Image Serving

### C.1 Upgrade Thumbnail Generation to WebP

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

### C.2 Frontend: Use Thumbnail URLs Everywhere

**Files**: `Dashboard.tsx`, `SeriesDetails.tsx`, `ChapterGallery.tsx`

- Audit all places that display series covers, chapter cover thumbnails, or page previews in gallery view
- Replace any use of `/api/images/{id}/file` with `/api/images/{id}/thumbnail` for preview contexts
- The full `/file` endpoint should only be used in the Reader for full-resolution viewing

### C.3 Move Thumbnail Generation Off the Upload Request Path

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

### ✅ Checkpoint C — Thumbnails

**Automated tests:**

- `PageServiceTest`: generate thumbnail from test PNG → verify output is valid WebP
- `PageControllerTest`: upload image → `GET /thumbnail` → verify `Content-Type: image/webp`
- `PageServiceTest`: upload with async thumbnail → verify `thumbnailStoragePath` is populated within 5s

**Manual checks:**

1. Upload a new page → check MinIO storage → thumbnails should be `.webp` files
2. Open Dashboard → inspect network tab → series covers should load from `/thumbnail` not `/file`
3. Compare visual quality: old JPEG thumbnail vs new WebP thumbnail
4. Upload 40 pages in batch → verify upload response returns quickly (< 2s per page) → thumbnails populate asynchronously

---

## Phase D — Frontend UI Fixes & Redesign

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

### ✅ Checkpoint D — UI Polish

**Manual checks:**

1. Create Series → verify no "Cover Image URL" field
2. Open Settings → verify modal doesn't overflow, has internal scrollbar
3. Open a chapter → verify header shows language, direction, page count, model info
4. Upload 5 pages → navigate to Series page mid-upload → verify upload widget persists
5. In Reader: navigate between pages → verify smooth transition without full reload
6. Dashboard: toggle sort options → verify order changes
7. Toggle dark/light mode → verify both themes look polished
8. Click username → verify user profile modal opens with avatar, password change, session list
9. Add 50+ series → scroll Dashboard → verify more series load dynamically

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

### ✅ Checkpoint E — Resilience

**Automated tests:**

- `test_provider_chain.py`: mock primary provider 500 → verify fallback to secondary
- `test_provider_chain.py`: mock timeout → verify failover triggers

**Manual checks:**

1. Set primary OCR provider to an invalid key → run pipeline → verify it fails over to next provider in chain
2. Set very low timeout (1s) → verify timeout is logged and failover triggers

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
| D.1 | `Dashboard.tsx`, `SeriesController.java` | Remove cover image URL field |
| D.2 | `SettingsModal.tsx` | Fix modal overflow |
| D.3 | `SeriesDetails.tsx`, `ChapterGallery.tsx` | Chapter cards redesign |
| D.4 | `Dashboard.tsx` | Sorting dropdown |
| D.5 | `Reader.tsx` | Fix page switch reload |
| D.6 | `App.tsx` / `UploadContext.tsx` | Persist upload widget |
| D.7 | `[NEW] UserManagement.tsx` | User profile with avatar, sessions, API keys stub |
| D.8 | `index.css` | nHentai dark + Pixiv light palettes |
| D.9 | `Dashboard.tsx`, `SeriesDetails.tsx` | Lazy loading / infinite scroll |
| D.10 | Model override components | Show resolved model names |
| E.1 | `[NEW] ProviderChain.py`, `config.py` | Cross-provider failover |
| E.2 | Worker HTTP call sites | Strict timeouts |
| F.1 | `bubble_detector.py` | YOLO model upgrade |
| F.2 | `ocr.py` | VLM prompt improvements |
| F.3 | `qa.py`, `qa_re_ocr.py` | QA prompt enhancements |
| F.4 | `translation.py` | Translation prompt improvements |
