# Issues and What I want for them

> Resolved items are verified and moved to [archive.md](./archive.md) rather than kept here with a `(done)` tag.

## The queue management has become absolute shit (in progress — partial fix applied)

It used to take 2 hours to process 50 images, check the logs.

Log in question [run-3-fresh.log](../logs/run-3-fresh.log) for details.

**Update 2026-08-01:** `WORKER_POLL_MS` was restored from the accidentally-regressed 30s back
down to 2s (commit `92f9284`), which alone removes ~85% of the idle-wait time — see
[slot_allocation.md](./slot_allocation.md) §5 for the measured before/after (50 pages: ~2h →
~13min). The remaining ~15% (poll-boundary latency, plus removing the dispatcher as a single
point of failure) needs the worker-pull model, which is designed but **not yet implemented** —
see [worker_pull_model.md](./worker_pull_model.md) and the corresponding entry in
[TODO.md](../TODO.md).

The "OCR should have a dedicated slot and should be prioritized" ask turned out to be a
misconception, not a bug — see [slot_allocation.md](./slot_allocation.md) §6: OCR shares the
single Heavy slot with panel-detection/re-OCR jobs, but it's polled first in priority order, so
in practice it isn't actually starved. Measured queue depth at OCR dispatch time was always 0.

**Update 2026-08-02 — measured, root cause found.** The first fully-drained run
(`logs/runs/20260802-163445`, 42 pages, 255 jobs, 100% dispatch-log coverage) split queue wait
from work for the first time. Full analysis:
[perf_analysis_backend_2026-08-02.md](./perf_analysis_backend_2026-08-02.md).

> **90.8% of total job lifetime is queue wait** — 49,073 s of waiting against 4,959 s of work.
> `layout` has a p50 wait of **591 s** around **0.2 s** of actual work.

The cause is **not** the dispatcher (slots sat idle *with work queued* only 3.2% of samples) and
**not** the rate limiter (AUDIT-W2, falsified below). It is `MAX_LIGHT_SLOTS=1`: four light stages
costing 0.2 s to 110 s each share one slot, so trivial jobs queue behind LLM calls. See
**AUDIT-W10**. The heavy tier is no longer the floor — the light tier is now 4× slower.

The queue docs were checked and are current as of 2026-08-01:
[slot_allocation.md](./slot_allocation.md) and
[translation_pipeline_phases.md](./translation_pipeline_phases.md) reflect the current
dispatcher behavior. [worker_provider_integration.md](./worker_provider_integration.md) was
rewritten to describe the `providers.json`-driven architecture — it previously predated that
file, as suspected.

## The UI is laggy and loads slow (partially fixed)

General observation, will do a proper firefox profile analysis later.

Most probably the backend holding it back, but it's probably just the inheritance and overrides

+ the logic bugs.

The previously described bug where the older chapter content remains visible for a split second
when loading a new one seems to still exist.

Also when there are too many jobs the queue and notification managers have noticeable lag.

**Update:** the frontend bundle-splitting fix (see [archive.md](./archive.md)) addresses initial
load weight, but that's load-time, not runtime.

**Update 2026-08-02 — profiling pass done.** See
[perf_analysis_frontend_2026-08-02.md](./perf_analysis_frontend_2026-08-02.md). The "lag when many
jobs are running" was largely a permanently-running CSS animation in the Queue Manager: **27.8% of
one CPU core sustained to display a static list**, via the 60 fps refresh-driver/WebRender loop
rather than restyle. All custom `@keyframes` have been removed from the frontend (commit `bcc86e0`);
loading state is MUI `CircularProgress`, and any future motion should use a MUI transition.

"Most probably the backend holding it back" is **falsified**: backend CPU averaged 3.8% across the
drained run. Two items remain open — per-chapter GC churn (2.93 s of major GC per 55 s window) and
per-chapter GC churn (2.93 s of major GC per 55 s window).

**Verified 2026-08-02 (run `20260802-210118`).** Post-fix the Queue Manager costs **1.0% of one
core** where it cost 27.8%, with **zero** `CSS animation iteration` markers and `RefreshDriverTick`
down from 59.68/s to 2.24/s.

The two remaining complaints are measured, and neither is fixable in frontend code:

+ **"Noticeable lag when background jobs are running"** — app CPU is only 4.9% of a core; **71% of
  LongTask wall time is the main thread descheduled**, not computing. Containers hit p95 204% of a
  400% box. Host CPU contention. See AUDIT-W10's interaction note.
+ **"Reader has some lag"** — 18.9% of a core, 41% descheduled. Of 8.80 s of JS self CPU, **app code
  is 0.715 s (8%)**; the rest is React reconciliation (2.71 s) and MUI (~2.1 s). See AUDIT-F2.

---

## Add Free Provider for Testing

[uncloseai](https://uncloseai.com/python-examples.html)
also [free-ollama](https://github.com/mfoud444/ollamafreeapi/tree/main)

### Available Endpoints

+ Hermes: <https://hermes.ai.unturf.com/v1> - General purpose conversational AI
+ Qwen 3 Coder: <https://qwen.ai.unturf.com/v1> - Specialized coding model
+ TTS: <https://speech.ai.unturf.com/v1> - Text-to-speech generation

Not yet added to `config/providers.json` — current entries are only `openrouter`, `cloudflare`,
`nvidia`, `neurometric`.

## `try_local_ai` ignores its `prompt` argument — local/Ollama QA silently returns nothing

Found while designing [mock_router.md](./mock_router.md).

`try_local_ai(prompt, text, response_schema, request_id)`
(`worker/src/worker/services/translation.py:455`) never references `prompt`. It hardcodes the
system prompt instead:

```python
system_pr = MANGA_TRANSLATION_JSON_SYSTEM_PROMPT if response_schema else MANGA_TRANSLATION_SYSTEM_PROMPT
```

For translation this is only redundant — the hardcoded prompt is the right one. For **QA it is a
functional bug**: `handlers/qa.py:281` and `:788` call
`try_local_ai(prompt, json.dumps(regions_metadata), QA_JSON_SCHEMA)`, so the QA prompt is discarded
and the model receives the *manga translation* system prompt with QA region metadata as its user
content. It answers with `{"translations": [...]}`, `parsed.get("results")` yields `[]`, and QA
completes having produced no results at all — no error, no log line saying anything is wrong.

Affects anyone running `QA_MODEL_PROVIDER=ollama`/`lmstudio`, and any QA job that falls through to
the local fallback after cloud providers fail. Also blocks Phase 1 of the mock-router work, which
routes QA through a mocked Ollama endpoint.

## Plan a better backend one that doesn't use java

I am tired of the boilerplate and bug factory that is java, it serves no real purpose and has no
real benefit other than being looking good in indian resumes, I hoesnly don't want to look at
java anymore.

For the love of god, do something use go or python idk if the [plan](./migration.md) is still
upto date or good, so maybe remake it when tackling this issue.

## Do we really need a separate worker?

like what does the backend do that cannot be done by the worker, why do we need this split?

## validate if the testing is really testing or just mocking everything and calling it a day

Check the [test-guide](./testing_isolation_guide.md) and make sure the tests are actually
testing the code and not just mocking everything and calling it a day.

**Note:** `testing_isolation_guide.md` only documents *environment* isolation (H2 in-memory DB,
Redis logical DB 1, mocked Python Redis client) so tests don't clobber the real stack — it does
not address whether the assertions themselves are meaningful, which is the actual question this
issue is asking. Still open.

**Update 2026-08-01:** the provider layer is a concrete instance of exactly this complaint —
`LLMClient` is only ever tested by monkeypatching `requests.post`, so nothing verifies the
request we actually put on the wire or the 429/timeout/schema-degradation branches.
[mock_router.md](./mock_router.md) designs a real over-the-wire mock provider to close that
specific gap; tracked in [TODO.md](../TODO.md) under Testing & QA.

**Correction 2026-08-01 (audit):** the "nothing verifies the request we put on the wire" half of
that claim is wrong — `tests/test_llm_client.py` *does* assert on `mock_post.call_args.kwargs["json"]`
for the Anthropic `cache_control`, the OpenRouter session/caching injection, and the Cloudflare
`json_schema` envelope. The half that holds is the branch coverage: all five tests are
happy-path `200`s. See [AUDIT-T1](#audit-t1--the-e2e-test-is-not-an-e2e-test) below for the real
shape of the testing gap.

## Update the `configuration_guide.md` once everything is done

We need to document how to setup the whole app like what needs to be populated in `.env` and
what needs to populated in the secrets, how to set up the `providers.json` and other small
stuff.

**Status:** `configuration_guide.md` now covers env vars, slot allocation, and the model
inheritance hierarchy in real depth — but it still has no section on Docker secrets file setup
or on `providers.json` structure/editing, so the original ask isn't fully done yet.

---

## Full-Stack Audit — 2026-08-01

A read-through of backend (`11.8k` LoC Java), worker (`8.3k` LoC Python), frontend (`26.8k` LoC
TS/TSX), the Dockerfiles and `docker-compose.yml`, cross-checked against `docs/` and the GitNexus
graph. Findings are new unless marked otherwise, and are ordered by severity. Every item carries a
`file:line` anchor so it can be picked up cold.

Conventions: **[C]** critical · **[H]** high · **[M]** medium · **[L]** low/cleanup.

### Security

#### AUDIT-S1 **[C]** — every secret has a hardcoded fallback, and a missing secret file fails open

`backend/src/main/resources/application.yml:44-51` ships working defaults for all four secrets:

```yaml
jwt:
  secret: ${JWT_SECRET:5367566B59703373367639792F423F4528482B4D6251655468576D5A71347437}
internal:
  api-token: ${INTERNAL_API_TOKEN:manga-library-internal-token-12345}
```

plus `minio.secretKey: minioadmin` (`:39`) and `spring.datasource.password: postgres` (`:10`).
That JWT default is a **verbatim copy of the key from a popular JWT tutorial** — it is on GitHub
tens of thousands of times. Anyone who knows it can mint a token for any email and, via
`JwtAuthFilter`, become whatever role that user holds.

This is only a latent default until you combine it with
`DockerSecretsEnvironmentPostProcessor:52-68`: if the secret file is missing or unreadable, it
logs nothing at all for that key and **silently continues**, so the app boots happily on the
tutorial key. There is no startup assertion that the secrets actually loaded.

**Fix:** fail startup when `JWT_SECRET` / `INTERNAL_API_TOKEN` are unset in a non-dev profile.
Move the dev defaults into an `application-local.yml` that production never activates.

#### AUDIT-S2 **[C]** — `/api/internal/**` is `permitAll`, guarded only by a filter with the same weak default

`SecurityConfig:44-45` marks `/api/internal/**` `permitAll()`. The only thing standing in front of
the callback API — which writes OCR regions, mutates job state, and creates layers — is
`InternalAuthFilter:17`, whose token defaults to `manga-library-internal-token-12345` (AUDIT-S1).
The backend is published through Traefik on a public hostname, so with the default in effect the
entire pipeline-mutation surface is unauthenticated.

Secondary: `token.equals(internalApiToken)` (`:32`) is a short-circuiting compare — use
`MessageDigest.isEqual` for a shared secret.

#### AUDIT-S3 **[H]** — the worker's auth is also fail-open

`worker/src/worker/main.py:81-84`:

```python
if conc.WORKER_API_SECRET and worker_api_secret != conc.WORKER_API_SECRET:
    raise HTTPException(status_code=401, detail="Unauthorized")
```

If `WORKER_API_SECRET` resolves to `""` — which `concurrency.py:48-54` will happily do when the
secret file is absent, catching the exception and printing to stdout — the guard evaluates to
falsy and **every endpoint becomes public**, including `/api/v1/jobs/submit`. Same pattern as
AUDIT-S1: the absence of a credential disables the check instead of failing.

#### AUDIT-S4 **[H]** — JWTs travel in the query string and land in the access log

Chain, all three parts verified:

1. `frontend/src/utils/useSSE.ts:25` — `EventSource` cannot set headers, so the token is appended:
   `` `${url}?token=${encodeURIComponent(token)}` ``.
2. `JwtAuthFilter:77-80` accepts `request.getParameter("token")` as a credential.
3. `application.yml:60-63` enables the Tomcat access log with pattern `'%h %l %u %t "%r" %s %b %Dms'`
   — `%r` is the full request line **including the query string**.

So every SSE connection writes a valid 24-hour bearer token to `catalina` access logs in plaintext,
where it also reaches any log shipper and the Traefik access log upstream. The token is
additionally kept in `localStorage` (`Auth.tsx:78`, `utils.ts:47`), so it is XSS-readable.

**Fix:** issue a short-lived, single-purpose SSE ticket instead of the session JWT, or move SSE
behind a cookie; and drop `%r` for `%U` in the access-log pattern.

### Pipeline correctness

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

#### AUDIT-P5 **[M]** — callbacks resolve "which job" by guessing instead of by `jobId`

`enqueueJobDirectly:306` puts `jobId` in the payload and the worker echoes it back. Yet
`handleOcrCallback:703` and `handleTranslationCallback:968` locate the job with
`findFirstByImageIdAndTypeOrderByCreatedAtDesc(imageId, type)` — newest job of that type for that
image. With a redo in flight, or an image backing pages in two chapters, this marks the wrong job
`FAILED`/`COMPLETED`. The correct identifier is already in hand.

#### AUDIT-P6 **[M]** — a lost `COMPLETED` PATCH silently re-runs the whole job

`rq_tasks.py:113` sends `update_job_status(job_id, "COMPLETED")` with `timeout=5`. On timeout the
exception is swallowed (`:58-59`, print-only). The job stays `PROCESSING` and is re-dispatched by
the stale sweeper 10 minutes later — duplicating work per AUDIT-P4. The callback that carries the
actual *results* has already landed by then, so the duplicate is pure waste plus duplicate rows.

#### AUDIT-P7 **[M]** — page-scoped Redis keys are written and never read

`triggerPageRedo:1220-1222` writes `page:ocr:reason:{pageId}` / `page:translation:reason:{pageId}`.
A grep across backend, worker and frontend finds **no reader** — the consumers at `:776` and
`:1036` read `image:ocr:reason:{imageId}` / `image:translation:reason:{imageId}`. So a page-level
re-OCR never gets its "OCR (manual-re-ocr)" layer label, and the keys accumulate in Redis with no
TTL (unlike `pipeline:trace:`, which gets `Duration.ofHours(2)`).

Same function, `:1226`: `redisTemplate.delete("pipeline:trace:" + pageId)` — trace keys are stored
under **imageId** (`:212`, `:282`, `:288`). The delete is a no-op, so a page redo inherits the
previous run's trace ID. `triggerImageRedo:1257` gets this right, which is what makes it a typo
rather than a design.

Related: the `image:*:reason:` keys are `set()` **without a TTL**. If the pipeline dies before the
callback, the key survives and mislabels the *next* run's layer.

#### AUDIT-P8 **[M]** — `pipeline:trace` expires mid-pipeline on slow runs

`:214` gives the trace key a 2-hour TTL; `:282-291` regenerates a fresh ID when it has expired. The
run in `logs/run-3-fresh.log` took ~2h for 50 pages, so traces were being silently split. The TTL
should outlive the longest realistic pipeline, or the trace should live on the `Job` row.

#### AUDIT-P9 **[M]** — regions and layers get written with `page_id = NULL`

`handleOcrCallback:713` allows `page` to be `null` (`resolvePageForCallback` returns `null` when the
page was deleted between enqueue and callback). It is then passed straight into
`region.setPage(page)` (`:740`) and `ocrLayer.setPage(page)` (`:795`) with no guard. The rows save
successfully and are then invisible to every `findByPageId` query — silent orphans that still count
against cost. Guard and abort the callback instead.

### Worker

#### AUDIT-W1 **[H]** — QA silently supports only 3 providers, 2 of which aren't in `providers.json`

`handlers/qa.py` dispatches on a hardcoded `if/elif` chain in four separate places (`:213-246`,
`:461-495`, `:763-781`, `:1039-1073`), each accepting only `openrouter`, `gemini`, `nvidia` and
falling off the end to `return None`.

`config/providers.json` ships `openrouter`, `cloudflare`, `nvidia`, `neurometric`. So:

+ **`cloudflare` and `neurometric` are selectable in the UI and do nothing in QA** — silent `None`.
+ **`gemini` is supported in code but absent from the config**, so it can't be selected.

The failure is invisible because `None` falls through to the local-LLM branch (`:277-284`), which
is itself broken (the `try_local_ai` prompt bug already tracked above), which returns something
unparseable, which yields `results = []`, which completes QA with zero findings and no error.

#### AUDIT-W2 **[H]** — `RATE_LIMIT` is a single global throttle across all providers and tasks

`utils/rate_limit.py:20-31` — when a provider does not carry its own `rate_limits`, it falls back
to the `RATE_LIMIT` env var under the lock key `"global"` (`:37`). `.env.example:105` sets
`RATE_LIMIT=10`, i.e. **one LLM call every 6 seconds across the entire worker** — OCR, translation
and QA all queue behind the same token bucket, regardless of which provider each is hitting.

**FALSIFIED IN PRACTICE 2026-08-02 — deprioritised.** The code reading above is correct, but the
fallback never engages: all four providers in `config/providers.json` carry their own `rate_limits`
(openrouter 40, cloudflare 40, nvidia 40, neurometric 60), so the `"global"` bucket is never used.
Measured on the drained run: **0.0 s of sleep across 1 sleep** in 7,924 s.

This item was previously ranked "likely the single largest throughput win available". It is inert.
The hardening is still worth doing — the global fallback should default to unlimited so that adding
a provider without `rate_limits` does not silently throttle everything — but it buys no throughput
today.

#### AUDIT-W3 **[M]** — cooldowns and lock waits burn a job slot doing nothing

Three places block a worker thread that is *holding a concurrency slot*:

+ `llm_client.py:57-64` `wait_for_cooldown` — `time.sleep` up to 60s.
+ `utils/lock.py:23-27` `acquire_lock` — spin-waits up to **600s**.
+ `translation.py:504` `try_local_ai` — `timeout=300` per endpoint × 2 endpoints = 10 minutes.

With `MAX_HEAVY_SLOTS=1` a single provider cooldown stalls all heavy work. Slots should be released
before sleeping, or the job re-queued with a delay.

#### AUDIT-W4 **[M]** — the Valkey lock is per-container and releases other holders' locks

`utils/lock.py:15` — `lock_key = f"lock:{lock_name}:{node_id}"`. Including the node ID means the
`local-llm` lock does **not** serialise across workers, which is the one job it exists to do
(`WORKER_URLS` is explicitly a comma-separated list, so multi-worker is a supported topology).

`:35` then does an unconditional `redis_client.delete(lock_key)` in `finally`. With `timeout=600`
and `expire=600` set equal, a holder that runs long enough for its lock to expire will delete the
lock a *different* holder has since acquired. Needs a random token value plus a compare-and-delete
Lua script.

#### AUDIT-W5 **[M]** — `REUSE_IDLE_SLOTS` is dead code in the push model

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

```
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

#### AUDIT-W7 **[M]** — the stale-job check hammers the heaviest endpoint, without a timeout

`rq_tasks.py:35-38`:

```python
res = requests.get(backend_url, headers=BACKEND_HEADERS)
```

Two problems. It is the only `requests` call in the file with **no `timeout`** — every sibling uses
`timeout=5` — so a wedged backend hangs a worker slot indefinitely. And the URL it hits is
`/api/internal/images/{imageId}`, i.e. `InternalJobController.getImageInfo`, which generates a
presigned URL, loads every panel, region, layer element, conversation and the previous page's text
— all discarded, because the only thing being checked is `status_code == 200`. Every job pays for
this before doing any work. Use a `HEAD`, or check the job row that is fetched two lines later
anyway.

#### AUDIT-W8 **[M]** — provider payload defects in `LLMClient`

`services/llm_client.py`:

+ `:161` Anthropic `max_tokens` is hardcoded to `4096`. A dense page truncates mid-JSON and fails to
  parse, indistinguishable from a model error.
+ `:158-171` the Anthropic branch **ignores `response_schema` entirely** — no tool-use, no
  structured output. Anthropic providers get no JSON enforcement at all.
+ `:300` `choices[0].get("message", {}).get("content", "")` returns `None` (not `""`) when the key
  is present with a null value, which is what providers send alongside a `refusal`. Downstream
  `json.loads(None)` raises `TypeError`. Use `or ""`.
+ `:68` `PROVIDER_REGISTRY = get_provider_registry()` executes at **import time**, so editing
  `providers.json` requires a worker restart — the backend, by contrast, has
  `ProviderConfigCache.reload()`. Asymmetric and surprising.
+ `:50-51` `PROVIDER_COOLDOWNS` / `PROVIDER_CONSECUTIVE_429S` are bare dicts mutated from multiple
  job threads with no lock; concurrent 429s lose increments.

#### AUDIT-W9 **[M]** — local JSON mode is not actually enforced

`translation.py:489-492` sets `payload["format"] = "json"` for Ollama. That is the field name for
Ollama's **native** `/api/generate` API, but the endpoint being called is the OpenAI-compatible
`/v1/chat/completions` shim (`:465`), which ignores it — the OpenAI shim wants
`response_format: {"type": "json_object"}`. So local structured output is silently unconstrained,
compounding the already-tracked `try_local_ai` prompt bug.

Also `:459` defaults `LOCAL_LLM_MODEL` to `gemma3:4b`, while `docker-compose.yml` and
`.env.example:81` default it to `gemma4:e4b` — a tag that does not exist (probably meant
`gemma3n:e4b`). And `:456` defaults `LOCAL_LLM_PROVIDER` to `lmstudio` where compose defaults to
`ollama`. Three different defaults for the same two settings.

### Backend (Spring)

#### AUDIT-B1 **[H]** — one scheduler thread runs the dispatcher, the sweeper and cleanup

Spring's default `TaskScheduler` pool size is **1**, and nothing in `application.yml` overrides
`spring.task.scheduling.pool.size`. Sharing that single thread:

| task | cadence |
| --- | --- |
| `WorkerDispatcherService.dispatchJobs` | every 2s, up to **30s HTTP timeout per worker** (`:193`) |
| `JobCoordinatorService.recoverStaleProcessingJobs` | every 5 min |
| `ExportCleanupService` / `DebouncedRenderService` | scheduled |

One unresponsive worker therefore stalls stale-job recovery and export cleanup for up to 30s per
dispatch attempt. Set the pool size to ≥4.

#### AUDIT-B2 **[H]** — `@Transactional` is bypassed on the startup recovery path

`JobCoordinatorService.onStartup:83,89` calls `this.resetProcessingJobsToPending()` and
`this.requeuePendingJobs()` directly. Self-invocation does not pass through the Spring proxy, so
the `@Transactional` on `resetProcessingJobsToPending:98` **does not apply** — the batch of
PROCESSING→PENDING writes runs unwrapped, and a mid-loop failure leaves the job table half-migrated.
Split into a separate bean or self-inject the proxy.

#### AUDIT-B3 **[M]** — `NullPointerException` is mapped to `400 Bad Request` and never logged

`GlobalExceptionHandler:41-49`:

```java
@ExceptionHandler({IllegalArgumentException.class, NullPointerException.class})
public ProblemDetail handleBadRequest(RuntimeException ex, WebRequest request) {
```

An NPE is a bug in our code, not a malformed client request. Mapping it to `400` means genuine
defects are reported to the caller as their fault, produce **no log line at all** (unlike
`handleInternalError:88`, which at least logs), and never show up in error-rate monitoring. This is
almost certainly a workaround for the 247 `Objects.requireNonNull` calls (AUDIT-Q1) rather than a
deliberate contract.

Two more in the same class:

+ `:92` returns `"Something went wrong: " + ex.getMessage()` to the client — leaks SQL fragments,
  file paths and internal identifiers.
+ There is no `AccessDeniedException` handler, so a `@PreAuthorize` denial thrown at method level is
  caught by the catch-all `Exception` handler and returned as **500 instead of 403**.

#### AUDIT-B4 **[M]** — SSE breaks with more than one browser tab

`SseService:32` stores `ConcurrentHashMap<UUID, SseEmitter>` — **one emitter per user**. Opening a
second tab calls `subscribe:38` which `put`s over the first emitter without completing it: tab 1's
connection leaks (server-side async request held until the 1-hour timeout at `:35`) and receives
nothing further.

Worse, `:41` registers `emitter.onCompletion(() -> emitters.remove(userId))` keyed by user, not by
emitter. When the orphaned tab-1 emitter eventually times out, its callback **removes tab 2's live
emitter from the map**, silently killing notifications for the tab that is actually in use. Needs
`Map<UUID, Set<SseEmitter>>` and removal by identity.

Also `sendPendingNotifications:67-81` does `range(0,-1)` then `delete(key)` non-atomically — a
notification pushed between the two calls is lost.

#### AUDIT-B5 **[M]** — schema is managed by `ddl-auto: update` with a competing `init.sql`

`application.yml:16` sets `spring.jpa.hibernate.ddl-auto: update` while
`docker-compose.yml` also mounts `database/init.sql` as a Postgres init script. Two sources of
truth for the schema, and `update` never drops or narrows a column, so the live schema silently
diverges from the entities over time with no migration history and no rollback. This is the single
biggest obstacle to the "plan a better backend" item above — a Flyway/Liquibase baseline is a
prerequisite for *any* migration, in Java or otherwise.

`:17` `open-in-view: true` is also explicit rather than inherited: it holds a DB connection for the
entire request and lets lazy collections load during view rendering, which is a plausible
contributor to the "backend is holding the UI back" complaint. Both deserve measurement before the
Firefox profiling pass.

#### AUDIT-B6 **[M]** — thumbnail generation is serialised on decode, contradicting its own comment

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

#### AUDIT-B8 **[L]** — assorted backend defects

+ `WorkerDispatcherService:25` — `${WORKER_URLS:http://worker:9091}` defaults to port **9091**; the
  worker listens on 8000 everywhere else (`Dockerfile EXPOSE 8000`, compose default).
+ `WorkerDispatcherService:45-55` — `@PostConstruct init()` re-reads `WORKER_API_SECRET_FILE`
  manually, duplicating work `DockerSecretsEnvironmentPostProcessor` already did.
+ `JwtAuthFilter` is a `@Component` **and** is added via `addFilterBefore` (`SecurityConfig:53`), so
  it is registered in both the servlet chain and the security chain. Register it with a
  `FilterRegistrationBean(setEnabled(false))`.
+ `JwtUtils:19` — `jwtExpirationMs` is an `int`; anything past ~24.8 days overflows.
+ `JwtAuthFilter:58` — `logger.error("Cannot set user authentication: {}", e)` fills the placeholder
  with `e.toString()` instead of attaching the throwable, so no stack trace is ever logged.
+ `InternalJobController:158-170` — five `log.info("DEBUG_TL: …")` lines at INFO on the hottest
  internal endpoint (called once per job, per AUDIT-W7).
+ `InternalJobController:74` — `updateJobStatus` writes whatever `status` string the worker sends,
  with no state-machine validation.
+ `InternalJobController:451-455` — `resolveNotificationContext` uses `pages.get(0)`, reintroducing
  exactly the "first page for this image" ambiguity that commit `5e2d5ce` removed elsewhere. Two
  chapters sharing an image will get notifications naming the wrong chapter.
+ `JobCoordinatorService:911-928` — reader mode (`source == target`) `return`s without setting any
  terminal job status, so the layout job's completion depends entirely on the worker's PATCH.

### Frontend

#### AUDIT-F1 **[M]** — the theme is rebuilt from scratch on every light/dark toggle

`src/theme.ts:3` exports `themeObj(mode)`, which `App.tsx:178` feeds through
`useMemo(() => themeObj(mode), [mode])`. Toggling the mode therefore constructs a whole new MUI
theme object and re-renders every consumer, re-serialising every Emotion style in the tree.

MUI v9 (the installed major) supports `createTheme({ colorSchemes: { light, dark }, cssVariables: true })`,
which switches themes by flipping CSS custom properties — no new theme object, no cascade of React
re-renders, and no flash on load. Migrating also unlocks `theme.vars.*`, which removes the need for
the `mode === "dark" ? … : …` ternaries currently repeated ~20 times inside `theme.ts` itself.

#### AUDIT-F2 **[M]** — inline `sx` object literals in the hottest components

| file | lines | `sx={{` literals | hooks |
| --- | --- | --- | --- |
| `ReaderRightSidebar.tsx` | 1588 | **65** | 0 |
| `QueueManager.tsx` | 1251 | 45 | 5 state / 2 effect |
| `Reader.tsx` | 3707 | 1 | 28 state / 12 effect |

Every `sx={{…}}` is a fresh object identity per render, so Emotion re-serialises and misses its
style cache. 65 of them in a 1588-line sidebar that re-renders on every reader interaction is a
concrete, measurable cause of the reported lag — worth checking in the profiling pass before
assuming the backend is at fault. Hoist static `sx` objects to module constants or move them into
`styled()`.

`Reader.tsx` at 3707 lines with 28 `useState` is the other half: any state change re-renders the
entire reader. This is the natural first target for a deepening refactor — the sidebar, the canvas
overlay and the page navigation are three independent modules sharing one component.

#### AUDIT-F3 **[M]** — SSE reconnects forever with no backoff

`useSSE.ts:66-71` — on error, wait a flat 5s and bump `retryCount`, which is in the effect's
dependency array, triggering a reconnect. No exponential backoff and no attempt cap, so a backend
outage turns every open tab into a 12 req/min heartbeat against a service that is already down. The
`EventSource` built-in reconnect is also still active until `close()` lands.

#### AUDIT-F4 **[M]** — light-mode secondary text fails WCAG AA by a wide margin

`theme.ts:19` sets `text.secondary` to `#b0b0b0`. Against `background.paper: #ffffff` that is a
contrast ratio of **≈2.2:1**, well under the 4.5:1 AA threshold for body text. Meanwhile
`text.disabled` (`#786e6a`) sits at ≈4.6:1 — so *disabled* text is more legible than *secondary*
text in light mode, inverting the visual hierarchy. Dark mode is fine (`#afafaf` on `#1e1e1e`
≈7.4:1). Something in the region of `#5f5f5f` restores AA.

#### AUDIT-F5 **[L]** — smaller frontend items

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

### Docker & Compose

#### AUDIT-D1 **[H]** — `db-backup` has an invalid restart policy and has not run since 2026-07-28

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

#### AUDIT-D3 **[M]** — `depends_on` ignores the healthchecks that are already defined

Every stateful service defines a `healthcheck`, but `backend:depends_on` (`:124-127`) and
`worker:depends_on` (`:213-216`) use the short list form, which only waits for *container start*.
The backend therefore races Postgres on a cold boot. Switch to
`depends_on: { db: { condition: service_healthy } }` — the healthchecks are already written, they
just aren't wired up.

#### AUDIT-D4 **[M]** — `MINIO_ENDPOINT` means two different things

`docker-compose.yml:107` gives the backend `${MINIO_ENDPOINT:-http://minio:9000}` (with scheme);
`:172` gives the worker `${MINIO_ENDPOINT:-minio:9000}` (without — the Python MinIO SDK requires
it that way). Both read the **same variable**. The defaults paper over it, but the moment anyone
sets `MINIO_ENDPOINT` in `.env` — which the compose file invites — exactly one of the two services
breaks. It is also absent from `.env.example`, so there is no documented correct value. Split into
`MINIO_ENDPOINT` and `MINIO_ENDPOINT_INTERNAL`.

#### AUDIT-D5 **[L]** — remaining infrastructure items

+ `:9`, `:52`, `:76` publish Postgres (5432), Valkey (6379) and the MinIO console (9001) to the host.
  Valkey has no `requirepass`. On a multi-user or bridged host that is an unauthenticated data
  store on the LAN. Drop the port mappings — everything that needs them is on `manga-net`.
+ `LOG_LEVEL` defaults to `DEBUG` for both backend (`:113`) and worker (`:200`) in the shipped
  compose file.
+ `backend/Dockerfile:9-12` — the comment reads *"npm ci: reproducible, faster, uses lockfile
  exactly — preferred over npm install for CI/production"* and the very next line runs
  `npm install`. The lockfile is not honoured and builds are not reproducible.
+ `backend/Dockerfile:66` — no `-XX:MaxRAMPercentage`; the JVM defaults to 25% of container RAM,
  which is both wasteful and prone to OOM-kill under the thumbnail load.
+ No `deploy.resources` limits on any service — already noted in `TODO.md` for the ML container,
  applies to all of them.

### Testing

#### AUDIT-T1 — the "e2e" test is not an e2e test

`worker/tests/test_translation_flow_e2e.py` is the answer to the "is the testing real?" question
above, and it is not a good one. The test carries **17 `@patch` decorators** and exactly three
assertions:

```python
mock_try_llm_qa.assert_called_once()
mock_try_vlm.assert_called_once()
assert mock_post.call_count == 7
assert mock_render_minio.put_object.call_count == 2
```

Every assertion is about a mock the test itself installed. Nothing checks the *content* of a single
callback: not the translated text, not the region IDs, not the layer geometry, not the cost. A
regression that posted `{}` to all seven callbacks would pass. `mock_post.call_count == 7` is also
brittle in the wrong direction — it breaks on any refactor while proving nothing about correctness.

The suite-wide numbers say the same thing: **320 `@patch` + 191 `MagicMock` across 46 files**, and
**217 tests pass in 6.3 seconds** — a full-pipeline suite that touches no real I/O at all. Worst
mock-to-assert ratios:

| file | mocks | asserts |
| --- | --- | --- |
| `test_translation_flow_e2e.py` | 29 | 2 |
| `test_rq_tasks.py` | 28 | 2 |
| `test_qa_extra.py` | 31 | 8 |
| `test_qa_pipeline.py` | 46 | 14 |

This is what `mock_router.md` is for, and it is the strongest argument yet for building it: the
handlers can only be tested meaningfully against something that speaks the wire protocol.

#### AUDIT-T2 — the error branches, which is where the bugs are, have no coverage

`test_llm_client.py` has five tests. All five stub a `200` response. There is **no test** for:

+ the `429` path and its exponential cooldown (`llm_client.py:260-270`)
+ the `json_schema` → `json_object` degradation (`:272-278`)
+ `5xx` → `TransientAPIError` → Tenacity retry (`:280`)
+ `4xx` → `PermanentAPIError` (`:282`)
+ `requests.exceptions.Timeout` / `ConnectionError` (`:255-258`)

Every defect in AUDIT-W8 lives in an untested branch. Same shape in the backend: 10 test classes use
`@ExtendWith(MockitoExtension)` against 11 using `@SpringBootTest`/`@DataJpaTest`, and none of the
dispatcher's failure paths (AUDIT-P2, AUDIT-P3) are exercised.

**Suggested order:** these are cheap to write against the existing mocks and would have caught real
bugs — do them before the mock-router work rather than waiting for it.

### Code quality

#### AUDIT-Q1 — 247 `Objects.requireNonNull` calls, most of them impossible to trigger

```text
$ grep -rho "Objects.requireNonNull" backend/src/main | wc -l
247
```

Concentrated in `JobCoordinatorService` (61), `PageController` (36), `SeriesController` (30),
`LayerController` (28). A representative sample:

```java
Objects.requireNonNull(ocrLayer, "ocrLayer cannot be null");   // :801, one line after `new Layer()`
Objects.requireNonNull(conv, "conv cannot be null");           // :890, after `new Conversation()`
Objects.requireNonNull("pipeline:trace:" + imageId)            // :212, a string concatenation
Objects.requireNonNull(Duration.ofHours(2))                    // :214, a factory result
Objects.requireNonNull(imageId, "imageId cannot be null")      // :843, after UUID.fromString already threw
```

None of these can fire. They add noise to every call site, and they are almost certainly what drove
the NPE→400 mapping in AUDIT-B3. A mechanical pass to delete the ones on freshly-constructed values,
literals and already-validated locals would remove several hundred lines and let `NullPointerException`
go back to meaning "bug".

#### AUDIT-Q2 — LLM thinking-out-loud committed as comments

```java
// PageService.java:430-431
// Skip TL/QA fields in OCR cloning just to be clean, but they will be overwritten if TL is cloned.
// Wait, actually OcrRegion contains TL/QA fields. If we ONLY clone OCR, we should clear TL fields.
```

```java
// JobCoordinatorService.java:1052-1056
// if summary is passed inside cost object, we can leave it there, or if we need to we can
// extract it.
// But user said move tl cost and summary under 'tl'.
```

Both are an assistant reasoning with itself, left in the source. Worth a grep for `// Wait`,
`// But user said`, `// Actually` before the next review.

#### AUDIT-Q3 — vestigial and misleading code

+ `handlers/qa.py:211` — builds a `cache_key`, logs it with a hardcoded `(hit=False)`, and **there is
  no cache**. Four copies of this across the QA paths, actively misleading during debugging.
+ `app.py:44-46` — `sum(1 for f in files if … and not os.remove(f))` performs the deletion as a side
  effect inside a generator, relying on `os.remove` returning `None`. Works; should not survive
  review.
+ `rq_tasks.py:100` — dispatches on `"queue:region-redo"`, a queue name the backend never creates.
+ `utils/rate_limit.py:50` — logs `[Translation]` from a rate limiter shared by OCR and QA.
+ `PageService.cloneOcrData:487-516` and `cloneTranslationData:570-599` — the 25-line LayerElement
  copy is duplicated verbatim. One `cloneLayerElement(source, targetLayer, regionIdMap)` helper
  removes both copies and is the natural place to fix the next field that gets forgotten.
+ `JobCoordinatorService.handleLayoutCallback:885` — `resolvePageForCallback` is called inside the
  conversation loop and then again at `:912`; it is a DB round-trip each time.
+ `resolveModel:561-573` — checks `!chapterVal.equals("inherit")` without trimming first, though the
  preceding condition trims. `" inherit "` passes through as a real model name.

### Suggested fix order

**Revised 2026-08-02** against measured data from the first drained run
([perf_analysis_backend_2026-08-02.md](./perf_analysis_backend_2026-08-02.md)). The previous
ordering ranked AUDIT-W2 as "likely the single largest throughput win available" — it is inert, and
the item that actually holds throughput (**AUDIT-W10**) was not in the list at all, because no run
had ever drained.

1. **AUDIT-S1 / S2 / S3** — the fail-open secrets. One afternoon, removes the worst exposure.
   Unchanged: severity is independent of the perf data.
2. **AUDIT-D1** — confirm whether backups are actually running. Everything else is recoverable.
3. **AUDIT-W10** — raise `MAX_LIGHT_SLOTS`. Config-only, attacks 99% of measured queue wait, and
   nothing else on this list moves throughput comparably. Change `CONCURRENT_JOBS` with it and
   sanity-check AUDIT-W6's arithmetic. Re-run the drained capture afterwards to confirm.
4. **AUDIT-P4** — duplicate work. The one correctness defect measurably costing work today
   (22 re-dispatches / 255 jobs). Needs callback idempotency, not just the tombstone.
5. **AUDIT-P1 / W1** — the provider/task-key mismatches. Both are silent-wrong-answer bugs, which
   are the expensive kind. The display half of P1 is already fixed; the clone-path half is not.
6. **AUDIT-T2** — the error-branch tests, before the mock-router build rather than after.
7. **AUDIT-P2 / P3 / B1** — the dispatcher defects. Demoted from #3: all three are real, but the
   drained run shows they are costing ~nothing right now (3.2% / 1.3% starvation, 0 stranded jobs).
   Fix as latent correctness, not as a throughput measure.
8. **AUDIT-W2** — demoted from #4. Falsified in practice; keep only the "global fallback should be
   unlimited" hardening so a future provider without `rate_limits` cannot silently throttle
   everything.
9. Everything else as it is touched.

**Not on this list on purpose:** the [worker pull model](./worker_pull_model.md). Measured, it would
remove **408 s of 49,058 s of queue wait (0.83%)**. Worth building for latency, resilience and
multi-worker scaling — not for throughput, and not before #3.

**Untriaged:** `translation` failed **11 of 50 (22%)** on the drained run, with 33 tracebacks in
`worker.log`. No audit item covers this yet; it may belong above #4.
