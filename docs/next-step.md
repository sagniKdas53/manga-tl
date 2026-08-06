# Handoff — 2026-08-07 (sixteenth sitting)

> **AUDIT-B9 is closed.** `LayerEditHistory.layerElement`/`.editedBy` now carry `@JsonIgnore`,
> matching every other entity in the codebase. Red-green verified with a real Testcontainers
> integration test (`PipelineFlowIntegrationTest#testLayerElementHistory_DoesNotSerializeLazyRelations`),
> not just a status-code check. See [§ What this sitting
> did](#what-this-sitting-did) and [archive.md](./archive.md#the-2026-08-07-sixteenth-sitting--audit-b9-the-open-in-view-serialization-gap).
>
> **AUDIT-B5 is still closed and deployed** (fifteenth sitting, unchanged) — schema baseline, 22
> live tables, `ddl-auto: validate`, no migration framework adopted. Nothing about that was
> touched or reopened this sitting. Full detail in archive.md if needed; not re-derived here.
>
> **CI was checked, as the last handoff asked, and it's a real gap, not a green light.** `CI -
> Backend` / `CI - Frontend` never triggered on GitHub for the fifteenth sitting's push
> (`5f7f0f6..dfb4c30`) despite the diff matching `ci-maven.yml`'s path filters exactly. Only
> CodeQL ran (passed). See [§ CI](#ci-checked-and-its-a-gap) — this needs a human decision, not
> something to route around silently.
>
> **45 of 53 findings closed (85%). 8 open, nothing `[C]` or `[H]`.** No new finding filed this
> sitting. See [§ Where issues.md stands](#where-issuesmd-stands).
>
> **Board re-ranked by the user, same sitting, after the code changes landed.** `AUDIT-F1` +
> `AUDIT-F2` + `AUDIT-F8` (server-side pagination, spec below) are next, as one unit, with tests
> designed alongside the implementation, not after. `AUDIT-F9` + a pagination benchmarking pass
> follow, paired. `AUDIT-Q1` fills whatever slack exists while the benchmarks run. `AUDIT-T1`,
> `AUDIT-D5`, `AUDIT-W3` are explicitly last — all three need real experimentation (concurrency
> testing, a sampled memory run, a wire-protocol test double) rather than a mechanical pass, which
> is exactly why they're being deferred rather than picked up opportunistically. See [§
> Roadmap](#roadmap-re-ranked-2026-08-07) — this supersedes the old "three tracks" framing below it
> for scheduling purposes; the track framing itself (what Track 1/2/3 mean) is still accurate.

## What this sitting did

One commit, one variable, matching AUDIT-B9's own scope exactly — the flag-flip-and-remeasure half
was deliberately left alone (see below):

1. **`backend/src/main/java/com/manga/library/model/LayerEditHistory.java`** — added
   `@com.fasterxml.jackson.annotation.JsonIgnore` to `layerElement` (`:14-17`) and `editedBy`
   (`:27-29`), the inline-annotation style this codebase already uses everywhere else (`Layer`,
   `LayerElement`, `OcrRegion`, etc.) rather than adding an import.
2. **`backend/src/test/java/com/manga/library/service/PipelineFlowIntegrationTest.java`** — new
   test `testLayerElementHistory_DoesNotSerializeLazyRelations`: creates a real `LayerEditHistory`
   row (real Testcontainers Postgres, real Hibernate lazy proxies) with both relations populated,
   hits `GET /api/layer-elements/{id}/history` over `MockMvc`, asserts the JSON body does not
   contain `layerElement` or `editedBy` keys. The existing `LayerControllerTest` couldn't have
   caught this either way — it's a `@WebMvcTest` with a mocked repository, never touches a real
   lazy proxy.
3. `docs/issues.md` — removed the `AUDIT-B9` entry (and the now-empty `### Backend (Spring)`
   subheader it was the only occupant of).
4. `docs/archive.md` — wrote the reasoning, including the red-green mechanics and the CI finding.

**Impact/detect_changes, per CLAUDE.md:** `impact({target: "LayerEditHistory", direction:
"upstream"})` → `LOW` risk, 2 direct callers (`LayerController.updateLayerElement`,
`LayerEditHistoryRepository`), 0 processes affected — a `@JsonIgnore` addition changes no
signature. `detect_changes()` after the edit → `risk_level: low`, 6 symbols touched, all inside
the two files actually edited, nothing unexpected riding along.

**Red-green:** confirmed red by `git stash push` on just `LayerEditHistory.java` (reverting only
the `@JsonIgnore` additions), rerunning the new test → `AssertionFailedError: expected: <false> but
was: <true>` (the lazy field was present in the JSON). `git stash pop` restored the fix, rerun →
green. Full `mvn -o clean verify`: **416 tests, 0 failures** (415 baseline + 1 new).

**Not done, deliberately:** flipping `spring.jpa.open-in-view` to `false` and remeasuring whether
it's actually contributing to "backend holds the UI back." AUDIT-B9's own text called this out as
"a distinct, larger measurement" (request-latency, not serialization-safety) — don't fold it into
this fix. It's the natural next-sitting candidate; see below.

## CI: checked, and it's a gap

The fifteenth sitting's handoff flagged CI as "pushed, not yet checked." Checked this sitting via
the GitHub REST API directly (no `gh` CLI available in this environment — `curl
api.github.com/repos/sagniKdas53/manga-tl/...` works fine without auth for a public repo).

**Finding: `CI - Backend` and `CI - Frontend` — the two workflows with real test suites — never
triggered for the push that landed the actual fix** (`5f7f0f6..dfb4c30`, which includes `ad113a9`,
`fc987c4`, `cf118de`). Verified via the GitHub compare API
(`/compare/5f7f0f6...cf118de`) that the diff includes `backend/src/main/resources/application.yml`,
a new `backend/src/test/.../InitScriptReconciliationTest.java`, and `database/init.sql` — all
three match `ci-maven.yml`'s `paths:` filter (`backend/src/**`, `database/**`) exactly. Only the
CodeQL workflow ran for those commits (`check-runs` API confirms: 5 jobs, 3 succeeded, 2 —
`python`, `actions` — cancelled, most likely superseded by the next push's own CodeQL run for the
same ref, not a code failure). `workflow_runs` for `ci-maven.yml` shows **zero runs** with
`head_sha` matching any of `ad113a9`/`fc987c4`/`cf118de`/`dfb4c30`.

The last real `CI - Backend` attempt was on the *separate, earlier* push that landed `5f7f0f6`
alone — and that one was **cancelled with 0 steps executed** (a platform non-start, confirmed via
the run's `jobs` API: `"conclusion": "cancelled"`, empty `steps` array). Not a code-caused
failure. The last commit with an actual passing `CI - Backend` run is `829a073d`
(2026-08-06T13:27:01Z) — three sittings and several commits behind current `HEAD`.

**No root cause found from read-only API access:** repo isn't archived or disabled, no
runs stuck queued/in-progress, the workflow YAML's `paths:` filter genuinely matches the diff. This
smells like a GitHub Actions platform hiccup (workflow evaluation silently not firing despite a
path match), not something in this repo's config — but that's a hypothesis, not a confirmed cause.

**Update, later the same sitting:** the user reported (from outside news, not confirmed from
inside the repo) that GitHub was having a platform-wide outage around 2026-08-07. That fits the
"platform-side non-start" reading above and is the most likely explanation. **Still not verified**
— re-check `CI - Backend`/`CI - Frontend` against current `HEAD` (`362fa60`) once GitHub's Actions
service is confirmed healthy again, rather than assuming the outage was the whole story.

**What this means practically:** the strongest available evidence for `main`'s backend health
right now is the local gate (`mvn -o clean verify`, 416/416 as of this sitting) plus CodeQL, not an
actual GitHub Actions test-suite green tick — because one doesn't exist for any commit past
`829a073d`. This is worth a decision, not a workaround:

- **Cheapest fix:** an empty/trivial commit touching a `backend/src/**` file (or a `git commit
  --allow-empty` won't match the path filter — needs an actual path match) might retrigger it on
  the next real backend edit. AUDIT-B9's own commit this sitting touches
  `backend/src/main/java/...` — **if the reader of this handoff has push access and wants to test
  the hypothesis, this sitting's own commit is a natural probe:** check `gh run list` or the
  workflow-runs API for this sitting's commit SHA after pushing, before assuming the platform
  issue repeats.
- **Alternative:** add `workflow_dispatch:` to `ci-maven.yml`/`ci-npm.yml` so they can be triggered
  manually regardless of push-trigger flakiness — a real code change to the workflow file, not
  something to do silently as part of an unrelated sitting.

Not fixed this sitting — flagging and handing off, since the root cause sits outside what
diagnosis from inside the repo can confirm.

## Where `issues.md` stands

**53 filed. 8 open. 45 closed — 85%.**

| sev | open | which |
| --- | --- | --- |
| **[C]** | 0 | — |
| **[H]** | 0 | — |
| **[M]** | 3 | W3, F1, F2 |
| **[L]** | 3 | F8, F9, D5 *(partial — 2 of 5 bullets)* |
| unranked | 2 | T1, Q1 |

No new finding filed this sitting — AUDIT-B9's fix was self-contained, no side-discoveries spun
into a new `AUDIT-*`.

## Roadmap, re-ranked 2026-08-07

User-set ordering, explicit and sequential — not a menu, a queue. Full detail on each item lives in
`issues.md`; this is the schedule, not a re-statement of the findings.

### 1. Next up — AUDIT-F1 + AUDIT-F2 + AUDIT-F8 (pagination), as one unit

Frontend + API, landed together, tests designed alongside the implementation rather than bolted on
after:

- **`AUDIT-F1`** — `theme.ts`'s `themeObj(mode)` rebuild on toggle → MUI v9
  `createTheme({ colorSchemes, cssVariables: true })`.
- **`AUDIT-F2`** — hoist `ReaderRightSidebar.tsx`'s 65 inline `sx={{…}}` literals (and
  `QueueManager.tsx`'s 45) to module constants / `styled()`.
- **`AUDIT-F8` — server-side pagination, three surfaces, exact spec (decided this sitting,
  supersedes the old "decide the ceiling" framing in `issues.md`):**
  - **Series** (`GET /api/series`, consumed at `App.tsx:216`) — **10 per page**, infinite-scroll
    fetch-next-10 at the scroll boundary.
  - **Chapters** (`GET /api/series/{seriesId}/chapters`) — **15 per page**, same pattern.
  - **Pages** (`GET /api/chapters/{chapterId}/pages`, consumed by `Reader.tsx:175`'s
    `fetchPages()`) — **25 per page**, but the reader itself must not dead-end at the batch
    boundary: navigating from page 25 to page 26 in a 30-page chapter must transparently trigger
    the next fetch rather than stopping. This is the one most likely to get shipped wrong if
    ported mechanically from the series/chapters infinite-scroll pattern — those two only need a
    scroll-triggered fetch, the reader needs a **navigation**-triggered one too.
  - All three list endpoints currently take no query params at all — this is a real API change
    (offset/limit or cursor), not just a frontend one. Coordinate with the OpenAPI-sync rule in
    `CLAUDE.md` (regenerate `frontend/src/api/schema.d.ts` after the backend change).
  - **Test design is part of the deliverable**, not an afterthought: coverage needed for (a) the
    new pagination params on each endpoint (boundary pages, partial final page, empty result), and
    (b) the reader's fetch-past-the-batch behavior specifically, since that's the part a naive port
    would miss silently rather than loudly.

### 2. Then — AUDIT-F9 paired with pagination benchmarking

Two things landing together on purpose: `AUDIT-F9` (zero `useMediaQuery`/`theme.breakpoints` use,
43 test files at one implicit viewport — needs the yt-diff-style dual-viewport `vitest projects`
setup) and a benchmarking pass measuring what the pagination work from step 1 actually bought
(request count, payload size, perceived load time, before/after against the old fetch-everything
baseline). Paired because both need the pagination work to exist first, and both are measurement
passes rather than one-line fixes.

### 3. In parallel with the benchmarking — AUDIT-Q1

`Objects.requireNonNull` sweep, 249 calls, most unreachable. Backend-only and doesn't contend with
the frontend benchmarking work above, so it fills the slack while step 2's benchmarks run rather
than waiting its turn.

### 4. Last, deliberately — AUDIT-T1, AUDIT-D5, AUDIT-W3

All three deprioritized by the user this sitting for the same reason: each needs real
experimentation before a fix can be trusted, not a mechanical pass.

- **`AUDIT-T1`** — the worker's "e2e" test is 19 `@patch`/4 `assert`; fixing it for real means
  building `mock_router.md`'s wire-protocol double first, then re-deriving the suite against it.
- **`AUDIT-D5`** — the backend memory-limit pair is blocked on a measured peak; kernel 5.15 has no
  `memory.peak`, so it needs a sampled `memory.current` run through a thumbnail-heavy load.
- **`AUDIT-W3`** — releasing worker concurrency slots before a cooldown sleep (or requeuing with a
  delay) needs concurrency testing to confirm it doesn't just relocate the deadlock risk.

### Track 2 — Plan a better backend (gate cleared, direction still undecided; not in the queue above)

`AUDIT-B9`'s correctness blocker is cleared, which means the `open-in-view` flip-and-remeasure is
doable whenever someone picks Track 2 back up: flip `spring.jpa.open-in-view` to `false`, run the
full suite (should be clean — `LayerEditHistory` was the only unsafe path), then measure real
request latency before/after. Not part of the re-ranked queue above — the user's ordering this
sitting was scoped to Track 1 + the three deferred items; Track 2's direction is still undecided
and untouched.

### Track 3 — Understand the paid product and close the quality gap (also not in the queue above)

Unchanged: the 6.85% vs 1.92% flattening gap, `BUBBLE_CONTOUR_FALLBACK` removal checkpoint, the VLM
benchmarking item. See the fourteenth sitting's handoff (preserved in this file's git history) for
the full writeup if picking this up.

## GitNexus

`manga-library` was **not reindexed this sitting** — one small, self-contained fix (2 files, both
already covered by the prior `cf118de` index) didn't warrant it. Still at `cf118de`: 5414 symbols,
13437 relationships, 300 execution flows. `impact()`/`detect_changes()` results above were taken
against that index and are still valid for the files touched — reindex before the *next* sitting if
it does anything larger. `manga-tl-worker` untouched, still at its prior index point.

Reindex command (both documented ones abort on this box):

```
~/.nvm/versions/node/v22.14.0/bin/node \
  ~/.nvm/versions/node/v26.1.0/lib/node_modules/gitnexus/dist/cli/index.js \
  analyze --embeddings --force
```

## Not mine — left alone deliberately

Same as last sitting — the free-model benchmarking thread (`docs/benchmarking.md`,
`docs/run_ocr_bench.md`, `docs/free_openrouter_translation_benchmark_2026-08-06.md`,
`docs/translation_bench.md`, `scripts/benchmark_translation.py`,
`scripts/build_translation_corpus.py`, `scripts/test-providers.json`) commits concurrently. Use an
explicit pathspec on every commit, `-F <file>` before the `--`.

## Carried forward — deliberately not done

- **The re-ranked queue itself** (§ Roadmap above) — nothing in steps 1–4 has started.
- **The `open-in-view` flip-and-remeasure.** Unblocked by AUDIT-B9, but Track 2's direction is
  undecided and it's not part of this sitting's re-ranked queue — see Track 2 above.
- **CI - Backend / CI - Frontend not triggering on push.** Flagged this sitting, likely explained
  by a GitHub-wide outage the user independently confirmed, but **not yet re-verified** — check
  `CI - Backend`/`CI - Frontend` against `362fa60` once GitHub's Actions service is healthy again.
- **Five confirmed-dead tables** (`queue_job`, `search_index`, `translations`,
  `translation_regions`, `volumes`). Not cleaned up — baselining isn't cleanup.
- **`updateJobStatus` has no state-machine validation**, only vocabulary validation.
- **`try_local_ai`'s bare `enforce_rate_limit()`.** Belongs to `AUDIT-W3` (now last-in-queue);
  inert by default (`DISABLE_LOCAL_LLM=true` on this box).
- **Valkey has no `requirepass`.** Needs backend `SPRING_DATA_REDIS_*` and worker `REDIS_*`
  simultaneously — a half-applied Redis password takes the whole pipeline down.
- **`SeriesController.resolveSetting`'s untrimmed placeholder compare.** Dormant.
- **The cross-provider fallback rule has not reached `ocr.py` and `qa.py`.**
- **The exported ZIP's pixel content is unverified.** jsdom has no canvas; needs a real browser.
- **The `neurometric` key in `secrets/api_keys.json` is still dead.**
- **A scan for other `@Transactional` self-invocations has not been done.**
- **`NotificationController.currentUser` throws `RuntimeException("Unauthorized")`** — a 500, not a
  401/403.
- **`Reader.tsx`'s dead canvas-pan guards** on `.delete-page-btn`/`.reorder-controls`. Track 1's.
- **`PageService`'s "variant not smaller" branch is uncovered.** Needs a contrived incompressible
  fixture.
- **`JobController` still lists `queue:region-redo`** in its queue-clear `delete`.

## Out of scope unless deliberately reopened

- **The worker pull model.** Measured at 0.83% of queue wait. Build for latency/resilience, never
  throughput.
- **A reader downscale cap.** Real but secondary; a second performance variable.
- **`AUDIT-W5`**, the queue-wait share re-derivation. Both settled; see `archive.md`.
- **The "should the worker split exist at all" architecture question.** Answered narrowly for B5
  (no DB coupling either way); the bigger question is untouched.
- **Migrating off hand-maintained schema management (Flyway or otherwise).** Explicitly rejected by
  the user in the fifteenth sitting. Do not reopen without asking.

## Working constraints

- **`CLAUDE.md` is binding.** `impact()` before editing any symbol, `detect_changes()` before
  committing — including config-only commits.
- **The pre-commit gate is `mvn -o clean verify`, not `test`.** `test` skips PMD and jacoco.
- **Verify a fix red-green; when there is none, verify the mechanism instead.** This sitting had a
  real one: `git stash` on just the model file, rerun the new test, confirm it reds; `stash pop`,
  rerun, confirm green.
- **A `@WebMvcTest` with a mocked repository cannot prove a lazy-serialization fix.** It never
  touches a real Hibernate proxy either way. Needed the `@SpringBootTest` + Testcontainers
  integration test (`PipelineFlowIntegrationTest`) for this one — worth remembering for any future
  `open-in-view`/lazy-loading-shaped fix.
- **The GitHub REST API works without `gh` or auth for public-repo read access** — `curl
  api.github.com/repos/<owner>/<repo>/actions/runs` etc. Used this sitting since `gh` CLI is
  unavailable in this environment. `check-runs` (commit-scoped) and `actions/runs` /
  `actions/workflows/<file>/runs` (workflow-scoped) answer different questions — check both before
  concluding CI status; `check-runs` alone missed that two whole workflows never ran.
- **Say plainly if a finding turns out stale, wrong or incomplete.** No stale finding surfaced this
  sitting (unlike the last two), but the CI gap is the same category of thing: don't quietly treat
  "some checks are green" as "CI passed" when the checks that matter didn't run at all.
- **Commit straight to `main`, no feature branches, always a pathspec.** `-F <msgfile>` goes
  *before* the `--`. The free-model benchmarking thread still commits concurrently.
- **`git fetch --all` hangs on `origin`.** Use `git fetch github` / `git push github main`. Worker
  submodule's `origin` is a separate, working remote.
- **Worker source lives at `worker/src/worker/`**, not `worker/`. Fixture is
  `worker/tests/test_providers.json`, forced by `conftest.py`.
- **`worker/` is a git submodule.** Its own commit plus a pointer bump; push the submodule first.
- **The `postgres` MCP tools query the live database directly.** Cheap, read-only.
- **GitNexus: two indexes.** `manga-library` (parent) and `manga-tl-worker` (submodule).
  `detect_changes()` on the parent cannot see inside `worker/` — use `repo: "manga-tl-worker"`
  there. If reindexing, both documented commands abort on this box; use Node 22 (see § GitNexus
  above).

## Prompt for the next chat

<!-- markdownlint-disable MD031 MD040 -->

```
Continuing manga-library. Read docs/next-step.md first — it is written to make
this sitting startable cold. docs/archive.md has a "2026-08-07 sixteenth
sitting" section. Do not re-audit the codebase and do not re-derive the schema
measurements or the AUDIT-B9 red-green mechanics — all are written down.

THE BOARD IS RE-RANKED, USER-SET, 2026-08-07. This is a queue, not a menu —
work it in order unless redirected:
  1. AUDIT-F1 + AUDIT-F2 + AUDIT-F8, as one unit. F8 is server-side pagination
     with an exact spec already decided: series 10/page, chapters 15/page,
     pages 25/page, all infinite-scroll. THE READER IS THE PART MOST LIKELY TO
     GET SHIPPED WRONG: navigating past the loaded page window (e.g. page 25
     of a 30-page chapter) must transparently fetch more, not dead-end at the
     batch boundary — that's a navigation-triggered fetch, not just the
     scroll-triggered one the series/chapters lists need. All three list
     endpoints (GET /api/series, GET /api/series/{id}/chapters, GET
     /api/chapters/{id}/pages) currently take no query params at all, so this
     is a real backend API change too, plus an OpenAPI regen per CLAUDE.md.
     Design tests alongside the implementation, not after — see
     docs/next-step.md's Roadmap section 1 and issues.md's AUDIT-F8 entry for
     the full spec.
  2. AUDIT-F9 (responsive verification, dual-viewport vitest projects) paired
     with a pagination benchmarking pass measuring what step 1 bought.
  3. AUDIT-Q1 (249 Objects.requireNonNull sweep) in whatever slack exists
     while step 2's benchmarks run — backend-only, doesn't contend with the
     frontend work above it.
  4. AUDIT-T1, AUDIT-D5, AUDIT-W3, last, deliberately — all three need real
     experimentation (a mock wire-protocol double, a sampled memory peak,
     concurrency testing) before a fix can be trusted, not a mechanical pass.
Track 2 (the open-in-view flip-and-remeasure, unblocked by AUDIT-B9) and
Track 3 (the quality gap) are NOT part of this queue — direction on both is
still undecided, don't start either without asking first.

AUDIT-B5 IS CLOSED AND DEPLOYED (unchanged since the fifteenth sitting).
AUDIT-B9 IS ALSO CLOSED: LayerEditHistory.layerElement/.editedBy carry
@JsonIgnore, matching every other entity. Red-green verified with a real
Testcontainers integration test, not just a status check.

CI GAP, LIKELY EXPLAINED BUT NOT RE-VERIFIED: CI - Backend / CI - Frontend
never triggered on GitHub for the fifteenth sitting's push despite matching
path filters exactly. Only CodeQL ran. The user independently confirmed a
GitHub-wide platform outage around this date, which fits the "cancelled with
0 steps executed" pattern seen on the last real CI-Backend attempt — probable
explanation, not a confirmed one. Re-check CI - Backend/CI - Frontend against
commit 362fa60 (or later) once GitHub's Actions service is confirmed healthy
again before assuming it's resolved. See docs/next-step.md's CI section for
the full diagnosis.

STATE: 53 filed, 45 closed, 8 open (85%). Nothing [C] or [H]. No new finding
filed this sitting.

GITNEXUS: manga-library NOT reindexed this sitting (small fix, no reindex
warranted) — still at cf118de (5414 symbols, 13437 relationships, 300 flows).
Reindex before doing anything larger. manga-tl-worker untouched. Two separate
indexes — detect_changes() on the parent cannot see inside worker/, use
repo: "manga-tl-worker" there. Reindex command (both documented ones abort on
this box):
  ~/.nvm/versions/node/v22.14.0/bin/node \
    ~/.nvm/versions/node/v26.1.0/lib/node_modules/gitnexus/dist/cli/index.js \
    analyze --embeddings --force

GATE: mvn -o clean verify (not test) — currently 416 passing (415 + AUDIT-B9's
new test). Worker gates (pytest, ruff check, ruff format --check, pyright)
untouched this sitting, still at the 315-test baseline.

REMOTES: git fetch --all hangs on origin. Use git fetch github / git push
github main for the parent; the worker submodule's origin is a separate,
working remote.

NOT MINE: the free-model benchmarking thread commits concurrently. Explicit
pathspec on every commit, -F <msgfile> BEFORE the --.

Say plainly if a finding turns out stale, wrong or incomplete.

CONSTRAINTS
- CLAUDE.md is binding: impact() before edits, detect_changes() before
  commits, even for config-only changes.
- Close the issues.md entry in the SAME commit as the fix: remove it from
  issues.md, write the reasoning into archive.md.
- Verify red-green. If a change genuinely has no red-green, say so and verify
  the mechanism instead.
- Read the whole issues.md entry, not the headline.
- Commit to main directly, with a pathspec; worker/ is a submodule and needs
  its own commit plus a pointer bump, pushed before the parent.
- If the user redirects mid-sitting, revert the discarded approach cleanly
  and record what was tried and undone.
- The GitHub REST API works without gh/auth for this public repo's read
  access — use it if CI status needs checking again and gh CLI is still
  unavailable.
```

<!-- markdownlint-enable MD031 MD040 -->
