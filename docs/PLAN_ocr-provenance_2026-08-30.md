# Plan: structured OCR provenance

**Status:** deferred, not started. Split out of the cost-accounting work (worker PR #30, parent
branch `cost-accounting-downstream`) so it can be shaped alongside the versioned export schema
rather than bolted onto the cost fixes.

## Why

Everything worth recording about an OCR run is already in memory at the end of `process_ocr`, and it
is thrown away into a single display string:

```python
# worker/src/worker/handlers/ocr.py:1441
model_identifier = f"PaddleOCR({rec_model})"
if vlm_model_used:
    model_identifier += f" + {vlm_model_used}"
...
"modelIdentifier": model_identifier,   # :1450
```

That string is the *only* record of how a page was read. It cannot answer which detector ran, which
recogniser was selected for the page's language, whether the model that ran was the one configured,
or which of several chunks used which model. Three concrete problems follow from it:

1. **Detection provenance is lost entirely.** Detection always runs locally, even in cloud-VLM mode
   — only *recognition* is remote. `ocr.py:627` sets `use_paddle_ocr` from the provider, and
   `ocr.py:654` then builds `paddle_ocr_detector` precisely when `use_paddle_ocr` is false. So a
   "cloud OCR" page still went through local PP-OCR detection and the local YOLO bubble detector,
   and nothing anywhere says which versions.

2. **Concurrent chunks record whichever finished last.** `vlm_model_used` is a single variable
   (`ocr.py:565`) assigned through `nonlocal` from inside the per-chunk worker (`ocr.py:1038`), at
   three different fallback tiers (`:1076` user model, `:1112` global model, `:1163` local model).
   With chunks running concurrently the last writer wins, so a page whose chunks used two different
   models reports one of them, arbitrarily.

3. **Silent model substitution is invisible.** Those three tiers are a fallback ladder: when the
   configured model fails, the next one is tried and only a warning is logged. Downstream there is
   no way to tell that a page was read by a different model than the one configured — which is
   exactly the question you ask when one page's output is inexplicably worse than its neighbours.

## What to record

A single `ocrProvenance` object on the OCR callback, alongside — never replacing — today's
`modelIdentifier`.

**Local recognition (`mode: "local"`)**

```jsonc
{
  "mode": "local",
  "detector": "PP-OCRv5_mobile_det",
  "recognizer": "en_PP-OCRv5_mobile_rec",   // per-language; the bug class ocr_models.py exists to prevent
  "catalogModelId": "PP-OCRv5",
  "requestedModelId": "PP-OCRv6",
  "autoRouted": true,                        // "you asked for v6; this language forced v5"
  "sourceLanguage": "ko",
  "bubbleDetector": { "path": "...", "sha256": "..." },
  "envOverride": { "det": "...", "rec": "..." }
}
```

**Cloud recognition (`mode: "cloud-vlm"`)** — the same local detection block, because it still ran,
plus the remote half and one entry per chunk:

```jsonc
{
  "mode": "cloud-vlm",
  "detector": "PP-OCRv5_mobile_det",
  "bubbleDetector": { "path": "...", "sha256": "..." },
  "recognizer": null,
  "vlm": {
    "provider": "openrouter",
    "modelRequested": "qwen/qwen3-vl-32b-instruct",
    "modelUsed": "qwen/qwen3-vl-32b-instruct",
    "usedFallbackModel": false,
    "routingStrategy": "lowest-cost",
    "batchSize": 10
  },
  "calls": [ /* one per chunk: generation id, model actually used, tokens, cost, duration */ ]
}
```

The per-chunk `calls[]` array is what fixes problem 2 — it removes the shared variable rather than
guarding it, so there is nothing left to race.

## Notes for whoever picks this up

- **The YOLO checksum already exists.** `worker/src/worker/services/bubble_detector.py:21` defines
  `get_sha256` and `:43` already computes it for the model file. Reuse it; do not add a second one.
- **`calls[]` entries should reuse the cost breakdown, not duplicate it.** After PR #30 each LLM
  call already produces a record carrying `generation_id`, `upstream_provider`, `model_resolved`,
  tokens, `cost_source` and `duration_ms`. Filter the job's cost list by `stage == "ocr"` rather
  than assembling a parallel structure that can drift.
- **Keep `modelIdentifier` byte-identical for at least one release.** `corpus/scripts/
  corpus_audit.py:184` reads `metadataJson.model` off the OCR layer to answer "which engine read
  this page". Changing that string breaks the corpus audit silently. Add the structured object
  beside it and migrate that consumer separately.
- **This feeds the schema v1 envelope.** `ocrProvenance` is one of the things v1 exists to carry, and
  `corpus_audit.py:76` currently pins a worker commit sha by hand (`GEOMETRY_CUTOFF_SHA`) as a
  stand-in for a real version field. Landing provenance and the envelope together is what lets that
  hand-maintained constant be deleted.

## Verification

Run one page in each mode and confirm:

- local mode records detector, recogniser and the routing decision, and `autoRouted` is true when
  the language forces a different catalogue model than the one requested;
- cloud mode still records the local detector and bubble-detector checksum;
- a page split into N chunks produces N `calls[]` entries, each with its own generation id — set
  `OCR_BATCH_SIZE` low enough to force several;
- forcing the primary VLM to fail produces `usedFallbackModel: true` and a `modelUsed` that differs
  from `modelRequested`;
- `modelIdentifier` is unchanged, and `corpus_audit.py` still reports the same `ocr_model`.
