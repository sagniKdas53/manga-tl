# TODO — Manga Library

> Status legend: `[ ]` not started · `[/]` in progress · `[x]` done · `[D]` deferred
>
> Full history of closed work is in [docs/archive/history.md](docs/archive/history.md). Finished planning docs
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
- [/] **D8 — mirror the D6/D7 fix into `fitText.ts`.** *Half done (verified 2026-08-17).* The
  **size-cap half is already there** — `fitText.ts:477-483` drops the `maxWidth / 3` pre-cap with a
  comment citing D7 and "matching the Python fix". What is **not** mirrored is **hyphenation**:
  `render.py` has a full pyphen implementation (`hyphen_positions`, `render.py:251-313`) and
  `fitText.ts` has none, so a long word still forces a smaller size in the browser than in the
  export. That is the remaining disagreement between live reader and export.
- [ ] **`freeTextBox` widening** — the backend's free-floating-text box can still land on top of
  artwork. Separate from D6/D7.
- [/] **D10 — strip glosses and junk regions.** *Mechanism built, one half inert (verified
  2026-08-17).* The **gloss half is done**: the prompt contradiction is gone —
  `translation.py:65` now reads `GOOD: "WHAM". BAD: "DOKAA (WHAM)".`. The **junk half is done**:
  `JUNK_REGION_MIN_CONFIDENCE` (0.55) is consumed at `translation.py:211`. The **sfx half is
  built but cannot fire**: the `TYPESET_SFX` gate at `translation.py:202` keys off
  `region_type == "sfx"`, and `classify_region_type` (`layout.py:50-55`) still recognises sfx only
  by kana-only-≤5-chars or 3:1-tall-≤6-chars — the two rules a mangled OCR read never matches. See
  issues.md §R4. Today SFX are suppressed by the QA VLM's `reject_sfx`, not by this gate.
- [ ] **D16 — glyph-level font fallback.** Glyphs the lettering face lacks print as a blank box
  (`♡`, `帅哥`). Reads as broken software, not a bad translation. **Note the title was misleading:**
  a font *fallback chain already exists* (`DEFAULT_FONT_FALLBACK_ORDER`, `render.py:77-120`), but it
  only fires when a font **file fails to load**. Comic Neue loads fine, so the chain never runs and
  the tofu still renders. What is missing is **per-glyph coverage detection** — nothing in
  `render.py` inspects a font's cmap. Verified 2026-08-17.
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

### 2. Audit backlog — re-oriented 2026-09-02

Full detail in [docs/issues.md](docs/issues.md). **96 filed, 70 closed, 26 open.** The 2026-09-02
field report added 28 items; `AUDIT-Q1`, `AUDIT-Q2` and `AUDIT-T3` closed as obsolete because they
named Java files the Rust rewrite deleted. Seven of the new items are already fixed.

The report is not 24 independent bugs. It is **three seams**, and they have to close in order —
each later one is wasted effort until the earlier one holds.

- [/] **Seam 1 — the editor and the renderer disagree about what an element is.**
  - [x] `AUDIT-F14` — rotation 400'd every save: `maxWidth`/`maxHeight` were `i32` and a rotated
    bounding box is fractional, so serde rejected the body before the handler ran.
  - [ ] `AUDIT-R5` — it still would not *render*: `render.py` contains the string `rotation`
    zero times, so every angled box flattens in the export. Next up; it is what makes F14 worth
    having.
  - [ ] `AUDIT-F16`/`AUDIT-R1` — padding is a constant in one renderer and absent in the other.
    Fix them as one: make the inset an element field both renderers read.
  - [ ] `AUDIT-R7` — a rectangle round-trips as a 40-vertex polygon (`epsilon = 0.002`).
  - [ ] `AUDIT-F15` — hidden elements become unselectable.
- [/] **Seam 2 — the canvas and the artifact are not connected.**
  - [x] `AUDIT-B12` — QA runs *after* the only render, so no `direct_fix` or `reject_sfx` ever
    reached `/rendered` or the chapter ZIP. QA now enqueues one `finalPass` render. Worth noting
    what this was **not**: all three renderers already refuse to paint a plate for a hidden or
    blank element. The seam was the pipeline order.
  - [ ] `AUDIT-B15` — **corrected**: the debounced sweeper for human edits *does* exist and runs
    every 5s. Its defect is that it stamps `last_rendered_at` when it *asks* for the render, not
    when the render lands, and gates that on an `is_ok()` that is always true. A lost render job
    therefore falsifies the sweeper's own predicate and strands that edit forever.
- [/] **Seam 3 — the UI does not believe the backend.**
  - [x] `AUDIT-F17` — the reader filtered SSE down to four job types on one page. Both halves
    fixed; the allow-list was removed rather than extended, because it goes stale silently.
  - [x] `AUDIT-F20` — `PROCESSING` shared a sort rank with `PENDING`, so active jobs never moved.
  - [ ] `AUDIT-F19` — thumbnails and cards never re-poll.
  - **The "SSE is ass, move to WS" proposal is declined for now** (`AUDIT-P10`) — every concrete
    symptom was the client-side filter, now fixed, and a rewrite would re-lose the ticket
    handshake, the Redis replay and the jittered reconnect for a client→server channel nothing
    uses. Reopen it with a measurement (dropped events per session) if it still feels unreliable.

Running alongside, on the pipeline side:

- [x] `AUDIT-W13` — context injection was advertised as on and was effectively off: four light
  slots translated four pages at once, so "previous page dialogue" was read before it existed, and
  `COALESCE(translated_text, text)` handed back the predecessor's *Japanese* under an English
  label. Gated in the dispatcher, not the worker, so a waiting job holds no slot — which is why
  `AUDIT-W3` turned out **not** to be a prerequisite after all.
- [x] `AUDIT-B13` — a page with nothing translatable burned 3 LLM attempts and landed red. It
  completes with a `WARNING` notification now, and the worker no longer raises.
- [ ] `AUDIT-W14` (medium) — the dispatcher never decrements its per-cycle capacity snapshot.
  The tier split itself is a measurement question; `AUDIT-W10` moved it deliberately, so re-run
  the timing before touching the default.

Still deliberately last, each needing real experimentation rather than a pass:
`AUDIT-T1` (a wire-protocol test double), `AUDIT-D5` (a measured memory peak), `AUDIT-F9`
(Playwright).

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
# /actuator/** is ADMIN-only, and this deployment carries no Basic auth — the token comes from a login.
JWT=$(curl -s localhost:8080/tlhub/api/auth/login -H 'Content-Type: application/json' \
       -d '{"email":"<admin-email>","password":"<pw>"}' | jq -r .token)

curl -X POST localhost:8080/tlhub/actuator/loggers/com.manga.library.controller.InternalJobController \
     -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
     -d '{"configuredLevel":"DEBUG"}'   # null to reset
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
- [x] **Resource metrics, and the Stack Performance dashboard** (2026-08-23). The line above about
  no Prometheus and no exporters held for pipeline facts and still does — it just never covered
  what the machine was doing. cAdvisor + Prometheus now feed a second dashboard (`/tlstats`,
  `config/grafana/dashboards/performance.json`) with per-container CPU, memory, disk and network,
  the root cgroup for whole-machine load, and the worker's CFS throttling against its 2.0-CPU cap.
  Pipeline panels on it still come from Postgres, and one panel draws on both at once. This is
  `scripts/capture-run.sh`'s `sample_resources` loop made standing: the same numbers that set the
  worker's `deploy:` limits, without having to remember to start a capture first.
  Two things worth knowing about the setup, both of which cost an hour:
  - Docker's cgroups on this host are at `/system.slice/docker-<hash>.scope`, not the `/docker/<hash>`
    every cAdvisor example assumes (cgroup v2, systemd driver). A relabel rule written against the
    documented path silently dropped every container and left only machine totals.
  - `container_cpu_usage_seconds_total` carries a `cpu="total"` label that `container_spec_cpu_quota`
    does not, so dividing them to get "percent of cap" matches nothing and renders as No data.
    `ignoring(cpu)` is what makes it work.
- [ ] **Backfill or accept null `started_at` on pre-2026-08-15 rows.** The wait-vs-work panels are
  empty for them; there is no way to reconstruct a dispatch time after the fact.

### 4. Housekeeping

- [ ] **Replace the `neurometric` API key** in `secrets/api_keys.json`. Still dead. Since
  `AUDIT-W11`, a chapter pinned to a provider whose key is rejected now falls back to another
  provider instead of failing 100% of its translations — so this is cleanup, not an outage.

## Medium priority

### Worker pull model (event-driven job handoff)

Design doc: [docs/design/worker_pull_model.md](docs/design/worker_pull_model.md) — designed, not implemented.

Would replace the backend's fixed-interval dispatcher with worker threads pulling directly off
Redis (`BRPOP`), plus lease/heartbeat crash recovery and a cancellation tombstone (the tombstone
gap exists today too — force-clearing a job doesn't stop the worker from finishing it and
resurrecting a cleared pipeline).

**Measured value is small: 0.83% of total queue wait** (408s of 49,058s), not the ~10–25%
originally estimated — see
[docs/archive/perf_analysis_backend_2026-08-02.md](docs/archive/perf_analysis_backend_2026-08-02.md). Worth
building for tail latency and multi-worker resilience, not for throughput.

## Low priority / stretch goals

- [ ] CBZ import/export, and ePub **export** (ePub import already works; only export and CBZ are
  missing).
- [ ] **OCR/Translation/QA prompt & schema robustness** — tracked in
  [docs/reference/models_and_prompts.md](docs/reference/models_and_prompts.md#suggestions-for-improvement):
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
  [docs/archive/history.md](docs/archive/history.md).
- [x] Worker container given CPU/memory limits (2 CPUs / 4g, sized from measured peak usage).
- [ ] **Large-upload performance (100+ images)** — thumbnail generation still serializes on the
  global `WEBP_LOCK` in `PageService.java`. *Narrower than this item used to claim (verified
  2026-08-17):* `AUDIT-B6` already pulled the non-WebP decode out of the lock, so a JPEG/PNG
  source now decodes in parallel and only genuinely-WebP work is serialized (`PageService.java:260-283`).
  The encode side (`:355`, `:518`) is still fully serialized, so the 4 executor threads still
  bottleneck on a WebP-heavy upload. See [docs/reference/webp_thumbnail_encoding.md](docs/reference/webp_thumbnail_encoding.md).
- [ ] **`mock-router`** — a deterministic mock LLM provider (speaks the OpenAI/Anthropic wire
  format) so the pipeline can be tested end-to-end with no API spend and no nondeterminism.
  Design doc: [docs/design/mock_router.md](docs/design/mock_router.md) — designed, not implemented, phased:
  - [/] Phase 0: ~~fix `try_local_ai` dropping its `prompt` argument~~ — **done**; it now takes the
    caller's prompt as the system message (`translation.py:540-551`), which is what had been
    silently breaking QA. Still open: route `ocr.py`'s cloud OCR calls through
    `LLMClient`/`PROVIDER_REGISTRY` instead of hardcoded per-provider URLs (`ocr.py:174` is still a
    hand-built Gemini URL — same line as the key-in-query-string item above).
  - [ ] Phase 1: Ollama drop-in mock + happy-path response contracts.
  - [ ] Phase 2: cloud-provider substitution + fault injection (429s, malformed JSON, timeouts).
  - [ ] Phase 3: record & replay against a real provider, as a prompt-regression baseline.
  - [ ] Phase 4: wire into CI via the Playwright suite below.
- [ ] **Playwright end-to-end pipeline test** — upload real pages, run the full
  OCR/translate/render pipeline, assert on layer correctness. Should run against `mock-router`
  rather than live providers.

---

[Full archive](docs/archive/history.md) · [Archived plans & handoffs](./docs/archive/)
