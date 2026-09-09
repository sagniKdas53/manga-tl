# Output-quality implementation boundaries

Checkpoint: 2026-09-09. The [implementation tracker](../output-quality-implementation-tracker.md) supersedes the broad grouping of seams below and supplies the bounded task packets. This note records source-verified starting points for small
implementation tasks. It does not claim that the proposed architecture is implemented.
GitNexus was one commit behind the app checkout; direct source and existing tests were used
for the details below. No broad tests were run.

## 1. Shared browser renderer

Bound the first task to a reusable TypeScript scene/layout module and a DOM/SVG scene entry
point, then make the editor preview and export callers consume it. The current split is clear:
`frontend/src/components/Reader.tsx:3982-4067` renders the reader preview through SVG/HTML,
while `handleExportPng` at approximately `2411-2515` and `handleExportZip` at
`2606-2716` independently draw Canvas text. `frontend/src/utils/fitText.ts` and
`frontend/src/utils/textFitBox.ts` are the browser fitting helpers. The worker's separate
Pillow path is `worker/src/worker/handlers/render.py:450-963` (`fit_text_in_box_py`) and
`:1101-1415` (`render_image_core`). A migration task can keep the worker for image IO,
thumbnails and job/storage plumbing while routing final scene typography through a pinned
headless Chromium service. There is no existing render-service module or browser renderer to
reuse in the app.

Existing validation surfaces:

```bash
cd frontend && npm run typecheck && npm test -- --run src/__tests__/utils/fitText.test.ts src/__tests__/utils/textFitBox.test.ts src/__tests__/components/ReaderExportZip.test.tsx
cd worker && ../.venv/bin/python -m pytest -q tests/test_typesetting.py tests/test_render_extra.py tests/test_render_and_qa.py
```

Those tests exercise current helpers and Pillow rendering; they do not prove browser/Pillow
parity or a headless service. The existing corpus comparison tools are
`scripts/render_quality_metrics.py`, `scripts/text_fit_probe.py`, and
`scripts/playwright/capture_exports.cjs`; use recorded/new output images for parity checks.

## 2. Early SFX preserve policy and prompt exclusion

Bound this task across classification, translation target creation, prompt context, cleanup,
scene construction and import/export policy. Current worker entry points are
`worker/src/worker/services/layout.py:classify_region_type`,
`worker/src/worker/services/translation.py:should_typeset_region` and
`should_translate_region`, and `worker/src/worker/handlers/translation.py:process_translation`
(`:98-110` filters typeset targets). The verified gap is in that handler's page manifest loop
(`:142-157`): it serializes *all* `ocr_regions` and prepends the result to every translated
chunk (`:170-179`), so a preserved SFX can still enter prompt context. `process_chunk` at
`:161-188` is the provider boundary. Keep “preserve”, “explain”, “replace” and “uncertain”
actions explicit; a preserve action should create no translation target, no normal repeated
manifest entry, no cleanup artifact and no text object while retaining OCR metadata.

Existing validation surfaces:

```bash
cd worker && ../.venv/bin/python -m pytest -q tests/test_translation_service.py tests/test_translation_pipeline.py tests/test_translation_flow_e2e.py tests/test_layout_extra.py
```

The current tests cover `should_typeset_region`, provider translation behavior and layout
classification. They do not assert manifest token exclusion, cleanup suppression, or final
pixel preservation; add those checks only with the new corpus/output fixtures.

## 3. Separate nearby text owners

The current merge boundary is `worker/src/worker/services/merge_regions.py:87-231`
(`merge_ocr_regions`), using `worker/src/worker/services/fragment_grouping.py` for connected
components. Conversation grouping is separately in
`worker/src/worker/services/layout.py:136-239` (`group_conversations`) and is called by
`worker/src/worker/handlers/layout.py:process_layout`. These relationships currently share
geometry and can produce a merged region with a union box/mask. A bounded task should preserve
fragment-to-block ownership and merge provenance, while allowing conversation/panel links to
remain many-to-one. Do not use a shared detector polygon or proximity alone as proof that two
nearby blocks share a cleanup owner.

Existing validation surfaces:

```bash
cd worker && ../.venv/bin/python -m pytest -q tests/test_merge_regions.py tests/test_fragment_grouping.py tests/test_ocr_grouping.py tests/test_ocr_grouping_wiring.py tests/test_layout_extra.py
```

These are real tests for current grouping/merge behavior. They do not establish the proposed
independent-owner invariants for new output schemas.

## 4. Glyph masks, reconstructed backgrounds, and editable styled text

The current cleanup representation is `maskPolygon` plus `backgroundColor`, produced in
`worker/src/worker/handlers/ocr.py` (including `cover_fill_for_region` at `:319-356`) and
painted by `frontend/src/utils/maskPaint.ts:78-235` or the worker render loop. The browser
export applies masks for the layer first and then draws fitted text in `Reader.tsx` around
`:2439-2550`; `fitText` receives font, weight, style, rotation and mask constraints. This is
the correct seam for a new artifact contract: source-space glyph/alpha mask, bounded cleanup
patch or clean plate, source digest, stable region/owner IDs, warnings and generator revision,
plus an editable text object carrying style and layout geometry. Keep cleanup independent from
English text edits and recomposite from immutable source when an object is hidden/rejected.

Existing validation surfaces:

```bash
cd worker && ../.venv/bin/python -m pytest -q tests/test_ocr_shaping_color.py tests/test_ocr_extra.py tests/test_render_layer_filtering.py tests/test_render_extra.py
cd frontend && npm test -- --run src/__tests__/utils/maskPaint.test.ts src/__tests__/utils/fitText.test.ts src/__tests__/components/Reader.test.tsx
```

`maskPaint.test.ts` verifies overlap/order, blank elements, rotation and fallback behavior;
the worker tests verify sampled background/color and render filtering. No existing test proves
texture reconstruction, protected-art preservation, glyph recall, or editable cleanup/text
round-trips.

## 5. Output revision freshness

The existing freshness mechanism is page timestamps. `backend-rust/src/jobs/recovery.rs:149-201`
(`process_pending_renders`) selects pages where `last_edited_at` is older than the debounce
threshold and newer than/null relative to `last_rendered_at`; the render callback in
`backend-rust/src/jobs/coordinator.rs:2109-2193` stamps `last_rendered_at`. The page/export
metadata path in `backend-rust/src/export.rs` also reports stale rendered state, and
`frontend/src/components/PipelineRefreshWatcher.tsx` refreshes loaded grids after job events.
`backend-rust/src/routes/page.rs:138-148` builds cache-busted rendered thumbnail URLs.

Bound freshness work around an explicit output revision/source and artifact digest (including
active layers, cleanup, fonts, layout version and settings), with stale-output rejection at the
callback/download/thumbnail boundary. Existing checks are:

```bash
cd backend-rust && cargo test --test jobs_endpoints recovery_reset_stale_and_debounced_render
cd backend-rust && cargo test --test pages_endpoints rendered_output_reaches_the_page_grid
cd frontend && npm test -- --run src/__tests__/components/ChapterPageGrid.test.tsx src/__tests__/components/PipelineRefreshWatcher.test.tsx
```

These verify timestamp recovery, rendered page-grid URLs/cache keys and UI refresh behavior;
they do not prove revision/digest matching across concurrent renders.

## ARM64 POC boundary

The user explicitly identifies ARM64 as a POC. Source evidence: `worker/.github/workflows/ci-arm64-poc.yml` builds under QEMU, imports `onnxruntime`/`rapidocr`, asserts architecture and checks that PaddlePaddle is absent. It does not run representative pages or compare OCR, cleanup or rendering quality. The main worker image workflow also publishes an ARM64 manifest, but a manifest is not a real-page quality or capacity result. No README/support claim substitutes for these observed checks. Target the existing amd64 route for this plan; ARM deployment and quality parity are excluded from required gates.
