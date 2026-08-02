# TODO — Manga Library (Master Checklist)

> **Last updated**: 2026-08-03  
> Audited via Git history & GitNexus analysis, cross-checked against `docs/issues.md` and `docs/archive.md`  
> Status legend: `[ ]` = not started, `[/]` = in progress, `[x]` = done, `[P]` = planned (in a plan doc), `[D]` = deferred

---

## 🟢 Current Goals

### Do these next (2026-08-03)

Carried over from the retired `docs/Next Steps.md`. The first three are the tail of the 2026-08-02
audit batch and need a human, not code.

- [ ] **Re-run the drained capture to confirm the AUDIT-W10 win.** `./scripts/capture-run.sh start`
  → ~20 pages end to end → drain fully → `stop`, then compare against the `20260802-163445`
  baseline. The slots went `1` → `4` light but the win is **unmeasured**; the headline number is
  `layout`'s 591 s p50 queue wait. Check the worker's startup log for AUDIT-W6's clamp messages, and
  watch whether the UI degrades under the extra concurrency (if it does, cap worker CPU rather than
  reverting the slots).
- [ ] **Replace the `neurometric` API key** in `secrets/api_keys.json` — 401 × 323 on the baseline
  run, 100% translation failure on every chapter pinned to it. No code change fixes a dead
  credential.
- [ ] **Regenerate `frontend/src/api/schema.d.ts`** — the S4 batch added
  `POST /api/notifications/ticket`. Per [CLAUDE.md](./CLAUDE.md), `npm run generate-api` from
  `frontend/` **after** the next `docker compose build backend && docker compose up -d backend`.
  Nothing is broken meanwhile (`useSSE.ts` uses a plain `fetch`).
- [ ] **AUDIT-T2 — error-branch tests for `LLMClient`.** Now the top of the un-started audit work,
  and cheap: five tests against the existing mocks covering `429` + cooldown escalation,
  `json_schema` → `json_object` degradation, `5xx` → Tenacity retry, `4xx` → `PermanentAPIError`,
  and timeout/connection error. Every AUDIT-W8 defect lives in one of these untested branches. Do it
  before the mock-router build, not after.

### Fix recent issues

- [ ] See [issues.md](./docs/issues.md)
- [/] **Full-stack audit backlog (2026-08-01)** — ~50 findings across backend, worker, frontend and
  Docker, logged as `AUDIT-*` in [issues.md](./docs/issues.md#full-stack-audit--2026-08-01) with
  `file:line` anchors and a suggested fix order. **Items 1–5 of that order landed 2026-08-02**
  (S1/S2/S3/S4 fail-open secrets, D1 backups, W10/W6 slots, P4 duplicate work, P1/W1 provider-key
  mismatches) — see [§ Status of the fix order](./docs/issues.md#status-of-the-fix-order--2026-08-02).
  Remaining, in order: **T2** (error-branch tests), **P2/P3/B1** (dispatcher defects, latent
  correctness rather than throughput), **W2** hardening, then everything else as it is touched.
  New since the batch: **AUDIT-W11** — a chapter pinned to a dead provider gets no cross-provider
  fallback.

### Output & Rendering Quality

- [ ] Rendered output quality gap vs mangatranslator.ai
  - See Example 1:
    - Original: <br/><img src="examples/sample2/original.jpg" alt="original" width="600"/>
    - mangatranslator.ai: <br/><img src="examples/sample2/en-mangatranslator.ai.jpg" alt="mangatranslator.ai" width="600"/>
    - Ours: <br/><img src="examples/sample2/en-local.png" alt="ours" width="600"/>
- [ ] **Multimodal VLM Quality Benchmarks & Render Tuning** — use VLMs (Kimi K3 or 5.6-Sol) to analyze translation and typesetting output against competitor benchmarks and refine `render.py` text fitting and inpainting algorithms.

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
