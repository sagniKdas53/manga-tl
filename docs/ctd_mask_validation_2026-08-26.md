# CTD mask validation — the 20-page test

**Date:** 2026-08-26, extended 2026-08-27 · **Status:** complete — all 21 pages, Findings 1–8
**Feeds:** `docs/erasure_overhaul_plan_2026-08-26.md` §7, §9 Phase 1, §10, §11
**Resume:** see `docs/RESUME_2026-08-28.md`
**History of the method being replaced:** `docs/erasure_method_history_2026-08-27.md`

## Why this test exists

Phase 1 of the erasure plan rests on one unverified assumption: that a learned text-segmentation
model produces a *glyph-shaped* mask on our corpus. That assumption was not free — my own OpenCV
morphology prototype failed exactly here, producing a solid vertical slab (12 components, 17,260 px
median) while scoring well against a metric that could not see the failure. §11 lists it as the
first risk: *"CTD mask quality on our corpus is unmeasured. Everything in Phase 1 rests on it."*

## Verdict

**The geometry gate passes decisively, and the plan should proceed — with five changes.**
CTD's mask is glyph-level on real manga pages, at roughly a tenth the coverage of our region fill
and a fortieth of the balloon-outline damage. But whole-page inference at a fixed 1024² is both too
slow and, on pages with small text, actively wrong; and the raw model output must not be used as the
erasure mask directly.

**Two things measured on 2026-08-27 qualify that verdict, and neither is in the plan:**

- **Per-region crops fix the accuracy problem but cost ~1.4× a whole-page pass, not less**
  (Finding 6). The plan's cost argument does not survive measurement — a whole-page pass is a fixed
  1024² regardless of page size, and our crops sum to more than that. **The latency gate is still
  unmet.**
- **A tight mask leaves text behind** (Finding 7). Our slab erases everything by construction;
  CTD + TELEA leaves a median 6.1 % residual ink, and **9 of 21 pages exceed 10 %**. A median 98.7 %
  of what CTD misses is glyph ink rather than balloon outline. **Phase 1 needs a recall-recovery
  step it does not currently have.** Lowering the threshold to 0.3 is worth doing (Finding 8) but only fixes the
  polarity half.

## The model

`comictextdetector.pt.onnx`, manga-image-translator `beta-0.3` release —
94,669,756 bytes, md5 `165141f94293c24f5ed2074369d72a6a`, opset 11, 388 nodes.
Outputs `blk` (YOLO, 64512 anchors), `seg` (text mask, full input res), `det` (2-ch line map).
We consume only `seg`, thresholded at 0.5. Preprocessing: pad to square bottom-right, resize to
1024, RGB, `/255`. (Bottom-right vs centred padding was measured and is equivalent: 9.30 % vs
9.25 % coverage, identical recall.)

## Method

**Masks compared, on identical pixels:**

- **OURS** — `project/layer-<translation>-mask.png`, which the exporter builds by filling each
  element's `maskPolygon` ([Reader.tsx:2510](../frontend/src/components/Reader.tsx#L2510)). This is
  exactly what `cover_fill_for_region` ([ocr.py:315](../worker/src/worker/handlers/ocr.py#L315))
  paints — not a reconstruction of it.
- **CTD** — the `seg` head at 0.5.

**Metrics.** Connected-component geometry (components < 8 px dropped as speckle) is the plan's
Phase 1 gate and the one number a slab cannot fake. Ink recall uses the mangatranslator.ai reference
as ground truth. Balloon-outline damage is a 9-px band straddling each `maskPolygon`, intersected
with ink and with the complement of text ink — the metric that discriminated the three pipelines on
the comparison page (toriitranslate.com 1.2 %, mangatranslator.ai 4.9 %, ours 21.4 %).

### Two metric corrections made during the run

1. **Recall denominator.** The first definition restricted text ink to *inside our own mask*, which
   makes OURS score 100 % by construction. On pages where our mask covers 44–92 % of the page that
   denominator is mostly artwork, so CTD scored 37–58 % for correctly declining to paint it. It was
   replaced with a mask-independent proxy: **ink present in the original and absent in the
   reference** — i.e. ink a known-good pipeline actually erased. Artwork stays inky in the reference
   and is excluded; the reference's newly typeset English adds ink and is excluded too. Where
   English lands on former Japanese this understates, which is conservative.
2. **Outline damage.** The band is only meaningful where `maskPolygon` traces a real bubble contour.
   A 4-point rectangle is the fallback box for free-floating text over artwork, and its "outline
   band" is plain artwork — sample189 has no balloons at all. Restricted to polygons with ≥ 9
   vertices (which come from `bubble_detector`'s `mask_polygon`).

The `flattened` metric follows the repo's own definition
([render_quality_metrics.py:71](../scripts/render_quality_metrics.py#L71)) — percentage of
*whole-page* pixels — so numbers stay comparable to the existing 6.85 % / 1.92 % baseline.

## Results (all 21 pages)

| page | group | CTD cov | CTD cc | CTD med | CTD out-kill | ours cov | ours cc | ours med | ours out-kill |
|---|---|---|---|---|---|---|---|---|---|
| sample47 | hard | 9.30 % | 204 | 247 | 2.6 % | 12.69 % | 7 | 25,581 | 28.4 % |
| sample33 | hard | 0.77 % | 46 | 128 | 0.0 % | 8.46 % | 3 | 33,078 | 33.3 % |
| sample52 | hard | 0.13 % | 26 | 144 | 0.0 % | 2.04 % | 2 | 41,390 | 46.0 % |
| sample128 | hard | 6.60 % | 214 | 190 | 2.7 % | 44.39 % | 4 | 49,276 | 49.5 % |
| sample136 | hard | 1.73 % | 168 | 86 | 0.4 % | 7.45 % | 13 | 5,096 | 26.5 % |
| sample152 | hard | 2.03 % | 152 | 202 | 0.0 % | 8.25 % | 15 | 12,157 | 40.5 % |
| sample87 | hard | 9.51 % | 122 | 104 | 19.7 % | 24.22 % | 22 | 17,682 | 30.0 % |
| sample158 | hard | 9.27 % | 81 | 180 | 0.0 % | **81.11 %** | 2 | 204,770 | 56.9 % |
| sample93 | hard | 3.49 % | 355 | 284 | 1.7 % | 35.13 % | 4 | 598,797 | 33.4 % |
| sample123 | hard | 3.20 % | 198 | 48 | 3.2 % | 15.59 % | 11 | 5,012 | 17.9 % |
| sample61 | dark | 16.35 % | 1735 | 219 | 48.7 %※ | 35.63 % | 45 | 23,300 | 39.0 % |
| sample107 | dark | 9.00 % | 441 | 538 | 2.1 % | 54.28 % | 5 | 402,936 | 31.3 % |
| sample189 | dark | 3.42 % | 65 | 929 | 30.5 %※ | 6.53 % | 3 | 203,288 | 18.8 % |
| sample145 | dark | 2.88 % | 107 | 660 | 0.2 % | 16.07 % | 13 | 96,205 | 41.0 % |
| sample106 | colour | 2.94 % | 17 | **4,466** | 0.0 % | 13.16 % | 6 | 67,939 | 67.0 % |
| sample92 | colour | 7.30 % | 288 | 194 | 20.1 % | **92.30 %** | **1** | 1,914,018 | 65.8 % |
| sample28 | colour | 1.10 % | 97 | 62 | 0.0 % | 10.44 % | 8 | 7,055 | 32.2 % |
| sample192 | control | 2.05 % | 75 | 697 | 2.1 % | 19.60 % | 3 | 145,298 | 25.9 % |
| sample69 | control | 1.29 % | 85 | 166 | 0.0 % | 4.01 % | 5 | 7,379 | 5.3 % |
| sample46 | control | 3.17 % | 60 | 168 | 1.5 % | 6.20 % | 2 | 62,598 | 40.2 % |
| sample37 | control | 5.36 % | 310 | 369 | — | 31.95 % | 5 | 139,160 | — |

※ metric artifact — see Finding 3.

**Group medians:**

| group | n | CTD cov | CTD cc | CTD med | CTD recall | CTD out-kill | ours cov | ours cc | ours med | ours out-kill |
|---|---|---|---|---|---|---|---|---|---|---|
| hard | 10 | 3.34 % | 160 | **162 px** | 87.4 % | **1.0 %** | 14.14 % | 6 | 29,330 | 33.3 % |
| dark | 4 | 6.21 % | 274 | 599 px | 93.9 % | 16.3 %※ | 25.85 % | 9 | 149,746 | 35.2 % |
| colour | 3 | 2.94 % | 97 | 194 px | 82.7 % | **0.0 %** | 13.16 % | 6 | 67,939 | 65.8 % |
| control | 4 | 2.61 % | 80 | 268 px | **99.7 %** | 1.5 % | 12.90 % | 4 | 100,879 | 25.9 % |
| **all 21** | 21 | **3.20 %** | 122 | **194 px** | 90.3 % | **1.6 %** | 15.59 % | 5 | **49,276** | 33.3 % |

Inference: median **77.5 s/page** (min 70.1, max 107.2) on the trimmed model, 4 threads.
*(Corrected 2026-08-27: was "77.4 / max 89.2", the 20-page figure. sample28 was measured separately via `one.py` and took 107.2 s, which is the new max.)*

Two things worth noting in the medians. Our all-21 median is **15.59 % coverage / 49,276 px**, in
the same region as the comparison page the plan was written from (15.69 %, 62,436 px) — so that page
was a fair *median*, and the tail is far worse than the plan recorded. And on the **control**
group — flat white balloons, the case our current approach is supposedly adequate for — CTD still
recovers 99.7 % of the ink at a fifth of the coverage.

> **Corrected 2026-08-27.** This paragraph previously read "62,598 px … lands almost exactly on the
> comparison page". 62,598 px was the median of the **pre-replacement** 20-page set; swapping
> sample184 for sample28 moved the median position and the correct all-21 value is **49,276 px**,
> which is what the table above has always said. Recomputed from `eval20.json`. The coverage figure
> (15.59 %) was unaffected.

**Hard group medians** (the 10 pages of text over artwork/screentone):

| | coverage | components | median cc area | outline-kill |
|---|---|---|---|---|
| CTD | 3.35 % | ~160 | **162 px** | **1.1 %** |
| ours | 14.1 % | ~5 | **29,330 px** | **33.4 %** |
| toriitranslate.com (reference) | 2.64 % | 295 | 215 px | 1.2 % |
| *Phase 1 gate* | — | *hundreds* | *≤ 2,000 px* | — |

CTD clears the gate by ~12×; our current mask misses it by ~15×. CTD lands on toriitranslate.com's profile.
Rendered, the CTD mask is *legible* — you can read the Japanese in it.

## Finding 1 — our current mask is far worse than the plan recorded

The plan cites 15.69 % coverage / 7 components / 62,436 px median from the comparison page. The
corpus is much worse:

| page | our coverage | components | median component |
|---|---|---|---|
| sample92 | **92.30 %** | **1** | 1,914,018 px |
| sample158 | 81.11 % | 2 | 204,770 px |
| sample107 | 54.28 % | 5 | 402,936 px |
| sample128 | 44.39 % | 4 | 49,276 px |

sample92 is an entire page destroyed by one region's fill. These pages were selected before any of
this was measured, by a detail heuristic that knew nothing about our own output.

## Finding 2 — the model's weaknesses are real but narrower than they first looked

An early two-page reading suggested CTD was broadly weak on inverted (light-on-dark) text: missed
ink was 47–56 % light-on-dark against 6–19 % for hits, and the misses were not stroke-edge slop
(median 7 px from the nearest CTD pixel; dilating 7 px recovered only 62.5 % while doubling
coverage). **The DARK group did not support the broad claim** — CTD recall there was 71.5–97.5 %,
not ~45 %. sample145 (clean white-on-black balloons) is the weakest at 71.5 %, so a real but milder
polarity effect exists. sample136's 45.6 % is something more specific and is still unexplained.

**Lowering the threshold does not help.** From 0.5 to 0.05:

| page | recall | coverage |
|---|---|---|
| sample136 | 45.6 % → 50.7 % | 1.73 % → 2.97 % |
| sample128 | 56.1 % → 71.0 % | 6.59 % → 11.05 % |
| sample47 | 88.8 % → 90.3 % | 9.29 % → 16.66 % |

Five points of recall for 72 % more paint, and the glyph geometry degrades as the mask fattens. The
model is not assigning low confidence to this text — it is assigning none. Thresholding is the wrong
knob.

## Finding 3 — two "CTD loses" results are metric artifacts, one is a real failure

- **sample61** (48.7 % outline-kill): chat-app screenshots, not drawn manga. The "balloon outlines"
  are UI chrome packed with text.
- **sample189** (30.5 %): no balloons at all — Korean text sits directly on artwork, and our 3
  rectangular fallback boxes make the band pure artwork. CTD found essentially all the text; our
  pipeline detected only 3 regions and missed the rest.
- **sample184** (23.69 % coverage, 20 px median, 66.2 % outline-kill) was **a genuine CTD failure**:
  a sticker illustration, not a comic page, where CTD mistakes the character's white rim-lighting
  and outline strokes for text and floods the image. **It has since been replaced by sample28** (see
  below), so it no longer appears in the table above. The out-of-domain finding stands and is worth
  keeping: *CTD is unreliable on illustration/sticker art with heavy white outlines.*

## Finding 4 — the mask must be gated by the region set

CTD finds *all* text, including text we never replace: SFX (never typeset, by policy) and lettering
that is part of the artwork — on sample128 it correctly segments the 明 characters printed on
characters' shirts. Erasing those leaves holes where nothing is drawn back.

**The shipped mask is `CTD ∩ (final region set)`, not raw CTD.** Phase 0 already computes the plate
after QA when the region set is final, so the ordering is right; the intersection must be explicit.

## Finding 5 — whole-page inference at a fixed 1024² is the wrong shape of the problem

**Cost.** 128 s/page on this box (4 cores). The worker is capped at `cpus: "2.0"`
([docker-compose.yml:415](../docker-compose.yml#L415)), so production is roughly double. The plan's
latency gate is *inpaint stage ≤ 10 s on 2 cores* — an order of magnitude out.

**The published model is needlessly expensive for us.** We use one of three outputs, and the `det`
branch carries its own `ConvTranspose` decoder at full resolution. Extracting `images → seg`:

| | nodes | size | time | mask |
|---|---|---|---|---|
| published | 388 | 94.7 MB | 128.2 s | — |
| seg-only | **208** | **65.6 MB** | **75.7 s** | identical (9.30 % / 204 cc / 247 px) |

**41 % faster for free**, and it removes the reason the model is shape-locked: the input is fixed at
`[1,3,1024,1024]` *only* because the YOLO head reshapes to a hardcoded 64512 anchors. The mask
decoder is fully convolutional, so the trimmed graph takes `[1,3,h,w]`.

**Accuracy, not just cost.** Padding to square and resizing to 1024 shrinks text — sample106
(1440×1920) shrinks 1.9×, and its small glyphs merge into solid column blobs: 17 components at a
**4,466 px median, the one gate failure among real manga pages**. sample93 survives a 6.6× shrink
because its text is large in absolute pixels, so the driver is stroke width *after* downscaling.

**This points at per-region crops at native scale instead of one whole-page pass.** Only possible
because the shape-locking YOLO head is gone. **Now measured — see Finding 6: the accuracy half is
confirmed and the cost half is wrong.** The reasoning below is left as written because the error in
it is instructive: *"cost then tracks text area rather than page area, and accuracy improves on
exactly the pages where whole-page inference degrades — cheaper and better."* Accuracy improves as
predicted. Cost does not, because a whole-page pass is a fixed 1024² no matter how large the page
is, and our crops sum to more than that.

## Finding 6 — per-region crops are the accuracy fix, but **not** the cost fix

*Measured 2026-08-27, closing the "Not yet measured" note at the end of Finding 5.*
Scripts: `crop.py` (square pad, as written), `crop2.py` (native aspect, written for this test),
`costbench.py` (all three modes back-to-back in one process).

### Mask geometry — the claim holds, decisively

| page | whole-page @1024² | per-region, square pad | per-region, native aspect |
|---|---|---|---|
| sample106 | 2.94 % / 17 cc / **4,466 px** — GATE FAIL | 2.55 % / 52 cc / 477 px | 2.28 % / 70 cc / **220 px** |
| sample136 | 1.73 % / 168 cc / 86 px | 1.41 % / 159 cc / 74 px | 1.47 % / 147 cc / 82 px |
| sample47 | 9.30 % / 204 cc / 247 px | 4.30 % / 206 cc / 180 px | 4.16 % / 200 cc / 184 px |

**The one gate failure among real manga pages is closed.** sample106 goes from 4,466 px median to
220 px, a 20× improvement, and its component count rises 17 → 70 as the merged column blobs separate
into glyphs. Coverage falls on every page — sample47 halves, 9.30 % → 4.16 %, because the whole-page
pass was also painting text outside the region set.

Native aspect beats the square pad on every geometry measure, and the two masks differ substantially
(IoU 82.9 % / 83.1 % / 85.2 %) — this is not a rounding difference.

### Cost — the claim is refuted

Back-to-back in one process, session pre-warmed, same page, no other load:

| page | whole-page | per-region, square pad | per-region, native aspect |
|---|---|---|---|
| sample47 (12 regions) | 114.8 s · 1.05 Mpx · 109.5 s/Mpx | 205.0 s · 1.74 Mpx · 118.0 s/Mpx · **1.79×** | 156.9 s · 1.18 Mpx · 133.0 s/Mpx · **1.37×** |
| sample106 (6 regions) | 110.8 s · 1.05 Mpx · 105.7 s/Mpx | 401.8 s · 2.33 Mpx · 172.1 s/Mpx · **3.63×** | 157.7 s · 1.16 Mpx · 136.1 s/Mpx · **1.42×** |

*(Absolute seconds here run high against the 77 s/page of the main run — the box was busier. Only
the ratios within each row are load-independent, and those are what the conclusion rests on.)*

Three causes, of which only the first was anticipated:

1. **The square pad, which is pure waste and is fixable.** A vertical Japanese text column is roughly
   60×400; padded to a square and rounded up it becomes a 448×448 inference, ~87 % of it zeros. The
   seg branch is fully convolutional and `extract.py` made *both* spatial dims symbolic, so the pad
   was never required — upstream does it only because the whole-page path inherits the YOLO head's
   fixed input. Dropping it is a large real win: sample106 goes 401.8 s → 157.7 s.

2. **The crops do not sum to less than the page — this is the assumption that fails.** Whole-page
   inference is a fixed 1024² = 1.05 Mpx *regardless of page size*. sample47's 12 crops sum to
   1.18 Mpx and sample106's 6 crops to 1.16 Mpx — both **more** than the whole page. The 64-px
   context pad on all four sides, plus rounding each dimension up to a multiple of 64, costs more
   than the skipped artwork saves: a 100×300 text region becomes 256×448 = 115 k px. *"Cost tracks
   text area, not page area"* is only true when regions are few and large, and our pages are the
   opposite.

3. **Small tensors are less efficient per pixel**: 133–136 s/Mpx for crops against 106–110 s/Mpx
   whole-page, ~25 % worse. Four threads parallelize one large convolution better than a dozen
   small ones.

**Net: per-region crops at native scale cost ~1.4× a whole-page pass, not less.**

### What to do about it

Adopt per-region crops at native scale — but for **one** reason, not two: they fix the small-text
merge failure and tighten coverage. The latency gate has to be met somewhere else. Untested levers,
cheapest first:

- **Reduce `PAD` from 64.** It is the single largest term in the crop area and was never tuned. The
  risk is mask quality — CTD may need surrounding context to fire on text — so this needs measuring,
  not assuming.
- **Batch the crops into one inference.** Pad to a common size and stack on the batch axis; this
  addresses cause 3 directly and is the standard fix for many-small-tensors.
- **Drop the whole-page input size.** `sweep.py` at `CTD_THREADS=2` sweeps 512–1024 and will say
  how much is available here. Not yet run.

## Finding 7 — CTD trades artwork damage for residual text, and the trade is not free

*`posthoc.py`, first end-to-end run 2026-08-27. It had never executed: it read `oink` without ever
defining it and would have raised `NameError` on the first page. Fixed by defining
`oink = band & ink & ~tink`, matching `thresh.py`.*

Medians over all 21 pages:

| metric | CTD | ours |
|---|---|---|
| erased-ink recall (mask-independent) | 87.0 % | **97.7 %** |
| residual ink after actually erasing | **6.1 %** | **0.0 %** |
| balloon-outline kill (bubble pages only) | **0.9 %** | 39.4 % |

### Three things this settles

**1. CTD's misses are mostly text, not outline — but not uniformly.** Median **98.7 %** of the ink
CTD misses is glyph ink, against **1.3 %** balloon outline. The earlier hope — that CTD's ~9 %
shortfall was it *correctly declining to paint the outline* — is wrong for most pages.

The distribution is bimodal, and the median hides it. On **17 of 21 pages ≥ 72 %** of the miss is
glyph ink, ten of them at 99–100 %. On **four pages the majority of the miss is outline**:
sample123 (6.2 % glyph), sample152 (28.8 %), sample47 (47.4 %), sample136 (66.6 %). Those are pages
where our `maskPolygon` traces the balloon contour tightly, so the 9-px band is genuinely on the
stroke and CTD is right to skip it. **Quote the median for the headline, but do not read it as
"CTD never declines the outline" — on a fifth of pages that is most of what it declines.**

### Per-page detail

| page | CTD recall (unrestricted) | miss that is glyph ink | miss that is outline | residual: ours | residual: CTD+TELEA |
|---|---|---|---|---|---|
| sample47 | 84.0 % | 47.4 % | 52.6 % | 0.54 % | 6.08 % |
| sample33 | 99.9 % | 100.0 % | 0.0 % | 0.00 % | 0.00 % |
| sample52 | 99.8 % | 100.0 % | 0.0 % | 0.00 % | 0.00 % |
| sample128 | 57.5 % | 98.7 % | 1.3 % | 0.01 % | **32.17 %** |
| sample136 | 25.8 % | 66.6 % | 33.4 % | 0.68 % | **30.78 %** |
| sample152 | 82.2 % | 28.8 % | 71.2 % | 0.25 % | 9.52 % |
| sample87 | 73.7 % | 87.6 % | 12.4 % | 0.02 % | 11.78 % |
| sample158※ | 39.3 % | 99.9 % | 0.1 % | 0.00 % | 45.45 % |
| sample93 | 31.5 % | 99.7 % | 0.3 % | 0.00 % | **60.65 %** |
| sample123 | 50.1 % | 6.2 % | 93.8 % | 0.46 % | 13.79 % |
| sample61 | 84.9 % | 99.5 % | 0.5 % | 0.00 % | 0.68 % |
| sample107 | 92.7 % | 98.1 % | 1.9 % | 0.00 % | 2.25 % |
| sample189 | 94.6 % | 99.6 % | 0.4 % | 0.00 % | 3.14 % |
| sample145 | 67.3 % | 91.5 % | 8.5 % | 0.05 % | **27.58 %** |
| sample106 | 68.9 % | 96.4 % | 3.6 % | 0.00 % | 18.28 % |
| sample92 | 73.0 % | 94.1 % | 5.9 % | 0.03 % | 20.41 % |
| sample192 | 97.5 % | 100.0 % | 0.0 % | 0.00 % | 0.00 % |
| sample69 | 99.2 % | 100.0 % | 0.0 % | 0.00 % | 0.00 % |
| sample46 | 99.8 % | 100.0 % | 0.0 % | 0.00 % | 0.00 % |
| sample37 | 99.4 % | 100.0 % | 0.0 % | 0.00 % | 0.00 % |
| sample28 | 87.3 % | 71.8 % | 28.2 % | 0.04 % | 5.30 % |
| **median** | **84.0 %** | **98.7 %** | **1.3 %** | **0.00 %** | **6.08 %** |

*※ sample158's erased-ink denominator is 33 px — see the exclusion note below.*

**2. The region-gated mask still clears the Phase 1 gate.** `CTD ∩ region set`, median over 21
pages: 2.83 % coverage, 97 components, **212 px median component** against the ≤ 2,000 px gate.
Gating (Finding 4) does not undo the geometry win.

**3. Gating is necessary, and its size is now known.** A median **8.2 %** of raw CTD's mask falls
outside the region set — the SFX and artwork lettering of Finding 4. Erasing that leaves holes where
nothing is drawn back.

### The cost of a tight mask is visible residual text

Ours leaves ~0 % residual **by construction** — an opaque slab cannot fail to cover what is beneath
it. CTD + TELEA leaves a median 6.1 %, and the tail is bad: **9 of 21 pages over 10 %, four over
27 %.**

| page | group | residual ink | erased-ink recall | n_erased |
|---|---|---|---|---|
| sample93 | hard | **60.7 %** | 41.5 % | 272,577 |
| sample128 | hard | 32.2 % | 56.1 % | 26,392 |
| sample136 | hard | 30.8 % | 45.6 % | 11,543 |
| sample145 | dark | 27.6 % | 69.9 % | 174,794 |
| sample92 | colour | 20.4 % | 74.1 % | 52,058 |
| sample106 | colour | 18.3 % | 82.2 % | 40,230 |
| sample123 | hard | 13.8 % | 61.6 % | 6,634 |
| sample87 | hard | 11.8 % | 87.0 % | 46,272 |

**sample136 is no longer a lone anomaly** — this closes the open question in Finding 2 and RESUME
item 6, though not with the answer that was expected. sample93 (41.5 %) and sample128 (56.1 %) sit
alongside it, all in the HARD group and all with large `n_erased`. The property is *dense text over
busy artwork*, not one page and not inverted polarity. That is now the thing to explain.

**One page must be excluded from recall conclusions: sample158.** Its erased-ink denominator is
**33 pixels** — the mangatranslator.ai reference barely altered the page — so its 0.0 % recall and
45.5 % residual are dividing by noise. Dropping it moves the medians only slightly (recall
87.0 → 87.4 %, residual 6.1 → 5.7 %), so the headline is unaffected, but the per-page figure is
meaningless. Every other guard in these scripts uses a 500-px floor; this metric needs the same one.

### What this means for the plan

Adopting CTD as written **trades one failure for another**. Today we destroy artwork (39.4 % outline
kill) but always remove the text. CTD preserves artwork (0.9 %) and leaves text visible on a third of
pages. Neither is shippable on its own, and the plan currently only accounts for the first half.

Phase 1 needs an explicit **recall recovery** step. Candidates, in the order they should be tried:

1. **Dilate the gated mask.** Cheap, and the mask is glyph-shaped so a small dilation stays far from
   the 2,000 px gate. Finding 2 measured a 7-px dilation recovering only 62.5 % while doubling
   coverage — but that was on the *ungated* mask, where the extra paint lands on artwork. Inside the
   region set the trade is different and worth re-measuring.
2. **Lower the threshold to 0.3.** Finding 8 measures this across all 21 and it is worth doing on
   its own merits — +11.7 points of light-on-dark recall for +0.69 pp coverage — but it addresses
   the *polarity* deficit, not the dense-text failure, and leaves sample93 at 45 %.
3. **A second pass inside the region set** wherever residual ink is detected after inpainting — the
   only option that targets the actual failure rather than widening the mask everywhere.

## Finding 8 — 0.5 is defensible, but 0.3 is better, and the reason is polarity

*`thresh.py`, run 2026-08-27 across all 21 pages. Re-thresholded from the saved probability maps, so
no model inference was needed. Recall here is the region-restricted `tink` metric, not Finding 7's
mask-independent one — the value is in the polarity split, which only this script computes.*

| threshold | median cov | median cc | median cc area | ink recall | recall: dark-on-light | recall: light-on-dark | outline-kill |
|---|---|---|---|---|---|---|---|
| 0.3 | 3.88 % | 103 | 251 px | **92.1 %** | 90.8 % | **75.3 %** | 2.5 % |
| 0.4 | 3.64 % | 108 | 222 px | 91.2 % | 90.3 % | 70.9 % | 2.3 % |
| **0.5** *(current)* | 3.19 % | 120 | 194 px | 90.3 % | 89.6 % | 63.6 % | 1.6 % |
| 0.6 | 2.83 % | 131 | 171 px | 89.2 % | 88.5 % | 55.7 % | 0.8 % |
| 0.7 | 2.42 % | 136 | 146 px | 87.7 % | 86.5 % | 48.7 % | 0.5 % |

*(14 of 21 pages carry enough light-on-dark ink to be measured; all 21 carry dark-on-light.)*

**Overall recall is nearly threshold-independent.** Across the whole 0.3–0.7 range it moves 92.1 % →
87.7 % — **4.4 points for a 60 % swing in coverage**. This confirms Finding 2's conclusion on all 21
pages rather than 3: the model is not assigning low confidence to the text it misses, it is
assigning none, and no threshold recovers it.

**The polarity effect is real, large, and it is the threshold-sensitive part.** Light-on-dark recall
moves 75.3 % → 48.7 % over the same range — **26.6 points, six times more sensitive** than
dark-on-light's 4.3. CTD systematically assigns *lower confidence* to inverted text rather than
missing it outright, which is exactly the shape a threshold can address. This is the sharpened
version of Finding 2's polarity claim: the DARK group did not support "CTD is weak on inverted text"
as a *recall* statement, and it is instead a *confidence calibration* statement.

**Recommendation: move to 0.3.** It buys +1.8 points overall recall and **+11.7 points on
light-on-dark**, for +0.69 pp of coverage. Outline-kill rises 1.6 % → 2.5 % — still **~16× better
than our current 39.4 %**, and geometry stays far inside the gate (251 px against ≤ 2,000 px). The
pages that gain most are the ones Finding 7 flagged:

| page | recall @0.5 | recall @0.3 | coverage cost |
|---|---|---|---|
| sample106 | 82.6 % | **91.5 %** | 2.94 % → 3.38 % |
| sample145 | 71.4 % | **79.8 %** | 2.88 % → 3.47 % |
| sample93 | 37.3 % | 45.2 % | 3.47 % → 5.35 % |
| sample92 | 73.6 % | 79.7 % | 7.29 % → 8.73 % |
| sample128 | 58.5 % | 63.9 % | 6.59 % → 7.82 % |
| sample136 | 51.8 % | 54.5 % | 1.73 % → 2.10 % |

**It does not solve the hard family.** sample93 is still at 45 % and sample136 at 55 % after the
change. The threshold fixes the *polarity* deficit; the dense-text-over-artwork failure of Finding 7
is a different mechanism and needs a different fix. Below ~0.3 the dial stops behaving — Finding 2
measured 0.05 buying 5 points for 72 % more paint — so 0.3 is close to the useful floor.

## What this changes in the plan

1. **§11 risk 1 is resolved** for real manga pages: the geometry gate passes by ~12×.
2. **Phase 1 step 5** should adopt the **seg-only dynamic subgraph**, not the published model.
3. **Phase 1 gains a step:** the mask is `CTD ∩ region set`, and resolution is chosen per region
   from text size — not one whole-page pass at 1024. **Adopt this for accuracy only** — Finding 6
   measured it at ~1.4× the cost of a whole-page pass, not less, so the cost gate is still open.
4. **§10's latency gate needs revisiting** against measured cost, or the plate stage must be
   explicitly off the interactive path.
5. **§7's table should gain the CTD row** next to toriitranslate.com and the failed morphology prototype.
6. **Phase 1 gains a recall-recovery step** (Finding 7). Without one, switching to CTD trades
   destroyed artwork for visible residual Japanese on a third of pages. This is new scope the plan
   does not currently carry.
7. **The threshold default moves 0.5 → 0.3** (Finding 8): +11.7 points of light-on-dark recall for
   +0.69 pp coverage, geometry still 8× inside the gate.

## Appendix — how sample184 was replaced

sample184 was selected for the COLOUR group by **whole-page saturation**, which turned out to be the
wrong criterion twice over: it admitted a sticker illustration with no balloons at all, and it never
measured the thing the group exists to test — whether the *balloon interior* is non-white.

The replacement was chosen on two measurements instead:

1. **Real bubble contours.** Count `maskPolygon`s with ≥ 9 vertices (which come from
   `bubble_detector`'s `mask_polygon`) versus 4-point fallback rectangles. sample184 had **0 real
   bubbles**; the whole-page-saturation ranking was full of such pages (sample166, sample21,
   sample70).
2. **Balloon interior colour.** Median HSV saturation and value inside each polygon, eroded 9 px so
   the outline itself is excluded.

sample28 (700×974) scored interior saturation **80.0** at value 242.5 across **6 real bubbles** —
genuinely green-tinted speech balloons on saturated colour artwork, with proper panel structure.
Candidates rejected: sample111 (strongest colour at 88.5 but only 2 bubbles, and dark tinted
text-boxes that overlap the DARK group), sample67 (text on artwork, few balloons), sample104
(decorative banner typography, not balloons), sample191 (5 clean bubbles but *white* interiors on
colour art — a fine page, wrong group).

One caveat on the replacement: at 700×974 sample28 is *upscaled* into the 1024 input, so it does not
exercise the small-text-merge failure that sample106 exposes. That failure mode is still covered, by
sample106.
