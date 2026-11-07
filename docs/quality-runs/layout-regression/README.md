# Layout regression ledger

The owner's rule (2026-11-07): no regression that can't be traced back to its source. Each change that can move text or regroup it gets a row here, and declares what it may touch before it runs. Anything else it moves fails the check.

## The ledger

| # | Change | Merged as | Declared footprint | Boxes moved | Bigger / smaller | Regrouped | Overlapping pairs | Tiny text | Violations | Run on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | Baseline | main f075ec8, worker c8972c3 | none | | | | 90 | 183 | 0 | [baseline](baseline-f075ec8.json), 92 pages, 903 regions |
| 1 | F5 part 1: text alone in a balloon grows into `safe_text`, keeping its outline | #328, then the outline rule in this row's PR | box: `resolved-bubble-container` | 220 | 173 / 0 | 0 | 90 | 173 | 0 | Prediction on all 92 pages. Live on Free ch1 p1 |
| 2 | F5 part 2: text sharing a detector box grows into the measured room (`rays-v1`) | PR pending, worker 9545dab | box: `resolved-local-split` | 71 | 40 / 0 | 0 | 90 | 168 | 0 | Prediction on all 92 pages. Live on B ja p10: all 8 boxes as predicted, the other 91 pages unchanged |

"Tiny" is under 1.5 % of page width, a threshold chosen for comparison. Overlap is two text boxes sharing over 10 % of the smaller one.

## Finding the source of a problem

1. **Which run changed it?** Find the region by its key in the snapshots. A key is a hash of the region's OCR pieces, so it survives a re-OCR that groups them the same way. The first row where it moves is the change.
2. **Which rule?** Each rule writes a marker on the region (`ownership_provenance`) and has its own switch. See the rule's row in the tracker's "Thresholds B tuned".
3. **Why that page?** The capture (`OCR_CAPTURE_DIR`) holds the OCR pieces, and `replay_grouping.py` reruns the grouping with no model calls.

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
- 4 pages are hand-edited: `db322cce`, `ccb6c221`, `2a0cea85` (`test` p5) and `6df55b91`.

## Evidence

Not in the repo: `~/Projects/manga-tl-data-backup/20261107-before-f5-part2/` holds the originals, captures, panels, a database dump and `PROVENANCE.txt`. The next OCR run overwrites the live captures, so this copy is the only "before".

## Rerun

```sh
# Snapshot the stack (add --what-if boxes.json to try other boxes)
node scripts/quality/layout_snapshot.cjs --db-container manga-tl-test-db-1 \
  --renderer-container manga-tl-test-page-renderer-1 --label <name> --out after.json

# Compare, declaring what the change may touch
python3 scripts/quality/compare_layout.py docs/quality-runs/layout-regression/baseline-f075ec8.json after.json \
  --allow-box resolved-local-split --out diff.json

# Replay grouping, in the worker image with this checkout's worker
docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint python -e HOME=/tmp \
  -e PYTHONPATH=/repo/worker/src -v "$PWD":/repo:ro -v <evidence>:/evidence manga-tl-test-worker:latest \
  /repo/scripts/quality/replay_grouping.py --captures /evidence/captures --pages /evidence/pages \
  --panels /evidence/panels.json --out /evidence/replay.json
```
