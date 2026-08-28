# Masks vs inpainting — measuring the claim, and why it is not actually a choice

**Date:** 2026-08-27 · **Status:** measurement complete; Torii screenshots still to come
**Question asked:** *"our current masks are too big… they even overlap each other. Either we inpaint
everything and transpose the text over it, or we improve our masks into a distinct technique. I want
my original idea — masking everything — validated against the other approach so we don't have regrets."*
**Script:** `corpus/gaps/manga-tl-erasure-eval/scripts/maskprobe.py` · **Data:** `maskprobe.json`

---

## 1. The architecture, as built

Confirmed against the exported projects, not assumed. Every page is exactly the layered model
described: **`original.png` + two layer pairs.**

| layer | mask.png | translation.png | purpose |
|---|---|---|---|
| `ocr` | full-page RGBA, **binary** alpha, 1 colour | full-page RGBA | crop/blank source regions for recognition |
| `translation` | full-page RGBA, **255** alpha levels, 1 colour | full-page RGBA | cover source text, type the translation |

The two mask kinds do have the different requirements you described. The OCR mask is binary and
loose — it only has to be readable. The translation mask is anti-aliased at the edges, because it
has to sit convincingly on the page.

---

## 2. All three claims are true, and they are not equally bad

271 pages, 2,494 mask elements, measured from the element polygons rather than the flattened raster
so overlap is visible per pair.

| | median | p25 – p75 | worst |
|---|---|---|---|
| mask coverage of the page | **18.6 %** | 12.0 – 27.5 % | 96.8 % |
| **oversize** — mask area ÷ ink area it covers | **6.3×** | 4.9 – 8.4× | 20.0× |
| of the mask, how much is actually ink | **15.9 %** | 11.9 – 20.3 % | — |
| of the mask, how much is *detailed artwork* | **49.4 %** | 41.9 – 59.3 % | 99.9 % |
| mask area painted twice or more | 0.01 % | 0.00 – 1.04 % | 19.3 % |

**"Too big" — confirmed, and it is the dominant problem.** Median oversize **6.3×**: only about a
sixth of what the mask paints is the text it exists to cover. 86 of 271 pages cover more than a
quarter of the whole page.

**"They don't respect the image" — confirmed, and this is the one that shows.** A median **49.4 %**
of every mask lands on *detailed* pixels — artwork and screentone, not flat balloon interior. On
**132 of 271 pages more than half the mask is painted over drawing.** That is the visible defect;
oversize on a flat white balloon costs nothing, oversize over a character's face costs everything.

**"They overlap each other" — confirmed, but it is the smallest of the three.** **140 of 271 pages
(52 %)** have at least one overlapping element pair, so it is widespread — but the doubly-painted
*area* is a median of only **1.0 %** of the mask on those pages, worst case 19.3 % (sample218).

Worth separating, because it is a different *kind* of bug: overlap is a **correctness** failure, not
a quality one. Whichever element paints second wins, and the first region's carefully sampled
backdrop is destroyed underneath it. It is cheap to detect and cheap to fix, and it should be fixed
regardless of which direction the erasure work goes. It is just not where the visible damage is.

---

## 3. The finding that dissolves the dilemma

**The mask layer is already a full-page RGBA raster. Nothing in the format requires a flat colour.**

The only reason it is a slab is the producer. `Reader.tsx:2524` builds the mask by walking each
element's `maskPolygon`, and then:

```js
maskCtx.fillStyle = el.backgroundColor || "#ffffff";
maskCtx.fill();
```

One `fillStyle`, one `fill()`, per polygon. That is the whole mechanism — and it is why the measured
masks have **255 distinct alpha values but exactly one distinct RGB colour**. The canvas is
`W × H` RGBA and would take a `drawImage` of arbitrary per-pixel content just as happily.

So the two options you framed are not alternatives:

> *Either we inpaint everything and transpose the text over it, or we improve our masks.*

**Inpainting is not an alternative to your architecture — it is a way to generate the mask's pixel
content.** Keep `original.png` + mask + text exactly as it is. Change the mask from *"this polygon,
filled with one colour"* to *"these glyph-shaped pixels, filled with what was behind them"*. The
base image stays untouched, the layers stay separable, the project format does not change, and the
export path already composites RGBA rasters.

**Your original idea validates.** The layered base-plus-masks design was never the thing causing the
damage — a flat polygon fill was. You do not have to give up non-destructive layering to get
Torii-quality erasure, and you would not have been able to tell that from the rendered output alone,
which is presumably why it felt like a fork.

What this buys, from the numbers already measured (`docs/ctd_mask_validation_2026-08-26.md`):

| | balloon-outline damage | median mask component |
|---|---|---|
| ours today, flat polygon fill | 39.4 % | 49,276 px |
| glyph mask (CTD `seg`) | **0.9 %** | **194 px** |
| toriitranslate.com's recovered footprint | 1.2 % | 215 px |

---

## 4. What I would do, in order

1. **Fix the overlap bug now.** 52 % of pages, cheap, independent of everything else. Two elements'
   polygons should never both paint; either merge them or let the later one clip against the earlier.
2. **Make the mask glyph-shaped**, gated by the region set — the Phase 1 work already measured and
   specified in the validation doc. This alone takes oversize from 6.3× toward ~1.2× and takes the
   artwork-spill number with it.
3. **Fill it from an inpainted patch rather than a flat colour**, writing per-pixel content into the
   mask raster the exporter already supports. The inpaint runs on a glyph-shaped mask over a small
   crop, which is far cheaper than inpainting the whole page.
4. **Do not inpaint the base image.** That would flatten the layer model, lose the ability to show
   the original, and throw away the one architectural advantage we have over a service that only
   ships a finished plate.

**Known open risk, carried from Finding 7:** a glyph-shaped mask leaves residual text on pages where
the detector under-fires — median 6.1 % residual ink, 9 of 21 pages over 10 %. Today's slab never has
that problem because it destroys everything under it. Step 2 must land with the recall-recovery work,
not before it.

---

## 5. Still open

**~~The Torii screenshots~~ — answered, and better than screenshots would have.** No screenshots are
coming: their API returns the **bare inpainted plate** alongside the render, and `fetch_torii.py`
already saves it as `torii/images/0_inpainted`. That is strictly better evidence — the actual plate,
not a recovered diff of a finished page.

Measured on sample264 (817×2048, the one bundle already on disk), differencing their original
against their inpainted plate:

| | value |
|---|---|
| coverage of page | **2.65 %** |
| connected components | **153** |
| median component area | **156 px** |
| p90 / max component | 634 px / 2,939 px |
| text boxes in their own metadata | 13 |
| **components per text box** | **11.8** |

**Their mask is per-glyph, not per-line and not per-bubble.** Twelve components per text box at a
156 px median is individual characters. It lands almost exactly on the footprint recovered from the
earlier comparison page (2.64 % / 295 cc / 215 px), so that recovery was sound and this is now
confirmed from their own plate rather than inferred from a render.

Against ours on the same measure — 18.6 % coverage, 49,276 px median component — that is the whole
gap in two numbers.

The second question, whether the plate is reconstructed artwork or a smoothed approximation, is
answerable the same way now that the plate is on disk; it needs a visual read of the plate under a
few balloons rather than a statistic, and it is worth doing once the regeneration run has produced
more than one bundle.

**Bubbles first, SFX second — this contradicts a decision already on record, so flagging rather than
building.** You asked for *"only translating the bubbles first and then translating SFX if requested
and if they are not obstructing too much of the text."* The current policy, your call on 2026-08-13,
is that **SFX are never typeset at all** — "no quality bar, no 'translate the readable ones'",
implemented as the QA VLM's `reject_sfx` feeding `should_typeset_region`.

The new request is a real change: from *never* to *optional, on request, when they do not obstruct*.
That is a reasonable revision — it is closer to what Torii appears to do — but it needs to be a
deliberate one. Two notes if you want it:

- The ordering half (bubbles first, SFX after) is nearly free — it is a pass ordering, and
  `should_typeset_region` already exists as the gate.
- The "not obstructing too much" half needs a definition, and **two obvious heuristics are already
  measured dead ends**: glyph size does not separate SFX from dialogue (over 804 fragments the
  largest text on the page was dialogue), and recogniser confidence does not either (0.994 for ドキ,
  0.976 for dialogue). Whatever "obstructing" means, it has to be geometric — SFX polygon area
  overlapping dialogue polygons — not a property of the text itself.

**Confirmed 2026-08-28: it is a documented Torii request flag, not an inference.** Their API docs
(`corpus/docs/tori/Image Translation and OCR API…pdf`) define `bubbles_only`:

> *"If true, only text inside detected speech bubbles will be translated **and also text that is
> very long and high-confidence**, even if not inside a bubble."*

So the behaviour you noticed is real and switchable, and their escape hatch for text outside a
bubble is **length plus detector confidence** — not a size heuristic and not a semantic
classification. That is a cheaper rule than anything we considered, and notably it does not try to
identify SFX at all; it identifies *things worth translating* and lets everything else through
untouched. Worth weighing against our QA-VLM approach, which spends a model call to reach a
similar outcome.

`--bubbles-only` is now plumbed through `fetch_torii.py` and `regen_run.py`, so the flag's effect
can be measured directly on our own corpus rather than argued about.
