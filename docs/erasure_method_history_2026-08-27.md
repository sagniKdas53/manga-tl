# Where our erasure method came from — and why it changed

**Date:** 2026-08-27 · **Question asked:** *what was the masking method before the current one, why
did we change, and was our way better than the inpainting toriitranslate.com does?*
**See also:** `docs/mask_precision_2026-08-27.md` — the same question answered forwards rather than
backwards, with mask geometry measured across 271 pages.
**Method:** `git log -S` (pickaxe) over both repos, plus reading the code at each branch point.
**Feeds:** `docs/erasure_overhaul_plan_2026-08-26.md` §4, §7 · `docs/ctd_mask_validation_2026-08-26.md`

---

> **Corrected 2026-08-27.** The first version of this note was framed as "did we once have
> inpainting", which was never the claim. Sagnik's design was always **one base image with mask
> overlays on top** — an OCR mask that only has to be readable, and a translation mask that has to
> cover the source text precisely. That architecture is intact and is *not* what changed. What
> changed four times is what goes *inside* the translation mask. The framing below is rewritten
> around that; the git archaeology itself was unaffected.

## The short answer

**The layered architecture has never changed. What changed is the mask's contents.** Every erasure
this project has shipped fills a polygon with **one flat colour**. What moved four times is *where
the polygon comes from* and *where the colour is sampled* — never the fill itself.

There has never been an inpainting implementation to compare against either: pickaxe over the whole
worker history gives zero hits for `cv2.inpaint`, `INPAINT_TELEA`, `seamlessClone` or
`connectedComponents`. So "was our masking better than inpainting" has no *historical* answer — the
comparison never ran in our code. It has a **measured** one (§4), and separately the premise turns
out to be a false choice: `docs/mask_precision_2026-08-27.md` finds the mask layer is already a
full-page RGBA raster, so an inpainted patch is simply a different way to fill it. **The
architecture and the technique are orthogonal.**

### Evidence that no inpainting ever existed

Pickaxe over the entire worker history — every commit, all branches:

| term | commits touching it |
|---|---|
| `cv2.inpaint` | **0** |
| `INPAINT_TELEA` / `INPAINT_NS` | **0** |
| `seamlessClone` | **0** |
| `LaMa` | 1 — `6847214` (2026-08-25), the Rust scaffold, not shipped |
| `aot` | 1 — same commit |
| `text_mask` | 1 — same commit |
| `connectedComponents` | **0** |
| `THRESH_OTSU` / `adaptiveThreshold` | **0** |
| `comictextdetector` | **0** |

(The 26 hits for a bare `lama` search are all `ollama`.)

The first inpainting code in the project is `6847214` / `dc32689`, **2026-08-25** — the Phase-1 Rust
LaMa scaffold, written two days before this note and not in the pipeline.

---

## 1. The four methods, in order

### M0 — bbox shape fill  (until 2026-06-20)

`detect_background_color(img, x, y, w, h)`: take the OCR bounding box, sample a **2-pixel border
ring** of that box, take the per-channel median, return it as hex. The renderer then drew a
`rectangle` or an `ellipse` over the whole bbox in that colour, chosen by the element's `boxShape`
field (`9eede76`, 2026-06-18, added the shape support).

No bubble geometry existed. The erased shape was the *text's* bounding box, not the balloon's.

### M0b — classical-CV bubble contour  (fallback, ~2026-06 to 2026-08-04)

`detect_bubble_contour(img, ocr_x, ocr_y, ocr_w, ocr_h)` — the closest thing to a genuinely
different approach we ever had, and the one most likely being remembered:

1. expand a search window around the OCR box by `max(40, 0.8×dim)`
2. grayscale, `medianBlur` k=11 to smear the text away
3. read the local median to decide polarity, then a **fixed** threshold —
   `THRESH_BINARY @ 200` if light, `THRESH_BINARY_INV @ 55` if dark
4. `findContours(RETR_EXTERNAL)`, keep the contour with the largest overlap with the OCR box
5. `approxPolyDP` at `ε = 0.002 × arcLength` → polygon

This is edge-based balloon finding, not glyph segmentation — it returns the *balloon outline*, and
the fill still covers everything inside it. It was demoted to a fallback when YOLO arrived, removed
from the main path on 2026-07-04 (`f28b6c7`, "redundant"), reinstated 2026-08-03 (`6906a71`) for
regions YOLO misses, and **defaulted off** the next day (`619e927`, *"reject a contour that is the
search window, and default the fallback off"* — the failure mode is that the whole search window
thresholds as one blob and becomes the "balloon").

### M1 — YOLO polygon fill  (2026-06-20/21, `9a628d6` + `d5b771b`)

The current family starts here. Three pieces landed together:

- **`bubble_detector`** — YOLO segmentation produces a per-bubble `mask_polygon`.
- **`get_split_polygon(mask, bbox, ...)`** — one YOLO bubble often holds several semantic regions,
  so the bubble mask is cropped to each merged region's bbox + 20 px, re-contoured, and simplified.
- **`detect_background_color_poly(img, mask_polygon)`** — `fillPoly`, **erode 5×5** so the sample
  misses the balloon's own border stroke, median of the interior.

Renderer: `draw.polygon(poly_tuples, fill=bg_color_hex)`.

**This is what was running on 16 July 2026.** Plus one detail: regions with no YOLO bubble at all
got a synthesized *"virtual bubble"* — the region's bbox padded by 6 px, as a 4-point rectangle.
`a32bb4f` (2026-07-19, 00:27 — three days after the recording) changed that padding **6 → 0**. Its
own comment says the mask exists *"to allow typesetter inpainting / background cleaning"*, which is
the earliest written intent to inpaint; nothing ever consumed it that way.

### M2 — the flatness gate  (2026-08-10, `232f6ec` / `a5ac096`)

Filed as defect **D3**. Both colour detectors *"sampled a median colour and always returned it, so
free-floating text got a flat rectangle painted over whatever was behind it — fine over a plain
wall, an obvious mismatched slab over a busy background."*

They now return `None` when the sample is not close to flat, measured as **per-channel median
absolute deviation** over `BACKGROUND_FILL_MAX_SPREAD` (default 20). The commit is explicit about
why MAD and not stddev: a plain stddev is spiked both by anti-aliased text edges and by a saturated
solid colour's own cross-channel separation (pure blue has huge B-vs-R spread while being perfectly
flat spatially) — *"both false positives a per-channel, outlier-robust measure avoids."*

`render_image_core` already skipped the fill on a falsy colour, so the effect was: **when we cannot
match the background, draw nothing.**

### M3 — `cover_fill_for_region`  (2026-08-13, `b510ecd`) — current

M2's "draw nothing" turned out to be the worse failure. R2 in that commit: *"'I cannot match this
background' must stop meaning 'draw nothing'"* — 21 elements across the corpus had English typeset
directly onto unerased Japanese. The current function:

- flat enough → the old behaviour, median colour over the region's own polygon
- not flat → **synthesize a balloon**: `dominant_color(..., ring=True)` for the colour, and
  `cover_balloon_polygon(...)` for a new shape covering the source text

Two more corrections in the same commit are worth remembering because both were found by looking at
output rather than reasoning about it: sampling *inside* the region samples the **lettering** (the
thick white stroke around unenclosed text was the most common colour in the box — R2's first output
was a white slab, the exact defect it exists to remove), so the sample moved to a band **outside**
the box; and a backdrop sampled from artwork can be dark, so `readable_text_color` now overrides
below WCAG 3.0 and only below it.

`R1` in the same commit fixed the geometry source: fragments were assigned to whichever YOLO mask
they overlapped *most*, and YOLO is single-class and fires on the white **stroke** drawn around
unenclosed lettering — a text-shaped blob sitting exactly on the text, which beats every real
balloon on the page. The test is now **containment**, not area ratio.

---

## 2. So what changed on/around 16 July?

Nothing structural. The method visible in the 2026-07-16 recording is **M1**, and M1 is still the
core of what ships today. The changes since are refinements to the same flat-fill idea:

| date | commit | change |
|---|---|---|
| 2026-07-19 | `a32bb4f` | virtual-bubble padding 6 → 0 |
| 2026-08-03 | `6906a71` | contour search reinstated as a YOLO-miss fallback |
| 2026-08-04 | `619e927` | that fallback defaulted **off**; reject search-window contours |
| 2026-08-10 | `232f6ec` | MAD flatness gate — refuse to fill when not flat |
| 2026-08-13 | `b510ecd` | synthesize a balloon rather than refuse; fix the containment test |

**Probable source of the "different method" memory.** There is a *second*, unrelated thing in this
codebase called masking: `5e24bce` (2026-08-08) *"Record measured result of polygon masking"* is
about masking the **OCR crop** — blanking outside the polygon before recognition so a reader does
not pick up text from the neighbouring balloon. That is an input-side mask, nothing to do with
erasure. Its finding was negative and is worth not re-deriving: of 36 low-fill regions re-read with
polygon masking, 12 shed cross-balloon spill, 22 were unchanged, 1 masked to empty; and it *cannot*
substitute for the region-merge fix, because all 214 `bubble` regions carry a polygon and all 77
`direct_text` regions carry none — and the merge defect is exclusively a `direct_text` phenomenon.

---

## 3. The screen recording

`~/Videos/vokoscreenNG-2026-07-16_09-13-50.mkv`, via its sidecar
`/home/sagnik/Projects/cdaf/tests/analyze-masking.cdaf` (validated FRESH — sha256 and byte size
match the container, so the description is trustworthy).

**It is not about masking.** Despite the sidecar's filename, the 27-minute recording is a frontend
session: network throttling in Firefox devtools, lazy-loading thumbnails, an upload failing under
a throttled connection, and an AI-assistant conversation about a React suspense-spinner regression
in `App.tsx`. The masking method appears only incidentally, as rendered output, in two windows —
**[19:15–19:35]** "verifying the rendered chapter with translated text boxes" and
**[20:38–21:05]** "reviewing translated manga overlay boxes in the reader".

If a visual confirmation of M1's output is wanted, those two ranges are where to pull frames from —
that is a targeted `ffmpeg -ss` extraction, not a 20-minute watch. The git history above is the
better evidence either way, and it is unambiguous.

---

## 4. Was our masking better than inpainting?

No — and this is measured, not argued. From `docs/ctd_mask_validation_2026-08-26.md`:

**Balloon-outline damage** (ink on a 9-px band straddling the balloon contour that the mask
destroys) on the comparison page:

| pipeline | outline damage |
|---|---|
| toriitranslate.com (inpainting) | **1.2 %** |
| mangatranslator.ai | 4.9 % |
| **ours (flat fill)** | **21.4 %** |

**Mask geometry**, median over 21 corpus pages — the number a flat slab cannot fake:

| mask | median connected-component area |
|---|---|
| CTD glyph mask | **194 px** |
| ours | **49,276 px** |

A 49,276 px median component *is* the method: we are not erasing text, we are painting an opaque
plate over the region that contains it. On flat white balloons that is invisible and perfectly
adequate — which is why it survived four iterations without anyone minding. On text over artwork or
screentone it destroys everything under the plate, and 10 of the 21 evaluation pages are that case.

### The reason we changed was never "inpainting is worse"

Reading the commits back, every change M0 → M3 was driven by a **visible defect on a specific
page**, and each one narrowed the plate rather than replacing it:

- M0 → M1: the plate was the *text's* box, so it spilled outside the balloon. Fix: use the
  balloon's polygon.
- M1 → M2: the plate was drawn even where no flat colour existed, so it was a mismatched slab over
  artwork. Fix: refuse when not flat.
- M2 → M3: refusing left English on top of unerased Japanese, which is worse. Fix: synthesize a
  covering balloon.

That is a good, evidence-led sequence, and each step was the right local call. But the whole
sequence is a search within one design — *flat fill of a polygon* — and M3 is close to the best that
design can do. R2's own docstring concedes it: *"It is visibly an addition to the artwork rather
than a repair of it."*

**The design being exhausted is the fill, not the layering.** Measured over 271 pages, the flat fill
paints a median **6.3× more area than the ink it covers**, and **49.4 % of every mask lands on
detailed artwork** rather than flat balloon interior (`docs/mask_precision_2026-08-27.md`). That is
the structural error the overhaul plan exists to fix, and it is fixable *without* touching the
base-image-plus-masks model.

Nothing was thrown away that should be recovered. The honest summary is that **the flat fill was
never chosen over anything — it was the first thing that worked, and every change since has been a
repair to it rather than a reconsideration of it.**

### One thing genuinely worth carrying forward

M1's `detect_background_color_poly` **erodes the polygon 5×5 before sampling**, so the colour is not
polluted by the balloon's own border stroke. The same class of mistake reappeared independently in
R2 (sampling inside a text box samples the white stroke around the lettering) and again in the CTD
work (`ocr-corpus-crop-padding`). Whatever samples background colour next should erode or sample a
ring — it has now been the same bug three times.
