# Corpus output cutoff evidence

Checked 2026-09-09 from the embedded metadata in the active corpus checkout. The machine-readable record is [corpus-cutoff-summary.json](./corpus-cutoff-summary.json).

The active set contains 262 project bundles: 211 JA, 29 KO, and 22 ZH. `exportedAt` runs from 2026-08-05 through 2026-08-28; the median is 2026-08-20 and the latest is `2026-08-28T19:11:55.236Z`. Recorded stage metadata is earlier: across 261 bundles with stage metadata, the latest stage-metadata update is `2026-08-28T19:11:44.700850881+00:00`. `ja/sample1` has an export but no layer stage timestamps.

The latest OCR `time` is August 28 at 19:11:12 UTC (`ja/sample2`); the latest translation `time` is 19:11:44 UTC on the same page. The maximum above is its translation `last_modified`, a fraction of a millisecond later. The latest recorded QA timestamp is August 26 at 07:46:26 UTC (`ja/sample263`). These are separate stage cutoffs; the extractor normalizes them to UTC with Python's microsecond precision, while the summary retains original timestamp strings.

## Six requested JA fixtures

| fixture | OCR layer time | latest translation time | latest QA time | `exportedAt` |
|---|---|---|---|---|
| `sample83` | 2026-08-13 14:28:48Z | 2026-08-13 14:30:41Z | 2026-08-13 14:31:05Z | 2026-08-13 14:58:44Z |
| `sample93` | 2026-08-13 15:31:32Z | 2026-08-13 15:31:45Z | 2026-08-13 15:32:36Z | 2026-08-15 07:16:56Z |
| `sample99` | 2026-08-13 17:41:36Z | 2026-08-13 17:42:15Z | 2026-08-13 17:42:54Z | 2026-08-13 18:12:37Z |
| `sample61` | 2026-08-16 09:43:04Z | 2026-08-16 09:52:41Z | 2026-08-16 09:53:37Z | 2026-08-16 17:06:59Z |
| `sample177` | 2026-08-22 11:04:42Z | 2026-08-22 11:06:27Z | 2026-08-22 11:07:48Z | 2026-08-22 15:10:38Z |
| `sample222` | 2026-08-22 11:08:17Z | 2026-08-22 11:12:26Z | 2026-08-22 11:13:28Z | 2026-08-23 18:45:45Z |

These values come from each bundle's `project/project.json`: OCR `layers[].metadataJson.time`, translation layer `time`, QA `metadataJson.qa.last_qa_at`, and the top-level `exportedAt`. `last_modified` is within milliseconds of each stage `time`, so it does not establish a separate later run. `meta.json` has source/reference provenance and output filenames, but no generation timestamp. Reproduce the extraction with `./.venv/bin/python docs/quality-evidence/corpus-cutoff_extract.py` (stdlib only); it parses `Z` and offset timestamps to UTC and reports latest timestamps by layer type and field.

## Plausible chronology cutoffs

The corpus records a historical pinned OCR geometry policy cutoff of `2026-08-13T06:41:45Z`, worker commit `2ed7c3e` (the policy is documented in `corpus/scripts/corpus_audit.py`). It was the corpus curation boundary at that time, not a claim about the current worker tip: later geometry/render commits exist. Since geometry and masks are baked during OCR, the OCR layer time is the correct freshness test; `exportedAt` only says when the browser export was written. All six fixtures have OCR times after this historical policy cutoff, so they are post-cutoff for that policy's contract.

The practical cutoff for the checked-in active outputs is the latest embedded stage, `2026-08-28T19:11:44.700850881+00:00` (latest export: `2026-08-28T19:11:55.236Z`). The selected application and worker fixes beginning 2026-08-29 therefore postdate every active embedded output. Representative later changes are:

- app `2dd8bd8` (author/committer 2026-08-29 21:28:28 +05:30), an OCR layer is excluded from raster export;
- app `abdcce2` (author/committer 2026-08-29 20:51:50 +05:30), preserve free-floating column height;
- worker `55dc693` (author/committer 2026-08-29 20:51:26 +05:30), erase free-floating captions during rendering;
- app `3433977` (author 2026-09-03 01:20:35 +05:30; committer 2026-09-04 00:02:21 +05:30) and worker `6b70db1` (author/committer 2026-09-03 01:19:29 +05:30), share one configurable fitted rectangle;
- worker `1e29253` (author/committer 2026-09-03 00:58:34 +05:30), place glyphs along the element angle;
- worker `ad1cf9e` (author/committer 2026-09-08 14:39:37 +05:30), route OCR through RapidOCR on ARM64.

These are chronology correlations, not claims that each fix affects every fixture. They establish that the corpus outputs cannot evidence behavior introduced by those later revisions.

## Import chronology and limits

The corpus history records when files were copied, flattened, or regrouped. For example, `sample83`, `sample93`, and `sample99` were carried through flattening commits `1157c174` (2026-08-15), `38ec562b` (2026-08-23), and regrouping commit `6b222229` (2026-08-26); `sample61` additionally passed through the six rerun import commits `3517922a`, `bedde7e4`, and `a179a7bd` on 2026-08-16/17. `sample177` and `sample222` entered through the gap folding commits `c28b91b8`/`18aa9336`, followed by the 2026-08-23 flatten and 2026-08-26 regroup. Those commit dates are metadata transport dates, not stage execution dates.

Author and committer dates provide repository chronology only. An exact deployed app or worker commit cannot be inferred from these timestamps; deployment logs, image digests, or per-run provenance are required. No corpus files were edited in this investigation.
