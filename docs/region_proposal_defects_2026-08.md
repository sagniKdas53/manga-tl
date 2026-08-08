# Region proposal defects — 2026-08-08

> **Superseded in part, 2026-08-08 (later).** Testing on `sample3` against its human reference
> showed the framing below is wrong for the pages that motivated it. The reference translator
> treats **every balloon separately** — 9 balloons, 9 text areas, no cross-balloon grouping — and
> reproducing that turns out to need no detector change and no new merge rule, only the right
> split threshold. See "What sample3 actually showed" at the end. Defect A as described (chaining
> in `merge_ocr_regions` over *unmatched* fragments) is real but marginal: on sample3 only 2 of 29
> fragments ever reach that path.
>
> **Superseded further, 2026-08-08 (later still).** Validated on 7 pages: the threshold finding
> holds, but the value is **0.35**, not ≤0.5. And defect A's flagship example (`sample23` r1) is
> a **reading-direction bug**, not chaining. Read the last two sections of this file, and
> `region_threshold_validation_2026-08-08.md`.

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

## Measured result of fix B (2026-08-08)

`scripts/polygon_mask_crops.py --min-fill 0.70`, PP-OCRv6_medium, 36 regions:

| outcome | regions |
|---|---|
| masked text **shorter** — cross-balloon spill removed | 12 |
| same length (reordering / character swaps) | 22 |
| longer | 1 |
| **masked to empty** — polygon too tight | 1 |

Clear wins where a neighbour's text was bleeding in: `sample10` r7 `121212122待って` → `待って`;
`sample3` r1 shed a trailing `といずっ私の` belonging to the next balloon; `sample7` r8 dropped a
`頑不` tail. Genuine recognition gains too, from removing distracting context: `sample6` r1
`ぶコとばすねよ` → `ぶっとばすねよ`.

The tail risk is real: `sample6` r4 (34% fill) masked to **empty**, i.e. the polygon excluded the
text. Masking should therefore fall back to the bbox reading when the masked crop yields nothing.

## Fix B does not subsume fix A — they are disjoint

| region type | count | has polygon | masking applies |
|---|---|---|---|
| `bubble` | 214 | yes (all) | yes |
| `direct_text` | 77 | **no (none)** | **no — pass-through** |

Defect A is entirely a `direct_text` phenomenon, and `direct_text` regions carry no polygon at
all. So masking is a literal no-op on exactly the regions defect A produces — `sample23` r1
(458x1505) and r2 (417x1223) are untouched by it. Choosing between the two fixes is a false
choice; they address different regions and neither covers the other.

## Evaluating B properly costs money

Its effect on *consensus* cannot be judged from the local engines alone. The vote compares paddle
against qwen and gemini, so masking paddle's crops while the cloud candidates still come from
unmasked ones would recreate precisely the defect fixed earlier today (engines voting on different
images). A valid measurement needs the cloud engines re-run on masked crops.

## Order of work

1. **B** — apply masking to *all* engines at once, with the empty-result fallback, and re-tier.
   Costs one cloud pass.
2. **A** — decide on production grounds, not corpus coverage. It affects only 5 large regions
   here, but downstream a merged region is one translation unit with one background colour and
   one typeset target, so chaining two speakers' balloons corrupts the output, not just the
   measurement.

Either fix changes region proposals, which invalidates every stored `candidate` (they were
transcribed from the old crops). Do them together rather than paying for two cloud passes.

---

## What sample3 actually showed (2026-08-08, later)

**Hypothesis under test:** professional translators identify each balloon separately and never
guess which connects to which. Detection is the crucial step; merging can always happen later.
Under-segmenting is recoverable, over-segmenting is not.

**Confirmed.** The human reference for `sample3` has 9 balloons and treats each as its own text
area. Reproducing that needs no change to YOLO and no new merge rule — only the split threshold.

### The measurements

`sample3`: YOLO returns **4** bubbles for **9** balloons, because the balloons visually touch and
a single-class segmenter fuses them into blobs. 27 of 29 PaddleOCR fragments land inside those 4
blobs; only **2** are unmatched. So on this page the unmatched-fragment merge — defect A above —
governs 2 fragments and is nearly irrelevant.

Three proposal strategies, and then a sweep of the in-bubble split threshold:

| strategy | regions | giant (>½ a page dimension) |
|---|---|---|
| A — current benchmark: YOLO bubbles as-is | 5 | 3 |
| B — split each bubble by its internal fragment clusters, `threshold_ratio=2.0` (production) | 6 | 1 |
| C — no merging at all, one region per raw fragment | 29 | 0 |
| **B at `threshold_ratio` ≤ 0.5** | **9** | **0** |

| `threshold_ratio` | regions |
|---|---|
| 0.15 – 0.50 | **9** — matches the reference |
| 0.75 – 1.0 | 8 |
| 1.5 – 2.0 | 6 |

At ≤0.5 each region maps to one balloon, and the DCG Corporation name badge separates from the
dialogue on its own — the "identify separately, merge later" behaviour, for free.

Strategy C (no merging) over-segments: a fragment is one *vertical column*, so a balloon becomes
3–4 regions. The hypothesis is right about the principle but the unit is the balloon, not the
text line.

### The two real defects

1. **`get_all_text_regions` in `scripts/benchmark_vlm_ocr.py` never splits a bubble.** It emits
   each YOLO detection as one region. Production (`worker/handlers/ocr.py:605`) *does* split, via
   `merge_ocr_regions(assigned_frags, threshold_ratio=2.0)`. **So the corpus is built from worse
   region proposals than the pipeline it is meant to measure** — the benchmark has been scoring
   engines on crops the product would never hand them. This is a benchmark bug, not a product one,
   and it is the direct cause of the giant regions in `corpus/ocr/`.

2. **`threshold_ratio=2.0` at that production call site is too permissive.** It under-splits
   touching balloons: 6 regions where the reference has 9. The evidence says ≤0.5, and 0.50 is
   already the module-wide default (`OCR_MERGE_THRESHOLD`) — so the 2.0 override is the outlier,
   and dropping it is a smaller change than it looks.

Note the ordering consequence: fixing (1) alone lifts the corpus to production parity; fixing (2)
changes shipped behaviour and needs tests. They are separable, and (1) is free of product risk.

### Still open — **resolved 2026-08-08 (later still)**

- ~~Validate the threshold on more pages~~ — **done on 7 pages**, see
  `region_threshold_validation_2026-08-08.md`. The finding holds in direction on all of them, but
  the value tightens: **0.35**, not ≤0.5. `sample30` breaks at exactly 0.50; `sample3`'s band
  happened to reach it. `sample30` otherwise reproduces `sample3` exactly — 7 regions, 1:1 onto
  7 balloons.
- `sample23` behaved as predicted: constant across the in-bubble sweep, so defect A's path is
  correctly separated from the split threshold. But its giant regions turned out to be a
  **reading-direction bug**, not chaining — see below.
- Both fixes change region proposals, invalidating every stored `candidate`. Bundle them with the
  polygon-masking work (fix B) so the cloud engines are re-run once, not three times.

### Defect A's headline evidence does not survive (2026-08-08, later still)

`sample23` r1 (458×1505) was defect A's flagship example. It is not connected-components
chaining. All 61 fragments on that page are horizontal (avg 214×33; 61/61 wider than tall), and
`merge_ocr_regions` treats `reading_direction == "rtl"` as "text is vertical", sizing the
vertical gap budget from `avg_width` — a whole line. Merging the same fragments with `ltr` gives
exactly the hand count of 17, stably across `threshold_ratio` 0.25–1.0.

`reading_direction` is a binding / page-order setting (`ocr.py:339`), not a text-orientation one.
The two coincide for typical manga, which is why the comment at `merge_regions.py:103` says
"typically" — but every Japanese job is `rtl`, so every horizontally-set Japanese page gets
vertical geometry.

Defect A's transitive-chaining argument may still hold on a genuinely vertical page. It needs
different evidence, and it should be re-assessed only after the direction bug is fixed.
