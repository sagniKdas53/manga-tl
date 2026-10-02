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
4. Merge: worker #47 first, then bump the parent's `worker` pointer to a commit on worker `main`.
5. Production, before it runs `main` (the user's call at deploy time):
   - **Database.** Upgrade in place or recreate from a backup. In place:
     `2026-10-01-upgrade-from-main.sql`, then `2026-09-27-r7-inpainting-layer.sql` (both
     re-runnable). The first was checked by loading main's `init.sql`, applying it, and comparing
     `pg_dump --schema-only` with the branch's `init.sql`: identical apart from column order.
   - **Models.** The worker now refuses to start without CTD and AOT (#47). Production mounts
     `./data/worker/huggingface` as the cache, so `ctd_seg_dyn.onnx` and `lama_aot.onnx` go in its
     `models/`, with the pinned checksums from `worker/src/worker/config.py`.

## Review rounds (2026-10-01)

- **#47:** 21 threads (CodeRabbit and Codex). 17 fixed in worker `460c7d0`; four answered and left
  open: quality-filtered regions (2 threads; the backend already gives absent regions a hidden row),
  uncontained fragments (a page with no panels must still join multi-line captions), and the
  heartbeat (the backend accepts one only while `PROCESSING`). A follow-up, `7a180d4`: a callback
  refused with 409 is terminal.
- **#152:** `.coderabbit.yaml` took effect (186 files reviewed, 166 filtered). 17 CodeRabbit threads
  fixed, plus Codex's migration (above), import-plate and render-backoff findings. Three Codex
  findings are answered and parked:
  - client-written scene validation is not the full JSON Schema. `PUT /pages/{id}/scene` has no
    caller in the app; full validation needs a schema crate. Follow-up.
  - a manual repaint is not fenced against patch edits made while it runs (about 10 s). Fencing on
    the scene revision would also reject repaints when the user edits text meanwhile. Follow-up.
  - a duplicate-upload clone copies the pipeline's cleanup, not the source page's hand edits. By
    design: the clone takes machine output and translates fresh.

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

## Second review round (2026-10-02)

The user tested the deployed fixes on chapter "2nd Oct / Inheritance"
(`d3fccb50-4800-458f-ad39-dad8c771fa61`) and drew the findings (`~/Downloads/latest issues.png`, videos
`vokoscreenNG-2026-10-02_01-35-32.mkv` and `…_02-04-26.mkv`).

| What the user saw | What it is | Decision |
| --- | --- | --- |
| Four Panel Detection jobs stuck PENDING after deleting accidentally uploaded pages | `delete_page` removes the page and its image but not its jobs. The worker finds no image and aborts before PROCESSING; its PENDING→FAILED report is refused (409), so the row stays PENDING and is sent again on every resume (seen 20:06 and 20:50 UTC). | Fix in #152 and #47: deleting a page, chapter or series cancels its queued jobs; the dispatcher drops a payload whose row is gone or no longer PENDING; a worker abort before start can land. |
| SFX shown on a white box ("SLUR"); "old type masks" | SFX regions are excluded from cleanup (`cleanup_region_entry` → `exclude`), so a shown SFX falls back to the plain plate. They are shown because QA passes them: QA is never sent `regionType`, and its rule reads "reject_sfx: a sound effect … that shouldn't be translated", while the translator is told to give SFX an English sound word. QA rejected 4 of 36 SFX on this chapter. | User: enforce the policy in QA; and when QA keeps a region that has no cleanup, generate a patch for it, once, without a QA loop. |
| An empty region drawn as a white box (page 12) | QA emptied a region's translation (SFX も, `fixed`); the editor still drew its plate. The export already skips empty elements. | Editor: no plate for a region's element with no text. |
| Clicking a review region does not highlight it | The selection outline is drawn only by the debug overlay ("Show debug"). | Always outline the selected region. |
| The mask panel ignores the sidebar toggle | The panel host was always shown, so Apply and Done were never out of reach. | Follow the toggle; Esc still leaves the mode. |
| Repaint / Restore labels | Too long for the toolbar. | Rename to **Draw** / **Erase**; same behaviour. |
| Export says "render still pending"; edits reach the render slowly | Every editor change is saved 1.5 s later and bumps the page revision (page 25: revision 3 → 23 in one session); the render waits 30 s after the last edit, then queues on the worker's light slots behind QA (50–200 s per job). Export was pressed 12 s after a delete. | User: the backend renders an edited page at once through page-renderer (not the worker queue); Export waits for it. Autosave after 30 s idle, save on page change, ask before closing with unsaved edits. |
| Edited pages go through QA again | A page counts as hand-edited only while one of its elements has `is_manually_edited`; deleting an element, toggling or deleting a layer does not set it, and deleting the edited element clears it. | A page-level hand-edit mark that those edits set and deletes cannot clear. |
| CodeRabbit "outside diff range" comments | 1: lease expiry in the recovery compare-and-swap (fixed in `7299fda`). 2: the max-attempts FAILED update has no compare-and-swap. | Fix 2. |

**What landed (2026-10-02).**

- **Queue.** Deleting a page, chapter or series deletes its pages' unfinished jobs in the same
  transaction (`coordinator::drop_unfinished_page_jobs`). The dispatcher drops a payload whose job
  row is gone or not PENDING (`dispatcher::job_still_pending`). The resume and orphan sweeps delete
  unfinished jobs whose page no longer exists (`drop_jobs_of_deleted_pages`), which clears jobs
  left behind before this fix. The transition table is unchanged: a job that never started still
  cannot report FAILED. Tests: `deleting_a_page_or_chapter_drops_their_unfinished_jobs`,
  `work_for_deleted_pages_is_dropped_not_dispatched`.
- **SFX.** QA is sent each region's `regionType`, and its `reject_sfx` rule now states the policy
  (worker `qa.py`, `REJECT_SFX_RULE`). After QA, a region it kept that has no patch gets one cleanup
  with the `replace` action (`coordinator::queue_late_patches`). Each region is tried once (the job's
  `followUp.regionIds` is the record). No translation follows, and the page re-renders as a final
  pass, so QA is not queued again. If cleanup finds no lettering, QA's verdict stands. Test:
  `regions_qa_kept_without_a_patch_get_one_late_cleanup`.
- **Render now.** `POST /api/pages/{pageId}/render` (`render_now.rs`) snapshots the page, wins the
  render job's start compare-and-swap, calls page-renderer directly (`PAGE_RENDERER_URL` on the
  backend), stores the PNG where the worker would, and applies it through `handle_render_callback`.
  If a worker has the job already, it waits for that render. Export calls it when the render is
  pending. Test: `an_edited_page_renders_in_the_request_and_queues_no_qa`.
- **Hand-edit mark.** `pages.hand_edited_at`, set by every editor layer and element route and by a
  landed manual repaint (`page_freshness::advance_page_revision_by_hand`). It is read by QA's skip
  (`coordinator::page_hand_edited`) and by the export metadata.
- **Editor.** Element edits save after 30 s idle, on Ctrl+S, on page change, and before Export or
  a layer reload. Closing the tab with edits pending asks first. Each save is followed by a render
  request. A finished render no longer reloads the open page. A region's element with no text draws
  no plate. With debug off, a review region can be clicked and the selected one is outlined. The
  mask panel follows the inspector toggle. The tools are labelled **Draw** / **Erase**.
- **CodeRabbit.** The max-attempts FAILED update in the stale sweep compares attempt, lease token
  and lease expiry.

**Production, in addition to the steps above:** `2026-10-01-upgrade-from-main.sql` now also adds
`pages.hand_edited_at`. A database already on an earlier build of this branch (the chrome-box test
stack) takes it by running the file again. The backend's compose service gets
`PAGE_RENDERER_URL`, defaulting to `http://page-renderer:8090`.

**Follow-up F — Photoshop-style layers (user, 2026-10-02).** Replaces follow-up D. The layer panel's
`+ TL` and `+ SFX` buttons become **Add layer** and **Merge layers**. Merge mode offers **merge down**,
**merge visible**, and **undo/redo** of a merge. Layers can be **grouped** (folders that hide, show,
reorder and merge as one). Merged patches stay editable (decision of 2026-10-01). Only like layers
merge: patches with patches, text with text. Undo must work after a reload, so the server keeps a
record of each merge. The model is how Photoshop handles layers.

## Third review round (2026-10-02, afternoon)

The user's evidence: page 21 export and screenshot, page 30 screenshot, export and layers ZIP, page
31 export and layers ZIP, video `vokoscreenNG-2026-10-02_13-38-56.mkv`.

| What the user saw | What it is | Decision |
| --- | --- | --- |
| "Old type masks" again (page 21: SQUELCH-POP on a peach box) | The export is the pre-QA render (`a9da14a9…` = page 21's revision 1, 08:01:06 UTC; QA's final pass came at 08:01:56). SFX are translated but excluded from cleanup, and the scene builder's fallback gave a region with no patch a flat plate in its sampled colour (`legacy_patch_and_mask`). QA then rejected both SFX. On the test stack all 130 plated regions were SFX. | User: show nothing until QA keeps it and its late patch lands. The plate fallback is removed. |
| Edits don't stick (page 30) | They did save: rev 4's scene has the new text, and the export is that scene's render. But the scene contract had no font size, shape or italic, so page-renderer auto-fitted the line to ≤ 72 px while the editor drew 152. | User: carry size, shape and italic (contract rule 8). |
| Deselect should not lose edits | Deselect kept the edits pending; Export's "Unsaved Changes" prompt saved them. | User: Deselect saves at once. |
| AOT does not work for manual cleanup (page 31) | That page's only repaint ran **Telea** (the method selected in the editor; no AOT repaint has ever run on the test stack). AOT on the same mark, run in the test worker, works. It is soft because a 1934×2071 mark is shrunk to 1024 px. | User asked to test per-stroke and close-stroke groups. Measured below: the current single crop stays. |

**Manual AOT, measured on page 31's mark** (test worker, OpenVINO, same underlay):

| Variant | Time | Result |
| --- | --- | --- |
| One crop over the whole mark, shrunk to 1024 px (current) | 8.8 s | Cleanest: smooth wall, horse outline continued |
| Per stroke (7 crops, each shrunk only if over 1024 px) | 15.4 s | Dark smears at the horse's edge |
| Strokes within 48 px grouped (6 crops) | 17.1 s | Same smears, slightly fewer |
| Strokes within 128 px grouped (4 crops) | 32.0 s | Close to current, a little darker |
| Whole mark, full resolution in 1024 px tiles | 67.5 s | Worst: tall dark streaks along the strokes |

AOT is trained on small holes. Each smaller crop gives it less of the surrounding wall to copy, and
full resolution makes a 120 px stroke a huge hole, so it paints from the dark horse instead. The
page's automatic patches also left white blobs (the glyphs' white outline), which is follow-up A.

**What landed.**

- **No flat plate; SFX wait for their patch.** `build_pipeline_scene` no longer plates a region
  without a patch. An SFX region (`region_type = sfx`, which cleanup excludes) without a patch is
  not drawn and its policy is `review`, unless the user typed its text by hand. Other text without
  a patch is drawn over the source with its halo. The editor matches (`isUnpatchedSoundEffect`; only
  a region-less "Add Mask" element keeps its editor plate). QA's `reject_sfx` rule now says an SFX is
  not drawn yet, so QA does not fail it, and buy a paid retry, for English it cannot see. Tests:
  `a_region_without_a_patch_gets_no_flat_plate_and_an_sfx_is_not_drawn`, `ReaderInpainting`
  (hides an unpatched SFX).
- **Contract rule 8: editor typography.** `style` may carry `font_size` (written only when auto-size
  is off), `font_style: italic` and `shape: elliptical` (written only for an element the user
  edited: layout marks 6,690 pipeline elements elliptical, and honouring that would change every
  page's scene). page-renderer wraps as the editor does (fitter seeded with the size, shape and
  style) and draws at the fixed size. A scene without the fields is byte-identical, so nothing
  re-renders. Schema, md, fixtures and all three validators (Ajv, Rust, Python, plus the worker's
  pinned schema hash) updated; both request builders (worker `render_page_scene`, backend render
  now) pass the fields on.
- **Deselect saves.** Deselecting an element (Deselect, a click elsewhere, picking another) flushes
  its pending edit and requests the render.

**Not changed, noted:** the editor wraps a pipeline element inside its mask polygon and inside an
ellipse when layout marked it elliptical; page-renderer still uses the rectangle for those. The
export ZIP still writes a text element's polygon as a "fallback plate", which an import turns into
a patch.

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
- **D — merge layers.** Superseded by follow-up F (Photoshop-style layers, above).
- **E — automatic angles, `AUDIT-R23`**, as in the 2026-09-29 handoff.

## Evidence

- Probe (Chromium, against the test stack, read-only): before the fix, slider drag +20/+50/+90/+140
  px gave `translate(20/50/90/140px, 0px)`; after, `translate(0px, 0px)` throughout; zoom kept the
  page centre at (940, 501); a Pan-tool drag of (+60, +40) moved it (+60, +40).
- Frontend: 56 files, 456 tests green; new tests in `ReaderInpainting.test.tsx` (panel drag never
  pans, Pan tool pans; halo pass before fill pass).
