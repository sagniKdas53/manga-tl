# OQ bounded implementation evidence — 2026-09-23

R3 remains **NOT PASSED**. This packet uses synthetic/recorded inputs, not a paid quality benchmark, corpus sweep or production deployment.

## Starting identity (read-only inspection before environment restart)

- Parent: `63f0ce21b0b1907ad6201951f20420af239c5fe8`; worker: `909264d957453e6ceb88d301e105d714b16fbf3f`.
- Existing staged handoff/tracker preserved.
- GitNexus refreshed separately: parent 13,607 nodes / 22,521 edges / 300 flows; worker 1,939 nodes / 3,841 edges / 165 flows. Index results are navigation evidence, not test passes.
- Dev backend image: `sha256:efff9c5ac3cef416ef1913f7fadba9d9af05f8060cb01524d70b39f6e93f7c94`.
- Dev worker image: `sha256:d2eb605b60210c5aec01dd86468825069d5fdc65049246567d0a172f054e70a1`.
- Dev renderer image: `sha256:42b2790f10c67e017f77099f2886e0b8922f94da68735442853a5b5471c92346`.
- Images have no source-commit labels; identity cannot prove checkout/build equivalence. Dev containers were healthy at first inspection, then absent after environment restart. No new live-page processing was launched.

## Page 14 correlation

Image `b0b1b726-7458-458a-a50a-f7e2aef0333d`, page `b14ecd44-013d-4752-9c48-90413032516d`, input generation 1, current scene revision 3, pointer `166eca0e-cda0-49b3-b076-f58bc6b1f16f`.

| Revision | Render job | Scene SHA-256 | PNG SHA-256 |
| --- | --- | --- | --- |
| 1 | `1fe7ad38-73db-4ca6-a106-8a3f03464f60` | `f6e5f8c943491ce187b86916701b4ae68e950650ce6dcf680560203977bf1f4b` | `845e817af06e6354fa45b596f39a2102ee652caf5ff1c215d82a545a9efbb0ab` |
| 2 | `4ace4eb9-7eeb-4d06-8b0a-45490a36381b` | `781e17e5e53c9822c3286e6cf3160e921fdb2a91d6df375d207c5ae4165fcfc0` | `8532cf6bfc3f5fc97ed958e3b29d09681093cf67481760828e44601dce4b6086` |
| 3 | `166eca0e-cda0-49b3-b076-f58bc6b1f16f` | `449c7bf81cd01ae9df2bd1d57e2d6c93c0728a5c32c0d7b8a1f7a15affb0a906` | `0f69883b3c97afcc670ace74f094b9f6e9549a410e8172f9e9458a6dd141dd72` |

All three ledgers succeeded. Snapshot object IDs and locally compared text hashes match the corresponding initial/retry/final layer elements; only the final layer is visible. Raw dialogue and source images are deliberately absent here. The supplied stale export SHA equals revision 1, not the current revision 3 ledger SHA. This rules against missing retry dispatch and stale snapshot text for this inspection. It does not prove what the user's browser cached.

The stable `/pages/{id}/rendered` URL used `max-age=31536000, public, immutable`, while Reader export used normal fetch caching. A neutral local Chromium HTTP reproduction (`scripts/playwright/verify_export_cache.cjs`) produced:

```json
{"oldDefaultFetch":"initial","newClientFetch":"final","newServerDefaultFetch":"final","serverHits":4}
```

That confirms the caching defect independently. The callback also previously fetched mutable `rendered/{imageId}.png`, a separate race capable of assigning another attempt's bytes to a valid ledger. Fixes address both boundaries; no claim that the second race caused page 14.

## Failure severity policy

- Block a page's successful completion/current export on stale or mismatched artifact identity, pending/failed required render, incomplete/duplicate/foreign/malformed QA coverage, or exhausted QA requiring review. A single occurrence is sufficient because the result is untrustworthy.
- A deterministic empty cleanup mask/invalid required geometry preserves source, records review-required diagnostics, and withholds translation for that page. Valid patches remain retained; unrelated pages continue. No retry storm and no claim of cleanup success.
- Retry eligible transport/storage failures only with the existing bounded attempt/generation fencing.
- Explicit SFX/preserve exclusions count as accounted exclusions. Optional diagnostics may warn if they do not compromise required artifact/coverage invariants. Warning status never closes missing quality evidence.

## What changed (OQ-01 freshness + OQ-02 accounting packet)

**Render artifacts are attempt-scoped.** The worker writes each render to
`rendered/{imageId}/jobs/{jobId}/attempts/{attempt}/{pngSha256}.png` and names it in the callback
(`artifact`: path, digest, byte length, type). The backend claims the callback first, then verifies
path, bytes, digest and length before filing the revision-addressed copy; a mismatch rolls the
claim back. The mutable `rendered/{imageId}.png` key is no longer written or read anywhere.
The render route also refuses a callback whose revision/scene digest differ from its ledger row.
An obsolete render (not current) no longer resizes elements of the newer scene or enqueues QA.

**QA judges exactly the bound artifact.** The render callback puts `renderArtifact`,
`pageRevision` and `logicalSceneSha256` on the QA job. VLM QA reads that artifact and verifies it
(refuses a missing binding or mismatched bytes); hybrid QA renders its prepared scene under its own
QA attempt key. Every QA callback reports `qaTargetIds`, the raw-response `qaResponseIntegrity`
report, and `judgedArtifact`.

**The backend decides the pass (`check_qa_callback`) before applying any verdict:**
- *Stale* — judged revision ≠ page revision, scene digest ≠ current snapshot, or the artifact is
  neither the bound render nor this QA attempt's own render → `STALE`, nothing applied.
- *Incomplete* — missing / duplicate / foreign / malformed verdicts, a failed integrity report, or
  a region the page displays text for that was not submitted → `QA_INCOMPLETE`: no verdict applied,
  layer `qa.status = "incomplete"` with the problem list, WARNING notification, no "Processing
  Complete". No automatic paid QA retry.
- *Retry exhaustion* with failures left standing → `COMPLETED_WITH_FAILURES` (WARNING), and the
  final-pass render no longer announces success.
- A QA final-pass render intent is persisted beside its snapshot, so recovery re-creates it with
  the same `finalPass`/`completesPipeline` flags (commit-before-dispatch interruption).

**Export and thumbnails.** `/pages/{id}/rendered` and `/images/{id}/thumbnail/rendered` answer
`Cache-Control: private, no-store`; Reader export fetches with `cache: "no-store"`. The rendered
thumbnail is generated from the current artifact and keyed by its PNG digest (it previously read
the mutable key and was cached forever per image).

## Failure severity policy (answer to "blocking or warning?")

One occurrence is enough to block when it makes the result untrustworthy:

| Event | Effect on the page | Effect on the run |
| --- | --- | --- |
| Stale/mismatched artifact or verdict identity | Refused; nothing applied | Blocking for that callback; newer revision continues |
| Incomplete / duplicate / foreign / malformed QA set | Not passed; no verdict applied; `incomplete` + WARNING | Other pages continue; counts as a gate failure |
| QA failures left after the retry budget | `COMPLETED_WITH_FAILURES`, WARNING | Other pages continue; counts as a gate failure |
| Pending / failed required render | Export answers 409 pending/failed, never an older PNG | Blocking for export of that page |
| Deterministic empty cleanup mask (OQ-07, not yet implemented) | Source preserved, review required, translation withheld for that page | Other pages continue; no retry storm |
| Transient storage/transport failure | Bounded, attempt-fenced retry | Warning unless the retries exhaust |
| Explicit SFX/preserve exclusion | Accounted exclusion | Not a warning |

A warning never closes missing gate evidence: an R3 gate run with any incomplete or stale page
is a failed gate for that page, reported individually.

## Deployment constraint

Backend and worker must ship together, with the render and QA queues drained first. Old-shape
render callbacks (no `artifact`) now get 409, and old-shape QA jobs (no `renderArtifact`) fail in
the worker. The R7 Reader/inpainting work-in-progress is parked in
`r7-reader-inpainting-wip.patch`, deliberately not applied: it made opening the Reader advance the
page revision, and the scene builder ignored its edits, so the PNG and the Reader would disagree.

## Validation log

- Chromium cache reproduction (`scripts/playwright/verify_export_cache.cjs`): old policy returned
  `initial` after the server moved to `final`; either fix returns `final`.
- `scripts/playwright/verify_synthetic_render.mjs` (renderer-only initial/retry/final/hidden pixels)
  is written but **not executed**: Chromium cannot start inside this sandbox (`sandbox_host_linux`
  fatal). Not a pass.
- Backend, isolated pg/valkey/minio (`scripts/test-env.sh run`): `cargo fmt --check` clean,
  `clippy --all-targets -D warnings` clean, `cargo test --no-fail-fast` **208 passed, 0 failed,
  24 suites**. `jobs_endpoints` had been silently skipping (malformed DB URL) and now executes.
  New: 5 pure `qa_coverage_tests`; `qa_rejects_incomplete_and_stale_verdicts` (missing, unsubmitted,
  duplicate, stale, complete); the full HTTP pipeline test now walks render → bound QA → pass.
- Worker: ruff, ruff format, pyright (0 errors), **573 passed**. New tests: attempt-scoped render
  key, truncated response reported incomplete with targets and judged artifact, integrity errors for
  duplicate/foreign verdicts, VLM refuses bytes that are not the bound artifact.
- Frontend: typecheck clean, lint clean, **409 passed**.
- Not done: no live dev-stack run of the changed handshake (the stack was down), no paid run.
  OQ-07/OQ-08 cleanup outcomes and R7 remain open. R3 stays **NOT PASSED**.

## Continuation: fresh dev stack and processing smoke check

The deployed stack's old database lacked `pages.input_generation` and the six job
generation/lease/progress fields. Upload inserted a page and then panicked decoding
it (`ColumnNotFound("input_generation")`); redo failed to enqueue a job. Container
health checks did not detect this schema mismatch.

At the user's direction, replaced the disposable dev database, queue, object store,
and render cache with fresh volumes initialized from current `database/init.sql`.
Model caches were retained. Backend, worker, and renderer were built from the current
checkout. No migration service or migration SQL is retained.

- All six dev services reached healthy state at `http://127.0.0.1:18080/tlhub/`.
- Browser login and multipart upload of a neutral blank 512×512 PNG succeeded.
  Panel detection and local PaddleOCR completed at attempt 1, generation 0.
- The existing image's redo-OCR endpoint accepted the operation, and the new OCR
  job completed at attempt 1, generation 1. Worker callbacks returned HTTP 200.
- The blank page had zero regions, so downstream translation/QA was correctly
  skipped. This is upload/dispatch/callback verification, **not full translated-page
  acceptance**. No provider inference calls were needed. Synthetic database records
  and test accounts were removed after verification.
- The existing renderer-only script now passes initial/retry/final/hidden cases,
  with four distinct PNG digests. Fixed its hidden fixture to request no unused font.
  Outputs and identities are retained in `artifacts/` beside this report.
- Six dev setup tests pass; their expected service list now includes the existing
  page-renderer service.
- The backend HTTP pipeline test now follows failed QA through retry translation,
  a newer scene revision containing the retried text, a changed scene digest, bound
  QA, and an export returning the newer artifact bytes. These are recorded callbacks
  and synthetic byte identities, not an actual worker-rendered translated-page run.
- Full isolated backend gate (`backend-rust/scripts/test-env.sh run`) completed:
  formatting and Clippy clean, **208 passed, 0 failed, 0 ignored** across 24 suites.
  Fresh test MinIO bucket setup is
  now explicit in the endpoint harness. The dev database was not used for this gate.

Next: finish OQ-01/OQ-02 acceptance, then OQ-07/OQ-08 cleanup outcomes, Reader cleanup
round-trip parity, and fitting. R3 remains **NOT PASSED**.
