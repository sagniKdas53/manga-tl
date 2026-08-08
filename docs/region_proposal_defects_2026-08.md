# Region proposal defects — 2026-08-08

Two independent defects in how OCR regions are proposed. They surfaced while building the OCR
corpus out to 40 pages, but **both are production bugs**: the corpus takes its regions from the
production path (`detect_bubbles_yolo` + PaddleOCR background text through
`worker.services.merge_regions.merge_ocr_regions`), so what hurts the benchmark is hurting the
product identically.

Measured over the 291 regions of `corpus/ocr/`:

| defect | regions | share |
|---|---|---|
| A — over-merged `direct_text` chains | see below | part of the 11 "giant" regions (3.8%) |
| B — `bubble` bbox far larger than its polygon | see below | part of the same 11 |
| (tiny false positives, `<45x45`, separate issue) | 12 | 4.1% |

Both produce the same symptom — a crop containing several bubbles' worth of text — so they were
initially mistaken for one problem. They are not, and only one of them is a merge bug.

---

## Defect A — `merge_ocr_regions` chains across bubble boundaries

**Symptom.** `sample23` r1 is a single `direct_text` region of **458x1505 px on a 1200x1600 page**
— essentially the whole page in one box. `sample23` r2 is 417x1223.

**Cause.** `merge_ocr_regions` builds an adjacency graph over PaddleOCR line fragments and takes
**connected components** (BFS). Fragments merge when, among other conditions:

```python
(y_overlap > 0 and x_dist <= max_horizontal_gap)      # max_horizontal_gap = avg_width * 0.50
```

For vertical Japanese text, adjacent columns *within one balloon* sit roughly half a character
apart, so this rule is correct locally. The failure is that adjacency is **transitive and
unbounded**: balloon A's leftmost column is within half a character of balloon B's rightmost, B
reaches C, and one BFS component swallows a whole page column. No condition references balloon
membership, so nothing stops the chain.

**Why it matters beyond the benchmark.** Downstream, a merged region is one translation unit with
one background colour and one typeset target. Chaining two speakers' balloons into a single region
merges unrelated dialogue into one translation request and one rendered block.

**Proposed fix — constrain merging by bubble membership.** `detect_bubbles_yolo` already runs
*before* the background-text pass in the same handler, and its boxes are in the same region list,
so the needed data is present and free. Rule: two fragments may merge only if they lie inside the
**same** detected bubble, or if neither lies inside any bubble. That preserves every intended
in-balloon merge and forbids exactly the cross-balloon chain.

A blunter fallback — capping a component's width/height at a plausible balloon size — treats the
symptom and would still mis-merge two small adjacent balloons. Prefer the membership rule.

**Risk.** This is shipped worker code (`manga-tl-worker`, 315-test baseline) on the live
translation path, so it changes user-visible output, not just measurements. Needs its own tests
and an explicit go-ahead.

---

## Defect B — irregular bubbles crop as their axis-aligned bbox

**Symptom.** `sample3` r2/r3/r4 and `sample30` r2/r3/r4 are `type: bubble` regions around 330x900.
Nothing merged them — YOLO emitted them directly.

**Cause.** The balloon is genuinely irregular or diagonal, so its axis-aligned bounding box is far
larger than the balloon. Measured polygon fill:

| region | bbox | bbox area | polygon area | fill |
|---|---|---|---|---|
| `sample3` r2 | 326x901 | 293,726 | 188,554 | **64%** |
| `sample30` r4 | 293x1031 | 302,083 | 194,476 | **64%** |

So **36% of the cropped pixels are outside the balloon** — neighbouring art and, worse,
neighbouring *text*, which the engine dutifully transcribes. That is why these regions never reach
consensus: engines disagree about text that shouldn't be in the crop at all.

The region already carries the balloon outline in its `polygon` key. `crop_for_region(img, bbox,
pad=10)` ignores it and slices the rectangle.

**Proposed fix — mask outside the polygon before cropping.** Fill everything outside the polygon
with the page background (white) so the engine sees the balloon and nothing else. The data is
already stored; this is a change at crop time only, touching no detection or merge logic.

**Risk.** Low and contained. `crop_for_region` has 4 call sites, all in benchmark/corpus scripts,
all passing `(img, bbox)`; the masking goes behind an opt-in parameter that defaults to off.

---

## Order of work

1. **Fix B first** — it is cheap, isolated, and measurable on its own: re-run the local engines on
   `sample3`/`sample30` with masking on and see whether consensus recovers.
2. **Then decide on A** from that evidence. If B alone lifts those pages, A stays a known
   production defect to schedule separately rather than a blocker for the corpus.

Note that either fix changes the *region proposals*, which invalidates every stored `candidate`
(they were transcribed from the old crops). Establish the clean baseline first, then treat region
work as its own round.
