# mock-router — Deterministic LLM Provider Mock for Full-Stack Testing

> **Status: design only, not implemented.** Tracked in [TODO.md](../../TODO.md) under 🧪 Testing & QA.

## 1. Motivation

Today the worker's provider layer is covered only by unit tests that monkeypatch
`requests.post` (`worker/tests/test_llm_client.py`, `test_translation_pipeline.py`,
`test_qa_pipeline.py`, …). Nothing exercises it over a real socket, which leaves several things
structurally untestable:

- The **request** we actually put on the wire — OpenRouter `cache_control` injection, the
  `provider.sort` routing block, the `response-healing` plugin, Anthropic's `system` array, auth
  header/prefix assembly from `providers.json`. All built in `LLMClient._build_payload` /
  `_inject_routing_and_caching`, then thrown away by the mock.
- The **error branches** in `LLMClient._execute_with_retry`: 429 cooldown escalation, the
  `json_schema` → `json_object` degradation on 400, Tenacity backoff, connect/read timeouts.
- **Cross-service behaviour**: whether a translation response actually lands in the DB and gets
  rendered, or is silently dropped by `parse_and_validate_batch` because IDs didn't match.

`yt-diff` solved the equivalent problem for YouTube with `validation/mock-tube`: an nginx
container serving fixture RSS playlists and generated `.mp4` files, with the test stack pointed at
it. `mock-router` is the same idea for our LLM egress — one container speaking the
chat-completions wire format, returning fixed, shape-correct payloads, so the full pipeline runs
end to end with zero API spend and zero nondeterminism.

## 2. The one hard constraint: responses must echo IDs

This is where `mock-router` has to diverge from `mock-tube`, and it drives everything else.

mock-tube gets to be a static file server because yt-dlp asks for a URL and consumes whatever
comes back. Our worker doesn't — it **matches responses back to the request by ID**:

- `validate_translation_response` (`worker/src/worker/services/translation.py:243`) keeps only
  items with a non-empty string `id`, and `translate_batch_llm` looks those up against the regions
  it sent. Region IDs come from the backend job payload
  (`worker/src/worker/handlers/translation.py:110`) and differ on every upload.
- `process_qa` does the same with `regionId`.
- Batch VLM OCR uses `region_{index}` (`worker/src/worker/handlers/ocr.py:645`), which *is*
  stable — but only for a fixed fixture image with deterministic bubble detection.

A static body with hardcoded IDs would be validated, matched against nothing, and dropped — the
pipeline would "succeed" while producing an empty page. The mock must parse each request and echo
its IDs back. That needs a real (small) HTTP service, not `return 200 '<json>'`.

Everything *else* is hardcoded: translated strings, scores, notes, confidences, token counts are
all fixtures. Only identifiers are dynamic.

## 3. Two ways in

The worker can be pointed at the mock through two entirely different code paths. They cost
different amounts of effort and cover different things, and we want both eventually.

### 3.1 Mode A — impersonate Ollama (recommended default)

The worker already has a first-class "local runtime" mode. Every handler branches on the provider
name:

```python
local_only = provider in ("ollama", "lmstudio")
```

— `handlers/translation.py:95`, `services/translation.py:790` (`translate_batch_llm`),
`handlers/qa.py:277` (`is_explicit_local`), `:783`, `:1075`. When that's true, the handler skips
all cloud tiers and calls `try_local_ai` / `try_local_vlm_vision`, which resolve their endpoint
from a **single env var**, `LOCAL_LLM_ENDPOINT`.

So setting `TL_MODEL_PROVIDER=ollama`, `QA_MODEL_PROVIDER=ollama`, `OCR_MODEL_PROVIDER=ollama` and
`LOCAL_LLM_ENDPOINT=http://mock-router:8080` routes **every** LLM and VLM call in the pipeline at
the mock, with **no code change and no `providers.json` change**. One knob.

Two further simplifications fall out of this:

- **The worker only ever speaks Ollama's OpenAI-compatible shim.** Nothing in the codebase touches
  the native Ollama API — no `/api/chat`, `/api/generate`, `/api/tags`, `/api/pull`. Both
  `try_local_ai` and `try_local_vlm_vision` append `/v1/chat/completions` if the endpoint doesn't
  already end in it. "Mock Ollama" therefore means "serve one OpenAI-compatible route", nothing
  more.
- **It sidesteps a hardcoded dispatch chain in QA.** See §3.3 — inventing a new provider name
  would *not* work; impersonating `ollama` does.

The cost: `try_local_ai` / `try_local_vlm_vision` build and send their own `requests.post` and
**bypass `LLMClient` entirely**. So Mode A gives excellent *pipeline* coverage and zero
*provider-layer* coverage — none of the retry, cooldown, routing, caching, or cost-estimation
logic in §1 is touched.

### 3.2 Mode B — substitute a cloud provider

To exercise `LLMClient`, the mock has to be reached through `PROVIDER_REGISTRY`. Two options:

1. **Make `baseUrl` interpolatable.** `ProviderConfigLoader` already runs `interpolate_env_vars`
   over `baseUrl` and supports `${VAR:-default}` (`provider_config.py:39,131`), so this is
   config-only and leaves production behaviour byte-identical:

   ```json
   "baseUrl": "${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1/chat/completions}"
   ```

2. **A separate `config/providers.mock.json`**, selected via the existing `PROVIDERS_CONFIG` env
   var (already mounted per-container). Better if the mock stack wants its own model catalogue —
   which it does, for the model-name scenario selection in §7.1.

A provider is only marked `active` when its key env var is non-empty, and `LLMClient.complete()`
returns `None` early if `api_key` is falsy — so the test stack must set a dummy
`OPENROUTER_API_KEY=mock-key`. (`resolve_key` in `config.py:174` is generic: it checks
`loader.providers[prov].api_key` first, so any provider name resolves as long as it has a
`keyEnvVar`.)

### 3.3 Why the mock must impersonate a *known* provider name

`handlers/qa.py` does **not** dispatch generically. `attempt_llm` is a hardcoded if/elif chain over
`openrouter` / `gemini` / `nvidia` that falls through to `return None` for anything else
(`qa.py:212-246`, and again at `:444-490` for the VLM path). A provider entry named `mock` would
load fine, resolve its key fine, and then silently produce **no QA results at all**.

So Mode B must reuse the name `openrouter` (pointed at the mock) rather than introduce a new one,
and Mode A works precisely because `ollama` has its own explicit branch. The if/elif chain is worth
fixing on its own merits — it's the reason `providers.json` is only *half* the source of truth for
QA — but that's a separate task, not a blocker.

### 3.4 Coverage summary

| Call path | URL source | Mode A | Mode B |
| :--- | :--- | :--- | :--- |
| `try_cloud_ai` / `_vision` / `_vision_batch` → `LLMClient` | `providers.json` | bypassed | ✅ |
| `handlers/qa.py` LLM + VLM QA | as above / local branch | ✅ | ✅ (as `openrouter` only) |
| `try_local_ai`, `try_local_vlm_vision` | `LOCAL_LLM_ENDPOINT` | ✅ | n/a |
| `try_cloud_ocr` / `perform_redo_ocr` | **hardcoded** URLs (`services/ocr.py:111,140,173,191`) | ❌ | ❌ |
| `try_deepl`, `try_google_translate` | **hardcoded** (`translation.py:528,570,942`) | ❌ — kill via `DISABLE_DEEPL_TRANSLATE` / `DISABLE_GOOGLE_TRANSLATE` | same |

`try_cloud_ocr` is the one genuine hole in both modes: single-crop cloud OCR and the whole QA
re-OCR escalation loop would reach for `api.openai.com` / `openrouter.ai` regardless. See §9.

## 4. Response contracts

Four shapes, all delivered as a **JSON string inside the assistant message content** (the worker
`json.loads` it afterwards — do not return a nested object). All four are consumed identically in
both modes; only the *request* differs.

### 4.1 Translation — `TRANSLATION_JSON_SCHEMA`

IDs echoed from the `bubbles_json` array in the user message.

```json
{"translations":[
  {"id":"<echoed>","translation":"So this is the place.","translationNotes":"",
   "emotion":"neutral","tone":"plain","translationScore":0.94}
]}
```

### 4.2 QA — `QA_JSON_SCHEMA` (`handlers/qa.py:28`)

`regionId` echoed. The optional `directFix` / `escalation` objects are what make the QA feedback
loop and the re-OCR handler reachable, so fixtures must include variants that emit them —
`qaStatus` cycling through `passed`, `failed`, `direct_fix`, `reject_sfx`.

```json
{"results":[
  {"regionId":"<echoed>","qaStatus":"passed","qaScore":0.91,"qaFeedback":"Reads naturally."}
]}
```

### 4.3 Batch VLM OCR

IDs echoed from the `Region ID: region_N` text parts interleaved between the image parts.

```json
{"results":[{"id":"region_0","text":"ここは……","confidence":0.97}]}
```

### 4.4 Single-crop OCR — `OCR_SINGLE_SCHEMA` (`services/ocr.py:40`)

```json
{"text":"ここは……","confidence":0.97}
```

### 4.5 Envelopes

OpenAI-compatible (`/v1/chat/completions`) — `model` echoed, `usage` populated so `estimate_cost`
and the cache-hit logging in `_parse_response` actually run:

```json
{"id":"chatcmpl-mock-0001","object":"chat.completion","model":"<echoed>",
 "choices":[{"index":0,"message":{"role":"assistant","content":"<json string>"},"finish_reason":"stop"}],
 "usage":{"prompt_tokens":1240,"completion_tokens":180,"total_tokens":1420,
          "prompt_tokens_details":{"cached_tokens":1024}}}
```

Anthropic (`/v1/messages`, Mode B only):

```json
{"content":[{"type":"text","text":"<json string>"}],
 "usage":{"input_tokens":1240,"output_tokens":180,"cache_read_input_tokens":1024}}
```

Ollama's shim returns the OpenAI envelope, so Mode A uses the first form unchanged. Note both
`try_local_ai` and `try_local_vlm_vision` read `choices[0].message.content` and ignore `usage`
entirely — populating it is harmless and keeps one envelope builder for both modes.

## 5. Telling the requests apart

**This differs by mode, and Mode A is the harder one.**

In Mode B every structured call carries its schema at `response_format.json_schema.schema`, so
routing is exact and needs no heuristics:

| Marker in request | Task |
| :--- | :--- |
| schema has `properties.translations` | Batch translation (§4.1) |
| schema has `properties.results.items.properties.regionId` | QA (§4.2) |
| schema has `properties.results.items.properties.id` + `text` | Batch VLM OCR (§4.3) |
| schema is `{text, confidence}` | Single-crop OCR (§4.4) |

In **Mode A there is no schema on the wire at all**. `try_local_ai` and `try_local_vlm_vision`
collapse the schema down to Ollama's `format: "json"` flag
(`translation.py:491`, `:908`) and drop it otherwise. The mock must discriminate on:

- presence of `image_url` parts → a vision call (OCR or VLM QA) vs text-only (translation or LLM QA);
- `Region ID: region_N` markers → batch OCR;
- the system prompt text;
- shape of the user content (bubbles JSON vs regions metadata).

That last one is currently unreliable — see §9.1, where the system prompt for local QA is wrong.
Until that's fixed, the most robust Mode A discriminator is the **model name**, which the worker
passes through untouched from `LOCAL_LLM_MODEL` / `LOCAL_VLM_MODEL` / `ocrModel`. Setting
`LOCAL_LLM_MODEL=mock/tl` and `LOCAL_VLM_MODEL=mock/ocr` makes routing explicit and removes the
guesswork entirely.

## 6. Service design

FastAPI + uvicorn in a slim Python image, at `validation/mock-router/`. FastAPI because the worker
already carries it (health server) and the repo's `fastapi` skill applies — it keeps the
fixture-driven routing to a couple hundred lines.

```text
validation/
  docker-compose.test.yml
  mock-router/
    Dockerfile
    app.py                 # routing + envelopes + fault injection
    fixtures/
      translation.json     # per-scenario translated strings
      qa.json              # per-scenario qaStatus / directFix / escalation sets
      ocr.json             # per-scenario source text
    cassettes/             # recorded real traffic — see §8
    README.md
  fixtures/
    page-fixture-01.jpg    # deterministic 3-bubble test page
```

| Route | Purpose |
| :--- | :--- |
| `POST /v1/chat/completions` | OpenAI-compatible; serves both modes and all four contracts |
| `POST /v1/messages` | Anthropic-shaped, Mode B only |
| `POST /__control` | Set scenario / fault sequence for subsequent calls |
| `GET /__requests` | Return every captured request (payload + headers) for assertions |
| `DELETE /__requests` | Reset the capture buffer between tests |
| `GET /health` | Compose healthcheck |

`GET /__requests` is where much of the value sits — it's the only way to assert on the request side
of `LLMClient`: that `cache_control: ephemeral` got attached to the system message, that
`provider.sort == "price"` under `lowest-cost`, that `plugins: [{"id":"response-healing"}]` is
present for OpenRouter and absent elsewhere, that Anthropic got `x-api-key` and not `Bearer`.

## 7. Scenarios and fault injection

### 7.1 Scenario selection

1. **By model name** — model strings are ours to invent in both modes (`LOCAL_LLM_MODEL` in Mode A,
   the mock catalogue in Mode B), so `mock/tl-happy`, `mock/tl-rate-limited`, `mock/ocr-refusal`
   select behaviour per task with no extra plumbing. Deterministic, stateless, and doubles as the
   Mode A discriminator (§5).
2. **Via `POST /__control`** — for stateful sequences a single model name can't express, e.g. *"429
   twice with `Retry-After: 2`, then succeed"*, which exercises Tenacity backoff **and** the
   consecutive-429 cooldown escalation in one run.

### 7.2 Fault matrix

Each row maps to a branch with no over-the-wire coverage today. The `LLMClient` rows are **Mode B
only** — Mode A never reaches that code.

| Scenario | Mock behaviour | Branch exercised | Mode |
| :--- | :--- | :--- | :--- |
| `rate-limited` | 429 + `Retry-After: 2` | cooldown registry, escalation, `PROVIDER_CONSECUTIVE_429S` | B |
| `server-error` | 500 | `TransientAPIError` → retry → give up after 3 | B |
| `schema-reject` | 400 when `response_format.type == "json_schema"`, 200 on retry | `_degraded_format` degradation | B |
| `slow` | sleep past the 45s read timeout | `requests.exceptions.Timeout` | B (Mode A timeout is 300s) |
| `malformed` | 200, truncated/invalid JSON in content | `parse_and_validate_batch` failure + fallback | A + B |
| `refusal` | 200, `"I cannot process this image"` | the missing refusal heuristic already in [TODO.md](../../TODO.md) — makes the gap demonstrable | A + B |
| `empty-choices` | 200 with `choices: []` | `content = ""` fallback | A + B |
| `id-drift` | echo IDs with a suffix | proves ID matching is enforced, not silently ignored | A + B |
| `partial` | echo only half the requested IDs | unmatched-region fallback | A + B |

## 8. Record & replay — establishing the baseline

Hand-written fixtures prove the *plumbing*. They don't prove our prompts still work, and they drift
from reality as prompts change. The second phase of this is to capture real traffic once, then
replay it forever:

1. **Record.** Run the mock in proxy mode (`MOCK_ROUTER_UPSTREAM=https://openrouter.ai/...`):
   forward each request to the real provider, return the real response, and write both to
   `cassettes/`. Do this once over a small curated set of pages — a few pages per source language,
   plus deliberately awkward ones (dense SFX, vertical text, a page with no text at all, a page
   that trips the QA `failed` / `direct_fix` branches).
2. **Canonicalize.** Cassettes can't be keyed on the raw request: region IDs are per-upload
   (§2) and base64 crops vary with JPEG encoding. The key should be a hash of
   `(task, model, system prompt, ordered source texts)` with IDs and image bytes normalized out.
   Store the *position-ordered* response so replay can re-attach whatever IDs the live request
   carries.
3. **Replay.** Default mode. A cassette miss is a loud failure, not a silent passthrough — a miss
   means a prompt changed, which is exactly the signal worth catching.
4. **Baseline.** Once cassettes exist, they double as a **prompt regression** check: re-record
   against the real provider on demand and diff the new responses against the committed ones.
   A prompt edit that degrades output shows up as a diff instead of being discovered on a live run.

This is the same shape as VCR/pytest-recording cassettes; the only project-specific work is the
canonicalization in step 2, which the ID-echo constraint forces on us anyway.

Recording touches real providers and costs real money — it's an explicit, manually invoked mode,
never the default, and never runs in CI.

## 9. Prerequisites and bugs found while designing this

### 9.1 `try_local_ai` ignores its `prompt` argument — local QA is broken

`try_local_ai(prompt, text, response_schema, request_id)` (`services/translation.py:455`) never
references `prompt`. It hardcodes the system prompt:

```python
system_pr = MANGA_TRANSLATION_JSON_SYSTEM_PROMPT if response_schema else MANGA_TRANSLATION_SYSTEM_PROMPT
```

For translation this is merely redundant. For **QA it's a functional bug**: `handlers/qa.py:281`
and `:788` call `try_local_ai(prompt, json.dumps(regions_metadata), QA_JSON_SCHEMA)`, so the QA
prompt is discarded and the model is handed the *manga translation* system prompt with QA region
metadata as user content. It will answer with `{"translations": [...]}`; `parsed.get("results")`
then yields `[]`, and QA silently returns no results.

This matters for Mode A specifically: routing QA through a mocked Ollama would otherwise be
"validating" a path that cannot work. **Fix before Phase 1** — and note that mock-router is exactly
the tool that would have caught it.

### 9.2 `try_cloud_ocr` bypasses the provider registry

`services/ocr.py` builds its own `url`/`headers`/`payload` with hardcoded provider endpoints (lines
111, 140, 173, 191), ignoring `providers.json`. `perform_redo_ocr`, and therefore the QA re-OCR
escalation loop, inherits this. Route it through `LLMClient` + `PROVIDER_REGISTRY` like its three
siblings. Run `impact` on `try_cloud_ocr` first — it's on the QA escalation path.

### 9.3 Egress guard

Put the validation stack on an `internal: true` Docker network. Any path we missed then fails with
a connection error instead of quietly making a real, billed API call. Cheap, permanent regression
guard against reintroducing a hardcoded URL — worth keeping even after §9.2 lands. (Proxy/record
mode from §8 necessarily runs outside this network.)

## 10. Wiring

### Mode A — Ollama drop-in

```yaml
environment:
  - TL_MODEL_PROVIDER=ollama
  - QA_MODEL_PROVIDER=ollama
  - OCR_MODEL_PROVIDER=ollama
  - LOCAL_LLM_PROVIDER=ollama                      # selects `format: "json"` over `response_format`
  - LOCAL_LLM_ENDPOINT=http://mock-router:8080     # /v1/chat/completions is auto-appended
  - LOCAL_LLM_MODEL=mock/tl
  - LOCAL_VLM_MODEL=mock/ocr
  - DISABLE_LOCAL_LLM=false
  - DISABLE_DEEPL_TRANSLATE=true
  - DISABLE_GOOGLE_TRANSLATE=true
  - RATE_LIMIT=1000                                # don't sleep in tests
```

No `providers.json` change, no code change.

> One serialization caveat: `try_local_ai` and `try_local_vlm_vision` both wrap their request in
> `acquire_lock("local-llm")`, so **all** mocked calls serialize through a single Valkey lock. Fine
> for correctness, but it means Mode A can't be used to test provider-level concurrency — use Mode
> B for that.

### Mode B — cloud provider substitution

```yaml
environment:
  - PROVIDERS_CONFIG=/app/config/providers.mock.json
  - OPENROUTER_API_KEY=mock-key                    # any non-empty string
  - OPENROUTER_BASE_URL=http://mock-router:8080/v1/chat/completions
  - DISABLE_COST_CALCULATION=false                 # leave on if asserting cost accounting
```

Keep the provider *named* `openrouter` (§3.3).

## 11. Implementation phases

- **Phase 0 — prerequisites.** Fix §9.1 (`try_local_ai` prompt). Refactor §9.2 (`try_cloud_ocr`
  through `LLMClient`).
- **Phase 1 — Mode A + happy path.** Mock service, OpenAI envelope, four contracts with ID echo,
  model-name routing, `validation/docker-compose.test.yml` with db/redis/minio/backend/worker/
  mock-router on an internal network. Exit criterion: upload the fixture page, get a fully rendered
  translated page out, no network egress.
- **Phase 2 — Mode B + fault injection.** `providers.mock.json`, `/__control`, `/__requests`, the
  §7.2 matrix, tests asserting on captured request payloads.
- **Phase 3 — record & replay.** Proxy mode, cassette canonicalization, curated-page baseline (§8).
- **Phase 4 — E2E suite.** Wire into the Playwright item in [TODO.md](../../TODO.md); assert layer
  correctness and QA-loop transitions. Add a CI job — with cassettes committed it needs no secrets.

## 12. Out of scope

- Simulating model *quality*. Output is fixture or recorded text, so this can't validate
  translation or typesetting quality; that stays on real providers and
  [benchmarking.md](../archive/benchmarking.md). (§8 recording is the one place the two touch.)
- Mocking DeepL / Google Translate wire formats — they're disable-flagged; revisit only if those
  paths need coverage.
- Replacing the unit tests. `mock-router` covers integration; `worker/tests/` keeps covering logic.

## 13. Related

- [worker_provider_integration.md](../reference/worker_provider_integration.md) — the provider/registry
  architecture Mode B plugs into.
- [ollama.md](../guides/ollama.md) — the real local-runtime setup this mode impersonates.
- [testing_isolation_guide.md](../guides/testing_isolation_guide.md) — environment isolation for the
  existing unit suites.
- [models_and_prompts.md](../reference/models_and_prompts.md) — prompt and schema definitions the fixtures
  must satisfy.
- `yt-diff` `validation/mock-tube` — prior art.
