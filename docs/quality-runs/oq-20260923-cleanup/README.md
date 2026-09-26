# Cleanup failure checkpoint — 2026-09-23

R3 remains **NOT PASSED**. This is a bounded cleanup failure fix, not Reader cleanup parity, fitting, or full output-quality acceptance.

## Reproduction

The user supplied SFW page 8 and identified SFW page 9. Both had one empty CTD mask and a FAILED cleanup job, followed by an erroneous FAILED → COMPLETED PATCH (409). Source SHA-256 was verified against each immutable cleanup payload before local inspection. Page 8 contains handwriting; page 9's failed region covers a clothing ornament misrecognized as text. No source images or dialogue are stored in this report.

Read-only native-crop CTD checks found peak probabilities 0.00623 and 0.00872 respectively, far below the unchanged 0.3 threshold. Local OCR results vary with crop context: the handwriting can be recognized again; the ornament produces inconsistent characters. This establishes detector/OCR disagreement, not permission to erase pixels.

## Behavior

- Empty CTD masks produce an explicit `uncertain` outcome. Before flagging, a single local OCR crop check records estimated glyph scale and agreement/disagreement with the original text (when present in the immutable payload). It reuses the selected local OCR model, the node OCR lock, and a 1024 crop cap; there are no cloud calls or unconditional extra CTD passes.
- Estimated glyph size below 16px is a diagnostic small-text candidate heuristic, not a validated erasure threshold or proof that a region contains text. Missing OCR/model evidence stays uncertain. Old queued payloads without original text explicitly report that comparison is unavailable.
- Uncertain regions retain source pixels and receive `cleanup_review`, diagnostics, and feedback. They are omitted from provider translation and translated overlays. Other regions continue. Hard failures and incomplete/duplicate/foreign callback accounting still block the page.
- QA folds unresolved cleanup reviews into overall manual review, even when every translated region passes. A page with no translatable regions emits a review warning. Reader displays a persistent expandable notice, including with OCR overlays hidden.
- The cleanup callback owns the terminal job state. RQ no longer sends a contradictory completion PATCH after an accepted callback. Transport errors retain bounded retry behavior.
- Retrying a cleanup job after its source URL expires reads the same object through configured storage on HTTP 403 and still requires the immutable SHA-256 digest.
- No schema migration, renderer replacement, threshold reduction, or artwork-erasure fallback was introduced.

## Validation

- Worker: 587 tests passed; full lint/format/typecheck clean. Follow-up focused tests for the final crop-cap/source-retry changes: 7 passed; targeted typecheck clean.
- Frontend: typecheck and lint clean. Live OpenAPI generation produced no schema diff.
- Backend (preceding session): full isolated gate, 210 tests passed across 24 suites; formatting and Clippy clean.
- September 24 focused regression rerun: 12 passed (review assessment, expired-source retry, callback terminal ownership, translation skip). Prior full gates above were not rerun today.

## Live checkpoint — 2026-09-24

The dev containers had been removed overnight. Restarted existing images against retained volumes using `docker-compose.dev.yml`, project `manga-quality-dev`, with `--no-build --wait`; all services became healthy. Backend image `862bf20b999c`, worker `7a4b3f5b594a` match the preceding session's builds.

| Page | Cleanup job | Observed outcome |
| --- | --- | --- |
| 8 | `912bc3f1-0e27-46f5-9751-a55a0cb3e618` | COMPLETED; accepted callback in 87.5s; translation dispatched |
| 9 | `fc21e36d-1296-49d5-a489-82a7bb974dd9` | COMPLETED; accepted callback in 51.9s; translation dispatched |

Both uncertain regions have `cleanup_review` and no cleanup patch. Glyph estimates were 97.7px/confidence 0.39 and 255.2px/confidence 0.80: neither is a small-text candidate. Both immutable old payloads lack original OCR text, and explicitly report comparison unavailable. Newly created jobs include that diagnostic input. Worker logs confirm one review region omitted from translation on each page and backend-owned cleanup completion; no contradictory transition was observed in the focused log window.

Headless Chromium opened only pages 8 and 9: both persistent review notices and expanded diagnostics were visible. Screenshots were inspected locally and kept only under `/tmp`, not committed. This verifies review visibility, not cleanup-layer parity or translated-output quality. Source download passed the worker's immutable digest guard; no independent output pixel comparison was performed today.

A final September 24 snapshot showed both translation jobs, initial renders, QA jobs, and post-QA renders COMPLETED. Each page still has one `cleanup_review`; other regions are passed/fixed (page 8: three/three; page 9: two/one). Both translation layers record overall QA `manual_review` and `cleanup_review: 1`. Export and visual output-quality acceptance were not rerun. Recorded durations are individual cleanup observations, not a benchmark or measured speedup. R3 remains NOT PASSED.
