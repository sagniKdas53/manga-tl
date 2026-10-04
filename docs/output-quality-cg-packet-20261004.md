# C + G packet: the export draws text like the editor, then text style

Written 2026-10-04. **A plan, no code.** It is built after A (cleanup masks, an edge case) and B
(one balloon, one text unit), because typesetting is tuned on what those two produce: B decides
the text units, A what they sit on. Three decisions are yours; they are at the end.

## In short

| Part | Kind | What it changes | Size |
| --- | --- | --- | --- |
| **G2: the export uses the balloon shape** | output | On about half of all text, the export stops drawing a smaller font or different line breaks than the editor | 1–2 days |
| **Outline width** | output | Optional. Thinner outline on big titles, thicker on small text, as Torii draws it | half a day |
| **H1: check `PUT /scene` against the schema** | upkeep | Nothing visible | a few hours, with G2 |
| **C: split `background_color`** | mostly upkeep | Only pages where you use "plain mask" and want an outline colour unlike the plate | 1–2 days |
| **Font weight defaults** | upkeep | Nothing today (every element is bold) | minutes, with G2 |
| **M7 scope** | — | What stays for later typesetting packets | — |

## What was measured today

All numbers are from the laptop's dev database (153 pages, 865 translated text elements) and the
270 Torii bundles in `corpus/samples/*/sample*/torii/metadata.json`. Nothing was changed.

**1. The balloon shape is the biggest remaining mismatch.** The editor fits text into the
element's `mask_polygon` when the polygon is at least as wide as the text box. Every translated
element on this database has one, of two kinds: 503 are traced balloon outlines from the bubble
detector, and 362 are rectangle-like (the text's bbox, or the padded rounded "cover" shape the
worker draws round it). The export never sees the polygon, because the page scene does not carry it,
so it fits into the plain rectangle or ellipse. Measured by running the editor's own `elementFit`
in Chromium with Comic Neue loaded, once with the polygon and once without:
- **425 of 865 elements (49 %) on 132 of 153 pages differ.** 373 get a different font size, and 52
  the same size but different line breaks. 301 of the 425 have a traced balloon outline, 124 a
  rectangle-like one.
- **Elliptical elements** (315 with a size change): the editor's text is larger on 288 of them,
  median 1.10× (1.02× to 1.19×, 10th to 90th percentile).
- **Rectangular elements** (58 with a size change): the editor's text is smaller on all 58, median
  0.94× (0.84× to 0.96×). The fitter clamps the polygon to the box, so a polygon can only narrow a
  rectangle's lines.
- The R7 close doc filed this as "test with a masked element". It is not an edge case.

**What this means for G3 (2026-10-03).** G3 made the export wrap elliptical elements in the
ellipse, on the belief that the editor does. The editor does so only when the polygon is ignored:
for 96 of the 682 elliptical elements. For the other 586 it wraps in the polygon. So G3 matched the
editor on those 96 only; on the rest, the export moved from the rectangle to the ellipse while the
editor stayed on the polygon.

**2. Outline width: ours is a fixed 0.18 × font px; Torii's grows more slowly.** Torii's
`lineWidth` is about 3 + font px ÷ 10 (median 4 px under 20 px text, 6 at 20–39, 8 at 40–59, 10 at
60–79, 14 at 100–119). Both are drawn centred on the glyph edge, so they compare directly.

| Font px (ours) | Ours | Torii |
| --- | --- | --- |
| 13 (10th percentile) | 2.3 | 4 |
| 33 (median) | 5.9 | 6 |
| 72 (90th percentile) | 13.0 | 10 |
| 172 (ch. 6 p. 1) | 31.0 | 20 |

At the median they agree. 286 elements have an outline more than 1 px thinner than Torii's, and 230
have one more than 1 px thicker.

**3. Outline colour: no change proposed.** Ours is the local background colour the worker samples.
That is the rule read from Torii's own client on 2026-09-18 (tracker row R2), and the bundles agree:
2,252 of 2,880 strokes are white, 221 near-white, 178 black, 9 near-black and 220 (8 %) other
colours. Ours samples the same way, so some outlines are mid-grey on both.

**4. The plate colour is barely used.** Besides the outline, `background_color` fills the plate
when you choose "cover with a plain mask" (`plain_plate_cleanup`) and the per-layer mask in the
export ZIP. Plain mask is a stop-gap kept only for failed cleanups (your decision, 2026-09-25).

**5. Font weight defaults disagree, but nothing is affected.** With no weight set, the editor
measures text as bold, draws it at normal weight, and the export uses 400. Every element on a
translation layer has `bold`: all 1,280 rows, counting hidden layers and empty elements, so the
865 measured above too. No page on this database shows this today.

## The parts

### G2: the export uses the balloon shape (output)

The shared fitter (`packages/page-scene/src/layout.ts`, `fitTextInBox`) already handles a polygon;
only the export's input is missing it. So the fix is to carry the polygon through:
- `contracts/page-scene-v1.schema.json`: an optional `style.mask_polygon`, an array of at least
  three `[x, y]` pairs. It is optional, like `font_size` and `shape` (contract rule 8).
- The validators: Ajv (`contracts/validate-page-scene-v1.cjs`), Rust (`backend-rust/src/page_scene.rs`)
  and Python (`worker/src/worker/page_scene.py`, whose `CONTRACT_SCHEMA_SHA256` changes).
- `backend-rust/src/page_scene_builder.rs` (`style_for`): write the element's `mask_polygon` when it
  has one.
- `packages/page-scene/src/ContentScene.ts`: pass it to `fitTextInBox`.
- The font-weight defaults: one fallback, 400, wherever `elementFit.ts` and `Reader.tsx` fall back
  to `bold` or `normal` (a few lines).

**Tests:**
- Fixture: a valid scene with `mask_polygon`, and invalid ones with two points or non-numbers.
- ContentScene: the same element with and without the polygon gives the editor's lines.
- Builder: the polygon is written only when present.

**Gate:**
- On the test pages below, every text element gets the same lines and font px in the editor and
  in the export.
- Checked with the probe used today, turned into a script beside `scripts/playwright/r7_parity.cjs`.

**Decision D1:** which way the two should agree. See the end.

### H1: check `PUT /pages/{id}/scene` against the schema (upkeep)

This changes no output, but it goes with G2 because both edit the same contract.
- Add a JSON Schema crate and compile the schema once at startup (`include_str!`).
- Run it in `routes/page.rs::put_page_scene` before the hand-written `validate_page_scene`.
- The fixtures in `contracts/fixtures/page-scene-v1/` are the tests.
- The only risk is a scene the hand rules accept and the schema refuses. Run the valid fixtures
  and one real editor scene through it first.
- Nothing in the app calls this route today (`savePageScene` is used only by its test).

### Outline width (output, optional)

- Replace `STROKE_WIDTH_RATIO` (0.18) in `ContentScene.ts` with a function of font px. The editor
  imports the same constant (`Reader.tsx`), so both change together.
- Torii's curve is about 3 + px ÷ 10.
- Gate: you look at ch. 6 p. 1 (large text) and two small-text fixtures side by side with Torii's
  `translated.png`.

**Decision D2:** keep 0.18, or follow Torii's curve.

### C: split `background_color` (mostly upkeep)

Split the field into an outline colour and a plate colour, so a plain-mask plate can differ from
the text's outline.
- A column in `database/init.sql`, plus an `ALTER` for existing stacks (as `hand_edited_at` had).
- Backend: `models.rs`, `routes/layers.rs`, `layers_ops.rs`, `clone.rs`, `coordinator.rs`,
  `routes/page.rs` (the plain-mask route), `page_scene_builder.rs`.
- A hand edit of `backend-rust/spec/golden-openapi.json` (nothing generates it), then the frontend
  types.
- Editor: the "Outline Color" picker stays, and a "Plate Color" picker appears with plain mask.
  `maskPaint.ts` fills with the plate colour.
- The worker keeps writing one sampled colour into both.

It changes a page only when you use plain mask and then want the outline unlike the plate.

**Decision D3:** build it, defer it, or drop it.

## M7 scope

M7 in the tracker is a large plan. This packet covers its editor/export matching, which is "one
text renderer" in practice: the editor and the export already share the fitter and the stroke
rule, so only the inputs differ.

Left for later M7 packets, each built on B's grouping:
- Source style estimation (H01b, H02).
- Overlapping neighbours, overflow and padding hierarchy (H03, H04: `AUDIT-R9`, `R8`, `R16`).

Their acceptance pages are the five you set on 2026-09-20: sample697–700 and sample76.

## Cost: each page renders once more

G2, and the outline width if chosen, change the scene of nearly every page:
- Nothing re-renders by itself.
- Each page pays once, on its next render: one render, plus a paid QA pass unless it was edited by
  hand.
- G3's per-page cost (2026-10-03) has not been paid yet either.
- Released together, the three cost each page one render, not three. The chrome-box test stack
  had about 600 pages.

## Test pages

- **Ch. 6 p. 1**: large 172 px text, eight editor lines against six in the export before G1.
- **The six fixtures**: sample177, sample222, sample61, sample99, sample93, sample83.
- **One balloon page per language** from the short list: sample7 (ja), sample197 (ko), sample641
  (zh). The six are mostly free-standing text, so they have few traced balloon outlines.
- **An elliptical and a rectangular element with a polygon**, and one plain-mask element (for C).

## Order when it is built

1. G2 with H1 and the weight defaults. One PR, because they share the contract.
2. The outline width, if D2 says so.
3. C, if D3 says so.
4. One release with G3, then the gate run on the test pages.

## Decisions (user, 2026-10-04)

- **D1: (a).** The export follows the editor and fits into the polygon.
- **D2: keep 0.18 × font px** and judge it on the test pages; switch to Torii's curve only if the
  results look wrong.
- **D3: skipped.** The split only matters when you choose **Mask** on a flagged region in the
  review list (the plain-mask stop-gap, used where cleanup left text or found none). The plate
  takes the region's sampled background colour, which is also the outline colour of the text on
  it. An edge case of an edge case: documented here, not built.

So the build is G2 with H1 and the weight defaults, then one release with G3 and the gate run.

## Decisions as they were put

- **D1: which way do the editor and the export agree?**
  - (a) The export follows the editor and fits into the polygon. On the export, elliptical text
    grows (median 1.10×) and rectangular text shrinks a little (0.94×), on about half the
    elements. What you see in the editor is what you get, which is what you chose G3 for; G3's
    ellipse then decides only the 96 elliptical elements whose polygon is ignored.
    **Recommended**, because the editor is what you have been judging.
  - (b) The editor stops using the polygon and wraps in the rectangle or ellipse, as the export
    does. The editor's elliptical text shrinks and its rectangular text grows a little, and no
    contract change is needed. G3 then becomes the full match.
- **D2: outline width.** Keep 0.18 × font px, or Torii's 3 + px ÷ 10.
- **D3: the background colour split.** Build it, defer it until plain mask needs it, or drop it.
