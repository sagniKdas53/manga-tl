# Archive

> Status legend: `[ ]` = not started, `[/]` = in progress, `[x]` = done, `[P]` = planned (in a plan doc), `[D]` = deferred

## Failed (Failed & Reverted)

### ML Models & Providers

- [D] **F.1 YOLO model upgrade** (Failed & Reverted) — current `juithealien/manga109-segmentation-bubble` (yolo11n) appears abandoned, only detects text bubbles. Upgrade to multi-class model (e.g. `ShadowB/Manga109-panel-balloon-text-yolov26-segmentation`) with size filtering fix.
  - **Re-evaluated 2026-08-03; do not retry as specified.** The exported artifact
    (`yolo26s_manga109.onnx`) is still in the worker model cache and was measured directly against
    yolo11n on 180 speech regions yolo11n missed. It recovers **4/180 (2.2%) at conf 0.25** vs
    yolo11n's 1/180, and **every region it recovered the contour search already recovered** — no
    additive value. It is not a size-filtering problem: yolo26s classes the irregular thought clouds
    as `text` (class 1), not `balloon` (class 2), so both models simply have not been trained on
    this shape. A future attempt needs a differently-*trained* detector, not a bigger one.
  - Integration note for whoever tries next: the two models have incompatible output layouts.
    yolo11n is `[1, 37, 33600]` (anchors last, single class, needs NMS); yolo26s is
    `[1, 300, 38]` end-to-end — `xyxy, score, class_id, 32 mask coeffs`, already NMS'd. The current
    `detect_bubbles_yolo` postprocess only understands the former, which is the likely reason the
    original attempt read as "failed".

- [D] **F.2 Add a free provider for testing** (closed 2026-08-04, no code written) — the ask was to
  add a no-cost provider to `config/providers.json` alongside `openrouter`, `cloudflare`, `nvidia`,
  `neurometric`. Two candidates were researched; neither is worth integrating. **Closed as won't-do.**
  - **uncloseai / unturf — the endpoints are dead, not shady.** Probed 2026-08-04:
    `hermes.ai.unturf.com/v1/models` → `502` (and `POST /v1/chat/completions` likewise),
    `qwen.ai.unturf.com/v1/models` → `403 "Access denied - This endpoint is closed"`,
    `ai.unturf.com` → connection failed. Only the `uncloseai.com` marketing site answers (`200`).
    It is a public-domain hobby project, not malicious — but there is no key, no rate-limit
    contract, no SLA. Independently of uptime it is the **wrong shape**: no vision models at all,
    which rules out `ocr` and `qaVLM` outright, and Hermes-3-Llama-3.1-8B is below the floor for
    JP→EN manga translation. The `free-ollama` link in the original issue was a model-aggregator
    wrapper over the same class of endpoint and was not pursued further.
  - **Mistral — technically viable, deliberately declined.** Wire-compatible with the existing
    `"type": "openai-compatible"` entry (`https://api.mistral.ai/v1/chat/completions`, Bearer
    auth), and `LLMClient._build_payload`'s generic branch already emits exactly the
    `response_format: {type: json_schema, json_schema: {name, schema, strict: true}}` Mistral
    wants. Free "Experiment" tier is ~1B tokens/month, no card. It was still declined:
    - **One RPM bucket vs. per-model limits.** `enforce_rate_limit` (`utils/rate_limit.py:37`)
      keys its bucket on *provider name* and `rateLimits` is a single integer, but Mistral's
      limits are per-model and span 180× (`mistral-large-2512` at 0.07 RPS → `ministral-3b-2512`
      at 12.50 RPS). The provider number must be pinned to the slowest model routed to; including
      `mistral-large-2512` anywhere pins the whole provider to ~4 RPM, i.e. a 14.3 s `time.sleep`
      before every call — taken while holding a light slot (AUDIT-W3) with `MAX_LIGHT_SLOTS=1`
      (AUDIT-W10). Worse than the 591 s p50 layout wait already measured.
    - **The 8-image cap.** `handlers/ocr.py` batches crops via `chunk_list(crops_payload, 10)`;
      Mistral's ceiling is 8 images / 10 MB per request, so batch OCR would `400` on every call.
      The chunk size is a hardcoded literal, not provider-aware.
    - **Not frontier, and weakest where it matters.** Mistral's multilingual strength is European
      languages; JP/KO/ZH is not what these models are tuned for, which is precisely the axis this
      pipeline is judged on.
    - **Free tier trains on your data by default** (input *and* output); opt-out is manual in
      Admin Console → Privacy.
    - `mistral-ocr` is **not** a chat-completions model — it is a separate Document AI product on
      `/v1/ocr` returning `pages[]/markdown/blocks`. It cannot go through `LLMClient` and would be
      its own integration. It also did not appear in the account's Limits page at all.
  - Account limits captured at research time are in `logs/mistral/` (three Limits-page
    screenshots). If this is ever revived, read model IDs from `GET /v1/models` — the published
    docs gave three mutually inconsistent ID formats for the same models.
  - Integration notes for whoever tries next, since they were verified and are cheap to lose: a new
    openai-compatible provider needs only a `providers.json` entry plus its key in
    `secrets/api_keys.json` (mounted as `DOCKER_SECRETS_JSON`, `docker-compose.yml:191`) and
    `scripts/seed_secrets.py`; `ProviderConfig.resolve_key` (`config.py:190`) consults the
    providers.json loader before the hardcoded `env_var_map` at `:201`, so that map is a fallback
    only. Backend and frontend need no changes — the `"openrouter"` literals there are
    is-openrouter special-casing for the routing-strategy UI, not allowlists.
  - **Side finding, folded back into `issues.md`:** AUDIT-W1's claim that QA dispatches on a
    hardcoded `openrouter`/`gemini`/`nvidia` if/elif chain is **stale**. Those chains are gone;
    `_qa_cloud_llm` / `_qa_cloud_vlm` (`handlers/qa.py:200`, `:219`) are provider-generic. Only the
    `QA_DEFAULT_*_MODELS` fallback maps at `:38-46` still name three providers, and only when no
    model resolves.

## ✅ Completed (Archive)

### The 2026-08-05 seventh sitting — AUDIT-P5, which completes AUDIT-P4

**AUDIT-P5 [H] — callbacks resolve "which job" by guessing instead of by `jobId`. Fixed.**

The finding was accurate as filed, including its claim on P4. `claimCallback` ran the right
conditional UPDATE but picked its row with `findFirstByImageIdAndTypeOrderByCreatedAtDesc` — so the
idempotency guard was keyed off the ambiguous identifier it existed to make safe. Claiming the wrong
row mis-marked that row *and* left the real one unclaimed, so the genuine callback was free to apply
twice: two claims that should have collided both succeeded, which is the precise failure P4 was
closed to prevent.

**What changed.** `jobId` — already minted by `enqueueJobDirectly`, already the job row's primary
key, already in the worker payload — is now echoed back on every callback and used to resolve the
row exactly.

- A new `resolveCallbackJob(jobId, imageId, jobType)` prefers `findById`, falling back to the old
  newest-of-type query only when a callback carries no `jobId` (a worker predating this change). A
  `jobId` that resolves to a row of a *different type* is refused rather than claimed — that would
  mean the callback reached the wrong endpoint, and acting on it would mis-mark an unrelated job.
- `claimCallback` and `failJob` both route through it, as do the two inline job lookups that had
  their own copy of the guess (the OCR zero-regions branch and the translation all-failed branch).
- All seven handlers thread it: `panel-detection` and `ocr` read it off their DTOs; `layout`,
  `translation`, `qa-re-ocr`, `render` and `qa` take it as a new first parameter, with the previous
  arities kept as delegating overloads passing `null` — the same idiom the file already used for
  the `pageId` retrofit.
- `PanelCallbackDto` and `OcrCallbackDto` gained a `jobId` component, which is the OpenAPI change;
  `frontend/src/api/schema.d.ts` was regenerated against a rebuilt backend.
- Worker: all **12** callback-payload sites across 8 handler files now send
  `"jobId": job_data.get("jobId")`.

**Verified red-green.** `testHandleOcrCallback_ClaimsTheJobNamedByJobIdNotTheNewest` sets up an
original job plus a newer redo for the same image and calls back naming the original. With
`resolveCallbackJob`'s id branch disabled it fails on exactly the right assertion — *"the callback
named the original job — that is the row that must be claimed"*, expected not-null — and passes
with it restored.

**Note for the next sitting:** `mvn -o test-compile` silently no-ops when it decides sources are
unchanged, and reported BUILD SUCCESS over five real constructor-arity errors. `mvn -o clean
test-compile` caught them. Do not trust an incremental Maven compile as evidence.

**AUDIT-P7 [M] — page-scoped Redis keys are written and never read. Fixed.**

Accurate as filed, all three bullets. `triggerPageRedo` wrote
`page:{ocr,translation}:reason:{pageId}` — and nothing in backend, worker or frontend reads a
page-scoped reason key. The consumers (`:927`, `:1368`) read `image:…:reason:{imageId}`, so a
page-level re-OCR never got its `(manual-re-ocr)` layer label and the key just accumulated. The
same function's `delete("pipeline:trace:" + pageId)` named a key written under **imageId**, so it
was a no-op and the redo inherited the previous run's trace id. `triggerImageRedo` already did
both correctly, which is what marks it a typo rather than a design. `imageId` was already resolved
one line above both statements.

The entry's third bullet — the `image:*:reason:` keys are written with no TTL, so a pipeline that
dies before its callback leaves a key that mislabels the *next* run — is fixed too, via a
`REDO_REASON_TTL` of 24h applied at all six write sites. The consumer deletes the key after
reading, so the TTL only ever catches the abandoned case.

**Verified red-green.** `testTriggerPageRedo_UsesImageScopedKeys` seeds a stale trace id, runs the
redo, and asserts the image-scoped reason key is set, the page-scoped one is not, and the trace id
changed. Reverting the two key names fails it on the first assertion.

**AUDIT-W4 [M] — the Valkey lock is per-container and releases other holders' locks. Fixed, with
one correction to the finding.**

Both defects were real. The key embedded `platform.node()` unconditionally, so every lock was
per-container; for `local-llm` that defeated it entirely, because `LOCAL_LLM_ENDPOINT` resolves to
a *shared* address — the `ollama` compose service, or LM Studio on the host — so N workers each
took their own lock and then hit the one instance concurrently. And the release was an
unconditional `DELETE`, so with `timeout == expire == 600` a holder that overran its TTL deleted
whatever lock had been acquired since.

**Where the finding is wrong:** it treats the node id as wrong everywhere, but the `ocr` lock
*should* be per-container. Its own comment says it serialises PP-OCR-Det and YOLO "on this host" to
avoid CPU/GPU overload — a deployment-wide `ocr` lock would serialise detection across the whole
fleet. So the fix adds `node_scoped` (default `False`, the global behaviour the finding asks for)
and passes `True` at that one call site, rather than stripping the node id everywhere.

The lock value is now a random token and the release is a compare-and-delete Lua script; a
mismatch warns instead of silently freeing someone else's lock.

**Verified red-green, each defect in isolation** — restoring the node id fails the global-key and
timeout tests; restoring the unconditional delete alone fails the other-holder test. New
`worker/tests/test_lock.py`, 5 tests; the lock had none before.

**AUDIT-W7 [M] — the stale-job check hammers the heaviest endpoint, without a timeout. Fixed.**

Accurate as filed. `check_stale_job` was the only `requests` call in `rq_tasks.py` with no
`timeout` — every sibling has `timeout=5` — so a wedged backend held a worker slot open
indefinitely. And it called `GET /api/internal/images/{imageId}`, which generates a presigned URL
and loads every panel, page, OCR region, layer element and conversation, then read nothing but
`status_code`. Every job paid for that before doing any work.

Fixed by taking the finding's first suggestion: a dedicated `HEAD` handler on the *same* path,
touching only `existsById`, so the worker changes only its verb. A `@GetMapping` alone would not
have helped — Spring answers HEAD by running the GET handler and discarding the body, so the
expensive loads still happen; the explicit HEAD mapping is what avoids them. Plus `timeout=5`.

**Verified red-green.** Moving the HEAD mapping off the path makes the request fall through to the
GET handler and 404 in the unit test. The worker tests assert `requests.get` is never called and
that the timeout is 5.

### The 2026-08-06 ninth sitting — AUDIT-P8, pipeline trace lifetime

**AUDIT-P8 [M] — `pipeline:trace:` expired mid-pipeline. Fixed, accurate as filed.**

Both `Duration.ofHours(2)` calls were where the entry said they were. `startPipeline` wrote the key
with a 2-hour TTL and nothing ever refreshed it, so the window ran from the *start of the pipeline*;
`enqueueJobDirectly` minted a fresh id whenever it found the key gone. The 50-page run in
`logs/run-3-fresh.log` took about two hours, which is why traces were splitting.

The entry offered two fixes — a longer TTL, or moving the trace onto the `Job` row. Neither on its
own is right. A longer TTL is still a bound picked in advance against an unbounded pipeline: whatever
number you choose, a big enough chapter beats it. So the fix is both halves of a sliding window:

- `PIPELINE_TRACE_TTL = Duration.ofHours(12)`, one constant replacing both literals, documented in
  the same shape as AUDIT-P7's `REDO_REASON_TTL` right above it.
- **Every hand-off through `enqueueJobDirectly` now calls `expire()` on the key it just read.** The
  TTL therefore has to outlive a single *stage*, not a whole run — and a stage that stalls is
  already given up on by the worker's stale sweeper after ten minutes. The bound stays only to stop
  a pipeline that dies between stages from leaking the key forever.

Moving the trace to the `Job` row was not done: the key is read before the `Job` row exists in
`enqueueJobDirectly`, so that is a restructure, not a fix.

**The first version of the test passed with the defect reinstated — the fifth instance.** The
in-memory Redis fake in `JobCoordinatorServiceTest` accepted a `Duration` on `set` and dropped it on
the floor, so *every* TTL assertion in that class was vacuously true; the fake had to learn TTLs
before it could test them. Then the fixed test still passed with the 2-hour literal restored,
because `startPipeline` hands straight off to `enqueueJobDirectly`, whose new sliding refresh
overwrites the initial TTL before any assertion can read it. Asserting on the surviving value tests
the refresh, not the write. The fake now records **every** TTL applied to a key, in order, and the
test asserts over the whole history. Caught only by reverting the two defects individually.

Backend 401 (was 399, +2). Both defects verified red in isolation, each failing only its own test.

### The 2026-08-05 eighth sitting — AUDIT-W8 and W9, the last two [M] worker findings

**AUDIT-W8 [M] — provider payload defects in `LLMClient`. Fixed, all four remaining bullets.**

Accurate as filed on all four, but **its severity was overstated for one deployment-specific
reason worth recording: `config/providers.json` has no `anthropic` provider at all** — only
`openrouter`, `cloudflare`, `nvidia` and `neurometric`. The Anthropic branch is therefore reachable
only through the hardcoded fallback registry in `provider_config.py`, which fires when
providers.json fails to load or parses empty. That is a live path, not a dead one, so the fix
stands; but nothing was silently producing unstructured Anthropic output in the current
deployment, because nothing was reaching Anthropic at all.

- **No JSON enforcement on Anthropic.** The whole `response_format` ladder sat inside the `else`.
  Anthropic has no `response_format`; the Messages API spells structured output as
  `output_config.format`, and its `json_schema` variant takes the schema **directly**, not wrapped
  in the OpenAI `{name, schema, strict}` object. Structured outputs are not available on every
  Anthropic model and there is no `json_object` tier to step down to, so the existing 400-degrade
  ladder gained a second arm that *drops* `output_config` and lets the caller's JSON system prompt
  carry it — i.e. degrades deliberately to the pre-fix behaviour instead of failing the call.
- **`content: null` → `TypeError`.** `.get("content", "")` returns `None` when the key is present
  and null, which is what providers send alongside a `refusal`; a default only applies to a
  *missing* key. Now `or ""`. **The Anthropic branch had the same bug one level over** and the
  entry did not mention it: `content[0]` is not reliably the text block once thinking is on, and
  `.get("text")` is `None` on any block that is not text. It now selects the first `text` block.
  That is the fifth time reading past the headline found real work.
- **Import-time registry.** The loader now tracks providers.json's mtime and `LLMClient.__init__`
  reloads when it changed — one `stat` on a call about to spend seconds in HTTP. The registry dict
  is mutated in place rather than rebound, because `translation.py` and the test suite hold
  references to that exact object. `load_and_validate` also had to start clearing `self.providers`:
  its loop only ever added, so a reload would not have dropped a deleted provider.
- **Lost 429 increments.** The consecutive-429 count is a read-modify-write over a dict shared by
  every job thread, so concurrent 429s from one provider collapsed into a single increment and the
  backoff stayed flat at exactly the load that produces them. Extracted to `_register_rate_limit`
  under a module lock. Single-key reads elsewhere stay unlocked on purpose — a stale cooldown read
  costs one extra attempt and nothing else.

Also replaced the fallback registry's `claude-3-5-sonnet-20241022`, **retired 2025-10-28**, so that
branch could only ever have 404'd even when it was reached.

**A test that passed for the wrong reason — the third instance, and a new mechanism.** The
concurrency test originally took the `no_retry_sleep` fixture, which patches
`worker.services.llm_client.time.sleep`. That patches the attribute on the **shared `time` module
object**, so the test's own interleaving delay was neutralised too and it passed with the lock
removed. It also mattered *where* the delay sat: sleeping before the read lets every other thread
finish its whole read-modify-write first, which serialises them and hides the race. Reading first
and then holding the stale value across the window reproduces it — 24 threads, 18 recorded.

**Verified red-green by reverting each of the six changes individually**, per the standing rule.

**AUDIT-W9 [M] — local JSON mode is not actually enforced. Fixed.**

Accurate on the mechanism. Both local call sites set `payload["format"] = "json"` for Ollama —
the field name for Ollama's **native** `/api/chat`, while the endpoint is its OpenAI-compatible
`/v1/chat/completions` shim, which ignores the unknown key. The `else` branch already sent the
right thing for every other local provider, so the conditional collapses entirely.

Confirmed against the deployed instance rather than from documentation — same prompt, model and
endpoint:

| sent | returned |
| --- | --- |
| `response_format: {"type": "json_object"}` | `{"key": "a", "value": 1}` |
| `format: "json"` | `"Sure! Here is an example..."` plus a ` ```javascript ` fence |

The four-way default split is closed too: `try_local_ai` alone said `lmstudio`/`gemma3:4b`, so it
resolved a different endpoint *and* took the other side of the format branch from the deployed
configuration — which is exactly why the bug was never seen in the one place anyone would look.
Both call sites now default to `ollama`/`gemma4:e4b`, matching `docker-compose.yml` and
`.env.example`.

**AUDIT-T2 — error-branch coverage. Closed as already done; nothing was written for it.**

The entry had been narrowed to a single outstanding item: *"AUDIT-P3's fix was a `break` rather than
a `continue` … and no test is named for it. A test that queues an undispatchable job ahead of a
dispatchable one and asserts the second still goes out would pin it."*

That test already exists. `WorkerDispatcherServiceTest.testDispatchJobs_StuckQueueDoesNotBlockThe
RestOfItsSlotClass` queues a stuck job on `queue:qa-re-ocr` and a dispatchable one on `queue:ocr`,
asserts the first is re-pushed and the second still dispatched, and carries a Javadoc naming
AUDIT-P3 — including why it uses a 500 rather than a 429 (a 429 also drops the worker from the
capacity map, which would mask the defect). `git log -S` puts it in **`19cab6f`, the same commit as
P3's fix**. It was never open; the entry simply did not know.

**It was checked, not assumed.** Reverting `break` to the pre-P3 `return` fails it on exactly the
right assertion — `leftPop("queue:ocr")` wanted, never invoked, because the whole slot class was
abandoned. Restored, 26/26 pass.

**A new instance of the Maven trap, and a worse one.** The first full-class run *passed* with
`return` in place. The documented failure mode is `mvn -o test-compile` silently no-op'ing; this was
`mvn -o test` reporting 26/26 green against classes compiled before the edit, because a
backgrounded run raced the source change. `mvn -o clean test`, or a single-method rerun after the
compile had definitely landed, showed the real result. **Treat a green Maven run that started near
an edit as no evidence at all** — the only trustworthy signal is `clean`.

#### Where a finding was wrong — the eleventh time

**AUDIT-W9's claim that `gemma4:e4b` "is not a real tag (probably meant `gemma3n:e4b`), so the
shipped default pulls nothing" is false.** The tag exists on the deployed Ollama host: `gemma4:e4b`,
family `gemma4`, 8.0B, Q4_K_M, pulled 2026-07-05. Obeying that bullet would have renamed a working
default to a non-existent one and broken the local path outright — the exact inversion of the
finding's stated intent. Check a claim about the runtime *against the runtime*, not against
plausibility: the tag looks like a typo for `gemma3n:e4b` and is not one.

### The 2026-08-05 verification pass — `issues.md` triaged against the code

*Retired from `issues.md` on 2026-08-05. No code changed in this pass; every entry below was read
against the working tree and closed. Six were found **already fixed while still marked open**,
which is the fourth, fifth and sixth time that has happened (after AUDIT-B6, AUDIT-D1 and P9's
wrong mechanism). The lesson is now unambiguous: `issues.md` status is evidence of what someone
intended, not of what the code does.*

**Found stale during this pass — no commit closed them because they were already closed:**

| id | sev | filed as | actually |
| --- | --- | --- | --- |
| AUDIT-P1 | H | `resolveConfigForChapter` passes `translation`/`qa` as task keys | **Fixed.** `JobCoordinatorService:646-655` passes `tl` / `qaLLM` / `qaVLM`, with a nine-line comment naming AUDIT-P1 and explaining the duplicate-page consequence. |
| AUDIT-P4 | H | job recovery re-runs work; callbacks are not idempotent | **Fixed.** `jobs.callback_applied_at` + `JobRepository.claimCallback` — a conditional `UPDATE … WHERE callback_applied_at IS NULL` — guards **all seven** handlers (`panel-detection`, `ocr`, `layout`, `translation`, `qa-re-ocr`, `render`, `qa`). The 2026-08-02 fix order recorded this; the entry itself never did. |
| AUDIT-W6 | M | slot maths can compute to zero or negative, nothing validates | **Fixed.** `concurrency.py:resolve_slot_config` clamps each below-1 value to 1, warns on over-subscription, and its docstring quotes the finding's own two examples back. |
| AUDIT-W10 | C | `MAX_LIGHT_SLOTS=1` serialises four workloads | **Fixed by config.** `docker-compose.yml:236-238` is `CONCURRENT_JOBS=5` with both `MAX_` values blank so light derives to 4; `.env.example` is 5 / 1 / 4. The measured `2/1/1` that produced the 591 s median layout wait is gone. |
| AUDIT-W8 (1 of 5) | M | Anthropic `max_tokens` hardcoded to `4096` | **Fixed.** Now `DEFAULT_MAX_OUTPUT_TOKENS` on **both** payload branches. The other four bullets are untouched and stay open. |
| AUDIT-B8 (1 of 9) | L | `JwtAuthFilter` registered twice | **Fixed.** `SecurityConfig:105` `FilterRegistrationBean.setEnabled(false)`. The other eight bullets stay open. |

**AUDIT-P4's residual is AUDIT-P5, and that linkage is load-bearing.** `claimCallback` resolves
*which* job to claim with `findFirstByImageIdAndTypeOrderByCreatedAtDesc` (`:709`) — the exact guess
AUDIT-P5 is about. So the idempotency guard is keyed off the ambiguous identifier it was meant to
make safe. With a redo in flight, or an image backing pages in two chapters, the guard can claim the
wrong row. P5 was already open; this makes it the correctness item rather than a tidiness one.

**AUDIT-T2's backend half was re-scoped by events, not by anyone editing it.** The entry says "none
of the dispatcher's failure paths are exercised, so AUDIT-P2 and AUDIT-P3 have no test to fail."
`WorkerDispatcherServiceTest.java` is now 639 lines and covers `PermanentRejection_400`,
`PermanentRejection_422`, `MultipleWorkers_AllFail`, `FirstThrowsExceptionSecondAccepts`,
`ServerError500`, `CapabilitiesQueryFails`, `AllWorkersInCooldown` and `LightSlotFull`. Those
arrived with P2's and P3's fixes. What is left is narrower and stays open — see `issues.md`.

**Entries closed on their own recorded status** (verified present in the tree, not re-derived):
`try_local_ai`, the `configuration_guide.md` item, AUDIT-P2, P3, P9, W5 (WON'T DO), W11, W12,
B1, B2, B3, B4, B6, B7, D1, D2, D3, D4, F3, F4, F5, F6, F7, plus the two superseded ordering
sections ("Status of the fix order — 2026-08-02" and "Suggested fix order").

The entries below are reproduced **verbatim**, so their heading levels and `+` bullets are the ones
`issues.md` used rather than this file's. Lint is suppressed across the block for that reason only.

<!-- markdownlint-disable MD001 MD004 -->

<details>
<summary>The archived entries, as they read in issues.md</summary>

## `try_local_ai` ignores its `prompt` argument — **RESOLVED 2026-08-05**

Fixed in worker `2b37cdd` (pointer bump `e8ccb49`). The caller's prompt now becomes the system
message; the hardcoded translation prompts remain the default for a caller that supplies none.
Regression tests assert on the outgoing payload, since the failure mode was silence. Detail in
[archive.md](./archive.md) under *The 2026-08-05 sitting*.

## Update the `configuration_guide.md` once everything is done

We need to document how to setup the whole app like what needs to be populated in `.env` and
what needs to populated in the secrets, how to set up the `providers.json` and other small
stuff.

**Status:** `configuration_guide.md` now covers env vars, slot allocation, and the model
inheritance hierarchy in real depth — but it still has no section on Docker secrets file setup
or on `providers.json` structure/editing, so the original ask isn't fully done yet.

---

#### AUDIT-P1 **[H]** — chapter/series model overrides are silently discarded in `resolveConfigForChapter`

`config/providers.json` keys its model lists as `tl`, `qaLLM`, `qaVLM`, `ocr` (verified across all
four providers). `enqueueJobDirectly` uses those keys correctly. But
`JobCoordinatorService.resolveConfigForChapter:613-621` passes task names that **do not exist**:

| call site | task passed | valid? |
| --- | --- | --- |
| `:605` ocr | `"ocr"` | ✅ |
| `:614` tlModel | `"translation"` | ❌ (should be `tl`) |
| `:619` qaLlmModel | `"translation"` | ❌ (should be `qaLLM`) |
| `:621` qaVlmModel | `"qa"` | ❌ (should be `qaVLM`) |

**Confirmed 2026-08-02.** `ProviderConfigCache.isValidProviderModel` does `pData.models.get(task)`
and returns `false` on a null list, so `resolveModelWithCheck` **always** discards the resolved
value and returns the global default.

Scope correction: `resolveConfigForChapter` is **not on the dispatch path**. The job payload is
built by `enqueueJobDirectly`, which passes the correct keys (`tl`, `qaLLM`, `qaVLM`) and uses a
plain `resolveModel` — no validity check — for `ocrModel`. So the pipeline is unaffected; the defect
is confined to the duplicate-page config comparison in `PageController` and `SeriesController`. Net effect: the duplicate-page config comparison in
`PageController:118-119` and `SeriesController:313-314` compares global defaults against global
defaults, so it will report two chapters as configuration-identical when they are not, and the
clone path will make the wrong call about whether OCR/TL data can be reused.

#### AUDIT-P2 **[H]** — the dispatcher drops permanently-rejected jobs without failing them

`WorkerDispatcherService:218-227`: on a `400`/`422` from the worker the job is popped off Redis and
`sent = true; // prevent re-push to queue`. Nothing marks the DB row `FAILED`. The row stays
`PENDING` forever:

+ `recoverStaleProcessingJobs:131` only scans `PROCESSING`, so the sweeper never sees it.
+ `requeuePendingJobs:538` *will* re-push it — but only on the next backend restart, at which point
  it gets rejected again, silently, forever.

The user-visible symptom is a pipeline that stops at a stage with no error anywhere in the UI.

**Status: DONE 2026-08-05 (`11c79da`).** A permanent rejection now marks the row `FAILED` with the
status and body in `jobs.error`, and emits `job_update` so a live reader sees it without a reload.
Best-effort by design: the job is already off the queue, so a DB or SSE failure there must not abort
the rest of the dispatch cycle. Verified red-green.

#### AUDIT-P3 **[H]** — one undispatchable job blocks every remaining queue in its slot class

`WorkerDispatcherService:254-263` — when no worker accepts a job it is pushed back and the method
`return`s, abandoning the rest of the loop. `HEAVY_QUEUES` is ordered
`[qa-re-ocr, region-redo-ocr, ocr, panel-detection]`, so a single stuck job on `queue:qa-re-ocr`
prevents `queue:ocr` from being polled *at all* for that cycle. `continue` to the next queue is
almost certainly what was meant. This is head-of-line blocking across unrelated work.

**Measured 2026-08-02: real bug, not currently costing throughput.** On the drained run a slot sat
idle *with work queued in its own class* in only **3.2%** (light) / **1.3%** (heavy) of 3,253
samples. Worth fixing as a latent correctness issue, but it is not the cause of the throughput
complaint at the top of this file — see AUDIT-W10.

**Status: DONE 2026-08-05 (`19cab6f`).** `break` rather than the suggested `continue` — the two are
equivalent here because the `while` condition is already false at that point, but `break` says "stop
draining this queue" outright. The commit explicitly declines to claim a throughput win.

#### AUDIT-P4 **[H]** — job recovery re-runs work the worker is still doing

Two paths requeue a job without telling the worker to stop:

+ `resetProcessingJobsToPending:99-124` at every backend boot. The worker is a *separate container*
  that does not restart with the backend, so its in-flight OCR keeps running.
+ `recoverStaleProcessingJobs:128-160` after a 10-minute silence — shorter than a slow cloud-VLM
  OCR pass on a busy page.

Because none of the callback handlers are idempotent (`handleOcrCallback:734-817` unconditionally
`saveAll`s a fresh region set and creates a new layer; `saveJobCosts` likewise), the duplicate run
produces **a second full set of `ocr_regions`, a second layer, and double-counted cost**. There is
no dedup key, and the `jobId` that would provide one is already in the payload but unused
(AUDIT-P5).

**Confirmed 2026-08-02 — this is the one correctness defect measurably costing work.** The drained
run logged **277 dispatches for 255 jobs (22 re-dispatches)** and produced 12 duplicate
`(subject, type)` rows across 4 subjects; `e185e276` ran `translation`, `qa` **and** `render` 3×
each. `translation` shows n=50 for 42 pages.

`worker_pull_model.md` §5.4 already proposes the cancellation tombstone that fixes half of this;
the idempotency half is not tracked anywhere.

#### AUDIT-P9 **[M]** — regions and layers get written with `page_id = NULL`

`handleOcrCallback:713` allows `page` to be `null` (`resolvePageForCallback` returns `null` when the
page was deleted between enqueue and callback). It is then passed straight into
`region.setPage(page)` (`:740`) and `ocrLayer.setPage(page)` (`:795`) with no guard. The rows save
successfully and are then invisible to every `findByPageId` query — silent orphans that still count
against cost. Guard and abort the callback instead.

**Status: DONE 2026-08-05 (`a8abea3`) — and the mechanism above is wrong.** The rows do *not* save
successfully. `ocr_regions.page_id` and `layers.page_id` are `NOT NULL` both in the entity mapping
(`@JoinColumn(nullable = false)`) and in the live schema — checked against the running database and
with a throwaway Testcontainers probe, which threw `ConstraintViolationException: null value in
column "page_id"`. There are no silent orphans and there never were. What actually happened is a
`DataIntegrityViolationException` at commit that rolls back the *entire completed OCR result*; the
job then sits `PROCESSING` until `recoverStaleProcessingJobs` requeues it, the whole expensive OCR
pass runs again and fails identically, up to `maxAttempts`. Real defect, wrong reason, and worse on
cost than "still count against cost" suggests. The guard now fails the job once with a reason.

#### AUDIT-W5 **[M]** — `REUSE_IDLE_SLOTS` is dead code in the push model

> **WON'T DO — closed 2026-08-04.** Re-measured payoff is **1.8%**, down from the 13.0% that put
> this at the top of the list, and at that size lending the slot is probably not even the right fix.
> Two corrections to the text below, both made by reading the code on 2026-08-03: `REUSE_IDLE_SLOTS`
> **is** read (`worker/src/worker/main.py:206`), and the method is `hasLightSlot()` at
> `WorkerDispatcherService.java:334`, not `:318`. Kept rather than deleted so this does not get
> re-derived. See `docs/archive.md`.

The worker will accept a light job into a spare global slot (`main.py:171-175`) and reports
`overflow_light_jobs` in `/capabilities`. But the backend gates dispatch on
`WorkerDispatcherService:318` `hasLightSlot() → activeLight < maxLight && activeTotal < maxTotal`,
which never allows the overflow. So the feature can only ever fire for a job the dispatcher would
not have sent. Either teach the dispatcher about it or delete the flag.

**Confirmed 2026-08-02.** Across 3,253 samples of a clean drained run, `active_light` **never
exceeded 1**, despite the worker reporting `reuse_idle_slots=true` and the heavy slot being free
95.9% of the time. Every previous run that touched this was contended; this one was not.

#### AUDIT-W10 **[C]** — `MAX_LIGHT_SLOTS=1` serialises four wildly different workloads

*Added 2026-08-02 from the first drained run. This is the largest measured throughput lever in the
codebase and it is a config change, not code.*

`environment.md` for run `20260802-163445`:

```txt
max_concurrent_jobs=2, max_heavy_slots=1, max_light_slots=1, reuse_idle_slots=true
```

Four light stages share that one slot, and their per-job costs differ by three orders of magnitude:

| light stage | total work | share of light tier | work p50 |
| --- | ---: | ---: | ---: |
| qa | 2,083 s | 52.4% | 53.8 s |
| translation | 1,774 s | 44.6% | 30.5 s |
| render | 96 s | 2.4% | 1.0 s |
| layout | 24 s | 0.6% | **0.2 s** |

So a **0.2 s** layout job queues behind 30–110 s LLM calls, one at a time, for a **591 s median
wait**. Little's law closes the loop: mean layout queue depth 4.49 × 7,924 s ÷ 42 jobs = 847 s
predicted vs 879 s measured.

**The tier that bounds throughput has flipped.** Every throughput argument in `docs/` still assumes
the single heavy slot is the floor — true when OCR was 13.7 s/page and QA was ~0.2 s/page. Today:

| tier | per page | pages/min bound |
| --- | ---: | ---: |
| heavy (`ocr`, `panel-detection`) | 23.4 s | 2.57 |
| **light** (`qa`, `translation`, `render`, `layout`) | **94.7 s** | **0.63** |

The light tier is **4× slower** than the heavy tier, and the heavy slot sits idle 95.9% of the time.
Headroom is available — worker CPU averaged **22.5%** (p95 191% of its 200% cap), and light work is
network-bound LLM calls, not CPU.

Raising `MAX_LIGHT_SLOTS` (and `CONCURRENT_JOBS` with it) attacks 99% of the measured queue wait.
Note AUDIT-W6 below: the slot maths is unvalidated, so change both knobs together and check the
resulting values. Interacts with AUDIT-W3 — light jobs that block on cooldowns/locks hold a slot,
which matters more, not less, once several run concurrently.

#### AUDIT-W6 **[M]** — slot maths can compute to zero or negative with no validation

`concurrency.py:29` — `MAX_LIGHT_SLOTS = _parse_env_int("MAX_LIGHT_SLOTS", MAX_CONCURRENT_JOBS - MAX_HEAVY_SLOTS)`.
`CONCURRENT_JOBS=1` with the default `MAX_HEAVY_SLOTS=1` yields `0`; `MAX_HEAVY_SLOTS=3` with
`CONCURRENT_JOBS=2` yields `-1`. Combined with `REUSE_IDLE_SLOTS=false` that is a permanent `429`
on every light queue — a hard pipeline deadlock from a plausible config. Nothing validates or warns.

#### AUDIT-W12 **[H]** — confirm QA actually emits `escalation` and `directFix` now

> **CONFIRMED 2026-08-04.** QA does emit `escalation` / `directFix` against a live provider. The
> contingency below — flattening the nested objects onto the result — is **not needed** and should
> not be built. The 90 s/page of blind re-translation this was costing is recovered.

Split out 2026-08-03. The schema change that makes both objects `required`, and the prompt rewrite
that tells the model prose has no routing effect, are **committed but unconfirmed against a live
provider** — the only evidence they were missing is observational (run `20260803-084755`: 10
`direct_fix` verdicts with zero `directFix` payloads, 10 `failed` verdicts with zero `escalation`
blocks), and nothing short of a real call proves the fix took.

This matters more than its size suggests. Until `escalation.needsReOcr` arrives, every QA failure
routes to a blind re-translation of the same unreadable OCR: measured at **450 s across 4 wasted
cycles on 5 pages — 90 s/page, 39% of all work in the run** — and it never fixes the defect, because
re-translating garbled OCR cannot recover the source text. The `qa-re-ocr` dispatch path already
exists and is correct (`JobCoordinatorService`, "Re-OCR request" branch); it has simply never fired,
because `regionsToReOcr` is only populated from a flag the model never set.

**How to check on the next run** — all three are already logged, no new instrumentation needed:

+ `zcat worker.log.gz | grep -c escalation` should be non-zero.
+ `grep "carry no escalation block"` should be absent (the new warning in `_sanitize_qa_results`).
+ `grep "Enqueuing qa-re-ocr job"` in the backend log should appear for garbled-OCR pages.

If `escalation` is still absent, the provider is dropping the required keys and the next step is to
flatten the fields onto the result object rather than nesting them — models emit optional nested
objects far less reliably than flat scalars, and that is the pattern all four QA prompts share.

#### AUDIT-W11 **[M]** — a chapter pinned to a dead provider has no escape hatch

> **FIXED 2026-08-04** (worker `2f0abfa`). Fallback now crosses provider boundaries when — and
> only when — the pinned provider is parked in `PROVIDER_AUTH_FAILURES`. Both translation paths
> share `resolve_fallback_target()`. `ocr.py` and `qa.py` still carry the old rule; the failure was
> only measured on translation, so they were left for their own commit.

*Added 2026-08-03, split out of the translation-failure triage at the bottom of this file.*

Visible in every traceback from run `20260802-163445`: `No fallback applied (global provider
different or model identical)`. When a chapter-level override pins a provider that is down — the
invalid `neurometric` key, 401 × 323 — the fallback logic declines to cross provider boundaries, so
the global default (a working `openrouter`) is never tried and the chapter fails 100% of its
translations.

The safety argument for not crossing providers is real (a chapter pinned to a specific model
presumably wants *that* model), but "the pinned provider is authenticating-failed and parked in
`PROVIDER_AUTH_FAILURES`" is exactly the case where it should. Fallback should cross providers when
the pinned one is parked, and say so in the log.

#### AUDIT-B1 **[H]** — one scheduler thread runs everything — **RESOLVED 2026-08-05**

Fixed in `0e5bbd5`. `spring.task.scheduling.pool.size` is now 4 (override with
`SCHEDULING_POOL_SIZE`). Confirmed in the deployed container: `scheduling-1`, `scheduling-3` and
`scheduling-4` run concurrently where before there was only ever `scheduling-1`.

#### AUDIT-B2 **[H]** — `@Transactional` bypassed on the startup path — **RESOLVED 2026-08-05**

Fixed in `61d856c` via a `@Lazy` self-reference. Two corrections to this entry as written:

+ The proxy fix alone was **not** sufficient. `resetProcessingJobsToPending` also caught every
  exception internally, so the transaction never saw a failure and would commit the partial batch.
  Exceptions now propagate; `onStartup` still logs and lets the app start.
+ **`requeuePendingJobs` was never a defect.** This entry named it alongside
  `resetProcessingJobsToPending`, but it carries no `@Transactional` at all — self-invocation loses
  nothing there.

#### AUDIT-B3 **[M]** — **FULLY RESOLVED 2026-08-05** (`f131e42` NPE, `80520a0` the rest)

`f131e42` split the handler: `IllegalArgumentException` → 400 with its message,
`NullPointerException` → 500, logged with the request description and full stack trace. The detail
sent to the client is generic, since an NPE message describes our internals.

*Live behaviour change:* any `Objects.requireNonNull` doing input validation now returns 500 rather
than 400 (see AUDIT-Q1's 247 calls). That is the correct signal, and no test depended on the old
mapping — but it is worth knowing when triaging a new 500.

**Still open in this entry:**

+ `handleInternalError` returns `"Something went wrong: " + ex.getMessage()` to the client — leaks
  SQL fragments, file paths and internal identifiers.
+ There is no `AccessDeniedException` handler, so a `@PreAuthorize` denial thrown at method level is
  caught by the catch-all `Exception` handler and returned as **500 instead of 403**.

#### AUDIT-B4 **[M]** — **FULLY RESOLVED 2026-08-05** (`c123cba` multi-tab, `6c9c624` the race)

`c123cba` replaced the one-emitter-per-user map with
`ConcurrentHashMap<UUID, Collection<SseEmitter>>` over `CopyOnWriteArrayList`, with removal **by
identity** under `compute` — so an orphaned tab's completion callback can no longer evict the live
tab's emitter, and the user's entry is dropped once its last connection goes rather than leaking an
empty collection. The three send paths share one fan-out helper that reports whether anything took
the event, which `emitNotificationToUser` uses to decide on queueing to Redis.

**Still open in this entry:** `sendPendingNotifications` does `range(0,-1)` then `delete(key)`
non-atomically, so a notification pushed between the two calls is lost. Untouched by the above, and
a different kind of bug — a Redis race, not a map-keying mistake.

#### AUDIT-B6 **[M]** — thumbnail decode serialised — **RESOLVED (verified 2026-08-05)**

> The lock is now scoped to genuinely-WebP reads and writes (`PageService.isNativeWebpReader`,
> `decodeForThumbnail`), and the `catch (Error)` is a `catch (… | LinkageError)`. The
> `in.mark` without a `reset` went with the rewrite. Found already-fixed while pulling items
> onto the 2026-08-05 board; the entry below is the original text.

`PageService:23-27` says the WebP lock is "scoped to WebP work only so the thread-safe built-in
PNG/JPEG/BMP codecs can still run in parallel". `:215-245` then wraps the **entire decode of every
format** in `synchronized (WEBP_LOCK)`, and `:260-285` wraps the encode. The 4-thread
`thumbnailExecutor` is therefore fully serialised for both halves of the work — which is the
already-noted 100+ image upload slowdown, but the code comment actively misleads anyone
investigating it. Only the WebP reader/writer calls need the lock.

Same method: `:211` `in.mark(Integer.MAX_VALUE)` is never paired with a `reset()`; `:298` catches
`Error`, which swallows `OutOfMemoryError` and `StackOverflowError` along with the
`UnsatisfiedLinkError` it was written for (`LinkageError` is the intended net).

#### AUDIT-B7 **[M]** — cover recalculation is skipped for duplicate-image imports

`PageService:96` uses `if (safePageNumber == 1)`; the near-identical
`createPageWithExistingImage:134` uses `if (pageNumber != null && pageNumber == 1)` — the **raw**
argument. Importing a duplicate image into an empty chapter passes `pageNumber = null`, resolves to
`safePageNumber = 1`, and skips `recalculateChapterCover`. The chapter renders with no cover until
something else touches it.

**Status: DONE 2026-08-05 (`3455430`).** Both call sites now guard on `safePageNumber`. Verified
red-green — the new test leaves the cover `null` on the raw-argument guard.

#### AUDIT-F3 **[M]** — SSE reconnects forever with no backoff — **RESOLVED 2026-08-05**

Fixed in `14f0c07`, closing all three gaps this entry accumulated. Exponential backoff from 5 s to a
60 s cap with **equal jitter** — which keeps a floor of half the nominal delay, so retries still make
steady progress while spreading a fleet of reconnecting tabs across the window instead of aligning
them. The streak resets when a connection actually opens, so an unrelated blip weeks later starts
from 5 s rather than inheriting an old 60 s.

Retries also stop entirely while `document.visibilityState !== "visible"` and resume immediately on
wake, rather than making the user wait out a backoff window they never saw start. Both hidden-tab
cases are covered and tested: hidden when the failure happened, and hidden by the time the armed
timer fired.

*This is the precondition for deleting the `QueueManager.tsx:427` poll under AUDIT-F5 — that poll
exists because SSE was not trusted to stay up. It is now safe to remove, and has not been yet.*

#### AUDIT-F4 **[M]** — light-mode secondary text fails WCAG AA — **RESOLVED 2026-08-05**

Fixed in `a39374c`: `text.secondary` `#b0b0b0` → `#5f5f5f`, giving 6.4:1 on paper and 5.9:1 on the
default background.

*Correction to this entry:* `text.disabled` (`#786e6a`) is **≈4.96:1**, not ≈4.6:1 — the new test
computes WCAG relative luminance directly rather than eyeballing it. The inversion described was
real and slightly worse than stated: secondary sat at **2.17:1**, well below disabled.

The test checks both text colours against both background surfaces in both modes, so a future
palette nudge cannot regress this quietly. It also pins the specific inversion: secondary must never
be less legible than disabled.

#### AUDIT-F5 **[L]** — smaller frontend items — **RESOLVED 2026-08-05** (`33f3902`)

> All nine. Two corrections: the `getSnapshot` "tearing hazard" is not one (a string snapshot
> compares fine under `Object.is`), and the precompressed-assets item would have emitted files
> nothing serves — Spring's own `server.compression` was enabled instead. See archive.md.

+ `useColorMode.ts:6` — `getSnapshot` calls `localStorage.getItem` directly, and React invokes it on
  every render and every store check. Cache the snapshot; returning a fresh value each call is also
  a `useSyncExternalStore` tearing hazard.
+ `useColorMode.ts:22` writes `manga_theme`, and `App.tsx:187` writes it **again** in an effect —
  two writers, one key.
+ `useColorMode.ts:23` — the synthetic `StorageEvent` carries no `newValue`, so any future listener
  that reads it breaks.
+ `QueueManager.tsx:420` — `setInterval(fetchJobs, 30000)` polls on top of the SSE feed that already
  pushes `job_update`.
+ `package.json:20` — `esbuild` is a direct dependency; it belongs in `devDependencies`.
+ `package.json:14` — `generate-api` hardcodes `http://localhost:8080/tlhub/...`, which breaks for
  any non-default `CONTEXT_PATH`.

**Re-checked 2026-08-04.** All six still open; line numbers have drifted —
`App.tsx:287` is the duplicate `manga_theme` writer, `QueueManager.tsx:427` the poll,
`package.json:21` the `esbuild` dependency. Three more of the same size, from the yt-diff
comparison (see [frontend_improvements.md](./frontend_improvements.md)):

+ **No precompressed assets.** `vite.config.ts` has no compression plugin and the MUI vendor chunk
  ships at 380 kB (119 kB gzip). yt-diff emits `.gz` + `.br` at build time via
  `vite-plugin-compression2`. Brotli is worth ~20–25% over gzip on that chunk, on a tablet.
+ **`"lint": "eslint ."` does not fail on warnings.** yt-diff runs
  `eslint src --report-unused-disable-directives --max-warnings 0`. Adopt the flags; it stops
  warning drift for free.
+ **Spinner-only loading states.** No `Skeleton` anywhere. The dashboard, chapter gallery and page
  grid all have known cell shapes, so skeletons map onto them directly and remove the layout jump
  a centred spinner causes.

#### AUDIT-F6 **[M]** — icon-only controls carry no accessible name — **RESOLVED 2026-08-05** (`ba21af6`)

> The count below is misleading: of 51 icon buttons, 21 were already named by a MUI `Tooltip`,
> 17 by a native `title`, and only **12** had nothing — none of them in the five files named
> here. `Reader.tsx` and `ReaderLeftSidebar` have no `IconButton` or `Fab` at all. The
> focus-order half had no concrete defect; the real gap is landmarks, now on the board.

The whole frontend has **5** `aria-label`s across 40 components. `Reader.tsx` — 3,954 lines, the
primary surface, almost entirely icon-only `IconButton`s — has **zero**, as do `ReaderTopNav`,
`ReaderLeftSidebar`, `ReaderRightSidebar` and `NavBar`.

For scale, `yt-diff/frontend` has 56 across 11 components and labels every icon button
(`Pagination.jsx` 5, `Nav.jsx` 13, `VideoPlayer.jsx` 15) — an independently built app of the same
shape that got this right without a policy. Unlabelled icon buttons are unusable with a screen
reader and give tests nothing stable to query, which is part of why the component suites here lean
on text matching.

Pairs with **AUDIT-F4**: between them they are the whole accessibility story, and F4 is a one-line
fix. Do them as one pass.

#### AUDIT-F7 **[M]** — nothing tells the client its session died — **RESOLVED 2026-08-05** (`ee24e53`)

> Correction: "the client half of that already exists here" below is **wrong**. `App.tsx`
> listens for a window `CustomEvent`; `useSSE` had no `session-expired` listener on the
> `EventSource`, so the push would have been dropped silently. That was added too.

Expiry is only ever discovered client-side, from the token's own `exp` (`utils.ts`, 2026-08-04) or
from a 401 on the next request. A tab that is open but idle has no idea.

yt-diff's backend arms a `setTimeout` at socket-connect for the token's exact `exp` and pushes
`token-expired` before disconnecting (`yt-diff/src/socket/index.ts:75-100`), re-verifying
periodically so a password change also kills live sessions. The client half of that already exists
here: `SESSION_EXPIRED_EVENT` in `utils.ts` and the `SessionWatcher` listener in `App.tsx` would
consume such an event with no change.

Wants `SseTicketAuthFilter` to emit `session-expired` at the token's `exp`. **Complements rather
than replaces the client timer** — a frozen mobile tab has no live SSE connection to receive a
push, which is the exact case that produced the original blank-screen report.

#### AUDIT-D1 **[H]** — `db-backup` restart policy — **RESOLVED (verified 2026-08-05)**

> `docker-compose.yml` reads `restart: unless-stopped`, with a NOTE recording that `none` was
> never a valid Compose value. Found already-fixed while pulling items onto the 2026-08-05
> board. **Backup freshness itself was not re-checked** — verify `data/backups/last/` before
> trusting it.

`docker-compose.yml:29` — `restart: none`. The Compose spec values are `no`, `always`,
`on-failure`, `unless-stopped`; `none` is not one of them. `docker compose config` passes it
through unvalidated, but the container **does not currently exist** (`docker ps -a` finds no
`manga-db-backup`), and the newest file in `data/backups/last/` is dated **2026-07-28** — four days
stale as of this audit.

Whatever stopped it, `restart: none` guarantees it never comes back after a stop or host reboot.
Use `restart: unless-stopped` (`BACKUP_ON_START=TRUE` plus `SCHEDULE=@daily` already handles the
"only run periodically" intent). **Verify the backups are actually current before trusting them.**

#### AUDIT-D2 **[M]** — the worker image is single-stage, runs as root, and pins nothing

`worker/Dockerfile`:

+ **Not multi-stage** — the ML dependency tree (paddle, onnx, opencv) ships in one layer with no
  builder/runtime split, and `libxrender-dev` (`:9`) leaves a `-dev` package in the runtime image.
+ **No `USER`** — the container runs as root, while `backend/Dockerfile:47` correctly creates and
  drops to a `spring` user. Inconsistent posture across the two images.
+ `:20-28` downloads four fonts from GitHub `raw.githubusercontent.com/.../main/...` at build time.
  Unpinned refs against a moving branch: the build is not reproducible and breaks if any upstream
  path moves. Vendor the fonts or pin commit SHAs. (The Arial pull from the `root-project` repo also
  has licensing implications for a published image.)
+ **No `PYTHONUNBUFFERED=1`** — which is precisely why the code is littered with `flush=True` on
  every `print`. Setting the env var lets those be dropped.
+ `pip install` without a BuildKit cache mount, unlike the backend's Maven and npm stages.

**Status: PARTLY DONE 2026-08-05** (worker `0894cb2`, pointer `9cdd365`). Read the whole entry before
calling this closed — it bundles more than its headline, and only some of it is done.

*Done.* **Pinning**: the base image is pinned by digest, and 19 of the 20 requirements carried no
version at all — all 20 are now pinned to the versions the running worker was already on, so the
change is behaviourally a no-op. **Non-root**: a fixed `uid 10001` (fixed, not useradd's choice,
because the bind-mounted model caches carry host ownership through and a drifting uid would silently
lose write access to 374 MB of models); the YOLO cache path in `config.py` moved off `/root` to match,
and the compose mounts moved with it.

*WON'T DO.* **Multi-stage**, on measurement. Of the 1.93 GB image, 1.53 GB is ML wheels and 280 MB is
apt libs, and there is **no build-toolchain layer at all** — no `build-essential`, no gcc — so a
builder stage has nothing to leave behind. The rebuilt image measured 1.94 GB, unchanged. Do not
reopen without a measurement that contradicts this.

*Still open, and not attempted.* The four font `wget`s against `raw.githubusercontent.com/.../main/`
are still unpinned refs on a moving branch, with the Arial licensing question untouched;
`libxrender-dev` is still a `-dev` package in the runtime image; there is still no
`PYTHONUNBUFFERED=1`, so the `flush=True` littering stands; and `pip install` still has no BuildKit
cache mount.

*Not yet deployed.* The host directories under `data/worker/` are still root-owned and must be
`chown`ed to `10001:10001` before `docker compose up -d worker`.

#### AUDIT-D3 **[M]** — `depends_on` ignores the healthchecks that are already defined

Every stateful service defines a `healthcheck`, but `backend:depends_on` (`:124-127`) and
`worker:depends_on` (`:213-216`) use the short list form, which only waits for *container start*.
The backend therefore races Postgres on a cold boot. Switch to
`depends_on: { db: { condition: service_healthy } }` — the healthchecks are already written, they
just aren't wired up.

**Status: DONE 2026-08-05 (`55f9d00`).** All six dependencies across `backend` and `worker` now use
`condition: service_healthy`, confirmed with `docker compose config`, and observed working on the
backend redeploy — compose printed `Waiting` then `Healthy` for db, minio and valkey before starting
the backend.

#### AUDIT-D4 **[M]** — `MINIO_ENDPOINT` means two different things

`docker-compose.yml:107` gives the backend `${MINIO_ENDPOINT:-http://minio:9000}` (with scheme);
`:172` gives the worker `${MINIO_ENDPOINT:-minio:9000}` (without — the Python MinIO SDK requires
it that way). Both read the **same variable**. The defaults paper over it, but the moment anyone
sets `MINIO_ENDPOINT` in `.env` — which the compose file invites — exactly one of the two services
breaks. It is also absent from `.env.example`, so there is no documented correct value. Split into
`MINIO_ENDPOINT` and `MINIO_ENDPOINT_INTERNAL`.

**Status: DONE 2026-08-05 (`69ad910`).** Split as `MINIO_ENDPOINT_URL` (backend, carries the scheme)
and `MINIO_ENDPOINT_HOST` (worker, bare host:port); the in-container variable stays `MINIO_ENDPOINT`
on both sides so no application code changed. Both are now documented in `.env.example`, closing the
"no documented correct value" half. It breaks in *both* directions, not just the worker's: the Java
SDK's `MinioClient.endpoint()` treats a bare host as HTTPS.

### Status of the fix order — 2026-08-02

Items 1–5 of the list below are **implemented and the full quality gate passes** (backend 330 tests

+ PMD + SpotBugs + JaCoCo, frontend 253 tests + lint + build, worker 241 tests + ruff + pyright,
85.4% coverage). What landed:

| item | what changed |
| --- | --- |
| **S1/S2/S3** | `application.yml` ships no secret fallbacks; `SecretsStartupValidator` fails startup on a missing, too-short or known-public secret; dev values moved to `application-local.yml`; `DockerSecretsEnvironmentPostProcessor` warns on every missing/empty secret file instead of continuing silently; `InternalAuthFilter` uses `MessageDigest.isEqual`; the worker refuses to start without `WORKER_API_SECRET` and `verify_auth` denies when it is unset. |
| **S4** | `SseTicketService` issues single-use 60s tickets; `SseTicketAuthFilter` redeems them; `JwtAuthFilter` no longer accepts `?token=` at all; access-log pattern `%r` → `%m %U %H`; `useSSE.ts` exchanges the JWT for a ticket over a header-authenticated POST. |
| **W10/W6** | Defaults raised to `CONCURRENT_JOBS=5 / MAX_HEAVY_SLOTS=1 / MAX_LIGHT_SLOTS=4`; `resolve_slot_config` clamps any combination that computes to zero or negative slots and logs each adjustment. **Correction 2026-08-03: this never took effect at runtime.** The change landed in `docker-compose.yml` (`${CONCURRENT_JOBS:-5}`) and `.env.example`, but the real `.env` — which is gitignored and untracked — still pinned `CONCURRENT_JOBS=2`, and an `.env` value overrides a compose default. Run `20260803-084755` therefore measured the *baseline* 2/1/1 config. Now set to `4/1/3` in `.env`. |
| **P4** | New `jobs.callback_applied_at` column plus `JobRepository.claimCallback`, a conditional UPDATE that makes the check-and-set atomic. Every result callback claims before writing, so a duplicate run is dropped instead of writing a second region set, layer and cost. A genuinely failed job never claimed, so its retry still applies. |
| **P1 / W1** | `resolveConfigForChapter` now passes `tl` / `qaLLM` / `qaVLM`, matching `providers.json`. `handlers/qa.py`'s four hardcoded `if/elif` provider chains are replaced by `_qa_cloud_llm` / `_qa_cloud_vlm`, so `cloudflare` and `neurometric` work and an unresolvable model logs why. |

Also fixed in passing, because the quality gate was already red before this batch: two dead private
`enqueueJob` overloads (SpotBugs `UPM_UNCALLED_PRIVATE_METHOD`), a bare `catch (Exception)` in
`WorkerDispatcherService.dispatchFromSlot` that swallowed interrupts, and a `UselessParentheses`
PMD violation. The `JwtAuthFilter` double-registration from AUDIT-B8 is closed too, via
`FilterRegistrationBean(setEnabled(false))`.

**Not done, and why:** the callback dedup key is `Job.id` resolved through the existing
`findFirstByImageIdAndTypeOrderByCreatedAtDesc` lookup rather than a `jobId` carried on the callback
body. Adding a field to the callback DTOs changes the OpenAPI spec, and `npm run generate-api` reads
the spec from the *running* backend container — so regenerating `schema.d.ts` correctly would mean
rebuilding and redeploying the live stack mid-change. **AUDIT-P5** already tracks carrying the job
id; doing it there removes the residual ambiguity noted in `claimCallback`'s javadoc.

#### Still outstanding from that batch — 2026-08-03

> **Closed out 2026-08-04.** Item 1 (the re-run) happened — `20260803-204638` (2 jobs) and
> `20260803-211221` (30 jobs, 204 jobs total, all COMPLETED, 24 min wall, $0.19), both profiled
> remotely so local profiling did not contend. Item 3 (`schema.d.ts`) is done — the file carries
> `notifications/ticket`. Item 2 (the `neurometric` key) is still dead, but **AUDIT-W11 changed what
> that costs**: a chapter pinned to a provider whose key is rejected now falls back across the
> provider boundary instead of failing 100% of its translations. Replacing the key is housekeeping
> now, not an outage.
>
> The re-run's own conclusions live in `docs/archive.md` under the 2026-08-04 handoff: AUDIT-W5 fell
> to 1.8%, AUDIT-W12 confirmed, AUDIT-W2 at 1.2%, and the large `layout` / `panel-detection` stage
> times turned out to be an **attribution artefact rather than a stall** — those stages sit
> immediately before the expensive ones, so a job accrues its whole wait under the stage it last
> completed. Do not re-derive "queue wait is 90% of job lifetime" as a finding; it is the same
> artefact seen from the other side.

Carried over from `docs/Next Steps.md`, which was retired once items 1–5 landed. These three need a
human and are not code work:

1. **Re-run the drained capture.** ~~W10 raised the slots but the win is unmeasured.~~
   **Attempted 2026-08-03 (`20260803-084755`) and invalid — the slot change was never in force.**
   `environment.md` recorded `max_concurrent_jobs:2 / max_heavy_slots:1 / max_light_slots:1` and
   `active_light` never exceeded 1 across 634 samples, because the untracked `.env` overrode the
   compose default (see the W10/W6 row above). `.env` is now `CONCURRENT_JOBS=4 /
   MAX_HEAVY_SLOTS=1 / MAX_LIGHT_SLOTS=3` — heavy deliberately stays at 1, since that tier is local
   PaddleOCR on CPU and is where the worker already hits its full 200% cap; the light tier is LLM
   API wait and costs almost no CPU to widen. **The re-run still needs to happen.**

   **Verify the config is actually in force before trusting a run**: `docker compose config | grep
   -E 'CONCURRENT_JOBS|MAX_(HEAVY|LIGHT)_SLOTS'`, and check the worker capabilities line in the
   captured `environment.md`. Nothing in the repository can catch this class of mistake, because the
   file that wins is not in the repository.

   Watch two things while it runs: AUDIT-W6's clamped slot arithmetic in the worker startup log, and
   whether the UI degrades — 71% of the browser's LongTask wall was already descheduling on this
   4-core box, so if it worsens, cap worker CPU rather than reverting the slots.

   **What `20260803-084755` was still good for**, since these are independent of slot count:
   translation failures went 11/50 → **0/9** (the dead `neurometric` key was the whole 22%);
   rate-limit sleep stayed at **0.0 s**, confirming AUDIT-W2 is inert; and `layout` still waits
   **255.5 s per job for 1.9 s of work** (99.2%), with `panel-detection` at 50.1 s for 0.2 s —
   together 97% of all queue wait. It also surfaced the QA silent-pass chain (now fixed, see
   [archive.md](./archive.md)) and one measurement that reframes the whole exercise: **work totalled
   1150.9 s against 1444 s of wall clock, so utilisation was 80% and even perfect scheduling recovers
   at most ~20% of wall.** The baseline's "90.8% queue wait" overstates the recoverable time, because
   most of that wait overlaps other jobs' work. Reducing *work* is the larger lever — and 450 s of
   that 1150.9 s (**39%**) was QA re-translation cycles that fixed nothing.
2. **Replace the `neurometric` API key** in `secrets/api_keys.json`. It returned 401 × 323 on the
   baseline run and caused 100% translation failure on every chapter pinned to it. The
   retry-amplification defect around it is fixed; the dead credential is not.
3. **Regenerate `frontend/src/api/schema.d.ts`.** The S4 batch added `POST /api/notifications/ticket`,
   so the generated client is a deploy behind. Per `CLAUDE.md`, run `npm run generate-api` from
   `frontend/` *after* the next `docker compose build backend && docker compose up -d backend`.
   Nothing is broken meanwhile: `useSSE.ts` calls the endpoint with a plain `fetch`, not the
   generated client.

### Suggested fix order

> **Superseded 2026-08-04.** Everything this list ranked is now either done, measured away, or
> reduced to housekeeping — see the current ordering in [next-step.md](./next-step.md). Kept below
> because the *reasoning* about what was demoted and why is still the record.
>
> | was | now |
> | --- | --- |
> | #3 AUDIT-W10 "top of the list until measured" | **Measured.** 30-page run, 204 jobs, zero failures. The scheduling thread is closed. |
> | #6 AUDIT-W12 "90 s/page if it holds" | **CONFIRMED 2026-08-04.** It held. |
> | #7 AUDIT-T2 "top of the un-started work" | Partly overtaken — the 2026-08-04 sweep added red-green regression tests across queue merge, chapter refresh, prefetch gate, ZIP export and the W11 fallback. The *original* error-branch gap in `llm_client` was closed by `ffab71d`. Re-scope before picking it up. |
> | #8 AUDIT-P2 / P3 / B1 | **B1 done 2026-08-05** (`0e5bbd5`) — it was indeed one config line. P2/P3 stay latent-correctness. |
> | #9 AUDIT-W2 | Second data point: 1.2%. Reading unchanged. |

**Revised 2026-08-02** against measured data from the first drained run
([perf_analysis_backend_2026-08-02.md](./perf_analysis_backend_2026-08-02.md)). The previous
ordering ranked AUDIT-W2 as "likely the single largest throughput win available" — it is inert, and
the item that actually holds throughput (**AUDIT-W10**) was not in the list at all, because no run
had ever drained.

1. ~~**AUDIT-S1 / S2 / S3** — the fail-open secrets.~~ **Done 2026-08-02** (with S4).
2. ~~**AUDIT-D1** — confirm whether backups are actually running.~~ **Done** — container healthy,
   `restart: unless-stopped`, backups current.
3. **AUDIT-W10** — ~~raise `MAX_LIGHT_SLOTS`~~ **code done 2026-08-02**, **config only actually in
   force from 2026-08-03** (`CONCURRENT_JOBS=4 / MAX_HEAVY_SLOTS=1 / MAX_LIGHT_SLOTS=3` in `.env`;
   the 2026-08-02 change sat in `docker-compose.yml` while the untracked `.env` overrode it, so run
   `20260803-084755` measured the old 2/1/1). **Still unmeasured** — see "Still outstanding from
   that batch" above. This is the top of the list until it is measured.

   Temper the expectation: at 80% utilisation the *scheduling* win is capped near 20% of wall clock.
   That is worth having, but **AUDIT-W12 below removes 39% of the work outright**, and removing work
   beats reordering it.
4. ~~**AUDIT-P4** — duplicate work.~~ **Done 2026-08-02** via `jobs.callback_applied_at` +
   `claimCallback`. The residual `jobId`-on-the-callback-body work stays under **AUDIT-P5**.

   **Still unexercised as of 2026-08-03, and `duplicate_jobs.csv` cannot test it.** Run
   `20260803-084755` had 42 dispatches for 42 jobs and **zero** re-dispatches, so the duplicate path
   never ran. The CSV was non-empty anyway (2 images × `translation`/`render`/`qa` × 3), but those
   rows are QA retry cycles, not duplicates: sequential, same `trace_id`, `attempt=1`, each job
   created the instant its predecessor completed, and **all 42 jobs have `callback_applied_at` set**
   — nothing was ever dropped. The baseline's `e185e276` "ran translation, qa and render 3× each"
   has the identical shape and was very likely also a QA loop. Any future check needs to exclude
   QA-driven repeats before reading that file as evidence of duplication.
5. ~~**AUDIT-P1 / W1** — the provider/task-key mismatches.~~ **Done 2026-08-02.**
6. **AUDIT-W12** — confirm QA emits `escalation` / `directFix`. Costs one grep over the next run's
   worker log; the payoff if it holds is 90 s/page of re-translation that currently fixes nothing.
7. **AUDIT-T2** — the error-branch tests, before the mock-router build rather than after. **Now the
   top of the un-started work.**
8. **AUDIT-P2 / P3 / B1** — the dispatcher defects. Demoted from #3: all three are real, but the
   drained run shows they are costing ~nothing right now (3.2% / 1.3% starvation, 0 stranded jobs).
   Fix as latent correctness, not as a throughput measure.
9. **AUDIT-W2** — demoted from #4. Falsified in practice; keep only the "global fallback should be
   unlimited" hardening so a future provider without `rate_limits` cannot silently throttle
   everything.
10. Everything else as it is touched.

**Not on this list on purpose:** the [worker pull model](./worker_pull_model.md). Measured, it would
remove **408 s of 49,058 s of queue wait (0.83%)**. Worth building for latency, resilience and
multi-worker scaling — not for throughput, and not before #3.

**Triaged 2026-08-02 — not a code defect, and it does not belong above #4.** All 33 tracebacks are
the same `RuntimeError: All N translation(s) failed`, and every one of them bottoms out in
**HTTP 401 `Invalid API key provided.` from `neurometric`, 323 times across the run**. Chapters
pinned to `neurometric` failed 100% of their translations; chapters on `openrouter` succeeded —
that is the 22%. **The `neurometric` API key in `secrets/api_keys.json` is invalid and needs
replacing; no code change fixes that.**

The run did expose one real defect, now fixed: nothing treated a 401 as terminal. `PermanentAPIError`
stopped Tenacity, but the layers above kept retrying the same dead provider — batch, then a retry
pass, then per-region individual fallback, then the RQ job three times — so one bad credential cost
9 identical 401s per region. `llm_client.py` now parks a provider that answers 401/403 in
`PROVIDER_AUTH_FAILURES` for 300s and short-circuits without sleeping (deliberately not the 429
cooldown, which blocks for up to 60s per call while holding a job slot).

Also visible in the same traces and still open: `No fallback applied (global provider different or
model identical)`. With the chapter pinned to a provider that is down and the global default set to
a working one, the fallback declines to cross providers, so a dead chapter-level override has no
escape hatch. **Split out 2026-08-03 as [AUDIT-W11](#audit-w11-m--a-chapter-pinned-to-a-dead-provider-has-no-escape-hatch).**

</details>

<!-- markdownlint-enable MD001 MD004 -->

### The 2026-08-05 third sitting — list items 1–7, minus two halves

*Retired from `next-step.md` on 2026-08-05. Eleven parent commits (`3455430` … `64cea19`) plus worker
`0894cb2`. Every code fix verified red-green. **Backend deployed; worker built but not deployed** —
see the end.*

Suites: **backend 390 → 395**, **frontend 305 → 306**, **worker 284** (unchanged). All green, no
skips.

| item | commit | what changed |
| --- | --- | --- |
| AUDIT-B7 | `3455430` | Cover recalculation guards on `safePageNumber` in both call sites. |
| AUDIT-P2 | `11c79da` | A 400/422 marks the row `FAILED` with the reason, and emits `job_update`. |
| AUDIT-P3 | `19cab6f` | `break` instead of `return` — a stuck queue no longer abandons its slot class. |
| AUDIT-P9 | `a8abea3` | OCR callback fails the job when its page is gone, instead of dying at commit. |
| AUDIT-D3 | `55f9d00` | All six `depends_on` entries moved to `condition: service_healthy`. |
| AUDIT-D4 | `69ad910` | `MINIO_ENDPOINT_URL` / `MINIO_ENDPOINT_HOST`, both documented. |
| AUDIT-D2 | `0894cb2`, `9cdd365` | Base pinned by digest, 19 requirements pinned, non-root `uid 10001`. |
| landmarks | `bc81040` | `<nav>`, `<main id="main-content">`, and a skip link. |
| MUI miss | `64cea19` | ColorPicker's nine painting surfaces onto MUI `Box`. |

**Two findings were wrong, and one entry was bigger than its headline.**

- **AUDIT-P9's mechanism is wrong.** It claims the rows "save successfully and are then invisible to
  every `findByPageId` query — silent orphans that still count against cost". They cannot:
  `ocr_regions.page_id` and `layers.page_id` are `NOT NULL` in the mapping *and* in the live schema.
  Checked against the running database and with a throwaway Testcontainers probe, which threw
  `ConstraintViolationException: null value in column "page_id"`. What actually happened is a
  `DataIntegrityViolationException` at commit that rolls back the **entire completed OCR pass**,
  after which the stale sweeper re-runs the expensive job to fail identically up to `maxAttempts`.
  Real defect, wrong reason, and worse on cost than the entry suggests.
- **AUDIT-D2's multi-stage half is a WON'T DO, on measurement.** Of the 1.93 GB image, 1.53 GB is ML
  wheels and 280 MB is apt libs, and there is **no build-toolchain layer at all** — no
  `build-essential`, no gcc — so a builder stage has nothing to leave behind. The rebuilt image came
  out at 1.94 GB, unchanged. The real "pins nothing" defect was elsewhere and unmentioned by the
  headline: **19 of 20 requirements carried no version**.
- **AUDIT-D2 bundles four more sub-items that are still open** and were not attempted: the four font
  `wget`s against a moving `main` branch (plus the Arial licensing question), `libxrender-dev` in the
  runtime image, no `PYTHONUNBUFFERED=1`, and no BuildKit cache mount on `pip install`. The
  "read the whole entry" rule earned its keep again.

**Three process notes.**

- **`detect_changes` returned HIGH on the a11y commit, and it was the line-offset artefact again** —
  in its most extreme form yet. Wrapping the routes in `<main>` re-indented ~120 lines, so the raw
  diff was 161/-126; `git diff -w` was **35 insertions and zero deletions**. All six flagged
  processes (`SseRetryDelayMs`, `ParseJwt`, `TicketUrlFor`, …) traverse `AppContent`'s hooks, none of
  which were touched — `AppContent` is a hub every flow enters at step 1. It also parsed the
  `(t) => t.zIndex.tooltip + 1` arrow inside an `sx` prop as a symbol named `zIndex`.
- **Wrapping JSX forces a re-indent, and Prettier is the right tool for it.** The standing rule is
  never to run `prettier --write` outside a formatting commit. That rule exists because the repo was
  *not* Prettier-clean; now that it is, `--write` on a file already being changed only touches lines
  the change itself caused. Verified by checking the file was clean at `HEAD` first, then confirming
  `git diff -w` showed no deletions.
- **`sx` is not a free swap for `style` on a drag path.** ColorPicker's handles update on every
  `pointermove`; `sx` compiles through emotion and mints a class per distinct value, so moving handle
  positions there would mean a new class per frame. Static styling went to `sx`, per-frame values
  stayed inline. A MUI migration is not always find-and-replace.

**Deployment state.** The backend **was** rebuilt and deployed this sitting, so AUDIT-F7's client
listener and `server.compression` are live for the first time; the container came up healthy with no
error lines. The worker image is **built and verified but not deployed** — it runs as `uid 10001`,
and the host directories under `data/worker/` are still root-owned. They need
`sudo chown -R 10001:10001 data/worker/{huggingface,paddlex,rendered_cache}` before
`docker compose up -d worker`. Until then the running worker is the previous root image and the stack
is consistent.

### The 2026-08-05 second sitting — list items 1–5, a MUI pass, and Prettier in CI

*Retired from `next-step.md` on 2026-08-05. Ten parent commits (`88b4cf6` … `3e1903c`) plus worker
`49ceaea`. Every fix verified red-green. **Not deployed** — see the note at the end.*

Suites: **backend 366 → 390**, **frontend 297 + 1 skipped → 305 + 0 skipped**, **worker 284**
(unchanged). Backend line coverage **0.7887 → 0.8165** against the 0.80 gate.

| item | commit | what changed |
| --- | --- | --- |
| CI unblock | `88b4cf6` | Two SpotBugs bugs, one PMD violation, and the JaCoCo gate. `PageService` 54.8% → 82.3%. |
| worker CI | `49ceaea`, `ca35171` | `ruff format` on `translation.py`; a pyright `Optional` in `test_typesetting.py`. |
| AUDIT-F7 | `ee24e53` | Ticket carries the session `exp`; `subscribe` arms one cancellable push per connection. |
| AUDIT-B4 leftover | `6c9c624` | `RENAME` to a scratch key; only the undelivered tail is requeued. |
| AUDIT-B3 leftovers | `80520a0` | Generic 500 detail; new `AccessDeniedException` → 403. |
| AUDIT-F6 | `ba21af6` | 12 nameless icon buttons named, 17 `title`-only ones given an explicit `aria-label`. |
| MUI misses | `b951ee2` | Two card grids and the drag overlay onto MUI `Grid`/`Backdrop`; 132 lines of dead CSS. |
| Prettier | `463b15b` | 27 files formatted, `format:check` gated in `ci-npm.yml`. |
| AUDIT-F5 | `33f3902` | All nine sub-items; see the two corrections below. |
| skipped test | `3e1903c` | The suite's only skipped test un-skipped. |

**Six corrections made by reading the code.** The board's track record holds.

- **AUDIT-F7's "the client half already exists" was wrong.** `App.tsx` listens for a *window*
  `CustomEvent` that `utils.ts` dispatches. `useSSE` registered six `EventSource` listeners and
  `session-expired` was not among them, so the backend push would have been dropped silently by the
  browser. The item needed a frontend change it said it did not need.
- **AUDIT-F6's framing overstated the defect and named the wrong files.** Classifying all 51 icon
  buttons: **21** were already named by a MUI `Tooltip` (it injects `aria-label` for a string
  title), **17** had a native `title` (a real name, by the weakest fallback), **1** had an
  `aria-label`, and **12** had nothing. None of the 12 are in the five files the entry names —
  `Reader.tsx` and `ReaderLeftSidebar` have no `IconButton` or `Fab` at all.
- **AUDIT-F6's "focus order" half has no concrete defect.** No `tabIndex` overrides anywhere, so
  tab order follows DOM order, and the single `outline: none` (`index.css:215`) is paired with a
  `box-shadow` focus ring. What *is* missing is landmarks — no `<main>` or `<nav>` in the app — and
  the skip link that depends on them. Carried onto the new board rather than invented here.
- **AUDIT-F5's tearing rationale is wrong.** The entry calls the uncached `getSnapshot` "a
  `useSyncExternalStore` tearing hazard". It is not: the snapshot is a string and `Object.is`
  compares it fine however often it is read. The item is still worth doing for the avoided storage
  read; the reason given is not the reason.
- **AUDIT-F5's precompressed-assets item would have shipped dead files.** It asks for
  `vite-plugin-compression2` to emit `.gz`/`.br`, copying yt-diff. This app serves its own frontend
  from `classpath:/static`, Spring will not serve a precompressed sibling without an
  `EncodedResourceResolver`, and the Traefik router carries no compress middleware — so the 380 kB
  MUI chunk was going out **uncompressed** and the emitted files would never have been read.
  Enabled Spring's own `server.compression` instead, with `mime-types` enumerated so
  `text/event-stream` stays off it; compressing SSE would buffer events behind the encoder.
- **`ErrorBoundary` is not a MUI migration miss.** Its docblock says it is dependency-free on
  purpose so it can still render when MUI is what failed. Converting it would defeat it.

**Two findings in `issues.md` were already fixed and still marked open** — now corrected there.
**AUDIT-B6**'s WebP lock is already scoped to WebP-only work and already catches `LinkageError`
rather than `Error`; **AUDIT-D1**'s `db-backup` already reads `restart: unless-stopped`, with a
NOTE explaining the invalid `none`.

**Three process notes worth keeping.**

- **`prettier --write` on a repo that was never Prettier-clean buries the change you came to make.**
  Formatting the files touched by the AUDIT-F6 sweep rewrote 270+ unrelated lines in
  `UploadContext.tsx` alone; the sweep was reverted and redone by hand to keep the diff readable.
  That is what motivated `463b15b`, and CI now gates on `format:check` so the drift cannot return.
- **That formatting commit silently broke a lint suppression.** A trailing
  `// eslint-disable-line react-hooks/exhaustive-deps` sat on the same line as a dependency array;
  Prettier split them, so the directive stopped applying *and* became unused. Nothing failed,
  because warnings were not gated. `--report-unused-disable-directives --max-warnings 0` — adopted
  from the same AUDIT-F5 entry — catches exactly this, and was verified to go red on it.
- **The `detect_changes` line-offset artefact fired three more times** (CRITICAL twice, HIGH once).
  In the AUDIT-B4 case `sendPendingNotifications` — the method actually rewritten — was not even in
  the changed list, while four untouched methods below the insertion were. `git diff -U0` hunk
  ranges settled each one in a single command.

**Not deployed.** The backend image has not been rebuilt since this sitting. Two changes need it to
take effect: AUDIT-F7's client listener (the frontend compiles into the backend image) and the new
`server.compression`. The branch is 10 commits ahead of `github/main` and nothing is pushed.

### The 2026-08-05 sitting — list items 1–5 and the AUDIT-F4 half of 6

*Retired from `next-step.md` on 2026-08-05. Seven code commits (`0e5bbd5` … `f131e42`), each
verified red-green: break it, watch the named test fail, restore it. Deployed and confirmed
running.*

Suites: **backend 349 → 366**, **frontend 283 → 297 + 1 skipped**, **worker 275 → 284.** All green.

| item | commit | what changed |
| --- | --- | --- |
| AUDIT-B1 | `0e5bbd5` | `spring.task.scheduling.pool.size` 1 → 4, via `SCHEDULING_POOL_SIZE`. |
| `try_local_ai` | `2b37cdd` (worker), `e8ccb49` (bump) | Caller's prompt becomes the system message. |
| AUDIT-B4 | `c123cba` | `Map<UUID, Collection<SseEmitter>>` over `CopyOnWriteArrayList`. |
| AUDIT-F3 | `14f0c07` | 5 s → 60 s backoff, equal jitter, visibility gate. |
| AUDIT-B2 | `61d856c` | `@Lazy` self-reference, plus the swallowed exception. |
| AUDIT-B3 **(part)** | `f131e42` | NPE → 500 and logged; `IllegalArgumentException` keeps 400. |
| AUDIT-B4 **(part)** | `c123cba` | See the leftovers below — both entries had more in them. |
| AUDIT-F4 | `a39374c` | Light `text.secondary` `#b0b0b0` → `#5f5f5f`. |

**AUDIT-B3 and AUDIT-B4 are only partly closed.** Each `issues.md` entry bundled more than its
headline, and the rest is still open — it stayed in `issues.md` rather than coming here:

- **AUDIT-B3** — `handleInternalError` still returns `"Something went wrong: " + ex.getMessage()`
  to the client, leaking SQL fragments and file paths, and there is still no
  `AccessDeniedException` handler, so a `@PreAuthorize` denial returns **500 instead of 403**.
- **AUDIT-B4** — `sendPendingNotifications` still does `range(0,-1)` then `delete(key)`
  non-atomically, so a notification pushed between the two calls is lost. Untouched by the
  multi-emitter change, and a different kind of bug (a Redis race, not a map-keying mistake).

**AUDIT-B1 is confirmed in production, not just in test.** The deployed container's startup logs
show `scheduling-1`, `scheduling-3` and `scheduling-4` running concurrently; before the change there
was only ever `scheduling-1`. Container reached `healthy` with zero error lines.

**Four corrections made by reading the code.** This board has a track record of findings that were
wrong until someone checked; these are the ones from this sitting.

- **AUDIT-B2 was half a fix as written.** Routing through the proxy was necessary but not
  sufficient: `resetProcessingJobsToPending` also caught and logged every exception internally, so
  the transaction would never see a failure and would commit whatever the loop managed first —
  precisely the half-migrated job table the transaction exists to prevent. Exceptions now propagate;
  `onStartup`'s own catch still logs and lets the app start.
- **AUDIT-B2's second call site was never a defect.** `issues.md` named both
  `this.resetProcessingJobsToPending()` and `this.requeuePendingJobs()`. `requeuePendingJobs` carries
  **no `@Transactional` at all**, so self-invocation loses nothing there. Only one of the two was
  real.
- **AUDIT-F4's `text.disabled` is ≈4.96:1, not ≈4.6:1** — the new test computes WCAG relative
  luminance directly. The inversion the finding describes was real and slightly worse than stated:
  secondary sat at **2.17:1**, well below disabled.
- **AUDIT-B3 is a behaviour change, not a logging fix.** Any `Objects.requireNonNull` doing input
  validation now surfaces as 500 rather than 400. That is the correct signal — a null check that is
  really validation belongs in `IllegalArgumentException` — and no test depended on the old mapping,
  but it is live and worth knowing when triaging a new 500.

**One process note worth keeping.** `detect_changes` returned CRITICAL on the SSE work. It was the
line-offset artefact the working constraints already warn about: a 45-line insertion shifted every
method below it, flagging `mapImageToUser`, `emitNotificationForImage`, `emitEventForImage` and
`sendPendingNotifications` as touched when all four are byte-identical. Checking `git diff -U0`
hunk ranges settled it in one command. The warning in the constraints is load-bearing — use it.

### The 2026-08-04 handoff — performance thread closed, correctness list emptied

*Retired from `next-step.md` on 2026-08-04 once everything in it was done. The measurements below
are the reason several things were dropped; keep them so they do not get re-derived.*

**The performance thread is closed. Do not reopen without a measurement that contradicts these.**

- **AUDIT-W5 fell from 13.0% to 1.8%** on re-measurement, and at that size lending the idle heavy
  slot is probably not even the right fix. Marked WON'T DO, not NOT STARTED. Two corrections made by
  reading the code first: `REUSE_IDLE_SLOTS` **is** read (`worker/src/worker/main.py:206`), and the
  method is `WorkerCapacity.hasLightSlot()` at `WorkerDispatcherService.java:334`. The old handoff
  was wrong on both and it cost time.
- **The huge `layout` and `panel-detection` stage times are an attribution artefact, not a stall.**
  In `20260803-211221` they carry 8,683 s and 6,550 s against a 1,457 s wall — 88% of all stage time
  between them, versus `ocr` 578 s and `render` 172 s. That is not work. Both stages sit immediately
  before the expensive ones, so a job accrues its whole wait under the stage it last completed. The
  2-job run settles it: `layout` p50 is **1.8 s** there and **179 s** in the 30-job run, and
  per-item cost cannot move 100×. The remedy is categorisation — a *transitioning* state — which is
  observability and **will not move wall time**.
  - Corollary: "queue wait is 90% of job lifetime" is the same artefact seen from the other side.
    It is not a finding.
- **AUDIT-W2 stays inert**: 16.9 s across 13 sleeps in 1,457 s (1.2%), consistent with the 0.0 s
  baseline.
- **AUDIT-W12 CONFIRMED** — QA does emit `escalation` / `directFix`. The contingency plan (flatten
  the nested objects onto the result) is not needed.
- **Utilisation is 80%**, not 10%: 1,150.9 s of work against 1,444 s of wall. Perfect scheduling
  recovers at most ~20% — **reducing work beats reordering it**, and 450 s (39%) of that work was QA
  re-translation cycles that fixed nothing.
- Run shape for reference: `20260803-211221`, 30 pages, 204 jobs, **all COMPLETED**, 24 min wall,
  $0.19. Costs $0.006/page at `openai/gpt-5.6-luna`.

**Render geometry** (`97bc93f`, worker `6906a71`). `f3aa160` shipped two defects, both fixed:

1. It insetted every region into "the bubble", but **42% of translated regions (1,832 of 4,351) have
   no detected bubble** — the worker fills `bubble*` from the OCR text bbox for those. Insetting a
   49 px caption to 29 px is narrower than a word, so `fit_text_in_box_py` fell through to
   per-character splitting and rendered "goi/ng", "sub/jec/t". 237 regions were under 40 px; now 16.
   The premise was measured library-wide, which folded in those synthetic rows sitting at exactly
   100% by construction; restricted to real bubbles it is 95.7%/97.4% and the inset is right.
2. A `record TextBox` was inserted between `@Transactional` and `handleTranslationCallback`, so the
   annotation bound to the record. It compiled clean — records are types — and left every write in
   that callback outside a transaction.

**The bubble detector's limits are measured. Do not re-derive them.** See also F.1 above.

- YOLO11n is single-class (`balloon`) and only recognises canonical enclosed balloons. On Openrouter
  ch. 11 p22 it scores **0.92** on a normal oval and **0.206 / 0.044** on the two irregular thought
  clouds. **34% of *speech* regions (1,022 of 2,967) have no detected bubble.**
- **Lowering the threshold does not work.** Over 30 pages / 180 such regions: 0.25 → 1 recovered,
  0.15 → 5, 0.10 → 7 (3.9%), at 24% more detections per page. The misses are mostly not
  low-confidence detections being filtered — there is no mask at all.
- **A bigger model does not work either.** `yolo26s_manga109` recovers 4/180, and every region it
  recovered the contour search had already recovered. Additive value zero.
- **What works** is `detect_bubble_contour`, which already existed but was unreachable while YOLO was
  active — its only call site was the legacy branch. Behind `BUBBLE_CONTOUR_FALLBACK` (default on):
  recovers ~48%, median 2.6× wider.
- **Only helps pages that are re-OCR'd.** Manual per-page re-OCR is the accepted remedy; no backfill.

**Correctness sweep** — seven items, one commit each, all with red-green regression tests.

| item | commit | what it actually was |
| --- | --- | --- |
| AUDIT-F6 | `18ffee8` | The poll merge compared `createdAt >=`, but `createdAt` is fixed for a job's lifetime, so for the same job it was always an equality and always passed — it could not distinguish "fresher" from "staler". Now uses the rule the SSE handler already had. |
| AUDIT-F8 | `4cbf925` | Moved the no-spinner assertion out of `waitFor`, where it could never fail. |
| AUDIT-F7 | `0b18b8d` | Ref-guarded against a chapter change mid-flight. Applied to **all four** chapter-scoped refreshes, not just the one named. |
| `/api/**` 200 | `9236787` | `forward:/error` sets no status, so it stayed 200. `safeFetch` is a bare `window.fetch`, so every `if (res.ok)` read a missing endpoint as success. |
| prefetch gate | `64cef93` | Pinned the "nothing warms before the current image loads" invariant, including that warming *does* happen after. |
| ZIP export | `1ae993e` | Archive generated through the real UI, captured and reopened with `JSZip.loadAsync`. Structure only — jsdom has no canvas. |
| AUDIT-W11 | worker `2f0abfa` | Fallback crosses providers **only** when the pinned one is parked in `PROVIDER_AUTH_FAILURES`. |

**Two process notes that cost time here:**

- Every behavioural fix was checked **red-green** — guard removed, test observed to fail, guard
  restored. A regression test that has never been seen to fail is not evidence.
- `ForwardControllerTest` and `TextBoxForTest`'s helper were both *pinning bugs* rather than
  behaviour. When a fix makes a test fail, work out which of the two is wrong before editing the test.

**Testcontainers was not broken.** The backend suite runs green. `init-test.sql` was missing
`reader_storage_path`, added to `Image` in `3122624` but never to the test schema. This neither
confirms nor refutes the older Ryuk/Redis diagnosis — that control run was abandoned after ten
minutes and never reproduced. Both failure modes surface as the same "ApplicationContext failure
threshold exceeded" cascade on every class after the first, so read the `Caused by` chain before
blaming the environment.

**Correction carried forward:** `handleExportRenderedPng` does **not** draw from `imgRef.current` —
it fetches `/api/pages/{id}/rendered` from the server and was never at risk. The two that did draw
from the displayed element are `handleExportPng` and `handleExportZip`.

### Issues Board Audit (`issues.md` → archived 2026-08-01)

Each item below was re-verified against current code/docs (not just taken on the word of the original "(done)" tag) before being moved out of `issues.md`.

- [x] **CI failing** — both failures fixed. Backend: `backend/pom.xml` pins `java.version=25` and `.github/workflows/ci-maven.yml` matches (`java-version: "25"`, `distribution: temurin`), resolving the "release version 25 not supported" error. Frontend: the flaky `AssertionError: expected false to be true` test was scoped inside `waitFor` in the Reader component test (commit `0a5296a`). **Correction 2026-08-03:** that did not fix it — the test flaked again in CI, and the cause was a product bug in `Reader.tsx`, not test timing. See "Reader lost-invalidation race" below.
- [x] **Same-image handling had not worked for a long time** — the full intelligent-cloning architecture is implemented and documented end-to-end in [duplicate_handling.md](./duplicate_handling.md): source-page scoring for cloning candidates, OCR/translation config-matched layer cloning, image-scoped panels vs. page-scoped everything-else, and page-scoped job routing so a shared image backing pages in different chapters no longer resolves the wrong chapter's model config (commits `7f080ea`, `5e2d5ce`, `72d8a4f`).
- [x] **`index.js` is still too big** — `frontend/vite.config.ts` now splits the bundle via `manualChunks` (`vendor-react`, `vendor-mui`, `vendor-router`, `lib-jszip`, `lib-zod`); the before/after build logs pasted into the original issue show the single ~375 KB `index-*.js` dropping to a ~23 KB main chunk with the rest cached in stable vendor chunks (commit `849cb81`).
- [x] **UI fixes needed**:
  - Lazy-loading thumbnails across series/chapter/page surfaces, fixing the earlier bug where the "lazy" loader still fetched full images (commit `6a94e97`).
  - Reader bi-directional cache with a soft cap — verified in `frontend/src/components/Reader.tsx` (~L668-719): a `[-2, +3]` sliding window prefetches both page details and images in *both* directions and evicts on window slide, with no hand-rolled memory-size cap (the earlier hard-cap calculation was removed; eviction is now purely window-based and lets the browser manage image memory).
  - Every-chapter-shows-spinner (component remount on cached data) fixed.
  - The Firefox-crashing regression was reverted (`5511ce8`) and the same features (lazy loading, bi-directional cache) were redone incrementally and safely (`e9567e7` → `6a94e97` → `48ba3a5` → `8f66c1f`).
- [x] **Add an export rendered PNG button** — `handleExportRenderedPng` implemented in `Reader.tsx` (~L2233) and wired into `ReaderRightSidebar` (commit `8f00564`). (The screenshot originally linked from this entry was removed from `docs/` in an unrelated cleanup; this entry is kept text-only.)

### Reader lost-invalidation race (2026-08-03)

- [x] **A `job_update` that arrived while page details were still loading was silently swallowed.**
  Diagnosed from a CI failure of `"reloads layers and shows toast on job_update SSE event"` — the
  same test `0a5296a` had already tried to de-flake by widening the assertion into `waitFor`. It was
  never a timing problem: in the losing interleaving the refetch is *never* issued, so `waitFor` can
  only time out.

  The SSE handler busts `pageDetailsCache` and nulls `loadedImageId` to force a refetch. If the
  initial `/api/pages/{id}` request was still in flight, its `.then` landed afterwards, rewrote the
  cache entry that had just been cleared and set `loadedImageId` back to the page id — so the effect
  saw nothing to do. The guard that should have caught this, `if (selectedPage.id === currentPageId)`,
  compared two values from the same closure and was always true, so every late response applied
  unconditionally.

  User-visible symptom: the "New layers available — refreshed" toast appears, and the reader keeps
  showing stale layers until you navigate away and back.

  Fixed with a cache-invalidation epoch (`cacheEpochRef` + a `cacheEpoch` state entry in the effect's
  dependencies): the SSE handler bumps it, `fetchPageDetails` refuses to write a response whose epoch
  is stale, and the tautological guard is replaced by `isCurrentRequest()`, which checks both the
  epoch and the most recently requested page id — so a late response for a page you navigated away
  from is dropped too. Reproduced deterministically with a 30 ms mocked response before the fix, and
  that case is now a regression test. The test file's `useParams` mock is also reset per-test; it was
  being set with `mockReturnValue` inside individual tests, which persists file-wide and made the
  suite order-dependent.

### Reader page images broke on the AUDIT-S4 deploy (2026-08-03)

- [x] **Every full-size reader image returned 403 after `?token=` was removed.** S4 correctly took
  the query-string credential path out of `JwtAuthFilter` (it is header-only now,
  `JwtAuthFilter.java:75-81`), but `Reader.tsx` still built image URLs as
  `` `${page.url}?token=${jwt}` `` in two places — the displayed `<img>` and the prefetch warm-up.
  An `<img>` cannot set an `Authorization` header, so the credential was simply ignored.

  Confirmed against the running backend rather than inferred: `/api/images/{id}/file?token=…` and
  the same URL with no credential at all both return **403**, while `/api/images/{id}/thumbnail`
  returns **200** because it is the one image route left `permitAll` in `SecurityConfig.java:48`.
  That asymmetry is exactly what the bug looked like — galleries kept working, the reader did not.

  Fixed in `frontend/src/utils/authImage.ts`: the bytes are fetched with the header and handed to
  `<img>` as a blob URL, so no credential reaches the URL, the access log or the referrer — the
  property S4 was protecting. The cache pins the image currently on screen so a neighbouring
  prefetch cannot evict it, dedupes in-flight loads, and revokes on eviction and on logout.
  `prefetchAuthImage` replaces the `new Image()` warm-up, which had depended on an unauthenticated
  `<img>` reaching the browser HTTP cache.

  **The Reader tests could not have caught this**: they mocked `safeFetch` without a `blob()`, so
  the component silently rendered its error state and no assertion touched the image. They now
  return blobs, and a regression test asserts the image loads via header with no `token=` in any
  request URL (commit `02d9185`).

### The QA silent-pass chain (2026-08-03)

Found while investigating a `NullPointerException` in run `20260803-084755`. One truncated model
response produced four independent silent failures, each of which on its own turned a broken QA pass
into a clean one.

- [x] **A QA result with no `regionId` NPE'd, and the swallowed exception scored as a pass.**
  `UUID.fromString(null)` at `JobCoordinatorService.handleQaCallback` threw inside the per-result
  `catch`, which logged and continued — leaving every counter at zero. Zero counters then computed
  `status = "passed"`, so the backend logged *"QA passed for image e3e52903. Pipeline complete!"*
  off a single unusable result and completed the pipeline with QA never applied.

  Results without a `regionId` are now discarded explicitly and counted. A callback that scores
  nothing reports `status: "error"` with `discarded_results`, returns `COMPLETED_NO_QA`, and raises
  a **WARNING** notification instead of a success one (commit `14bed1e`).

- [x] **QA metadata was written to every translation layer on the page.** With a QA retry cycle
  leaving several translation layers behind, the final callback stamped its verdict over the results
  already recorded for the earlier cycles. Verified on an image whose QA *did* parse: all three of
  `1f546be9`'s layers carry the same `last_qa_at` to the microsecond. On `e3e52903` the last, broken
  callback left all three layers reading `passed / total_regions: 0`. It now writes only to the
  newest translation layer.

- [x] **The truncation was invisible to the worker.** The model hit its output cap mid-word
  (`out=3408`); OpenRouter's `response-healing` plugin (`llm_client.py`) closed the JSON, so
  `json.loads` succeeded and returned `[{"qaFeedback": "…"}]`. `LLMResponse` did not carry
  `finish_reason`, so nothing downstream could tell a complete answer from a guillotined one. It is
  captured now, with a `truncated` helper and a warning log. Separately, `max_tokens` was only ever
  sent for Anthropic — every other provider inherited whatever the routed model defaulted to; all
  providers now get an explicit `DEFAULT_MAX_OUTPUT_TOKENS = 8192`.

- [x] **The worker auto-passed every region when QA produced nothing.** Three identical
  `"[QA] Falling back to default PASS for all regions."` blocks in `handlers/qa.py` fabricated a
  `passed` verdict for each region whenever parsing failed or the provider was dead — making a
  broken QA provider indistinguishable from a clean page. Replaced by `_sanitize_qa_results`, which
  drops entries that are malformed, unidentified or reference an unknown region, and reports an
  empty verdict instead of a fabricated one. This composes with the backend change above: empty now
  means "QA did not run" and is recorded as such. One existing test
  (`test_process_qa_vlm_local_fallback`) was asserting the old fabricated pass and was updated.

- [x] **`directFix` and `escalation` were optional and the model never emitted them.** The run
  produced `qaStatus: "direct_fix"` **10 times with zero `directFix` payloads** and
  `qaStatus: "failed"` **10 times with zero `escalation` blocks**. Both consuming branches in
  `JobCoordinatorService` are keyed on the object being present, so direct fixes were never applied
  and `needsReOcr` never routed — which is why every failure fell through to a blind re-translation
  of the same bad OCR. QA's own prose said *"Please re-OCR and then re-translate"*; with no flag set,
  the pipeline re-translated. Both objects are now `required` at the item level with fully-specified
  inner fields (also what OpenAI-style `strict` structured output demands), and all four QA prompts
  state explicitly that the objects are always present and that prose has no routing effect. If a
  provider rejects the schema, `LLMClient` already degrades to `json_object` and retries.
  **Emission is not yet confirmed against a live provider** — see the open item in `issues.md`.

### Audited & Verified Completed Items (Git History & Code Base Audit)

- [x] **Cloudflare Workers AI Integration** — added Cloudflare Workers AI provider to worker (`providers.json` & `llm_client.py`) with schema validation and session affinity support (commits `14532cf`, `f90902f`).
- [x] **RFC 7807 Problem Details Error Formatting** — implemented in `GlobalExceptionHandler.java` using Spring 6 `ProblemDetail` for all 4xx/5xx exceptions (commit `9a8a14b`).
- [x] **Spring Boot OpenAPI Annotations & DTO Refactoring** — annotated controllers with `@Tag` and `@Operation`, migrated DTOs to Java Records (`f07f49a`), and auto-generated TypeScript schema definitions (`schema.d.ts`) via `springdoc-openapi` (commits `ae6b69e`, `4077116`, `87fe269`).
- [x] **Null Type Safety Warnings Audit** — resolved via Java Records migration (`f07f49a`) and SpotBugs exclusion filtering (`c8bfc07`).
- [x] **Layer Update Failure Audit ([run-8.log])** — obsolete/resolved; transactional layer saving and history tracking verified, stale log removed (`b928608`).
- [x] **Presigned S3 Asset URLs & Worker Bearer Auth** — worker downloads input images and uploads outputs via presigned S3 URLs; authenticated via `WORKER_API_SECRET` Bearer token (`8be6f09`).

### Critical Bugs (plan-critical-bugfixes.md)

#### Phase 1 — Data Integrity

- [x] **1.1** Shared image cascade delete — deleting a page from one chapter destroys the image in all chapters
- [x] **1.2** Per-chapter model override uses wrong chapter — `findFirst()` picks arbitrary chapter for config resolution
- [x] **1.3** Re-upload after cross-chapter delete fails with `pages_chapter_id_page_number_key` duplicate key constraint
- [x] **1.4** Allow duplicate images in same chapter (doujin cover page use case)
- [x] **1.5** Image hash reuse causing unintended layer sharing across chapters, leading to incorrect processing.
- [x] **1.6** `project.json` `metadataJson` showing single model (e.g. PaddleOCR) instead of list of models (e.g. PaddleOCR + Gemini), and Gemini costs not captured.

#### Phase 2 — Backend API & Export

- [x] **2.1** Chapter export returns 500 — `LazyInitializationException` after OSIV disabled
- [x] **2.2** Clear queue API returns `{status: 999}` — missing `@Transactional`, incomplete Redis queue list, deletes PROCESSING jobs
- [x] **2.3** QA_MODE `auto` not recognized by worker — falls back to auto-pass instead of resolving to vlm/llm/hybrid
- [x] **2.4** OCR model identifier string has dead `MangaOCR/` prefix
- [x] **2.5** Exported ZIP should include rendered translations, not just original images
- [x] **2.6** Aggregated `modelsUsed` from cost breakdowns across QA and Translation in ChapterExportService.
- [x] **2.7** Added `needsReRender` flag based on lastEditedAt vs lastRenderedAt in ChapterExportService.
- [x] **2.8** Added padding to `LayerElement` bounds during OCR to Layout generation to improve `render.py` text fitting.
- [x] **2.9** Checked for manual edits before enqueueing QA on Render callback, avoiding costly QA on manual re-renders.
- [x] **2.10** Removed Image hash deduplication on Project Import to prevent layers stacking on existing pages.
- [x] **2.11** Separated QA models from Translation models in export metadata `modelsUsed` payload and guaranteed base keys.

#### Phase 3 — Upload Validation & Security

- [x] **3.1** Non-image files accepted on upload (`.md`, `.txt` etc.) — no file type validation
- [x] **3.2** Duplicate image idempotency guard for same chapter/same slot
- [x] **3.3** Image file endpoint (`/api/images/{id}/file`) works without auth

#### Phase 4 — Worker & Pipeline Robustness

- [x] **4.1** Worker health server `BrokenPipeError` clutters logs
- [x] **4.2** Translation romanization in outputs from cheap models
- [x] **4.3** Job retry counter never increments — frontend always shows `Attempt: 1/3`
- [x] **4.4** Dockerfile uses non-existent `maven:3-eclipse-temurin-26` tag (Skipped)
- [x] **4.5** QA `auto` mode falls back to `none` (skip) instead of trying default models (Skipped)
- [x] **4.8** Linting and parallel test execution issues across components

### Improvements (plan-improvements.md)

#### Phase 0 — CI Foundation

- [x] **0.1** Add static analysis to Python CI (ruff check, pyright)

#### Phase A — SSE Job System Migration

- [x] **A.1** Replace polling with SSE for job state updates (Queue/Per-job events)
- [x] **A.2** Frontend SSE-driven Queue Manager
- [x] **A.3** Queue Manager UI redesign

#### Phase B — Reader Auto-Refresh

- [x] **B.1** SSE-driven layer auto-refresh in Reader

#### Phase C — Thumbnail & Image Optimization

- [x] **C.1** WebP thumbnails with bicubic interpolation
- [x] **C.2** Frontend: use `/thumbnail` URLs everywhere
- [x] **C.3** Async thumbnail generation off the upload request path

#### Phase D — Frontend UI Fixes & Redesign

- [x] **D.1** Remove "Cover Image URL" field from create/edit series dialogs
- [x] **D.2** Fix settings modal overflow
- [x] **D.3** Chapter cards redesign
- [x] **D.4** Dashboard sorting
- [x] **D.5** Fix Reader full-reload on page switch (sliding window caching)
- [x] **D.6** Persist upload widget across navigation
- [x] **D.7** User management modal
- [x] **D.8** Theme improvements
- [x] **D.10** Model override display — show resolved model instead of `--Inherit--`
- [x] **D.11** Model override UX redesign
- [x] **D.12** Migrate frontend to Material UI (MUI)

#### Phase E — Backend Resilience

- [x] **E.1** Cross-provider failover
- [x] **E.2** Strict HTTP timeouts
- [x] **E.3** Move cost tracking from `costs.json` filesystem to PostgreSQL
- [x] **E.4** Remove `rendered_cache` QA images
- [x] **E.5** Chapter export cleanup
- [x] **E.6** Cost-Aware Provider Routing (OpenRouter)
- [x] **E.7** Model Routing Strategy Selector (UI + Backend)

#### Phase F — ML Models & Prompts

- [x] **F.2** OCR VLM prompt improvements
- [x] **F.3** Translation prompt improvements
- [x] **F.4** QA prompt improvements

#### Phase G — Concurrency & Slot Allocation

- [x] **G.1** Dual-Slot Dispatcher (Heavy/Light queues)
- [x] **G.2** Configurable Worker Slots (MAX_HEAVY_SLOTS / MAX_LIGHT_SLOTS)
- [x] **G.3** Deployment & Documentation

### More Improvements & Infrastructure (plan-more-improvements.md, decoupled_architecture_plan.md, implementation_plan.md)

- [x] **Details API 500 Root Cause Fix** — resolved `IllegalArgumentException` on `/api/pages/{pageId}/details` by updating Reader.tsx prefetch signature and adding 404 exception handling.
- [x] **Series Overrides Persistence** — preserved 9 override fields during series creation in `SeriesController.java`.
- [x] **`useFallbackModels` Override Toggle** — added boolean flag to disable global/local fallbacks on per-series/chapter basis.
- [x] **OpenRouter Strategy Logging** — added explicit logs for `lowest-cost` and `highest-throughput` provider ordering in worker.
- [x] **Response Format 400 Degradation** — worker gracefully falls back from `json_schema` to `json_object` when budget providers reject schema parameters.
- [x] **Provider-Aware Model Mapping** — added `providerModelsMap` to SystemSettingsDto and dynamically filtered model dropdowns per provider in `SettingsModal.tsx`.
- [x] **API Key Verification per Provider** — backend dynamically inspects environment API keys before populating active provider lists.
- [x] **Worker Model Name Normalization** — worker automatically strips provider prefixes (`google/`) and `:free` tags when dispatching requests to native APIs.
- [x] **Dynamic `providers.json` Config Architecture** — restructured provider configuration for generic OpenAI-compatible APIs (Neurometric, Nvidia, Cloudflare, Google AI Studio).
- [x] **Docker Compose Environment Defaults** — added `${VAR:-default}` bash parameter expansions across `docker-compose.yml` to prevent blank string overrides.
- [x] **Security CORS PATCH Support** — added `PATCH` method to allowed CORS methods in `SecurityConfig.java`.
- [x] **Reader Stale Chapter Clearing** — cleared pages state on `chapterId` change to prevent flash of previous chapter content.
- [x] **Out-of-Bounds Page Number Guard** — added defensive sequence bounds checking in `PageController.java`.
- [x] **S3 Rendered Image Naming Unification** — unified rendered image storage key naming (`imageId`) between worker rendering and QA passes.
- [x] **Individual Region Provider Inheritance** — ensured individual region translation fallback respects chapter/series provider overrides instead of defaulting to global env vars.
- [x] **Heartbeat Endpoint Logging** — added debug logging to `JobController.getJobs()` for heartbeat visibility.
- [x] **Queue Manager & Dark Mode UI Polish** — fixed table column layout jumping and applied MUI elevation paper styling across components.
- [x] **Testcontainers Integration Tests** — added real PostgreSQL integration tests for controllers and repository mapping.
- [x] **OpenAPI Spec Auto-Generation** — integrated springdoc-openapi to expose live OpenAPI JSON spec at `/tlhub/v3/api-docs`.

### Bugs (Fixed)

- [x] Hybrid cloud OCR coordinate space mismatch
- [x] Settings page causes logout
- [x] Model picker options collapsible
- [x] Cloud OCR misses free-floating text
- [x] Delete Page broken
- [x] Backend-rendered pages don't match frontend (Playwright fix)
- [x] Manual layer edits not included in export
- [x] Benchmark alternative cloud OCR models
- [x] Cost calculation wrong
- [x] Bubble polygon detection regressions
- [x] Bubble grouping issues after OCR upgrade
- [x] Redo Page OCR replacing old layer
- [x] OCR layer visible when Clean Scanlation toggled
- [x] Layer stacking and numbering
- [x] Translated text breaking out of bounding box
- [x] Free resize mode not working
- [x] Clone layer at wrong position
- [x] Undo doesn't work for bubble dragging
- [x] Delete confirmation dialogs don't respect light theme
- [x] Toast doesn't respect light theme
- [x] Deleting first image leaves series thumbnailless
- [x] SSE user-image mapping expiry
- [x] Clean up Minio artifacts on page delete
- [x] Increase JWT access token TTL
- [x] Fix `CostEstimationService.java`

### Backend & Features (Done)

- [x] `/api/settings` endpoint with runtime model config
- [x] Per-chapter/series model selection
- [x] Worker accepts model config per-job
- [x] Frontend settings panel
- [x] Red-outline bubbles that failed QA
- [x] QA summary in layer metadata
- [x] Export button in Chapter view
- [x] Async job queue with retry & backoff
- [x] Image dedup via hashing
- [x] Unified LLM provider (LiteLLM)
- [x] Layer metadata tracks model identifiers
- [x] Worker observability & structured logging
- [x] Live updates via SSE
- [x] ZIP/ePub import
- [x] Layer project re-hydration from archives
- [x] Redo-OCR / Redo-Translation fixes
- [x] PP-OCRv5/v6 integration
- [x] OpenRouter cloud OCR
- [x] Nemotron OCR v2 (rejected)
- [x] Notifications with image/chapter/series context
- [x] Chapter-level memory toggle
- [x] Disable OSIV
- [x] Clean up JVM Unsafe warnings
- [x] Persist job queue across restarts
- [x] Queue management (pause/resume/clear UI)
- [x] Docker secrets file support
- [x] Hybrid QA mode (LLM + VLM)
- [x] Model picker improvements (provider filtering, format mapping, fallbacks)
- [x] Worker: model seeding, test fixes, MangaOCR/EasyOCR removal
- [x] Cost tracking per layer in exports
- [x] Parallelized processing with configurable concurrency

### Java 25 Upgrade

- [x] Follow Java upgrade plan — compile Java 25 locally via SDKMAN, run Java 26 in Docker (we are sticking to 25 for now, will go to 27 when it comes out)
  - Update `pom.xml`: `java.version=25`, `release=25`
  - Update Dockerfile: `maven:3-eclipse-temurin-25` + `eclipse-temurin:25-jre-alpine`

---

## 📁 Archived Plans & Research Documentation Summaries

Summary of historical plans, architecture designs, and Root Cause Analyses (RCAs) previously stored in `docs/archive/`:

### Architecture & Infrastructure Plans

#### 1. Decoupled Architecture Plan (`decoupled_architecture_plan.md`)

Strategic blueprint for decoupling the monolithic setup into independent microservices:

- **Frontend Service:** Extracted Vite/React SPA served via a lightweight NGINX Alpine container, proxying REST (`/tlhub/api`) and WebSocket/SSE requests.
- **Backend Service:** Pure Spring Boot REST API without embedded static web assets, generating presigned S3 URLs for asset storage.
- **Worker Pool:** Support for local and remote cloud GPU nodes (RunPod, Vast.ai, AWS) accessing input/output assets via presigned S3 GET/PUT URLs and communicating status back via secure HTTPS callbacks with Bearer token authentication.

#### 2. Java Upgrade Plan (`java-upgrade-plan.md`)

Guide for host machine and container environment Java version alignment:

- Upgraded host development environment via SDKMAN (Java 26 SDK, Maven 3.9+).
- Updated `pom.xml` (`spring-boot-starter-parent` 3.4.0, `java.version` 25, `release` 25, JaCoCo 0.8.16).
- Updated backend runtime Dockerfile to `eclipse-temurin:25-jre-alpine` / `eclipse-temurin:26-jre-alpine`.

#### 3. Model Upgrade Plan (`model_upgrade_plan.md`)

Evaluation and replacement strategy for YOLO segmentation models:

- Diagnosed limitation of single-class model `juithealien/manga109-segmentation-bubble` (text bubbles only).
- Evaluated and recommended 3-class Ultralytics YOLO26s-seg model `ShadowB/Manga109-panel-balloon-text-yolov26-segmentation` (`frame`, `text`, `balloon`).
- Enabled downstream pipeline branching: typesetting inside dialogue balloons, position-anchored overlays for free-standing SFX text, and panel boundary detection for right-to-left reading order reconstruction.

---

### Feature Implementation & System Plans

#### 4. Provider-Aware Model Mapping & Key Verification (`implementation_plan_better_providers.md`)

Robust mapping and normalization architecture across AI providers:

- **Backend:** Dynamic API key inspection (`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY`, etc.) in `SystemSettingsService` to filter active providers and populate `providerModelsMap`.
- **Frontend:** Dynamic filtering in `SettingsModal` to match model choices strictly with selected providers while removing redundant `-- Default / Inherit Env --` entries.
- **Worker:** Model name normalization in `llm_client.py` to strip provider prefixes (`google/`, `neurometric/`) and `:free` suffixes before making native provider API calls.

#### 5. Master Improvements & UI Redesign Plan (`plan-improvements.md`)

Multi-phase blueprint covering performance, system architecture, and UI overhauls:

- **Phase 0 (CI Foundation):** Integrated static analysis for Python workers using Ruff (linting/formatting) and Pyright (type checking).
- **Phase A (SSE Job System):** Migrated from high-frequency REST polling to real-time SSE `job_update` events with interactive Queue Manager controls (pause, resume, retry, clear).
- **Phase B (Reader Auto-Refresh):** Implemented real-time layer auto-refresh in the reader upon SSE job completion.
- **Phase C (Thumbnail & Image Optimization):** Added non-blocking `@Async` WebP thumbnail generation using `ImageReader` subsampling and bicubic downscaling.
- **Phase D (MUI v9 Migration & Render Hygiene):** Full migration to Material UI v9, render hygiene optimizations (context memoization, prop stabilization, `React.memo` exports), user management modal, and stacked MUI Snackbars.

#### 6. Extended Improvements Plan (`plan-more-improvements.md`)

System reliability, performance, and contract verification checklist:

- **Testing:** Integration testing with Testcontainers and real PostgreSQL instances to catch schema, proxy serialization, and DDL issues.
- **Render Loop Protection:** Failure tracking on entities in `DebouncedRenderService` to prevent infinite render retry loops when manual edits fail.
- **Latency & Caching:** N+1 query elimination via `findByConversationIdIn` batching, sliding window page caching (`[N-1, N, N+1, N+2]`) in `Reader.tsx`, JWT session auto-refresh (`/api/auth/refresh`), and pipeline quality gates.

#### 7. Material UI Migration Detailed Strategy (`plan-mui-migration.md`)

Incremental 9-phase migration from glassmorphism CSS to Material UI (MUI v9):

- Dual theme palette definitions: nHentai-inspired dark mode (`#1f1f1f` / `#ee2553`) and Pixiv-inspired light mode (`#f5f5f5` / `#0197fc`).
- Component conversions for AppBar navigation, MUI Dialog modals, MUI Drawer/Table Queue Manager, MUI Cards for Dashboard/Series, MUI TextField form inputs, and stacked Snackbar toasts.
- Targeted Reader fixes: splitting shared redo loading states (7.4.1) and disabling Redo-OCR on translation layers (7.4.2).

---

### Bug Fix Plans & Root Cause Analyses (RCAs)

#### 8. Phased Implementation Plan for All Issues (`implementation_plan.md`)

Action plan to resolve issues documented in `issues-found.md`:

- **Phase 1:** Preserved all 9 override fields during series creation in `SeriesController.java`.
- **Phase 2:** Added `useFallbackModels` toggle per series/chapter (preventing fallback cascade when set to `false`), enhanced worker routing logs, handled budget provider 400 errors (`json_schema` -> `json_object` fallback), replaced deprecated model slugs.
- **Phase 3:** Expanded color picker presets, split chapter card export buttons with overflow menus, added provider/routing chips.
- **Phase 4:** Returned 410 Gone for expired exports, downgraded SSE disconnect logs to WARN, added `routingStrategy` and `useFallbackModels` to export metadata.

#### 9. Issues Inventory (`issues-found.md`)

Raw bug log and operational audit capturing issue descriptions across provider key filtering, first-load default settings population, duplicate `(free)(free)` model labels, chapter/series model mapping bugs, non-JP OCR quality degradation, out-of-bounds page creation, S3 rendered image `NoSuchKey` errors, SSE logging noise, AMOLED dark theme contrast, reader page state flash, and missing heartbeat logs.

#### 10. Initial Root Cause Analysis (`issues_rca.md`)

Technical RCA and targeted fixes for items in `issues-found.md`:

- Addressed CORS `PATCH` method support in `SecurityConfig.java`.
- Cleared stale `pages` state in `Reader.tsx` on chapter navigation.
- Defensive bounds checking in `PageController` for page creation.
- Unified S3 rendered image keys (`imageId` vs `pageId`).
- Passed chapter provider/model overrides to individual region translation fallbacks (`translate_text`).
- Standardized MUI Paper surface elevation and fixed Queue Manager column widths.

#### 11. Improved RCA Execution Plan (`issues_rca_improved.md`)

Detailed 10-phase execution guide with precise file paths and verification commands:

- Docker compose environment fallback parameters (`${VAR:-default}`).
- CORS `PATCH` method configuration.
- Provider fallback removal in `SystemSettingsService.java`.
- Model name `(free)` suffix deduplication in `providers.json`.
- Dynamic model dropdown mapping in series/chapter dialogs.
- Operational heartbeat logging (`HealthReporter`) and cache key logging in worker handlers.

#### 12. Critical Bug Fixes Plan (`plan-critical-bugfixes.md`)

Foundational data integrity, security, and pipeline stability plan:

- **Phase 1 (Data Integrity):** Shared image reference-counting before deletion, explicit `chapterId` propagation in job dispatch, duplicate key constraint prevention on re-upload, multi-chapter image layer reuse fixes.
- **Phase 2 (Backend API & Export):** Added `@Transactional(readOnly=true)` on export endpoints, fixed clear queue API, handled runtime `QA_MODE=auto` resolution, added debounced re-render service for manual edits, export ZIP caching and metadata enrichment.
- **Phase 3 (Security & Upload):** Image magic byte validation (PNG, JPEG, WebP, BMP), required Bearer auth for `/api/images/{id}/file`, updated cover URLs to use `/thumbnail`.
- **Phase 4 (Worker & Pipeline):** Worker health server `BrokenPipeError` suppression, anti-romanization prompt guards, job-level retry logic with attempt counters, automated lint/pytest fixes.

#### 13. Details API 500 Root Cause Fix (`plan-fix-details-api-500.md`)

Root cause analysis and resolution of repeated 500 errors on `GET /api/pages/{pageId}/details`:

- **Root Cause:** `Reader.tsx` prefetch loop passed `imageId` instead of `pageId` to `fetchPageDetails`, causing page lookup failures. Secondary cache key mismatch between `pageId` and `imageId` evicted active cache entries.
- **Fix:** Restructured `fetchPageDetails` in `Reader.tsx` to strictly consume `pageId`, updated prefetch loop and eviction window keys, added `GlobalExceptionHandler` with `ResourceNotFoundException` mapping 404s with descriptive JSON bodies.

---

### Configuration & Architecture Specifications

#### 14. Provider Restructuring & Inheritance Specification (`restructure.md`)

Specification for provider configuration restructuring and model inheritance:

- Replaced `api_keys.json` with `secrets/llm_config.json` defining provider defaults, priority, rate limits, free-tier flags, supported model lists (TL, QA LLM, QA VLM, OCR), and per-task cost structures.
- Formalized 6-tier model resolution fallback hierarchy (`P0` chapter overrides -> `P1` series inherited -> `P2` series overrides -> `P3` global inherited -> `P4` global overrides -> `P5` system settings defaults).
- Documented API reference curl payloads for Cloudflare Workers AI, Neurometric, Nvidia Nemotron, and Google AI Studio.
