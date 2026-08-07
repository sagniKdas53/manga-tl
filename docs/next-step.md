# Handoff — 2026-08-07 (nineteenth sitting)

> **AUDIT-F10 + F11 + F12 closed, plus AUDIT-T3's frontend half.** Both `[H]` regressions from
> `8c4c509` are gone. Both were reproduced as failing tests against the real hook *before* any
> fix, and PROBE B reproduced the eighteenth sitting's number verbatim
> (`expected 15 to be less than or equal to 3`) — neither finding was stale.
>
> **Gates: `mvn -o clean verify` → `BUILD SUCCESS`, 424 backend tests (untouched). `vitest` →
> 326/326 across 46 files**, up from 316/45. `npx eslint` clean on every changed file — with the
> `react-hooks/exhaustive-deps` suppression *deleted*, not moved.
>
> **61 filed, 51 closed, 10 open (84%).** No `[C]`, and **no `[H]`** — the board is back to two
> `[M]` and five `[L]` plus three unranked. See [§ Where issues.md stands](#where-issuesmd-stands).
>
> **The reindex command in the last handoff does not work on this box. The fixed one is in
> [§ GitNexus](#gitnexus)** — it needs two env vars, and without them `analyze` exits 0 having
> written nothing.

## What this sitting did

1. **Reindexed GitNexus first**, as the last handoff insisted — and it took two attempts, see
   § GitNexus. `impact()` on `usePaginatedResource` then returned `LOW`, one direct caller
   (`AppContent`, 7 flows). Before the reindex the same call returned "symbol not found", which
   reads like a safety signal and is actually blindness.
2. **Reproduced both probes as permanent tests** in
   `frontend/src/__tests__/hooks/usePaginatedResource.test.ts`, red against the unfixed hook.
   Eight new red tests total, covering F10, F11's three parts, and F12's two.
3. **Fixed all three findings in one pass** over `usePaginatedResource.ts`, as the queue specified.
4. **Closed AUDIT-T3's two frontend bullets**, including a new integration test at the seam.
5. Docs: F10/F11/F12 removed from `issues.md`, T3 amended, reasoning into `archive.md`.

## The fixes

Full reasoning is in
[archive.md](./archive.md#the-2026-08-07-nineteenth-sitting--audit-f10--f11--f12); this is the
shape.

**F10** — `fetchPage` depends on `paramsKey` (`new URLSearchParams(params ?? {}).toString()`) and
rebuilds its query *from that string*, so the dependency and the request cannot drift. The
`eslint-disable` is gone and lint is clean without it. `sortKey` — the one thing the rule would
still have demanded — moved to a ref assigned in an effect (assigning during render trips
`react-hooks/refs`), same pattern `LoadMoreSentinel` already uses.

**F11** — all three changes the finding specified: `loadMore` seeks the lowest *unloaded* index;
`hasMore` is `loadedPageCount < totalPages`; `fetchPage` refuses `pageIndex >= totalPages` once
known. `totalPages` is kept in state (for `hasMore`) and a ref (for the synchronous guard).

**F12** — `isLoading` is `inFlightCount > 0`. On reset the count is deliberately *not* zeroed;
the in-flight requests each still decrement once. A dedupe hole was closed in passing:
`fetchPage`'s `finally` deletes from the Set it captured, not from a `inFlightRef.current` a reset
may have replaced.

### Two things worth knowing before you touch this again

**Two pre-existing tests went red on F11's backstop, and their fixtures were the bug.** Both
declared `size: 25, totalElements: 2` — a *one-page* resource — then expected a page 1 to exist.
They passed only because nothing bounded the walk. Rewritten at page size 1. The old fixtures
encoded the defect as the expectation, which is the same failure mode AUDIT-T3 is about.

**AUDIT-F12's error bullet was filed slightly too strongly, and this is corrected in the
archive.** It said failures are "invisible" and go "only to `console.error`". Not quite:
`safeFetch` dispatches a global `api-error` event and `App.tsx`'s `GlobalErrorListener` toasts it,
so a failure was never silent. What *was* true is that the list surface couldn't distinguish a
failed page-0 fetch from an empty library. The hook now exposes `error: string | null`
(generation-guarded), `App.tsx` passes it as `loadError`, and `Dashboard` renders an `Alert`.

## Where `issues.md` stands

**61 filed. 10 open. 51 closed — 84%.** (Was 61/13/48 = 79%.)

| sev | open | which |
| --- | --- | --- |
| **[C]** | 0 | — |
| **[H]** | 0 | — |
| **[M]** | 2 | W3, B10 |
| **[L]** | 5 | F9, D5, F13, B11, Q2 |
| unranked | 3 | T1, Q1, T3 |

`AUDIT-T3` stays open on its **third bullet only** (`@WebMvcTest` cannot prove a pagination fix)
— that one is backend and belongs with AUDIT-B10.

## Roadmap

Unchanged from the last handoff apart from step 1 being done. The user's 2026-08-07 ordering
still governs.

### 1. Next up — AUDIT-B10 + AUDIT-B11 (backend pagination hardening)

**B10 needs a measurement before a fix, and this has not been done.** `PageController.listPages`
forwards the caller's `?sort=` into Spring Data unvalidated while its two siblings allowlist
theirs. Hit the **live** endpoint with `?sort=bogus` and `?sort=id,desc` and record what actually
comes back before changing anything — the expected 500 via `GlobalExceptionHandler`'s catch-all is
**unverified**, and the `@WebMvcTest`s cannot tell you (that is exactly AUDIT-T3's remaining
bullet). Then make `listPages` match its siblings. **B11 is one line of `application.yml`**
(`spring.data.web.pageable.max-page-size`), so `?size=2000` stops working.

Closing T3's third bullet means a `@SpringBootTest` + Testcontainers test that proves Spring Data
actually applied the `Sort` — `PipelineFlowIntegrationTest` is the working example.

### 2. Then — AUDIT-F9 paired with pagination benchmarking

**Now genuinely unblocked**: F11's unbounded request walk was the thing that would have poisoned
any request-count measurement, and it is fixed. F9 is the dual-viewport `vitest projects` /
Playwright question; the benchmark is request count, payload size and perceived load time against
the old fetch-everything baseline.

### 3. Then — AUDIT-Q1, with AUDIT-Q2 folded in

`Objects.requireNonNull` sweep, 249 calls, plus Q2's inline fully-qualified class names — same
mechanical pass over the same controllers (`SeriesController`, `PageController` are in both).
Backend-only; fills slack while step 2's benchmarks run.

### 4. Then — AUDIT-F13

`ChapterPageGrid.tsx:159` disables "move page right" on `idx === pages.length - 1`, and since
AUDIT-F8 `pages.length` is the *loaded* count, not the chapter's length. Left alone deliberately
this sitting: it is `[L]`, it is in a different file from F10–F12, and bundling it would have
widened a contained change. It is small and self-contained whenever it comes up.

### 5. Last, deliberately — AUDIT-T1, AUDIT-D5, AUDIT-W3

Unchanged in reasoning: each needs real experimentation (a wire-protocol test double, a sampled
memory peak, concurrency testing), not a mechanical pass.

### Not in the queue

- **Track 2 — the `open-in-view` flip-and-remeasure.** Unblocked since the sixteenth sitting,
  still unscheduled, direction still undecided. Don't start without asking.
- **Track 3 — the quality gap** (6.85% vs 1.92% flattening, `BUBBLE_CONTOUR_FALLBACK` removal
  checkpoint, VLM benchmarking). Unchanged; see the fourteenth sitting's handoff in git history.

## GitNexus

**Reindexed, and the documented command needed fixing.** The command in the last handoff aborted
in a native worker (`Analysis aborted in a native worker or native binding path`), **exit code 0
with no index written** — it burned its whole retry budget on `backend/src/main/c/jni/jni.h`, a
74 KB vendored Oracle JDK header. It is *not* a broken install and reinstalling does not help; the
parse is just slower than the default 30 s idle timeout. **Use this instead:**

```
GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS=120000 GITNEXUS_WORKER_MAX_CUMULATIVE_TIMEOUT_MS=600000 \
  ~/.nvm/versions/node/v22.14.0/bin/node \
  ~/.nvm/versions/node/v26.1.0/lib/node_modules/gitnexus/dist/cli/index.js \
  analyze --embeddings --force
```

188.8 s. Now at **5,532 nodes / 13,635 edges / 300 flows** (was 5,414 / 13,437). `AGENTS.md` and
`CLAUDE.md` had their stat lines rewritten by `analyze` and those edits are in this sitting's
commit.

Note `impact()` reports `Dashboard` as having **0 direct callers**, which is an artefact: `App.tsx`
imports it via `React.lazy(() => import(...))` and the graph does not trace a dynamic import as a
call. Cross-check with grep before trusting a zero.

`manga-tl-worker` untouched, still at its prior index point.

## CI — still not re-verified, and the API probe failed on the wrong URL

Carried forward. `CI - Backend` / `CI - Frontend` never triggered for the fifteenth sitting's push
despite matching `ci-maven.yml`'s path filters; only CodeQL ran. A GitHub-wide outage around
2026-08-07 is the probable but unconfirmed explanation.

**One correction for whoever picks this up:** the repo is `sagniKdas53/manga-tl`, *not*
`Sagnik-Das-53/manga-library` — a guessed URL returns a 404 that looks like "no check runs" but is
actually "no such repo". Get the slug from `git remote -v` first. `8c4c509` is still the best probe
(it touches `backend/src/**` and `frontend/**`), and this sitting's commit is a second one. Check
**both** `commits/<sha>/check-runs` and `actions/workflows/<file>/runs` — `check-runs` alone is
what missed that two whole workflows never ran.

The strongest available evidence for `main`'s health remains the local gate: backend 424,
frontend 326.

## Not mine — left alone deliberately

Unchanged — the free-model benchmarking thread (`docs/benchmarking.md`, `docs/run_ocr_bench.md`,
`docs/free_openrouter_translation_benchmark_2026-08-06.md`, `docs/translation_bench.md`,
`scripts/benchmark_translation.py`, `scripts/build_translation_corpus.py`,
`scripts/test-providers.json`) commits concurrently. Explicit pathspec on every commit, `-F
<file>` before the `--`.

## Carried forward — deliberately not done

- **AUDIT-F13**, see roadmap step 4.
- **The `open-in-view` flip-and-remeasure.** Unblocked, unscheduled, Track 2's direction undecided.
- **CI - Backend / CI - Frontend not triggering.** See § CI above.
- **Five confirmed-dead tables** (`queue_job`, `search_index`, `translations`,
  `translation_regions`, `volumes`). Baselining isn't cleanup.
- **`updateJobStatus` has no state-machine validation**, only vocabulary validation.
- **`try_local_ai`'s bare `enforce_rate_limit()`.** Belongs to `AUDIT-W3`; inert by default
  (`DISABLE_LOCAL_LLM=true` on this box).
- **Valkey has no `requirepass`.** Needs backend `SPRING_DATA_REDIS_*` and worker `REDIS_*`
  simultaneously — a half-applied Redis password takes the whole pipeline down.
- **`SeriesController.resolveSetting`'s untrimmed placeholder compare.** Dormant.
- **The cross-provider fallback rule has not reached `ocr.py` and `qa.py`.**
- **The exported ZIP's pixel content is unverified.** jsdom has no canvas; needs a real browser.
- **The `neurometric` key in `secrets/api_keys.json` is still dead.**
- **A scan for other `@Transactional` self-invocations has not been done.**
- **`NotificationController.currentUser` throws `RuntimeException("Unauthorized")`** — a 500, not
  a 401/403.
- **`Reader.tsx`'s dead canvas-pan guards** on `.delete-page-btn`/`.reorder-controls`.
- **`PageService`'s "variant not smaller" branch is uncovered.** Needs a contrived incompressible
  fixture.
- **`JobController` still lists `queue:region-redo`** in its queue-clear `delete`.
- **Only `Dashboard` consumes the hook's new `error`.** The chapters and pages surfaces still
  render an empty list on a failed fetch. Cheap to extend if it ever matters; not filed.

## Out of scope unless deliberately reopened

- **The worker pull model.** Measured at 0.83% of queue wait. Build for latency/resilience, never
  throughput.
- **A reader downscale cap.** Real but secondary.
- **`AUDIT-W5`**, the queue-wait share re-derivation. Settled; see `archive.md`.
- **The "should the worker split exist at all" architecture question.** Answered narrowly for B5.
- **Migrating off hand-maintained schema management (Flyway or otherwise).** Explicitly rejected
  by the user in the fifteenth sitting. Do not reopen without asking.

## Working constraints

- **`CLAUDE.md` is binding.** `impact()` before editing any symbol, `detect_changes()` before
  committing — including config-only commits.
- **The pre-commit gate is `mvn -o clean verify`, not `test`.** `test` skips PMD and jacoco.
- **Run `vitest` from `frontend/`, not the repo root.** From the root it picks up a different
  config, jsdom never loads, and every test fails with `document is not defined` — which looks
  like a catastrophic regression and is a wrong working directory.
- **A `@WebMvcTest` with a mocked repository proves very little.** If the behaviour under test
  belongs to Spring Data or Hibernate, a mocked repository cannot see it. Use `@SpringBootTest` +
  Testcontainers (`PipelineFlowIntegrationTest` is the working example). **This is AUDIT-T3's one
  remaining bullet and it blocks a real AUDIT-B10 fix.**
- **Verify red-green.** Worked again this sitting: both probes were red first, and the F11 probe
  reproducing the prior sitting's exact number is what proved the finding hadn't gone stale.
- **A green suite is not the same as covered behaviour**, and **check what a red test is telling
  you before you fix the code** — two of this sitting's red tests were wrong fixtures, not
  regressions.
- **Read the whole `issues.md` entry, not the headline.**
- **Close the entry in the SAME commit as the fix** — remove from `issues.md`, reasoning into
  `archive.md`.
- **Commit straight to `main`, no feature branches, always a pathspec.** `-F <msgfile>` goes
  *before* the `--`. The free-model benchmarking thread still commits concurrently.
- **`git fetch --all` hangs on `origin`.** Use `git fetch github` / `git push github main`.
- **The GitHub repo slug is `sagniKdas53/manga-tl`.** Don't guess it.
- **Worker source lives at `worker/src/worker/`**, not `worker/`. Fixture is
  `worker/tests/test_providers.json`, forced by `conftest.py`.
- **`worker/` is a git submodule.** Its own commit plus a pointer bump; push the submodule first.
- **The `postgres` MCP tools query the live database directly.** Cheap, read-only.
- **GitNexus: two indexes.** `manga-library` (parent) and `manga-tl-worker` (submodule).
  `detect_changes()` on the parent cannot see inside `worker/` — use `repo: "manga-tl-worker"`.
- **Say plainly if a finding turns out stale, wrong or incomplete.**

## Prompt for the next chat

<!-- markdownlint-disable MD031 MD040 -->

```
Continuing manga-library. Read docs/next-step.md first — it is written to make
this sitting startable cold. docs/archive.md has a "2026-08-07 nineteenth
sitting" section with the full reasoning for the AUDIT-F10/F11/F12 fix. Don't
re-audit that hook — it was just rewritten, is covered by 13 tests, and what
survived is written down.

LAST SITTING CLOSED BOTH [H]s. AUDIT-F10 + F11 + F12 fixed as one unit in
frontend/src/hooks/usePaginatedResource.ts, plus AUDIT-T3's two frontend
bullets. Gates green: mvn -o clean verify = BUILD SUCCESS, 424 backend tests;
vitest = 326/326 across 46 files (up from 316/45). eslint clean with the
exhaustive-deps suppression DELETED, not moved.

STATE: 61 filed, 51 closed, 10 open (84%). NO [C] and NO [H].

QUEUE — work it in order unless redirected:
  1. AUDIT-B10 + B11. B10 NEEDS A MEASUREMENT FIRST: PageController.listPages
     forwards the caller's ?sort= into Spring Data unvalidated while its two
     sibling endpoints carefully allowlist theirs. Hit the LIVE endpoint with
     ?sort=bogus and ?sort=id,desc and record what actually happens before
     fixing — the expected 500 via GlobalExceptionHandler's catch-all is
     UNVERIFIED and the @WebMvcTests cannot tell you. B11 is one line of
     application.yml (spring.data.web.pageable.max-page-size; today ?size=2000
     works). Closing AUDIT-T3's remaining third bullet means a @SpringBootTest
     + Testcontainers test that proves Spring Data actually applied the Sort.
  2. AUDIT-F9 + the pagination benchmarking pass. NOW genuinely unblocked —
     F11's unbounded request walk was the thing that would have poisoned any
     request-count measurement, and it is fixed.
  3. AUDIT-Q1 with AUDIT-Q2 folded in — same mechanical pass over the same
     controllers (SeriesController, PageController are in both).
  4. AUDIT-F13 [L] — ChapterPageGrid's "move page right" disables on
     idx === pages.length - 1, and pages.length is now the LOADED count.
     Deliberately not bundled into last sitting's hook change.
  5. AUDIT-T1, AUDIT-D5, AUDIT-W3 last, deliberately — each needs real
     experimentation, not a mechanical pass.
Track 2 (open-in-view flip-and-remeasure) and Track 3 (the quality gap) are
NOT in this queue — direction on both undecided, don't start either without
asking.

GITNEXUS: reindexed last sitting, at 5,532 nodes / 13,635 edges / 300 flows.
THE COMMAND IN OLDER HANDOFFS DOES NOT WORK — it exits 0 having written
nothing, dying in a native worker on backend/src/main/c/jni/jni.h (a vendored
JDK header that parses slower than the 30s default idle timeout). Use:
  GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS=120000 \
  GITNEXUS_WORKER_MAX_CUMULATIVE_TIMEOUT_MS=600000 \
    ~/.nvm/versions/node/v22.14.0/bin/node \
    ~/.nvm/versions/node/v26.1.0/lib/node_modules/gitnexus/dist/cli/index.js \
    analyze --embeddings --force
impact() reporting 0 callers for a React.lazy-imported component is an
artefact, not a safety signal — cross-check with grep. Two separate indexes;
detect_changes() on the parent cannot see inside worker/, use
repo: "manga-tl-worker" there.

GATE: mvn -o clean verify (not test) — 424 passing. Frontend: vitest RUN FROM
frontend/, 326 passing across 46 files. From the repo root it loads the wrong
config and every test fails with "document is not defined" — that's a wrong
cwd, not a regression. Worker gates untouched, still at 315.

CI: still not re-verified. CI - Backend / CI - Frontend never triggered for
the fifteenth sitting's push despite matching path filters; only CodeQL ran.
A GitHub-wide outage around 2026-08-07 is the probable but unconfirmed
explanation. THE REPO SLUG IS sagniKdas53/manga-tl — a guessed URL 404s in a
way that looks like "no check runs". Check BOTH commits/<sha>/check-runs and
actions/workflows/<file>/runs; check-runs alone is what missed two workflows
never running.

REMOTES: git fetch --all hangs on origin. Use git fetch github / git push
github main. Worker submodule's origin is separate and works.

NOT MINE: the free-model benchmarking thread commits concurrently. Explicit
pathspec on every commit, -F <msgfile> BEFORE the --.

Say plainly if a finding turns out stale, wrong or incomplete.

CONSTRAINTS
- CLAUDE.md is binding: impact() before edits, detect_changes() before
  commits, even config-only ones.
- A @WebMvcTest with a mocked repository proves very little. If the behaviour
  under test belongs to Spring Data or Hibernate, a mocked repository cannot
  see it — use @SpringBootTest + Testcontainers (PipelineFlowIntegrationTest
  is the working example). This is AUDIT-T3's remaining bullet and it BLOCKS a
  real AUDIT-B10 fix.
- Verify red-green. Write the failing test against the real code before
  writing a word about a suspected defect.
- But check what a red test is telling you before you fix the code — two of
  last sitting's reds were wrong fixtures, not regressions. A fixture that
  says size:25/totalElements:2 and then expects a page 1 encodes the bug as
  the expectation.
- Close the issues.md entry in the SAME commit as the fix; reasoning into
  archive.md.
- Read the whole issues.md entry, not the headline.
- Commit to main directly, with a pathspec; worker/ is a submodule and needs
  its own commit plus a pointer bump, pushed before the parent.
- If the user redirects mid-sitting, revert the discarded approach cleanly and
  record what was tried and undone.
```

<!-- markdownlint-enable MD031 MD040 -->
