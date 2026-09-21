# R3 handoff — sequential cleanup, reliable recovery, honest acceptance

Updated 2026-09-21 after reviewing the tracker, retained runs, representative editor/export images, and current source. Inspected checkout: parent `ab86d20`, worker `ac7cbba`. These are review revisions, not the revisions that generated every retained image. Refresh heads and runtime image identities before implementation or measurement.

This handoff supersedes earlier summaries that say quality passed on six fixtures, describe cleanup as parallel/deferred, promise a measured post-fix speedup, or equate the editor with the render service. Historical run artifacts remain unchanged. This update records a proposed execution plan; it does not claim implementation, live validation, deployment, or user quality sign-off.

## Current state

**R3 is NOT PASSED. The worker → backend → scene data path exists. Performance fails; visual cleanup acceptance and complete fixture coverage remain open.** Cleanup still runs inside OCR with two CTD calls per eligible region. The separate cleanup job, heartbeat protocol, and removal of the second call are not implemented.

| Area | Verified state | Still open |
| --- | --- | --- |
| Cleanup | Per-region CTD masks, TELEA/AOT reconstruction, stored assets, server scene consumption. CTD caps the input long side at 1024. | Mask coverage, protected-art invariance, visual reconstruction quality, acceptable page time. |
| Translation | Source has default `CLOUD_CONCURRENCY=2` and OpenRouter reasoning capped at 4096 tokens. | Combined live speed/quality improvement. These retained runs do not establish it. |
| Recovery | Ten-minute stale threshold, five-minute sweep; callback claims deduplicate by job ID. | Current-attempt checks, periodic heartbeat, atomic result/stage advancement, restart behavior. |
| QA | Bounded translation/re-OCR retries and final render after accepted edits. | Complete target coverage: sample61 returned 38 verdicts for 63 regions yet logged a pass. |
| Editor/export | Page PNG export calls the backend rendered-artifact endpoint. Editor still draws legacy layer elements without R3 cleanup assets. | R7 shared cleanup scene behavior; remaining M8 archive/output consistency. |
| Fitting | Shared fitter exists; automatic starting-size calculation still contains a 72 px limit. | M7 sizing, narrow columns, collisions, overflow, style, and editor acceptance. |

Implementation entry points: [cleanup](../../worker/src/worker/services/cleanup_reconstruct.py), [CTD cap](../../worker/src/worker/services/glyph_mask.py), [OCR wiring](../../worker/src/worker/handlers/ocr.py), [translation](../../worker/src/worker/handlers/translation.py), [callbacks](../../backend-rust/src/jobs/coordinator.rs), [recovery](../../backend-rust/src/jobs/recovery.rs), [sweep schedule](../../backend-rust/src/jobs/mod.rs), [reader/export](../../frontend/src/components/Reader.tsx), [fitter](../../packages/page-scene/src/layout.ts).

## What the retained runs demonstrate

| Directory | Captured fixtures | Limit |
| --- | --- | --- |
| [`r3-20260921-six`](../quality-runs/r3-20260921-six/) | sample177 | Initial uncapped attempt. Partial manifests; sample222 took about 27 minutes in OCR/cleanup and exceeded the harness window. |
| [`r3b-20260921-six`](../quality-runs/r3b-20260921-six/) | sample177, sample222 | Capped attempt. Harness aborted waiting for sample61. Its eventual roughly 47-minute completion includes interruption/recovery overhead; no sample61 export was captured. |
| [`r3b-20260921-six-b`](../quality-runs/r3b-20260921-six-b/) | sample99, sample93, sample83 | Completed continuation on the same stack, not a second complete six-fixture experiment. |

The capped directories contain **five distinct captured fixtures**. A worker rebuild and stale recovery confound run A's wall time. The conventional controls have not passed the combined R2/R3 gate.

Keep [R3's timing table](R3.md#time--this-is-the-failed-part) as historical measurement. Sample61 took 1245.9 seconds in OCR: 202.9 seconds in page OCR, 1038 seconds in cleanup, including approximately 519 seconds initial CTD, 514 seconds recheck, and 5 seconds reconstruction. Removing the recheck alone projects **732 seconds / 12.2 minutes for OCR plus cleanup**, before translation/render/QA. This is subtraction from recorded timings, not a new benchmark. Separating jobs changes scheduling and recovery, not inference cost.

The reports compare final translated output with Torii's inpainted image inside region boxes; this mixes typography and cleanup. Changed/flattened-pixel percentages cannot establish correct artwork reconstruction. Unchanged OCR region counts cannot establish CTD mask accuracy. R3f/R3g cleanup-only capture/scoring remain unfinished.

Visual review of [sample83 export](../quality-runs/r3b-20260921-six-b/a04-exports/sample83/export.png) found reconstruction smearing; [sample93 export](../quality-runs/r3b-20260921-six-b/a04-exports/sample93/export.png) shows patchy/outline-shaped remnants and undersized text. These concerns are not yet independently root-caused. [Sample93 editor](../quality-runs/r3b-20260921-six-b/a04-exports/sample93/editor.png) demonstrates the editor/export cleanup gap. Aggregate metrics do not close these findings.

## Preserve the agreed direction

Normal forward path, after any existing panel-detection step:

`OCR → cleanup → translation → render → QA → complete/review`

1. Cleanup is one job per page, processing a stable ordered list of regions. Keep it sequential with translation. No parallel cleanup branch or late-cleanup re-render mechanism.
2. Retain per-region CTD **with the existing 1024 cap** and current reconstruction routing. Older “native CTD” wording must not lead to removing the cap. Do not reopen whole-page CTD/model/quantization exploration in this packet.
3. Remove the unconditional runtime recheck. It rejected no regions in the logged gate run and consumed about half its cleanup time. This supports an optimization candidate, not universal claims of uselessness or zero quality risk. Retain offline evaluation and known bad-reconstruction cases; an inside-mask residual score cannot validate missing glyphs outside that mask.
4. Add cleanup to the existing heavy queues on **both backend and worker**. No independent heavy capacity. `MAX_HEAVY_SLOTS` is per worker, not a fleet-wide limit. Translation chunk concurrency separately affects provider load.
5. Preserve source images and linked cleanup patches. English text movement must not move source cleanup or rerun it. R7 separates cleanup visibility from text visibility for manual typesetting; reconcile older coupled hide-text/hide-cleanup rules when specifying that layer.

Sequential does not mean an unconditional single pass: existing QA retries/final renders remain bounded branches. Require one authorized forward stage per page/run, with obsolete attempts unable to mutate current state. Persisted stage outputs and pinned scene/font inputs support replay; fresh remote LLM calls do not promise identical text or timing. Translation chunks currently map results by region ID, not completion order; preserve that behavior.

## Next work, in bounded packets

Start with a concrete specification, then the reliability foundation. Use existing R3/R5 seams; avoid a general scheduler rewrite. Each implementation packet needs focused verification and its own evidence. This documentation update makes no runtime changes.

### Packet 1 — freeze the transition and recovery contract

Write `docs/superpowers/specs/2026-09-21-r3-phase-separation-design.md` and a bounded implementation plan. Preserve the decisions above; resolve these mechanics from actual callers:

- Cleanup job name and immutable payload/result shapes: stable region IDs, source/geometry/policy/config digests, page/run generation, attempt or lease token. Distinguish input generation from scene revisions created by successful output writes.
- OCR callback → persisted regions → cleanup → persisted patches → translation. Define empty-page, policy-exclusion, partial-failure, cancellation, edit, deletion, and redo outcomes. Missing patches/fallbacks must remain explicit, not count as successful cleanup. Trace page redo, region redo, and QA re-OCR separately; do not assume identical cleanup wiring.
- Heartbeats, status updates, and callbacks must match the current attempt/input generation. An old attempt cannot renew a newer lease, write patches, reset status, or dispatch translation. Job-ID deduplication alone is insufficient.
- Commit callback acceptance, result records, and durable next-job intent together. Specify queue publication/reconciliation after commit so a crash between database and Redis cannot strand or duplicate the next stage.
- Periodic liveness heartbeats during inference/network waits, separate progress timestamps/counters, and bounded operation timeouts. A heartbeat thread must not hide hung inference indefinitely. Specify startup grace, heartbeat interval, expiry, sweep cadence, and recovery bounds together; two-minute expiry plus today's five-minute sweep is not two-minute recovery.
- Scope the same protocol to other long stages, especially OCR/translation. Cleanup-only heartbeat leaves their false-recovery path open. Enumerate shared-code impact and split implementation where necessary.
- State what survives restart. Prefer reusing completed region artifacts only when source, geometry, policy, and generator/config digests match; otherwise account for recomputation. A filename or existing row is not proof of a valid cache hit.

Finish with concrete transitions, payloads, failure outcomes, affected files, and tests. Do not repeat architecture brainstorming or make unavailable historical skills a prerequisite. Apply the current session's instructions and authorization to subsequent implementation and runs.

### Packet 2 — recovery safety, then the cleanup stage

Implement attempt/generation checks, heartbeat handling, and durable stage advancement at the touched seams first. Wire cleanup onto those guarantees, move it out of OCR, keep the cap, and remove the runtime recheck. Preserve asset/compositing semantics unless a separately reproduced defect needs correction.

Required integration cases: healthy work spanning the old ten-minute threshold; death before callback; death after commit but before queue publication; duplicate callback; superseded attempt arriving after recovery; edit/cancel/delete during cleanup; partial region failure. Assert persisted results and downstream dispatch counts. Use isolated database/queue services; skipped integration tests are not executed.

### Packet 3 — QA coverage before quality acceptance

Persist expected QA target IDs for the submitted generation/artifact. Compare them with unique valid returned IDs. Explicit policy exclusions are not missing verdicts. Truncation, missing IDs, duplicates, or foreign IDs cannot produce a full pass. Retry under a bounded policy or finish incomplete/manual review. Old QA cannot approve a newer artifact.

Regression: 38 verdicts for 63 expected targets cannot be `passed`. Cover empty and partial responses. JSON repair is not complete QA. Keep this separate from provider tuning.

### Packet 4 — measurement and the bounded gate

Finish R3f/R3g: capture logical/resolved scene, actual cleanup assets, cleanup-only composite, final artifact and provenance. Measure cleanup independently of translated text. Check exact source invariance outside approved alpha support, lettering/outline coverage, and protected art. Keep human crop review; Torii similarity is supporting evidence, not a sufficient pass.

Use recorded OCR/translation outputs first to isolate cleanup/replay without paid calls. Then run a fresh isolated live canary with image/model/config identities and effective hardware/resources recorded. No mid-benchmark worker rebuild. Forced restart is a separate labeled reliability run. Save resumable manifests; capture completed pages without repeating paid stages.

Complete all six fixtures, including sample61, and the selected short list (`sample7`, `sample197`, `sample641`) before the combined conventional-control sweep under existing runbook/review/budget decisions. The tracker historically says “24 controls” but later adds sample641 as the 25th: enumerate the actual manifest and report its denominator. Preserve A09; do not score or tune on it here.

The previously requested live `gpt-5.6-luna` comparison remains pending for the next provider test round. Hold inputs/settings constant and report omissions/refusals, tokens, retries, cost and time. Do not silently change the default model or claim the comparison happened.

### Packet 5 — R7 editor, then M7 fitting

R7 should consume the same assets and shared scene/layout as the artifact, without another independently editable scene or typography implementation. First cut: separate Inpainting objects with the agreed geometry/visibility controls; no new inference-on-edit workflow. Specify source anchoring, explicit patch transforms, overlapping patches, hide/delete, undo and save/reload. Deleting a patch restores source plus remaining active patches; overlapping support requires recomposition.

Compare content-only renders at identical source dimensions, revision, fonts and assets. A viewport screenshot with UI/overlays need not share the artifact's PNG digest. Check canonical downloads by digest separately. OCR overlays remain absent from exports.

M7 addresses the 72 px sizing behavior, narrow columns, neighbor collisions, overflow, hierarchy, padding and style. Preserve the user's five named cases (`sample697`–`sample700`, `sample76`) alongside existing fixtures/controls. R3 does not close these defects. M8 finishes archive/output consistency; M9 release/corpus work remains later.

## Three separate acceptance decisions

| Gate | Required evidence | Current status |
| --- | --- | --- |
| Reliability | Attempt-safe callbacks, atomic advancement, bounded recovery, restart/edit/cancel cases, no duplicate accepted stage results/downstream jobs. | Open. Heartbeats alone cannot pass it. |
| Performance | Queue wait and service time per stage; region/call costs; first translated artifact and final completion; retry/recovery overhead; batch throughput/resource use on declared hardware. | Retained runs fail; optimized end-to-end result unmeasured. |
| Quality | All required captures, cleanup-only assets and visual review, complete translation/QA accounting, protected-art checks. R7/M7 separately gate editor equality/fitting. | Incomplete, with visible concerns. No six-fixture quality pass. |

Set explicit user-facing latency/throughput ceilings for ordinary and stress pages before calling speed accepted. These runs establish no approved numeric ceiling for the revised pipeline. Record per-page timings/sample count; small-sample percentiles are descriptive, not production p95 evidence. A heartbeat or finishing within the harness timeout is not a speed target. The unset ceiling does not prevent implementing/measuring the agreed optimization; it prevents claiming performance acceptance.

If capped per-region CTD without recheck still misses the eventual budget, retain that failure and propose one measured next optimization. Do not silently increase timeouts, concurrency, hardware requirements, or quality tolerances to manufacture a pass.

## Landed fixes and evidence limits

- Worker `ac7cbba` / parent pointer `5b15023`: translation concurrency and OpenRouter reasoning cap. The cap also affects OpenRouter OCR/QA. Some normal observed calls already used fewer than 4096 reasoning tokens; the cap alone cannot establish that typical translation latency is solved.
- Parent `0e61fa4`: literal backslash-n joining corrected to real newlines in Reader. Fitting and cleanup visibility remain open.
- Worker `57d402d`: seed-model fixtures stub CTD/AOT as well as YOLO. Previous handoff reports 559 worker tests, 409 frontend tests, and green hosted CI. These are historical results, not rerun or reverified by this documentation review.
- Whole-page CTD spike: prior notes report recall/agreement 0.34–0.75 at 1024 and poor recovery of selected regions at larger sizes. Comparator was per-crop CTD, not independently annotated glyph truth. Scripts/overlays were scratch artifacts, not reproducible assets in these three run directories. Keep the rejected direction closed for this packet; do not label per-region CTD universally correctness-safe.
- Dynamic quantization: prior spike reports 1.17–1.25× acceleration with mask disagreement; not selected. Static quantization remains unmeasured. LaMa-mpe/pluggable reconstruction are separate follow-ups.

## Resume checklist

Read this handoff, the [tracker summary](../output-quality-implementation-tracker.md#status-at-a-glance-2026-09-21--read-this-first-then-the-r-track-table), and [R3 measurements](R3.md). Check worktrees, heads and applicable instructions. Start **Packet 1**, then **Packet 2** before another expensive full run. Packets 3/4 must land before declaring quality acceptance.

GitNexus impact before symbol edits; worker index is `manga-tl-worker`, separate from parent. Detect changes in each changed repository before committing. Worker development uses root `.venv`; backend API changes require live OpenAPI regeneration. Deliver worker commits before the parent pointer. Preserve runs, sources, references and uploads. This handoff does not authorize volume resets, expanded paid corpus work or deployment, and records no new quality sign-off.
