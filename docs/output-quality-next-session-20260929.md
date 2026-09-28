# Output quality — plan after R7, 2026-09-29

## Start here

This is the starting point once the user gives the R7 verdict. It replaces the "Next" lines of the
[tracker](output-quality-implementation-tracker.md)'s 2026-09-27 status. R7's own record is
[R7.md](quality-checkpoints/R7.md); the work of 2026-09-28 is summarised below because R7.md does not
have it yet.

**The order after R7 passes:** `AUDIT-R21` grouping → `AUDIT-R23` rotation → M7 (text fitting and one
text renderer) → make PR #47 (worker) and #152 (parent) ready and merge. Quality first; reliability and
speed get their own round later.

## Where things stand

### R7 plus the 2026-09-28 work

Branch `feat/output-quality` (parent `f9b0ac7`, worker `436a59b`), CI green on both PRs.

| Commit | What changed for the user |
| --- | --- |
| `7c1d7ff` | OCR layers are created hidden; the editor's region tools follow the newest OCR pass (page 23's wrong-inpaint report). |
| `3998862` | A cloned (duplicate-upload) page copies its source's cleanup patches; 13 pages backfilled (page 400's "no inpainting" report). |
| worker `4f77b41` | Cleanup adds leftover ink next to the mask before painting (option K; page 19's blobs). Generator `ctd-seg+telea-aotgan-cleanup/v3-leftover-ink`. On the 13 backfilled pages: 14 spots better, 1 mixed (page 49 "W.C" clipped). |
| `47fb56c`, `9f3b5b7`, worker `ce4da55`/`436a59b` | Mask editor: click the Inpainting layer, brush an area, Apply repaints it on a new Inpainting layer. Tools sit in the right sidebar; the page does not move while brushing (Space + drag pans); the eraser over an automatic patch marks it red and Apply puts the original page back there (`restore`); Apply · Cancel · Done. |
| `9f3b5b7` | Patches are prefetched with the next pages' details and cached across page turns; the page's text waits up to 1 s for its patches. Patch lag behind the image: ~300 ms (max 0.6 s) → ~110 ms. |
| `0f2d328` | Job links last 7 days (render jobs had failed with 403 after the 10-minute links expired); the queue no longer calls a 403 a bad API key. |
| `979820b`, `f9b0ac7` | CI fixes only (formatting; a test that failed on Node 20). |

### The verdict run (chrome-box test stack)

- **Where:** `http://chrome-box.tail9ece4.ts.net:18090/tlhub/chapters/3a4bb13d-7389-457d-882c-46b7fb68831d/chapter-1`,
  pages **71–470** = SpaceBunny Ch.2 pages 1–400 from the laptop (image hashes checked, in order).
  Stack `manga-quality-r7-20260928` at `9f3b5b7`; the production checkout was not touched.
- **Re-run, not imported:** most of the laptop's results predate K and the 7-day links, so the verdict
  judges current code. Six uploads were duplicates (5 inside the 400; page 153 = chapter 1's page 43)
  and took the clone path.
- **Speed:** a page takes about 45 s before QA (cleanup ~10 s).
- **Spend:** space-bunny (free) returns an empty answer on about 20 % of calls tonight (2 % on the
  laptop), and each falls back to DeepSeek V4 Pro: about $0.005 per page, ~$2 for 400.
  `/tmp/spend_guard.sh` on chrome-box sets the queue's pause flag once spend since 18:49 UTC passes
  **$0.50** (about page 100). Resume from the queue panel; stop the guard with
  `ssh chrome-box pkill -f spend_guard.sh`. Log: `/tmp/spend_guard.log`.
- **Left open:** the 394 new images belong to the throwaway `bunny-import-c68d0f@example.invalid`
  (only live notifications follow the owner). `cb_handover.sh` in the session's job folder hands them to
  the user's account and deletes the throwaway; it needs the user to run it. The laptop stack is down
  with its volumes kept; its throwaway user row is still in that database.

## Step 0 — the R7 verdict (user)

Look at pages 71–470 in the reader and in the exports. What R7 claims:
- the reader shows the cleaned page (patches between the image and the text), with no English over
  un-erased Japanese on page turns;
- each patch can be hidden, moved, deleted, or repainted/restored with the mask editor;
- the export matches what the reader shows (text excepted — that is M7).

If a page fails, note its number and what is wrong. Cleanup misses feed the `AUDIT-R25` check below;
editor problems are R7 fixes before anything else starts.

**Also decide from these pages — is leftover Japanese still common?** `AUDIT-R25` (text left inside a
detected region) was filed at R3 close; K fixes ink *next to* the mask but was not measured on those
pages. If many of the 400 pages still show it, a cleanup packet for R25 goes before R21. If it is rare,
it stays filed.

## Step 1 — `AUDIT-R21`: one balloon, one region

**What it improves:** a balloon whose OCR broke one column in two is translated as one sentence again,
not as separate fragments with separate English boxes.

- **Known:** the owner veto (`worker/src/worker/services/owner_assignment.py::_line_continuity`) split
  42 regions on 5 pages of the dev "Tests" series (2026-09-25); 7 of 8 cases were inside one detected
  balloon. The cause: when OCR breaks a vertical column in two, the top piece's x-neighbour is the next
  column and the continuity test fails (Ch.3 p2: ブラ above イダルなんて).
- **Fix idea (user-agreed direction):** join collinear pieces of one column before the continuity test.
  Opt-in first, checked with the grouping frozen-equivalence test, then measured.
- **Not this step:** the proximity budget. It is already a setting (*OCR Grouping Threshold*, 0.35;
  about 0.45 joins Ch.1 p4's paragraph).
- **Gate:** the 42 regions / 5 pages; the six fixtures show no new cross-balloon merges; region count
  alone never passes it.

## Step 2 — `AUDIT-R23`: tilted text stays tilted

**What it improves:** English on a tilted sign or banner follows the tilt, as Torii's does.
Torii rotates 339 of its 2,880 boxes by 5° or more, on 121 of 270 corpus pages.

- **Known:** PP-OCRv6 already returns the angle in its quads (the sign: 23.9°/26.9°, Torii 25.3°).
  `handlers/ocr.py` and `services/merge_regions.py` write `rotation: 0.0`. Storage, the scene and the
  renderer already handle rotation.
- **Work:** an angle per region (length-weighted from the quads, snapped to 0 inside a 3–5° dead band,
  ~90° treated as vertical text); an oriented box (the axis-aligned box of a tilted line is too tall);
  merge and region redo keep the angle. Cleanup is unaffected.
- **Gate:** angle error against the 339 Torii boxes, and the text still fits the oriented box; the
  sample222 pink banner looks right.

## Step 3 — M7: text that fits, drawn one way everywhere

M7 in the tracker is H01b–H06. R7 already delivered its cleanup-object half (per-patch hide, move,
delete, manual cleanup). What remains, in order:

1. **One text renderer.**
   - **Editor vs export:** on sample177 the editor draws bold where the export is lighter, and line
     breaks differ ("…Touhou / boss music" vs "…Touhou boss / music").
   - **The reader's ZIP export** (`Reader.tsx` ~2900–3030) draws the English itself with canvas
     `fillText`. That is M8's I06.
   - **Goal:** the editor and every download use the page-renderer's layout. R7's parity harness
     (`r7-20260927-gate`) extends to text.
2. **Fitting defects**, gated on the five control pages added 2026-09-20 (User-Test chapter
   `399bac7e…`: pages 6, 12, 18, 23, 27 / samples 697, 698, 699, 76, 700) plus the six fixtures:
   - `AUDIT-R16`: a narrow column is capped by its widest word;
   - `AUDIT-R9`: neighbouring boxes overlap;
   - `AUDIT-R8`: text under-fills or over-runs its balloon.
3. **Source style** (H01b/H02: colour, stroke, weight from the source lettering). Decide at the start
   of M7 whether this is in the merge scope or follows it.

**Gate (G7):** real browser editing at normal zoom, save/reload, the five control pages and the six
fixtures side by side with source and Torii.

## Step 4 — merge

- [ ] **Docs:** add the 2026-09-28 work and the verdict to R7.md; update the tracker's status and the
      R-track rows.
- [ ] **Worker PR #47 first.** Then the parent's `worker` pointer must name a commit on worker `main`.
      A squash merge drops `436a59b`, so bump the pointer after merging (or use a merge commit).
- [ ] **Database:** production needs `database/migrations/` applied before it runs code from `main`
      (today: `2026-09-27-r7-inpainting-layer.sql`, plus anything M7 adds). `init.sql` covers only new
      installs.
- [ ] **CI green** on both PRs.
- [ ] **M8 leftovers:** I06 is done in step 3.1. Check that thumbnails come from the render (I03).
      I04 (tie QA to the render revision it judged) may stay open.

## Later, by user decision (2026-09-28)

- **Reliability and speed round.** The disruption cases carried from R3 go here: worker killed
  mid-stage, and edit/cancel/delete during cleanup (one labelled run on `sample177`).
  "We are fixing quality now; we can do a performance tuning round later."
- **R3's latency item is closed.** The cleanup speed packet (worker `5d49b50`, denormals flushed +
  OpenVINO) took sample177's cleanup from 98 s to 4.2 s; CTD takes about 0.4–1.3 s per crop. A full stress
  page (sample61) on the new image was never timed; do that in the speed round, if at all.
- **M9** (full ~260-page corpus regeneration and release) comes after the merge.
- **Filed, not scheduled:**
  - `AUDIT-R24` (patch smears art under text; the mask editor is the workaround);
  - `AUDIT-R22` (LaMa-mpe mode);
  - `AUDIT-R26` (AI re-inpaint for one hard region);
  - `AUDIT-T6` (harness captures before QA redos end).

## Working rules that carry over

- Never touch chrome-box's production checkout `~/Documents/docker-composes/manga-tl`; test on a
  cloned stack.
- No paid run beyond one page without asking. Space-bunny is free but its fallbacks are not.
- Throwaway accounts and test data are removed afterwards. The user's own layers are never modified.
- Worker is a submodule: commit and push it first. GitNexus `detect_changes` on the parent cannot see
  into `worker/`; use `repo: "manga-tl-worker"`.
- OpenAPI: hand-edit `backend-rust/spec/golden-openapi.json`, then regenerate the frontend types.
