# Manga Translation Platform Implementation Checklist v2 (Updated)

This document tracks the translation platform checklist, restructured and prioritized based on user feedback (June 18, 2026).

## 💬 User Feedback & Design Decisions (Incorporated)

- **Phase 1 (Reading Order Panel Sorting):** Keep as high priority.
- **Phase 2 (SFX Rendering):** Simplified. We do not need an over-engineered SFX system. Instead, use the same mask-and-add-text approach, adding bold/italic support to the font. Keep SFX elements on a dedicated togglable canvas layer.
- **UI Enhancements (from Annotated Screenshot):**
  - **Bug Fix:** Fix layer alignment/rendering breaking when zooming the workspace.
  - **Zoom Controls:** Remove the floating zoom widget (`+`/`-`/`RESET` panel) on the canvas and its toggle ("Show Zoom Bar"). Rely entirely on the zoom controls in the left sidebar.
  - **Tools Panel:** Add a new toolbar between the layers panel and page actions panel. It should let users add masks, add text, and use an eye-dropper tool to manually sample colors to correct mask backgrounds.
- **Phase 6 (Speech Bubble Inpainting):** Simplified. Do not spin up Stable Diffusion or ComfyUI. Rely on the current mask-original-and-add-text approach. Improve it via:
  1. Auto-typesetting respecting background colors and matching mask color.
  2. Shaping text boxes dynamically based on the original speech bubble contour/boundaries.
- **Deferred Phases:** Phase 3 (Import Engine), Phase 4 (Character Memory), Phase 5 (Chapter Summary), and Phase 7 (Meilisearch) are deferred as they are not needed right now.
- **Phase 8 (Advanced VLM & QA):** Kept as low priority (Phase 4).

---

## 📅 Prioritized Phases

### Phase 1: Core Engine & UI Refinements (High Priority)

- [x] **Dynamic Panel Sorting by Reading Direction**
  - **Context:** Currently, bubble sorting inside panels respects the series' `readingDirection` (`rtl`, `ltr`, `ttb`), but the panel segmenter (`detect_panels` in `panel.py`) still sorts panels using a hardcoded RTL row-then-column order.
  - **Action:** Update the panel detection handler to read `readingDirection` from the enqueued Redis job payload and apply dynamic sorting logic so LTR (left-to-right column ordering) and TTB (top-to-bottom strip) layouts are parsed correctly.
- [x] **UI Refinements & Fixes (Annotated Screenshot Feedback)**
  - **Layer Zoom Bug:** Investigate and fix the layer alignment/rendering breaking when zooming in/out on the page.
  - **Zoom Widget Cleanup:** Remove the floating canvas zoom control panel (and the "Show Zoom Bar" toggle in the sidebar) to simplify the viewport; use only the left sidebar zoom/pan controls.
  - **Toolbar Insertion:** Add a toolbar between the Layers panel and Page Actions panel with controls to:
    - Add Mask
    - Add Text
    - Eye-dropper tool to sample page colors and manually correct mask background colors.

### Phase 2: Simplified SFX Layer (High Priority)

- [x] **SFX Dialogue & Font Support**
  - **Context:** Keep SFX on a separate canvas layer for clarity, but avoid complex/stylized sound effect paths.
  - **Action:**
    - Support bold and italic styling for typescript/dialogue fonts.
    - Enable placing text on a dedicated, togglable SFX-specific canvas layer using the same mask-and-text system as regular speech bubbles.

### Phase 3: Smart Masking & Box Shaping (Medium Priority)

- [x] **Context-Aware Masking & Typesetting (No SD/ComfyUI)**
  - **Context:** Rather than using Stable Diffusion for full image inpainting, refine the existing mask-and-text flow.
  - **Action:**
    - **Adaptive Mask Color:** Implement color-sampling/auto-detection of bubble background color so masks match the local background color instead of being hardcoded to white.
    - **Contour-Based Text Box Shaping:** Shape the text boxes dynamically based on the detected speech bubble boundaries/contours to optimize text layouts.

### Phase 4: Advanced VLM Processing & Quality Assurance (Medium Priority)

- [x] **Single-Pass Multimodal VLM Pipeline**
  - **Action:** Integrate a multimodal workflow where a single prompt sends the page image to a VLM to extract layout, reading order, and translation in a single pass.
- [x] **Headless Render Engine on Worker**
  - **Action:** Implement headless canvas/Node rendering inside the Python worker to render the final typeset images directly.
- [x] **VLM Quality Assurance Review Pass**
  - **Action:** Set up a QA loop where a VLM reviews the final rendered typeset images to detect text bounds overflow, clipping, or incorrect font sizes.
- [x] **Web Novels, Comics, & Document Configs**
  - **Action:** Create customized pipeline templates and prompt profiles for non-manga documents (screenshots, documents, web novels).

---

## 🚫 Deferred Items (Not Needed Right Now/Low Priority)

- [ ] **Layer Project Re-hydration (Project Import Engine)**
  - **Action:** Implement importing a `project.json` or full ZIP to restore UI state.
- [ ] **Cross-Page Character Memory Tracking**
  - **Action:** Pass speaker profiles to LLM prompts to prevent name drift.
- [ ] **Chapter Summary Generation**
  - **Action:** Background worker aggregates dialogue and summarizes chapters.
- [ ] **Full-Text Search Indexing & Querying (Meilisearch)**
  - **Action:** Set up Meilisearch container and index translated dialogue.
