# R7 close and the merge, 2026-10-01

## Start here

The user reviewed R7 on the chrome-box test stack (TELEA chapter
`d5350431-6433-4703-87c4-99a3874dd48c`) and listed ten points, with three screen recordings. This note
records what each point turned out to be, what was fixed to close R7, and what follows the merge.
It replaces the order in [output-quality-next-session-20260929.md](output-quality-next-session-20260929.md):
**R7 closes and PRs #47 and #152 merge first**, then the follow-ups below go in their own PRs.

## The merge plan (user, 2026-10-01)

1. The four R7 fixes below; the user tests them on the chrome-box test stack.
2. `.coderabbit.yaml` (new) excludes `docs/quality-{checkpoints,runs,evidence}/**`. CodeRabbit's
   300-file limit counts files after path filters; #152 had 332, and the filter leaves 184. It
   keeps the organization's UI settings (`inheritance: true`). Docs history is not code, so it is
   not split into its own PR.
3. Both PRs leave draft. CodeRabbit's findings are fixed on both: #47 had 21 open threads and
   "changes requested" on 2026-10-01; #152 gets its first review.
4. Merge: worker #47 first, then bump the parent's `worker` pointer to a commit on worker `main`;
   apply `database/migrations/` to production before it runs `main`.

## The ten points

| # | What the user saw | What it is | Where it goes |
| --- | --- | --- | --- |
| 3 | Resizing the brush moves the page | The mask panel is a React portal rendered from inside the canvas; its mouse events reached the canvas's pan handlers through the React tree. A 140 px slider drag panned the page 140 px (reproduced in Chromium). | **Fixed (R7)** |
| 6 | Odd zoom and mask interactions (video 3) | The same leak: at 0:10 the panel heading is text-selected and the page follows the mouse. The panel's Select menu and touch taps had it too (a tap on a menu item could turn the page on a touch screen). After the fix, zoom grows about the page centre. | **Fixed (R7)** |
| 9 | No way to drag the page while masking | A Pan tool next to Repaint and Restore, the same path as holding Space. | **Fixed (R7)** |
| 7 | The editor looks better than the export; the editor cannot show the outline | The export draws every text with a halo (stroke) in the element's background colour, 0.18 × font px; the editor drew none. The editor now draws it the same way: every halo, then every fill. Weight and line breaks still differ: M7. | **Outline fixed (R7)**; rest is M7 |
| 8 | "Mask Background Color" is really the outline colour | `background_color` has two uses in `page_scene_builder.rs`: the text halo (`style_for`), and the plain plate for a region with no cleanup patch. The picker was hidden unless "Clean background mask" was ticked. Now a text element always shows it as **Outline Color**, with a hint about the plate; a text-less mask shows **Mask Color**. | **Interim (R7)**; two fields is a follow-up |
| 1 | Outlined source text gives a messy patch | Page 1: black text with a soft white glow 10–15 px wide. The CTD mask covers the glyphs plus 5 px; Telea fills from the mask edge, which is the glow, and paints white columns. The user's hand repaint over it (video 1, 1:40) gave a grey smear for the same reason. Torii's inpaint of this column also leaves a pale streak; its white-stroked English hides it. | Follow-up A |
| 2 | Small holes in the masks (pages 2, 14) | The amber tint is each patch's mask. Automatic masks are glyph-tight: a 15 px close + hole fill (what hand marks already get, `tidy_mask`) would add 5–18 % of each mask's area on pages 1, 2, 14. Hand-marked masks have none. Page 14's pink blotches sit in those gaps: source shows through (patch alpha is 0 outside the mask) and Telea smears their edges. | Follow-up A |
| 5 | Text in one balloon is not merged; can it work? | Yes. Each owner already carries the detected balloon (`container_id`). Page 2: `bubble_1` holds 3 regions of one sentence, `bubble_4` holds 4. Grouping joins by distance only; the balloon is used only to *veto* a cross-balloon merge (`owner_assignment.py`), never to cause one. | Follow-up B |
| 4 | Cannot flatten/merge layers | No route can move an element to another layer (`LayerElementDto` has no `layerId`). User decision: **merge into one layer, every patch stays editable** (not baked). | Follow-up D |
| 10 | Cannot rotate text | The Rotation slider works (user). The ask is automatic angles: `AUDIT-R23`. Torii's only rotated box on this page is an SFX (−15°), which we never typeset. | Follow-up E |

## Follow-ups, in order of output value

- **A — cleanup masks (worker).** (1) Close and fill the automatic mask as `tidy_mask` does for hand
  marks. (2) Grow the mask over an outline or glow: look at rings just outside the mask; while a
  ring's colour is consistent and differs from the far background, keep growing. Apply to hand
  marks too. Measure offline first (pages 1, 2, 14 of TELEA from `scene-assets`, the six fixtures),
  bump the generator id, then one labelled re-run.
- **B — one balloon, one text unit (extends `AUDIT-R21`).** Regions sharing a bubble container are
  grouped in reading order and translated together. Gate: R21's 42 regions / 5 pages, the six
  fixtures with no cross-balloon merge, and page 2's handwritten aside 良くないけど, which should stay
  its own text.
- **C — text style (rest of 7 and 8).** Split `background_color` into an outline colour and a plate
  colour (migration, golden OpenAPI hand-edit, frontend types). Consider Torii's contrast halo:
  `strokeColor #ffffff` for black text at `lineWidth` 6–8 on 31–42 px. Then M7's one text renderer.
- **D — merge layers.** A route that moves one Inpainting layer's elements into another and keeps
  their draw order; a "Merge down" button on the layer.
- **E — automatic angles, `AUDIT-R23`**, as in the 2026-09-29 handoff.

## Evidence

- Probe (Chromium, against the test stack, read-only): before the fix, slider drag +20/+50/+90/+140
  px gave `translate(20/50/90/140px, 0px)`; after, `translate(0px, 0px)` throughout; zoom kept the
  page centre at (940, 501); a Pan-tool drag of (+60, +40) moved it (+60, +40).
- Frontend: 56 files, 456 tests green; new tests in `ReaderInpainting.test.tsx` (panel drag never
  pans, Pan tool pans; halo pass before fill pass).
