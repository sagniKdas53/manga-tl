# TODO — Manga Library (Master Checklist)

> **Last updated**: 2026-08-04  
> Audited via Git history & GitNexus analysis, cross-checked against `docs/issues.md` and `docs/archive.md`  
> Status legend: `[ ]` = not started, `[/]` = in progress, `[x]` = done, `[P]` = planned (in a plan doc), `[D]` = deferred

---

## 🟢 Current Goals

### Do these next (2026-08-04)

> The ordered list with file:line anchors and effort estimates lives in
> **[next-step.md](./docs/next-step.md)**. What was settled and why — including several things
> dropped *because they were measured* — is in [archive.md](./docs/archive.md) under
> *The 2026-08-04 handoff*. Read that before reopening anything performance-related.

- [x] ~~**Re-run the drained capture to confirm the AUDIT-W10 win.**~~ **Done 2026-08-04** —
  `20260803-204638` (2 jobs) and `20260803-211221` (30 pages, 204 jobs, all COMPLETED, 24 min,
  $0.19), both profiled remotely. The headline turned out to be that `layout`'s huge queue wait is
  an **attribution artefact**, not a stall: those stages sit before the expensive ones and a job
  accrues its whole wait under the stage it last completed. Scheduling thread closed.
- [x] ~~**Regenerate `frontend/src/api/schema.d.ts`**~~ — done; the file carries
  `notifications/ticket`.
- [x] ~~**AUDIT-T2 — error-branch tests for `LLMClient`.**~~ **Done** (`ffab71d`) — 16 tests, all
  five named branches covered. The **backend** half of T2 is still open and is now the part that
  matters: the dispatcher's failure paths (AUDIT-P2, P3) still have no test.
- [ ] **Replace the `neurometric` API key** in `secrets/api_keys.json`. Still dead, but **AUDIT-W11
  changed what it costs**: a chapter pinned to a provider whose key is rejected now falls back
  across the provider boundary instead of failing 100% of its translations. Housekeeping, not an
  outage.
- [ ] **AUDIT-B1 — scheduler pool size.** One line in `application.yml`; five `@Scheduled` tasks
  currently share Spring's default single thread, so one unresponsive worker stalls stale-job
  recovery, debounced renders and export cleanup for up to 30 s per dispatch. Best payoff-per-line
  on the board — see next-step.md item 1.

### Fix recent issues

- [ ] See [issues.md](./docs/issues.md)
- [/] **Full-stack audit backlog (2026-08-01)** — ~50 findings across backend, worker, frontend and
  Docker, logged as `AUDIT-*` in [issues.md](./docs/issues.md#full-stack-audit--2026-08-01) with
  `file:line` anchors and a suggested fix order. **Items 1–5 of that order landed 2026-08-02**
  (S1/S2/S3/S4 fail-open secrets, D1 backups, W10/W6 slots, P4 duplicate work, P1/W1 provider-key
  mismatches) — see [§ Status of the fix order](./docs/issues.md#status-of-the-fix-order--2026-08-02).
  **Re-ordered 2026-08-04** by payoff-per-line, and the ordering now lives in
  [next-step.md](./docs/next-step.md): **B1** (one config line), `try_local_ai` ignoring its prompt,
  **B4** (a second browser tab kills the first tab's SSE), **B2** (`@Transactional` bypassed by
  self-invocation), **B3** (a genuine NPE returns 400 and is never logged), then D3/D4/D2.
  Closed since the batch: **W11** (cross-provider fallback when the pinned provider is parked),
  **W12** (confirmed), **W5** (WON'T DO at 1.8%), **W2** (1.2%, inert — only the unlimited-default
  hardening left), **T2**'s worker half, and the F6/F7/F8 + `/api` 404 correctness sweep.

### Output & Rendering Quality

- [ ] Rendered output quality gap vs mangatranslator.ai
  - See Example 1:
    - Original: <br/><img src="examples/sample2/original.jpg" alt="original" width="600"/>
    - mangatranslator.ai: <br/><img src="examples/sample2/en-mangatranslator.ai.jpg" alt="mangatranslator.ai" width="600"/>
    - Ours: <br/><img src="examples/sample2/en-local.png" alt="ours" width="600"/>
- [ ] **Multimodal VLM Quality Benchmarks & Render Tuning** — use VLMs (Kimi K3 or 5.6-Sol) to analyze translation and typesetting output against competitor benchmarks and refine `render.py` text fitting and inpainting algorithms.
- [ ] **CHECKPOINT — delete the contour fallback.** `BUBBLE_CONTOUR_FALLBACK` is now **default off**,
  because the ~48% recovery it was built on was not real: 171 of the 172 results it accepted over a
  300-region sample were the contour search's own crop window. Free-floating text sits on the page
  background, the threshold finds the background, and a blob with no boundary inside the crop has
  `boundingRect` = the crop — which passed every guard, since a window contains its text, sits within
  `2 * pad` of it, and is a small part of the page. Those windows became "bubbles" (a 49x489 caption
  read as 129x1271) *and* the region's mask polygon, so a white rectangle got painted over the
  artwork and over neighbouring bubbles' text. `contour_bubble_for_unmatched` now rejects a blob
  clipped by its own window, which drops acceptance to 1 in 300. Delete the flag, the function and
  its tests once a detector lands that finds irregular bubbles directly — there is nothing to lose.
  - A larger model is **not** that detector. `yolo26s_manga109` (3-class, already in the worker
    cache from the reverted F.1 attempt) recovers 4/180 at conf 0.25 against yolo11n's 1/180, and
    every region it recovered was already recovered by the contour search — additive value zero.
    Both models are trained to find *balloons*; yolo26s classes the irregular clouds as `text`, not
    `balloon`. This is a training-distribution gap, not a model-size gap.
- [x] **Free-floating text is laid out in the source's vertical column.** 42% of translated regions
  have no detected bubble — irregular thought clouds, captions, SFX — and the worker synthesizes
  `bubble*` from the OCR bbox for these, so their box was the tight vertical Japanese column.
  `freeTextBox` now squares such a column up: same area, same centre, clamped to the page. Page 22 of
  Openrouter ch. 11 goes from a 69px ribbon to a 173x203 block, which is roughly what
  mangatranslator.ai gives that cloud.
  - Bounded by the page only. It does not know where the artwork or the neighbouring regions are, so
    a block can still land partly over line art; area preservation and the 2.5x widening ceiling are
    what keep that small. Collision handling against neighbouring regions is the next increment.
  - Still worth costing: detect the irregular bubble properly. These clouds are visible to a human
    and the detector just does not return them (see the checkpoint above — the contour search is not
    that detector). Real geometry would remove the whole class rather than compensate for it.

## 🟡 Medium Priority

### Worker Pull Model — Event-Driven Job Handoff

Design doc: [worker_pull_model.md](./docs/worker_pull_model.md) (status: design only, not implemented).

- [ ] Implement Option A (recommended): worker slot-consumer threads `BRPOP` Redis queues
  directly instead of the backend `WorkerDispatcherService` pushing on a fixed poll interval.
  - [ ] Ship behind a `WORKER_PULL_ENABLED` flag (default off) — dispatcher keeps running
    until the flag is flipped, so behavior is unchanged during rollout.
  - [ ] Add lease/heartbeat crash recovery (`lease:{jobId}` key, ~60s TTL, ~30s sweep) to
    replace reliance on the 5-minute stale-`PROCESSING` sweeper for pulled jobs.
  - [ ] Implement the cancellation tombstone (`cancelled:{imageId}`, doc §5.4) — **this is a
    pre-existing gap in the current push model too**: force-clearing a `PROCESSING` job deletes
    the DB row, but the worker keeps running and its callback can still re-enqueue downstream
    jobs, resurrecting a pipeline that was just cleared. Worth fixing regardless of push/pull.
  - [ ] Flip on per-worker, verify queue depths and `PROCESSING` transitions on a small run,
    then remove `WorkerDispatcherService` and the `WORKER_POLL_MS` knob.
- **Measured 2026-08-02, and the premise has inverted.** This buys **408 s of 49,058 s of queue
  wait (0.83%)** — not the "~10-25%" estimated in doc §6, and the single heavy slot is no longer
  the throughput floor (the light tier is now 4× slower; that is AUDIT-W10, already addressed by
  config). Build it for sub-second tail latency, resilience and multi-worker scaling — **not** for
  throughput, and not before the W10 re-capture lands. See
  [perf_analysis_backend_2026-08-02.md](./docs/perf_analysis_backend_2026-08-02.md).

## 🔵 Low Priority / Stretch Goals

- [ ] CBZ import/export support, and ePub **export** (currently ZIP-only for export). ePub
  **import** already works — `PageController.java`/`SeriesController.java` accept `.epub`
  alongside `.zip` uploads, so the previous "ePub / CBZ import and export, currently ZIP only"
  wording here was stale.
- [ ] **OCR/Translation/QA Prompt & Schema Robustness** — open items logged in
  [models_and_prompts.md](./docs/models_and_prompts.md#suggestions-for-improvement) but never
  carried into this list:
  - [ ] Retry with `temperature=0` on JSON parse failures (OCR batch, translation, QA paths)
  - [ ] Refusal/length heuristic validation on cloud OCR text responses (currently trusted at
    face value — a model reply of "I cannot process this image" is accepted as OCR text)
  - [ ] Strict schema enforcement for local Ollama VLM OCR crops (currently only sets
    `format: json` and falls back to raw text on parse failure)
  - [ ] Per-region confidence from VLM OCR (currently hardcoded `0.99` for every region)
  - [ ] Normalize the JSON-only closing instruction across all structured-output prompts
    (OCR/translation/QA currently phrase it inconsistently)
- [ ] **Rich Translation Context & Character Memory** — maintain series/chapter descriptions (booru-style metadata) and a cross-page character/name/place registry, injecting them alongside previous page text into LLM translation context.
- [ ] **AI-Generated Chapter & Series Summarization** — auto-generate summaries from translated dialogue.
  - [ ]  **Phase 1**: Need to add summary filed to both series and chapter objects first so that they can be manually configured
  - [ ]  **Phase 2**: Add `Named Entity Recognition (NER)` and auto generate these (remember to upgrade/the Inject Context Memory toggle to enable or disable this)
- [ ] **Pagination & Infinite Scroll** — two-phase approach for series, chapters, and pages:
  - [ ] **Phase 1**: Add backend & frontend pagination support (e.g. paged navigation).
  - [ ] **Phase 2**: Implement lazy loading / infinite scroll on top of paginated API endpoints to load more items as user scrolls.
- [ ] **Standalone NGINX & Decoupled Topology** — package frontend into standalone NGINX Alpine container and extract git submodules for remote GPU worker deployments.
  - [ ] Analyze if this will be even useful or needed, as we are as always constrained by the how fast the backend can send resources and over not how fast the html or js loads.

## 🧪 Testing & QA

- [/] Test at higher concurrency not just 2 slots. **Defaults raised 2026-08-02** to
  `CONCURRENT_JOBS=5 / MAX_HEAVY_SLOTS=1 / MAX_LIGHT_SLOTS=4` (AUDIT-W10), with `resolve_slot_config`
  clamping degenerate combinations (AUDIT-W6). The measurement half is still open — see the drained
  re-capture under Current Goals.
- [x] Reserve CPU/memory for ML container (like Immich does for its ML container) — worker capped
  at 2 CPUs / 4g (`deploy.resources` in `docker-compose.yml`, overridable via `WORKER_CPUS` /
  `WORKER_MEMORY` / `WORKER_THREADS`). Sized from the 2026-08-01 runs: worker mean 76-93% CPU,
  peak 216%, peak RSS 2.1 GiB, while all containers together peaked at 279% of a 4-core box.
  `OMP/MKL/OPENBLAS_NUM_THREADS` are pinned to match the quota — Paddle can't see a cgroup limit
  and would otherwise start 4 threads to contend for 2 cores. **Not yet benchmarked**: this caps
  the heavy OCR stage, so re-baseline `stage_summary.csv` before reading any throughput
  comparison against the 2026-08-01 runs.
- [ ] Larger upload optimization (100+ images) — noticeable slowdown, need to optimize. Known
  contributor per [webp_thumbnail_encoding.md](./docs/webp_thumbnail_encoding.md): thumbnail
  generation is serialized behind one global lock (`WEBP_LOCK` wraps both decode and encode in
  `PageService.java`), so the 4-thread `thumbnailExecutor` still processes thumbnails one at a
  time; `getScaledInstance` (slow AWT scaling path) is also flagged there as worth replacing
  with a `Graphics2D` LANCZOS draw.
- [ ] **`mock-router` — deterministic LLM provider mock for full-stack testing** — a container
  speaking the OpenAI/Anthropic chat-completions wire format that returns hardcoded, shape-correct
  payloads, so the whole pipeline can run end to end with no API spend and no nondeterminism.
  Modelled on `yt-diff`'s `validation/mock-tube`. Design doc:
  [mock_router.md](./docs/mock_router.md) (status: design only, not implemented).
  The mock impersonates **Ollama**, not a new provider: every handler already branches on
  `provider in ("ollama", "lmstudio")` and routes to a single `LOCAL_LLM_ENDPOINT` env var, and the
  worker only ever speaks Ollama's OpenAI-compatible shim (no native `/api/*` calls anywhere). So
  Mode A needs no code and no `providers.json` change. A *new* provider name would not work —
  `handlers/qa.py` dispatches on a hardcoded `openrouter`/`gemini`/`nvidia` if/elif chain and
  returns `None` for anything else.
  - [ ] **Phase 0 (prerequisites)**:
    - [ ] Fix `try_local_ai` dropping its `prompt` argument — see [issues.md](./docs/issues.md).
    - [ ] Route `try_cloud_ocr` / `perform_redo_ocr` through `LLMClient` + `PROVIDER_REGISTRY` —
      `worker/src/worker/services/ocr.py` still hardcodes per-provider URLs (lines 111/140/173/191),
      so single-crop cloud OCR and the QA re-OCR escalation loop bypass `providers.json` and would
      hit the real internet even in mock mode.
  - [ ] **Phase 1 — Mode A (Ollama drop-in) + happy path**: mock service, OpenAI envelope, the four
    response contracts with region-ID echo (static bodies won't work — the worker matches responses
    back by `id`/`regionId`, which are per-upload backend values), model-name routing, and
    `validation/docker-compose.test.yml` on an `internal: true` network as an egress guard.
  - [ ] **Phase 2 — Mode B (cloud substitution) + fault injection**: `config/providers.mock.json`,
    then `429` cooldown escalation, `json_schema`→`json_object` degradation, timeouts, malformed
    JSON, refusal text, ID drift — plus a `/__requests` capture endpoint to assert on the *request*
    side (OpenRouter `cache_control`, `provider.sort`, `response-healing`, Anthropic auth headers).
    None of that has over-the-wire coverage today, and Mode A can't reach it: the local path
    bypasses `LLMClient` entirely.
  - [ ] **Phase 3 — record & replay baseline**: proxy mode that forwards to a real provider once
    over a curated page set and writes cassettes, keyed on a canonicalized
    `(task, model, system prompt, ordered source texts)` hash with IDs and image bytes normalized
    out. Doubles as a prompt-regression diff: re-record on demand and compare against committed
    responses.
  - [ ] **Phase 4**: fold into the Playwright E2E item below; add a CI job (with cassettes committed
    it needs no secrets).
- [ ] **Playwright End-to-End Pipeline Integration Test Suite** — create end-to-end Playwright test suite that uploads test manga images, triggers full OCR/TL/Render pipeline, and asserts layer correctness.
  - Should run against [`mock-router`](./docs/mock_router.md) rather than live providers.

---

[Archive](./docs/archive.md)
