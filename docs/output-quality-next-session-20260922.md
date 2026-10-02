# Output quality — next-session starting point, 2026-09-22

## Start here

This is the current resume document. It supersedes the next-action advice in the [2026-09-21 owner briefing](output-quality-owner-briefing-20260921.md) and the pre-implementation descriptions in the [R3 handoff](quality-checkpoints/R3-phase-separation-handoff-20260921.md). Preserve their historical evidence. The [implementation tracker](output-quality-implementation-tracker.md) remains the overall ledger.

**Next bounded delivery: fix QA-to-render freshness and incomplete QA verdict accounting, using synthetic/recorded inputs. Then integrate Reader cleanup and fix fitting.** R3 remains **NOT PASSED** on reliability, performance and quality. Do not restart phase separation, replace the renderer, or infer acceptance from passing unit tests.

This session was investigation and documentation only. No application/worker changes, processing jobs, paid benchmarks, deployments, or new test-suite runs were performed. The user requested a ready-to-use handoff, not implementation in this turn, and explicitly confirmed after the cleanup investigation: **“Finish triage and handoff; fix next session.”** All eight issues below remain subject to their stated acceptance checks; the four failed cleanup jobs were not retried or changed.

## Verified starting state

- Inspected parent HEAD: `63f0ce21b0b1907ad6201951f20420af239c5fe8`; worker: `909264d957453e6ceb88d301e105d714b16fbf3f`. Refresh status and runtime image identity next session; do not assume running images equal checkout HEAD.
- R3 Packets 1–2 landed: sequential cleanup job, attempt/input-generation/lease fencing, recovery contract, removal of the unconditional second CTD pass. Normal progression remains OCR → cleanup → translation → render → QA, with existing bounded retries (layout/classification occurs between OCR and cleanup).
- Recorded implementation validation: backend 202, worker 569, frontend 409 tests passing. Those counts are historical, not tests rerun for this handoff.
- Durable in-transaction next-stage dispatch covers only `layout→cleanup` and `cleanup→translation`. Three other edges rely on post-commit dispatch and orphan recovery. Recovery can take roughly the five-minute sweep plus the 120-second lease. Real crash/restart and stale-attempt validation remains open.
- The user deployed the dev stack. Containers named `manga-r3c-20260922-*` were healthy; frontend/backend accessible at `http://localhost:18090/tlhub/`. Browser login and navigation to Test → Chapter 1 → Reader page 8 succeeded. The chapter had 24 pages at inspection. Credentials are intentionally not copied into docs.
- Existing logs show separate cleanup completions and page 14 translation/render/QA callbacks. This supersedes historical statements that no post-change live activity exists. It is not a controlled speed comparison or complete HTTP/recovery acceptance.
- Only five of the historical six fixtures have captured exports; sample61 remains timing-only. No new full fixture/control gate was run. Historical 1,038-second sample61 cleanup and the projected saving from removing its second CTD pass are not current measurements.

## Triage and delivery order

| ID | Priority / state | Problem and bounded next action | Acceptance required |
| --- | --- | --- | --- |
| OQ-01 | P1, mismatch confirmed; exact cause open | QA retries can leave exported pixels showing superseded text. Trace authoritative layer state → snapshot → queued render → accepted artifact → PNG response. Include direct fixes and hidden/rejected regions in the same freshness contract. | Synthetic initial → retry → final text sequence exports final text only; hide/reject removes the intended replacement; obsolete callbacks cannot publish old pixels; completion waits for the required current render. |
| OQ-02 | P1, known open defect | Incomplete QA verdict sets can pass (historical 38/63). Persist expected target IDs tied to submitted generation/artifact, compare unique valid returned IDs. | Missing, duplicate, foreign, malformed or truncated results cannot pass; legitimate exclusions are explicit; stale/duplicate callbacks cannot edit or advance a newer run. |
| OQ-03 | P1, live Reader gap confirmed, R7 | Reader lacks R3 cleanup assets; source lettering remains under translations while server PNG is cleaned. Add a separate Inpainting layer from existing assets. | Source → cleanup → text composition matches canonical content view; moving text leaves cleanup fixed; patch move/resize/hide/delete/opacity persist; overlapping patch deletion recomposes correctly. No in-editor regeneration in this first slice. |
| OQ-04 | P1, fitting defects confirmed, M7 | Text geometry crosses page bounds; narrow columns and uneven sizes harm readability. Fix boundary/padding/wrapping/readable sizing using the shared fitter, then broader hierarchy/collision/style checks. | No off-page glyphs/strokes or unreported overflow; Reader and export use identical resolved layout. Include sample697–sample700 and sample76 plus conventional dialogue controls. Merely raising 72 px is insufficient. |
| OQ-05 | P1 for faithful project saves, archive gap confirmed | Project ZIP has original and layer mask/text rasters plus metadata but no cleanup assets. Ship the cleanup round-trip with R7; retain broader canonical archive work under M8. | New-format export/import preserves cleanup assets, transforms, visibility, layer order and text. OCR remains metadata/optional editor overlays, never a raster export. Hidden historical layers must not flatten into the visible result. |
| OQ-07 | P1, cause narrowed; unresolved | Four cleanup jobs fail on empty CTD masks, stopping entire pages. Distinguish detector miss/uncertain region from transient infrastructure failures and preserve explicit review behavior. | Typed persisted outcomes; no silent success for empty masks; retry only eligible failures; uncertain source pixels stay unchanged with visible review state; valid regions and excluded SFX remain correctly accounted for. |
| OQ-08 | P1, protocol/diagnostic defects confirmed | Cleanup callback commits FAILED but returns HTTP 200; worker then sends COMPLETED and receives 409. Failure reasons are dropped from stored region diagnostics. | Worker honors accepted terminal outcome; no contradictory completion PATCH; transient retries are bounded and attempt-safe; queue UI exposes useful cause and review/retry action. |
| OQ-06 | Gate blocker, open | R3 quality/performance/reliability evidence is incomplete. Retain current-stack evidence first; run controlled canary and fixture gate only within agreed run/spend scope. | Stage/total timings, hardware and image identities, retries, billed/estimated cost distinction, cleanup-only assets/crops, protected-art invariance and complete six-fixture/control verdicts. Report failed gates individually. |

P1 denotes user-visible correctness/high priority here, not a claim of data loss or a security incident. OQ-01 and OQ-02 are the first implementation packet. R7's implementation dependency (separate cleanup stage) has landed; acceptance remains open. Carry the small cleanup archive slice with R7 rather than leave project saves unable to represent its new layer. Full M8 consistency and M9 corpus/release remain later work.

## OQ-01: page 14 evidence and diagnostic boundary

User supplied these local files (do not copy images or dialogue into the repository):

- `/home/sagnik/Downloads/page-14-layers(3).zip`
- `/home/sagnik/Downloads/page-14-export(3).png`
- `/home/sagnik/Downloads/Screenshot 2026-09-22 at 22-14-37 tl-hub Test - Ch. 1 Page 14.png`

Archive metadata: image `b0b1b726-7458-458a-a50a-f7e2aef0333d`, dimensions 800×1066, export timestamp `2026-09-22T16:44:42.149Z`, one region `ff02aa5b-3ce6-445c-bde0-6954156741fd`.

| Layer | ID | Archived state |
| --- | --- | --- |
| Initial translation, z2 | `db82e709-1d0c-4fca-9d97-d7ad7453806a` | Hidden, initial text |
| QA retranslation, z3 | `126c52d0-f1fd-440c-9234-8f08bf606915` | Hidden, retry text |
| QA retranslation, z4 | `6beb6da0-9b8a-430a-a6b1-4b98b8c0c9db` | Visible, final text; QA passed at `16:28:20.111810497Z`, `retries_used=2` |

The screenshot matches the latest visible layer; the supplied PNG visibly matches the initial superseded layer. The ZIP also includes raster files for all three translation layers; hidden history in an editable archive is not itself proof of incorrect flattening.

Read-only backend logs for the same image establish this UTC sequence:

| Event | Time |
| --- | --- |
| Initial translation callback | 16:25:57 |
| Initial render callback | 16:26:03 |
| QA fails, retry 1/2 | 16:26:53 |
| Retry translation / render callbacks | 16:27:09 / 16:27:11 |
| QA fails, retry 2/2 | 16:27:27 |
| Final translation / render callbacks | 16:28:05 / 16:28:06 |
| Final QA pass, pipeline complete | 16:28:20 |

**Confirmed: exported content disagrees with the latest visible QA-reviewed layer. Not confirmed: that render was never scheduled. Render callbacks occurred after both retries.** Callback logs alone do not prove which scene was rendered or which artifact the download selected. This case exercises QA retranslation, not `direct_fix` or `reject_sfx`; the user's reported hide/disable case needs its own focused reproduction.

First inspect [coordinator.rs](../backend-rust/src/jobs/coordinator.rs): `handle_translation_callback`, `handle_qa_callback`, `enqueue_final_pass_render`, `handle_render_callback`; [page_scene_builder.rs](../backend-rust/src/page_scene_builder.rs): snapshot construction and selection of layer/region text; [page_scene.rs](../backend-rust/src/page_scene.rs): `current_render_artifact`; [recovery.rs](../backend-rust/src/jobs/recovery.rs): `enqueue_current_snapshot_render`; [page.rs](../backend-rust/src/routes/page.rs): `get_page_rendered`; [Reader.tsx](../frontend/src/components/Reader.tsx): `handleExportPng`.

Capture a read-only join of page revision/current job pointer, scene snapshots, render jobs/digests and selected visible layer IDs. Compare initial/retry/final snapshot text with layer-element text and region state. Verify runtime build identity. Distinguish stale scene projection, absent invalidation/revision advance, rejected render callback, stale pointer, and HTTP/browser caching before selecting the fix. Existing final-pass code means blindly adding another render call is not sufficient.

Source review narrows the candidates:

- `build_pipeline_scene` reads through the snapshot transaction and selects visible translation/SFX layers. Its comment documents a previously fixed pool-read bug that rendered one translation behind. Verify the deployed build before assuming that older cause has returned.
- `handle_render_callback` fetches the mutable `rendered/{image_id}.png` worker output and then stores those bytes under an immutable revision/digest path. Investigate whether concurrent/out-of-order renders can associate the wrong bytes with a valid ledger entry; this is a code-supported candidate, not the established cause of page 14.
- Current-artifact resolution checks revision, scene digest and succeeded status. If these work correctly, an obsolete callback should leave a newer page pending/failed, not make old pixels appear current. Trace that invariant end to end.
- Existing `backend-rust/tests/coordinator_flows.rs` direct-fix/visibility/retry tests cover DB changes or enqueueing but do not prove the final exported bytes. `backend-rust/tests/jobs_endpoints.rs` freshness tests use synthetic render jobs and do not originate from QA retranslations. Add the missing integrated path and a shared-output interleaving case, not another scheduling-only assertion.

Use neutral synthetic text (`initial`, `retry`, `final`) and plain background fixtures. Required regressions: two retranslations; direct text/font fix; hide/reject-only QA; mixed fix plus exhausted retry/manual-review branch; no-op QA; duplicate/stale callback; commit-before-dispatch interruption; failed final render; export during pending render. Assert scene content and artifact identity as well as scheduling. Preserve cleanup when only translation changes; test rejection policy separately so text visibility does not accidentally leave unwanted cleanup or restore unrelated content.

## OQ-03/04/05: page 8 evidence

Local inputs: `/home/sagnik/Downloads/page-8-layers(2).zip`, `/home/sagnik/Downloads/page-8-export(5).png`, `/home/sagnik/Downloads/Screenshot 2026-09-22 at 22-00-55 tl-hub Test - Ch. 1 Page 8.png`.

- Image `0e4a35f4-d36d-4b2b-8896-3372467d045b`, 1067×1600. Screenshot and live Reader show the cleanup gap; supplied PNG shows cleaned background.
- Right-hand translation element: x=894, width=181, right edge=1075, eight pixels outside page width. Visible blocks record 50 px and 20 px sizes. Geometry, typography and boundary handling all need attention; these measurements do not identify a single fitter root cause.
- Archive has only `original.png`, one translation mask PNG, one translation PNG and `project.json`. No cleanup patch assets or Inpainting layer.
- QA reports two accepted regions plus one rejected sound effect out of three. That count is accounted for; do not label this example a missing-verdict reproduction. Its visual issues still show why QA status alone is not layout acceptance.
- Shared fitting entry point: [layout.ts](../packages/page-scene/src/layout.ts), including the 72 px automatic starting-size cap. Reader uses [fitText.ts](../frontend/src/utils/fitText.ts) / [textFitBox.ts](../frontend/src/utils/textFitBox.ts); server layout uses [ContentScene.ts](../packages/page-scene/src/ContentScene.ts). Trace shared and divergent paths before editing.

## OQ-07/OQ-08: cleanup failures on pages 12, 13, 15 and 24

Additional user screenshot: `/home/sagnik/Downloads/Screenshot 2026-09-22 at 22-25-19 tl-hub - Test - Ch. 1.png`. Read-only SQL and worker logs confirm four FAILED cleanup jobs, each still at attempt 1:

| Page | Cleanup job ID | Empty-mask regions (source x,y,w,h) |
| --- | --- | --- |
| 12 | `e93cda68-58f8-4816-8db2-60b1953d643c` | `79c15344-8d6e-48ec-a615-6c3c52178b27` (348,561,122,147) |
| 13 | `fdfe5023-dadb-471b-9846-460f72ef5de0` | `5a599dab-a1e9-43e9-aa6e-990358a4f8d8` (808,232,97,99) |
| 15 | `3e681ec6-325c-40d5-b6b6-4ba35148ddf2` | `5577486b-ff12-4bab-9e17-523ff700b43f` (0,1155,285,414) |
| 24 | `8ee7f9d0-8e08-445b-b149-699dcfebab36` | `49574707-f3d2-4629-9c75-c7cf6fd3df3d` (775,284,50,168); `7d76472d-6382-4a74-897e-e8eed1fd6900` (900,472,36,38); `dc7315f3-a137-491c-aeb9-751cc58b94cc` (784,530,61,84) |

The six matching worker log entries say **“rejected, CTD found no glyphs”**. This means the thresholded mask gated to the dispatched region footprint was empty; it does not prove that the source contains no lettering. Page 13's region is classified caption; the others speech. Page 24 also has an excluded SFX region without a cleanup patch; do not count that legitimate exclusion as a seventh failed region.

Confirmed chain:

1. `reconstruct_region` in [cleanup_reconstruct.py](../worker/src/worker/services/cleanup_reconstruct.py) returns `None` for an empty gated mask (also for other distinct rejection conditions).
2. `_process_region` in [cleanup.py](../worker/src/worker/handlers/cleanup.py) collapses this to failed with generic `CTD/reconstruction produced no cleanup artifact`.
3. `apply_cleanup_callback` in [internal.rs](../backend-rust/src/routes/internal.rs) marks the page's cleanup job FAILED if any dispatched region failed, deliberately withholding translation. This prevents claiming cleanup succeeded while source lettering remains. It stores complete/degraded diagnostics but drops failed-region diagnostics; SQL shows NULL diagnostics on these six failures.
4. The callback returns HTTP 200 after persisting FAILED. `process_cleanup` returns normally, and `process_job_rq` in [rq_tasks.py](../worker/src/worker/rq_tasks.py) unconditionally requests COMPLETED. All four jobs logged a rejected `FAILED → COMPLETED` PATCH. The jobs remain FAILED at attempt 1; this route does not enter the worker's exception-based retry branch. Do not claim automatic retries recovered them.

The detector's empty-mask outcome is the immediate cause, **not a verified MinIO outage, provider refusal or timeout**. Whether each empty mask is a real detector miss, classification/geometry error, or a region that should be preserved/reviewed remains unresolved. Do not weaken the threshold globally, substitute a destructive rectangle, call all empty masks successful, or automatically resend deterministic failures until they happen to pass.

Next bounded resolution: introduce explicit reasons for empty mask, invalid geometry, detector failure and asset upload failure; preserve them in backend/UI. Give the worker a clear accepted terminal outcome so it cannot overwrite FAILED with COMPLETED. Separate retryable infrastructure failure from uncertain-content review. A preserve-and-review path must carry explicit policy and prevent translation/cleanup replacement of unresolved regions, while retaining valid artifacts; confirm this behavior before changing the existing all-or-nothing stage contract. Refresh API schema if the callback contract changes. Use neutral synthetic fixtures for the implementation; do not reprocess the supplied pages as a workaround.

Tests: empty mask versus thrown detector error; one failure among valid regions; expected SFX exclusion; diagnostic persistence; accepted failed callback and duplicate delivery; no COMPLETED PATCH after terminal failure; transient retry with new attempt identity; deterministic empty-mask review without retry storm; successful eventual retry; no new translation dispatch while required cleanup remains unresolved. Verify the intended queue message and state through the dev stack. These issues remain **OPEN**, not resolved by documentation.

## Evidence identity and handling

SHA-256 of inspected archives/exports:

| File | SHA-256 |
| --- | --- |
| page-14-layers(3).zip | `543550bbe21c279b9ec5429ca3cd6c50041ab05bcc193cf23ca313a7278fa46e` |
| page-14-export(3).png | `845e817af06e6354fa45b596f39a2102ee652caf5ff1c215d82a545a9efbb0ab` |
| page-8-layers(2).zip | `99a72b4b9f25378decfbfaf49306efadabe5f449c389cb4fdf3cb4bcc138c08c` |
| page-8-export(5).png | `d332621b1bebafcd98ea598eeb3d9b76fb9d42803dcf6dd92d7d1ab2c7cc0258` |

Downloads and the ephemeral stack may disappear. The structural evidence above remains useful; if inputs disappear, report that and reproduce with synthetic fixtures rather than claim a new visual verification. Keep source archives local and out of new provider calls. No credentials, raw dialogue or supplied images are embedded in this handoff.

## Next-session prompt

> Read docs/output-quality-next-session-20260922.md and the current tracker first. Start with OQ-01 QA-to-render freshness and OQ-02 complete QA accounting; include OQ-07/OQ-08 cleanup outcome, diagnostics and terminal-state handling as an explicitly bounded follow-up packet. Refresh repository/runtime identity and GitNexus indexes, then run impact analysis before symbol edits and report scope. Reproduce with synthetic text/background fixtures and recorded verdicts; correlate layers, snapshots, revisions, render jobs and exported artifact digests. Page 14 had render callbacks after retries, so do not assume the fix is merely to enqueue a render. Cover retranslation, direct_fix, hide/reject, pending/failed render, stale callbacks and retry exhaustion. Keep cleanup independent of translated text, bounded retries, and the existing renderer. Run focused checks and applicable repository gates; skipped infrastructure tests are not passes. Report changes, evidence, limits and remaining gate failures. Then proceed through Reader cleanup parity with faithful project round-trip, followed by fitting, in bounded packets. Do not launch a paid benchmark, broad corpus sweep, production deployment or architecture rewrite on the strength of this handoff. Preserve existing session authorization and obtain a concrete run/spend decision only when needed. R3 stays NOT PASSED until all required evidence exists.
