# Handoff — state at end of 2026-08-04

> Consolidates the former `immediate-next-steps.md`, which is now deleted. Everything still live
> is below; everything settled is recorded as settled so it does not get re-litigated.
>
> **Resume at:** [§ What to do next](#what-to-do-next). Both the performance thread and the
> correctness list are closed; what remains is the transitioning-state change and one deferred
> cleanup.

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
| 7. Lend the idle heavy slot | **WON'T DO** — measured at 1.8%, and probably the wrong fix. See [§ AUDIT-W5](#audit-w5--corrected). |

Also shipped 2026-08-03: **AUDIT-B6** (`WEBP_LOCK` scoped to WebP only, so the 4-thread
`thumbnailExecutor` no longer serialises every decode), and both image backfills deleted after
running to completion.

Shipped 2026-08-04, both render-geometry fixes — see [§ 2026-08-04](#2026-08-04--render-geometry).

## The performance thread is closed

Nothing on the performance side is worth picking up next, and two things that looked worth picking
turned out not to be.

**AUDIT-W5 fell from 13.0% to 1.8%** on re-measurement, and the remaining 1.8% probably would not be
recovered by lending the slot anyway. It is marked WON'T DO rather than NOT STARTED.

**The huge `layout` and `panel-detection` numbers are an attribution artefact, not a stall.** In
`20260803-211221` those two stages carry 8,683 s and 6,550 s of a 1,457 s wall — 88% of all stage
time between them, against `ocr` 578 s and `render` 172 s. That is not work. Those two stages sit
immediately before the expensive ones, so a job created early accrues its whole wait under the stage
it was last in. The 2-job run makes it plain: `layout` p50 is **1.8 s** there and **179 s** in the
30-job run, and per-item cost cannot move 100x.

- **The remedy is categorisation, not scheduling.** Move a waiting job to a *transitioning* state
  instead of leaving it labelled with the last stage it completed, so the nature of the wait is
  visible. This is an observability change — **it will not move wall time**, and it should not be
  filed or measured as a performance item.
- Corollary: do not re-derive "queue wait is 90% of job lifetime" as though it were a finding. It is
  the same artefact seen from the other side.

**AUDIT-W2 got another data point and stays inert**: 16.9 s of rate-limit sleep across 13 sleeps in
1,457 s of wall (1.2%), consistent with the 0.0 s baseline.

### AUDIT-W5 — corrected

**The description carried in the old handoff was wrong and cost time. Corrected 2026-08-03 by
reading the code:**

- The old note said *"`REUSE_IDLE_SLOTS` is never read"*. **It is read** — `worker/src/worker/main.py:206`.
  The worker's admission control already accepts a light job beyond `MAX_LIGHT_SLOTS` when
  `REUSE_IDLE_SLOTS` is set (default `true`) and `ACTIVE_JOBS < MAX_CONCURRENT_JOBS`.
- The method is `WorkerCapacity.hasLightSlot()`, not `hasLightCapacity()`
  (`WorkerDispatcherService.java:334`).

**Superseded 2026-08-04 — do not implement.** Re-measured payoff is **1.8%**, not 13.0%, and at that
size the change is probably aimed at the wrong thing. The description below is kept because it is
accurate about the code, and because the next person to read "AUDIT-W5" in `issues.md` needs to find
the reason it was dropped rather than re-deriving it.

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
| 3. Queue wait ≪ 90.8% | **SETTLED 2026-08-04.** And re-read: the queue-wait share is an attribution artefact, not a scheduling loss. See [§ The performance thread is closed](#the-performance-thread-is-closed). |
| 4. Tiers converge | **SETTLED 2026-08-04** on `20260803-211221`. |
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

## What to do next

**The correctness list is empty.** Everything that was open on the morning of 2026-08-04 is
closed — see [§ 2026-08-04 — correctness sweep](#2026-08-04--correctness-sweep). What is left is
one deliberate piece of work and one deferred cleanup:

1. **Move a waiting job to a *transitioning* state** rather than leaving it labelled with the stage
   it last completed. Observability, **not** performance — see the closed-thread section. It makes
   the wait legible; it will not make anything faster. Note `getDisplayStatus` already renders
   `COMPLETED` as `TRANSITIONING...` (`QueueManager.tsx:681`), so part of the vocabulary exists.
2. **The `BUBBLE_CONTOUR_FALLBACK` removal checkpoint** in `TODO.md`, once a detector lands that
   finds irregular bubbles directly.

Two things carried forward that are not tasks:

- The same cross-provider fallback rule AUDIT-W11 established for translation still has to be
  adopted by `ocr.py` and `qa.py`. `is_provider_auth_parked()` is in place for it. Left undone
  deliberately: the failure was only ever measured on translation, and each deserves its own commit
  rather than a speculative sweep.
- **Pixel content of the exported ZIP is still unverified.** The archive now opens under test, but
  jsdom has no canvas, so the PNG bytes in that test are placeholders. How an exported page actually
  *looks* needs a real browser and has never been checked.

### Correction to the old Step B note

The old handoff said `handleExportRenderedPng` draws from `imgRef.current`. **It does not** — it
fetches `/api/pages/{id}/rendered` from the server and was never at risk. The two that did draw from
the displayed element are `handleExportPng` and `handleExportZip`.

## 2026-08-04 — correctness sweep

Seven items, one commit each. Frontend 264 passing, backend 349, worker 275.

| item | commit | what it actually was |
| --- | --- | --- |
| AUDIT-F6 | `18ffee8` | The poll merge compared `createdAt >=`, but `createdAt` is fixed for a job's lifetime, so for the same job it was always an equality and always passed. It could not distinguish "same job, fresher" from "same job, staler". Now uses the rule the SSE handler already had. |
| AUDIT-F8 | `4cbf925` | Moved the no-spinner assertion out of `waitFor`. Verified by inversion — flipping it now fails the test, which it could not before. |
| AUDIT-F7 | `0b18b8d` | Guarded with a ref holding the current chapter id. Applied to **all four** chapter-scoped refreshes (upload, import, delete, reorder-revert), not just the one the audit named. |
| `/api/**` 200 | `9236787` | `forward:/error` reaches the error controller but sets no status, so it stayed 200. `safeFetch` is a bare `window.fetch`, so every `if (res.ok)` read a missing endpoint as success. Now throws `ResponseStatusException(NOT_FOUND)`. The old test asserted `isOk()` — it was pinning the bug. |
| prefetch gate | `64cef93` | Stubs `Image`, asserts nothing warms before load and that warming *does* happen after, so the test cannot pass with prefetching deleted. Verified by removing `!isImageLoaded`. |
| ZIP export | `1ae993e` | Archive is generated through the real UI path, captured off `URL.createObjectURL` and reopened with `JSZip.loadAsync`. Entries and `project.json` round-trip. Cost is asserted specifically because it is summed from `metadataJson` rather than stored, so a shape change would silently zero it. |
| AUDIT-W11 | worker `2f0abfa` | Fallback now crosses providers **only** when the pinned one is parked in `PROVIDER_AUTH_FAILURES`. Both translation paths share one `resolve_fallback_target()`; they had duplicated the condition. |

Two process notes worth keeping:

- Every behavioural fix above was checked **red-green** — the guard removed, the test observed to
  fail, the guard restored. A regression test that has never been seen to fail is not evidence.
- `ForwardController`'s old test and `TextBoxForTest`'s helper were both *pinning bugs* rather than
  behaviour. When a fix makes a test fail, check which of the two is wrong before editing the test.

## 2026-08-04 — render geometry

Two commits, `97bc93f` (backend + docs) and worker `6906a71`.

**AUDIT-W12 is CONFIRMED** — QA does emit `escalation` / `directFix`. Moved out of the open list.

**`f3aa160` shipped two defects and they are both fixed.**

1. It insetted every region into "the bubble", but 42% of translated regions (1,832 of 4,351) have
   no detected bubble — the worker fills `bubble*` from the OCR text bbox for those. Insetting a
   49px caption to 29px is narrower than a word, so `fit_text_in_box_py` fell through to
   per-character splitting and rendered "goi/ng", "sub/jec/t". 237 regions were under 40px; now 16.
   The premise was measured library-wide, which folded in those synthetic rows sitting at exactly
   100% by construction; restricted to real bubbles it is 95.7%/97.4% and the inset is right.
2. The new `record TextBox` was inserted between `@Transactional` and `handleTranslationCallback`,
   so the annotation bound to the record. It compiled clean — records are types — and left every
   write in that callback outside a transaction.

**The bubble detector's limits are now measured; do not re-derive them.**

- YOLO11n is single-class (`balloon`) and only recognises canonical enclosed balloons. On Openrouter
  ch. 11 p22 it scores **0.92** on a normal oval and **0.206 / 0.044** on the two irregular thought
  clouds. 34% of *speech* regions (1,022 of 2,967) have no detected bubble.
- **Lowering the threshold does not work.** Over 30 pages / 180 such regions: 0.25 → 1 recovered,
  0.15 → 5, 0.10 → 7 (3.9%), at 24% more detections per page. The misses are mostly not
  low-confidence detections being filtered; there is no mask at all.
- **A bigger model does not work either, and this closes F.1.** `yolo26s_manga109` (3-class, already
  in the worker cache) recovers 4/180 at 0.25 vs yolo11n's 1/180, and every region it recovered the
  contour search had already recovered — additive value zero. It classes the clouds as `text`, not
  `balloon`. This is a training-distribution gap, not a model-size gap. Details in
  [archive.md](./archive.md) F.1, including the incompatible output layouts that made the original
  attempt read as "failed".
- **What does work** is `detect_bubble_contour`, which already existed but was unreachable whenever
  YOLO was active — its only call site was the legacy branch. Wired in behind
  `BUBBLE_CONTOUR_FALLBACK` (default on): recovers ~48%, median 2.6x wider. It is compensation for a
  detector limitation and carries a removal checkpoint in `TODO.md`.
- **This only helps pages that are re-OCR'd.** Existing pages keep their synthetic geometry; the
  backend fix improves them, the contour recovery does not reach them. Manual re-OCR per page is the
  accepted remedy, so no backfill is planned.

**Testcontainers: the backend suite is green, 346/346.** `init-test.sql` was missing
`reader_storage_path`, added to `Image` in `3122624` but never to the test schema — six
`@DataJpaTest` classes plus `SchemaValidationTest`, `OpenApiSpecTest` and
`PipelineFlowIntegrationTest` were failing schema validation on it. Note this does **not** confirm
or refute the earlier Ryuk/Redis diagnosis below: the control run on a stashed tree exceeded ten
minutes and was abandoned, so that was never reproduced. Treat the old constraint as stale rather
than as disproved, and re-check it if the suite goes red again.

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
- **~~Testcontainers is currently broken on this box~~ — STALE as of 2026-08-04.** The full backend
  suite runs **346/346 green**. The cause found and fixed was a test-schema drift, not Ryuk:
  `init-test.sql` had no `reader_storage_path`. The original Ryuk/Redis diagnosis was neither
  reproduced nor disproved this time — the stashed-tree control run exceeded ten minutes and was
  abandoned. If the suite goes red again, check the surefire report's `Caused by` chain before
  assuming the environment; a schema-validation failure and a Ryuk failure both surface as
  "ApplicationContext failure threshold exceeded" on every class after the first.
- **MinIO objects are readable straight off disk** — no container, no port 9000. Single-drive MinIO
  prefixes a 32-byte bitrot checksum to each 1 MiB block; strip those and the bytes come back
  verbatim. Handle three layouts: single-part, multi-part (`part.1..N`, numeric order), and small
  objects inlined into `xl.meta` as a trailing msgpack `bin32`. Verified against all 743 ETags.
- **Never upload Firefox profiles** — use save-to-file; they carry series names and URLs.

## Prompt for the next chat

<!-- markdownlint-disable MD031 MD040 -->

```
Continuing manga-library. Read docs/next-step.md first — it has what shipped, what is
settled, and what is still open. Do not re-audit the codebase and do not re-derive the
run numbers; both are written down. The ~50 AUDIT-* findings in docs/issues.md carry
file:line anchors.

The performance thread is CLOSED. AUDIT-W5 is WON'T DO at 1.8%, and the large
layout/panel-detection stage times are an attribution artefact, not a stall — do not
reopen either without a new measurement that contradicts the ones on file.

WHAT I WANT

1. The transitioning-state change for queued jobs — an observability fix so a job's
   wait stops being attributed to the stage it last completed. Do not file or measure
   this as a performance item; it will not move wall time. getDisplayStatus already
   renders COMPLETED as "TRANSITIONING..." so some of the vocabulary exists.

2. Rank whatever remains in issues.md by measured payoff — "N seconds per page, M
   lines to fix" — not by severity label.

The correctness list from 2026-08-04 is closed; do not reopen those without a new
reproduction. Each fix has a red-green regression test, so start by running the
suites rather than re-reading the diffs.

Tell me plainly if any of this is falsified once measured. I would rather delete a
wrong model of the system than fix the wrong thing.

CONSTRAINTS
- CLAUDE.md is binding: reindex, impact() before edits, detect_changes() before commits.
- Commit to main directly.
- One performance variable per change.
- Security findings (AUDIT-S*) are tracked separately; don't fold them in.
```

<!-- markdownlint-enable MD031 MD040 -->
