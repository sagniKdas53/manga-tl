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
    - Extract and return additional translation metadata (emotions, tones, translation notes).

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
    - Edits are persisted in the database.

- [x] **16. Text Fitting**
  - *Status:* **Complete**.
  - **Done:** Client-side offscreen canvas measurement engine dynamically fits text into bounding boxes, adjusts line wraps, scales font sizes, and reports overflow flags.

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
- [ ] **24. Local Model Support**
  - *Status:* **Todo**.

---

## 🤖 AI-Powered Typesetting Roadmap

The current typesetting engine delivers solid text-fitting within bounding boxes. To reach print-quality, comic-native rendering, the following advanced AI integrations are planned:

### 1. Context-Aware Font Selection
- Classify region category (`whispering`, `screaming`, `narration`, `sfx`, `caption`, `thought`) during the **layout analysis stage** (already has the labels, just needs to be passed to layers).
- Map classification labels to styled comic font faces dynamically:
  - *Bangers* / *Permanent Marker* → action SFX
  - Condensed sans → speech bubbles
  - Serif italic → internal monologue / narration boxes
  - Uppercase heavy-weight → yelling / emphasis
- Font mapping table configurable per series (editorial style guide).

### 2. Contour-Aware Text Wrapping
- Detect bubble boundary contours using computer vision (OpenCV on binarized bubble masks from the `mask.png` export layer).
- Represent boundary as a polygon and compute per-scanline available width for text layout — enabling natural oval/irregular wrapping that doesn't clip corners.
- Expose as an optional layer flag `contourWrap: true` with a fallback to rectangular bounds.

### 3. VLM Styling Insights
- Prompt Vision-Language Models to output visual metadata per bubble (`styleMultiplier`, `isBold`, `emotionKey`, `bubbleShape`) based on visual inspection of the speech bubble shape (spikey → bold uppercase, round → regular, cloud → thought).
- Store metadata in `layer_elements.style_hints` JSON column (already schematised in `layer_edit_history`).
- Apply hints at render time as an override on top of the font mapping table.

### 4. Automatic Balloon Replacement / Inpainting
- Feed `mask.png` + `original.png` into a Stable Diffusion inpainting pipeline (SD-XL Inpaint or ComfyUI workflow) to white-out Japanese text while preserving artwork texture.
- Use `translation.png` as the typesetting overlay applied post-inpainting.
- Integrates directly with item **23 (Inpainting)** above.

### 5. Lettering Quality Scoring
- Compare rendered translation PNG against OCR region dimensions and font metrics to produce a quality score (`overflow`, `too_small`, `ideal`).
- Surface warnings in the Layer Inspector panel for elements scoring below threshold.
- Use score as a signal for human review queue prioritisation.
