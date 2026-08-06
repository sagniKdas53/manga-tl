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
**not** the rate limiter (AUDIT-W2, falsified and now closed — see
[archive.md](./archive.md)). It is `MAX_LIGHT_SLOTS=1`: four light stages
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

**Update 2026-08-07 (AUDIT-B5):** measured the one narrow slice of this that gated the schema
baseline — does the worker keep its own view of job state, so the baseline would have to reconcile
two schemas? No. `docker-compose.yml`'s `worker` service carries no `POSTGRES_*`/`SPRING_DATASOURCE_*`
env vars at all, and `worker/` has zero `psycopg`/`sqlalchemy`/any-Postgres-client dependency.
`jobs`, `queue_job` and `job_costs` are owned exclusively by the backend's Postgres schema; the
worker's only state touchpoints are Redis (the queue) and an HTTP callback
(`BACKEND_CALLBACK_URL`) back to the backend. So the schema baseline does not depend on this
question either way — a merged worker would still go through the same repositories, not a second
schema. The bigger architectural question (should the split exist at all) is untouched and still
open; this only closes the narrow "does the DB schema need to account for it" sub-question.

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
>
> **All four `AUDIT-S*` findings are closed** (S1, S2, S3, S4 — fixed 2026-08-02, verified against
> the code and the running stack on 2026-08-06). They sat here as "open" for four days because the
> handoff rule *"security is tracked separately, don't fold it in"* was read as *don't triage it
> either*. Reasoning and the live probes are in
> [archive.md](./archive.md#the-2026-08-06-thirteenth-sitting--the-whole-security-track-was-already-closed).
>
> **Security is not exempt from verification.** If a finding lands here again, it gets read against
> the code like any other entry.

### Pipeline correctness

### Worker

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

*Re-verified bullet-by-bullet 2026-08-06. **Three of five are now fixed and archived** (the published
ports, the `DEBUG` log defaults, the `npm install`). The two below are the memory pair, and both were
**wrong as filed** — corrected here. They are deliberately deferred: they cannot be sized without a
measured peak, and this kernel cannot supply one.*

+ `backend/Dockerfile:66` — no `-XX:MaxRAMPercentage`. **The filed reasoning is inverted.** The
  backend has no `deploy.resources` limit, so "25% of container RAM" is 25% of the *host*: on this
  19.3 GiB box the JVM already gets a ~4.8 GiB max heap. It is neither starved nor OOM-prone for
  being too small. Adding `MaxRAMPercentage=75` **on its own makes it strictly worse** — ~14.5 GiB.
  This bullet is only meaningful landed together with the one below, and only after the pair is
  sized.
+ No `deploy.resources` limits on **db, db-backup, redis, minio or backend**. **The filed wording
  ("any service") is stale** — the worker was capped at 2 CPUs / 4 GiB on 2026-08-01 and `TODO.md`
  line 163 is checked off. What remains is the other five.
+ **Why both are deferred, and what unblocks them.** The worker's 4 GiB came from a *measured*
  2.1 GiB peak. There is no equivalent number for the backend and no cheap way to get one here:
  kernel 5.15's cgroup v2 has no `memory.peak` (added in 6.8), so there is no high-water mark to
  read, and instantaneous `docker stats` is not a peak — backend idles at 433 MiB, db 69 MiB,
  valkey 10 MiB, minio 123 MiB. Sizing a cap from idle numbers on a JVM that is currently allowed
  4.8 GiB is how you get an OOM-kill under thumbnail load. **Get a peak first:** sample
  `memory.current` through a thumbnail-heavy run, or run the backend briefly under a generous cap
  and watch `memory.events`. Then set the cap and `MaxRAMPercentage` together, one variable.

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
