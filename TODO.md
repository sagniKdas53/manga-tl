# TODO — Manga Library (Master Checklist)

> **Last updated**: 2026-07-26  
> Audited via Git history & GitNexus analysis  
> Status legend: `[ ]` = not started, `[/]` = in progress, `[x]` = done, `[P]` = planned (in a plan doc), `[D]` = deferred

---

## 🟢 Current Goals

### Fix recent issues

- [ ] See [issues.md](./docs/issues.md)

### Output & Rendering Quality

- [ ] Rendered output quality gap vs mangatranslator.ai
  - See Example 1:
    - Original: <br/><img src="examples/sample2/original.jpg" alt="original" width="600"/>
    - mangatranslator.ai: <br/><img src="examples/sample2/en-mangatranslator.ai.jpg" alt="mangatranslator.ai" width="600"/>
    - Ours: <br/><img src="examples/sample2/en-local.png" alt="ours" width="600"/>
- [ ] **Multimodal VLM Quality Benchmarks & Render Tuning** — use VLMs (Kimi K3 or 5.6-Sol) to analyze translation and typesetting output against competitor benchmarks and refine `render.py` text fitting and inpainting algorithms.

## 🔵 Low Priority / Stretch Goals

- [ ] ePub / CBZ import and export support (currently ZIP only)
- [ ] **Rich Translation Context & Character Memory** — maintain series/chapter descriptions (booru-style metadata) and a cross-page character/name/place registry, injecting them alongside previous page text into LLM translation context.
- [ ] **AI-Generated Chapter & Series Summarization** — auto-generate summaries from translated dialogue.
  - [ ]  **Phase 1**: Need to add summary filed to both series and chapter objects first so that they can be manually configured
  - [ ]  **Phase 2**: Add `Named Entity Recognition (NER)` and auto generate these (remember to upgrade/the Inject Context Memory toggle to enable or disable this)
- [ ] **Pagination & Infinite Scroll** — two-phase approach for series, chapters, and pages:
  - [ ] **Phase 1**: Add backend & frontend pagination support (e.g. paged navigation).
  - [ ] **Phase 2**: Implement lazy loading / infinite scroll on top of paginated API endpoints to load more items as user scrolls.
- [ ] **Standalone NGINX & Decoupled Topology** — package frontend into standalone NGINX Alpine container and extract git submodules for remote GPU worker deployments.
  - [ ] Analyze if this will be even useful or needed, as we are as always constrained by the how fast the backend can send resources and over not how fast the html or js loads.

## 🧪 Testing & QA

- [ ] Test at higher concurrency not just 2 slots.
- [ ] Reserve CPU/memory for ML container (like Immich does for its ML container)
- [ ] Larger upload optimization (100+ images) — noticeable slowdown, need to optimize
- [ ] **Playwright End-to-End Pipeline Integration Test Suite** — create end-to-end Playwright test suite that uploads test manga images, triggers full OCR/TL/Render pipeline, and asserts layer correctness.

---

[Archive](./docs/archive.md)
