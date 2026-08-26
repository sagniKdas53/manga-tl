# Rendered output quality gap — measured, root-caused, and planned

**Date:** 2026-08-05
**Input:** the 31-page `examples/` set, run end-to-end through the fresh deployment at
`3e82f62`; logs in `logs/remote/run-1.log` and `run-2.log`.
**Compares against:** mangatranslator.ai, mangatranslate.com, mangatranslate.online, Google
Lens, two commercial "manga-tl" outputs, and 15 human scanlations.

> `examples/sample22/page-22-export-auto-typeset.png` is dated 2026-06-16 and is excluded
> throughout — it is a leftover from a since-removed experiment, not output from this run.
> Every other export and layer bundle in `examples/` was produced today.

This replaces the one-example note in [TODO.md](../TODO.md) §"Rendered output quality gap vs
mangatranslator.ai" with the full picture.

---

## 1. Verdict

**The gap is not translation. It is erasure and typesetting.**

Read the English alone and ours is competitive — on `sample4` our prose is better than
mangatranslator.ai's, and on `sample1`, `sample20`, `sample22`, `sample27` it is a fair fight.
What loses is everything around the words: we destroy artwork to make room for text, and then
we set the text badly in the hole we made.

One crop carries the whole argument. Same bubble, `sample21`, at the same scale:

| | outline | fill | type |
|---|---|---|---|
| mangatranslator.ai | intact | text fills the balloon | heavy manga face, centred, 7 lines |
| ours | **gone** — the balloon is now an unstroked white blob | text occupies ~40% of the balloon, rest empty | thin sans, overflows the left edge, 3 lines |

and immediately below it, in our render, the second balloon is a **flat grey rectangle painted
over the character's chin**.

## 2. The measurement

`scripts/render_quality_metrics.py` (added with this analysis) scores a render against its
source page on two numbers, no reference output required:

- **altered** — % of page pixels that changed at all. Includes the text we meant to change, so
  it is a smell, not a verdict.
- **flattened** — % of pixels where the original carried local detail (line art, screentone,
  gradient) and the render carries none. A flat fill over artwork lands here; correctly set
  text does not, because glyphs have as much local variance as the ink they replaced.

**flattened, ours vs. everyone else, on the 12 pages where a reference output exists:**

| page | ours | best reference | reference is |
|---|---|---|---|
| sample1 | 1.86% | 1.14% | mangatranslator.ai |
| sample2 | **5.78%** | 0.30% | mangatranslator.ai |
| sample4 | **7.71%** | 3.14% | mangatranslator.ai |
| sample20 | 3.40% | 2.00% | mangatranslate.com |
| sample21 | 2.42% | 0.85% | mangatranslator.ai |
| sample25 | 2.72% | 1.06% | reference |
| sample28 | **8.69%** | 3.15% | human scanlation |
| sample30 | **6.10%** | 1.51% | reference |
| sample23 | **11.03%** | 2.43% | reference |
| sample26 | **14.23%** | 0.48% | reference |
| sample24 | **16.04%** | 2.07% | reference |
| **mean** | **6.85%** | **1.92%** | |

**We flatten 3.6× more artwork than the competition, and we lose on every single page —
there is not one exception.** Over the full 31-page suite (58 renders, export + rendered)
the mean is 4.74% with a max of 16.09%; ten pages exceed the 5% failure line.

A second number separates "spread thin" from "one catastrophic slab" — the **largest single
contiguous flattened blob**, as a share of the page:

| | mean largest blob | worst | pages with ≥1 blob over 0.5% of the page |
|---|---|---|---|
| ours | **2.22%** | 7.03% (`sample24`) | 6 of 11 |
| references | **0.32%** | 1.29% | 3 of 11 |

No reference output — commercial or human — ever introduces a flat blob larger than 1.3% of
the page. Ours reaches 7%. **They never paint a rectangle over artwork. We do it routinely.**

`sample24` is the extreme: **46% of the page pixels altered, 16% of the artwork flattened.**
An entire panel — two characters, the hand-drawn SFX, everything — is replaced by one
uniform tan rectangle carrying a line of 20px text.

## 3. What actually makes them better

Not a better model, and not a better translation. Three habits, all of which we could adopt
without any new ML.

### 3.1 They erase ink. We erase regions.

This is the whole thing, and it is visible directly. The comparison was made by taking the same
balloon from `sample21` and rendering, for each pipeline, **every pixel it changed** as black on
white.

> The side-by-side figure that used to sit here was a crop of an NSFW corpus page and has been
> removed from the repo. To regenerate it for a page of your choosing, diff the source against
> each pipeline's output and threshold the result — `scripts/render_quality_metrics.py` computes
> the same footprint numerically, which is what the percentages in §2 come from.

mangatranslator.ai's footprint is **the Japanese glyph strokes and nothing else** — you can
read 「はぁ…中でめっちゃビクビクしてる…」 in the shape of what they deleted, with the new English
overlaid in the same footprint. The balloon outline, the balloon interior, the fur texture, the
character: untouched, pixel-identical to the source.

Ours is **the entire balloon as a solid silhouette, outline included**, plus a rectangle over
the character's chin at bottom right.

Same input, same target region, two completely different amounts of destruction. Their unit of
erasure is the glyph; ours is the region. Everything in §4 that is catastrophic follows from
that one choice, because once your unit is the region, every downstream mistake — an
over-merged component, a bad polygon, a misdetected watermark — is paid for in artwork instead
of in a few misplaced letters. **Their pipeline is failure-tolerant by construction; ours
converts every upstream error into permanent damage.**

### 3.2 They fill the balloon. We rattle around in it.

Same balloon, measured:

| | glyph cap-height | ink coverage | glyph components |
|---|---|---|---|
| mangatranslator.ai | **98px** | **10.7%** | 50 |
| ours | 49px | 4.4% | 43 |

**Their type is exactly twice the size of ours** for the same balloon and effectively the same
word count, and lays down 2.4× the ink. Theirs reads as lettering; ours reads as a caption
someone forgot to enlarge.

This is not a font-size bug so much as a different objective. They fit type to the *balloon
interior* and target a fill ratio. We fit type to a box derived from the source text's bounding
geometry, refuse to hyphenate, and accept whatever size falls out — which in a tall narrow box
is always small (D6, D7).

### 3.3 They do less, so they break less.

A consistent policy of restraint across every reference output:

- **Untranslatable or ambiguous text is left alone, not erased.** Every reference leaves the
  hand-drawn SFX (はぁ, ドチュ, プルプル) exactly as drawn. So do we — except that we sometimes
  *erase* them first and then fail to put anything back (`sample21`, `sample20` have
  erased-but-empty balloons; `sample10` flattens the 「うわああ」 SFX area to a lavender slab).
- **Non-dialogue is skipped entirely.** mangatranslator.ai ignores the artist's signature on
  `sample2`; we OCR it as `兔猫锚ommision@免猫锚`, translate it to "Rabbit-Cat-Anchor omission @
  Exemption-Cat-Anchor", and hand it 24% of the page (D10).
- **When they can't preserve a shape, they preserve the art around it.** On `sample4`'s stats
  panel they typeset each radar-chart label in place and leave the chart; we merge the panel
  into one region and delete the chart.
- **Nothing that isn't text ever gets a backdrop.** No reference output contains a filled
  rectangle. Not one, across 12 pages.

The uncomfortable version: on the pages where we lose worst, the *right* behaviour would have
been to do nothing at all. Leaving the Japanese visible on `sample24` would have scored better
than what we shipped.

## 4. What we are doing wrong

Ranked by how much damage each does.

### D1 — We erase with a flat colour fill. There is no inpainting anywhere.

`grep -rn inpaint worker/src backend/src frontend/src` returns **one comment and zero code**.
The entire "remove the source text" step is: sample one background colour from inside the
region polygon (`ocr.py:969` `detect_background_color_poly`), then paint the whole polygon
that colour — `render.py:765` `draw.polygon(poly_tuples, fill=bg_color_hex)` and
`Reader.tsx:2290` `ctx.fill()`.

That is correct only when the region is a flat white balloon interior. On artwork it is a
paint bucket. Every catastrophic page in the table above is this one line.

**Fix:** erase the *glyph strokes*, not the region. Threshold within the region to get a text
mask, dilate it by a stroke width, and `cv2.inpaint` (TELEA is enough for balloon interiors;
a LaMa/MI-GAN pass is what the competition uses for text over art). Reserve the flat fill for
the case where the region is provably a uniform-colour balloon interior — measure the
variance you already compute in `detect_background_color_poly` and refuse to fill when it is
high.

### D2 — The painted polygon is the *outer* bubble contour, so the balloon outline goes with it.

`bubble_detector.py:190` derives `mask_polygon` from the un-eroded cleaned YOLO mask — the
balloon's outer boundary, black stroke included. `ocr.py:990` stores it, `textBoxFor` passes
it through unchanged, and the renderer fills it solid. The stroke is inside the fill.

Visible as a fully unstroked blob on line-art pages (`sample21`, `sample20`, `sample28`) and
as a ragged, notched outline on colour pages where the polygon happens to wander in and out
of the stroke (`sample1`, top-right balloon).

The eroded mask already exists — `YOLO_MASK_EROSION=3` produces `safe_rect` at
`bubble_detector.py:206` — but only its *bounding rect* is kept, and the fill uses the
un-eroded contour.

**Fix:** keep the eroded **polygon**, not just its bounding rect, and fill that. 3px of
erosion is also too little for a page rendered at 6879px wide — make it a fraction of the
bubble's minor axis, floor 2px.

### D3 — Free-floating text has no bubble, so the "mask" is the OCR quad.

When YOLO finds no balloon, `maskPolygon` becomes the four-point OCR quad (`sample2`:
`poly pts: 4`), `backgroundColor` becomes a colour sampled from the artwork, and the renderer
paints a rectangle. This is `sample2`'s beige slab over the signature art, `sample23`'s purple
slab, `sample24`'s tan panel, `sample26`, `sample28`'s grey hexagon-replacements, `sample30`.

The competition never paints a rectangle. mangatranslator.ai on `sample2` inpaints the
vertical column stroke-by-stroke and sets the English in free space over untouched art —
0.30% flattened against our 5.78%.

**Fix:** free-floating text must never get a filled backdrop by default. Inpaint the glyphs
(D1) and set the translation over the recovered art with a stroke (D9). If inpainting is
unavailable, leaving the source text visible is strictly better than destroying the panel.

**Status (2026-08-10): partially fixed, on `ocr-pre-grouping-baseline` and `main` (worker
`a5ac096`/`232f6ec`).** Independently re-confirmed via `sample21` (the picture-frame slab) while
validating the pre-grouping baseline — this bug predates the region-grouping work and hit both
worker histories identically. `detect_background_color`/`_poly` now return `None` instead of
always returning a colour, gated on a per-channel median-absolute-deviation spread check
(`BACKGROUND_FILL_MAX_SPREAD`, default 20); `render_image_core` already skipped the fill when
`backgroundColor` is falsy, so no renderer change was needed. This is the "if inpainting is
unavailable, leaving the source text visible is strictly better" half of the fix — real glyph-mask
inpainting (D1) is still not implemented, so a free-floating region over a *uniform* background
(e.g. a plain wall) still gets a flat fill, correctly, but a region over a textured one now leaves
the source art untouched underneath the new text rather than painting over it.

**Status (2026-08-12): the visible consequence is now measured, and it is not a threshold to
tune.** Across the 40-page corpus 21 regions get no fill, 7 of them inside a properly detected
bubble, which means the Japanese stays visible under the English. `sample28` is the worst page —
five of nine. It is tempting to read that as the spread check over-firing on the very ink the
fill exists to cover, and that reading is **wrong**: measured over the polygon interiors, the
declined balloons carry *less* ink than the filled ones (5-8% of pixels against 7-11%). What
blows the spread is a vertical colour **gradient** — MAD 24-88 against the threshold of 20, with a
44-74 top-to-bottom drift. There is no single colour that represents those regions, so raising
`BACKGROUND_FILL_MAX_SPREAD` would paint a flat swatch over every gradient balloon on the page,
which is the exact defect this check was added to stop. The check is correct and the capability is
missing: gradient-aware fill (repaint the sampled gradient per scanline) or real inpainting. **This
half of D3 therefore folds into D1** and should not be worked as a D3 tuning item. Confirmed not
recoverable by QA — see §8.

### D4 — Region merging is unconstrained connected components, and the merged mask is a convex hull.

`merge_regions.py:110-146` builds an adjacency graph on pure bbox proximity — no bubble
membership, no panel membership — and takes connected components. Two balloons whose text
columns pass within `avg_width × threshold` chain together; on an SFX-dense page everything
chains into one component. `_merged_mask_polygon` (`:58`) then takes the **convex hull** of
the member polygons, which by construction fills the gap *between* them.

- `sample1`: 「ああ、着替えたら向こうの岩場に集合な」 and 「こんなチャンスめったに無い…楽しみだろ？」 are two
  separate balloons in the art and **one region** in `project.json`. The hull spans both plus
  the luggage between them.
- `sample4`: the entire bottom panel — radar chart, axis labels, stat list — merges into one
  region. The chart is gone from our render; mangatranslator.ai typesets every label in place.
- `sample24`: a panel's worth of scattered hand-drawn SFX becomes one region covering 55% of
  the page.

And `docker-compose.yml:203` sets `OCR_MERGE_THRESHOLD=${OCR_MERGE_THRESHOLD:-1.0}` — **double
the 0.50 the code defaults to** at `merge_regions.py:95`. The deployed threshold is 2× more
aggressive than the one the merge logic was tuned against.

**Fix, in order of effort:**
1. Drop the compose default to `0.5` to match the code. One line, measurable today.
2. Refuse to merge across a bubble boundary: two regions may only merge when they share a
   `bubbleId`, or when neither has one.
3. Never hull. Union the polygons (or keep them as a multi-polygon) so the gap between two
   balloons is never painted.
4. Cap region area — reject any merged region above ~8% of page area and split it back.

### D5 — Masks and text are interleaved, so one region's fill lands on its neighbour's text.

Both renderers loop *per element* doing mask-then-text: `render.py:722` and `Reader.tsx:2258`.
Element N+1's backdrop is therefore painted over element N's glyphs.

`sample10` shows it plainly: the yellow balloon reads `'LL PAY BACK / HE MONEY I / PENT ON MY
/ VENTUALLY!` — the first letter of every line eaten by the white bubble drawn next to it.
`sample22` overlaps "OMAKE" and "(Bonus)" the same way.

**Fix:** two passes. All masks, then all text. Both renderers. This is a small, safe change
with a visible payoff.

### D6 — The text box is the bubble's *bounding box*, not the area text can occupy.

`JobCoordinatorService.textBoxFor` (`:1170`) takes `bubbleW/H` and insets a flat
`TEXT_BOX_PADDING = 20` (`:1112`). For an oval or a spiked balloon the bounding box is far
larger than the inscribed area, so lines that "fit the box" run outside the visible balloon.

Visible in `sample20` ("UNLIKE KAWAYU" outside the balloon), `sample22` (the OMAKE bubble
spilling both sides), `sample28` ("SOME SLIGHT DIFFERENCES" leaving the grey box onto the
art), `sample21` (line starts left of the balloon edge).

And 20px is an absolute constant applied to pages from 832px to 6879px wide.

**Fix:** compute the largest inscribed rectangle of the mask polygon and use that as the box;
make the padding proportional to the bubble's minor axis. The polygon-aware wrapper in
`fitText.ts:90` already knows how to flow to a shape — it is just being handed the wrong box,
and it disables itself (`fitText.ts:75-80`) whenever the mask does not span the box, which is
exactly the oval case.

### D7 — Font size collapses in column-shaped boxes.

The clean-fit search (`fitText.ts:509`, `render.py:622`) will not break a word, so a box
narrower than the longest word forces the size down until it fits. In a tall narrow box that
means 3 lines of text in the top third of a balloon and two-thirds empty air (`sample21`), or
genuinely tiny type (`sample20` "You're completely stark naked...", `sample10` bottom-left
caption).

`freeTextBox` (`:1224`) already reshapes column-shaped *free* boxes to square. Bubble boxes get
no such treatment, and the reshape preserves area rather than targeting a fill ratio.

**Fix:** target a fill ratio (manga lettering typically fills 70–85% of the balloon interior),
allow hyphenation with a real dictionary rather than per-character splitting, and let the
search grow past the current `min(h/2, w/3, 72)` cap — 72px is small on a 6879px page.

**Status (2026-08-10): the width cap is fixed, the rest of this item is not.** Independently
re-confirmed via `sample1` against mangatranslator.ai (bubble-by-bubble: ours consistently smaller
and narrower for the same balloon) while validating the pre-grouping baseline — predates the
region-grouping work, hit both worker histories identically, fixed on both
(`ocr-pre-grouping-baseline`/`main`, worker `a5ac096`/`232f6ec`). Dropped the `w/3` term from
`max_start_size` entirely rather than raising it: `fits_clean` already rejects any size that
overflows the box width or breaks a word, so the pre-cap was redundant with a real check further
down and only ever prevented the search from trying sizes that check would have accepted anyway.
The 72px absolute cap, the fill-ratio target, and dictionary hyphenation are all still open.

**Update:** `fitText.ts` (the browser-side twin of `fit_text_in_box_py`, used by both export
handlers and by the live reader whenever `element.autoSize` is set) had the identical `maxWidth /
3` term and was fixed the same way. The live reader mostly avoided the bug in practice — when
`autoSize` is unset it just displays the `element.size` the backend already computed — but
`handleExportPng` and `handleExportZip` call `fitTextInBox` unconditionally, so every exported
PNG/ZIP was silently capped at the old limit regardless of what the on-screen reader showed.

**Status (2026-08-13): fixed in `render.py`** (worker `a9f5c30`), not yet mirrored into
`fitText.ts` — see D8. Both remaining causes turned out to be measurable rather than a matter of
taste, once `fit_text_in_box_py` was made to report *which* rule stopped the search (`limitedBy`
in its return, values `size_cap | height | width | unbreakable_word | mask | none`). Over the
40-page corpus, post-fix attribution: 123 `unbreakable_word` at median fill 0.43, 85 `height` at
0.97, 57 `width` at 0.93, 51 `size_cap` at 0.60, 35 `mask` at 0.84.

+ **Hyphenation, not a fill-ratio target.** The `unbreakable_word` group is the underfill: one
  word wider than the line holds the whole balloon at the size that word fits whole. pyphen
  (Liang dictionaries, `left=2 right=3`, positions computed on the word's alphabetic core so
  punctuation cannot buy an illegal break) supplies the break; `break_word_to_width` takes the
  largest legal point that fits and carries the hyphen. Per-character splitting survives only for
  boxes narrower than the shortest legal head, where the alternative is ink outside the region.
  `broke_a_word` now reassembles the lines (a hyphen-terminated line joins the next without a
  space) and compares against the input, so the rejection rule became "no *illegal* split" rather
  than "no split".
+ **The 72px cap — and `max_height // 2`, which was worse.** One line at `h/2` with a 1.2
  line-height fills exactly 60% of its box and nothing more; the `size_cap` group's median fill of
  exactly 0.60 is that arithmetic showing up in the data. `max_start_size` is now the box height.
  It is only a search *bound*: height, width, the word rule and the mask are all still checked per
  candidate, so a generous bound costs bisection steps, not correctness.

No fill-ratio target was needed in the end — with the two artificial ceilings gone, the ordinary
"largest size that fits cleanly" search lands in the references' range on its own. Median fill
0.591 → **0.866** (references 0.70–0.85), elements under 0.45 fill 126 → 66, median type 23 → 27px,
mask escapes unchanged at 2.

The cost is that larger type makes the remaining defects more legible: ink outside a *reshaped
free box* 116 → 138 occurrences (D6's backend half — `freeTextBox` widening — untouched by this),
and D10's junk regions and D16's tofu glyphs now print bigger. Neither is made more likely; both
are on the list.

### D8 — The two renderers disagree.

`page-N-export.png` is the browser canvas (`Reader.tsx:2258`). `page-N-rendered.png` is PIL in
the worker (`render.py:722`). They are separate implementations of the same spec, and they
diverge: 40,853 differing pixels on `sample1` (3.9% of the page), 160,696 on `sample2`. The
`sample1` crop shows the same text block sitting roughly half a line-height apart vertically —
canvas uses `textBaseline="middle"` with `startY` as the first line's centre, PIL anchors at
the ascender.

The frontend also **paints the mask when the element has no text**, where `render.py:724` has
`if not text: continue`. With 110 failed translation batches in the remote run (§5), that is
where `sample21`'s and `sample20`'s erased-but-empty balloons come from.

**Fix:** one renderer. Given the export must work offline in the browser, the cheapest honest
option is to make the worker the single source of truth and have the export fetch
`/api/pages/{id}/rendered`, keeping the canvas path only for live preview. Failing that, a
shared golden-image test that runs both and diffs them. The empty-text guard should go in
today either way.

### D9 — Typography: wrong face, no stroke, wrong colour, inconsistent case.

- **Face.** `Comic Neue` is the default everywhere (`JobCoordinatorService:1464`,
  `render.py:17`). It is a light, round, low-contrast web font. Every reference output uses a
  Wild-Words-class comic letterer with heavy strokes and tight tracking. This alone accounts
  for a large share of the "theirs looks professional, ours looks like a UI" impression.
- **No stroke.** `grep strokeText` and `grep stroke_width` both return nothing. Black text on
  dark artwork is unreadable — `sample2` sets "I'M ON THE EARTH WHERE I WAS BORN" in black over
  a dark red traffic light. Every reference output strokes floating text in white.
- **Colour.** `getContrastingTextColor` (`:2120`) returns black unless the sampled background
  is dark. The source lettering's own colour is never sampled: `sample2`'s green narration
  becomes black (mangatranslator.ai keeps it green), `sample28`'s pink and white HUD text
  becomes black (the human scanlation keeps both).
- **Case.** Uppercase is applied only when `regionType == "speech"` (`render.py:733`), so the
  same page mixes ALL CAPS balloons with sentence-case captions — `sample4`, `sample20`,
  `sample21`, `sample22` all show it.
- **Leading.** Fixed 1.2 with no tracking control; manga lettering sits nearer 1.0–1.1.

### D10 — Non-dialogue text is OCR'd, translated, and typeset.

Nothing filters watermarks, signatures, page numbers, or logos.

- `sample2`: the artist's handwritten "Commission" signature is read by PaddleOCR as
  `兔猫锚ommision@免猫锚` (Latin script misclassified as CJK), translated to
  **"Rabbit-Cat-Anchor omission @ Exemption-Cat-Anchor"**, and given a 1459×1100px region —
  24% of the page — with a solid fill.
- `sample22`: `@yuzukano2` typeset as dialogue. `sample28`: a stray "M".
- Translator glosses leak onto the page: "Haha (Giggle)" (`sample21`), "SHIMMER (SOUND OF A
  REFLECTION)" (`sample19`), "OCHIN (PLOP)" / "MUYA (SQUISH)" (`sample24`), "PURUPUN (WOBBLE)"
  (`sample6`). A gloss belongs in a note, not in the balloon.
- `sample24` renders the literal string **"[REDACTED]"** — model self-censorship reaching the
  page. 6 occurrences in `run-2.log`.

**Fix:** a region classifier gate before translation — drop regions that are (a) low OCR
confidence *and* outside any detected bubble/panel, (b) script-inconsistent (Latin glyph
shapes read as CJK), (c) in the page margin, (d) above the area cap. Strip parenthetical
glosses in the render layer. Reject `[REDACTED]`-class outputs at QA.

### D11 — Colour SFX are dropped rather than re-lettered.

`sample10`: the human scanlation re-letters「うわあああ」as a large blue outlined "WAAAAAH!" and
「ピピ」as an orange "BEEP". We flatten the whole area to a lavender rectangle and set "FOR
REAL?" in 20px black. Same for the yellow spike balloon — theirs is "HANG ON!" filling the
shape, ours is "WAIT." at 10px in the middle of it.

This is a genuine feature gap, not a bug, and it is the most visible remaining difference on
pages where everything else is right. It needs a display-font path with stroke, fill, and
rotation driven by the source SFX's own geometry and colour.

### D12 — Canvas exports silently fall back to the wrong font.

`Reader.tsx`'s `handleExportPng` and `handleExportZip` set `ctx.font = ...\"Comic Neue\"...` and
call `fillText` with no check that the face is actually loaded. Canvas text does not trigger a
web font load the way DOM text does — it just substitutes the fallback (`sans-serif`) if the
requested face isn't already in `document.fonts` at the moment `fillText` runs. The live reader
never hits this because it renders text as real DOM nodes (`foreignObject` + `div`), so it always
rides the browser's normal `@font-face` swap; a freshly built export canvas, especially moments
after opening a page, has no such guarantee. `grep -rn "document.fonts"` returned nothing anywhere
in the frontend before this was fixed.

**Fix:** `ensureFontsLoaded` in `fitText.ts` awaits `document.fonts.load(...)` for every distinct
font/weight/style combination about to be drawn, before either export handler's draw loop.
No-ops (does not throw) where the Font Loading API isn't available, e.g. in tests.

**Status: fixed** (`ocr-pre-grouping-baseline` and `main`).

### D13 — `render.py` fit and draw geometry disagreed by a few pixels.

`fit_text_in_box_py`'s polygon path computes each line's horizontal span assuming the text is
centred within an inset box (`ex+4, ey+4, (ew-8)*0.95, (eh-8)*0.95)` — that's what it's passed as
`box_x`/`box_y`/`max_width`/`max_height`. `render_image_core`'s draw loop instead centred and
clamped against the raw outer box (`ex, ey, ew, eh`). The few-pixel mismatch was invisible at the
font sizes the D7 bug produced; once D7 was fixed and text got bigger, a line fit for a bubble's
wide middle could land a few pixels off from where the fit assumed it would, right where an oval
mask had already narrowed — visible as text spilling outside the white area onto the art behind
it (`sample1`'s merged bubble, once D7 stopped undersizing the text enough to hide it).

**Fix:** introduced `text_box_x/y/w/h` as the single source of truth for both the `fit_text_in_box_py`
call and the draw geometry (centring and the horizontal clamp), so they can no longer drift apart.

**Status: fixed** (`ocr-pre-grouping-baseline` worker `5c2f04f`, `main` worker `6fbf4d3`).

---

## 5. Plan

### Phase 0 — configuration and guards (hours, no design work)

Expect the worst pages to improve immediately; this is the highest ratio of payoff to risk.

1. `docker-compose.yml:203` — `OCR_MERGE_THRESHOLD` default `1.0` → `0.5`. (D4)
2. Cap merged-region area at ~8% of page; split above it. (D4)
3. `Reader.tsx` — skip elements with empty text, matching `render.py:724`. (D8)
4. Two-pass render: all masks, then all text, in both renderers. (D5)
5. Uppercase consistently for all dialogue-class regions, not only `elliptical`. (D9)
6. Strip parenthetical glosses and `[REDACTED]` at render time. (D10)

**Re-run `scripts/render_quality_metrics.py --suite examples/` after each. Target: no page
above 8% flattened.**

### Phase 1 — stop destroying artwork (the real fix)

7. Replace flat-fill erasure with glyph-mask inpainting (`cv2.inpaint` first, LaMa/MI-GAN
   behind a flag). (D1)
8. Fill the *eroded* bubble polygon, scale erosion to bubble size, keep the outline. (D2)
9. Never fill a backdrop for free-floating text. (D3)
10. Union instead of convex hull; refuse to merge across bubble boundaries. (D4)

**Target: mean flattened ≤ 2.5%, max ≤ 5% — i.e. inside the reference band.**

### Phase 2 — set the text properly

11. Largest inscribed rectangle of the mask polygon as the text box; proportional padding. (D6)
12. Fill-ratio-targeted sizing, dictionary hyphenation, lift the 72px cap. (D7)
13. Vertical centring on the balloon interior, not the bbox (which includes the tail). (D6)

### Phase 3 — typography

14. Ship a manga lettering face and make it the default. Licensing matters here — Comic Neue
    is OFL, most Wild-Words-alikes are not. Blambot's free-for-independent faces (Digital Strip
    BB, Back Issues BB) and Komika Text are the usual escape hatch; confirm terms before
    bundling.
15. White stroke on all text, width proportional to font size, mandatory outside balloons. (D9)
16. Sample the source lettering colour and carry it over. (D9)
17. Tighten leading to ~1.05 and expose tracking. (D9)

### Phase 4 — content gating and SFX

18. Region classifier gate before translation. (D10)
19. Script-consistency check on OCR output. (D10)
20. Display-font SFX path with stroke, fill, and rotation. (D11)

### Phase 5 — one renderer

21. Collapse the canvas and PIL renderers, or bind them with a golden-image test. (D8)

---

## 6. Deployment problems the run exposed

Separate from rendering, but they shaped these outputs — a failed translation still gets its
balloon erased by the frontend export (D8), which is where the blank balloons come from.

| count | signal |
|---|---|
| 110 | `Batch translation with fallback 'openrouter'/'deepseek/deepseek-v4-pro' failed` — against 86 rendered pages |
| many | `Insufficient credits` from OpenRouter; the fallback chain exhausts rather than degrading |
| many | `model: inclusionai/ling-3.0-flash does not support feature: structured-outputs` (Novita) — a model in the chain cannot satisfy the structured-output contract the pipeline requires |
| 54 | `[OCR Redo] Cloud OCR error from provider=openrouter` |
| 14 | `AuthorizationDeniedException: Access Denied` (backend) |

The structured-outputs mismatch is a provider-config bug worth fixing on its own: that model
should not be in a chain that requires structured outputs.

---

## 7. The 2026-08-12 A/B run

All 40 SFW samples run end-to-end on `main` (grouping, `OCR_MERGE_THRESHOLD=0.35`, waist gate and
orientation vote on) and on `ocr-pre-grouping-baseline` (the pre-2026-08-09 deployed defaults),
then compared region-by-region against each other, against the voted ground truth in `corpus/ocr/`,
and against the human and mangatranslator.ai renderings in `corpus/samples/`. Artifacts and run
provenance: `corpus/exports/` (see its README).

**Two conditions decide how these numbers read.** Both runs were **single-pass with QA off** — no
re-OCR, no QA re-translation, the page ships what the first pass produced — so every defect here is
an upper bound on what a user running with QA on would see, the translation-side ones especially.
And the run used **the same model mangatranslator.ai uses**, so the gap against
mangatranslator.ai is not a model-quality gap: it is our region proposals, our prompt
contract and our renderer. Note this also means `corpus/samples/*/export.png` and `render.png` are
*not* a valid comparison point — those were produced with QA on and higher-tier models, so diffing
against them measures the QA pass, not a change.

### 7.1 Grouping wins, and the baseline branch is retired

| | regions | of 363 GT |
|---|---|---|
| `main` | 351 | −12 |
| `ocr-pre-grouping-baseline` | 278 | −85 |

Checked both directions by bbox overlap: every baseline region has a `main` counterpart, and 73
`main` regions have none. So the baseline's shortfall is not recall the grouping traded away — it
is text merged into a neighbouring balloon and then set as one blob across both. `sample23` is the
extreme (17 regions vs 2, the two rendered as paragraph-blobs over the character's face);
`sample1`, `sample3`, `sample25`, `sample30` and `sample34` show the same failure smaller.

`ocr-pre-grouping-baseline` was retired on this result (manga-library `69aacdf`), with
`config/providers.json` — its one unique change — brought onto `main` first.

### 7.2 New defects the run exposed

#### D14 — Grouping shreds vertical multi-column narration.

`sample2`'s narration column becomes five regions, split mid-word (`違う星から来` | `たみたいだった`),
each translated on its own. The page ships `"KITA (ARRIVED FROM)"` and four blocks of ~4px type.
The baseline read it correctly as one block, and so does mangatranslator.ai.

The gap budgets in `fragment_grouping.py:100-101` are symmetric in form but not in what they mean:
for vertical text `max_vertical_gap` scales from `avg_width` (correct — a column's width is the
font size) while `max_horizontal_gap` scales from `avg_width` too, so the *inter-column* budget is
one character wide. Column-set narration outside a balloon has no bubble mask to bind it, and
inter-column leading in vertical Japanese is routinely wider than one character, so adjacent
columns of the same block never join.

**Fix:** for text resolved as vertical (`resolve_vertical`, `:124`), scale the cross-axis budget
from the column pitch — the median centre-to-centre distance between neighbouring columns — not
from `avg_width`. Bind columns that share a baseline range and are consecutive in reading order.
Gate the whole thing on the region being outside any bubble mask, where D4's waist veto has nothing
to say.

#### D15 — The translation unit is the region, so a sentence spanning regions is translated as fragments.

`sample9`'s `って` is its own balloon and is translated standalone as **"like"**; the human
scanlation reads "W-WAIT". The batch prompt (`services/translation.py:58-60`) already sends every
region of the page in reading order and asks for context to be maintained, but the response
contract is 1:1 region→string, so a sentence broken across two balloons has to be broken back
across two strings, and the model has no way to say "these two are one utterance".

This is not caused by grouping — the baseline hits it too, less often because its over-merging
happens to reunite some of them — but grouping makes more, smaller regions, so it surfaces more.

**Fix:** let the batch response carry an optional continuation group id, translate the group as one
utterance, then split it back on clause boundaries proportional to each region's capacity. Cheaper
interim: pass each region's neighbours as context and instruct that a fragment which is not a
complete utterance should be rendered as its natural English part, not as a standalone gloss.

#### D16 — Unsupported glyphs render as tofu boxes.

`sample30` sets `senpai~♡` and the `♡` comes out as a notdef box; `sample23` carries `帅哥` through
untranslated (D10) and prints two boxes. Comic Neue has neither, `render.py` loads exactly one face
and PIL substitutes nothing.

**Fix:** a fallback chain in the render layer — primary lettering face, then a CJK face, then a
symbol face — resolved per glyph run. Plus a pre-render assertion that every codepoint in the
string has a glyph in some face in the chain; anything left over is a translation bug worth failing
loudly rather than printing a box.

### 7.3 Status refresh on existing D-codes

- **D6 (text box is the bbox, not the fillable area) — still open, now measured.** `sample1`'s
  bottom-left balloon: OCR bbox spans x 43–156, drawn ink spans x 25–168, and the first line
  visibly crosses the oval's outline. D13 aligned the fit box with the draw box; both are still the
  *bounding* box, so a line sized for the balloon's wide middle overflows where the oval narrows.
  Dropping D7's `w/3` pre-cap made this reachable for short strings that previously never got big
  enough to hit it.
- **D7 (font-size collapse) — the width cap is fixed, the underfill is worse than before.** Narrower
  regions mean narrower boxes mean smaller type: measured on `sample27`'s first balloon, same
  balloon on both branches, `main` draws 12–13px line height against the baseline's 22px. Regions
  whose longest translated word cannot fit at 12px: 42 on `main`, 26 on the baseline. Against the
  human references we are roughly half their size on the same balloon. The fill-ratio target is now
  the single highest-leverage open item on this page.
- **D8/D12 (two renderers, canvas font fallback) — export/render agreement checked, no fallback
  seen.** `page-9-export.png` and `page-9-rendered.png` match in face and metrics on both branches.
  That is observation on the pages inspected, not the E2E rebuild the 2026-08-10 handoff asked for,
  but nothing in this batch is drawing in the browser default font.
- **D10 (non-dialogue text typeset) — unchanged in kind, up in volume.** Regions under 60px on a
  side: 83 on `main`, 59 on the baseline. Parenthetical glosses reaching the page: 29 and 23
  (`"Puru-pun (STRUGGLING SOUND)"`, `"...Just kidding! (PLAYFUL RETRACTION)"`). Untranslated CJK
  passed through as a translation on both branches: `迷途竹林`, `帅哥`, and the bare characters
  `三 小 江 父 心 大`. The Phase 0 gloss strip and the Phase 4 classifier gate both still apply
  as written.

### 7.4 What to do next

Order is by measured leverage on these 40 pages, not by section number.

1. ~~**Fill-ratio-targeted sizing** (D7 → Phase 2 item 12) and **largest-inscribed-rectangle text
   box** (D6 → item 11).~~ **Done in `render.py`, 2026-08-12/13** (worker `4b7c7a4`, `a9f5c30`) —
   see the status blocks under D6 and D7. Escapes 45 → 2, median fill 0.591 → 0.866. No fill-ratio
   target was needed: hyphenation plus removing the `min(h/2, 72)` ceiling let the ordinary
   largest-clean-fit search land in the references' range by itself. Two pieces of this remain
   open: the mirror into `fitText.ts` (D8), and the backend's `freeTextBox` widening, which is
   what the surviving "ink outside the box" cases are.
2. **Gloss strip and junk-region gate** (D10 → Phase 0 item 6, Phase 4 item 18). Cheap, mechanical,
   removes 29 visible defects and ~80 stray typeset fragments.
3. **Font fallback chain** (D16). Hours, and it removes a class of defect that reads as broken
   software rather than as a bad translation.
4. **Vertical column-pitch grouping** (D14). Contained to `fragment_grouping.py`, and `sample2`
   is a ready-made regression test.
5. **Continuation groups in the translation contract** (D15). The largest of the five and the one
   that needs a schema change; worth doing after 1–4 have moved the visible baseline.

Re-run the whole corpus after each and diff `corpus/exports/main/` — the region counts, the
width-starved count, and the gloss count above are the regression bar.

## 8. The QA control (2026-08-12)

§7's run was **single-pass, QA off**, deliberately. That leaves one obvious objection open — that
the QA phase would have caught the worst of it — so two pages were re-run with QA enabled and
diffed against their own no-QA output. Artifacts: `corpus/withQA/` (note the page numbers there do
*not* follow the sample numbers; `page-1` is `sample28`, `page-2` is `sample10`).

Same `imageId` in both runs, same branch, `PaddleOCR(PP-OCRv6_medium_rec)` +
`deepseek/deepseek-v4-pro` in both, $0.0035 and $0.0031 per page.

### QA rewrites text and touches nothing else

All 25 elements match their no-QA counterparts at **IoU 1.00**, and every `backgroundColor` is
byte-identical. Regions with no fill: 5 -> 5 on `sample28`, 4 -> 4 on `sample10`. So none of the
geometry defects in §7 are recoverable by QA — not the box, not the fill, not the region split.
Everything in D6/D7/D14 has to be fixed in the pipeline or not at all.

### What it did buy, and what it cost

Fixed, on two pages:

- a pronoun error: "I always liked driftwood" -> "*you* always liked things that washed ashore";
- a garbled number sequence: `72797... 172799. 172798 172800` -> `172,800... 172,799, 172,798,
  172,797`;
- one D10 gloss: `Eh (HMM?)` -> `Huh?`;
- one watermark leak: `@mer It's fine.` -> `Very well.`

Cost, on the same two pages:

- `Mumble mumble...` -> `Say your complaints.` — invented content over an OCR junk region, which is
  worse than the placeholder it replaced;
- `Deadline Countdown!` -> **`[Illegible sign]`**, typeset literally onto the page. That is D10's
  `[REDACTED]` class with a new spelling, and it argues for the render-layer string gate whether or
  not QA runs.

So QA is worth having for pronouns, numbers and context, and is not a substitute for any of the
geometry work. It also strips *some* glosses — but see below for why that is the expensive way to
fix them.

### D10's glosses are prompt-specified, not model disobedience

28 of the 29 parenthetical glosses on the corpus are the exact shape the prompt asks for.
`MANGA_TRANSLATION_JSON_SYSTEM_PROMPT` (`worker/src/worker/services/translation.py:56`) contains a
direct self-contradiction:

```
- "sfx": Transliterate the sound effect AND provide an English equivalent
         in parentheses (e.g. "DOKAA (WHAM)").
...
NEVER include romanized text, pinyin, romaji, or pronunciation guides.
BAD: "ERUFU (ELF!)"
GOOD: "ELF!"
```

`DOKAA (WHAM)` and `ERUFU (ELF!)` are the same string in the same shape, given once as the required
format and once as the forbidden one, eleven lines apart. `Puru-pun (STRUGGLING SOUND)` and
`KOROSHI NASAI (KILL HIM)` are the model following the first rule. The references pick the other
side — the human scanlations letter `Tremble Tremble` and `Ba-dump`, no romaji.

**Fix:** decide which rule survives and delete the other; keep the render-layer strip as defence in
depth for the residue (the 1 gloss that is genuine drift, `...Just kidding! (PLAYFUL RETRACTION)`,
came from the model generalising the sfx rule onto dialogue). One prompt edit is cheaper and more
reliable than a QA pass per page. Same file, minor: `MANGA_TRANSLATION_SYSTEM_PROMPT` has
`- Do not explain.` twice.
