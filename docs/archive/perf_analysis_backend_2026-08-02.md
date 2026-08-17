# Backend Performance Analysis — drained run `20260802-163445`

Deliverables #1, #2 and #4 of [perf_run_playbook.md](../guides/perf_run_playbook.md), from the first run
that ever **drained to idle**. Supersedes the 2026-08-01 baseline (the worker is now capped at
2 CPUs / 4 GB, so older stage timings are not comparable).

Frontend half: [perf_analysis_frontend_2026-08-02.md](perf_analysis_frontend_2026-08-02.md).

**Run:** 42 pages, 7,924 s (2 h 12 m), 255 job rows, `n_unfinished = 0` on every stage,
244 COMPLETED / 11 FAILED.

---

## 1. Method

The dispatch log line carries the job id as of 2026-08-02
(`WorkerDispatcherService`), and `JobCoordinatorService` sets `jobs.id` and the payload's
`jobId` from one UUID, so `backend.log` joins directly to `jobs.csv`. Two log lines bracket the
handoff:

```
Enqueued <type> job <id> onto queue:<q>     <- pushed to Redis
Dispatched job <id> from queue:<q> to ...   <- popped and handed to the worker
```

giving a three-way split per job:

| segment | meaning |
| --- | --- |
| `created_at → Enqueued` | DB row exists but not yet in Redis (deferred-until-commit path) |
| `Enqueued → Dispatched` | **queue wait** — sitting in Redis waiting for a slot |
| `Dispatched → updated_at` | **work** — the worker actually doing the job |

**Coverage: 255 of 255 job rows matched, 0 unmatched, 0 negative intervals.** 277 dispatch lines
for 255 jobs — the 22 extra are re-dispatches (§4, AUDIT-P4).

`created_at → Enqueued` is **0.0 s p50 for every stage** (max 3.7 s), so the deferred Redis push
is not a factor and "queue wait" below is genuine Redis queue time, not dependency lag.

---

## 2. Deliverable #1 — the per-page time budget

| stage | n | wait p50 | wait p95 | wait max | **work p50** | work p95 | work max | wait % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| layout | 42 | **591.3** | 2848.4 | 2898.8 | **0.2** | 0.6 | 12.5 | 99.9% |
| panel-detection | 42 | **195.0** | 746.1 | 796.2 | **0.3** | 1.0 | 4.2 | 99.8% |
| render | 39 | 1.2 | 8.1 | 8.4 | 1.0 | 6.6 | 39.2 | 43.5% |
| translation | 50 | 1.8 | 24.0 | 97.3 | 30.5 | 66.5 | 120.9 | 13.9% |
| ocr | 42 | 1.7 | 1.9 | 3.1 | 23.9 | 33.1 | 35.1 | 7.4% |
| qa | 39 | 1.1 | 1.6 | 1.9 | 53.8 | 106.6 | 109.5 | 1.9% |
| qa-re-ocr | 1 | 0.8 | — | 0.8 | 5.5 | — | 5.5 | 13.0% |
| **all** | **255** | | | | | | | **90.8%** |

> **49,073 s of queue wait against 4,959 s of work.** 90.8% of the total job lifetime in this
> pipeline is spent waiting for a slot.

**The open question from `perf_plan_2026-08-02.md` is answered.** `layout`'s 810 s p50 (2306 s max)
in the older data was never layout being slow — **layout takes 0.2 seconds**. It is 99.9% queue
wait. Same shape for `panel-detection`: 195 s of waiting around 0.3 s of work.

The stages that are genuinely expensive are the LLM ones, and they barely wait at all:
`qa` 53.8 s work / 1.1 s wait, `translation` 30.5 s / 1.8 s, `ocr` 23.9 s / 1.7 s.

---

## 3. Deliverable #2 — where the throughput actually goes

### 3.1 It is not the dispatcher

Starvation, measured directly from `queues.csv` (3,253 valid samples) as *slot idle **and** a queue
in that slot's class non-empty*:

| | idle | idle **with work queued** |
| --- | ---: | ---: |
| light slot | 54.5% | **3.2%** |
| heavy slot | 95.9% | **1.3%** |

The slots are idle a lot, but almost always because the queues are genuinely empty — work arrives
serially down the per-page chain. AUDIT-P3's head-of-line bug is real code, but **it did not fire in
this run.**

### 3.2 It is `MAX_LIGHT_SLOTS = 1`

From `environment.md`:

```
max_concurrent_jobs=2, max_heavy_slots=1, max_light_slots=1, reuse_idle_slots=true
```

Four light stages — `layout`, `translation`, `render`, `qa` — share **one** slot, and their costs
differ by three orders of magnitude:

| light stage | total work | share of light tier |
| --- | ---: | ---: |
| qa | 2,083 s | 52.4% |
| translation | 1,774 s | 44.6% |
| render | 96 s | 2.4% |
| layout | 24 s | 0.6% |

So a 0.2 s layout job queues behind 30–110 s LLM calls, one at a time. That is the entire
explanation for its 591 s median wait, and Little's law confirms it end to end:

```
mean layout queue depth 4.49 x 7,924 s / 42 jobs = 847 s predicted
                                    measured mean = 879 s
```

The layout queue is non-empty in **48.8%** of samples (mean depth 4.49, peak 21) while the light
slot is busy — the 3.2% starvation figure above is low precisely *because* the slot is always
occupied when layout has work.

### 3.3 The bottleneck has moved from heavy to light

| tier | total work | per page | pages/min bound |
| --- | ---: | ---: | ---: |
| heavy (`ocr`, `panel-detection`) | 982 s | 23.4 s | 2.57 |
| **light** (`qa`, `translation`, `render`, `layout`) | **3,977 s** | **94.7 s** | **0.63** |
| actual | — | 189 s | 0.32 |

**The light tier is now 4× slower than the heavy tier.** Every document in `docs/` that reasons
about throughput still assumes the opposite — that the single heavy slot bound by CPU PaddleOCR is
the floor. That was true when OCR was 13.7 s/page and QA was ~0.2 s/page; QA is now 53.8 s and
translation 30.5 s.

Headroom exists: worker CPU **mean 22.5%**, p95 191% of its 200% (2-CPU) cap. Light work is
network-bound LLM calls, not CPU.

> **The single largest available throughput lever is raising `MAX_LIGHT_SLOTS`.** It is a config
> change, not code.

---

## 4. Deliverable #4 — hypothesis results

| id | claim | verdict |
| --- | --- | --- |
| **AUDIT-W2** | global `RATE_LIMIT` is the dominant ceiling | **Falsified in practice.** All four providers in `providers.json` carry their own `rate_limits` (40/40/40/60), so the `RATE_LIMIT=10` global fallback never engages. Measured: **0.0 s of sleep across 1 sleep**. The code reading is correct; it is simply not live. |
| **AUDIT-W5** | `REUSE_IDLE_SLOTS` is dead code | **Confirmed.** `active_light` never exceeded 1 across 3,253 samples on a clean drained run, despite `reuse_idle_slots=true` on the worker. The dispatcher gate is what blocks it. |
| **AUDIT-P4** | recovery re-runs in-flight work | **Confirmed.** 277 dispatches for 255 jobs = 22 re-dispatches. 12 duplicate `(subject, type)` rows across 4 subjects; `e185e276` ran `translation`, `qa` **and** `render` 3× each. `translation` shows n=50 for 42 pages. |
| **AUDIT-P1** | wrong task keys collapse overrides to global | **Confirmed.** `isValidProviderModel` returns `false` on a null task list, and `resolveConfigForChapter` passes `"translation"`/`"qa"` where `providers.json` uses `tl`/`qaLLM`/`qaVLM`. Note this function is **not** on the dispatch path — `enqueueJobDirectly` is, and it uses the correct keys. The defect is confined to the duplicate-page comparison. |
| **AUDIT-P3** | head-of-line blocking across queues | **Not observed** (3.2% / 1.3% starvation). Real bug, currently costing nothing. |
| **AUDIT-P2 / P6** | jobs stranded in PENDING/PROCESSING | **Not observed.** 244 COMPLETED, 11 FAILED, 0 stranded. |
| backend 177% CPU spike | real or artifact? | **Transient, not a bottleneck.** Per-container: backend mean 3.8%, max 138.3%; worker mean 22.5%, max 220.7%. |
| **AUDIT-W7 / B1** | `getImageInfo` cost; scheduler pool contention | **Still unmeasured** — both need worker-side / scheduler timing that these artifacts do not carry. |

Unrelated but worth tracking: **`translation` failed 11 of 50 (22%)**, alongside 33 tracebacks in
`worker.log`. Not diagnosed here.

---

## 5. What this changes

1. **Raise `MAX_LIGHT_SLOTS`.** §3.2/§3.3. Config-only, attacks 99% of the measured wait.
2. **Do not prioritise the worker-pull model for throughput** — see
   [worker_pull_model.md](../design/worker_pull_model.md) §6.1. Pull removes the poll boundary, which is
   **408 s of the 49,058 s of queue wait (0.83%)**.
3. **AUDIT-W2 drops out of the fix order.** It was ranked "likely the single largest throughput win
   available" and is inert with the current `providers.json`.
4. **AUDIT-P4 moves up.** It is the one confirmed correctness defect actively costing work.

---

## 6. Notes on the capture tooling

- `log_signals.md` reported `Dispatched job from → 0` for this run. That is a stale regex, not
  reality — the job-id change broke the pattern. Fixed in `scripts/capture-run.sh` to
  `"Dispatched job .* from"`.
- `queues.csv` `sample_ms`: mean 177 ms, max 1729 ms — no meaningful sampler degradation.
- 159 samples have blank slot columns (backend momentarily unreachable); excluded from §3.1.
- Firefox profiles must be saved with the profiler's **download/save-to-file** button, never
  "Upload" — uploading publishes to a public Mozilla URL, and these profiles contain page titles,
  series names, URLs and (observed in the AFTER profile's markers) a JWT in the SSE stream URL.
