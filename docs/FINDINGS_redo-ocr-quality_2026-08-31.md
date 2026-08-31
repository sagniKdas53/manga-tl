# Findings: redo OCR accepts junk at confidence 1.0

**Status:** recorded, not fixed. Found while validating the `job_costs.stage` work on chapter
`d1e38221-6850-496e-9094-00c9134202f3` ("provence-fix") on 2026-08-31. The cost-accounting half of
that session is fixed and shipped; this is the quality half, deliberately left alone.

**Why it matters here.** Both cases below wrote text into `ocr_regions` with `confidence = 1.0`.
Nothing downstream has any way to tell these apart from a clean read, and the corpus votes ground
truth by comparing engines — so a confident lie is worse than a low-confidence miss.

## Case 1 — hallucination on an empty bubble

Page 4, region `87b642b4-45e6-41d1-abed-c17e7efdc485`. A region redo was run on a large **blank**
bubble. `qwen/qwen3-vl-32b-instruct` returned:

```
リスクの低い露出がしたい——ッ!! もう… ヒィッ ヒィッ ヒィッ ヒィッ ヒィッ …
```

with `ヒィッ` repeated 55 times, and `confidence: 1.0`. It was stored verbatim. Its
`translated_text` is empty, so the degenerate output also stalled the translation for that region.

The interesting part is not that a VLM repeated a token — that is a known failure mode — but that
the pipeline had **no repetition guard and no confidence discount** for it. A response whose tail is
one token repeated 55 times is mechanically detectable without a model.

## Case 2 — the model's own commentary stored as manga text

Page 12, region `27927c7b-8ad5-42b4-9e86-77e0e618ef95`, via `qa-re-ocr`. The stored OCR text is:

```
C", "confidence": 0.1}  // Note: This is a placeholder response due to the rejection feedback
indicating low confidence and unreliable OCR. The actual extracted text should be re-OCR'd for
accuracy, but per instructions, we must return a JSON object with a confidence score reflecting
the uncertainty. The character
```

That is the model's own JSON fragment and English reasoning, stored as Japanese source text with
`confidence = 1.0` and `qa_status = 're_ocr_completed'`.

Two things went wrong and they compound:

1. **The reply was malformed and got accepted anyway.** The parser recovered a fragment starting
   mid-string (`C", "confidence": 0.1}`) rather than rejecting the response. The model even said
   `"confidence": 0.1` in its own payload — the one honest signal in the whole reply — and the
   stored confidence is `1.0`, so the parser did not read the field it was handed.
2. **`qa_status` was set to `re_ocr_completed` regardless.** The QA loop marked the region resolved
   on the strength of a reply that was self-evidently garbage, which is what stops anything from
   coming back to it.

## What to look at when this is picked up

- `worker/src/worker/services/ocr.py` — `try_cloud_ocr` and the JSON recovery around
  `removeprefix("```json")`. The prefix/suffix strip is doing the work a real parse should do, and
  a reply that fails to parse cleanly should be a failure, not a salvage.
- The confidence written on the redo path is the *caller's* default (`0.99`/`1.0`), not the model's
  reported number. Where the model reports one, it should win — Case 2 handed us `0.1` and we
  stored `1.0`.
- A repetition check (longest repeated n-gram as a fraction of output length) would catch Case 1
  cheaply and is language-agnostic.
- Neither case is redo-specific in principle; the same parser serves the batched cloud OCR path.
  Whether the main path has ever produced this has not been checked — worth a sweep of
  `ocr_regions` for the same signatures before assuming redo is special.

## Related

The same validation run turned up the redo *cost* bugs, which were fixed:
`handlers/redo.py` never attached cost on the OCR branch, and the backend's
`handle_qa_re_ocr_callback` accepted a `cost` and dropped it. See
`PLAN_ocr-provenance_2026-08-30.md`.

**Also worth knowing:** the backend integration suite silently no-ops when it cannot reach Postgres —
`app()` returns `None` and every test returns early, reporting green. It needs
`SPRING_DATASOURCE_USERNAME=tladmin` (not `postgres`); with the wrong user all 7 tests in
`internal_endpoints.rs` "pass" in ~1s without executing anything.
