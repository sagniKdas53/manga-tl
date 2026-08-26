# CTD mask validation — the 20-page test

**Date:** 2026-08-26 · **Status:** complete — all 21 pages measured
**Feeds:** `docs/erasure_overhaul_plan_2026-08-26.md` §7, §9 Phase 1, §10, §11
**Resume:** see `docs/RESUME_2026-08-28.md`

## Why this test exists

Phase 1 of the erasure plan rests on one unverified assumption: that a learned text-segmentation
model produces a *glyph-shaped* mask on our corpus. That assumption was not free — my own OpenCV
morphology prototype failed exactly here, producing a solid vertical slab (12 components, 17,260 px
median) while scoring well against a metric that could not see the failure. §11 lists it as the
first risk: *"CTD mask quality on our corpus is unmeasured. Everything in Phase 1 rests on it."*

## Verdict

**The geometry gate passes decisively, and the plan should proceed — with three changes.**
CTD's mask is glyph-level on real manga pages, at roughly a tenth the coverage of our region fill
and a thirtieth of the balloon-outline damage. But whole-page inference at a fixed 1024² is both too
slow and, on pages with small text, actively wrong; and the raw model output must not be used as the
erasure mask directly.

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

Inference: median **77.4 s/page** (min 70.1, max 89.2) on the trimmed model, 4 threads.

Two things worth noting in the medians. Our all-21 median (15.59 % coverage, 62,598 px) lands almost
exactly on the comparison page the plan was written from (15.69 %, 62,436 px) — that page was a fair
*median*, and the tail is far worse than the plan recorded. And on the **control** group — flat white
balloons, the case our current approach is supposedly adequate for — CTD still recovers 99.7 % of the
ink at a fifth of the coverage.

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

**This points at per-region crops at native scale instead of one whole-page pass.** Cost then tracks
text area rather than page area, and accuracy improves on exactly the pages where whole-page
inference degrades — cheaper *and* better. Only possible because the shape-locking YOLO head is
gone. **Not yet measured** (`crop.py` is written and ready).

## What this changes in the plan

1. **§11 risk 1 is resolved** for real manga pages: the geometry gate passes by ~12×.
2. **Phase 1 step 5** should adopt the **seg-only dynamic subgraph**, not the published model.
3. **Phase 1 gains a step:** the mask is `CTD ∩ region set`, and resolution is chosen per region
   from text size — not one whole-page pass at 1024.
4. **§10's latency gate needs revisiting** against measured cost, or the plate stage must be
   explicitly off the interactive path.
5. **§7's table should gain the CTD row** next to toriitranslate.com and the failed morphology prototype.

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
