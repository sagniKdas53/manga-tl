# R3 phase separation and recovery contract

Written 2026-09-21 for Packet 1 of the [R3 handoff](../../quality-checkpoints/R3-phase-separation-handoff-20260921.md);
updated 2026-09-22 to match what Packet 2 actually implemented. Where the two differed, this
document was corrected to the code, and each correction says why.

This is a reliability and scheduling contract. It makes no claim about cleanup speed or visual
quality, and it does not mark R3 passed.

## Scope

The forward page path is `OCR -> layout -> cleanup -> translation -> render -> QA`. Cleanup is a
heavy worker job, sequential with translation. Reconstruction itself is untouched: same per-region
CTD with its 1024-pixel cap, same TELEA/AOT routing, same asset and compositing semantics. The
only change to the cleanup work itself is that the unconditional second CTD pass is gone.

## Identity and generation

`pages.input_generation` is the page's **source/geometry** generation. `pages.scene_revision`
describes an artifact scene. They are separate on purpose: moving English text, retranslating or
restyling advances the revision and must not invalidate a cleanup patch computed from the source
pixels underneath it.

`input_generation` advances when, and only when, the page's source geometry is replaced:

- a whole-page OCR pass, in the same transaction that purges and re-inserts `ocr_regions`;
- a whole-page OCR redo, before the replacement job is enqueued;
- a source image replacement (`restore_project_page` with a replacement image).

**Correction to the 2026-09-21 draft**, which listed region redos too. A region redo rewrites one
region's *text* — `region_callback` never touches a bbox — and several run concurrently on one
image by design, so advancing the generation there would make each redo fence out the others'
in-flight jobs. Panel detection writes `panels`, not regions, and is likewise excluded.

Every `jobs` row carries `input_generation`, `lease_token`, `lease_expires_at`, `heartbeat_at` and
`progress_at`. The worker receives `jobId`, `attempt`, `inputGeneration` and `leaseToken` in its
payload and echoes all four as `X-Job-Id`, `X-Job-Attempt`, `X-Input-Generation` and
`X-Lease-Token` on every backend call it makes while running that job.

Authority is header-bound, not body-bound. Each stage's body has its own shape and its own
history, and a body field is exactly what a superseded attempt re-sends verbatim.

### Transitions

An internal status update may only affect the row its headers matched:

| From | To | When |
| --- | --- | --- |
| PENDING | PROCESSING | the start compare-and-swap; Redis may redeliver, only the first wins |
| PROCESSING | PROCESSING | heartbeat only, and only within `JOB_MAX_RUNTIME_SECS` of the stamped start |
| PROCESSING | PENDING | the worker's bounded retry; `attempt` must advance by exactly one |
| PROCESSING | FAILED | attempts exhausted, or a rejected delivery |
| PROCESSING | COMPLETED | the ordinary end of a stage |
| COMPLETED | COMPLETED | idempotent: the claim already completed the row, the worker's PATCH follows |
| FAILED | PENDING | re-arm after a failed delivery, same attempt rule |

`COMPLETED -> PENDING` is deliberately absent: a finished stage is not re-armable by a worker.
Anything not in the table is 409, which the worker's retry wrapper treats as terminal.

A stale job whose page has moved to a later generation is **not** re-armed: recovery fails it
explicitly. Re-dispatching it would run the stage again — for cleanup, a full CTD pass — against
a region list the page has left behind, and the fence would refuse its callback anyway.

Re-arming a row (any transition to PENDING, and both recovery paths) clears `started_at`,
`lease_expires_at`, `heartbeat_at` **and `callback_applied_at`**, and issues a fresh lease token.
Leaving the claim stamped would make the retry's own result read as a duplicate and be dropped —
a cleanup that failed once could then never succeed.

### Claims

A result callback claims the right to apply itself with a single conditional UPDATE, which
requires: the exact job id, image and type; status PROCESSING; the attempt, generation and lease
token from the headers; no prior claim; a start inside the runtime cap; **and the job's generation
still equal to its page's current `input_generation`**.

That last clause is what makes a page redo fence work already running: nothing rewrites the
in-flight job row, only the page moves, so comparing against the job's own stored generation would
have fenced nothing.

The claim reports three outcomes. `Claimed` applies. `AlreadyApplied` is the same attempt
re-sending a delivery that landed — acknowledged 200. `NotCurrent` is a superseded attempt —
answered 409, so it stops instead of reporting COMPLETED for a stage it no longer owns.

## Durable advancement

The `jobs` table is the durable dispatch intent. A result callback transaction: locks and claims
the job, writes its stage result, completes the job, and inserts the next PENDING job with its own
identity and immutable payload — then commits. Redis publication happens strictly after the
commit. A crash in between leaves a PENDING row that startup recovery and the two-minute
`requeue_orphaned_pending_jobs` sweep republish. Redis delivery may duplicate; the start
compare-and-swap means only one attempt runs.

**Implemented for `layout -> cleanup` and `cleanup -> translation`.** `ocr -> layout`,
`translation -> render` and `qa -> render` still enqueue after their transaction commits via
`enqueue_job_directly`. Those are recovered by the orphan sweep rather than by an in-transaction
successor, so they are a narrower guarantee, not the same one.

## Cleanup contract

The layout callback creates the cleanup job in the same commit as the classifications it is
computed from. Its payload carries `imageUrl`, hex `sourceSha256`, `inputGeneration`,
`cleanupInputDigest`, and an immutable ordered `cleanupRegions` list:

```json
{"regionId": "uuid", "x": 0, "y": 0, "width": 0, "height": 0,
 "policyAction": "replace|exclude", "inputDigest": "sha256"}
```

`exclude` is for regions policy keeps — SFX are never typeset, so their source lettering must stay
on the page. The worker verifies the downloaded source against `sourceSha256`, processes the list
in order under the node-scoped `ocr` lock (the same lock the work took when it lived inside the
OCR job), and reports exactly one outcome per region: `complete`, `excluded`, `degraded` or
`failed`.

The backend accounts the response against **its own** dispatched list, not the worker's. A missing,
repeated or foreign region, a mismatched `inputDigest`, an unknown status, or a region that no
longer belongs to the page is an incomplete cleanup. An incomplete cleanup persists nothing
downstream, fails the job with a message naming the first problem, and withholds translation — a
page whose Japanese is still on it does not get translated. No cache reuse: a replacement attempt
recomputes.

Reader mode (series source language == target language) stops the pipeline at layout and persists
no cleanup job at all.

## Liveness bounds

`JOB_LEASE_SECS` is 120; the worker heartbeats every 30 seconds from a thread that shares the
attempt's context. Each heartbeat carries the attempt's progress counter, and the backend advances
`jobs.progress_count`/`progress_at` only when it grew. That is the reading that separates "the
worker is answering" from "the job is advancing": a hung inference keeps the first moving and
stops the second. Nothing acts on it automatically yet — it is operator-visible state behind the
runtime cap, not a second timeout.

The heartbeat renews the lease only while the attempt is alive and only inside
`JOB_MAX_RUNTIME_SECS` (3600) of the stamped start — a heartbeat thread cannot keep a hung
inference alive indefinitely. A rejected heartbeat revokes the attempt locally, so its own
subsequent backend calls raise instead of being sent.

The stale sweep keys off `lease_expires_at` rather than ten minutes of silence on `updated_at`,
which is what lets a cleanup page that spends seventeen minutes inside CTD survive it. Rows with
no lease (pre-upgrade, or never started) fall back to the old ten-minute rule so an upgrade does
not strand them. The sweep runs every five minutes, so **recovery is worst case about five minutes
plus the lease, not two minutes** — the two numbers only mean something read together. Re-arming
is itself a compare-and-swap on the attempt and lease the sweep observed, so a worker that
heartbeated in between is not yanked back to PENDING underneath itself.

A stale job whose page has moved to a later generation is **not** re-armed: the sweep fails it
explicitly instead. Re-dispatching it would run the stage again — for cleanup, a full CTD pass —
against a region list the page has left behind, and the generation fence would refuse its
callback anyway. Up to `max_attempts` of that is waste, not retry.

## What survives a restart

Persisted stage results and the `jobs` rows. Completed region artifacts are **not** reused: the
first cut recomputes rather than trusting a filename or an existing row as a cache hit.

## Removing the second CTD pass

`reconstruct_region` no longer calls `_residual_ink_pct` on the reconstructed crop. That recheck
consumed roughly half of cleanup's wall time on sample61 (about 514s of 1038s) and rejected no
region in the logged gate run. `_residual_ink_pct` and `CleanupConfig.residual_ink_max_pct` remain
as offline evaluation helpers; neither is read on the runtime path. `GENERATOR_ID` moved to
`ctd-seg+telea-aotgan-cleanup/v2-single-ctd`, so a stored patch records which recipe made it.

**No run has been made since.** The projected saving is subtraction from R3's recorded timings,
not a measurement — and removing the recheck also removes the only runtime check that a
reconstruction came out clean, leaving the 0.3 threshold and the 5px dilation as the whole recall
margin. Packet 4 is where that gets measured. Nothing here claims a speedup.

## Known deployment hazard

Jobs already queued or PENDING without `leaseToken`/`inputGeneration` in their payload produce
partial identity headers, so the backend answers 409 and the worker stops. On a stack that can be
drained this is a non-issue; on one that cannot, those rows need re-enqueueing after deploy.

## Files

- `database/init.sql` — `jobs.input_generation`/`lease_token`/`lease_expires_at`/`heartbeat_at`/`progress_at`/`progress_count`, `pages.input_generation`
- `backend-rust/src/jobs/coordinator.rs` — `CallbackIdentity`, `ClaimOutcome`, `claim_callback*`, `persist_next_job_tx`, cleanup dispatch from layout
- `backend-rust/src/jobs/recovery.rs` — lease-based staleness, lease rotation, claim release
- `backend-rust/src/routes/internal.rs` — identity headers, transition table, `/jobs/callback/cleanup`
- `backend-rust/src/page_freshness.rs` — `advance_page_input_generation`
- `backend-rust/spec/golden-openapi.json`, `frontend/src/api/schema.d.ts` — the cleanup callback and the identity headers
- `worker/src/worker/job_attempt.py` — per-attempt authority and revocation
- `worker/src/worker/rq_tasks.py` — start CAS, `JobHeartbeat`, cleanup dispatch
- `worker/src/worker/handlers/cleanup.py` — the cleanup stage
- `worker/src/worker/services/cleanup_reconstruct.py` — second CTD pass removed

## Tests

- `backend-rust/tests/stage_recovery.rs` — leased job outliving the old threshold, death before
  callback, death after commit before publication, superseded attempt after recovery, page redo
  during cleanup, an obsolete job abandoned rather than retried, deleted page
- `backend-rust/tests/internal_endpoints.rs` — the pipeline through cleanup, partial region
  failure withholding translation, retry then success, transition table, duplicate deliveries
- `backend-rust/tests/coordinator_flows.rs` — claim refusal across images
- `worker/tests/test_attempt_recovery.py` — start rejection, heartbeat bounds, revocation, progress
- `worker/tests/test_cleanup_handler.py` — sequential ordering, per-region outcomes, digest check
