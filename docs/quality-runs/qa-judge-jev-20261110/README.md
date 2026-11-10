# QA judge bench: Jev as a first-pass gate, 2026-11-10

**Question:** can `typesafe/jev-1.14` act as a cheap, fast first pass that says "this region needs a fix, yes or no", ahead of the vision-QA model?

**A fourth page was added later the same day; see [below](#a-fourth-page-e-rotation-test-ja-p1).**

**Short answer from 3 pages:** at its 0.5 line Jev caught every seeded defect. It also flagged 22 to 30 of the 52 unseeded region-runs, but most of those come from one page, `test` p5. On the other two pages together it flagged 2 to 8 of 24, depending on layout. The vision models flagged almost nothing, seeded or not. Three pages is a smoke test, so read the "Limits" section before using any number.

Run on 2026-11-10 with `scripts/quality/qa_judge_bench.py`. No page text or images are in this folder: regions are named by index.

## What was run

**Pages.** All three have a current render and every judged region is drawn in it.

| Page | Regions judged | Seeded | Unseeded | Stored QA verdicts |
| --- | --- | --- | --- | --- |
| `test` p5 | 18 | 4 | 14 | none (page was hand-edited) |
| `test` p16 | 8 | 4 | 4 | 8 passed |
| `test2` p1 | 12 | 4 | 8 | 12 passed |
| Total | 38 | 12 | 26 | 20 passed |

`test2` p6 was on the list but was swapped for `test2` p1. p6 has 7 translated regions, below the 8 to 30 range, and the render differs from the original in only 1 of the 7 boxes. The database holds `reject_sfx` for the other 6, so they are hidden and a pasted-back original would change nothing. p1 is the first other `test2` page with 8 to 30 translated regions and none rejected.

**Judged set.** The worker's own filter (`_translation_qa_regions`): a region is judged if it has a translation that did not fail and is not `cleanup_review` or `rejected`. Region numbers come from the worker's `_region_labels`. The region rows came from the database, not from the worker's internal API (which needs the internal key). The per-region `user_override` was therefore treated as unset.

**Seeded defects, 2 of each kind per page.** Seeds are picked from drawn regions that are not `sfx`, largest box first.

- *Untranslated:* the 2 largest regions. The original page's pixels are pasted back over the region's box on the typeset image.
- *Wrong translation:* the next 2. Their translations are swapped in the metadata or question text. The image is not touched, so it still shows the right English.

Each page is judged twice over: unmodified, and seeded (both kinds at once, on different regions). Everything ran twice.

**A bug, found after the runs.** For Jev, the text of the unmodified page carried the swapped translation for the 6 wrong-translation seeds, so those 6 regions were not judged on correct text there. The seeded-page results and the unseeded regions are not affected. The unmodified-page figures below leave those 6 regions out for every config, so they cover 32 of the 38 regions (16 on p5, 6 on p16, 10 on p1). The control for those 6 (correct text, unmodified page) was not run: redoing it needed 30 more Jev calls and the cap left 23. The script is fixed for a re-run; `--exclude-wrong-seeds-unmodified` reproduces the tables here from the cache.

**A. `google/gemini-3.5-flash-lite` and B. `google/gemini-3.1-flash-lite`.** Model B exists on OpenRouter (the id was listed). Both got the worker's real `_vlm_qa_prompt`, read from the worker source with `ast`, and the worker's side-by-side JPEG (quality 85, full resolution). The request body mirrors what `LLMClient` sends to OpenRouter: system prompt, strict `json_schema`, response healing, reasoning cap 4096, `max_tokens` 8192, price-sorted routing with the default quantization and ignore lists. It was sent directly over HTTP, so there was no worker rate limiter, retry loop or session id. A verdict of `failed` or `direct_fix` counts as "needs a fix". `reject_sfx` is counted on its own. `passed` is no fix.

**C. `typesafe/jev-1.14`**, `POST https://openrouter.ai/api/alpha/decisions`. Two questions per region: `noul` ("does it need a fix") and a `choice` of kind (`none`, `translation_wrong`, `text_overflows_or_overlaps`, `ocr_wrong`, `untranslated`). The text part carries the OCR text, the translation the region is meant to show, and the region type. Three layouts:

| Layout | Image | Region box | Requests |
| --- | --- | --- | --- |
| `page` | whole page side by side, PNG | in the text, as fractions of one page | one per region |
| `page_batch` | the same image | in the text | one per page and variant, all regions' questions in it |
| `crop` | original crop and typeset crop, two images | none (the region is centred) | one per region |

Request shape that worked (no key):

```
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer <key>
{
  "model": "typesafe/jev-1.14",
  "state": [ "<text>", {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}, "<text per region>" ],
  "questions": {
    "r<N>_fix":  {"type":"noul",   "instructions":"...", "criteria":{"true":"...","false":"..."}},
    "r<N>_kind": {"type":"choice", "instructions":"...", "criteria":{"none":"...","translation_wrong":"...", ...}}
  }
}
```

The reply holds `answers.<name>` (`{"type":"noul","noul":0.93}` and `{"type":"choice","choice":...,"probabilities":{...}}`) and `usage.cost`. "Needs a fix" below means `noul >= 0.5` unless a threshold is named.

Jev image limits are 256 to 1568 px a side and 78,400 to 2,458,624 px in all. The side-by-side image is scaled to fit: `test` p5 from 2150x1518 to 1568x1107, `test2` p1 from 3036x2150 to 1568x1110, and `test` p16 is not scaled. **Jev saw a smaller image than Gemini did.**

**Calls.** Per-region layouts: every region on the unmodified page, and only the 4 seeded regions on the seeded page (the other crops would be the same input). Totals: 24 Gemini calls (no retries needed), 277 Jev attempts. Spend: about $0.151 in all, under the $1 cap.

## Results

### Unmodified pages: regions flagged

Run 1 / run 2. 32 regions judged by every config (the 6 wrong-translation seeds are left out, see above): 16 on p5, 6 on p16, 10 on p1.

| Config | `test` p5 (16) | `test` p16 (6) | `test2` p1 (10) | Total (32) |
| --- | --- | --- | --- | --- |
| Gemini 3.5 flash-lite | 0 / 0 | 0 / 1 | 0 / 0 | 0 / 1 |
| Gemini 3.1 flash-lite | 0 / 0 | 1 / 0 | 1 / 0 | 2 / 0 |
| Jev `page` | 15 / 14 | 2 / 2 | 1 / 0 | 18 / 16 |
| Jev `page_batch` | 16 / 16 | 2 / 2 | 0 / 0 | 18 / 18 |
| Jev `crop` | 8 / 8 | 3 / 3 | 3 / 3 | 14 / 14 |

Gemini also answered `reject_sfx` for 4 regions per run (3.5) and 3 per run (3.1), 3 of them on `test` p5. These are not counted as flags. The p5 numbers for Jev are high in every layout. That is the same effect as the unseeded flags below.

### Seeded defects caught

Per run (run 1 / run 2), summed over the three pages. 6 seeds of each kind per run.

| Config | Untranslated caught | Wrong translation caught |
| --- | --- | --- |
| Gemini 3.5 flash-lite | 2 / 1 of 6 | 4 / 4 of 6 |
| Gemini 3.1 flash-lite | 0 / 1 of 6 | 4 / 4 of 6 |
| Jev `page` | 6 / 6 of 6 | 6 / 6 of 6 |
| Jev `page_batch` | 6 / 6 of 6 | 6 / 6 of 6 |
| Jev `crop` | 6 / 6 of 6 | 6 / 6 of 6 |

Both Gemini models missed all 8 seeds on `test` p5 (4 per run) in both runs. On the other two pages they caught the wrong translations (8 of 8 per model) and mostly missed the untranslated ones. The Gemini misses are `passed` verdicts, not failed parses: all 24 calls returned a usable verdict for every region.

Jev's kind answer matched the seeded kind (`untranslated` or `translation_wrong`) in 21 of 24 region-runs for `page`, 21 of 24 for `page_batch`, and 24 of 24 for `crop`.

### Jev probabilities: seeded against unseeded

`noul` values pooled over both runs. Seeded: from the seeded page. Unseeded: from the unmodified page, so "unseeded" is not guaranteed good. Counts are region-runs at or above the threshold.

| Layout | Group | n | min | median | max | >= 0.5 | >= 0.7 | >= 0.9 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `page` | untranslated | 12 | 0.63 | 0.73 | 0.93 | 12 | 6 | 2 |
| `page` | wrong translation | 12 | 0.84 | 0.94 | 0.97 | 12 | 12 | 10 |
| `page` | unseeded | 52 | 0.13 | 0.50 | 0.67 | 28 | 0 | 0 |
| `page_batch` | untranslated | 12 | 0.57 | 0.73 | 0.86 | 12 | 8 | 0 |
| `page_batch` | wrong translation | 12 | 0.76 | 0.89 | 0.97 | 12 | 12 | 5 |
| `page_batch` | unseeded | 52 | 0.20 | 0.55 | 0.71 | 30 | 1 | 0 |
| `crop` | untranslated | 12 | 0.98 | 0.99 | 0.99 | 12 | 12 | 12 |
| `crop` | wrong translation | 12 | 0.52 | 0.76 | 0.97 | 12 | 7 | 4 |
| `crop` | unseeded | 52 | 0.07 | 0.37 | 0.99 | 22 | 13 | 2 |

Area under the curve for seeded against unseeded (1.0 is perfect separation): `page` 0.98, `page_batch` 0.95, `crop` 0.90.

- **One page drives the unseeded flags.** `test` p5 holds 25 of the 28 unseeded `page` flags at 0.5, 28 of 30 in `page_batch`, and 14 of 22 in `crop`. In `page` the 28 unseeded p5 region-runs have a median of 0.55 and none is above 0.7, so they sit close to the line and say little either way. See the per-page table below.
- The layouts see different defects. `page` and `page_batch` separate wrong translations cleanly (all 12 at 0.76 or higher) but untranslated regions less so. `crop` puts every untranslated region at 0.98 or higher but mixes wrong translations in with the unseeded values.
- In `page`, a line at 0.7 flags 0 of 52 unseeded and catches 18 of 24 seeded. This was read off the same regions it is scored on, so it is not a tested threshold.
- The 2 unseeded `crop` values at 0.9 or higher are the same region in both runs, an `sfx`-type region on `test` p5.
- Jev's two answers can disagree on unmodified pages (a hand tally from the raw files, not from the script). Over all unmodified calls (including the 6 polluted regions), of the 46 `page` region-runs with `noul >= 0.5` the choice said `none` for 19, 16 of them on p5. For `crop`, 39 were flagged and the choice said `none` for 4.

Per page (same pooling, both runs). Unseeded n is 28 for p5, 8 for p16 and 16 for p1. Seeded n is 4 per kind on each page.

| Layout | Page | Unseeded >= 0.5 / 0.7 / 0.9 | Untranslated >= 0.5 / 0.7 / 0.9 | Wrong translation >= 0.5 / 0.7 / 0.9 | AUC |
| --- | --- | --- | --- | --- | --- |
| `page` | `test` p5 | 25 / 0 / 0 | 4 / 2 / 0 | 4 / 4 / 4 | 0.98 |
| `page` | `test` p16 | 2 / 0 / 0 | 4 / 4 / 2 | 4 / 4 / 4 | 1.00 |
| `page` | `test2` p1 | 1 / 0 / 0 | 4 / 0 / 0 | 4 / 4 / 2 | 1.00 |
| `page_batch` | `test` p5 | 28 / 1 / 0 | 4 / 4 / 0 | 4 / 4 / 2 | 1.00 |
| `page_batch` | `test` p16 | 2 / 0 / 0 | 4 / 4 / 0 | 4 / 4 / 2 | 1.00 |
| `page_batch` | `test2` p1 | 0 / 0 / 0 | 4 / 0 / 0 | 4 / 4 / 1 | 1.00 |
| `crop` | `test` p5 | 14 / 9 / 2 | 4 / 4 / 4 | 4 / 4 / 4 | 0.94 |
| `crop` | `test` p16 | 2 / 0 / 0 | 4 / 4 / 4 | 4 / 2 / 0 | 0.97 |
| `crop` | `test2` p1 | 6 / 4 / 0 | 4 / 4 / 4 | 4 / 1 / 0 | 0.85 |

Without `test` p5 (p16 and p1 added together, 24 unseeded region-runs and 8 seeded per kind), the unseeded flags at 0.5 are 3 for `page`, 2 for `page_batch` and 8 for `crop`. At 0.7 they are 0, 0 and 4.

**Is p5's high score a real defect?** Two things were checked. The English text drawn on p5 matches the stored translation for all 18 judged regions (count-only query on `layer_elements`), and no element on it is marked hand-edited, so Jev was not handed a text that differs from the page. Same result on p16 and p1. Whether the layout on p5 has real overlap or overflow was not checked by eye. `docs/quality-runs/layout-regression` names p5 as the owner's overlap report, so some of Jev's flags there may be right. This run cannot tell.

### Agreement with the stored and Gemini verdicts

Run 1, unmodified pages, on the 32 regions. "Stored passed" covers `test` p16 and `test2` p1 only: 16 of the 32 regions. `test` p5 has no stored verdicts. The stored verdicts come from an earlier QA run of unknown model.

| Config | Flags on the 16 stored-passed | Flagged, Gemini 3.5 passed (both flag / model only / Gemini only) |
| --- | --- | --- |
| Gemini 3.5 flash-lite | 0 | reference |
| Gemini 3.1 flash-lite | 2 | 0 / 1 / 0 |
| Jev `page` | 3 | 0 / 15 / 0 |
| Jev `page_batch` | 2 | 0 / 15 / 0 |
| Jev `crop` | 6 | 0 / 11 / 0 |

28 regions compared (the `reject_sfx` ones are left out). Gemini 3.5 flagged none of them in run 1, so every Jev flag shows up as "model only". The comparison says Jev flags more than Gemini 3.5 does. It does not say who is right.

### Stability (run 1 against run 2, unmodified pages)

| Config | Regions whose flag changed (of 32) | Largest change in `noul` |
| --- | --- | --- |
| Gemini 3.5 flash-lite | 1 | n/a |
| Gemini 3.1 flash-lite | 2 | n/a |
| Jev `page` | 2 | 0.08 |
| Jev `page_batch` | 0 | 0.09 |
| Jev `crop` | 0 | 0.09 |

Gemini was less steady on seeded defects: untranslated catches went 2 to 1 (3.5) and 0 to 1 (3.1). Jev's seeded catches were the same in both runs at 0.5.

### Latency

Per call, successful calls only. `page_batch` is one request for a whole page (up to 36 questions).

| Config | Median (s) | Worst (s) |
| --- | --- | --- |
| Gemini 3.5 flash-lite | 6.0 | 8.1 |
| Gemini 3.1 flash-lite | 5.9 | 8.0 |
| Jev `page` | 1.45 | 6.3 |
| Jev `page_batch` | 1.27 | 5.5 |
| Jev `crop` | 1.0 | 2.7 |

Per page, one pass, with the calls sent one after another (the bench did not send them in parallel). Mean over the two runs.

| Config | `test` p5 (18 regions) | `test` p16 (8) | `test2` p1 (12) |
| --- | --- | --- | --- |
| Gemini 3.5 flash-lite | 6.6 s | 4.7 s | 5.6 s |
| Gemini 3.1 flash-lite | 7.7 s | 4.4 s | 6.0 s |
| Jev `page` | 51.8 s | 14.9 s | 15.3 s |
| Jev `page_batch` | 3.6 s | 2.9 s | 1.3 s |
| Jev `crop` | 23.0 s | 7.5 s | 11.3 s |

A per-region Jev layout is faster per call but slower per page than one Gemini call unless the calls run in parallel. Only `page_batch` beat Gemini per page here.

### Reliability of the Jev endpoint

| Layout | Attempts | Results | Cause of the extra attempts |
| --- | --- | --- | --- |
| `page` | 118 | 100 | 504 after about 5 s, and 529 `system_overloaded` |
| `page_batch` | 17 | 12 | 529 |
| `crop` | 139 | 100 | 529, and my own size error (see below) |

Every call had a result by the end, after one retry. The harness retried each failure once and re-ran leftovers.

### Cost

From `usage.cost`. "Per page, one pass" is all of a page's regions on the unmodified page (all 38 regions were called, including the 6 left out of the figures above), averaged over the three pages and two runs. "Per page-run" adds the seeded pass; in the per-region Jev layouts that pass holds only the 4 seeded regions.

| Config | Per page, one pass ($) | Per page-run, unmodified + seeded ($) |
| --- | --- | --- |
| Gemini 3.5 flash-lite | 0.0056 | 0.0118 |
| Gemini 3.1 flash-lite | 0.0038 | 0.0075 |
| Jev `page` | 0.0027 | 0.0036 |
| Jev `page_batch` | 0.0004 | 0.0008 |
| Jev `crop` | 0.0011 | 0.0015 |

A Jev call is billed on input tokens only, at $0.042 per million.

### Things found along the way

- **Crop size.** A crop exactly 256 px on a side came back `400 "Invalid image dimensions"`, though the docs give 256 as the minimum. 300 was accepted. The script now pads crops to at least 320. A few of the extra `crop` attempts above were this.
- **Gemini and the seeds.** The models passed regions whose English was swapped with another region's, and regions with the Japanese plainly still on the page. This was most complete on `test` p5.
- **Image content.** Some of the test pages are adult. No call was refused or filtered.

## A fourth page: `E rotation test (ja)` p1

Run later the same day, on a page the owner picked as a complex one: turned text, 16 regions judged, 4 seeded (2 of each kind), two runs. Same script, with the bug above fixed, so all 16 regions are in the unmodified figures. Spend: $0.066 (8 Gemini calls, 91 Jev calls). It is kept apart from the three-page tables above.

| Config | Seeded caught (of 8, both runs) | Unseeded regions flagged at 0.5 (of 16, run 1 / run 2) | Cost, one pass ($) | Time, one pass (s) |
| --- | --- | --- | --- | --- |
| Gemini 3.5 flash-lite | 3 | 0 / 0 | 0.0066 | 6.4 |
| Gemini 3.1 flash-lite | 6 | 1 / 1 | 0.0048 | 7.5 |
| Jev `page` | 8 | 15 / 15 | 0.0035 | 21.9 |
| Jev `page_batch` | 8 | 15 / 14 | 0.0005 | 1.2 |
| Jev `crop` | 8 | 13 / 13 | 0.0016 | 16.5 |

"Unseeded regions flagged" counts all 16 regions on the unmodified page. Gemini 3.5 missed all 4 seeds in run 1 and caught 3 of 4 in run 2.

Jev `noul` values, both runs pooled:

| Layout | Group | n | min | median | max | >= 0.5 | >= 0.7 | >= 0.9 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `page` | untranslated | 4 | 0.88 | 0.89 | 0.91 | 4 | 4 | 1 |
| `page` | wrong translation | 4 | 0.90 | 0.95 | 0.98 | 4 | 4 | 4 |
| `page` | unseeded | 24 | 0.53 | 0.68 | 0.82 | 24 | 11 | 0 |
| `page_batch` | untranslated | 4 | 0.81 | 0.85 | 0.89 | 4 | 4 | 0 |
| `page_batch` | wrong translation | 4 | 0.87 | 0.93 | 0.96 | 4 | 4 | 3 |
| `page_batch` | unseeded | 24 | 0.48 | 0.67 | 0.75 | 23 | 9 | 0 |
| `crop` | untranslated | 4 | 0.91 | 0.93 | 0.94 | 4 | 4 | 4 |
| `crop` | wrong translation | 4 | 0.89 | 0.94 | 0.98 | 4 | 4 | 3 |
| `crop` | unseeded | 24 | 0.32 | 0.81 | 0.92 | 18 | 16 | 3 |

- AUC, seeded against unseeded: `page` 1.0, `page_batch` 1.0, `crop` 0.95.
- At 0.5 Jev flags nearly the whole page, so at that line it gates nothing here.
- The ranking still holds in the whole-page layouts: every seeded region scored above every unseeded one. But the line that separates them is about 0.85 here, against about 0.7 on the first three pages, and the gap is thin (0.82 against 0.88 in `page`).
- Nobody checked the unseeded regions. This is a rotation test page, and turned text is what the overlap shrink leaves for review, so some of those flags may be right.
- Largest `noul` change between runs: 0.07. One flag changed between runs (`page_batch`).
- Jev attempts against results: `page` 43 for 40, `crop` 44 for 40, `page_batch` 4 for 4. The failures were 529s, retried.

## Where this leaves it (owner, 2026-11-10)

Jev is not a replacement for the vision QA: it returns no corrected text, no feedback and no font size. It could be a first judge that decides which regions go on to the costlier model. No decision is taken yet. What the four pages say about that use:

- One call per page (`page_batch`) is the only layout that is both cheaper and faster than Gemini: about a tenth of the cost and a fifth of the time.
- A fixed pass/fail line did not hold across pages. Ranking the regions and sending the top few on is the variant worth testing next, on about 20 pages with regions checked by eye.
- Gemini 3.5 flash-lite, the current QA model, missed 18 of the 32 seeded region-runs over the four pages. That matters whatever happens with Jev.

## Limits of this test

- 3 pages, 38 regions, 12 seeds. Counts like 6 of 6 are small and a single region moves a rate a lot. This is a smoke test, not a verdict.
- The seeds are crude. A pasted rectangle has hard edges, and a swapped translation sits next to an image that shows the right English. Real defects are subtler and may be harder or easier.
- "Unseeded" is not "good". Nobody checked those regions, so a flag on one is not necessarily wrong. The Gemini 3.5 reference flagged almost nothing, so it is a weak yardstick. The stored verdicts are from an earlier run of an unknown model.
- `test` p5 was hand-edited (the page has a hand-edit timestamp; no element on it is marked edited). It has no stored verdicts. It is also the page both Gemini models handled worst, and where Jev flagged most. Machine QA leaves hand-edited pages alone, so the pipeline might never judge it. Pooled figures with and without it are both given above.
- Jev and Gemini saw different images: Jev a scaled PNG (crops upscaled), Gemini the full-resolution JPEG.
- One prompt wording per Jev layout, not tuned. The Jev text parts were written for this run.
- Thresholds were read off the same regions they are scored on. There is no held-out set.
- Gemini was called over plain HTTP, not through the worker's client. `user_override` was not available. The region rows came from the database.
- Jev image input is documented as an early feature, and the endpoint is alpha.

## Reading

On these three pages Jev's `noul` score ranked seeded defects above unseeded regions well (AUC 0.90 to 0.98 pooled), and at 0.5 it caught all 24 seeded cases in every layout. At that line it also flagged 22 to 30 of 52 unseeded region-runs that Gemini 3.5 passed, but those flags are concentrated on `test` p5: on p16 and p1 together the rate was 2 to 8 of 24, and p5's own scores sat near 0.5. The data cannot say whether p5's flags are false alarms or real layout problems, since nobody looked at the regions. A line of 0.7 in `page` flagged no unseeded region and caught 18 of 24 seeded cases, but that line was read off the same regions it is scored on. `page` and `crop` were better at different defects (wrong translations and untranslated regions). The two Gemini models flagged almost nothing, including most untranslated seeds and every seed on p5, so the current QA model is not a strong baseline on this test. Jev was faster per call and cheaper per page, but only the batched layout was faster per page than a Gemini call, and the endpoint returned transient 504 and 529 errors on about 15 to 30 percent of `page` and `page_batch` attempts. The data do not show how either approach would do on real defects, which threshold to use, or that Jev should replace or gate Gemini. Settling that takes a labelled sample from more pages, with seeds that look like real mistakes.
