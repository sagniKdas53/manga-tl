# G2 gate run, 2026-11-07 (#177)

**Result: 116 of 117 text elements match, on five of six pages.** G2 and real Bold together close the gap. The last difference is one symbol that Comic Neue doesn't have, so each machine draws it from a different font ([#325](https://github.com/sagniKdas53/manga-tl/issues/325)). Test stack only.

The gate asks that every text element has the same lines and font px in the editor and in the export. `scripts/playwright/g2_parity.cjs` compares what the Reader draws with the layout the renderer reported, kept in `page_render_jobs.layout_json`.

## Results

"Before" compares the deployed editor with the pages' old renders. "G2" is the same pages re-rendered with the outline (main eeb3eb9, worker c8972c3). "G2 + Bold" adds the fix for [#322](https://github.com/sagniKdas53/manga-tl/issues/322) (branch `fix/renderer-real-bold-322`). Each cell is elements that differ.

| Page | Why it was picked | Text elements | Outlines in scene | Before | G2 | G2 + Bold |
| --- | --- | --- | --- | --- | --- | --- |
| B fixtures p3 (sample99) | Named gate page | 9 | 6 | 2 | 1 | 1 |
| B #230 ja p5 | Most elliptical elements with traced balloons | 18 | 17 | 9 | 1 | 0 |
| B fixtures p2 | Rectangular only | 62 | 52 | 20 | 20 | 0 |
| E rotation ja p7 | Rotated, both shapes | 9 | 8 | 5 | 3 | 0 |
| B #230 ja p10 | F5's page, large text | 8 | 8 | 7 | 2 | 0 |
| `test` p5 | The owner's overlap report | 11 | 6 | 5 | 5 | 0 |
| **Total** | | **117** | **97** | **48** | **32** | **1** |

Rectangular text didn't improve, as the packet predicted: the outline mostly changes elliptical text.

## The second cause: bold drawn in Regular (fixed by #322)

`services/page-renderer/fonts.json` had one face, `ComicNeue-Regular.otf`, declared for weights 100 to 1000. A scene's weight 700 was therefore measured and drawn in Regular, while the editor used real Bold from Google Fonts.

| 20 px, three sample strings | Width (px) |
| --- | --- |
| Export before the fix (Regular face, asked for 700) | 243, 320, 246 |
| Real `ComicNeue-Bold.otf`, 700 | 244, 327, 245 |
| Editor (Google Fonts Bold) | 244, 327, 245 |

Before building the fix, the renderer's own layout bundle was run offline on the six stored scenes. With Regular as declared, 117 of 117 elements equalled the stored export. With real Bold, 117 of 117 equalled the editor. That run used this machine's fallback fonts for both sides, which is why it didn't predict the last difference.

## The last difference: ♡ (#325)

B fixtures p3, a short line ending in ♡: 39 px in the editor, 38 px in the export, same line breaks. Comic Neue has no ♡, and the two systems substitute different fonts: at bold 39 px it is 35 px wide here (DejaVu Sans) and 39 px in the renderer image (WenQuanYi Zen Hei). Comic Neue's own text measures the same on both.

So **this result holds for the machine that ran it**: a browser on another OS may pick another fallback.

## How the pages were re-rendered

Each page's `scene_revision` was advanced by one row update, the same update `advance_page_revision` makes, then `POST /api/pages/{id}/render`, once for each deploy. The pages were not marked hand-edited, so QA ran on all six.

QA cost about $0.05 per round ($0.048 and $0.049). The configured free VLM (`dots-studio/dots-3-note-preview:free`) answered 400 in the first round, so those pages fell back to `google/gemini-3.5-flash-lite`.

The second round re-rendered without touching the scenes' text: the scene now lists both font files, so its digest changed and the old PNG wasn't reused.

## What the gate has not covered

- **Named pages:** sample177, 222, 61, 93, 83, 197, 641, sample7 and ch. 6 p. 1 are not on this machine.
- **Outline width (D2):** this needs ch. 6 p. 1 and Torii's `translated.png`, and the owner's eye.
- **ZIP text layer:** read in the code, not compared in pixels. It differs from the render, and has its own issue, [#323](https://github.com/sagniKdas53/manga-tl/issues/323).
- **Only lines and font px are compared**, not line positions or pixels.

## Files

Results and scripts are outside the repo, in `~/Projects/manga-tl-data-backup/20261107-g2-gate/`: `parity-before.json`, `parity-after.json`, `parity-after-bold.json`, editor screenshots, `simulate_fonts.cjs`, `measure_fonts.cjs`. The two scripts carry this machine's paths; they are a record of what ran, not tools.

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
