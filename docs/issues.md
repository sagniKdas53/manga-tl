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

## `try_local_ai` ignores its `prompt` argument — **RESOLVED 2026-08-05**

Fixed in worker `2b37cdd` (pointer bump `e8ccb49`). The caller's prompt now becomes the system
message; the hardcoded translation prompts remain the default for a caller that supplies none.
Regression tests assert on the outgoing payload, since the failure mode was silence. Detail in
[archive.md](./archive.md) under *The 2026-08-05 sitting*.

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

**Update 2026-08-03 — a concrete instance, on the frontend this time.** The Reader test
`"reloads layers and shows toast on job_update SSE event"` was de-flaked on 2026-07-28 (`0a5296a`)
by widening its assertion into a `waitFor`. It flaked again, and the cause turned out to be a real
lost-invalidation race in `Reader.tsx` — see [archive.md](./archive.md#reader-lost-invalidation-race-2026-08-03).
The lesson generalises past that one test: **a flaky test is a hypothesis about a race, and
relaxing its timing discards the hypothesis.** Worth grepping for other assertions that were widened
rather than diagnosed before trusting the frontend suite as a regression guard.

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

> **Before filing or fixing anything that "closes an open endpoint": read
> [security_boundary.md](./security_boundary.md).** The derived image variants
> (`/api/images/*/thumbnail`, `/api/images/*/reader`) are public **on purpose** and are not a
> finding. Everything that decides, changes or reveals state stays authenticated.

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

**Status: DONE 2026-08-05 (`a8abea3`) — and the mechanism above is wrong.** The rows do *not* save
successfully. `ocr_regions.page_id` and `layers.page_id` are `NOT NULL` both in the entity mapping
(`@JoinColumn(nullable = false)`) and in the live schema — checked against the running database and
with a throwaway Testcontainers probe, which threw `ConstraintViolationException: null value in
column "page_id"`. There are no silent orphans and there never were. What actually happened is a
`DataIntegrityViolationException` at commit that rolls back the *entire completed OCR result*; the
job then sits `PROCESSING` until `recoverStaleProcessingJobs` requeues it, the whole expensive OCR
pass runs again and fails identically, up to `maxAttempts`. Real defect, wrong reason, and worse on
cost than "still count against cost" suggests. The guard now fails the job once with a reason.

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
unparsable, which yields `results = []`, which completes QA with zero findings and no error.

**Correction 2026-08-04 — the dispatch half of this is stale.** Found while researching a Mistral
provider entry (archived under F.2 in [archive.md](./archive.md)). The four hardcoded `if/elif`
chains no longer exist: `_qa_cloud_llm` (`handlers/qa.py:200`) and `_qa_cloud_vlm` (`:219`) are
provider-generic and route through `LLMClient` for any provider in `config/providers.json` — their
docstrings say so explicitly. What remains is narrower: `QA_DEFAULT_LLM_MODELS` /
`QA_DEFAULT_VLM_MODELS` (`:38-46`) still list only `openrouter`, `gemini`, `nvidia`, so a provider
absent from those maps has no built-in default and `_resolve_qa_model` returns `None` **when no
model is configured at any level**. Since `providers.json` carries per-provider `defaultQALLMModel`
/ `defaultQAVLMModel`, that path is reachable but no longer silent — `_resolve_qa_model` logs the
reason. Re-rank as **[L]**: delete the two default maps in favour of the config, rather than
extending them.

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

**Second data point, 2026-08-04** (`20260803-211221`, 30 pages): **16.9 s across 13 sleeps in
1,457 s of wall — 1.2%.** Non-zero this time but still noise. Consistent with the 0.0 s baseline;
the reading stands. Only the unlimited-default hardening remains.

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

### Backend (Spring)

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

#### AUDIT-F8 **[L]** — lists are fetched whole; no pagination, search or debounce

`App.tsx:216` fetches `/api/series` in full; the series route fetches every chapter. There is **no
search UI anywhere** in the app and **zero** uses of debounce or throttle.

yt-diff paginates server-side (`rowsPerPage` 10/25/50 with start/stop offsets,
`PlayList.jsx:380`) and debounces its search at 1000 ms — because it was built against libraries
large enough to force the issue.

Not a problem at the current library size. Recorded because the fetch-everything assumption is
baked into the routing layer, where it is most expensive to change later. **Decide the ceiling
rather than the fix:** if a few hundred series is the realistic cap, write that down and close
this. Debounced search is a cheap independent win either way.

#### AUDIT-F9 **[L]** — responsive behaviour is never verified

**Zero** uses of `useMediaQuery` or `theme.breakpoints` — all responsiveness is `sx`/CSS.
`vitest.setup.ts` mocks `localStorage`, `ResizeObserver` and `URL.createObjectURL` but not
`matchMedia`, and all 43 test files run at one implicit viewport.

yt-diff runs its whole suite twice, at 375×667 and 1280×720, via vitest `projects` with
per-viewport `matchMedia` shims. **Do not copy that here** — it is load-bearing there because
yt-diff branches on `useMediaQuery` in 9 places, and there are no such branches here for it to
exercise. jsdom does not lay out CSS, so the only thing that can actually check this is a real
browser: a Playwright viewport smoke test over the reader and dashboard. Given the primary device
is an Android tablet, nothing checks it today.

### Docker & Compose

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

> **Worker half DONE** (`ffab71d`). `test_llm_client.py` is now 16 tests and **all five branches
> listed below are covered**: 429 + cooldown escalation (×3, including `Retry-After`),
> `json_schema` → `json_object` degradation, `5xx` → Tenacity retry (×2), `4xx` →
> `PermanentAPIError` (×2, including that a non-401 4xx does *not* park the provider), and
> timeout/connection errors. Auth-failure parking gained two more in the same pass.
>
> **Backend half still open, and it is the part that matters now**: none of the dispatcher's failure
> paths are exercised, so AUDIT-P2 and AUDIT-P3 have no test to fail. Re-scope this entry to that
> before picking it up — the "five cheap tests against existing mocks" framing below is spent.

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
