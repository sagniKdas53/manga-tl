# Translation Pipeline Phases

This document describes the manga translation pipeline: its phases, the QA sub-pipeline,
the worst-case number of steps a single job can take, and where thumbnail generation fits in.

All backend line references are to
`backend/src/main/java/com/manga/library/service/JobCoordinatorService.java`
unless otherwise noted.

## Phases (in order)

The pipeline runs as a callback-chained sequence of worker jobs. Each phase's completion
callback enqueues the next phase.

1. **panel-detection** — detect manga panels. Enqueued when the pipeline starts
   (`startPipeline` → `enqueueJob("panel-detection")`, :210).
2. **ocr** — extract text regions (triggered by the panel callback, :620).
3. **layout** — analyze region types and conversation grouping (triggered by the OCR callback, :752).
4. **translation** — LLM batch translation of regions (triggered by the layout callback, :853).
5. **render** — typeset / inpaint translated text onto the image (triggered by the translation callback, :1096).
6. **qa** — quality assurance pass (triggered by the render callback, :1270).

> **Reader mode:** If a series' source language equals its target language, translation,
> render, and QA are all skipped (:552).

## QA sub-pipeline

QA is not a single atomic phase. It has several modes and internal loops.

### QA modes (`worker/src/worker/handlers/qa.py:70` `process_qa`, mode resolution :90-97; `docs/models_and_prompts.md:304`)

- **llm** — text-only semantic review (one pass).
- **vlm** — visual layout review on the rendered image (one pass).
- **hybrid** — two passes: (1) LLM text review → `/qa-hybrid-prepare` applies fixes →
  **inline re-render** (`render_image_core`, `qa.py:316-319`) → (2) VLM visual check on the
  re-rendered output. The intermediate re-render is inline, not a separately queued job.
- **none** — auto-pass all regions.

### QA result handling / retry loop (`handleQaCallback`, :1363)

Each region receives a status and the pipeline branches:

1. **direct_fix / fixed** — apply corrected text & font inline.
2. **failed → escalation** (:1467-1470):
   - `needsManualIntervention` → **halt** pipeline, returns `MANUAL_REVIEW` (:1545).
   - `needsReOcr` → enqueue **`qa-re-ocr`** job (high priority) → `handleQaReOcrCallback`
     (:1195) re-runs OCR then loops back to **translation** (:1229).
   - `ocrBad` → correct source text; `orderBad` → fix reading order.
3. **failed (retryable)** → re-enqueue **translation** with reason `qa-re-translate` (:1571).
4. Retries are capped at **2** (`needsRetry && retries < 2`, :1550, counter key
   `image:qa:retries:` :1479). On exhaustion or a pass, the pipeline completes (:1582).

## Worst-case number of steps for a single job

Worst case, without any failure and without user cancellation, taking the longest QA loop
(the re-OCR branch) each time = **14 queued worker jobs**.

The QA retry cap is 2 (`needsRetry && retries < 2`, :1121), and the longest retry path is
the re-OCR branch (`qa → qa-re-ocr → translation → render → qa`, :1130) rather than the plain
re-translate branch.

| #  | Step            | Trigger                                                        |
| ---- | ----------------- | --------------------------------------------------------------- |
| 1  | panel-detection | ingest (:103)                                                 |
| 2  | ocr             | panel callback (:334)                                          |
| 3  | layout          | ocr callback (:453)                                            |
| 4  | translation     | layout callback (:560)                                         |
| 5  | render          | translation callback (:767)                                    |
| 6  | qa (pass 1)     | render callback (:845) → fails w/ needsReOcr, retries 0→1      |
| 7  | qa-re-ocr       | qa callback (:1130)                                            |
| 8  | translation     | qa-re-ocr callback (:839)                                      |
| 9  | render          | translation callback (:767)                                    |
| 10 | qa (pass 2)     | render callback → fails w/ needsReOcr, retries 1→2            |
| 11 | qa-re-ocr       | qa callback (:1130)                                            |
| 12 | translation     | qa-re-ocr callback (:839)                                      |
| 13 | render          | translation callback (:767)                                    |
| 14 | qa (pass 3)     | render callback → retries=2, not `< 2` → pipeline completes (:1141) |

So: 6 (base pipeline) + 2 retries × 4 jobs = **14**.

**Caveat:** This counts distinct *queued* jobs. In **hybrid** QA mode each `qa` job also does
an LLM pass → inline re-render (`render_image_core`, `qa.py:290`) → VLM pass internally. Those
are not separate queue entries, but if the inline re-render is counted as a step it adds 3 more
(one per QA pass), giving **17** processing steps.

## Where does thumbnail generation happen?

Thumbnail generation is **not** a pipeline phase. It is fired **asynchronously at upload/ingest
time**, before the async pipeline is triggered.

During upload, the controller calls `pageService.generateAndSaveThumbnailAsync()`
(`backend/src/main/java/com/manga/library/service/PageService.java:209`, annotated
`@Async("thumbnailExecutor")`), which resizes the original image and uploads a **WebP**
thumbnail to MinIO, storing the path in `Image.thumbnailStoragePath`. It runs on a separate
executor thread, so it does **not** block the ingest request.

The upload call-sites (thumbnail fired before/around `startPipeline`) are:

- Standard single-page upload — `PageController.java:375`
- Multi-page / next-number upload — `PageController.java:415`, `:600` (immediately followed by
  `jobCoordinatorService.startPipeline(...)`)
- ZIP / project import — `PageController.java:600`, `:693`, `:1278`, `:1329`
- Chapter ZIP import — `SeriesController.java:689`
