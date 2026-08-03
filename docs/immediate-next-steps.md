# Immediate next steps — handoff 2026-08-03

> **Read this before `next-step.md`.** The plan for 2026-08-03 was to analyse the post-W10
> benchmark run per [next-step.md](./next-step.md). That analysis happened and is finished, but it
> surfaced a broken reader and a chain of silent QA failures that were more pressing, so the day
> went into those instead. `next-step.md` is now **partly consumed and partly superseded** — see
> [§ Status of the original day plan](#status-of-the-original-day-plan).
>
> **Resume at:** [§ Resume here — step A](#resume-here) (the WebP measurement).

## TL;DR of the day

| | |
| --- | --- |
| **Analysed** | Runs `20260803-084755` (queue), `20260803-101946` (reader), `20260803-103311` (both) |
| **Shipped** | 5 parent commits + 1 worker submodule commit, all on `main`, all deployed |
| **Falsified** | AUDIT-W10 was never in force; `duplicate_jobs.csv` cannot test AUDIT-P4; "90.8% queue wait" overstates recoverable time |
| **Found** | A four-link silent-QA-pass chain; the reader regression from `02d9185`; `images.width/height` null for all 743 rows |
| **Open** | The 7-item reader plan below, items 1/2/4/5/6 — plus AUDIT-B6 and AUDIT-W12 |

## What was done today

All on `main`, working tree clean, backend and worker rebuilt and running.

| commit | what |
| --- | --- |
| `02d9185` | **Reader images fixed.** AUDIT-S4 removed the `?token=` credential path but the reader still built image URLs with it, and `<img>` cannot send a header — every full-size page 403'd. Replaced with `utils/authImage.ts` (fetch + blob URL). **This is itself the regression that later items undo — see below.** |
| `14bed1e` | **Backend QA silent-pass.** `UUID.fromString(null)` threw inside a per-result catch, leaving counters at zero, which computed to `status = "passed"`. Now discards unidentified results, reports `error` / `COMPLETED_NO_QA`, and writes metadata only to the newest translation layer. |
| `143f6d9` | **Docs**: run findings, the W10 correction, the AUDIT-P4 correction; worker pointer bump. |
| `0867252` | **Security boundary recorded** — see [security_boundary.md](./security_boundary.md). Image bytes public on purpose; `SecurityConfigTest` enforces both halves. |
| `4f40d39` | **Overlay geometry decoupled from the displayed image.** Prerequisite for serving a variant. `images.width/height` now captured at upload + backfilled (743 updated, 0 skipped, ~16 s). |
| worker `2b4d41d` | **Worker QA.** `finish_reason` captured, explicit `max_tokens=8192` for all providers, `_sanitize_qa_results` replaces three blanket auto-PASS blocks, `directFix`/`escalation` made `required`. |

### Measurements worth not re-deriving

- **Slot change works**: `layout` p50 **150.64 s → 2.65 s** once 4/1/3 was actually in force.
- **Idle heavy slot is never lent out** (AUDIT-W5): in `20260803-103311`, **13.0%** of 391 samples
  had light at its cap of 3, heavy idle, light work queued, and *no* heavy work at all.
  `WorkerDispatcherService.hasLightCapacity()` is `activeLight < maxLight && activeTotal < maxTotal`,
  and `REUSE_IDLE_SLOTS` is never read.
- **Utilisation is 80%**, not 10%: work 1150.9 s against 1444 s wall. Perfect scheduling recovers at
  most ~20% of wall — **reducing work beats reordering it**, and 450 s (39%) of that work was QA
  re-translation cycles that fixed nothing.
- **Reader**: 20 distinct images, **20 fetches (1.00×)** — the blob cache is *not* the problem.
  Image p50 **706 ms**, p95 **2482 ms** (the 5 slowest are the startup prefetch storm: 5 images
  issued within 25 ms). Mean image **1.37 MB**, max **4.73 MB**, 27.3 MB for 20 pages, at
  **0.2–1.9 MB/s** over Tailscale. Page details refetch **1.75×**.
- **Image corpus**: 743 images — 522 jpg, 163 png (avg 2271×2557), 27 jpeg, 31 webp. Widths: 101
  <1000, **470 in 1000–2000**, 115 in 2000–3000, 57 above 3000. Average original **1807×1851**;
  one sample PNG is **22.8 MB at 6764×4961**.

## Status of the original day plan

`next-step.md`'s six predictions were all walked. Outcome:

| prediction | outcome |
| --- | --- |
| 1. `active_light > 1` | **FAILED — stop condition hit.** `.env` pinned `CONCURRENT_JOBS=2`, overriding the compose default. The run measured the baseline 2/1/1 config. Now `4/1/3` and confirmed in force. |
| 2. `layout` p50 wait collapses | Untestable then; **confirmed later** on `20260803-103311`: 150.64 s → 2.65 s. |
| 3. Queue wait ≪ 90.8% | Untestable then. Superseded by the 80%-utilisation finding above. |
| 4. Tiers converge | **Still untested.** Needs a clean run at 4/1/3. |
| 5. `duplicate_jobs.csv` empty | **Metric invalid.** Its rows are QA retry cycles (sequential, same `trace_id`, `attempt=1`, all 42 callbacks claimed), and the run had zero re-dispatches, so AUDIT-P4's path never ran. Neither confirmed nor refuted. |
| 6. Translation failures → 0 | **PASSED.** 11/50 → 0/9. The dead `neurometric` key was the whole 22%. |

**`next-step.md` is superseded for predictions 1, 5 and 6; still live for 2–4**, which need one
clean drained run at 4/1/3. Do not re-run it before the reader work lands — reader traffic and
queue traffic contend on this 4-core box, which is exactly what made `20260803-103311` noisy.

### The 7-item reader plan — status

Quoted from the session where it was agreed, with current state:

1. **Reader-sized image variant** — **SUPERSEDED, see [§ Resume here](#resume-here).** The original
   framing (~1600 px downscale) is wrong: 77% of images are already ≤2000 px, so downscaling buys
   almost nothing. **The win is the WebP re-encode, not the resize.** Revised target is one
   high-quality WebP at *native* resolution, with a downscale cap only for the ~5 outliers >6000 px.
2. **Make images cacheable** — **NOT STARTED.** Still required and still confirmed: `permitAll` does
   *not* lift Spring Security's blanket `Cache-Control: no-cache, no-store, must-revalidate`. I
   verified this against the already-public `/thumbnail`. Needs an explicit header override on
   `/api/images/**`, plus `ETag` and a real `Content-Length` (`StreamingResponseBody` sends none).
3. **Fix the overlay gate** — **PARTLY DONE** in `4f40d39`. The `viewBox` no longer comes from
   `naturalWidth`, so overlays are correctly *positioned*. **Still to do:** gate overlay
   `visibility` on the image having loaded rather than on `isLoadingPageDetails`
   (`Reader.tsx`, the `svg.svg-overlay` style), which is what makes them appear over a blank page.
4. **Restore native `<img>` loading** — **DECIDED, not implemented.** The auth question is settled:
   derived variants are public (`/thumbnail` and `/reader` are both `permitAll`, already wired in
   `SecurityConfig`). Rationale and the "do not close this" record are in
   [security_boundary.md](./security_boundary.md). Implementation is part of the WebP migration.
5. **Deprioritise prefetch** — **NOT STARTED.** Revised per research: nhentai's model — forward
   biased, default ~3 pages, `priority: "low"`, not started until the current image has landed, and
   exposed as a reader setting. Replaces the hardcoded bidirectional ±2 window.
6. **Widen the details cache** — **NOT STARTED.** ~15-entry LRU instead of hard ±2 eviction; the
   measured cost is the 1.75× refetch.
7. **Lend the idle heavy slot (AUDIT-W5)** — **NOT STARTED.** Backend-only, unrelated to the reader,
   wants its own run because it is one performance variable. Measured payoff: the 13.0% above.

## Resume here

**Step A — measure WebP before building anything.** This was in progress when the session ended and
is the input to every decision below.

- Encode a sample of real originals at **q85 / q90 / lossless**, at native resolution, and report
  real ratios. Include screentone-dense pages and produce a couple of crops to eyeball.
- **Why it matters:** screentone is the pathological case for lossy compression and manga is full of
  it. Expect to land on **q90**, but verify. WebP lossless typically beats PNG by 20–30% with zero
  quality loss and may be the right answer for the 163 PNGs.
- **How:** MinIO erasure-codes objects on disk so they cannot be read from the filesystem; the
  worker container has no route to `minio:9000`; port 9000 is not published to the host. Run it
  **inside the backend container**, which already has working MinIO access via `MinioService`.

**Step B — migrate the reader to WebP.**

- Generate and **store** the variant alongside the thumbnail in `PageService` (never resize per
  request — this is MangaDex's `data-saver` model). Serve at `/api/images/{id}/reader`; the
  `permitAll` matcher already exists.
- Add the cache headers from item 2 in the same change.
- Point the reader `<img>` at it as a plain `src` and **delete the blob path**
  (`frontend/src/utils/authImage.ts` and its use in `Reader.tsx`), which restores progressive
  decode and browser request priority. Keep `clearAuthImageCache()`'s call site in `App.tsx` tidy.
- **Do not skip:** `handleExportRenderedPng` and `handleExportZip` draw from `imgRef.current`, and
  the ZIP labels the result `original.png`. Once the element shows a variant these silently become
  re-encodes of a lossy source. Point both at `/file` explicitly.
- Then finish item 3 (the overlay visibility gate) and items 5 and 6.

**Step C — fix the WebP lock (AUDIT-B6).** `PageService` wraps the **entire decode of every format**
in `synchronized (WEBP_LOCK)` despite a comment claiming the lock is WebP-only, so the 4-thread
`thumbnailExecutor` runs fully serialised — the known 100+ image upload slowdown. Only the WebP
reader/writer calls need it. This matters more once every upload also encodes a reader variant.
Same method: `in.mark(Integer.MAX_VALUE)` is never `reset()`, and the `catch` swallows
`OutOfMemoryError` (`LinkageError` was the intent).

**Step D — return to the original plan.** Item 7 (AUDIT-W5), then a clean drained run at 4/1/3 to
settle predictions 2–4, following `next-step.md`'s prompt.

## Other open items opened today

- **AUDIT-W12 [H]** (in `issues.md`) — confirm QA actually emits `escalation` / `directFix` now.
  Committed but unverified against a live provider. Until `escalation.needsReOcr` arrives, every QA
  failure routes to a blind re-translation of unreadable OCR: **450 s across 4 wasted cycles on 5
  pages, 90 s/page, 39% of all work**. Three greps on the next run settle it; they are listed in the
  issue. The `qa-re-ocr` dispatch path already exists and is correct — it has simply never fired.
- **Unmatched `/api/**` paths return 200**, not 404: `ForwardController` catches them and forwards
  to `/error`. Noticed while writing `SecurityConfigTest`; left alone as out of scope.

## Working constraints (unchanged, still binding)

- **`CLAUDE.md` is binding.** `impact()` before editing any symbol, report HIGH/CRITICAL,
  `detect_changes()` before committing. `detect_changes` attributes by line offset, so a large
  insertion flags untouched symbols below it — check hunk ranges before believing the blast radius.
- **Commit straight to `main`** — no feature branches for this project.
- **`.env` is gitignored and untracked, and it overrides `docker-compose.yml` defaults.** This is how
  the W10 change was missed for a day. Verify with
  `docker compose config | grep -E 'CONCURRENT_JOBS|MAX_(HEAVY|LIGHT)_SLOTS'` before trusting a run.
  Current values: `CONCURRENT_JOBS=4 / MAX_HEAVY_SLOTS=1 / MAX_LIGHT_SLOTS=3`.
- The frontend compiles **into** the backend image, so any frontend change needs
  `docker compose build backend && docker compose up -d backend`.
- **`worker/` is a git submodule.** Changes need their own commit plus a pointer bump in the parent.
- Backend build is Maven (`mvn -o compile`, no wrapper). `PipelineFlowIntegrationTest` guards
  pipeline/config changes (~80–180 s).
- **Never upload Firefox profiles** — use save-to-file; they carry series names and URLs.
- One performance variable per change.

## Prompt for the next chat

<!-- markdownlint-disable MD031 MD040 -->

```
Continuing the manga-library reader work. Read docs/immediate-next-steps.md first —
it has what shipped 2026-08-03, what was falsified, and where to resume. Do not
re-audit the codebase or re-derive the run numbers; both are already written down.

Resume at "Step A": measure WebP encoding on real originals.

WHAT I WANT

1. Step A. Encode a sample of real originals at q85 / q90 / lossless, native
   resolution, from inside the backend container (MinIO is not reachable any
   other way — the doc explains why). Report real size ratios, and give me
   screentone-dense crops to look at before we pick a quality.

2. Then Step B: migrate the reader to the stored WebP variant at
   /api/images/{id}/reader, add the cache headers, delete the blob path in
   utils/authImage.ts, and repoint both export paths at /file so original.png
   stays original.

3. Then Step C: AUDIT-B6, the WEBP_LOCK that serialises all decoding.

Tell me plainly if any of this turns out to be the wrong fix once measured — I
would rather delete a wrong model than fix the wrong thing.

CONSTRAINTS
- CLAUDE.md is binding: impact() before edits, detect_changes() before commits.
- Commit to main directly.
- One performance variable per change.
```

<!-- markdownlint-enable MD031 MD040 -->
