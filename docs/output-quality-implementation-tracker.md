# Output quality tracker

Rewritten 2026-11-14 to say what the task is, what is done and what is left. Everything the old tracker held (every dated status, the R-track, the milestone cards, the thresholds table) is kept unchanged in the [history file](output-quality-tracker-history.md).

## What this task is

Make a translated page come out right without hand repair. Work began on 2026-09-09, after the August corpus showed art wiped by flat patches, text split or merged wrongly, and exports that didn't match the editor.

The goal, unchanged since September: a reliable OCR → cleanup → translation → render → QA pipeline, exports that match the latest reviewed result, QA failures reported honestly, and cleanup and text fitting that are the same in the editor and the export.

It ends in three steps:

1. The open issues in the [Output-quality tracker milestone](https://github.com/sagniKdas53/manga-tl/milestone/1) are closed or deliberately dropped.
2. M9 (#187): validate, regenerate the corpus of about 260 pages, and promote it.
3. A fresh production stack (#188). Production is down until then.

## Where it stands (2026-11-14)

The pipeline stages are rebuilt and live on the test stack. What is left is text fitting, a handful of grouping and OCR bugs, and the final validation.

**The next step is the paid re-run.** Three merged changes only apply to a page when it is next OCR'd and translated, so the 92 existing test pages still show the old result:

| Change | Issue | What it has been proven on |
| --- | --- | --- |
| F5: the text box is sized to the balloon, not the OCR column | #244 | Prediction on 92 pages, live on 6 |
| Two speakers outside a balloon become two text units | #321 | Replay on 92 pages (13 groups on 8 pages), live on 5 |
| Overlap shrink: the smaller of two colliding text boxes is shrunk back | #182 | Prediction on 92 pages, live on 6 (8 boxes, exactly as predicted) |

One re-run covers all three. It costs OCR, translation and QA on 92 pages, and it has waited for the owner's go since 2026-11-08.

## What is left, in order

### 1. The paid re-run (waits for the owner)

- Before it: check which `main` and worker commit the test stack runs. It must include #339 and worker #88. The off switch is now `OVERLAP_SHRINK=off` (it was `COLLISION_TRIM` before #344); the test stack sets neither.
- Run it against the [layout regression ledger](quality-runs/layout-regression/README.md) and add a row by hand. CI no longer demands one (#344).
- After it: the owner looks at the pages. #244 and #321 close if they hold. #182 closes too: the pairs the shrink can't fix are now listed in the editor's Review tab (#343).

### 2. E3: rotated text fits its balloon's outline (#180)

- Started. One commit, `76394b9` on the local branch `feat/e3-rotated-outline` (worktree `../manga-tl-e3`), turns the outline into the box's own frame before fitting. It has tests and is **not pushed**. It was 16 commits behind `main` before today's merges.
- Left: rebase, push, a ledger row, and the owner's test on the Rotate set.
- Why it is next: 20 of the 39 text collisions left on the test stack are rotated text, which the overlap shrink never touches.

### 3. M7: the rest of text fitting

- #183: balloons left under-filled, short text in narrow boxes, padding per element.
- #181: estimate the source text's style and carry it to the page.
- #330: a box slightly wider than its balloon's outline sets text about 15 % smaller. It has a workaround in `coordinator.rs`. The real fix is in `layout.ts`.

### 4. Smaller tracker issues

| Issue | What |
| --- | --- |
| #177 | The editor-and-export gate passed on six pages (116 of 117 elements). Still open: the gate pages that need the corpus, and the outline-width look (D2) |
| #323 | The export ZIP's text layer has no outline and breaks lines differently from the render |
| #325 | Symbols the font lacks fall back to a different font on each machine |
| #319 | A Japanese page in a Korean series translates OCR noise instead of being flagged |
| #320 | OCR joins chart labels and a paragraph into one region, and QA passes it |
| #231 | B follow-ups: paragraph gaps inside one balloon, orientation checks, an aside left untranslated |
| #245 | Text the OCR detector never finds stays untranslated. Before M9 |
| #184, #185 | Carried from R3: the disturbance cases on sample177, and an agreed page latency ceiling |
| #174, #228 | Cleanup mask over outlines and glows, and halo blots. Only if they still matter |

### 5. After the tracker

#186 (corpus-v2), #187 (M9), #188 (fresh production stack), #220 (docs cleanup).

## Decisions waiting for the owner

- **The go for the paid re-run**, and whether it is all 92 pages.
- **Jev as a first judge ahead of the vision QA.** The [bench](quality-runs/qa-judge-jev-20261110/README.md) on four pages: Jev caught every seeded defect at under a tenth of the cost, and flagged many regions nobody seeded. Whether those flags are real is unchecked. No decision yet.
- **The 5-page pilot** (ledger row 5) still says "awaiting the owner's look".
- **One-shots and moves** (#288, #307) passed CI and an API check, but nobody has driven them in a browser on the test stack.
- **#174 and #228:** keep or drop.
- **Two dependency updates left open on 2026-11-14:** jsdom 31 (#346) fails three `ReaderInpainting` tests, and the worker's Python 3.15 base image (worker #93) is not exercised by PR CI, which tests on 3.13.

## What is done

| When | What | Where |
| --- | --- | --- |
| Sept | M0–M4: frozen fixtures, the page-scene format, artifact freshness, one browser renderer | History, "Foundations" |
| 2026-09-18 to 09-19 | R1, R2, R6: pipeline renders in Chromium, no more flat patches over the art, one balloon is one region | `quality-checkpoints/R1.md`, `R2.md`, `R6.md` |
| 2026-09-26 | R3: source lettering removed and the background rebuilt. Accepted by the owner | [Run](quality-runs/r3p4-20260926-six/README.md) |
| 2026-10-02 | R7: cleanup patches are an editable layer, with a mask editor | `quality-checkpoints/R7.md` |
| 2026-10-05 to 10-07 | A (halo grow) and B: one balloon, one text unit (#175) | [B plan](b-plan-20261006.md) |
| 2026-10-08 | F1–F4: layers, groups, undo that survives a reload (#178) | [F and E plan](fe-plan-20261007.md) |
| 2026-10-10 to 10-17 | E0–E2: tilted text is typeset at its angle. Reshape on rotated boxes (#179). Korean OCR fixed | [E handoff](e-handoff-20261008.md) |
| 2026-11-06 to 11-07 | One-shots and moving chapters. SeaweedFS replaces MinIO (#271) | [Object storage](minio-aistor-migration.md) |
| 2026-11-07 | G2: the balloon shape goes into the page scene, so the export fits text like the editor (#176) | [Gate run](quality-runs/g2-gate-20261107/README.md) |
| 2026-11-07 to 11-08 | F5 parts 1 and 2 (#328, #331, worker #87). The #321 split (worker #88) | [Ledger](quality-runs/layout-regression/README.md) rows 1–5 |
| 2026-11-09 to 11-10 | #182: the overlap shrink (#338, #339) and the editor's list of what it left (#343). Page text removed from the tree (#340, worker #92) | Ledger row 7 |
| 2026-11-14 | #344: "collision trim" renamed "overlap shrink", the CI ledger rule dropped, the Jev bench. Nine parent and three worker dependency updates | |

Skipped by decision: C, splitting `background_color` (D3, 2026-10-04).

## Rules still in force

- **Done means live pixels.** A change counts when it changes real pages through the running stack, not when a test passes.
- **LOCK-1:** text with no balloon is never widened.
- **Overlaps:** the bigger block keeps its shape and the smaller one adjusts. A hand-edited box, or a page edited by hand, is never changed.
- **A regression must be traceable.** Each layout change says what it may touch and gets a ledger row. This is by hand now.
- **Fixes apply when a page is next OCR'd.** Grouping runs inside the OCR job, so an old page keeps its old regions until *Redo OCR*. Check what a re-run replaces on hand-edited pages first.
- **No page text or page images in the repo.** Evidence stays outside it.
- **No compatibility work.** No readers or converters for old projects. The one exception is `scripts/convert_project_v2_to_v3.py`.
- **Paid runs need the owner's go**, each time.

## Reference

- **Test stack:** chrome-box `manga-tl-test`, on SeaweedFS since 2026-11-07, 92 pages. S3 is on 127.0.0.1:19030. Rollback notes and data snapshots are in the history file's [2026-11-06 status](output-quality-tracker-history.md#status-at-a-glance-2026-11-06--one-shots-merged-test-stack-on-main).
- **Grouping thresholds**, with what a wrong value looks like and how to change it: [history file](output-quality-tracker-history.md#thresholds-b-tuned-risk-and-remedy).
- **How the pipeline works:** [diagram](output-quality-tracker-history.md#how-the-pipeline-works-now-2026-09-25-ocr-threshold-added-2026-09-26).
- **Layout regressions:** the [ledger](quality-runs/layout-regression/README.md) and its tools in `scripts/quality/`.
- **Corpus:** images are in LFS on pi5, not GitHub. The gate pages that need it are not on the test machine.
- **Everything outside this task** (UI overhaul, backlog bugs, feature ideas): the roadmap issue, #210.
