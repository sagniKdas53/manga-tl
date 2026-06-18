# Manga Translation Platform Implementation Checklist v2 (Pending Items Only)

This checklist ranks the remaining pending tasks from the Translation Platform project in their recommended logical execution order.

---

### 1. 👁️ Core Engine: Reading Order Panel Sorting (Phase 1/2 Carryover)

- [ ] **Dynamic Panel Sorting by Reading Direction**
  - **Context:** Currently, bubble sorting inside panels respects the series' `readingDirection` (`rtl`, `ltr`, `ttb`), but the panel segmenter (`detect_panels` in `panel.py`) still sorts panels using a hardcoded RTL row-then-column order.
  - **Action:** Update the panel detection handler to read `readingDirection` from the enqueued Redis job payload and apply dynamic sorting logic so LTR (left-to-right column ordering) and TTB (top-to-bottom strip) layouts are parsed correctly.

### 2. 🎨 Translation & Typesetting: SFX Rendering Path (Phase 4 Carryover)

- [ ] **Styling & Placing Sound Effects on SFX Layer**
  - **Context:** Original sound effects (SFX) need customized placements, rotation, and stylized fonts that differ from regular dialogue.
  - **Action:** Implement sound-effect styling controls in the frontend editor and add support for rendering and saving sound effects on a dedicated, togglable SFX-specific canvas layer.

### 3. 📂 Workflow: Project Import Engine (Phase 8 Carryover)

- [ ] **Layer Project Re-hydration**
  - **Context:** The Export Engine currently outputs a ZIP containing page images, masks, and a `project.json` containing layer element metadata. We need a way to reload this state.
  - **Action:** Implement a file input handler in the React viewer that accepts a `project.json` or the full export ZIP, parses the metadata, and restores the full editable layers state in the UI for round-tripping.

### 4. 🧠 Translation Context: Character Memory System (Phase 10 Carryover)

- [ ] **Cross-Page Character Memory Tracking**
  - **Context:** Maintain character names and roster context consistently throughout translations.
  - **Action:** Implement a character dictionary/memory service that collects recognized speaker profiles and passes them along to the VLM/LLM translation prompt template to avoid character name drift across pages.

### 5. 📝 Chapter Summarization Engine (Phase 9 Carryover)

- [ ] **Chapter Summary Generation**
  - **Context:** Summarize translation dialogue/narration once a chapter is completed.
  - **Action:** Implement a background summarizer task that triggers when a chapter's pages are fully translated. It should aggregate the dialogue text, prompt an LLM to generate a story summary, and save it to the chapter's metadata database field.

### 6. 🧹 Image Processing: Automated Inpainting (Phase 8 Carryover)

- [ ] **Speech Bubble Text Removal**
  - **Context:** Cleaning pages by replacing the text areas with inpainted backgrounds.
  - **Action:** Spin up a background worker task using the generated white-filled `mask.png` (produced by the export engine) as an input to an SD/ComfyUI-based inpainting API to automate text bubble cleaning.

### 7. 🔍 Search Infrastructure: Meilisearch Integration (Phase 7)

- [ ] **Full-Text Search Indexing & Querying**
  - **Context:** Enable users to search across translated manga dialogues, titles, and narration.
  - **Action:** Set up a Meilisearch container, integrate it with the Spring Boot backend, and write a search indexing service that updates the index when translations are edited or approved.

### 8. 🤖 Advanced VLM Processing & Quality Assurance (Phase 10)

- [ ] **Single-Pass Multimodal VLM Pipeline**
  - **Action:** Integrate a multimodal workflow where a single prompt sends the page image to a VLM to extract layout, reading order, and translation in a single pass.
- [ ] **Headless Render Engine on Worker**
  - **Action:** Implement headless canvas/Node rendering inside the Python worker to render the final typeset images directly.
- [ ] **VLM Quality Assurance Review Pass**
  - **Action:** Set up a QA loop where a VLM reviews the final rendered typeset images to detect text bounds overflow, clipping, or incorrect font sizes.
- [ ] **Web Novels, Comics, & Document Configs**
  - **Action:** Create customized pipeline templates and prompt profiles for non-manga documents (screenshots, documents, web novels).
