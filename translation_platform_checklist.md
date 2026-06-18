# Manga Translation Platform Implementation Status

This checklist maps the **Development Order** defined in [Manga_Translation_Platform_Specification_v4.md](file:///home/sagnik/Projects/docker-composes/manga-library/Manga_Translation_Platform_Specification_v4.md) against the codebase, noting what is complete, partially implemented, and what remains.

---

## 🛠️ Infrastructure & Foundation (Phases 0, 5, 6)

- [x] **1. PostgreSQL Schema (Full)**
  - Schema in [init.sql](file:///home/sagnik/Projects/docker-composes/manga-library/database/init.sql) fully matches Phase 6.
  - Supports authorization, series/volume/chapter hierarchies, panels, OCR regions, conversations, translations, layers, layer elements, and search index.
- [x] **2. MinIO Integration & Storage**
  - Integrated via `MinioService` in Spring Boot backend.
  - Bucket structures defined, saves uploaded file originals to `originals/`.
- [x] **3. Spring Boot API Skeleton**
  - Handles auth (JWT setup), uploading pages, creating entity trees, and coordinating Redis job pipelines.
- [x] **4. Docker Compose Setup**
  - Configured in [docker-compose.yml](file:///home/sagnik/Projects/docker-composes/manga-library/docker-compose.yml).
  - *Note:* The 5 separate ML/stub workers were consolidated into a single unified worker container (`manga-worker` in [unified-worker-v2/app.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-worker-v2/app.py)), listening to all 5 queues sequentially.
- [x] **5. React Gallery & Viewer (Basic)**
  - Implemented in [App.tsx](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/App.tsx).
  - Supports dashboard workspace, series/chapter/pages creation, image viewing with SVG overlays.

---

## 👁️ Layout & OCR Pipeline (Phases 1, 2)

- [x] **6. Panel Detection Worker**
  - OpenCV morphology-based contours panel segmentation logic complete.
  - Correctly sorts panels in RTL grid order and returns coordinates.
- [x] **7. OCR Worker Pipeline**
  - Multi-engine pipeline: PaddleOCR (PP-OCRv5 Mobile) → EasyOCR fallback → MangaOCR refinement for CJK regions.
  - **PaddleOCR language is now dynamic**: the backend passes `sourceLanguage` (from `series.original_language`) in the Redis job payload; the worker lazy-inits a per-language reader on first use and caches it.
  - Supports `ja` (japan), `zh`/`zh-tw` (chinese_cht), `zh-cn` (ch), `ko` (korean), `en` — unknown codes fall back to `japan`.
  - Character regex-based language detector per region (`ja`, `zh-TW`, `en`).
  - Correctly maps regions into panels based on overlap; reading direction is applied when sorting bubble reading order within each panel.
  - *Remaining:* Backend (`OcrService` in Spring Boot) must be updated to include `sourceLanguage` and `readingDirection` in the enqueued Redis job payload.
- [x] **8. OCR Overlay in Viewer**
  - Interactive SVG overlay displays panel boundaries and OCR boxes.
  - Clickable regions dynamically display details in a sidebar inspector.
- [/] **9. Reading Order Detection**
  - *Status:* **Partially Done**.
  - **Done:** Bubble sorting within panels now respects `readingDirection` from the job payload (`rtl`, `ltr`, `ttb`) — no longer hardcoded to RTL.
  - *Remaining:* `detect_panels` still sorts panels using a hardcoded RTL row-then-column order. It needs to read and apply the series' `reading_direction` dynamically so LTR (left-to-right column ordering) and TTB (top-to-bottom strip) panels are ordered correctly too.
- [x] **10. Conversation Grouping**
  - *Status:* **Complete**.
  - Groups OCR regions in each panel into conversation groups based on spatial proximity heuristics and reading order.
- [x] **11. Layout Analysis Worker**
  - *Status:* **Complete**.
  - Replaced the layout stub. Classifies each region as `speech`, `narration`, `sfx`, `caption`, or `sign` based on geometry and position relative to the panel.

---

## 🤖 AI Translation & Layers (Phases 3, 4)

- [x] **12. Translation Context Assembler**
  - *Status:* **Complete**.
  - **Done:** `JobCoordinatorService` auto-queues a `translation` job after every `layout` callback. The worker fetches all OCR regions from the backend (including text, detected language, bounding boxes, panel reading order, and bubble reading order) and assembles them into a structured JSON batch prompt.
  - Context formatting preserves the visual and dialogue flow (splits pipe-separated dialogue histories into formatted dialog lists instead of flattening them).
  - Integrates narrative context compilation (summary guidelines, character roster) dynamically.

- [x] **13. VLM Translation Worker**
  - *Status:* **Complete**.
  - **Done:**
    - **NVIDIA NIM VLM Support:** Integrates free hosted VLM endpoints from build.nvidia.com. Supports VLM models such as `nvidia/nemotron-nano-12b-v2-vl` or `microsoft/phi-4-multimodal-instruct`.
    - **Selective VLM Activation:** VLM vision translation is dynamically triggered if environment variables (`USE_VLM_TRANSLATION`, `VLM_MODEL` or `NVIDIA_VLM_MODEL` with keys) are populated.
    - **Prompt Enrichment:** Prompts are enriched with `regionType`, `conversationGroup`, and `speakerLabel` properties to leverage visual and narrative continuity.
    - **Hardened Validation:** Rejects translations with CJK character leaks, pathological string lengths, or repetitive word loops.

- [x] **14. Translation Overlay in Viewer**
  - *Status:* **Complete**.
  - **Done:**
    - `showTranslations` toggle switches overlay rendering.
    - SVG `<foreignObject>` overlays center typeset text with white masking backgrounds.
    - Complete layers visibility toggle, z-order sorting, and inspector properties popover implemented.

- [x] **15. Layer Editor**
  - *Status:* **Complete**.
  - **Done:**
    - Full backend `LayerController` handles CRUD operations for `layers`, `layer_elements`, and `layer_edit_history`.
    - Custom UI fields allow editing of font size, family, coordinates (X, Y), bounds (Width, Height), rotation angle, auto-sizing, and visibility.
    - **Interactive Drag & Resize:** Added 4 corner handles and boundary overlays inside the editor canvas SVG to allow smooth drag-to-move and drag-to-resize operations. It pushes a single original state to the undo/redo stack on mouse up, and executes a silent, alert-free save to the server.

- [x] **16. Text Fitting**
  - *Status:* **Complete**.
  - **Done:**
    - Client-side offscreen canvas measurement engine dynamically fits text into bounding boxes, adjusts line wraps, scales font sizes, and reports overflow flags.
    - **Character Wrapping Fallback:** Falls back to splitting words character-by-character if a single long word exceeds the bounding box's maximum width.
    - **Overflow Outline Indicator:** Displays a warning red dashed outline around any text layer that overflows its box constraints in edit mode.
    - **Minimum Font Floor Reduction:** Reduced the hardcoded minimum font size floor from `10px` to `6px` in `fitText.ts` to accommodate small text bubbles.

- [x] **17. Undo/Redo System**
  - *Status:* **Complete**.
  - **Done:** Client-side undo/redo stacks track state modifications and are bound to `Ctrl+Z` / `Ctrl+Y` shortcuts.

- [ ] **18. SFX Rendering Path**
  - *Status:* **Todo**.
  - **Plan:** Support styling and placing sound effects near their original coordinates on an SFX-specific layer.

---

## 🔍 Search, Exports & Advanced (Phases 7, 8, 9, 10)

- [ ] **19. Meilisearch Integration**
  - *Status:* **Todo**.
  - *Remaining:* Spin up Meilisearch service, implement backend `search-service` for indexing and querying.

- [x] **20. Export Engine (Client-side)**
  - *Status:* **Complete** — implemented in [Reader.tsx](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/Reader.tsx) via `jszip`.
  - **Export Page (PNG):** Flattens the base page image + all visible layer element masks + translated text onto a single canvas and triggers a PNG download.
  - **Export Layer Project (ZIP):** Produces a structured ZIP archive containing:
    - `original.png` — unmodified page scan.
    - `mask.png` — white inpaint mask for all speech bubble regions (transparent background, useful for inpainting pipelines).
    - `translation.png` — rendered translated text only on a transparent background.
    - `project.json` — full layer/element metadata (positions, fonts, text, visibility) for round-trip reimport.
  - Export buttons live under a dedicated **Export** section in the right-side panel (Page View).
  - *Note:* Exported canvas size matches the original image resolution (`imageDims.w × imageDims.h`), computed dynamically on `<img>` load.

- [ ] **20a. Project Import**
  - *Status:* **Todo** — add as a follow-up to the Export engine.
  - **Plan:** Accept a `project.json` (or the full ZIP) and hydrate layers + elements back into the viewer, restoring the full editing state. This enables sharing projects between users and round-tripping edits.
  - *Revisit when:* Export is battle-tested and a sharing/collaboration flow is planned.

- [ ] **21. Chapter Summary Generation**
  - *Status:* **Todo**.
  - *Remaining:* Summarization pipeline executing on chapter completion.
- [ ] **22. Character Memory System**
  - *Status:* **Todo**.
  - *Remaining:* Tracking character rosters across page translations.
- [ ] **23. Inpainting**
  - *Status:* **Todo**.
  - *Note:* The `mask.png` produced by the Export Engine (item 20) is the natural input artifact for the inpainting pipeline — white-filled speech bubble rects on transparent background, ready for SD/ComfyUI inpainting.
- [x] **24. Local Model Support**
  - *Status:* **Complete** (Supports custom Ollama or LMStudio endpoints).

---

## 🛠️ Pipeline Improvement Plan (Carryover Tasks)

- [x] **25. LLM Prompt Enrichment for Standard LLM Batch Translation**
  - *Status:* **Complete**.
  - **Done:**
    - Both VLM vision prompt (`translate_vlm_vision`) and standard LLM batch prompt (`translate_batch_llm`) are fully enriched with `regionType`, `conversationGroup`, and `speaker` properties. Prompt templates are updated with instructions for standard LLMs.

---

## 🚀 Specification v4.0 Additions

- [x] **26. Database & Chapter Numbering Rules**
  - [x] Alter PostgreSQL schema: Change `chapters.chapter_number` to `NUMERIC` or `DOUBLE PRECISION`.
  - [x] Enforce backend unique check on `(series_id, chapter_number)`.
  - [x] Implement deletion gap insertion rules and moving/renumbering validation.
  - [x] Support Ascending/Descending chapter list sorting toggling in the frontend.

- [x] **27. Frontend Double-Sidebar Layout**
  - [x] Restructure layout: Create Left Sidebar for controls (zoom, overlays, navigation), Center Canvas for editor, Right Sidebar for details inspector.
  - [x] Update Nav Bar to modern Glassmorphism styling.
  - [x] Set browser window title dynamically based on series/chapter/page details.
  - [x] Save viewer toggle and zoom preferences in `localStorage` across page reloads.

- [/] **28. Frontend Editor & Canvas Enhancements**
  - [x] Backend Thumbnailer integration: Save downscaled thumbnail copies to MinIO and use them for quick gallery rendering.
  - [x] Fix Zoom Sync: Update scale indicator correctly when "Fit Width" or "Fit Height" is used.
  - [x] Fix scale-independent bounds rendering: Bounding boxes and borders must scale without displacement at <100% scales.
  - [ ] Add manual text box creation and deletion/dismissal buttons in the canvas overlay [Not right now]
  - [ ] Implement Eye-Dropper tool to sample background colors from base image to be used [Not right now]

- [/] **29. Valkey & Pipeline Optimizations**
  - [x] Update `docker-compose.yml` to replace `manga-redis` with `valkey/valkey:8-alpine`.
  - [ ] Implement optional Spring cache abstraction with PostgreSQL as fallback to remove Valkey dependency for internal job queue [Not right now]
  - [x] Configure parallel processing pipelines for layout analysis and translation stages (leaving OCR and local LLMs sequential).

- [ ] **30. Advanced VLM Translation & QA**
  - [ ] Add support for Single-Pass Multimodal VLM (merging layout, grouping, and translation).
  - [ ] Implement headless Canvas/Node rendering on worker side to output final images.
  - [ ] Implement final VLM-based Quality Assurance review pass on rendered images to verify typesetting fit.
  - [ ] Add test configurations for comics, documents, web novels, and screenshots.

- [x] **31. Remote Machine Learning Integration**
  - [x] Support remote Ollama and remote workers, configurable though env vars in docker compose.
  - [x] Set up signed MinIO URL delivery for remote API processing.

- [x] **32. Repository Cleanup & Publishing**
  - [x] Audit and remove all hardcoded API keys.
  - [x] Purge references to nHentai endpoints.
  - [x] Set up cloud-based Docker image build triggers instead of local host-side builds.
