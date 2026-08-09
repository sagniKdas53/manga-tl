# The bubble mask separates balloons; text distance does not — 2026-08-09

Result of the first cut of `region_grouping_plan_2026-08-09.md`. Short on purpose.

**One line:** the geometric clearance inside the YOLO bubble mask separates same-balloon from
cross-balloon fragment pairs with a **1.6% error rate**; the text-gap distance the merge actually
uses gets **17.8%**. The signal we need has been computed and thrown away on every page.

## What was run

`scripts/region_proposal_probe.py waist` — no worker changes, no cloud spend, no engines beyond the
local PaddleOCR already in the loop.

For each YOLO bubble holding ≥2 fragments: distance-transform the bubble mask, then for every
fragment pair sample the transform along the segment between the two boxes' nearest points and take
the minimum. That minimum is the **waist** — the tightest clearance to the balloon outline anywhere
on the path between the two text blocks. Normalise it by `fs_pair = max(width)` for vertical text,
the same character-size proxy the merge uses.

Pairs are labelled same/cross-balloon from the merge grouping at `0.35`, but **only on pages where
that grouping reproduces the hand count** — `sample1`, `sample3`, `sample30`. 129 pairs, 72 same,
57 cross. Chance error rate 0.442.

## The numbers

| signal | best error | best cut | same-balloon range | cross-balloon range |
|---|---|---|---|---|
| `gap/fs` — what the merge uses today | **0.178** | 1.148 | [0.00, 4.24] | [0.38, 5.56] |
| `waist/fs` — clearance on the nearest-point path | **0.016** | 1.146 | **[1.16, 3.87]** | **[0.00, 1.35]** |
| `waistC/fs` — clearance on the centroid path | 0.085 | 0.881 | [0.23, 3.39] | [0.00, 1.45] |

Read the range columns, not just the error column. `gap/fs`'s two classes overlap over almost their
entire extent — **there is no cut that separates them**, which is the measured form of "0.35 is an
intersection of constraints, not an optimum". `waist/fs`'s classes are nearly disjoint, overlapping
only on 1.16–1.35.

The cut is sayable in words: **two text blocks are in the same balloon if the path between them
stays more than ~1.15 characters clear of the outline.**

All 2 errors are cross-balloon pairs landing just above the cut (1.354, 1.189). **Zero same-balloon
pairs fall below it**, so at this cut the gate never causes a false split — only two false merges.
Since a merger costs more than a split, the cost-optimal cut is probably slightly higher than the
error-optimal one; worth setting once the cost function exists, not now.

## Why this is not circular

The labels come from a **gap-based** grouping, so the comparison is rigged *in gap's favour*. Worse
for gap: every cross-balloon pair is cross precisely because its gap exceeded the merge budget, so
`gap/fs` starts with a construction advantage (hence the 0.38 floor on cross pairs). It still loses
by 11×. The waist has no such advantage.

The honest limitation is the other side of the same coin: this method can only label pages where
the current algorithm is already right, so the four pages where it is *wrong* — `sample9`,
`sample16`, `sample23`, `sample27` — contribute nothing. Confirming the waist on those needs
annotated boxes.

## What this changes in the plan

- **P6 (mask-waist gate) is promoted from last to first among the real phases.** It is the only
  measured signal that separates the classes.
- **The parked track survives too.** Geometric mask splitting before fragment assignment depends on
  the same geometry, and that geometry is now shown to be real. Still the larger change; still
  second.
- **P1–P5 are not cancelled.** Orientation (BUG-6) is independent and still evidenced. Local
  normalisation still has a job at `:663`, where the fragment population genuinely is page-wide —
  and note `:663` has **no mask**, so the waist gate cannot help there at all.
- **`threshold_ratio` should stop being the thing we tune.** The baseline dispersion of the per-page
  optimum is **0.296** (`ablate`, midpoint of each page's best band). That is the number later
  phases have to drive down.

## Also established

- **The harness reproduces the published 7-page sweep exactly** — all 7 pages, all 8 thresholds,
  against `region_threshold_validation_2026-08-08.md` §3. Numbers downstream of it can be trusted.
- **19.4s → 0.57s per page** via the new on-disk cache of the YOLO + PaddleOCR stage. Sweeps are now
  interactive.
- The seven hand counts now live in `scripts/region_truth.json` instead of a markdown table, with
  their ±1 caveats attached.
- **Containment violations are zero on all 7 pages at every threshold.** A genuine null: the failure
  mode is fusion *inside* one bubble, never regions swallowing each other. That metric can be
  dropped.
- **Only 3 of 7 pages can reach their hand count at any threshold.** The other four are detector
  misses or cross-path splits — no merge configuration fixes them, and they should be excluded from
  any threshold ship gate.

## Next

1. **Hand-label `sample9`, `sample16`, `sample27`** — the pages the derived labelling cannot reach.
   `region_proposal_probe.py label` emits a self-contained page per sample: the art with numbered
   OCR fragments overlaid, click to group them, save JSON. Then `waist --labels <dir>`.

   Note what is being annotated and why it is not boxes. The experiment needs a **partition of the
   OCR fragments**, not region rectangles. That is quicker by hand, and — unlike anything derived
   from `corpus/ocr/*/regions.json` — it is independent of the algorithm under test. The existing
   `_review/*.html` pages cannot serve here: they are transcription review built *from* the buggy
   region output, so annotating them would be circular.

2. Extract the `group_fragments` seam with the golden-equivalence test (zero behaviour change).
3. Implement the waist gate behind an off-by-default flag and re-run `ablate`.

## Reproduce

```bash
.venv/bin/python scripts/region_proposal_probe.py waist            # the experiment
.venv/bin/python scripts/region_proposal_probe.py ablate           # metric baseline
.venv/bin/python scripts/region_proposal_probe.py sweep sample30   # reproduction check
```
