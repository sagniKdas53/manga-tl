# TODO — Manga Library

> Status legend: `[ ]` not started · `[/]` in progress · `[x]` done · `[D]` deferred
>
> Full history of closed work is in [docs/archive.md](./docs/archive.md). Finished planning docs
> and session handoffs live in [docs/archive/](./docs/archive/).

## Now

### 1. Render quality gap (the paid-product comparison)

We flatten **6.85%** of page artwork on average vs **1.92%** for mangatranslator.ai / human
scanlation — we lose on every page in the 40-page comparison set. Root cause: there's no real
inpainting, erasure is a flat colour fill over the balloon's outer contour, and unconstrained
region merging grows that fill across whole panels. Full writeup, defect list (D1–D16) and phase
plan: [docs/render_quality_gap_2026-08-05.md](docs/render_quality_gap_2026-08-05.md). Score any
render with `scripts/render_quality_metrics.py`.

Where it stands, in leverage order:

- [x] **D6/D7 — undersized, overflowing text.** Fixed 2026-08-12/13 (hyphenation + dropping a
  size cap that pinned every fit to 60% of its box). Median balloon fill went 0.591 → 0.866.
- [ ] **D8 — mirror the D6/D7 fix into `fitText.ts`.** `render.py` has it; the browser-side
  renderer doesn't yet, so live reader and export can still disagree.
- [ ] **`freeTextBox` widening** — the backend's free-floating-text box can still land on top of
  artwork. Separate from D6/D7.
- [ ] **D10 — strip glosses and junk regions.** Cheap, mechanical: removes ~29 visible
  parenthetical glosses (`"DOKAA (WHAM)"`) and ~80 stray typeset fragments that shouldn't have
  been translated at all.
- [ ] **D16 — font fallback chain.** Glyphs the lettering face lacks print as a blank box
  (`♡`, `帅哥`). A few hours of work; reads as broken software, not a bad translation.
- [ ] **D14 — vertical multi-column narration gets shredded** into separate regions and
  translated one column at a time. Fix is contained to `fragment_grouping.py`; `sample2` is a
  ready-made regression test.
- [ ] **D15 — a sentence spanning two balloons is translated as two disconnected fragments.**
  Needs a schema change (a way to say "these regions are one utterance"). Biggest item on this
  list; do it after D10/D16/D14 have moved the visible baseline.
- [ ] **D1 — actual inpainting.** No flat-fill or gradient-aware approach will fully close the
  gap; this is the real fix and everything above is stopgap.
- [ ] **CHECKPOINT — delete the contour-fallback flag.** `BUBBLE_CONTOUR_FALLBACK` defaults off:
  its ~48% recovery rate on irregular bubbles turned out to be almost entirely the search finding
  its own crop window, not a real bubble. Drop the flag once a detector exists that finds
  irregular bubbles directly (a bigger YOLO model isn't it — tested, no additive value).
- [x] Free-floating text now lays out in a squared-up box instead of the source's narrow
  vertical column.

**QA does not close any of the geometry gaps above.** Tested 2026-08-12: QA rewrites text and
touches nothing else, so none of D1/D6/D7/D8/D10/D14/D15/D16 are recoverable by the safety net.

### 2. Backend audit backlog

~50 findings from a full-stack read-through, tracked as `AUDIT-*` in
[docs/issues.md](docs/issues.md). **58 of 66 closed.** 8 open, none critical or high:

- `AUDIT-B10` (medium) — `listPages` doesn't validate `?sort=` like its sibling endpoints do.
  Needs a live measurement before fixing — see issues.md.
- `AUDIT-W3` (medium) — provider cooldowns/lock waits block a worker slot instead of releasing it.
- `AUDIT-F9`, `AUDIT-D5`, `AUDIT-Q2` (low) — responsive-layout tests, backend memory limits,
  inline fully-qualified class names.
- `AUDIT-T1`, `AUDIT-Q1`, `AUDIT-T3` (unranked) — the worker test suite over-mocks, 249 dead
  `Objects.requireNonNull` calls, and one `@WebMvcTest` can't prove a Spring Data sort composes
  correctly.

The last three (`T1`, `D5`, `W3`) are deliberately last — each needs real experimentation
(a wire-protocol test double, a measured memory peak, concurrency testing), not a quick pass.

### 3. Logging & observability (audit of 2026-08-15)

Full-stack logging audit, measured over one 65-minute window with a live pipeline running.
Headline: the worker emitted **65,741 lines / 6.2 MB**, of which **50,584 (77%) carried no level
tag at all**, and the backend emitted **8,259**, of which **23% was stack traces from routine
403s**. Findings are tracked as `AUDIT-L*`.

Closed:

- [x] **`AUDIT-L1` — the Tomcat access log was enabled and had never been read.** No `directory`
  was set, so it went to `/tmp/tomcat.8080.<random>/logs/` *inside* the container: absent from
  `docker logs`, absent from Dozzle, destroyed on every recreate. Now on stdout, with the
  healthcheck/`/health` probes filtered out via `condition-unless`.
- [x] **`AUDIT-L2` — `traceId` existed end-to-end but reached no log line.** Minted per pipeline in
  `JobCoordinatorService`, stored in `jobs.trace_id`, shipped to the worker in the payload, and
  logged by nobody. Now in the backend's MDC (`TraceContext` / `TraceIdFilter`), in the worker's
  log format via a `ContextVar` set in `process_job_rq`, and propagated over HTTP as `X-Trace-Id`.
  Both services print the first 8 characters; the full id is logged once by `startPipeline` and
  lives in `jobs.trace_id`.
- [x] **`AUDIT-L3` — routine 403s cost 1,922 lines at ERROR.** 16 denials × ~120 frames.
  `AuthorizationDenialFilter` now catches them at the chain edge, on async dispatches too.
- [x] **`AUDIT-L4` — per-job chatter was INFO-only and all-or-nothing.** `InternalJobController`
  (2,710 lines) and `JobCoordinatorService` (2,528) narrated a state machine the `jobs` table
  already records. The narration is DEBUG now; outcome lines with counts stay INFO.
- [x] **`AUDIT-L5` — no runtime level control.** The actuator `loggers` endpoint is exposed, so one
  package can be turned up live without a restart. `/actuator/**` is ADMIN-only as a result —
  it was `permitAll`, which was fine for `health` alone but not for `loggers`/`env`/`metrics`.
- [x] **`AUDIT-L6` — 215 bare `print()` calls in the worker**, which no `LOG_LEVEL_WORKER` setting
  could suppress. All converted to level-appropriate logger calls (100 error / 63 info / 29 warning
  / 23 debug); `traceback.print_exc()` became `logger.exception`. Multi-KB payload dumps go through
  `log_payload()` (`LOG_PAYLOAD_MAX_CHARS`, default 2000, `0` for the full blob). uvicorn's
  `/health` access line (733 lines/hour) and urllib3's per-request DEBUG output are filtered.
- [x] **`AUDIT-L7` — no log rotation anywhere.** json-file defaults to unbounded and
  `/etc/docker/daemon.json` set no `log-opts`; the worker alone wrote ~140 MB/day into
  `/var/lib/docker`. All six services now cap at 3 × 10 MB.
- [x] **`jobs.started_at`** — stamped when a worker accepts a job (HTTP 202), cleared on every
  requeue path. Queue wait and work time were previously inseparable: `updated_at - created_at` was
  the only duration the table could express, which is why panel-detection measured a 184-second
  average when most of it was time spent in Redis.
- [x] **Grafana on the pipeline tables** — `127.0.0.1:3001`, provisioned from
  `config/grafana/`, reading Postgres through a SELECT-only `grafana_ro` role
  (`database/grafana_readonly.sql`). Eight panels: queue depth, pages/hour, per-stage wait-vs-work
  percentiles, failures with trace ids, and model spend. No Prometheus, no Loki, no exporters —
  every number on it is already a column, and Dozzle still covers live tailing.
- [x] **The SSE stream terminated with a 500 on every disconnect.** Found via `AUDIT-L1`. Tomcat
  re-dispatches the request when the emitter completes — on the 1-hour `EMITTER_TIMEOUT`, or as soon
  as the client goes away — and the auth filters run again. By then the single-use ticket is spent
  (`redeem` is a `GETDEL`) and an `EventSource` cannot send a header, so nothing re-established a
  `SecurityContext` and `AuthorizationFilter` denied a stream that had been properly authenticated
  an hour earlier. Fixed in two places:
  - `SseTicketAuthFilter` now keeps the `Authentication` it built on the request and restores it on
    the `ASYNC` dispatch. The ticket stays single-use — this is the same request being finished, not
    a second one being admitted — and nothing changes about how a client authenticates.
  - `AuthorizationDenialFilter` now unwraps the cause chain. Its original
    `catch (AuthorizationDeniedException)` never fired: on a committed response
    `ExceptionTranslationFilter` rethrows the denial wrapped in a `ServletException`, so `AUDIT-L3`
    caught nothing and the traces kept coming. Measured on the running instance before the fix: four
    SSE terminations, eight ~120-frame ERROR traces, four `500`s.

  Both are covered by tests that were confirmed to fail without the fix
  (`AuthorizationDenialFilterTest`, `SseTicketTest.streamStaysAuthenticatedAcrossTheAsyncDispatchThatEndsIt`).
  Frontend impact was nil either way — `useSSE` reconnects on error, `NotificationContext` logs it
  only in DEV, and notifications raised during the gap queue to Redis and drain on reconnect.
- [x] **`AUDIT-L8` — the access log's duration column was mislabelled by 1000x.** Tomcat 10.1
  redefined `%D` from milliseconds to microseconds and the pattern kept its `ms` suffix, so a 403
  that curl timed at 9.8 ms logged as "9974ms". Only visible once `AUDIT-L1` put the log somewhere
  readable. Now `%Dus`. On async requests `%D` measures the whole request lifetime rather than any
  server work: SSE lines carry values like `3600693674us`, which is the 1-hour `EMITTER_TIMEOUT` to
  within a millisecond. That is the number behaving correctly — read those lines as "how long the
  stream was open", not as latency.

**Reading a pipeline out of the logs.** Both services print the first 8 characters of the trace id
in a `[........]` column. Grab one from the Grafana failures panel or from
`select left(trace_id,8) from jobs where image_id = '<uuid>'`, then:

```bash
{ docker logs manga-backend 2>&1 | grep -F "[$SHORT]" | sed 's/^/BACKEND /'
  docker logs manga-worker  2>&1 | grep -F "[$SHORT]" | sed 's/^/WORKER  /'; } | sort -k2
```

That returns all six stages across both containers. To turn one class up without raising
`LOG_LEVEL` globally:

```bash
curl -u admin:<pw> -X POST localhost:8080/tlhub/actuator/loggers/com.manga.library.controller.InternalJobController \
     -H 'Content-Type: application/json' -d '{"configuredLevel":"DEBUG"}'   # null to reset
```

Open:

- [ ] **Move the direct Gemini OCR key out of the query string** (`services/ocr.py`, the
  `?key=` on the `generativelanguage.googleapis.com` URL) **into the `x-goog-api-key` header.**
  Every other provider already authenticates by header, including Google's own OpenAI-compatible
  endpoint in `provider_config.py`; this one call site is the exception. A URL-borne key lands in
  `requests`' exception text, in urllib3's DEBUG output, and in any proxy log on the path.
  `redact()` (`config.py`) is the belt — it strips `?key=`/`Bearer` out of anything passed through
  it, verified against both the `requests` and urllib3 exception shapes — but it is opt-in per call
  site, and `llm_client.py:216` and ~20 other `logger.error(f"…{e}")` sites do not call it. The
  header change is the braces and makes the rule unnecessary on this path.
  **Not urgent:** the path is unreachable in this deployment (the configured `google/gemini-*`
  models are served through OpenRouter), so it leaks nothing today — it goes live the moment a
  direct Gemini key is configured. Deferred once already because it changes a provider's wire
  format and there is no key here to test it against; Google accepts both forms, so any Gemini key
  is enough to verify it.
- [ ] **Decide whether Loki is wanted after living with the cleaned-up logs.** Deliberately deferred:
  shipping 65k unstructured lines/hour into it would have relocated the noise rather than removed
  it. Revisit once there is a concrete search Dozzle cannot answer.
- [ ] **Backfill or accept null `started_at` on pre-2026-08-15 rows.** The wait-vs-work panels are
  empty for them; there is no way to reconstruct a dispatch time after the fact.

### 4. Housekeeping

- [ ] **Replace the `neurometric` API key** in `secrets/api_keys.json`. Still dead. Since
  `AUDIT-W11`, a chapter pinned to a provider whose key is rejected now falls back to another
  provider instead of failing 100% of its translations — so this is cleanup, not an outage.

## Medium priority

### Worker pull model (event-driven job handoff)

Design doc: [docs/worker_pull_model.md](./docs/worker_pull_model.md) — designed, not implemented.

Would replace the backend's fixed-interval dispatcher with worker threads pulling directly off
Redis (`BRPOP`), plus lease/heartbeat crash recovery and a cancellation tombstone (the tombstone
gap exists today too — force-clearing a job doesn't stop the worker from finishing it and
resurrecting a cleared pipeline).

**Measured value is small: 0.83% of total queue wait** (408s of 49,058s), not the ~10–25%
originally estimated — see
[docs/perf_analysis_backend_2026-08-02.md](./docs/perf_analysis_backend_2026-08-02.md). Worth
building for tail latency and multi-worker resilience, not for throughput.

## Low priority / stretch goals

- [ ] CBZ import/export, and ePub **export** (ePub import already works; only export and CBZ are
  missing).
- [ ] **OCR/Translation/QA prompt & schema robustness** — tracked in
  [docs/models_and_prompts.md](./docs/models_and_prompts.md#suggestions-for-improvement):
  - [ ] Retry with `temperature=0` on JSON parse failures
  - [ ] Reject refusal/length-anomaly responses from cloud OCR instead of trusting them as text
  - [ ] Strict schema enforcement for local Ollama VLM OCR (currently falls back to raw text)
  - [ ] Real per-region OCR confidence from VLMs (currently hardcoded to `0.99`)
  - [ ] One consistent JSON-only closing instruction across all structured-output prompts
- [ ] **Rich translation context & character memory** — series/chapter descriptions and a
  cross-page name/character/place registry, injected into translation context alongside prior
  page text.
- [ ] **AI-generated chapter/series summaries.**
  - [ ] Phase 1: add a manually-editable summary field to series and chapter objects.
  - [ ] Phase 2: auto-generate via NER, gated behind the existing context-memory toggle.
- [x] ~~**Pagination & infinite scroll**~~ — shipped as part of the backend audit's `AUDIT-F8`:
  server-side pagination on series/chapters/pages plus scroll-triggered `loadMore`. Both phases
  originally planned here are done.
- [ ] **Standalone NGINX / decoupled topology** — package the frontend as its own container and
  split out git submodules for remote GPU worker deployments.
  - [ ] Worth checking first whether this actually helps — the bottleneck has consistently been
    backend response time, not frontend asset load.

## Testing & QA

- [x] Concurrency defaults raised (`CONCURRENT_JOBS=5`, `MAX_HEAVY_SLOTS=1`,
  `MAX_LIGHT_SLOTS=4`) and confirmed via a drained capture — see
  [docs/archive.md](docs/archive.md).
- [x] Worker container given CPU/memory limits (2 CPUs / 4g, sized from measured peak usage).
- [ ] **Large-upload performance (100+ images)** — thumbnail generation is serialized behind one
  global lock (`WEBP_LOCK` in `PageService.java`), so the thumbnail executor's 4 threads still
  process one at a time. See [docs/webp_thumbnail_encoding.md](./docs/webp_thumbnail_encoding.md).
- [ ] **`mock-router`** — a deterministic mock LLM provider (speaks the OpenAI/Anthropic wire
  format) so the pipeline can be tested end-to-end with no API spend and no nondeterminism.
  Design doc: [docs/mock_router.md](./docs/mock_router.md) — designed, not implemented, phased:
  - [ ] Phase 0: fix `try_local_ai` dropping its `prompt` argument; route `ocr.py`'s cloud OCR
    calls through `LLMClient`/`PROVIDER_REGISTRY` instead of hardcoded per-provider URLs.
  - [ ] Phase 1: Ollama drop-in mock + happy-path response contracts.
  - [ ] Phase 2: cloud-provider substitution + fault injection (429s, malformed JSON, timeouts).
  - [ ] Phase 3: record & replay against a real provider, as a prompt-regression baseline.
  - [ ] Phase 4: wire into CI via the Playwright suite below.
- [ ] **Playwright end-to-end pipeline test** — upload real pages, run the full
  OCR/translate/render pipeline, assert on layer correctness. Should run against `mock-router`
  rather than live providers.

---

[Full archive](./docs/archive.md) · [Archived plans & handoffs](./docs/archive/)
