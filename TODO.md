# TODO — Manga Library (Master Checklist)

> **Last updated**: 2026-08-01  
> Audited via Git history & GitNexus analysis, cross-checked against `docs/issues.md` and `docs/archive.md`  
> Status legend: `[ ]` = not started, `[/]` = in progress, `[x]` = done, `[P]` = planned (in a plan doc), `[D]` = deferred

---

## 🟢 Current Goals

### Fix recent issues

- [ ] See [issues.md](./docs/issues.md)
- [ ] **Full-stack audit backlog (2026-08-01)** — ~50 findings across backend, worker, frontend and
  Docker, logged as `AUDIT-*` in [issues.md](./docs/issues.md#full-stack-audit--2026-08-01) with
  `file:line` anchors and a suggested fix order. Start with the fail-open secrets
  (`AUDIT-S1`/`S2`/`S3`) and confirming DB backups are still running (`AUDIT-D1`).

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
- Expected throughput gain is modest (~10-25% over the already-applied 2s poll, doc §6) since
  the single heavy slot (CPU OCR, ~13.7s/page) is the real throughput floor. The real payoff is
  sub-second tail latency and removing a scheduler/single-point-of-failure from the handoff
  path — not raw throughput. See [issues.md](./docs/issues.md) for the queue-performance issue
  this closes out.

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

- [ ] Test at higher concurrency not just 2 slots.
- [ ] Reserve CPU/memory for ML container (like Immich does for its ML container)
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
