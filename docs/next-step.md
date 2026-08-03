# Handoff — state at end of 2026-08-03

> Consolidates the former `immediate-next-steps.md`, which is now deleted. Everything still live
> is below; everything settled is recorded as settled so it does not get re-litigated.
>
> **Resume at:** [§ What to do next](#what-to-do-next) — AUDIT-W5, then a clean drained run.

## Where the work stands

**The 7-item reader plan is complete except item 7.** Items 1–6 shipped and are deployed:

| item | outcome |
| --- | --- |
| 1. Reader-sized variant | **Done.** Stored WebP at q90, native resolution. 1.142 GB → 0.266 GB. See [comparison.md](./comparison.md). |
| 2. Cacheable images | **Done.** `max-age=31536000, public, immutable` + `ETag` + real `Content-Length` on `/reader`, `/file`, `/thumbnail`. |
| 3. Overlay gate | **Done.** Geometry in `4f40d39`; visibility now gates on the image having loaded. |
| 4. Native `<img>` | **Done.** Blob path deleted; `utils/authImage.ts` replaced by `utils/readerImage.ts`. |
| 5. Deprioritise prefetch | **Done.** Forward-biased, `fetchPriority="low"`, waits for the current image, persisted slider (default 3, 0 disables). |
| 6. Widen details cache | **Done.** 15-entry LRU over a `Map`, replacing the hard ±2 eviction. |
| 7. Lend the idle heavy slot | **NOT STARTED** — see [§ AUDIT-W5](#audit-w5--corrected). |

Also shipped 2026-08-03: **AUDIT-B6** (`WEBP_LOCK` scoped to WebP only, so the 4-thread
`thumbnailExecutor` no longer serialises every decode), and both image backfills deleted after
running to completion.

## What to do next

**1. AUDIT-W5 — lend the idle heavy slot.** Backend-only, one performance variable, wants its own
run. Measured payoff: **13.0%** of 391 samples in `20260803-103311` had light at its cap of 3,
heavy idle, light work queued, and no heavy work at all.

**2. Then one clean drained run at 4/1/3** to settle predictions 2–4 below, following the prompt at
the bottom. The reader work is done, so reader traffic no longer contends with queue traffic — the
thing that made `20260803-103311` noisy.

### AUDIT-W5 — corrected

**The description carried in the old handoff was wrong and cost time. Corrected 2026-08-03 by
reading the code:**

- The old note said *"`REUSE_IDLE_SLOTS` is never read"*. **It is read** — `worker/src/worker/main.py:206`.
  The worker's admission control already accepts a light job beyond `MAX_LIGHT_SLOTS` when
  `REUSE_IDLE_SLOTS` is set (default `true`) and `ACTIVE_JOBS < MAX_CONCURRENT_JOBS`.
- The method is `WorkerCapacity.hasLightSlot()`, not `hasLightCapacity()`
  (`WorkerDispatcherService.java:334`).

So the worker would accept a lent slot today. **The blocker is entirely on the backend dispatcher**,
which never offers one:

```java
boolean hasLightSlot() {
  return activeLight < maxLight && activeTotal < maxTotal;   // :334-336
}
```

Gated at `WorkerDispatcherService.java:180` (`if (!isHeavy && !cap.hasLightSlot()) continue;`). With
`maxLight = 3`, a fourth light job is never dispatched even when the heavy slot is idle and
`activeTotal < maxTotal`. **This is a one-condition change on the backend side, and the worker
already supports the other half** — which is a materially smaller job than the old note implied.

## Settled — do not re-litigate

The six predictions from the original post-W10 analysis:

| prediction | outcome |
| --- | --- |
| 1. `active_light > 1` | **FAILED then fixed.** `.env` pinned `CONCURRENT_JOBS=2`, overriding the compose default, so that run measured baseline 2/1/1. Now `4/1/3` and confirmed in force. |
| 2. `layout` p50 wait collapses | **CONFIRMED** on `20260803-103311`: 150.64 s → 2.65 s. |
| 3. Queue wait ≪ 90.8% | **Superseded** by the 80%-utilisation finding below. Still worth one clean number. |
| 4. Tiers converge | **STILL UNTESTED.** Needs the clean run. |
| 5. `duplicate_jobs.csv` empty | **METRIC INVALID.** Its rows are QA retry cycles (sequential, same `trace_id`, `attempt=1`, all 42 callbacks claimed), and the run had zero re-dispatches, so AUDIT-P4's path never ran. Neither confirmed nor refuted. |
| 6. Translation failures → 0 | **PASSED.** 11/50 → 0/9. The dead `neurometric` key was the whole 22%. |

### Measurements worth not re-deriving

- **Utilisation is 80%**, not 10%: work 1150.9 s against 1444 s wall. Perfect scheduling recovers at
  most ~20% of wall — **reducing work beats reordering it**, and 450 s (39%) of that work was QA
  re-translation cycles that fixed nothing.
- **Reader, pre-WebP**: 20 distinct images, 20 fetches (1.00×) — the blob cache was never the
  problem. Image p50 **706 ms**, p95 **2482 ms** (the 5 slowest were the startup prefetch storm,
  5 images within 25 ms). 27.3 MB for 20 pages at **0.2–1.9 MB/s** over Tailscale. Details refetch
  **1.75×**. *Items 1/5/6 all target numbers on this line — it is the before-picture for the next
  reader profile.*
- **Image corpus**: 743 images, **550 JPEG / 162 PNG / 31 WebP by decoded format** (the old
  extension-based 522+27/163/31 mislabels at least one file). 1.14 GB, width p50 1806.
- **Baseline run `20260802-163445`** — 42 pages, 255 jobs, 7,924 s: 90.8% of job lifetime was queue
  wait; `layout` p50 wait 591 s around 0.2 s of work; light tier 94.7 s/page vs heavy 23.4 s/page;
  `active_light` never exceeded 1 across 3,253 samples; 277 dispatches for 255 jobs; worker CPU mean
  22.5%; **0.0 s of rate-limit sleep** across 7,924 s (AUDIT-W2 inert).

## Still open, verified present 2026-08-03

- **AUDIT-W12 [H]** (`issues.md`) — confirm QA actually emits `escalation` / `directFix`. Committed
  but never verified against a live provider. Until `escalation.needsReOcr` arrives, every QA
  failure routes to a blind re-translation of unreadable OCR: **450 s across 4 wasted cycles on 5
  pages, 39% of all work**. Three greps on the next run settle it. The `qa-re-ocr` dispatch path
  exists and is correct — it has simply never fired.
- **AUDIT-F6** — `QueueManager.tsx:378` still uses `>=` on `createdAt`, so an in-flight poll can
  overwrite a newer SSE status.
- **AUDIT-F7** — `ChapterGallery.tsx:194-199` still calls `setPages` after upload with no guard that
  `selectedChapter` hasn't changed meanwhile.
- **AUDIT-F8** — the negative assertion inside `waitFor` is still there, now at
  `Reader.test.tsx:501-505` (was 386). `waitFor` retries until the callback passes, and
  `not.toBeInTheDocument()` passes on the first tick, so the test cannot fail.
- **AUDIT-W11** — a chapter pinned to a dead provider gets no cross-provider fallback.
- **Unmatched `/api/**` paths return 200**, not 404: `ForwardController` catches them and forwards
  to `/error`.
- **The ZIP export is unverified.** `handleExportPng` / `handleExportZip` were repointed at `/file`
  so `original.png` stays the original, and `/file` was confirmed to still serve untouched bytes —
  but nobody has opened an exported ZIP and checked. Silent failure mode; worth one click.
- **No automated test for the prefetch gate.** The invariant "nothing prefetches before the current
  image loads" is exactly the kind that regresses quietly.

### Correction to the old Step B note

The old handoff said `handleExportRenderedPng` draws from `imgRef.current`. **It does not** — it
fetches `/api/pages/{id}/rendered` from the server and was never at risk. The two that did draw from
the displayed element are `handleExportPng` and `handleExportZip`.

## Out of scope unless deliberately reopened

- **The worker pull model.** Measured at 408 s of 49,058 s of queue wait (0.83%). Build it for
  latency and multi-worker scaling, never for throughput.
- **AUDIT-S\*** — security is tracked separately, don't fold it in.
- **A reader downscale cap.** Measured: a 3000 px long-edge cap hits 124 images and saves a further
  46 MB (0.241× → 0.200×). Real but secondary, and a second performance variable.

## Working constraints

- **`CLAUDE.md` is binding.** `impact({target, direction:"upstream", repo:"manga-library"})` before
  editing any symbol, report HIGH/CRITICAL, `detect_changes()` before committing.
  **`detect_changes` attributes by line offset**, so a large insertion flags untouched symbols below
  it — check hunk ranges before believing the blast radius, and **reindex first**
  (`node .gitnexus/run.cjs analyze`); a stale index is the main source of false HIGH/CRITICAL.
- **One performance variable per change.** The delta has to be attributable.
- **Commit straight to `main`** — no feature branches for this project.
- **`.env` is gitignored and overrides `docker-compose.yml` defaults.** This is how the W10 change
  was missed for a day. Verify with
  `docker compose config | grep -E 'CONCURRENT_JOBS|MAX_(HEAVY|LIGHT)_SLOTS'` before trusting a run.
  Current: `CONCURRENT_JOBS=4 / MAX_HEAVY_SLOTS=1 / MAX_LIGHT_SLOTS=3`.
- The frontend compiles **into** the backend image, so any frontend change needs
  `docker compose build backend && docker compose up -d backend` (~10 min).
- Backend API changes require `npm run generate-api` from `frontend/` with the backend container up.
- **`worker/` is a git submodule.** Changes need their own commit plus a pointer bump in the parent.
- Backend build is Maven (`mvn -o compile`, no wrapper).
- **Testcontainers is currently broken on this box** — `SecurityConfigTest`,
  `PipelineFlowIntegrationTest`, `SchemaValidationTest` and the repository tests all fail on Ryuk /
  Redis connection errors. Confirmed environmental: reproduced on a clean tree with all changes
  stashed, and persists both outside the sandbox and with `TESTCONTAINERS_RYUK_DISABLED=true`.
  Unit tests are unaffected. **Fix this before trusting a green backend suite.**
- **MinIO objects are readable straight off disk** — no container, no port 9000. Single-drive MinIO
  prefixes a 32-byte bitrot checksum to each 1 MiB block; strip those and the bytes come back
  verbatim. Handle three layouts: single-part, multi-part (`part.1..N`, numeric order), and small
  objects inlined into `xl.meta` as a trailing msgpack `bin32`. Verified against all 743 ETags.
- **Never upload Firefox profiles** — use save-to-file; they carry series names and URLs.

## Prompt for the next chat

<!-- markdownlint-disable MD031 MD040 -->

```
Continuing manga-library performance work. Read docs/next-step.md first — it has
what shipped, what is settled, and what is still open. Do not re-audit the codebase
and do not re-derive the run numbers; both are written down. The ~50 AUDIT-* findings
in docs/issues.md carry file:line anchors.

WHAT I WANT

1. AUDIT-W5 first: lend the idle heavy slot. Read the corrected description in
   next-step.md — the worker already honours REUSE_IDLE_SLOTS, so the change is on
   the backend dispatcher's hasLightSlot() alone. One variable, its own commit.

2. Then a clean drained run at 4/1/3 and walk predictions 2-4:
   - stage_summary.csv new vs baseline 20260802-163445, per stage: n / p50 / p95 / total
   - the queue-wait split — still ~90% of job lifetime, and which tier is the floor now?
   - if the light tier is STILL the floor with slots lent, say so and say what the
     next measurement is. AUDIT-W3 is the next suspect.

3. Check two second-order effects: rate-limit sleep seconds in log_signals.md
   (baseline 0.0s), and worker/container CPU in resources.csv against the 4-core box.
   If the UI degrades, cap the worker's CPU rather than reverting the slot change —
   that is the documented decision, not a fresh judgement call.

4. Settle AUDIT-W12 with the three greps listed in issues.md — does QA actually emit
   escalation/directFix now?

5. Rank whatever remains by measured payoff — "N seconds per page, M lines to fix" —
   not by severity label.

Tell me plainly if any of this is falsified once measured. I would rather delete a
wrong model of the system than fix the wrong thing.

CONSTRAINTS
- CLAUDE.md is binding: reindex, impact() before edits, detect_changes() before commits.
- Commit to main directly.
- One performance variable per change.
- Security findings (AUDIT-S*) are tracked separately; don't fold them in.
```

<!-- markdownlint-enable MD031 MD040 -->
