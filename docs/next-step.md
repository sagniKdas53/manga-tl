# Handoff — analysing the post-W10 benchmark run

> **SUPERSEDED IN PART, 2026-08-03 — read
> [immediate-next-steps.md](./immediate-next-steps.md) first.** This analysis was carried out. Of
> the six predictions below: **#1 failed** (the slot change was never in force — `.env` overrode the
> compose default), **#5's metric is invalid** (`duplicate_jobs.csv` counts QA retry cycles, and the
> run had zero re-dispatches so AUDIT-P4's path never ran), and **#6 passed** (translation failures
> 11/50 → 0/9). **#2 was later confirmed** on `20260803-103311` — `layout` p50 150.64 s → 2.65 s.
> **#3 and #4 remain untested** and need one clean drained run at the now-correct `4/1/3`.
> The baseline numbers and working constraints below are still accurate and still worth reading.
>
> ---
>
> Written 2026-08-03. **Purpose: a single comparison.** The 2026-08-02 batch changed the slot
> configuration and three correctness paths; none of it is measured yet. This file exists so the
> next session can walk into the numbers without re-deriving the codebase or the baseline.
>
> **Read first:** [issues.md § Status of the fix order](./issues.md#status-of-the-fix-order--2026-08-02),
> [perf_analysis_backend_2026-08-02.md](./perf_analysis_backend_2026-08-02.md),
> [perf_run_playbook.md](./perf_run_playbook.md) § "Re-running for comparison".
>
> **Do not re-audit the codebase.** The ~50 `AUDIT-*` findings in
> [issues.md](./issues.md#full-stack-audit--2026-08-01) already carry `file:line` anchors.

## What changed since the baseline

| | |
| --- | --- |
| **W10 / W6** | `CONCURRENT_JOBS=5 / MAX_HEAVY_SLOTS=1 / MAX_LIGHT_SLOTS=4` (was `2 / 1 / 1`). `resolve_slot_config` clamps degenerate combinations and logs each adjustment. **This is the change under test.** |
| **P4** | `jobs.callback_applied_at` + `JobRepository.claimCallback` — a conditional UPDATE making check-and-set atomic, so a duplicate run is dropped at the callback instead of writing a second region set, layer and cost. |
| **P1 / W1** | `resolveConfigForChapter` passes `tl` / `qaLLM` / `qaVLM`; QA's four hardcoded provider chains replaced by `_qa_cloud_llm` / `_qa_cloud_vlm`. |
| **S1–S4** | No secret fallbacks, startup validation, SSE tickets instead of `?token=`. Not perf-relevant, but it is new surface in the same deploy — see "Regression watch". |
| **`neurometric` key** | Replaced 2026-08-03. The baseline's 22% translation failure was 401 × 323 from one dead credential. |
| **Reader race** | A `job_update` landing while page details were in flight no longer swallows the refresh (`c4d092d`). |

## The baseline, so you don't re-derive it

Run `20260802-163445` — 42 pages, 255 jobs, 7,924 s, 100% dispatch-log coverage.

- **90.8% of total job lifetime was queue wait** — 49,073 s waiting vs 4,959 s working.
- `layout`: **p50 wait 591 s** around **0.2 s** of work. Little's law reconciled to within 4%
  (depth 4.49 × 7,924 s ÷ 42 jobs = 847 s predicted, 879 s measured).
- Light tier **94.7 s/page** (0.63 pages/min) vs heavy **23.4 s/page** (2.57 pages/min) — the light
  tier was **4× slower** and the heavy slot idle **95.9%** of the time.
- Light stage totals: `qa` 2,083 s (p50 53.8 s) · `translation` 1,774 s (p50 30.5 s) ·
  `render` 96 s (p50 1.0 s) · `layout` 24 s (p50 0.2 s).
- `active_light` **never exceeded 1** across 3,253 samples.
- **277 dispatches for 255 jobs** (22 re-dispatches); 12 duplicate `(subject, type)` rows across
  4 subjects; `e185e276` ran `translation`, `qa` **and** `render` 3× each.
- `translation` failed **11 of 50 (22%)**; 323 × HTTP 401 from `neurometric`.
- Starvation (slot idle with work queued in its own class): **3.2% light / 1.3% heavy**.
- Worker CPU mean **22.5%** (p95 191% of its 200% cap); backend CPU **3.8%**.
- Rate limiting: **0.0 s of sleep across 1 sleep** in 7,924 s (AUDIT-W2 is inert).

## Predictions, in the order they should be checked

Each is falsifiable. **If #1 fails, nothing below it means anything** — stop and fix the config.

1. **`active_light` must exceed 1** in `queues.csv`. The baseline never did. If it still doesn't,
   the slot change did not take effect: check `environment.md` for the values actually in force and
   the worker startup log for AUDIT-W6 clamp messages. Everything else is downstream of this.
2. **`layout` p50 wait collapses** from 591 s. It does 0.2 s of work; it was queued behind 30–110 s
   LLM calls purely because they shared one slot.
3. **Queue wait falls well below 90.8%** of job lifetime.
4. **The tiers converge.** Four light slots put the light ceiling near 23.7 s/page against heavy's
   23.4 s/page, so **the floor should move back to the heavy tier** — the state every throughput
   argument in `docs/` assumed before the baseline falsified it. If light is *still* the floor, the
   slots are not the whole story and the next question is AUDIT-W3 (a light job blocking on a
   cooldown or lock holds a slot, which matters more with four of them, not less).
5. **`duplicate_jobs.csv` is empty** — and note this is *not* the same as re-dispatches going away.
   `claimCallback` works at the callback layer, so **22-ish re-dispatches with zero duplicate rows
   is the expected shape and is the proof the fix works.** Cross-check the row deltas in
   `db_counts_before/after.csv`. If duplicates persist, the claim is not covering every callback
   path.
6. **`translation` failures drop to ~0.** If they don't, the 22% was never only the key — pull the
   new tracebacks before assuming anything.

## What the extra concurrency might break

Two effects the baseline could not show, because nothing ran concurrently:

- **Provider rate limits may start to engage.** Four concurrent light jobs means up to four
  concurrent LLM calls per provider. `providers.json` carries `rate_limits` (openrouter 40,
  cloudflare 40, nvidia 40, neurometric 60) and the baseline measured **0.0 s of sleep**. If
  `log_signals.md` now shows real sleep seconds, the win is partly being handed back — and per
  AUDIT-W3 that sleep happens *while holding a job slot*.
- **UI contention gets worse.** 71% of the browser's LongTask wall was already the main thread
  descheduled on this 4-core box, with containers at p95 204% of 400%. Worker CPU was 22.5% mean
  with headroom, so the cost should be modest — but if the UI degrades, **cap the worker's CPU
  rather than reverting the slot change.** That is the documented decision, not a fresh judgement
  call.

## Regression watch (same deploy, not the variable under test)

- **SSE**: tickets replaced `?token=`. Notifications and the queue feed should behave exactly as
  before; a silent SSE failure would look like "the queue stopped updating".
- **Reader refresh**: the "New layers available — refreshed" toast now actually refreshes, including
  when a job completes while the page is still loading. Worth one manual check during the run.
- **AUDIT-W5**: `REUSE_IDLE_SLOTS` should still never fire — the dispatcher gates on `maxLight`.
  `active_light > 4` would mean it did.

## Explicitly out of scope for this session

- **AUDIT-F6/F7/F8** (deferred by decision 2026-08-03, not yet written into `issues.md`): the
  QueueManager stale-poll revert (`QueueManager.tsx:374-386`, `>=` on `createdAt` lets an in-flight
  poll overwrite a newer SSE status), the ChapterGallery cross-chapter `setPages` write
  (`ChapterGallery.tsx:194-199`), and the negative-assertion-inside-`waitFor` in
  `Reader.test.tsx:386` that cannot fail.
- **AUDIT-W11** — a chapter pinned to a dead provider gets no cross-provider fallback.
- **The worker pull model.** Measured at 408 s of 49,058 s of queue wait (0.83%). Build it for
  latency and multi-worker scaling, never for throughput, and not before this run is read.
- **AUDIT-S\*** — security is tracked separately, don't fold it in.

## Working constraints

- **`CLAUDE.md` is binding.** `impact({target, direction:"upstream", repo:"manga-library"})` before
  editing any symbol, report HIGH/CRITICAL, `detect_changes()` before committing. Note that
  `detect_changes` attributes by line offset, so a large insertion will flag untouched symbols
  below it — check hunk ranges before believing the blast radius.
- **One performance variable per change.** The delta has to be attributable.
- **Backend API changes** require `npm run generate-api` from `frontend/` with the backend container
  up. The frontend compiles *into* the backend image (`backend/Dockerfile:26`), so any frontend
  change needs `docker compose build backend && docker compose up -d backend`.
- **`worker/` is a git submodule** (`manga-tl-worker`). Changes there need their own commit plus a
  pointer bump in the parent.
- **Never upload Firefox profiles.** Use the profiler's save-to-file button — uploading publishes to
  a public Mozilla URL, and these profiles carry series names and URLs.
- Backend build is Maven (`mvn -o compile`, no wrapper). `PipelineFlowIntegrationTest` is the guard
  for pipeline/config changes; ~80–180 s.

## Prompt for the next chat

<!-- markdownlint-disable MD031 MD040 -->

```
Comparison analysis of a pipeline run recorded after the AUDIT-W10 slot change.

Read docs/next-step.md first — it has the baseline numbers, the six predictions to
test in order, and what is out of scope. Do not re-audit the codebase; the findings
are in docs/issues.md under "Full-Stack Audit — 2026-08-01".

New run:      logs/runs/<TIMESTAMP>/
Baseline run: logs/runs/20260802-163445/

WHAT I WANT

1. Walk the six predictions in docs/next-step.md in order, with the number that
   settles each. Start with active_light > 1 — if that failed, stop and tell me the
   config did not take effect.

2. stage_summary.csv new vs baseline, per stage: n / p50 / p95 / total. Then the
   queue-wait split — is it still ~90% of job lifetime, and which tier is the floor
   now?

3. Tell me plainly if any prediction is falsified. I would rather delete a wrong
   model of the system than fix the wrong thing. In particular: if the light tier is
   still the floor with four slots, say so and say what the next measurement is.

4. Check the two second-order effects: rate-limit sleep seconds in log_signals.md
   (baseline 0.0s), and worker/container CPU in resources.csv against the 4-core box.

5. Rank whatever remains by measured payoff — "N seconds per page, M lines to fix" —
   not by severity label.

CONSTRAINTS
- One performance variable per change.
- CLAUDE.md is binding: impact() before edits, detect_changes() before commits.
- Security findings (AUDIT-S*) are tracked separately; don't fold them in.
```

<!-- markdownlint-enable MD031 MD040 -->
