# Manga Translation Platform (Immich-Inspired)

## Product & Technical Architecture Specification v4.0

> **Changelog from v3.0:**
> - **PostgreSQL Database**: Support for decimal chapter numbers, unique ordering rules, and sorting.
> - **Frontend UI/UX**: Redesigned layout (left side control bar, right side OCR/region bar), thumbnailer service, page title updates, dynamic scale values, scale-independent bounds, localStorage state persistence, manual text box creation/dismissal, and eye-dropper color tool.
> - **Valkey & Job Queues**: Valkey replacing Redis as broker, parallel pipeline execution (while keeping OCR/local LLMs sequential), and path to database-driven internal broker queueing.
> - **Advanced AI Pipeline & VLM QA**: Single-pass multimodal VLM translation, headless worker-side image rendering, and a VLM-based final visual typesetting quality check.
> - **Remote ML Integration**: Remote Immich-style ML and remote Ollama URLs with signed MinIO URL delivery.
> - **Repository Hygiene**: Repo clean-up, removing nHentai references, API key sanitization, and cloud-based image building.

---

*For the dynamic language and reading direction configurations, see [Manga_Translation_Platform_Specification_v3.md](file:///home/sagnik/Projects/docker-composes/manga-library/Manga_Translation_Platform_Specification_v3.md). For the foundational architecture, refer to [Manga_Translation_Platform_Specification_v2.md](file:///home/sagnik/Projects/docker-composes/manga-library/Manga_Translation_Platform_Specification_v2.md).*

---

## 1. Database & Chapter Numbering Rules

### Decimal Chapter Numbers
Currently, `chapter_number` is typed as an `INT` in PostgreSQL (`chapters` table). To support decimal sub-chapters (e.g. `1.1`, `1.45`, `1.5`), the database schema must be altered:
- Modify `chapters.chapter_number` to `NUMERIC(6, 2)` or `DOUBLE PRECISION` to preserve precise decimal positions.

### Unique Constraints & Ordering
1. **Duplicate Chapter Block**: The database enforces a `UNIQUE(series_id, chapter_number)` constraint. When creating or editing a chapter, the system will return a validation error if a duplicate chapter number is submitted for the same series.
2. **Deletion Gaps**: If chapters `1`, `2`, and `3` exist, deleting chapter `2` leaves a gap (`1`, `3`). The system permits adding a new chapter `2` back into this gap.
3. **Move / Renumbering Boundaries**: 
   - Moving/renumbering chapter `3` to `2` is permitted (since `2` is free).
   - Moving/renumbering chapter `3` to `1` is blocked because chapter `1` already exists (preventing duplicate key exceptions).
4. **Sorting Direction**: The series details view in the frontend will allow toggling the sorting of chapters between:
   - **Ascending** (default): chapter `1.1` -> `1.5` -> `2` -> `3`.
   - **Descending**: chapter `3` -> `2` -> `1.5` -> `1.1`.

---

## 2. Frontend UI/UX Refactoring

### Double-Sidebar Layout
To clean up the crowded workspace interface:
- **Left Sidebar**: Dedicated to global controls, including:
  - Zoom controls (fit width, fit height, slider, current zoom %).
  - Overlay toggles (show/hide OCR bounding boxes, show/hide translations, layers list).
  - Navigation controls (previous page, next page, chapter navigation).
- **Center Canvas**: The main interactive editor showing the base image, SVG bounds overlay, and typeset text.
- **Right Sidebar**: Inspector panel displaying detailed attributes of the selected region:
  - OCR text and detected language.
  - Translation input box and translation history/notes.
  - Layer properties (font size, font family, position coordinates, auto-size bounds, wrap settings).

### Visual Polish & Branding
- **Nav Bar**: Replaced with a modern, glassmorphic layout using vanilla CSS.
- **Favicon & Logo**: Added custom branding assets for TLHub.
- **Dynamic Window Title**: Update the browser tab/page title dynamically based on the current context: `[TLHub] Series Title - Vol. X Ch. Y Page Z` (removing generic "frontend" title).

### Rendering & Editor Corrections
1. **Thumbnailer Service**: To solve slow gallery loading times, the backend will generate downscaled thumbnails (e.g. max width 300px) when uploading pages. These are saved in `thumbnails/` inside the MinIO bucket and loaded in the workspace gallery instead of the heavy original files.
2. **Zoom Sync**: The zoom scale indicator must accurately sync when the user clicks "Fit Width" or "Fit Height", calculating the relative ratio of the canvas to the browser viewport.
3. **Scale-Independent Bounds**: Fix a bug where SVG panel borders and OCR bounding boxes shift or break alignment at scales less than 100%. Coordinate transformation calculations in `App.tsx` must correctly multiply the bounding coordinates by the active scale.
4. **Persistent Controls**: Save the state of toggles (e.g. `showOcrBoxes`, `showTranslations`, preferred font family, default zoom mode) to `localStorage` so that settings persist across page reloads.
5. **Manual Bounding Box Management**: Add buttons in the toolbar to:
   - Draw/add a manual text box in the editor.
   - Delete/dismiss unwanted OCR bounding boxes (e.g. if they detect noise or background objects).
6. **Eye-Dropper Color Picker**: Add an eye-dropper tool in the translation editor toolbar to allow sample-picking colors directly from the base image. The picked color can be applied to the background mask fill or text color of manual/VLM-generated layers.

---

## 3. Queue & Broker Architecture

### Valkey Transition
The message broker container `manga-redis` is replaced with Valkey (a fully open-source, protocol-compatible drop-in replacement).
- Update `docker-compose.yml` image to `valkey/valkey:8-alpine`.
- Runtimes and environment variables (`REDIS_HOST`, `REDIS_PORT`) continue to function without code modifications due to full protocol parity.

### PostgreSQL Internal Queue (Zero-Broker Alternative)
To simplify deployment footprints, the system defines an optional DB-driven queue engine:
- A new `jobs` table in PostgreSQL tracks job states (`queued`, `processing`, `completed`, `failed`).
- Spring Boot uses standard JPA and triggers callbacks on state changes.
- Python workers fetch jobs using `SELECT ... FOR UPDATE SKIP LOCKED` transactions, eliminating the Valkey container dependency entirely for ultra-lightweight hostings.

### Parallel Processing Pipelines
To speed up multi-page processing:
- When a chapter of 10+ pages is uploaded, translation and layout analysis jobs are executed in **parallel** across workers.
- **Resource Locking**: OCR (PaddleOCR/MangaOCR) and local LLM processes (Ollama/LM-Studio) are flagged as sequential/exclusive queue tasks to prevent GPU/CPU thrashing or hardware-level out-of-memory errors on the self-hosted runner.

---

## 4. Advanced AI & Typesetting QA

### Single-Pass Multimodal Translation
Instead of performing layout classification, OCR merging, and translation sequentially:
- Send the raw image and layout boundaries directly to a capable Multimodal VLM (e.g. Gemini 2.5 Flash / Nemotron-VL).
- The VLM analyses the scene layout, groups panels, and outputs translated dialogue mapping in a single prompt loop, utilizing visual and textual cues together.

### Headless Image Rendering & VLM QA
1. **Worker-side Rendering**: Implement a headless canvas renderer in the Python worker (or backend Node service) to flatten the original page, background masks, and typeset text layers exactly as configured.
2. **Quality Assurance Pass**: Send the final rendered page image to a review VLM:
   - Prompt: "Check if the English text overflows the speech bubbles, overlaps with other text, cuts off at the borders, or is otherwise unreadable. Output a quality score and flag bubbles requiring manual correction."
   - Flags are saved to `layer_elements.overflow` and highlighted in red in the frontend.

### Corpora Diversity
Expand the validation and pipeline testing corpus beyond manga to include:
- Webtoons/Manhwa (vertical scrolling strip layout).
- Western comics (left-to-right grid).
- Text documents, screenshots, and visual novels.
- Social media posts and scanned novels.

---

## 5. Remote Machine Learning Configuration

### Immich-style Remote ML
Support delegating heavy ML workloads to remote servers:
- The worker and backend can be configured with a remote ML URL (`REMOTE_ML_URL` / `OLLAMA_REMOTE_URL`).
- Instead of uploading heavy raw files over API payloads, the backend creates **signed MinIO URLs** with 10-minute expirations.
- The remote worker fetches the image directly from MinIO, processes it, and returns the metadata, keeping payload sizes lightweight.

---

## 6. Repository Cleanup & Publishing

Before publishing the repository, complete the following cleanup operations:
1. **API Key Scrub**: Audit all environment files and code files to ensure no hardcoded API keys exist.
2. **Remove nHentai References**: Purge any test scripts, references, or links to nHentai endpoints.
3. **Cloud Image Builds**: Set up GitHub Actions or automated docker builds to build and push docker images (`manga-backend`, `manga-worker`) to the registry, avoiding local image building steps on the user's host during deployments.
