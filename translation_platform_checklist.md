# Manga Translation Platform Implementation Status

This checklist maps the **Development Order** defined in [Manga_Translation_Platform_Specification_v2.md](file:///home/sagnik/Projects/docker-composes/manga-library/Manga_Translation_Platform_Specification_v2.md) against the codebase, noting what is complete, partially implemented, and what remains.

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
  - Integrated with EasyOCR (ja/en support).
  - Includes character regex-based language detector (`ja`, `zh-TW`, `en`).
  - Correctly maps regions into panels based on overlap and sorts bubble reading order.
- [x] **8. OCR Overlay in Viewer**
  - Interactive SVG overlay displays panel boundaries and OCR boxes.
  - Clickable regions dynamically display details in a sidebar inspector.
- [/] **9. Reading Order Detection**
  - *Status:* **Partially Done**.
  - *Remaining:* Sorting is currently hardcoded for Right-to-Left (RTL). Needs to read and apply the series' database-defined `reading_direction` (`rtl`, `ltr`, `ttb`) dynamically.
- [ ] **10. Conversation Grouping**
  - *Status:* **Todo**.
  - *Remaining:* Worker does not perform conversation groupings; backend database mapping is present but unused.
- [ ] **11. Layout Analysis Worker**
  - *Status:* **Todo**.
  - *Remaining:* The layout analyzer is a stub (sleeps for 0.5s). Need classification of region types (`speech`, `thought`, `narration`, `sfx`, `caption`, `sign`).

---

## 🤖 AI Translation & Layers (Phases 3, 4)

- [ ] **12. Translation Context Assembler**
  - *Status:* **Todo**.
  - *Remaining:* Backend needs to assemble structural context (OCR coordinates), narrative context (prior page/chapter summary, characters), and editorial instructions into a prompt package.
- [ ] **13. VLM Translation Worker**
  - *Status:* **Todo**.
  - *Remaining:* Currently a stub. Needs integration with a VLM (Gemini, OpenAI, or local VLMs) to handle context-aware translations.
- [ ] **14. Translation Overlay in Viewer**
  - *Status:* **Todo**.
  - *Remaining:* Needs viewer modes for Original, Translation, Split View, Bilingual, and Layer View.
- [ ] **15. Layer Editor**
  - *Status:* **Todo**.
  - *Remaining:* UI editor for manually modifying translation text, position/sizing, fonts, or hiding/showing individual layers.
- [ ] **16. Text Fitting**
  - *Status:* **Todo**.
  - *Remaining:* Auto-sizing, wrapping, and overflow checking logic for dialogue boxes.
- [ ] **17. Undo/Redo System**
  - *Status:* **Todo**.
  - *Remaining:* Frontend hooks tracking session edits via `layer_edit_history`.
- [ ] **18. SFX Rendering Path**
  - *Status:* **Todo**.
  - *Remaining:* Configuration per series for Sound Effects handling styles (overlay, omit, preserve).

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
