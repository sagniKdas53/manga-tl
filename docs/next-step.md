# Handoff — opened 2026-08-04

> The previous handoff is retired: everything in it is done and its measurements live in
> [archive.md](./archive.md) under *The 2026-08-04 handoff*. Read that before re-opening anything
> performance-related — several things were dropped **because they were measured**, not because
> nobody got to them.
>
> **Resume at:** [§ The list](#the-list). Item 1 is a one-line config change.

## Where the work stands

Three threads are closed and should stay closed without a new measurement that contradicts the file:

| thread | outcome |
| --- | --- |
| Reader performance (7-item plan) | Items 1–6 shipped. Item 7 (lend the idle heavy slot, AUDIT-W5) is **WON'T DO** at 1.8%. |
| Queue scheduling | **Closed.** Utilisation is 80%; the big `layout`/`panel-detection` numbers are an attribution artefact, not a stall. |
| Correctness sweep (F6/F7/F8, `/api` 404, prefetch gate, ZIP, W11) | **Closed 2026-08-04**, each with a red-green regression test. |

Suites at the time of writing: **frontend 264, backend 349, worker 275.** All green.

## The list

Ranked by payoff per line changed, which is the ordering this project has asked for. Every item
below was **re-verified in the code on 2026-08-04** rather than taken from `issues.md`'s own status.

### 1. AUDIT-B1 — one scheduler thread runs everything *(1 line)*

`application.yml` sets no `spring.task.scheduling.pool.size`, so Spring's default of **1** is in
force and these five share it:

| task | cadence |
| --- | --- |
| `WorkerDispatcherService.dispatchJobs` | every 2 s, **30 s HTTP timeout per worker** (`:204`) |
| `JobCoordinatorService.recoverStaleProcessingJobs` | every 5 min (`:126`) |
| `DebouncedRenderService` | every 5 s |
| `HealthReporter` | every 5 min |
| `ExportCleanupService` | daily cron |

One unresponsive worker therefore stalls stale-job recovery, debounced renders and export cleanup
for up to 30 s per dispatch attempt. Set the pool to ≥4. Best payoff-per-line on the board.

### 2. `try_local_ai` ignores its `prompt` argument *(~3 lines)*

`worker/src/worker/services/translation.py:513` — the signature takes `prompt` and never reads it;
`:539` hardcodes a translation system prompt instead. For translation that is merely redundant. For
**QA it is a functional bug**: `handlers/qa.py` passes the QA prompt, the model receives the *manga
translation* prompt with QA region metadata as user content, answers `{"translations": [...]}`,
`parsed.get("results")` yields `[]`, and QA completes having produced nothing — no error, no log
line. Anyone on `QA_MODEL_PROVIDER=ollama`/`lmstudio` is affected, as is any QA job that falls
through to the local tier.

Use `prompt` when it is supplied and keep the hardcoded value as the default. Add a test that a
non-default prompt reaches the payload — the failure mode is silence, so nothing else will catch it.

### 3. AUDIT-B4 — SSE breaks with more than one browser tab *(~15 lines)*

`SseService.java:32` is `ConcurrentHashMap<UUID, SseEmitter>`, one emitter per **user**, and `:40`
does a plain `put`. Opening a second tab silently evicts the first tab's emitter, so that tab stops
receiving `job_update` events and looks frozen until reload. This is a daily-use bug, not a latent
one. Wants a `Map<UUID, Collection<SseEmitter>>` with per-emitter removal on completion/timeout.

### 4. AUDIT-B2 — `@Transactional` bypassed on the startup recovery path *(~10 lines)*

`JobCoordinatorService.onStartup:80` calls `this.resetProcessingJobsToPending()` directly.
Self-invocation does not pass through the Spring proxy, so the `@Transactional` on that method does
not apply and the batch of PROCESSING→PENDING writes runs unwrapped — a mid-loop failure leaves the
job table half-migrated. Split into a separate bean or self-inject the proxy.

*Worth pairing with a scan for the same shape elsewhere: this class of bug is invisible at the call
site and we have now hit an annotation-binding failure twice in this codebase (see `f3aa160`'s record
insertion in archive.md).*

### 5. AUDIT-B3 — a real `NullPointerException` becomes a silent 400 *(~10 lines)*

`GlobalExceptionHandler.java:39` maps `IllegalArgumentException` **and** `NullPointerException` to
`400 Bad Request`, and logs neither. The intent was to catch `Objects.requireNonNull` validation —
but it also swallows every genuine NPE anywhere in a controller path, reporting a server bug to the
client as their bad request with no stack trace anywhere. Split it: `IllegalArgumentException` → 400,
`NullPointerException` → 500 **and log it**.

*Note the interaction with AUDIT-Q1's 247 `Objects.requireNonNull` calls — if those go, this handler
loses its original reason to exist entirely.*

### 6. Infrastructure hygiene *(one commit each)*

- **AUDIT-D3** — `docker-compose.yml:142` and `:245` still use the plain-list `depends_on` for
  backend and worker, so the healthchecks defined right above them are ignored on startup. Only
  `db-backup` uses the `condition:` form. Same class of bug that took backups down for three days.
- **AUDIT-D4** — `MINIO_ENDPOINT` means two different things: `:118` wants a scheme
  (`http://minio:9000`), `:184` wants bare `minio:9000`. One `.env` value cannot satisfy both.
- **AUDIT-D2** — the worker image is single-stage, runs as root, and pins nothing
  (`worker/Dockerfile:1`, no `USER`). Also the largest image in the stack.

### 7. The transitioning state for queued jobs *(observability, not performance)*

Move a waiting job to a *transitioning* state instead of leaving it labelled with the stage it last
completed, so the shape of the wait is legible. **It will not move wall time** — file and measure it
as observability. `getDisplayStatus` already renders `COMPLETED` as `TRANSITIONING...`
(`QueueManager.tsx:681`), so some of the vocabulary exists.

## Carried forward — deliberately not done

Not tasks, but not forgotten either. Each was left undone for a stated reason.

- **The cross-provider fallback rule has not reached `ocr.py` and `qa.py`.** AUDIT-W11 established it
  for translation and `is_provider_auth_parked()` is in place for the others. Left alone because the
  failure was only ever measured on translation, and a speculative sweep is the opposite of
  one-variable-per-change.
- **The exported ZIP's pixel content is unverified.** The archive opens under test, but jsdom has no
  canvas so those PNG bytes are placeholders. How an exported page actually *looks* has never been
  checked and needs a real browser.
- **`BUBBLE_CONTOUR_FALLBACK` is compensation, not a feature.** `TODO.md` carries the removal
  checkpoint and the baseline numbers to re-measure against, for when a detector lands that finds
  irregular bubbles directly. A *bigger* YOLO is not that detector — see archive.md F.1.
- **The `neurometric` key in `secrets/api_keys.json` is still dead.** AUDIT-W11 changed what that
  costs: a chapter pinned to it now escapes to the global provider instead of failing 100% of its
  translations. Housekeeping now, not an outage.
- **AUDIT-F3 is half-closed.** The `EventSource` built-in reconnect no longer races the manual one.
  The flat 5 s retry with no cap remains; downgraded to **[L]**.

## Out of scope unless deliberately reopened

- **The worker pull model.** Measured at 408 s of 49,058 s of queue wait (0.83%). Build it for
  latency, resilience and multi-worker scaling — never for throughput.
- **AUDIT-S\*** — security is tracked separately, don't fold it in.
- **A reader downscale cap.** A 3000 px long-edge cap hits 124 images and saves a further 46 MB
  (0.241× → 0.200×). Real but secondary, and a second performance variable.
- **AUDIT-W5**, and re-deriving the queue-wait share. Both settled; see archive.md.

## Working constraints

- **`CLAUDE.md` is binding.** `impact({target, direction:"upstream", repo:"manga-library"})` before
  editing any symbol, report HIGH/CRITICAL, `detect_changes()` before committing.
  **`detect_changes` attributes by line offset**, so a large insertion flags untouched symbols below
  it — check hunk ranges before believing the blast radius, and **reindex first**
  (`node .gitnexus/run.cjs analyze`); a stale index is the main source of false HIGH/CRITICAL.
- **Verify a fix red-green.** Break it, watch the test fail, restore it. A regression test that has
  never been seen to fail is not evidence — and twice now a failing test has turned out to be
  pinning a bug rather than the behaviour.
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
- Backend build is Maven (`mvn -o test`, no wrapper). Frontend is `npx vitest run` / `npx tsc
  --noEmit` / `npx eslint`. Worker is `python3 -m pytest -q` plus `ruff check src tests`.
- **Testcontainers works.** If the backend suite goes red across many classes at once, read the
  surefire report's `Caused by` chain before blaming the environment — a schema-validation failure
  and a Ryuk failure both surface as "ApplicationContext failure threshold exceeded" on every class
  after the first.
- **MinIO objects are readable straight off disk** — no container, no port 9000. Single-drive MinIO
  prefixes a 32-byte bitrot checksum to each 1 MiB block; strip those and the bytes come back
  verbatim. Handle three layouts: single-part, multi-part (`part.1..N`, numeric order), and small
  objects inlined into `xl.meta` as a trailing msgpack `bin32`. Verified against all 743 ETags.
- **Never upload Firefox profiles** — use save-to-file; they carry series names and URLs.

## Prompt for the next chat

<!-- markdownlint-disable MD031 MD040 -->

```
Continuing manga-library. Read docs/next-step.md first, then docs/archive.md's
"2026-08-04 handoff" section. Between them they have what shipped, what is settled
and why, and what is still open. Do not re-audit the codebase and do not re-derive
the run numbers — both are written down. The AUDIT-* findings in docs/issues.md
carry file:line anchors, but trust next-step.md over issues.md's own status: the
list there was re-verified in the code on 2026-08-04.

CLOSED — do not reopen without a measurement that contradicts the file:
the performance/scheduling thread, AUDIT-W5 (1.8%, WON'T DO), AUDIT-W2 (1.2%),
AUDIT-W12 (confirmed), and the 2026-08-04 correctness sweep.

WHAT I WANT

Work down "The list" in next-step.md in order, one commit each:

1. AUDIT-B1 — scheduler pool size. One line, biggest payoff per line on the board.
2. try_local_ai ignoring its prompt argument — silent QA failure on local providers.
3. AUDIT-B4 — SSE emitters keyed by user, so a second tab kills the first.
4. AUDIT-B2 — @Transactional bypassed by self-invocation on the startup path.
5. AUDIT-B3 — a genuine NPE returns 400 and is never logged.

Then the D3/D4/D2 infrastructure items, then the transitioning-state change.

For each: run impact() first, verify the fix red-green (break it, watch the test
fail, restore it), and say plainly if the finding turns out to be stale or wrong
when you actually read the code. Several items on this board were wrong until
someone checked.

CONSTRAINTS
- CLAUDE.md is binding: reindex, impact() before edits, detect_changes() before commits.
- Commit to main directly; worker/ is a submodule and needs its own commit plus a pointer bump.
- One performance variable per change.
- Security findings (AUDIT-S*) are tracked separately; don't fold them in.
```

<!-- markdownlint-enable MD031 MD040 -->
