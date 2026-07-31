# Worker Pull Model — Design Plan

> **Status: design only — not implemented.** This document describes how the job handoff
> between the backend and the worker could move from **backend-push + fixed poll** to a
> **worker-pull** model, why it helps, the two design candidates (A primary, B backup), how
> pause/resume/clear behave in each, and a measured performance comparison.
>
> Context: the immediate fix (restoring the dispatcher poll to 2s) is already applied — see
> `docs/slot_allocation.md` §5. This doc is the next step.

---

## 1. Current model: backend push + fixed cadence

```
enqueueJob ──> Redis queue:{type}          (JobCoordinatorService, DB row = PENDING)
                     │
   @Scheduled (WORKER_POLL_MS, now 2000ms) ── WorkerDispatcherService.java:78
                     │  anyQueueHasItems()? ── /capabilities ── leftPop(queue)
                     │  POST /api/v1/jobs/submit {queue_name, job_data}
                     ▼
              Worker: submit_job ── thread ── process_job_rq ── GET metadata
                     │                                   ── PATCH PROCESSING
                     │                                   ── run handler → callback → PATCH COMPLETED
                     ▼
             slot released in finally (concurrency.py:66-78)
```

Structural costs even at a 2s poll:

1. **Poll-boundary latency** — a job that finishes in 0.3s still waits up to 2s for the next
   poll cycle before the next job is handed off.
2. **A centralized scheduler** in the handoff path — scheduled task, `/capabilities` HTTP
   polls, and the worker 429/cooldown machinery (`WorkerDispatcherService`), i.e. a single
   point of failure and extra HTTP hops per job.

Pull inverts this: **the worker asks for work when it has a free slot**, making handoff
event-driven and removing the scheduler from the critical path.

---

## 2. Why pull, and what it does NOT fix

- **Throughput win is modest on this device (~10–25% over the 2s poll).** The single heavy
  slot is the floor: OCR runs ~13.7s/page on CPU, so the heavy tier can only do ~4 pages/min
  regardless of handoff speed. Pull removes poll-boundary *waiting*, not slot *occupancy*.
- **Real wins:** sub-second tail latency for interactive use, no dispatcher (fewer moving
  parts, no single point of failure), no `/capabilities` + cooldown logic, natural
  multi-worker distribution (Redis `BRPOP` is atomic across consumers), and throughput that
  auto-scales if heavy slots are raised later.
- **The true throughput unlock beyond ~4 pages/min is parallelizing the heavy tier**
  (multi-GPU `MAX_HEAVY_SLOTS`, or GPU PaddleOCR instead of CPU) — out of scope here.

---

## 3. Option A — Worker pulls Redis directly (recommended)

### 3.1 Slot consumers

The worker already owns the slot types and the priority order as constants
(`worker/src/worker/concurrency.py:36-49`), and it already has a Redis/Valkey client (used
for locks, config, etc.). Each worker runs **two slot-consumer threads**, gated by
`MAX_HEAVY_SLOTS` / `MAX_LIGHT_SLOTS` / `CONCURRENT_JOBS`:

- **Heavy consumer** (bound to one heavy slot):
  `BRPOP queue:qa-re-ocr queue:region-redo-ocr queue:ocr queue:panel-detection`
- **Light consumer** (bound to one light slot):
  `BRPOP queue:region-redo-tl queue:qa queue:render queue:translation queue:layout`

`BRPOP` tries keys in order (key order = priority, identical to today's
`WorkerDispatcherService.HEAVY_QUEUES` / `LIGHT_QUEUES`), blocks when all are empty, and is
atomic — two workers never receive the same job, so cross-worker fairness is free. On a
2–5s timeout it re-checks `system:queue:paused` and loops (see §5.1).

### 3.2 Job execution (unchanged)

The popped payload is the exact JSON the dispatcher previously read. Feed it straight to the
existing `process_job_rq(queue_name, job_data)` (`worker/src/worker/rq_tasks.py:63`), whose
built-in guards all still apply:

- pre-flight `GET /jobs/{id}` — skip if 404 (deleted/cancelled) or status ≠ `PENDING`
  (`rq_tasks.py:69-84`);
- `check_stale_job` — skip if the image no longer exists;
- PATCH `PROCESSING` → run handler → callback → PATCH `COMPLETED`.

### 3.3 What is deleted / disabled

- `WorkerDispatcherService` (scheduled dispatch, `/capabilities`, worker cooldown map) —
  disabled via a `WORKER_PULL_ENABLED` flag during rollout, removed after.
- The `WORKER_POLL_MS` knob (no longer meaningful).

### 3.4 What stays the same

- `enqueueJob` → Redis `queue:{type}` push (`JobCoordinatorService.java:465`); the queues
  remain the source of truth for *pending* work.
- The DB `Job` state machine, attempt tracking, orphan recovery.
- Global pause flag, `requeuePendingJobs()`, per-job pause/resume/delete controllers.
- Worker slot accounting (`concurrency.py`) and all handlers.

### 3.5 New piece: fast crash recovery (lease/heartbeat)

Today a 5-minute backend sweeper requeues jobs stuck in `PROCESSING` for >10 min
(`JobCoordinatorService.recoverStaleProcessingJobs`, `:128`). In a pull model a worker that
dies mid-job strands the job (BRPOP already removed it). Add:

- Worker sets a lease at pull time: `SET lease:{jobId} {workerId} EX 60`, refreshed every
  ~30s for long jobs (OCR).
- A backend sweep (extend the existing one, or new, every ~30s) requeues any job whose DB
  status is `PENDING`/`PROCESSING` with no fresh lease → `attempt++` via the existing
  `updatePayloadAttempt` path (`JobCoordinatorService.java:117`). Max-attempt handling stays.

---

## 4. Option B — Worker pulls a backend endpoint (backup)

If Option A is judged too invasive, a lower-risk alternative keeps job ownership in the
backend:

- New backend endpoint `POST /api/v1/jobs/pull` `{slot: heavy|light}` → backend pops from the
  priority-ordered queue and returns `{queue_name, job_data}`, or long-polls ~5s (via
  `CompletableFuture` + an enqueue notifier) when empty.
- Backend keeps priority ordering, pause, attempt-tracking, and orphan recovery; the worker
  keeps slot accounting. Existing `dispatchFromSlot` logic is largely reused, inverted.
- Costs: backend stays in the handoff path; long-polling adds Spring machinery; a second
  round-trip per job versus direct Redis.

**Recommendation: Option A.** It removes a whole service, the priority/slot constants already
live in the worker, `BRPOP` gives cross-worker atomicity, and handoff is genuinely
sub-second. Keep B as a fallback if per-worker Redis access or BRPOP semantics are
unacceptable.

---

## 5. Pause / resume / force-clear semantics

All three operations are **backend-owned** (DB rows + Redis flags/keys in `JobController`),
so they keep working in the pull model — with a few worker-side gates.

### 5.1 Global pause (`POST /api/jobs/pause`)

Today: sets `system:queue:paused=true` (`JobController.java:34,56-62`); the dispatcher skips
its cycle, and `enqueueJob` holds new jobs in the DB without pushing
(`JobCoordinatorService.java:442`).

**Option A:** the check moves into the slot-consumer loop — read `system:queue:paused` before
each `BRPOP`; if `true`, block (sleep + re-check ~1s) instead of popping. Enqueue path
unchanged (jobs pile up in the DB while paused).

**The one race:** pause can be set *between* the flag check and the `BRPOP`, so the worker
pops one job after pause. Fix = check-then-act with a compensating push:

```
1. GET system:queue:paused  -> if "true", block
2. BRPOP queue:...
3. GET system:queue:paused again -> if "true": RPUSH job back, block
```

(An alternative is a Redis pub/sub `queue.paused` signal the worker subscribes to, but the
re-check is simpler.)

### 5.2 Global resume (`POST /api/jobs/resume`)

Sets the flag to `false` and calls `requeuePendingJobs()` — DELs all Redis queues, re-pushes
every DB `PENDING` job. Unchanged in Option A.

**Race note:** the resume `DEL` can race a worker that already `BRPOP`ed a job, briefly
producing two copies in the system. This **self-heals**: the worker pre-flight
`GET /jobs/{id}` makes the second puller see `PROCESSING` and skip (`rq_tasks.py:81-84`),
so no duplicate execution — the same safety net the push model already relies on.

### 5.3 Per-job pause/resume (`POST /api/jobs/{id}/pause|resume`)

Works **unchanged** with identical semantics to today:

1. Pause only accepts `PENDING` jobs (`JobController.java:158`), flips DB to `PAUSED`. The
   job is still sitting in the Redis queue.
2. Worker `BRPOP`s it, pre-flight sees `PAUSED` → skips (no PATCH). The job drains from the
   queue and stays `PAUSED` in the DB.
3. Resume flips back to `PENDING` and re-pushes to Redis (`JobController.java:187`).

Same as today, with `BRPOP` replacing `leftPop` + POST. Cost: one wasted pull per paused job.
(Optional improvement: make `pauseJob` `LREM` the payload out of its queue so paused jobs
never reach a consumer.)

### 5.4 Force clear (`DELETE /api/jobs/clear?force=true`)

Deletes DB rows for `PENDING/PAUSED/FAILED/PROCESSING` and `DEL`s the 10 Redis queue keys
(`JobController.java:73-115`).

- **PENDING/PAUSED/FAILED:** trivially fine — rows gone, queues empty, consumers `BRPOP`
  into empty lists.
- **PROCESSING (force=true): pre-existing gap in BOTH models.** Force-clear deletes the DB
  row, but the worker is already *executing* that job. It keeps running, its final
  `PATCH status` hits a deleted row (404, silently swallowed), and its **callback can still
  re-enqueue downstream jobs**, resurrecting a pipeline that was just cleared (callbacks in
  `JobCoordinatorService` enqueue purely by `imageId`, which force-clear does not delete).

**Recommended fix (shared, do it regardless of push/pull):** a **cancellation tombstone** —
on force-clear set `cancelled:{imageId}` (TTL ~1h) in Redis, and have both the worker's
pre-flight check *and* the backend callbacks (`handlePanelCallback`, `handleOcrCallback`,
…) consult it and bail. In the pull model the worker's existing pre-flight
`GET /jobs/{id}` (404 → skip) is the one built-in protection that stays.

---

## 6. Performance: 30s poll vs 2s poll vs worker-pull

Measured phase durations (`logs/run-3-fresh.log`, 304 pages, CPU PaddleOCR):

| Phase | Actual processing | 30s poll wait | 2s poll wait | pull wait |
| :--- | :---: | :---: | :---: | :---: |
| panel-detection | 0.3s | up to 30s | up to 2s | ~0s |
| ocr | 13.7s avg | up to 30s | up to 2s | ~0s |
| layout | 0.7s | up to 30s | up to 2s | ~0s |
| translation | 7.4s avg | up to 30s | up to 2s | ~0s |
| render | 2.7s | up to 30s | up to 2s | ~0s |
| qa | ~0.2s | up to 30s | up to 2s | ~0s |

| Metric | 30s poll (before) | 2s poll (applied) | worker-pull |
| :--- | :---: | :---: | :---: |
| Single-page chain latency | ~2.5–3 min | ~30 s | ~25 s |
| Steady-state throughput | ~0.5 pages/min | ~3.8 pages/min | ~4.3 pages/min |
| 50 pages | ~2 h | ~13 min | ~12 min |
| 304 pages (run-3) | ~10.3 h (measured) | ~75 min | ~70 min |

Notes:

- The 2s poll captures ~85–90% of the pull-model benefit on this device; the rest is
  poll-boundary granularity.
- Throughput is heavy-slot-bound (`ocr` 13.7s + `panel-detection` 0.3s ≈ 14s/page).
  Pull-model headroom (light tier ~11s/page) is mostly absorbed by `REUSE_IDLE_SLOTS`
  borrowing the idle heavy slot.
- Pull's qualitative wins — latency, no single point of failure, multi-worker scaling —
  do not show in the throughput column.

---

## 7. Rollout

1. Ship Option A behind `WORKER_PULL_ENABLED` (default off). Workers start pulling while the
   dispatcher still runs, so behavior is unchanged until the flag flips.
2. Flip on per-worker; verify queue depths, `PROCESSING` transitions, and the lease sweeper
   on a small run.
3. Implement the cancellation tombstone (§5.4) either before or together with the flip.
4. Remove/disable `WorkerDispatcherService` and the `WORKER_POLL_MS` knobs once stable.

---

## 8. Open decisions

- Pause signal: flag re-check (chosen) vs pub/sub signal.
- Lease TTL / sweep cadence for crash recovery (60s lease, 30s sweep suggested).
- Whether per-job pause should `LREM` from the queue (optimization) or keep the
  pull-and-skip handshake.
- Backend endpoint to expose for observing pulled/in-flight jobs during rollout.
