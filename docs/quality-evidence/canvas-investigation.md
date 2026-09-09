# Canvas save and render investigation

Final cross-check: the consolidated `../output-quality-investigation.md` includes actual worker
render-loop probes completed after this canvas pass. Whitespace still paints automatic masks,
empty manual plates are dropped by the worker, and preexisting visible SFX bypasses the
translation-stage setting. Treat the earlier unit-test results here as narrow coverage, not a
universal blank/SFX fix. The root also reproduced the save handler's incorrect layer/element ID
and premature render timestamp clearing; `../canvas-output-quality-plan.md` defines final priorities.

Status: completed source-level investigation with a deterministic local repro, 2026-09-09.

Scope is current checkout `25731ac3767af0b52b23ea119aeddcaf58ac86c7` and worker
submodule `3a7b46c`. This is an investigation only: no application code was
changed.

## Checkpoint: paths being verified

* Browser PNG export is `Reader.tsx` `doExport` (around lines 2410–2530): it
  awaits font loading, paints masks into a transparent canvas, composites that
  canvas over the original, then typesets exportable translation/SFX layers.
* ZIP export is `handleExportZip` (around lines 2602–2841); it invokes the PNG
  export path and serializes project/layer information for downstream render.
* Mask geometry is shared by browser export through
  `frontend/src/utils/maskPaint.ts`; box rectangles are rotated, while stored
  absolute mask polygons deliberately are not.
* Text geometry is shared through `textFitBox.ts` / `fitText.ts`. Recent
  commits `3433977` and `9e1f285` claim configurable single-inset parity; those
  claims still need current-test and fixture confirmation.
* The prior committed fixes `2dd8bd7` (OCR excluded from export), `a3813f1`
  (blank text must not erase), and `5f8f947` (rotation semantics) are treated
  as hypotheses, not proof of current end-to-end behavior.

## Results

### What is currently covered

The following deterministic checks passed at this checkout:

```text
cd frontend
npm test -- --run src/__tests__/utils/maskPaint.test.ts \
  src/__tests__/utils/textFitBox.test.ts src/__tests__/utils/fitText.test.ts \
  src/__tests__/components/ReaderExportZip.test.tsx
# 4 files, 35 tests passed

cd worker
../.venv/bin/python -m pytest -q tests/test_render_extra.py \
  -k 'rotate or text_fit or sfx or blank or empty'
# 6 passed, 24 deselected

cd backend-rust
cargo test --lib accepts_the_fractional_box_a_rotation_produces
# 1 passed (fractional dimensions and rotation survive save DTO parsing)
```

These establish unit-level rotation transforms, blank-mask policy, shared inset
arithmetic, ZIP structure, and selected worker rotation/fit helpers. The ZIP
test explicitly uses stub canvas bytes, so it is not pixel evidence.

The requested fixtures exist in `corpus/samples/ja`. A `jq` scan of their
`project/project.json` files found the following:

| sample | elements | rotated | blank/whitespace text | SFX `regionType` |
| --- | ---: | ---: | ---: | ---: |
| 177 | 8 | 0 | 0 | 0 |
| 222 | 2 | 0 | 0 | 0 |
| 61 | 200 | 0 | 3 | 0 |
| 99 | 20 | 0 | 1 | 0 |
| 93 | 22 | 0 | 5 | 0 |
| 83 | 12 | 0 | 0 | 0 |

They are useful blank-mask and ordinary-export fixtures, but they cannot
reproduce the reported rotation or SFX cases: every stored rotation is zero
and no exported element has `regionType: "sfx"`.

### Confirmed current behavior

* Browser PNG export fetches the full original, waits for CSS fonts, paints a
  per-layer transparent mask, then turns its text canvas about the stored box
  centre (`frontend/src/components/Reader.tsx:2411-2517`). ZIP export repeats
  that text transform and retains `rotation`, font/weight/style, polygon, and
  `regionId` in `project.json` (`Reader.tsx:2656-2781`).
* `paintLayerMask` ignores blank automatic elements, but permits an explicitly
  manually edited blank plate (`frontend/src/utils/maskPaint.ts:77-177`; test
  cases at `frontend/src/__tests__/utils/maskPaint.test.ts:161-224`). OCR
  rasters are excluded while OCR metadata stays in the archive.
* Both sides use the same default inset calculation: 4px per edge followed by
  95 percent, integer-truncated (`frontend/src/utils/textFitBox.ts:53-74`; the
  worker equivalent is `worker/src/worker/handlers/render.py:1047-1090`).
  The parity tables passed above.
* The backend accepts fractional box dimensions and rotation in ordinary saves
  (`backend-rust/src/routes/layers.rs:45-165`) and ZIP restore reads rotation,
  font/style/weight, box geometry, visibility, colours, shape, polygon, and
  region id (`backend-rust/src/routes/page.rs:1929-2013`).
* Production worker rendering filters to visible translation and SFX layers,
  skips empty text before masking, rotates both plates and glyphs, and uses a
  tile to avoid clipping rotated glyphs (`worker/src/worker/handlers/render.py:1150-1381`).
  Its default SFX policy is preserve-as-drawn unless `TYPESET_SFX` is enabled
  (`worker/src/worker/config.py:412-421`,
  `worker/src/worker/services/translation.py:201-218`).

### Open quality gaps found in current code

1. **Browser export and worker output are not stroke-parity artifacts.** The
   worker may add a backdrop-coloured halo for free-floating text
   (`render.py:1275-1285`, `1326-1364`). Browser PNG and ZIP text canvases call
   `fillText` only; neither sets `lineWidth` nor calls `strokeText`
   (`Reader.tsx:2493-2515`, `2693-2716`). A free-standing caption that needs a
   worker halo will differ even when the serialized fields match. This is a
   source-confirmed gap, not yet a measured image delta.
2. **Browser export clamps to the raw box after fitting to the inset box.**
   `fitTextInBox` gets `fitBox`, but `clampLineCenter` receives `el.x,width` in
   both export paths (`Reader.tsx:2474-2514`, `2665-2714`). Worker clamps to
   `text_box_x,text_box_w` (`render.py:1297-1323`). The outcome diverges for
   offset polygon spans or lines near an inset edge. This is a deterministic
   code-path mismatch; an adversarial rotated/polygon fixture should quantify
   it before changing behavior.
3. **ZIP project JSON is not self-contained SFX/region semantics.** The browser
   serializes `regionId` and QA fields but not `regionType`, bubble geometry, or
   `layerVisible` per element (`Reader.tsx:2757-2781`). Restore can retain a
   region UUID only if that referenced region exists in the destination
   database (`page.rs:2005-2013`). Thus an imported archive alone cannot prove
   that worker SFX/no-bubble policy is preserved. This is especially relevant
   because the requested fixtures contain no SFX field to exercise it.
4. **Font parity is best-effort rather than byte-identical.** Browser export
   asks the CSS Font Loading API for the requested family and then uses Canvas
   fallback on failure (`fitText.ts:19-45`); the worker resolves a local Pillow
   font via `load_font` (`render.py:1258-1274`). There is no cross-runtime font
   identity check or glyph-metrics golden test.
5. **Project ZIP restore loses fractional dimensions.** Ordinary API saves
   deliberately accept fractional `maxWidth`/`maxHeight` generated by rotation
   (`backend-rust/src/routes/layers.rs:45-165`), but ZIP restore reads both
   through `as_i64()` before defaulting to 150×80 (`page.rs:1948-1957`). A
   browser ZIP can therefore preserve the number in JSON yet restore a different
   box and change its later render.

### Executable current repro: raw-versus-inset clamp

`docs/quality-evidence/canvas-clamp-repro.mjs` loads the current TypeScript
helpers through Vite and checks the actual two Reader call-site argument
patterns. It needs no server, credentials, image fixture, or model call:

```text
node docs/quality-evidence/canvas-clamp-repro.mjs
```

At the default 4px/95% inset, a 300px box at x=100 becomes x=104, width=277.
For a valid polygon span whose desired centre is its right edge (381), a
100px line is clamped to x=350 by the browser's raw box and x=331 by the
worker's fitted box: **19px centre/left-edge drift**. The harness confirms both
the PNG and ZIP Reader paths currently pass `el.x,width`, while the two numeric
results come from the imported production helpers. This is a geometry repro,
not a rendered-pixel comparison; it establishes the open mismatch's magnitude
for this adversarial but valid placement.

The Vite loader emitted an irrelevant sandbox WebSocket bind warning for port
24678, but the script completed with exit 0 and printed the measured JSON.

### Executable current repro: fractional ZIP restore

```text
node docs/quality-evidence/canvas-zip-fractional-repro.mjs
```

The archive-compatible `{maxWidth:186.43,maxHeight:187.91,rotation:12.5}`
input retains rotation but restores to the source defaults 150×80, a measured
36.43px width and 107.91px height loss. The diagnostic asserts the live
`as_i64()` accessor in the restore block and models the JSON number category
that drives its default branch. It is a no-database, source-level repro; an
integration import test should become the acceptance gate before a repair.

### Coordinator, QA, blank-mask and SFX correction

The live server-to-worker path does preserve policy inputs. The backend expands
each stored element with `layerType`, `layerVisible`, and its OCR
`regionType` (`backend-rust/src/routes/internal.rs:337-384`), and the renderer
fails closed unless the visible layer is translation/SFX (`render.py:1141-1168`).
Layout persists region types (`backend-rust/src/jobs/coordinator.rs:1223-1263`).
For normal pipeline work, SFX skipped by the worker receives empty translated
text and the renderer skips it before masking (`worker/src/worker/handlers/translation.py:98-108`;
`render.py:1165-1168`). QA `reject_sfx` hides the matching translation elements
and records the QA status (`coordinator.rs:2292-2374`). Thus the earlier ZIP
finding is limited to standalone project archive re-import, not the live
coordinator render payload.

The reported old defects should therefore be classified carefully: rotation,
empty automatic masks, OCR rasters, and configurable padding have code and
targeted-test evidence of fixes. The three gaps above remain current source
evidence, while visual severity is unmeasured pending a live deterministic
browser/worker run.

## Execution plan and acceptance gates

1. Add a checked-in synthetic project fixture with one rotated rectangular
   caption, one rotated polygon, an offset elliptical/polygon line span, an
   automatic blank, a manually blank plate, a free-standing caption, and an
   SFX region. Keep it local and deterministic; no model calls.
   **Gate:** its saved JSON round-trips through the layers API and project ZIP
   import without changing rotation, text, font fields, polygon, blank intent,
   layer visibility, SFX policy inputs, or fractional box dimensions.
2. Run the browser against that fixture in Chromium and retain PNG/ZIP outputs;
   run the worker renderer from the same serialized payload and retain its PNG.
   **Gate:** pixel diff is zero for geometry/rotation where the shared canvas
   implementation is the accepted renderer, or each approved renderer-specific
   difference (notably anti-aliasing) is masked and bounded. Check rotated text
   centroid/angle, plate footprint, and clipped-pixel count independently.
3. Make text rendering policy explicit: either implement the worker halo in
   browser export or define browser PNG as a preview and direct final export to
   worker rendering. Also align clamping to the shared fit rectangle.
   **Gate:** synthetic free-standing and offset-span cases meet agreed pixel
   tolerances and the parity test asserts placement, not only inset dimensions.
4. Define archive semantics for regions. Serialize the SFX/bubble inputs needed
   by the render policy, or document that project ZIP is editor-only and cannot
   be used as a worker-render input. Add migration compatibility for older ZIPs.
   **Gate:** SFX default stays unpainted; `TYPESET_SFX=true` produces an SFX
   layer intentionally; re-imported output follows the selected policy.
5. Add the six named corpus samples as regression visual references for blank
   mask behavior and non-rotated ordinary exports, then add at least one real
   rotated/SFX sample once available.
   **Gate:** test manifest records source hash, project JSON hash, browser
   version, fonts, worker revision, expected image hashes/metrics, and a small
   contact sheet for review.

## Reproduction limits

No stack was started and no browser/PDF visual comparison was run in this
checkpoint. The selected frontend ZIP test stubs canvas pixels; the worker
selection verifies helpers rather than MinIO callback delivery. The available
named fixtures contain no rotation or SFX, so they cannot validate the two
highest-risk reported scenarios. No production code was edited.
