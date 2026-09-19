# G0 closure execution report

Status: PASSED — fresh capture, explicit-unresolved baseline coverage, approved successor protocol, and independent sign-off satisfy G0's evidence boundary. This report is not a quality pass and does not score A09.

## R1 — pinned inputs

- App `8f9d88a75f75ed8b2776929a2a2ce589ab8e62ac`; worker `7b54f8c1c516eb445e869b2776ffa62e4ee2762b`; corpus `27de7499f0c4c142763116bfcbcfd0afd9709cbf`.
- [`G0-closure-manifest.json`](G0-closure-manifest.json) pins all six original defect cases and 24 conventional controls by source SHA-256 and dimensions. No historical capture was reused as current evidence.

## R2 — truthful observation and measurement

The 2026-09-13 retained-run `provider_calls`, snapshot-observed settings and font-asset-unknown fields were backfilled after capture from immutable `page-snapshot.json` bytes; the corrected live harness has not been run again. This preserves the one-run spend limit without representing post-capture derivation as a new browser execution.

- `scripts/playwright/capture_quality_baseline.cjs` persists completed-pipeline timestamps, requested settings, snapshot-observed resolved models/providers, actual Chromium/runtime/container identities, registered versus loaded faces, observed font asset hashes when URLs exist, and explicit unavailable fields. It derives available cost/token/retry data from page-layer metadata rather than treating it as unavailable.
- `scripts/quality_preflight.py` proves isolated DB sentinel, Redis and MinIO object round trips. The stale `minio/minio` reference was corrected to the usable dev-stack `purevert/minio:backup` reference.
- `scripts/score_page_quality.py` fail-closes selected candidates for missing/duplicate/extraneous/stale/wrong-source inputs, artifacts and dimensions; fails unknown resolved associations; emits pass/fail/not-executed threshold checks and exits nonzero for failed or unavailable checks. Geometry remains explicitly proxy-only. `scripts/test_score_page_quality.py` exercises candidate, association and threshold failure boundaries.

## R3 — current isolated development baseline

- [`preflight.json`](preflight.json): isolated DB sentinel, Redis and MinIO object round trips passed.
- [`canary-sample7/manifest.json`](canary-sample7/manifest.json): current source-to-browser-export canary passed. [`continuation/manifest.json`](continuation/manifest.json): 29 remaining pages completed serially, preserving snapshot/editor/export/rendered/ZIP artifacts before the next page.
- [`capture-completion-audit.json`](capture-completion-audit.json): all 30 expected pages passed source hash/dimension, export/render dimension, artifact hash, ZIP integrity and runtime-provenance checks. It also records that the two intentional isolated Compose projects were removed after capture.
- [`provider-usage-summary.json`](provider-usage-summary.json), recovered from the retained snapshot metadata: estimated cost US$0.1819514999999999996 (below the user-authorized US$3 cap), 222,219 prompt tokens, 90,903 completion tokens, 75 priced calls, one unpriced call and three QA retries. This is retained application metadata, not a provider invoice.
- Observed layer metadata records PP-OCRv6 JA/ZH and PP-OCRv5 KO OCR; translation calls resolve to `openai/gpt-5.6-luna` through OpenRouter, while QA metadata resolves to `google/gemini-3.1-flash-lite` through OpenRouter. Requested settings are not substituted for this observed provenance. Eight faces were loaded, but their asset URLs/bytes were not observable; that provenance remains explicitly unavailable. Final fitted glyph size is also unknown.

## Historical versus current disclosure

[`historical-current-delta.json`](historical-current-delta.json) compares the six original defect pages against the retained worker `7d70b64` captures. Visible translation elements fell from 77 to 19 under current worker `7b54f8c`; 53 current visible elements are empty. `sample222` and `sample83` current `export.png` bytes equal their source `project/original.png` bytes: these pages rendered no typeset output. The current eligibility guard is a plausible cause but is not established as causal by this evidence. This is a baseline finding for M5/M6/M7, not a production change.

## R4 — corrected development-only measurement/evaluation procedure

- [`development-candidates.json`](development-candidates.json) is exactly the 30 current development pages; no A09 roster/reserve page appears.
- [`development-measurement.json`](development-measurement.json) candidate-validates all 30 and reports JA/KO/ZH, style and original/control slices. Current geometry facts: 307 regions, 216 visible text elements, 61 visible empty elements, maximum safe-rectangle overflow 20 px and maximum element-rectangle overlap ratio 1.0. These are not pixel-quality verdicts.
- [`G0-reviewed-reconciliation.json`](G0-reviewed-reconciliation.json) retains all 267 source-reviewed actions as **explicitly unresolved** fresh identities. Historic UUID/order/proximity/OCR text was not copied as identity evidence. This is honest baseline coverage; future J02 evaluation must fail until every candidate association is resolved by source-pixel review. Policy metrics and final fitted font size remain unknown.
- [`A09-evaluation-correction-v2.approved.json`](A09-evaluation-correction-v2.approved.json) and [`A09-quality-thresholds-v2.approved.json`](A09-quality-thresholds-v2.approved.json) are the coordinator-approved successor protocol and development-control baseline bounds. [`development-approved-threshold-application.json`](development-approved-threshold-application.json) proves the evaluator rejects the intentionally unresolved baseline rather than manufacturing a pass.

## Explicit gate state

A09 has not been scored or altered; B01 and production OCR/grouping/cleanup/typesetting/rendering work have not begun. The coordinator approved the successor protocol/bounds and explicitly closed all 267 fresh associations as unresolved rather than fabricating a source identity. [`G0-independent-review-20260914.md`](G0-independent-review-20260914.md) records the final independent PASS. M1 may consume the recorded eligibility/source-identical-export findings; future J02 candidate evaluation still requires source-pixel-resolved associations.

## M1 handoff

Start M1 with the `historical-current-delta.json` finding: current worker `7b54f8c` produced source-identical exports for `sample222` and `sample83`, and visible translation elements fell from 77 to 19 across originals. Diagnose the eligibility path and ownership handoff only; do not change G0 artifacts, score A09, or use explicit unresolved mappings as automatic replacement permission.
