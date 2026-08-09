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

> **Final, 2026-08-09 (latest).** `sample9`, `sample23` and `sample27` were re-annotated by hand.
> The corrected labels **overturn the pooled claim**: page-wide the waist now *loses* to text
> distance, 0.381 against 0.202. But at the level the gate actually operates — the individual YOLO
> bubble — the picture is sharp and shippable: **on every bubble whose mask is genuinely pinched
> (solidity < 0.90) the waist separates balloons with zero errors, 8 bubbles out of 8.** Above that
> it is unreliable and should not fire. Read "The bubble-level result" at the end; it supersedes
> both sections below.

> **Revised 2026-08-09 (later), on hand annotations.** The first pass below used labels derived
> from the algorithm's own output, which only works on pages where it is already right — three easy
> ones. With hand-annotated balloon partitions on six pages the finding **holds but narrows**: the
> waist wins on 4 of 5 scorable pages and is *perfect* on both fused-balloon pages, but it **loses
> badly on `sample27`**. See "What the hand labels changed" at the end. Read that section before
> acting on the numbers immediately below.

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

---

## What the hand labels changed (2026-08-09, later)

Balloon partitions were annotated by hand for all seven pages (`corpus/ocr/_region_probe/`, click-to-group
via `label` mode). Six are usable. Per page:

| sample | same | cross | chance | gap err | **waist err** | waist cut | |
|---|---|---|---|---|---|---|---|
| `sample3` | 43 | 35 | 0.449 | 0.192 | **0.000** | 1.393 | waist wins |
| `sample30` | 19 | 13 | 0.406 | 0.156 | **0.000** | 0.979 | waist wins |
| `sample9` | 120 | 20 | 0.143 | 0.121 | **0.071** | 0.967 | waist wins — but see below |
| `sample16` | 32 | 17 | 0.347 | 0.286 | **0.245** | 0.741 | waist wins, both poor |
| `sample27` | 18 | 21 | 0.462 | **0.077** | 0.308 | 1.854 | **waist loses** |
| `sample1` | 19 | 0 | — | — | — | — | one class only |

Pooled: gap 0.289, waist 0.171, waistC 0.188, against a chance rate of **0.297**.

**Three things to take from this.**

1. **The waist is perfect on exactly the pages that have the bug.** `sample3` and `sample30` are the
   fused-touching-balloon pages — BUG-2 itself — and on both the waist separates the classes with
   **zero errors**. The mechanism is real and it is precisely targeted.

2. **`gap/fs` pooled is 0.289 against a chance rate of 0.297.** Page-wide, the signal the merge
   currently runs on is **no better than guessing "everything is one balloon"**. That is a stronger
   statement than the first pass made, and it is the real indictment of tuning `threshold_ratio`.

3. **`sample27` reverses the result and must not be explained away.** There, gap gets 0.077 and the
   waist 0.308. That page is the *over-splitting* one, and its panel-2 shout is a borderless blob
   where YOLO drew a bubble around only half the text — so the mask is not a balloon outline and its
   clearance means nothing. **The waist is only as good as the mask.** Any gate built on it needs an
   applicability condition, and it should be a *veto* (able to block a merge, never to force one)
   so that a bad mask degrades toward current behaviour instead of inventing splits.

**Do not pool these numbers.** `sample9` contributes 120 same-pairs against 20 cross — it dominates
any pooled figure while having the least balanced, least trustworthy labels on the page set.

### Two annotation defects to fix before the next round

- **`sample23` is unusable.** The annotation covers 52 fragments; the page has 61. The loader's
  staleness guard rejects it. Re-annotate. It is also the one page with zero YOLO bubbles, so it can
  never contribute to the waist experiment anyway — its value is to the orientation work (BUG-6).
- **`sample9`'s annotation and its hand count contradict each other** — 11 groups against a hand
  count of 18, and *fewer* groups than the 15 regions the current buggy algorithm produces. One of
  the two is wrong. Until that is resolved, `sample9`'s 0.071 should not be quoted.
- Note also that the two duplicate annotations (`sample1`, `sample3`) are identical **including the
  arbitrary order of group IDs**, so they are not independent annotations and provide no
  inter-annotator agreement figure.

---

## The bubble-level result (2026-08-09, final)

`sample9`, `sample23`, `sample27` re-annotated by hand. `sample9` changed most: 11 groups → 16
(against a hand count of 18), and that alone flipped the page from "waist wins 0.071" to "waist
loses 0.364". **The earlier 1.6% figure was an artifact of bad labels and is withdrawn.**

Per page, on corrected labels:

| sample | gap err | waist err | |
|---|---|---|---|
| `sample3` | 0.192 | **0.000** | waist wins |
| `sample30` | 0.156 | **0.000** | waist wins |
| `sample16` | 0.286 | **0.245** | waist wins, both poor |
| `sample9` | **0.143** | 0.364 | waist loses |
| `sample27` | **0.077** | 0.308 | waist loses |

Pooled: gap 0.202, waist 0.381, chance 0.473. **Page-wide, the waist is not a replacement for
distance.** That claim is dead.

### But the gate does not operate page-wide

It operates per bubble. Scored per bubble, and bucketed by **mask solidity** (polygon area ÷ convex
hull area — a fused pair of balloons is pinched and non-convex; a single balloon is nearly convex):

| solidity | bubbles | mean gap err | **mean waist err** |
|---|---|---|---|
| < 0.85 — strongly pinched | 7 | 0.144 | **0.000** |
| 0.85 – 0.90 | 1 | 0.000 | **0.000** |
| 0.90 – 0.95 | 5 | 0.107 | 0.120 |
| ≥ 0.95 — convex | 2 | 0.062 | 0.317 |

**Zero errors on all 8 bubbles below 0.90**, spanning `sample3` (×4), `sample30` (×3) and `sample9`
(×1). The degradation above it is *monotone* — 0.000 → 0.120 → 0.317 — which is what a real
mechanism looks like rather than a fitted cut. Two bubbles just above the line (`sample16` at 0.911
and 0.912) score 0.000 and 0.067, so anywhere in **0.90–0.92** works on this data; the exact value
is not established by 15 bubbles and should not be treated as a constant yet.

Solidity is also a usable fusion detector on its own: **9 of 12** bubbles below 0.90 genuinely hold
more than one balloon, against **7 of 21** above it.

That is an applicability condition computable from the mask alone, with no labels, before any
merge decision — and it is principled rather than fitted: a bubble containing two touching balloons
is *non-convex by construction*, which is the same geometry the waist measures.

### The rule this yields

```
if bubble_mask_solidity < 0.90:      # this blob is pinched -> probably >1 balloon
    veto merges whose waist/fs_pair < ~1.0        # never force a merge, only block one
else:
    leave today's distance behaviour untouched
```

A veto, not a merger: where the mask is poor the gate simply does not fire and behaviour degrades
to what ships today. That is what makes `sample27` safe — its borderless shout sits at solidity
0.958 and would be skipped entirely.

### What this does not establish

- **15 scorable bubbles, 8 below the cut, from 3 pages.** Small. The 0.90–0.92 boundary is read off
  this data and wants confirmation before it becomes a constant.
- **The rule is deliberately conservative and leaves the single biggest fused bubble unfixed.**
  `sample9` bubble 0 holds 16 fragments across multiple balloons at solidity **0.977** — genuinely
  fused but not pinched, so the rule skips it, and it alone is 120 of that page's 140 scored pairs.
  Skipping is the right failure direction (no change, rather than a wrong split), but it means the
  waist gate does **not** address most of `sample9`. Whatever fixes that bubble is a different
  mechanism — most likely the alignment and size gates.
- **Near-convex fused bubbles are the majority case.** 7 of 21 bubbles above 0.90 are truly fused.
  The gate as specified will never fire on them.
- **Nothing here has been run through region counts yet.** Separation of labelled pairs is not the
  same as better region proposals; `ablate` is what closes that gap, and it needs the gate
  implemented first.

---

## The gate implemented, and what it does to region counts (2026-08-09)

Pair separation and region counts are different claims. This is the second one.

Implemented as `GroupingConfig.waist_gate` + `GroupingContext` in
`worker/src/worker/services/fragment_grouping.py`, off by default. Region counts per page, gate at
1.0 characters, applied only below solidity 0.90:

| sample | truth | today `2.0` | threshold fix `0.35` | **gate only `2.0`** | **both `0.35`** |
|---|---|---|---|---|---|
| `sample3` | 9 | 6 (−3) | 9 (0) | 6 (−3) | **9 (0)** |
| `sample30` | 7 | 4 (−3) | 7 (0) | **7 (0)** | **7 (0)** |
| `sample1` | 4 | 3 (−1) | 4 (0) | **4 (0)** | **4 (0)** |
| `sample16` | 10 | 8 (−2) | 9 (−1) | 8 (−2) | 9 (−1) |
| `sample9` | 18 | 11 (−7) | 15 (−3) | 13 (−5) | **17 (−1)** |
| `sample27` | 18 | 15 (−3) | 20 (+2) | 16 (−2) | 21 (+3) |
| `sample23` | 17 | 2 (−15) | 2 (−15) | 2 (−15) | 2 (−15) |
| **Σ\|err\|** | | **34** | 21 | 27 | **20** |
| **Σ\|err\| excl. `sample23`** | | **19** | 6 | 12 | **5** |

`sample23` has zero YOLO bubbles, so no configuration here can touch it — it is the orientation
bug (BUG-6), and it alone accounts for 15 of today's 34.

**Four things this establishes.**

1. **The gate and the threshold are complementary, not alternatives.** The gate alone fixes
   `sample30` and `sample1` completely; the threshold alone fixes `sample3`; only together do they
   get `sample9` from 11 to 17 against a truth of 18. Neither substitutes for the other.

2. **The gate fixes `sample30` at production's current `2.0`, changing no threshold at all.**
   4 → 7 regions, exactly the hand count, purely from the mask geometry. That is BUG-2 fixed
   without touching a tuned constant.

3. **It makes the threshold stop mattering, which was the whole point.** `sample30`'s exact-match
   band widens from 3 grid steps to **all 8**; `sample1`'s from 6 to 8. A page that hits its hand
   count at every threshold from 0.15 to 2.0 is no longer being held together by a constant.

4. **The errors change character, and that matters more than the totals.** Today every page is
   under-segmented — six pages, −19 in total, all *mergers*, which fuse two speakers into one
   translation unit and one flat fill. Under "both" that becomes −2 of merger error plus +3 of
   split error on `sample27`. Splits usually typeset back into the same balloon acceptably;
   mergers are unrecoverable. **Converting 19 units of merger into 2 merger + 3 split is a larger
   win than the Σ|err| 21 → 20 makes it look**, and it is the trade the asymmetric cost function
   was written to express.

**The cost, stated plainly:** `sample27` gets worse, 20 → 21 against a truth of 18. It was already
the only over-splitting page, part of it is the borderless shout no configuration can join, and
the gate adds one more split on top. That is the price, it is in the cheap direction, and it should
not be hidden in a total.

**Still not established:** whether better region proposals produce better *transcriptions*. That
needs the bundled cloud re-run, and nothing here anticipates it.

## The local bench, 2026-08-09 — the regrouping is character-neutral

`region_proposal_probe.py bench` scores a configuration on an *order-invariant multiset of
normalised characters* against the corpus text, because the configurations produce different
numbers of regions and any metric keyed to the existing boxes measures the regrouping rather than
the transcription. `--transcribe` re-OCRs each proposed crop, which is what the corpus and the
cloud VLMs consume; without it the metric is insensitive by construction, since regrouping the
same fragments cannot change the joined character bag.

Forty pages, each region's crop re-read with PP-OCRv6_medium
(`corpus/runs/2026-08-09/region-grouping/`):

| config | regions | Σ\|err\| | M | S | cost | cover | charP | charR |
|---|---|---|---|---|---|---|---|---|
| production | 282 | 34 | 17 | 2 | 87 | 0.591 | 0.953 | **0.928** |
| threshold | 339 | 21 | 5 | 5 | 30 | 0.512 | 0.954 | **0.928** |
| geometry | 321 | 12 | 11 | 5 | 60 | 0.557 | 0.948 | **0.928** |
| proposed | 364 | 5 | 2 | 7 | 17 | 0.495 | 0.949 | **0.928** |

**Character recall is identical across all four.** 29 of 40 pages are byte-identical in text; of
the 11 that move, 7 gain recall and 2 lose it. So the regrouping costs nothing in characters while
taking mergers 17 → 2 — which is the deploy gate, and it passes. `cover` is agreement with the
*existing* boxes and necessarily falls when a configuration splits more; it measures how much of
the corpus a deploy invalidates, not quality.

### A negative result worth not repeating: crop padding

`sample10` (a countdown timer, four ~25px lines whose boxes already overlap) loses precision under
`proposed`, 0.903 → 0.791, because `crop_for_region`'s fixed 10px pad pulls each neighbour into the
crop and the digits are transcribed two and three times. Five ways of clipping that margin were
measured; **every one cost more recall than it bought precision**, including on `production` boxes:

| variant | production P / R | proposed P / R |
|---|---|---|
| A — fixed 10px, no clipping (shipped) | 0.957 / **0.917** | 0.937 / **0.919** |
| B — clip at midpoint to a sibling | 0.953 / 0.822 | 0.953 / 0.845 |
| C — B + margin capped at 15% of the box | 0.948 / 0.819 | 0.948 / 0.842 |
| D — B but never clipping into the bbox | 0.956 / 0.909 | 0.953 / 0.910 |
| E — D + neighbour must share ≥50% | 0.956 / 0.910 | 0.955 / 0.909 |

The 10px margin turns out to be load-bearing: PaddleOCR's detection boxes are tight enough to clip
glyph edges, and B removing it costs ~0.10 recall on pages of narrow vertical columns. D and E are
the geometrically sound versions and *still* lose recall, because a region whose box genuinely
overlaps its neighbour's cannot be padded without either duplicating text or dropping it — the two
cases have the same geometry and no threshold separates them (`sample6`, two balloons overlapping
24×113px). Recall is the gate, so A stands. **A real fix has to work on the text — drop characters
the neighbouring crop also produced — not on the box.**

## Reproduce

```bash
.venv/bin/python scripts/region_proposal_probe.py label            # annotation pages, all samples
.venv/bin/python scripts/region_proposal_probe.py waist            # the experiment
.venv/bin/python scripts/region_proposal_probe.py ablate           # metric baseline
.venv/bin/python scripts/region_proposal_probe.py sweep sample30   # reproduction check
.venv/bin/python scripts/region_proposal_probe.py rdcl             # mergers vs splits
.venv/bin/python scripts/region_proposal_probe.py bench --transcribe   # the deploy gate (~40 min)
```

`bench` writes its run to `corpus/runs/<today>/region-grouping/` — `_summary.json` carries the
config matrix and the HEAD of all three repos, and each configuration gets a per-page file with
every proposed box and both its joined and re-OCR'd text. Pass `--no-save` to print without
recording, or `--bench-configs production proposed` to run a subset.

`waist` reads `corpus/ocr/_region_probe/` by default, keying each file on the `sample_id` inside it
rather than its filename. A sample annotated twice must induce the same partition or it is dropped —
a disagreement between annotators is missing ground truth, not a tie to break.
