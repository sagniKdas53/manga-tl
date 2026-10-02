# M5 grouping repair handoff

## Status

**M5 is active; G5 is blocked and MUST NOT be marked passed.**

The original M5 owner/provenance work is complete enough to produce fresh evidence, but output grouping and fitting remain below the user-specified quality bar:

- `sample61`: original page-wide components are gone, but dense framed UI-card text remains over-compressed.
- `sample177`: free-standing captions remain local to the illustration grid, but the top title/note are coalesced and two expected captions are missing.
- No claim has been made that the new output is acceptance quality.

The user asked to resume tomorrow. Start from the raw-group fixture work below; do **not** rerun paid provider pipelines before a local regression proves the intended groups.

## User acceptance reference

The user supplied source artifacts and expected visual targets:

| Fixture | Source | Fresh final output | Required structure |
|---|---|---|---|
| `sample61` | `corpus/samples/ja/sample61/source.jpg` | `docs/quality-runs/g5-20260917-final-six/a04-exports/sample61/editor.png` | Each dark framed UI text card remains a separate translation unit; no text crosses cards or character art. |
| `sample177` | `corpus/samples/ja/sample177/source.jpg` | `docs/quality-runs/g5-20260917-final-six/a04-exports/sample177/editor.png` | Title and note are separate as required; six character captions stay local to their intended illustration. |

Historical `corpus/samples/.../export.png` is **not** a quality oracle: it also coalesces groups too aggressively.

## What changed

### Removed obsolete renderer UI

- `frontend/src/components/Reader.tsx`
- `frontend/src/components/ReaderRightSidebar.tsx`
- `frontend/src/__tests__/components/ReaderRightSidebar.test.tsx`

`Export Rendered PNG` and its handler/props were removed. The live UI now exposes only `Export Page (PNG)` and `Export Project (ZIP)`.

The page-renderer service was intentionally not deleted. It is no longer reader-export UI, but deleting its scene/ledger path is a separate architecture cutover.

### Corrected renderer recovery log spam

- `backend-rust/src/jobs/recovery.rs`

`process_pending_renders` previously logged `Debounced render triggered` before it knew a canonical page-scene render could be enqueued. Legacy pages without snapshots repeated this INFO line every recovery cycle. It now logs only an actual enqueue:

```text
Debounced render enqueued for page: <page-id>
```

Focused test passed:

```bash
cd backend-rust
scripts/test-env.sh run cargo test --test jobs_endpoints recovery_reset_stale_and_debounced_render -- --exact
scripts/test-env.sh down
```

### Restored normal translation and QA scheduling

- `worker/src/worker/handlers/translation.py`
- `worker/src/worker/handlers/qa.py`
- `worker/tests/test_translation_pipeline.py`
- `worker/tests/test_qa_policy.py`

M3 `review` metadata had been incorrectly used as a translation scheduling veto, producing a zero-element Translation layer. Default review candidates now still follow:

```text
OCR → translation → visual QA → reject/hide SFX as needed → Export Page (PNG)
```

Only explicit `preserve` and `explain` user overrides bypass provider translation.

### Existing owner/provenance work

Worker files changed during M5:

- `worker/src/worker/services/owner_assignment.py`
- `worker/src/worker/services/merge_regions.py`
- `worker/src/worker/services/fragment_grouping.py`
- `worker/src/worker/handlers/ocr.py`
- `worker/tests/test_owner_assignment.py`
- `worker/tests/test_fragment_grouping.py`
- `worker/tests/test_merge_regions.py`
- `worker/tests/test_ocr_grouping.py`
- `worker/tests/test_ocr_grouping_wiring.py`

The narrow bubble-edge fallback remains intentionally constrained:

```text
geometry-attached-continuous-lines
```

It permits exactly two continuous adjacent lines only when one is in one validated bubble and the other lies immediately over the detector edge. It MUST NOT bridge distinct bubbles, styles, or larger unknown components.

### Current pre-merge direct-text partition

- `worker/src/worker/handlers/ocr.py`
- `worker/src/worker/services/panel_detection.py`

Unmatched OCR fragments are partitioned by the **smallest containing source container** before grouping:

```text
persisted backend panel bounds
+ nested dark rectangular text containers
```

`partition_unmatched_fragments_by_panel` accepts both formats:

```python
{"x", "y", "width", "height"}
{"bboxX", "bboxY", "bboxW", "bboxH"}
```

`detect_text_containers(image)` uses dark source contours and keeps only closed rectangular candidates:

- minimum 0.3% page area
- width >= 80 px
- height >= 50 px
- exactly four approximated vertices
- at least 60% contour rectangularity

This eliminated `sample61` page-scale components, but does not yet recover correct dense-card text fitting or all `sample177` labels.

## Evidence timeline

| Run | Meaning | Result |
|---|---|---|
| `docs/quality-runs/g5-20260916-scheduling-repair/` | Translation scheduling correction. | `sample177` Translation layer populated again. |
| `docs/quality-runs/g5-20260916-geometry/` | First six-page owner/provenance run. | Demonstrated original oversized-group failure. Not a pass. |
| `docs/quality-runs/g5-20260916-bounded-direct-text/` | Rejected member-cap experiment. | 146 OCR elements, 14 translation elements, ~US$0.098; reverted. |
| `docs/quality-runs/g5-20260917-panel-partition/` | Broad existing-panel partition. | 55 OCR elements; improved column separation but insufficient nested-card granularity. |
| `docs/quality-runs/g5-20260917-nested-containers/` | Nested dark-container partition. | 24 OCR elements; page-scale region gone; dense text still compressed. |
| `docs/quality-runs/g5-20260917-free-labels/` | Free-label behaviour. | Local captions; top header still coalesced. |
| `docs/quality-runs/g5-20260917-final-six/` | Current six-fixture baseline. | All pipelines completed; structural improvement only, **not G5 pass**. |

Current checkpoint record:

- `docs/quality-checkpoints/F04.md`
- `docs/output-quality-implementation-tracker.md`

## Fresh final-six facts

Run:

```text
docs/quality-runs/g5-20260917-final-six/
```

Fixtures:

```text
sample177, sample222, sample61, sample99, sample93, sample83
```

All ran local PP-OCRv6 Japanese OCR, OpenRouter `openai/gpt-5.6-luna` translation, and visual QA. The capture deliberately used `--skip-rendered`: immutable canonical `/rendered` output is not the active legacy pipeline surface.

The isolated stack was stopped after capture.

## Next implementation: fixture first, then runtime

1. **Freeze raw OCR regressions locally, without provider calls.**
   - Extract/construct exact expected source-space group memberships for sample61’s framed text cards.
   - Extract/construct sample177’s title, note, and six caption groups.
   - Test observable output of `group_fragments` / `merge_ocr_regions`, including final source bounds. Do not assert source text or incidental fields.

2. **Tighten direct-label grouping.**
   - The current unmatched path still has an overbroad free-label header component in sample177.
   - Split by local geometry and reading order without reviving a global transitive graph.
   - Preserve conservative unknown/review states when no valid container or local sequence exists.

3. **Improve dense-card fitting only after groups are fixed.**
   - `sample61` text remains too compressed inside valid framed cards.
   - This is a renderer/text fitting concern, not evidence that cards should be re-merged.

4. **Run focused worker tests and static checks.**

```bash
cd worker
../.venv/bin/python -m pytest -q tests/test_owner_assignment.py tests/test_fragment_grouping.py tests/test_merge_regions.py tests/test_ocr_grouping.py tests/test_ocr_grouping_wiring.py
../.venv/bin/python -m ruff check src/worker/services/owner_assignment.py src/worker/services/merge_regions.py src/worker/services/panel_detection.py src/worker/handlers/ocr.py tests/test_owner_assignment.py tests/test_ocr_grouping_wiring.py
../.venv/bin/python -m ruff format --check src/worker/services/owner_assignment.py src/worker/services/merge_regions.py src/worker/services/panel_detection.py src/worker/handlers/ocr.py tests/test_owner_assignment.py tests/test_ocr_grouping_wiring.py
../.venv/bin/python -m pyright src/worker/handlers/ocr.py src/worker/services/panel_detection.py
```

5. **Only then run a clean isolated one-fixture capture** for the changed fixture. Use Compose project scoping explicitly:

```bash
docker compose -p manga-quality-g5-20260916 -f docker-compose.dev.yml down -v --remove-orphans
DEV_HTTP_PORT=18086 docker compose -p manga-quality-g5-20260916 -f docker-compose.dev.yml up --build
node scripts/playwright/capture_quality_baseline.cjs \
  --out docs/quality-runs/<new-run-name> \
  --base http://localhost:18086/tlhub \
  --register --skip-rendered --fixture sample61
```

Never use only `DEV_PROJECT_NAME`; it did not provide reliable Compose project isolation. Use `docker compose -p manga-quality-g5-20260916`.

6. After one-fixture proof, capture all six fixtures fresh and perform UR03 source-pixel review. Only that can unblock/complete G5.

## GitNexus requirements

Repository rules require upstream impact analysis before editing any existing function/class/method. Relevant prior impact results:

| Symbol | Repo | Risk |
|---|---|---|
| `assign_captured_owners` | `manga-tl-worker` | HIGH — user was warned. |
| `_translation_qa_regions` | `manga-tl-worker` | HIGH — user was warned. |
| `group_fragments` | `manga-tl-worker` | HIGH — user was warned. |
| `process_ocr` | `manga-tl-worker` | LOW. |
| `process_pending_renders` | `manga-library` | LOW. |
| `handleExportRenderedPng` | `manga-library` | LOW. |

Run fresh impact for any symbol touched tomorrow:

```bash
node .gitnexus/run.cjs impact <symbol> --repo manga-tl-worker --direction upstream --include-tests
node .gitnexus/run.cjs impact <symbol> --repo manga-library --direction upstream --include-tests
```

Warn the user before editing any HIGH/CRITICAL impact target. Do not commit unless requested; before any commit run `detect_changes` for the parent repo and separately for the worker submodule.

## Important constraints

- Worker is its own GitNexus repo: `manga-tl-worker`.
- Python runs only through project root `./.venv`; do not run global `pip`.
- Do not delete the page-renderer service merely because the Reader export button was removed.
- Do not restore an `Export Rendered PNG` fallback to legacy output.
- Preserve all old quality evidence; failed experiments are useful evidence and are already recorded.
- Do not call G5, F04, M5, or output quality passed based solely on completed pipelines or populated layers.
