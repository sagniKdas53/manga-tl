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

## Full-Stack Audit — 2026-08-01

A read-through of backend (`11.8k` LoC Java), worker (`8.3k` LoC Python), frontend (`26.8k` LoC
TS/TSX), the Dockerfiles and `docker-compose.yml`, cross-checked against `docs/` and the GitNexus
graph. Findings are new unless marked otherwise, and are ordered by severity. Every item carries a
`file:line` anchor so it can be picked up cold.

Conventions: **[C]** critical · **[H]** high · **[M]** medium · **[L]** low/cleanup.

> **Triaged against the code on 2026-08-05.** Every entry below was re-read against the working tree
> and the closed ones moved to [archive.md](./archive.md). Six were **already fixed while still
> marked open** — AUDIT-P1, AUDIT-P4, AUDIT-W6, AUDIT-W10, and one bullet each from AUDIT-W8 and
> AUDIT-B8 — and AUDIT-T2's backend half was re-scoped by fixes that landed elsewhere. Severities
> and line anchors below have been re-checked; where an anchor had drifted it is corrected inline.
>
> What survives here is open **as of 2026-08-05**, verified, and nothing in it is stale.

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

#### AUDIT-P6 **[M]** — a lost `COMPLETED` PATCH silently re-runs the whole job

`rq_tasks.py:113` sends `update_job_status(job_id, "COMPLETED")` with `timeout=5`. On timeout the
exception is swallowed (`:58-59`, print-only). The job stays `PROCESSING` and is re-dispatched by
the stale sweeper 10 minutes later — duplicating work per AUDIT-P4. The callback that carries the
actual *results* has already landed by then, so the duplicate is pure waste plus duplicate rows.

#### AUDIT-P8 **[M]** — `pipeline:trace` expires mid-pipeline on slow runs

*Anchors re-checked 2026-08-05; both `Duration.ofHours(2)` calls still present.*

`:246` gives the trace key a 2-hour TTL; `:303-309` regenerates a fresh ID when it has expired. The
run in `logs/run-3-fresh.log` took ~2h for 50 pages, so traces were being silently split. The TTL
should outlive the longest realistic pipeline, or the trace should live on the `Job` row.

### Worker

#### AUDIT-W1 **[L]** — QA's two default-model maps duplicate `providers.json`

*Re-ranked **[H] → [L]** on 2026-08-05, applying the 2026-08-04 correction the entry already carried
in its body but never applied to its heading. The original title is preserved below.*

**Original title:** QA silently supports only 3 providers, 2 of which aren't in `providers.json`

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

#### AUDIT-W2 **[L]** — the global `RATE_LIMIT` fallback should default to unlimited

*Re-ranked **[H] → [L]** on 2026-08-05. Measured inert twice (0.0 s, then 1.2%); only the hardening
below survives. The original title is preserved because the code reading under it is still correct.*

**Original title:** `RATE_LIMIT` is a single global throttle across all providers and tasks

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

*Anchors re-checked 2026-08-05; all three blocking calls confirmed present.*

Three places block a worker thread that is *holding a concurrency slot*:

+ `services/llm_client.py:93-100` `wait_for_cooldown` — `time.sleep` up to 60s.
+ `utils/lock.py:21-26` `acquire_lock` — spin-waits at `time.sleep(0.5)` up to **600s**.
+ `services/translation.py:576` `try_local_ai` — `timeout=300` per endpoint × 2 endpoints = 10
  minutes. Note the second local path (`:990`) already uses a `(10, 45)` connect/read pair, so the
  fix pattern exists in the file; `try_local_ai` just never got it.

With `MAX_HEAVY_SLOTS=1` a single provider cooldown stalls all heavy work. Slots should be released
before sleeping, or the job re-queued with a delay.

**Less urgent than when filed, for one tier only.** AUDIT-W10 is closed and light slots now derive
to 4, so a cooldown on a light job no longer halts the light tier. Heavy is still `MAX_HEAVY_SLOTS=1`
by design — that tier is local PaddleOCR on CPU and already saturates the container — so the
original "one cooldown stalls all heavy work" reading is unchanged there.

### Backend (Spring)

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

#### AUDIT-B8 **[L]** — assorted backend defects

*Re-verified bullet-by-bullet 2026-08-05. **One of the nine is fixed and has been archived**; the
other eight are confirmed present, with anchors updated. Note that `next-step.md`'s one-line summary
of this entry listed only five of them — the `@PostConstruct` duplication, the `JwtAuthFilter`
logging placeholder and the reader-mode terminal status were dropped somewhere between the two files
and are restored here.*

+ ~~`JwtAuthFilter` is registered in both the servlet chain and the security chain.~~ **Fixed** —
  `SecurityConfig:105-110` registers it through a `FilterRegistrationBean` with
  `setEnabled(false)`, and `SseTicketAuthFilter` got the same treatment at `:112`.

Still open:

+ `WorkerDispatcherService:27` — `${WORKER_URLS:http://worker:9091}` defaults to port **9091**; the
  worker listens on 8000 everywhere else (`Dockerfile EXPOSE 8000`, compose default).
+ `WorkerDispatcherService:47-55` — `@PostConstruct init()` re-reads `WORKER_API_SECRET_FILE`
  manually, duplicating work `DockerSecretsEnvironmentPostProcessor` already did.
+ `JwtUtils:20` — `jwtExpirationMs` is an `int`; anything past ~24.8 days overflows. Used at `:31`
  as `new Date(new Date().getTime() + jwtExpirationMs)`, so the overflow lands in the past.
+ `JwtAuthFilter:58` — `logger.error("Cannot set user authentication: {}", e)` fills the placeholder
  with `e.toString()` instead of attaching the throwable, so no stack trace is ever logged.
+ `InternalJobController:189-196` — five `log.info("DEBUG_TL: …")` lines at INFO on the hottest
  internal endpoint. Still called once per job to fetch the image for processing; AUDIT-W7 (now
  closed, see archive.md) only moved the *stale check* off it onto a HEAD.
+ `InternalJobController:68-105` — `updateJobStatus` writes whatever `status` string the worker
  sends straight onto the row (`job.setStatus(payload.get("status"))`), with no state-machine
  validation and no enum. It special-cases `PENDING` and `FAILED` for *logging* only, so a typo
  reaches the DB and every downstream `equals` comparison silently stops matching.
+ `InternalJobController:651` — `resolveNotificationContext` uses `pages.get(0)`, reintroducing
  exactly the "first page for this image" ambiguity that commit `5e2d5ce` removed elsewhere. Two
  chapters sharing an image will get notifications naming the wrong chapter.
+ `JobCoordinatorService:1029-1035` — reader mode (`source == target`) `return`s after logging
  "Skipping translation, render, and QA" without setting any terminal job status, so the layout
  job's completion depends entirely on the worker's PATCH — which AUDIT-P6 shows can be lost.

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

**Re-counted 2026-08-05 and the trend is the wrong way.** The suite grew and got *more* mocked, not
less: **342 `@patch` across 49 files**, up from 320 across 46. `test_translation_flow_e2e.py` itself
is now **19 `@patch` against 4 `assert`s**, so the two tests added since it was filed were the same
shape as the ones it criticises. Nothing here is stale; it is worse.

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
> **~~Backend half still open~~ — that framing is stale as of 2026-08-05.** It said "none of the
> dispatcher's failure paths are exercised, so AUDIT-P2 and AUDIT-P3 have no test to fail."
> `WorkerDispatcherServiceTest.java` is now **639 lines** and covers `PermanentRejection_400`,
> `PermanentRejection_422` (both AUDIT-P2's paths), `MultipleWorkers_AllFail`,
> `FirstThrowsExceptionSecondAccepts`, `ServerError500`, `CapabilitiesQueryFails`,
> `AllWorkersInCooldown`, `LightSlotFull` and both independent-slot rejection cases. Those landed
> alongside P2's and P3's fixes without anyone updating this note.
>
> **What is actually left**, and it is small: AUDIT-P3's fix was a `break` rather than a `continue`
> — the choice that stops one undispatchable job from blocking its slot class — and no test is named
> for it. A test that queues an undispatchable job ahead of a dispatchable one and asserts the
> second still goes out would pin it. That is one test, not a body of work.
>
> With the worker half done (`ffab71d`) and the backend half down to a single test, **this entry is
> now smaller than AUDIT-T1**, which is the opposite of how the two were ranked when filed.

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

#### AUDIT-Q1 — 249 `Objects.requireNonNull` calls, most of them impossible to trigger

*Re-counted 2026-08-05: **249**, up 2 from the filed 247. Nobody has been adding them deliberately;
they arrive with new code because the surrounding style invites them. That is the argument for doing
the mechanical pass rather than waiting — the count only moves one way on its own.*

```text
$ grep -rho "Objects.requireNonNull" backend/src/main | wc -l
249
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

*Anchors re-checked 2026-08-05; both still present, line numbers updated.*

```java
// PageService.java:669-670
// Skip TL/QA fields in OCR cloning just to be clean, but they will be overwritten if TL is cloned.
// Wait, actually OcrRegion contains TL/QA fields. If we ONLY clone OCR, we should clear TL fields.
```

```java
// JobCoordinatorService.java:1318-1320
// if summary is passed inside cost object, we can leave it there, or if we need to we can
// extract it.
// But user said move tl cost and summary under 'tl'.
```

Both are an assistant reasoning with itself, left in the source. **The suggested grep has now been
run** — `// Wait`, `// But user said` and `// Actually` across `backend/src/main/java` return
exactly these two hits and nothing else, so this entry is two comments, not a class of problem.

#### AUDIT-Q3 — vestigial and misleading code

*Re-verified bullet-by-bullet 2026-08-05. All seven confirmed present; anchors updated. One count is
lower than filed and one bullet has grown a wider blast radius — both noted inline.*

+ `handlers/qa.py:390-391` and `:599-600` — builds a `cache_key`, logs it with a hardcoded
  `(hit=False)`, and **there is no cache**. **Two** copies, not the four filed; the other two went
  with the `if/elif` chains AUDIT-W1 records as removed.
+ `worker/app.py:46` — `sum(1 for f in files if … and not os.remove(f))` performs the deletion as a
  side effect inside a generator, relying on `os.remove` returning `None`. Works; should not survive
  review.
+ `rq_tasks.py:107` — dispatches on `"queue:region-redo"`, a queue name the backend never creates:
  `JobCoordinatorService:1432` only ever produces `region-redo-ocr` or `region-redo-tl`, and both
  are already handled at `:105-106`. Dead branch.
+ `utils/rate_limit.py:32` and `:51` — logs `[Translation]` from a rate limiter shared by OCR and QA.
+ `PageService.cloneOcrData:648` and `cloneTranslationData:762` — the 25-line LayerElement copy is
  duplicated verbatim. One `cloneLayerElement(source, targetLayer, regionIdMap)` helper removes both
  copies and is the natural place to fix the next field that gets forgotten.
+ `JobCoordinatorService.handleLayoutCallback:992` — `resolvePageForCallback` is called inside the
  conversation loop and then again at `:1019`; it is a DB round-trip each time.
+ **`JobCoordinatorService.isOverride:588-593`** — checks `!value.equals("inherit")` without trimming
  first, though the preceding condition trims. `" inherit "` passes through as a real model name.
  **This is no longer local to `resolveModel`.** The predicate has been extracted to a `public
  static` and its own Javadoc now says *"anything that reads this must use the same predicate the
  pipeline uses, otherwise the UI can report a different model from the one that actually runs — see
  `SeriesController.toChapterDto`."* So the untrimmed compare is now the shared definition of "is
  this an override", and a padded value disagrees with the pipeline in exactly the way that comment
  warns about. Cheapest fix in the file: trim once into a local and compare against that.
