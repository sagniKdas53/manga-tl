# Handoff — fixing the urgent issues

Written 2026-08-02 at the end of the performance-measurement work. **Measurement is done; this is
the build list.** Everything below is backed by numbers, not hypotheses — do not re-derive them.

Read first: [issues.md § Suggested fix order](./issues.md#suggested-fix-order),
[perf_analysis_backend_2026-08-02.md](./perf_analysis_backend_2026-08-02.md),
[perf_analysis_frontend_2026-08-02.md](./perf_analysis_frontend_2026-08-02.md).

---

## State of the tree

- **Uncommitted:** `docs/issues.md`, `docs/perf_analysis_frontend_2026-08-02.md` (staged).
  Everything else is committed.
- **Deployed:** current `manga-backend` image carries the animation removal, sourcemaps, and the
  chapter-card model fix. Frontend compiles into the backend image (`backend/Dockerfile:26`), so a
  frontend change needs `docker compose build backend && docker compose up -d backend`.
- **No frontend measurement work is open.** Don't re-profile.

## What is already done (do not redo)

| | |
| --- | --- |
| AUDIT-D1 db-backup | **Fixed and verified** — container up and healthy, `restart: unless-stopped`, backups current. |
| Queue Manager animation | **Removed and verified** — 27.8% of a core → 1.0%. |
| AUDIT-F2 item #3 | **Withdrawn** — the "2.44 s Reader closures" were React reconciliation, a bundle mis-attribution. |
| Chapter-card wrong model | **Fixed** — display now calls the same resolvers as `enqueueJobDirectly`. |
| Deliverable #1 (queue wait vs work) | **Done** — run `20260802-163445`. |

---

## The work, in order

### 1. AUDIT-S1 / S2 / S3 — fail-open secrets **[CRITICAL, security]**

The only genuinely dangerous item on the list. Roughly one afternoon.

- `backend/src/main/resources/application.yml:44-51` — every secret has a working hardcoded
  fallback. The JWT default is a **verbatim copy of a popular tutorial key**, on GitHub tens of
  thousands of times. Anyone with it can mint a token for any user/role via `JwtAuthFilter`.
- `DockerSecretsEnvironmentPostProcessor:52-68` — a missing/unreadable secret file logs **nothing**
  and continues, so the app boots on the tutorial key.
- `SecurityConfig:44-45` — `/api/internal/**` is `permitAll()`, guarded only by
  `InternalAuthFilter:17`, whose token defaults to `manga-library-internal-token-12345`. The backend
  is published through Traefik on a public hostname, so with defaults in effect the entire
  pipeline-mutation surface is unauthenticated. Also `:32` uses `.equals` — use
  `MessageDigest.isEqual`.
- `worker/src/worker/main.py:81-84` — `if conc.WORKER_API_SECRET and ...` means an empty secret
  **disables the check**, including on `/api/v1/jobs/submit`.

**Fix:** fail startup when `JWT_SECRET` / `INTERNAL_API_TOKEN` are unset outside a dev profile; move
dev defaults into `application-local.yml`; make the worker refuse to start rather than run open.

Related but separate: **AUDIT-S4** — JWTs travel in the SSE query string (`useSSE.ts:25`) and land in
the Tomcat access log via `%r` (`application.yml:60-63`), plus `localStorage`. Needs a short-lived
SSE ticket and `%U` instead of `%r`. Do it with this batch if there's appetite.

### 2. AUDIT-W10 — raise `MAX_LIGHT_SLOTS` **[biggest throughput win, config-only]**

Current: `max_concurrent_jobs=2, max_heavy_slots=1, max_light_slots=1`.

Measured on the drained run (42 pages, 255 jobs, 7,924 s):

> **90.8% of total job lifetime is queue wait** — 49,073 s waiting vs 4,959 s working.
> `layout` waits **591 s (p50)** to do **0.2 s** of work.

Four light stages share one slot and differ by three orders of magnitude — `qa` 53.8 s and
`translation` 30.5 s vs `layout` 0.2 s. **The light tier is now 4× slower than heavy** (94.7 s/page
vs 23.4 s/page); the heavy slot is idle 95.9% of the time. Worker CPU averaged 22.5%, so there is
headroom. Little's law reconciles to within 4%.

**Do:** raise `MAX_LIGHT_SLOTS` and `CONCURRENT_JOBS` together, then re-run the drained capture
(`./scripts/capture-run.sh start` → ~20 pages → drain fully → `stop`) and compare.

Two traps:
- **AUDIT-W6** — the slot maths is unvalidated and can compute to 0 or negative
  (`concurrency.py:29`). Check the resulting numbers.
- **UI contention** — the browser already loses 71% of its LongTask wall to descheduling under load
  on this 4-core box. More worker concurrency makes that worse. Light work is network-bound so the
  cost should be modest; if the UI degrades, cap the worker's CPU rather than reverting.

### 3. AUDIT-P4 — duplicate work **[the one correctness defect costing real work]**

Confirmed: **277 dispatches for 255 jobs (22 re-dispatches)**; 12 duplicate `(subject, type)` rows
across 4 subjects; one subject ran `translation`, `qa` **and** `render` 3× each.

Two paths requeue without telling the worker to stop — `resetProcessingJobsToPending:99-124` at
every backend boot, and `recoverStaleProcessingJobs:128-160` after 10 min (shorter than a slow OCR).
No callback handler is idempotent, so a duplicate run writes a second full region set, a second
layer, and double-counted cost.

**Needs the idempotency half, not just the cancellation tombstone** from
[worker_pull_model.md](./worker_pull_model.md) §5.4. `jobId` is already in the payload and unused
(AUDIT-P5) — it is the dedup key.

### 4. AUDIT-P1 / W1 — silent wrong-answer bugs

- **P1 (half done).** `resolveConfigForChapter:613-621` passes task keys `"translation"` / `"qa"`
  that don't exist in `providers.json` (which uses `tl` / `qaLLM` / `qaVLM` / `ocr`).
  `isValidProviderModel` returns `false` on a null list, so every model collapses to the global
  default. **Not on the dispatch path** — only the duplicate-page comparison
  (`PageController:118-119`, `SeriesController:322-323`), which therefore compares global defaults
  against global defaults and makes the wrong call about whether OCR/TL data can be reused.
  The display half is already fixed; this is the clone half.
- **W1.** `handlers/qa.py` hardcodes an `if/elif` over `openrouter` / `gemini` / `nvidia` in four
  places. `cloudflare` and `neurometric` are selectable in the UI and silently return `None`;
  `gemini` is supported in code but absent from config.

### 5. Untriaged, may belong above #3

`translation` failed **11 of 50 (22%)** on the drained run, with 33 tracebacks in `worker.log.gz`
(`logs/runs/20260802-163445/`). No audit item covers this. Worth 20 minutes before starting #3.

---

## Explicitly deprioritised — do not start these

- **Worker pull model.** Measured: it removes **408 s of 49,058 s of queue wait (0.83%)**. Its §2/§6
  premise that the heavy slot is the floor has inverted. Build it for latency, resilience and
  multi-worker scaling, *after* #2. See [worker_pull_model.md](./worker_pull_model.md) §6.1.
- **AUDIT-W2 (global `RATE_LIMIT`).** Falsified in practice — all four providers carry their own
  `rate_limits`, so the global bucket never engages (0.0 s of sleep in 7,924 s). Keep only the
  "global fallback should default to unlimited" hardening.
- **AUDIT-P2 / P3 / B1 (dispatcher defects).** Real bugs, but costing ~nothing right now: 3.2% /
  1.3% starvation, 0 stranded jobs. Fix as latent correctness, not throughput.

---

## Working constraints

- **`CLAUDE.md` is binding.** Run `impact({target, direction:"upstream", repo:"manga-library"})`
  before editing any symbol; report HIGH/CRITICAL to the user; run `detect_changes()` before
  committing. `resolveModel` is **CRITICAL** (3 direct callers, 10 processes) — treat with care.
- **Backend API changes require** `npm run generate-api` from `frontend/` with the backend
  container up, per `CLAUDE.md`.
- **Never upload Firefox profiles.** Use the profiler's download/save-to-file button — uploading
  publishes to a public Mozilla URL, and these profiles contain series names, URLs and a JWT in the
  SSE stream URL.
- Backend build is Maven (`mvn -o compile`, no wrapper). `PipelineFlowIntegrationTest` is the
  integration guard for pipeline/config changes; ~80–180 s.
