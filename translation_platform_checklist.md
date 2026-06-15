# Manga Translation Platform Implementation Status

This checklist maps the **Development Order** defined in [Manga_Translation_Platform_Specification_v2.md](file:///home/sagnik/Projects/docker-composes/manga-library/Manga_Translation_Platform_Specification_v2.md) against the codebase, noting what is complete, partially implemented, and what remains.

See [Manga_Translation_Platform_Specification_v3.md](file:///home/sagnik/Projects/docker-composes/manga-library/Manga_Translation_Platform_Specification_v3.md) for the v3 delta (dynamic OCR language & reading direction).

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
  - *Note:* In the previous conversation, the 5 separate ML/stub workers were consolidated into a single unified worker container (`manga-worker` in [unified-worker/app.py](file:///home/sagnik/Projects/docker-composes/manga-library/workers/unified-worker/app.py)), listening to all 5 queues sequentially.
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

- [/] **12. Translation Context Assembler**
  - *Status:* **Partially Done** (Detailed in [implementation_plan.md](file:///home/sagnik/.gemini/antigravity-ide/brain/6c2955b3-3843-4157-80a4-57c7118f39d4/implementation_plan.md)).
  - **Done:** `JobCoordinatorService` auto-queues a `translation` job after every `layout` callback. The worker fetches all OCR regions from the backend (including text, detected language, bounding boxes, panel reading order, and bubble reading order) and assembles them into a structured JSON batch prompt. The reading order serves as implicit structural context.
  - **Remaining Plan:**
    - Update `InternalJobController.getImageInfo` to compile and pass narrative context to the worker (previous page translation, previous chapter's summary from `chapters.summary_json`, and character rosters).
    - Track `isIntermediateTranslation` when series source language differs from scanlation image source language.
    - Implement cost estimation using character/token counts prior to VLM job dispatch.

- [/] **13. VLM Translation Worker**
  - *Status:* **Partially Done** — a functional multi-tier pipeline exists, not a stub (Detailed in [implementation_plan.md](file:///home/sagnik/.gemini/antigravity-ide/brain/6c2955b3-3843-4157-80a4-57c7118f39d4/implementation_plan.md)).
  - **Done:**
    - **Tier 1 (Optional VLM vision pass):** Sends page image + OCR regions to a VLM (OpenRouter/Gemini) for context-aware batch translation when `USE_VLM_TRANSLATION=true`.
    - **Tier 2 (LLM batch):** Sends all bubbles as structured JSON to DeepSeek/Nemotron (OpenRouter), NVIDIA Nemotron, or a local Ollama/LMStudio model.
    - **Tier 3 (retry):** Re-runs failed/invalid batch items.
    - **Tier 4 (individual fallback):** Per-region translate via the LLM chain → DeepL → free Google Translate.
    - Quality filters: confidence threshold, kana-only SFX whitelist, pathological-length rejection, boilerplate rejection.
    - Rate limiting via `RATE_LIMIT` env var.
  - **Remaining Plan:**
    - Group regions by conversation/scene and translate cohesive dialogue blocks rather than a flat list of text bubbles.
    - Inject narrative context (`chapterSummary`, character rosters, and editorial rules) into VLM/LLM prompts.
    - Extract and return additional translation metadata (emotions, tones, translation decision notes) to backend.

- [/] **14. Translation Overlay in Viewer**
  - *Status:* **Partially Done** — basic overlay exists and is working (Detailed in [implementation_plan.md](file:///home/sagnik/.gemini/antigravity-ide/brain/6c2955b3-3843-4157-80a4-57c7118f39d4/implementation_plan.md)).
  - **Done:**
    - `showTranslations` toggle in the sidebar switches the overlay on/off.
    - When enabled, an SVG `<foreignObject>` renders translated text centred over each OCR bounding box with a dark/light pill background.
    - The region inspector popover shows translated text alongside the original, switching labels between "Original" and "Translated" based on the toggle state.
    - Per-region re-translate button triggers a `region-redo?type=translation` job with live polling.
  - **Remaining Plan:**
    - Implement a **Scanlation Masking View**: Erase/mask original text under speech bubbles using solid background elements, rendering cleanly styled translations centered inside bubbles with digital manga fonts.
    - Build a full Layer Manager component to toggle visibility of and re-order OCR, translation, SFX, and notes layers.

- [/] **15. Layer Editor**
  - *Status:* **Partially Done** — inline text editing exists (Detailed in [implementation_plan.md](file:///home/sagnik/.gemini/antigravity-ide/brain/6c2955b3-3843-4157-80a4-57c7118f39d4/implementation_plan.md)).
  - **Done:**
    - Clicking any OCR region popover opens an inline textarea (edit mode) for either `text` (OCR) or `translatedText` (translation) depending on the `showTranslations` toggle.
    - Save immediately PATCHes `/api/ocr-regions/{id}` and updates local state optimistically.
    - Per-region approve/flag toggle (green checkmark) stored server-side.
  - **Remaining Plan:**
    - Create backend `LayerController.java` to support full Layer and LayerElement CRUD operations.
    - Write translation edits to `layer_elements` (and `layer_edit_history` for history logs) instead of directly mutating base `ocr_regions`.
    - Provide custom UI inputs in the frontend inspector to manipulate layer element properties: font sizes, font families, margins, coordinates, width/height dimensions, and rotation angles.
- [ ] **16. Text Fitting**
  - *Status:* **Todo**.
  - **Plan:** Implement a client-side text-fitting utility using canvas measurements to scale font sizes dynamically within bounding boxes, flagging overflow elements with warning indicators.
- [ ] **17. Undo/Redo System**
  - *Status:* **Todo**.
  - **Plan:** Build client-side history stack tracking layer element edits and hook up Ctrl+Z / Ctrl+Y keyboard shortcuts.
- [ ] **18. SFX Rendering Path**
  - *Status:* **Todo**.
  - **Plan:** Support styling and placing sound effects near their original coordinates on an SFX-specific layer.

---

## 🔍 Search, Exports & Advanced (Phases 7, 8, 9, 10)

- [ ] **19. Meilisearch Integration**
  - *Status:* **Todo**.
  - *Remaining:* Spin up Meilisearch service, implement backend `search-service` for indexing and querying.
- [ ] **20. Export Engine**
  - *Status:* **Todo**.
  - *Remaining:* Build exporter for PNG, PDF, and CBZ (with metadata layers sidecar).
- [ ] **21. Chapter Summary Generation**
  - *Status:* **Todo**.
  - *Remaining:* Summarization pipeline executing on chapter completion.
- [ ] **22. Character Memory System**
  - *Status:* **Todo**.
  - *Remaining:* Tracking character rosters across page translations.
- [ ] **23. Inpainting**
  - *Status:* **Todo**.
- [ ] **24. Local Model Support**
  - *Status:* **Todo**.
