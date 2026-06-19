# Manga Translation Platform Implementation Checklist v3

This document tracks the translation platform checklist, restructured and prioritized based on user feedback and workflow requirements (Updated June 19, 2026).

## 💬 User Feedback & Design Decisions (Incorporated in v3)

- **Frontend Upload Experience:** Need visual progress feedback and automatic refreshing. An upload queue (similar to Immich) and dynamic gallery refresh upon completion are required.
- **Text Box Interaction Regression:** Re-enable text box dragging and resizing via a togglable "Free Resize Mode" in the region editor sidebar to prevent canvas drag/zoom interference.
- **Branding & Logo:** Standardize project naming to `tl-hub`. Create a favicon, navicon, and navbar logo (light/dark variants) capturing smooth translation. Fix the homepage browser title showing generic "Frontend".
- **Configurable Translation Pipeline:** Move beyond hardcoded JP-to-EN. Support configurable `sourceLanguage` and `targetLanguage` per series, including reader-only modes (`EN --> EN`) and experimental modes (`KR --> JP`).
- **QA & Logger Verbosity:** Make VLM QA results verbose. Support comprehensive input/output logging on `DEBUG` and network headers/timing on `TRACE`. Add intentional failure/mismatch tests for VLM QA validation.
- **Backend Cache Migration:** Replace Valkey with Spring Boot's native cache framework.
- **CI/CD Build Separation:** Build and publish the backend within the main repository, and relocate the worker to a sub-module repository for independent builds.
- **Deferred Items:** Epubs/ZIP imports (Stretch Goal), Meilisearch indexing, and AI-generated summaries remain low priority.

---

## 📅 Prioritized Phases

### Phase 1: Core Engine & UI Refinements (Completed in v1/v2)

- [x] **Dynamic Panel Sorting by Reading Direction**
- [x] **UI Refinements & Fixes (Layer zoom bug resolved)**
- [x] **Zoom Widget Cleanup (Canvas buttons removed, sidebar controls centralized)**
- [x] **Toolbar Insertion (Add Mask, Add Text, Eye-dropper color sampler)**

### Phase 2: Simplified SFX Layer (Completed in v1/v2)

- [x] **SFX Dialogue & Font Support (Bold/Italic, dedicated SFX canvas layer)**

### Phase 3: Smart Masking & Box Shaping (Completed in v1/v2)

- [x] **Context-Aware Masking & Typesetting (Adaptive mask colors, contour-based shaping)**

### Phase 4: Advanced VLM Processing & Quality Assurance (Completed in v1/v2)

- [x] **Single-Pass Multimodal VLM Pipeline**
- [x] **Headless Render Engine on Worker**
- [x] **VLM Quality Assurance Review Pass**
- [x] **Web Novels, Comics, & Document Configs**

---

### Phase 5: Frontend UI & Editor Enhancements (High Priority)

- [x] **Upload Queue & Progress Feedback**
  - **Context:** Dropping files currently triggers uploads silently without visual progress, and sometimes requires a manual page refresh.
  - **Action:**
    - Add an upload queue component (similar to Immich's web UI) with progress indicators.
    - Automatically reload the gallery once all enqueued uploads finish.
    - Add a snackbar/toast notification system for successful uploads and error handling.
- [x] **Text Box Drag & Resize Fix (Free Resize Mode)**
  - **Context:** Dragging and resizing text boxes is currently broken/disabled in the editor view to prevent canvas zoom/pan conflicts.
  - **Action:**
    - Introduce a "Switch to Free Resize Mode" button in the region editor (left sidebar, under position/size inputs) when a text box is selected.
    - In Free Resize Mode, allow users to drag-to-move and edge-drag-to-resize the text box bounding boxes directly on the canvas.
- [x] **Project Naming & Branding (`tl-hub`)**
  - **Context:** Project names are inconsistent ("Manga Translation Hub" in navbar, `/tlhub` in context path, `manga-tl` in repository name).
  - **Action:**
    - Standardize branding and terminology under `tl-hub`.
    - I will provide the logo, use it for both faviocn and nav icon.
    - ![alt text](frontend/src/assets/logo-dark.svg)
    - ![alt text](frontend/src/assets/logo-light.svg)
    - And favicon.zip for the rest of the asstes
- [x] **Homepage Browser Title Bug Fix**
  - **Context:** The browser tab title displays a generic "Frontend" when visiting the homepage (whereas series, chapters, and pages views work fine).
  - **Action:**
    - Update the homepage component/routing title handling to reflect the new `tl-hub` branding dynamically.

---

### Phase 6: Configurable Translation Engine & QA Validation (Medium Priority)

- [x] **Bidirectional Translation & Reader Configs**
  - **Context:** The pipeline needs customizable translation source/target pairs and non-translation pipelines.
  - **Action:**
    - Add `sourceLanguage` and `targetLanguage` parameters to the series configuration.
    - Support configurations:
      - `JP --> EN`: Standard translation and typesetting workflow.
      - `EN --> EN` (Reader mode): Generate thumbnails and run OCR for future indexing/summaries, skipping translation.
      - `KR --> JP`: Experimental VLM/LLM translation.
- [x] **Universal Thumbnail Generation**
  - **Context:** Gallery page load times are sluggish using full-resolution images.
  - **Action:**
    - Ensure thumbnails are generated on upload for every page, regardless of the series config.
- [x] **Verbose VLM QA & Debug Logging**
  - **Context:** VLM QA passes all images without verbose output, making validation difficult. We also need deep trace logs of all API calls.
  - **Action:**
    - Make VLM QA rejection/approval reasoning verbose and visible.
    - Update logger configuration:
      - `DEBUG` level: Output full inputs and outputs for OCR, LLM translation, and VLM QA.
      - `TRACE` level: Log headers and exact response timings for all external API calls.
    - Create QA test cases to verify rejection capabilities:
      - Force poor translations using intentionally dumb models.
      - Input low-quality source images (messed-up OCR).
      - Upload a Korean (KR) page to a Japanese (JP) series to test mismatch handling.
- [x] **High-Quality/Paid Translation API Integration**
  - **Action:** Research and integrate a paid/premium translation API endpoint for better output quality.
- [x] **Hardware & Remote ML Deployment Testing**
  - **Action:**
    - Deploy and test the Python worker locally on a Raspberry Pi 5.
    - Configure and verify remote Ollama connections on the Chromebox.

---

### Phase 7: Backend Refactoring & Packaging (Medium Priority)

- [ ] **Monorepo Packaging & CI/CD Remediation**
  - **Context:** Backend and worker packaging do not map correctly to the repositories they are built in.
  - **Action:**
    - Build and publish the Java backend from the main repo.
    - Relocate the worker code to a sub-module repository and configure its independent build/publish pipeline.

---

## 🚫 Deferred Items (Low Priority / Stretch Goals)

- [ ] **Spring Boot Native Cache Migration**
  - **Context:** Remove external Valkey dependency in favor of Spring Boot native caching.
  - **Action:**
    - Migrate cache abstractions to use Spring Boot's internal cache providers (e.g., Caffeine or simple in-memory caches).
- [ ] **Layer Project Re-hydration (Project Import Engine)**
  - **Action:** Support importing epubs, zips, or previously exported translation projects to restore workspace and layers state.
- [ ] **Full-Text Search Indexing & Querying (Meilisearch)**
  - **Action:** Set up a Meilisearch container and index typeset/translated text dialogue.
- [ ] **Chapter & Series Summary Generation**
  - **Action:** Background worker aggregates translated dialogue and generates summaries of chapters and series using the AI backend.
- [ ] **Cross-Page Character Memory Tracking**
  - **Action:** Feed speaker profiles to the translation engine prompts to avoid name/gender drift across chapter pages.
