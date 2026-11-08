# Layout regression ledger

The owner's rule (2026-11-07): no regression that can't be traced back to its source. Each change that can move text or regroup it gets a row here, and declares what it may touch before it runs. Anything else it moves fails the check.

## The ledger

| # | Change | Merged as | Declared footprint | Boxes moved | Bigger / smaller | Regrouped | Overlapping pairs | Tiny text | Violations | Run on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | Baseline | main f075ec8, worker c8972c3 | none | | | | 90 | 183 | 0 | `baseline-f075ec8.json` in the evidence folder, 92 pages, 903 regions |
| 1 | F5 part 1: text alone in a balloon grows into `safe_text`, keeping its outline | #328, with the outline rule from #331 | box: `resolved-bubble-container` | 220 | 173 / 0 | 0 | 90 | 173 | 0 | Prediction on all 92 pages. Live on Free ch1 p1 |
| 2 | F5 part 2: text sharing a detector box grows into the measured room (`rays-v1`) | #331 (main 5803e70), worker #87 (9545dab) | box: `resolved-local-split` | 71 | 40 / 0 | 0 | 90 | 168 | 0 | Prediction on all 92 pages. Live on B ja p10: all 8 boxes as predicted, the other 91 pages unchanged |
| 3 | Worker dependencies: FastAPI 0.162, `rq` 3.0, ruff 0.17.3 (worker #82, #83, #84) | pin at worker 8e61358 | none | 0 | 0 / 0 | 0 | 90 | 168 | 0 | Replay: groups identical on 92 of 92 pages. **No job run on it yet** |
| 4 | #321: outside a balloon, a jump in column tops separates two speakers | worker #88 (ef7d3ea) | grouping: no-balloon text only | not predicted, the new regions have no translation yet | not predicted | 13 groups on 8 pages | 34 to 41 pairs on those 8 pages, overlapped area -23 % | not predicted | 0 groups outside the footprint | Replay on all 92 pages. Live in row 5 |
| 5 | Pilot: rows 1-4 live on 5 pages (`test` p5, p16, p4, `test2` p6, B fixtures p5) | no code | everything on those 5 pages | 2 | 0 / 0 (45 reworded) | 30 regions, 12 more in all | 90 to 97 | 182 to 186 | 0 | Live. The other 87 pages unchanged. Text reworded by re-translation isn't compared for size. 2 boxes moved on `test2` p6 and `test` p16. Awaiting the owner's look |
| 6 | CI checks; worker pin at the golden test | PR pending | none: tests and fixtures only | 0 | 0 / 0 | 0 | 97 | 186 | 0 | The two checks below pass on this code, and fail on deliberately broken code |

"Tiny" is under 1.5 % of page width, a threshold chosen for comparison. Overlap is two text boxes sharing over 10 % of the smaller one.

## Finding the source of a problem

1. **Which run changed it?** Find the region by its key in the snapshots. A key is a hash of the region's OCR pieces, so it survives a re-OCR that groups them the same way. The first row where it moves is the change.
2. **Which rule?** Each rule writes a marker on the region (`ownership_provenance`) and has its own switch. See the rule's row in the tracker's "Thresholds B tuned".
3. **Why that page?** The capture (`OCR_CAPTURE_DIR`) holds the OCR pieces, and `replay_grouping.py` reruns the grouping with no model calls.

## What CI checks

All with no page images, no page text and no model calls, because both repos are public and the pages can't go in them.

| Check | Where | What fails it |
| --- | --- | --- |
| **Ledger rule** (`check_ledger_row.py`) | `ci-layout.yml` | A PR touching the worker pin, the fitter, the renderer or the text-box code without adding a row here. `no-layout-effect` is the explicit way out. CI sees only the pin move, not what changed in the worker, so a tests-only or provenance-only worker bump takes the label too |
| **Layout check** (`layout_ci.cjs`) | `ci-layout.yml`, in the renderer's own image | Any change to a fitted size or line count, over 730 stored boxes with stand-in text (`scripts/quality/fixtures/layout-fixture.json`). Runs when the ledger rule finds a layout path, or when the check's own tooling (`layout_ci.cjs`, `ci-layout.yml`) changes |
| **Grouping check** (`test_grouping_golden.py`) | Worker CI | Any change to grouping, over 91 pages' piece positions. It leaves out the one page whose balloon join needs its image |

Each was checked by breaking things on purpose: turning off each of five grouping rules, or changing a threshold, failed 4 to 26 pages, and changing the outline rule or the line height failed 34 and 189 text objects.

What CI still can't do: judge how a real page looks, or run the real ledger, which needs the stack and the originals. That stays by hand, with the owner's eye as the gate.

When a change is meant, rewrite the fixture in the same PR: `make_grouping_fixture.py` for grouping, `layout_ci.cjs --dump` then `--write` for layout. The fixture's diff and the ledger row then show what moved.

## The tools

All are read only and make no model calls.

| Tool | What it does |
| --- | --- |
| `scripts/quality/replay_grouping.py` | Reruns the worker's grouping from captures |
| `scripts/quality/layout_snapshot.cjs` | Records each region's pieces, boxes and fitted font px. `--what-if` tries other boxes with the same text |
| `scripts/quality/compare_layout.py` | Compares two snapshots and exits 1 on anything undeclared. Tested by `test_compare_layout.py` |
| `scripts/quality/predict_text_boxes.py` | Applies the backend's box rules to a snapshot, for `--what-if`. `--room` uses the worker's own measurement |

Text is stored only as a hash. A reworded translation is counted, not treated as a code effect; re-translating Free ch1 p1 turned "Oh~" (12 px) into "Ooooh~" (6 px) with no code involved.

## How far the tools are proven

Checked on the baseline, on the code it ran:

- **Replay:** 92 of 92 pages reproduce the groups the live OCR recorded.
- **Layout:** 212 of 214 elements rendered by the current renderer get the same font px. Both others hold a ♡, the fallback font difference in [#325](https://github.com/sagniKdas53/manga-tl/issues/325). The other 505 elements were last rendered by an older renderer, so they can't vouch for it.

Not covered:

- **Looks:** none of this checks how a page looks, only boxes, sizes and groups. The owner's eye is still the gate.
- **Corpus pages:** sample177, 222, 61, 93, 83, 197, 641 and sample7 aren't on this machine, so the fixtures here aren't the whole set the tracker names.
- **Cleanup:** masks and cleanup patches aren't compared. A change must not touch them, and its tests say so.

## Prediction and live runs

Rows 1 and 2 are predictions: `predict_text_boxes.py` applies the backend's rules to the stored regions, and the same translated text is fitted into the new boxes. A live re-run is then compared with the prediction.

The prediction repeats backend logic in Python, so the two can drift. A live run is what catches that, and on B ja p10 they agreed exactly: all 8 boxes the same to the pixel, and 7 of 8 font sizes the same. The eighth, 69 predicted and 67 live, was reworded by the re-translation.

**Existing pages are not re-run yet.** Rows 1 and 2 only reach a page when it is next OCR'd or translated. Part 2 and the #321 split share one paid re-run, after the split.

## Known at the baseline

- 12 groups in the captures have no row in the database, on 10 pages (3 of the pages were hand-edited). Most are one piece. Not investigated.
- **Symbols on the host (fixed 2026-11-08):** `layout_snapshot.cjs` used to fit in the host's browser, so text with a symbol Comic Neue lacks took another fallback font than in the renderer ([#325](https://github.com/sagniKdas53/manga-tl/issues/325)). Usually 1 px, but a short line with ♡ in a 26 px box on `test` p16 fit 6 px on the host and 16 px in the renderer. It now fits inside the running renderer (`layout_ci.cjs --fit`), and the fit check went from 293 to 299 of 299 elements matching what the renderer recorded. Snapshots taken before then (their `meta` has no `fitted_in`) can be off by a few px on text with a symbol: on 2026-11-08's stack, 10 sizes by 1–5 px and one line count.
- **Old renders:** a page's saved render can predate the current renderer. On 2026-11-08 three of five pilot "before" images did, and three of five in the sample after it. Compare against a redraw by the current renderer: redrawing two pages that were current gave byte-identical images, which is how the method was checked. Snapshots aren't affected, since they always fit with the current layout code.
- 4 pages are hand-edited: `db322cce`, `ccb6c221`, `2a0cea85` (`test` p5) and `6df55b91`.

## Text collisions (#182)

Snapshots from 2026-11-08 on also record each region's drawn line boxes (read off the renderer's SVG) and
`text_collisions`: pairs of regions whose drawn lines share area. A box overlap that is only padding is
not one. `compare_layout.py` fails on a new collision.

On the test stack (main 23286e3), 55 region pairs on 20 pages collide. Boxes overlapping by more than 10%
catch 51 of them, but 44 of the 95 such overlaps have no colliding text.

`predict_collisions.py` applies the owner's rule for #182: a hand-edited box keeps its shape; otherwise the
bigger source footprint does, then the one with more translated text; the other is trimmed back from it on
the side that keeps the most, and a trim that would leave tiny text or too little box goes to review.

| Trigger | Boxes trimmed | Collisions | Text set smaller | Tiny text | Left for review |
| --- | --- | --- | --- | --- | --- |
| Drawn lines collide | 9 | 55 → 43 | 8 | 188 → 188 | 44: 20 rotated, 18 too little left, 6 tiny |
| Boxes overlap over 10% (all the backend sees before fitting) | 37 | 55 → 42 | 26 | 188 → 188 | 58 |

Of the 44 left for review, 20 are rotated text (E3, #180). That is an upper bound: line and source boxes are
axis-aligned around rotated text, so they overstate overlap. Of the 18 with too little left, 6 have source boxes
overlapping by more than 30%, but checked against the pieces' own outlines only 2 truly share source text. In the
other 4 a small region sits inside the rectangle of a bigger, oddly shaped group, so no trim of the small one can
clear it.

## Evidence

Not in the repo, because run data stays out of it (`.gitignore`): `~/Projects/manga-tl-data-backup/20261107-before-f5-part2/` holds the baseline, originals, captures, panels, a database dump and `PROVENANCE.txt`. `20261108-before-rerun/` holds each page's saved render and scene, a dump and a snapshot from before the re-run, and the pilot's comparison. The next OCR run overwrites the live captures, so this copy is the only "before".

## Rerun

```sh
# Snapshot the stack (add --what-if boxes.json to try other boxes)
node scripts/quality/layout_snapshot.cjs --db-container manga-tl-test-db-1 \
  --renderer-container manga-tl-test-page-renderer-1 --label <name> --out after.json

# Compare, declaring what the change may touch
python3 scripts/quality/compare_layout.py <evidence>/baseline-f075ec8.json after.json \
  --allow-box resolved-local-split --out diff.json

# Replay grouping, in the worker image with this checkout's worker
docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint python -e HOME=/tmp \
  -e PYTHONPATH=/repo/worker/src -v "$PWD":/repo:ro -v <evidence>:/evidence manga-tl-test-worker:latest \
  /repo/scripts/quality/replay_grouping.py --captures /evidence/captures --pages /evidence/pages \
  --panels /evidence/panels.json --out /evidence/replay.json
```
