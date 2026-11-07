# G2 gate run, 2026-11-07 (#177)

**Result: does not pass yet.** G2 works, and one more cause remains: the renderer draws bold text in Regular ([#322](https://github.com/sagniKdas53/manga-tl/issues/322)). Test stack only, on main eeb3eb9 and worker c8972c3.

The gate asks that every text element has the same lines and font px in the editor and in the export. `scripts/playwright/g2_parity.cjs` compares what the Reader draws with the layout the renderer reported, kept in `page_render_jobs.layout_json`.

## Results

"Before" compares the deployed editor with the pages' old renders. "After" is the same pages re-rendered with G2. Each cell is elements that differ, out of the page's text elements.

| Page | Why it was picked | Outlines in scene after | Before | After | After, with real Bold (offline) |
| --- | --- | --- | --- | --- | --- |
| B fixtures p3 (sample99) | Named gate page | 6 of 9 | 2 of 9 | 1 of 9 | 0 of 9 |
| B #230 ja p5 | Most elliptical elements with traced balloons | 17 of 18 | 9 of 18 | 1 of 18 | 0 of 18 |
| B fixtures p2 | Rectangular only | 52 of 62 | 20 of 62 | 20 of 62 | 0 of 62 |
| E rotation ja p7 | Rotated, both shapes | 8 of 9 | 5 of 9 | 3 of 9 | 0 of 9 |
| B #230 ja p10 | F5's page, large text | 8 of 8 | 7 of 8 | 2 of 8 | 0 of 8 |
| `test` p5 | The owner's overlap report | 6 of 11 | 5 of 11 | 5 of 11 | 0 of 11 |
| **Total** | | **97 of 117** | **48** | **32** | **0** |

Rectangular text didn't improve, as the packet predicted: the outline mostly changes elliptical text.

## The remaining cause

`services/page-renderer/fonts.json` has one face, `ComicNeue-Regular.otf`, declared for weights 100 to 1000. A scene's weight 700 is therefore measured and drawn in Regular, while the editor uses real Bold from Google Fonts.

| 20 px, three sample strings | Width (px) |
| --- | --- |
| Export (Regular face, asked for 700) | 243, 320, 246 |
| Real `ComicNeue-Bold.otf`, 700 | 244, 327, 245 |
| Editor (Google Fonts Bold) | 244, 327, 245 |

The last column of the results table comes from running the renderer's own layout bundle offline on the six stored scenes, twice:

- **Regular, as declared today:** 117 of 117 elements equal the stored export, so the simulation is faithful.
- **Regular up to weight 500, real Bold from 600:** 117 of 117 equal the editor.

## How the pages were re-rendered

Each page's `scene_revision` was advanced by one row update, the same update `advance_page_revision` makes, then `POST /api/pages/{id}/render`. The pages were not marked hand-edited, so QA ran on all six.

QA cost $0.048 in total. The configured free VLM (`dots-studio/dots-3-note-preview:free`) answered 400 on every call, so each page fell back to `google/gemini-3.5-flash-lite`.

## What the gate has not covered

- **Named pages:** sample177, 222, 61, 93, 83, 197, 641, sample7 and ch. 6 p. 1 are not on this machine.
- **Outline width (D2):** this needs ch. 6 p. 1 and Torii's `translated.png`, and the owner's eye.
- **ZIP text layer:** read in the code, not compared in pixels. It differs from the render, and has its own issue, [#323](https://github.com/sagniKdas53/manga-tl/issues/323).
- **Only lines and font px are compared**, not line positions or pixels.

## Files

Results and scripts are outside the repo, in `~/Projects/manga-tl-data-backup/20261107-g2-gate/`: `parity-before.json`, `parity-after.json`, editor screenshots, `simulate_fonts.cjs`, `measure_fonts.cjs`. The two scripts carry this machine's paths; they are a record of what ran, not tools.

## Rerun

```sh
TLHUB_EMAIL=... TLHUB_PASSWORD=... node scripts/playwright/g2_parity.cjs \
  --base http://127.0.0.1:18093/tlhub --db-container manga-tl-test-db-1 --out <dir> --tag after \
  --page sample99=7c6feba1-bc7f-46ef-bc92-2cb8f9b6fb54 \
  --page b-ja-p5=f4d7b451-e694-412d-ab35-30ab9f9a6392 \
  --page fixtures-p2=d7e3f2c6-2dfc-4c5b-bcc0-2eb4f6ffaba3 \
  --page e-ja-p7=392fb9c5-0f7d-401f-94f6-6b8030a3a5a5 \
  --page b-ja-p10=c4ab9769-f6d5-4d4e-84dd-33e952d984aa \
  --page test-p5=2a0cea85-af17-4d02-a5d6-79ae9b55cfe4
```

It exits 1 if any page differs. Wait for the job queue to empty first: QA can re-render a page.
