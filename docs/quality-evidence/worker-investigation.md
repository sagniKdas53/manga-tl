# Worker quality investigation

## Checkpoint: 2026-09-09

Status: worker investigation and local render replay completed. The consolidated root report and
`../canvas-output-quality-plan.md` define final priorities; full source OCR and live services remain unverified.

Scope is read-only application-code investigation of OCR fragment grouping / merged boxes,
mask creation and cover-fill erasure, and SFX/style classification and rendering. No remote
OCR, VLM, translation, or image-generation calls are included.

| Item | Value |
| --- | --- |
| Parent checkout | `25731ac3767af0b52b23ea119aeddcaf58ac86c7` |
| Worker checkout | `3a7b46c2994e2acff78cc27a9ef0c4545803ac0d` |
| Corpus checkout | `607b78b8b7211778f44ada940a06d7b8052917e6` |
| Initial status | all three repositories clean (reported before evidence files were created) |
| Fixtures | `corpus/samples/ja/sample177`, `sample222`, `sample61`, `sample99`, `sample93`, `sample83` |
| Graph status | worker GitNexus index verified fresh at the worker checkout; direct source remains the authority for runtime conditions |

### Confirmed current paths

1. `process_ocr` maps OCR quadrilaterals into original-image rectangles, assigns each by raw
   pixel overlap to one YOLO bubble, then rejects a winning bubble that does not substantially
   contain the fragment. (`worker/src/worker/handlers/ocr.py:783-842`)
2. Per-bubble grouping is `merge_ocr_regions(... grouping=grouping_config(...),
   context=bubble_grouping_context(...))`; a split component gets a contour cropped to its text
   rectangle plus 20 px, otherwise it falls back to the entire detected bubble. (`ocr.py:872-934`)
3. Unmatched text has no geometry gate and is merged by distance; if contour recovery fails, its
   mask is exactly its OCR rectangle because `pad = 0`. (`ocr.py:936-992`)
4. Region classification calls `classify_region_type`; only kana-only, <=5-character text outside
   a confident detected bubble is labelled `sfx`. (`worker/src/worker/services/layout.py:47-83`)
5. Rendering filters to visible `translation` and `sfx` layers, fills `maskPolygon` with the
   detected background color, and additionally fills the rendered text box for an element that
   does not resolve to a detected bubble. (`worker/src/worker/handlers/render.py:1141-1243`)

### Reproduction plan in progress

* Inventory saved `project.json`, source, render, export, and Torii artifacts; verify same-page
  identity via dimensions/digests before comparing them.
* Re-run pure grouping, classification, mask-shape and local renderer helpers through the root
  `.venv`, using fixture metadata or standalone synthetic inputs only. Do not invoke model-backed
  OCR stages or mutate corpus fixtures.
* Separate results labelled **reproduced current**, **historical artifact**, and **hypothesis**;
  add numeric acceptance gates with each proposed fix.

## Results

### Reproduced current behaviour

The command below used only the root Python 3.13.12 virtual environment and local fixtures:

```bash
cd worker
PYTHONPATH=src ../.venv/bin/python -m pytest -q \
  tests/test_fragment_grouping.py tests/test_ocr_grouping.py tests/test_layout_extra.py \
  tests/test_ocr_shaping_color.py tests/test_render_extra.py tests/test_typesetting.py
```

It completed with **103 passed**. This is a focused regression check, not an end-to-end production
run.

The exact pure grouping reproduction (three 10x10 fragments at x=0,14,28, threshold 0.5) returned
one component, one 38x10 union box, and `C B A` in RTL order. This is a direct consequence of
edge adjacency followed by unbounded breadth-first connected components
(`fragment_grouping.py:242-291`). It is a real failure mode for an unmatched chain: no bubble
geometry is available there to veto the bridge (`ocr.py:936-942`).

The current default configuration is a distance threshold of 0.35 character units, orientation
vote, and a 1.0-character waist veto where a non-convex bubble mask is available
(`config.py:434-452`, `ocr.py:55-69`). The veto can separate fragments inside a detected bubble;
it cannot act on unmatched text or an over-convex/fused detector mask.

`cover_fill_for_region` with each stored OCR rectangle and no mask returned a synthesized rounded
cover mask wider/taller than the source rectangle for every raw OCR region replayed. That is the
current intended path (`ocr.py:320-357`), using 18% of the shorter side as padding
(`config.py:395-404`). The replay records exact colors and bounds in
`worker-repro-results.json`.

There is one concrete classification defect: `classify_region_type` uses
`region.get("confidence") or 1.0` (`layout.py:53-55`). A deterministic call with otherwise
identical small panel text produced `speech` at numeric confidence `0`, and `sign` at `0.1`.
Zero is a valid low confidence, so this suppresses the small-low-confidence rule
(`layout.py:115-123`).

SFX is deliberately conservative: only short kana-only text outside a confident detected bubble
is marked `sfx` (`layout.py:63-83`). `should_translate_region` still admits that label, while
`should_typeset_region` leaves it artist-drawn under the default `TYPESET_SFX=false`
(`translation.py:182-233`; `config.py:417`). Rendering itself has no SFX-specific style branch;
it treats visible `translation` and `sfx` layers alike and only uppercases speech
(`render.py:1141-1180`). That is current policy, not evidence that a saved SFX was misclassified.

### Historical artifacts; not a current end-to-end claim

The replay verifies source-to-project identity before applying current helpers. It was pixel exact
for samples 222, 61, 99, 93, and 83. `sample177` is not pixel-identical: its source and saved project
original differ at 1,317,157 channel values, with maximum per-channel delta 24. Do not use its
saved render/export to judge the current worker against the saved source.

Saved masks often equal the OCR rectangle (sample177 4/4 matching output masks; sample61 132/150;
sample83 3/9). Those are historical project exports, so they demonstrate the data that needs
regeneration or migration, not that the current cover-fill helper still emits it. Current helper
replay instead generated a padded rounded mask for every no-mask input.

The stored project contains post-pipeline OCR/translation elements, not raw detector boxes, YOLO
masks, or saved per-stage job payloads. It therefore cannot prove which current detector branch
would execute. Running `process_ocr` or `render_image_core` would require the backend callback,
object storage, and OCR models; it was intentionally excluded to avoid external or model-backed
work.

### Current render-loop archive replay

`worker_render_replay.py` now invokes the real `render_image_core` loop against source bytes and
archived project layers. It stubs only the backend GET response, `download_image`, and MinIO
`put_object`; the fitted-text, plate, halo, visibility, and PNG-encoding code is current worker
code. The same injection boundary is exercised by `tests/test_render_extra.py` and
`tests/test_render_layer_filtering.py`.

| Fixture | Archived elements | Drawn by current filter | Changed pixels | Artifact |
| --- | ---: | ---: | ---: | --- |
| sample222 | 2 | 1 | 7,295,537 | `current-render-sample222.png` |
| sample177 | 8 | 4 | 346,272 | `current-render-sample177.png` |
| sample83 | 12 | 3 | 1,919,856 | `current-render-sample83.png` |
| sample61 | 200 | 49 | 1,528,677 | `current-render-sample61.png` |
| sample99 | 20 | 9 | 3,033,981 | `current-render-sample99.png` |
| sample93 | 22 | 4 | 11,601,979 | `current-render-sample93.png` |

Exact source/result digests and channel-delta metrics are in
`worker-render-replay-results.json`. For every archive replay, the harness restores only
`layerType` and `layerVisible` from the archived parent layer. Archive OCR elements lack persisted
bubble geometry, so it supplies bbox-equal `bubbleW`/`bubbleH`; this intentionally follows the
renderer’s **no-detected-bubble** branch. The images demonstrate current renderer behavior on
these serialized fields, not the original production bubble state. `sample177` retains the
source/project identity warning above; its current replay deliberately uses `source.jpg`.

The root pass completed all six and recorded the actual host font in the combined report:
requested Comic Neue bold resolves to DejaVu Sans Bold. Treat typography as this local environment's
output, not deployed-container font parity. See the consolidated investigation for the font hash
and complete visual observations. Changed pixels include intentional typesetting, not just damage.

The current loop has three observable policy gaps for elements that have already reached rendering:

* A visible translation whose text is whitespace is truthy, so it paints its 60x60 plate; the
  synthetic probe changed 3,721 pixels.
* A manually edited element with empty text is skipped before plate drawing; the synthetic probe
  changed zero pixels. The loop tests `if not text`, and has no manual-plate exception.
* A visible `layerType=sfx`, `regionType=sfx` element is painted even while the configured
  `TYPESET_SFX` is false; the synthetic probe changed 3,721 pixels. `TYPESET_SFX` is enforced in
  the translation stage, which the renderer does not call.

These probes are deliberate current-render facts. They do not establish that a normal fresh OCR
run will create such elements, because archived raw fragments and bubble semantics are absent.

## Prioritized execution plan

1. **Stop cross-unit merges before erasure (P0).** Persist a local, versioned diagnostic artifact
   for raw OCR boxes, detector masks, assignment overlap, grouping edges/vetoes, and resulting
   region IDs. Replace unrestricted connected components on the unmatched path with a bounded
   grouping rule that cannot bridge distant units through an intermediate fragment. For fused
   bubbles, do not use the full detector polygon when a per-component split contour is absent;
   return a reviewable unresolved region or an explicitly limited local plate.

   Acceptance: labelled cases must preserve every same-speaker component while producing zero
   cross-balloon components; a three-node bridge fixture must remain at least two components;
   every multi-component result must have pairwise-disjoint masks or an explicit unresolved flag.

2. **Make mask provenance and safety auditable (P0).** Carry `maskSource` (`detector`,
   `contour`, `synthesized`, `unresolved`) and image digest from OCR to render. Gate fill on the
   digest and reject mismatched project/source inputs. For synthesized covers, record color sample
   source and padding; avoid painting a whole fused bubble when a split failed.

   Acceptance: 100% of rendered masks have a same-page source digest; no multi-component group
   may reuse the full shared detector polygon after a failed split; fixture replays must report
   bounded cover expansion and zero source/plate identity mismatches.

3. **Fix confidence and make SFX policy explicit (P1).** Treat only `None` as unknown confidence.
   Keep the high-precision SFX rule, but carry its reason and the bubble-confidence evidence into
   the translation/render payload. Decide whether a deliberately translated SFX should also set
   `TYPESET_SFX`, rather than relying on unrelated layer type alone.

   Acceptance: confidence `0` exercises the sign branch; `None` retains the existing default;
   known enclosed dialogue and known short kana SFX retain their current classifications; every
   skipped SFX has a recorded reason.

4. **Validate actual render contracts (P1).** Add a local fixture-based render seam that takes a
   saved image plus serialized OCR/layer payload without HTTP or object storage. Verify visible
   layer filtering, plate/mask bounds, glyph bounds, contrast, and `regionType` propagation.

   Acceptance: no drawn glyph lies outside its permitted plate/halo policy; no OCR layer is drawn;
   all output elements have an explicit layer type and visible state; the six fixtures produce
   deterministic measurement JSON and no image-identity failure is silently accepted.

5. **Make renderer handling of persisted exceptional elements intentional (P1).** Align the
   renderer with the editor’s policy for blank text/manual plates and with the translation-stage
   SFX decision. The archive harness must stay as a regression seam because imported or saved
   projects can carry elements that no current OCR job would create.

   Acceptance: whitespace-only elements either render by an explicit editor-approved rule or are
   skipped; intentional empty manual plates retain their specified plate; persisted SFX behavior
   matches the chosen `TYPESET_SFX` policy; all three synthetic probes have asserted image deltas.
