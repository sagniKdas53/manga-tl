# Handoff — 2026-08-08 (twenty-first sitting)

> **The loaded-prefix family is closed — five bugs, one root cause.** Three were reported by the
> user, two were found while fixing them and had never been noticed. Full reasoning in
> [archive.md § the twentieth sitting](./archive.md#the-2026-08-08-twentieth-sitting--the-loaded-prefix-family).
>
> **Gate re-run and verified today, not quoted from the last handoff:** `format:check` clean,
> `eslint` clean, **332 tests across 47 files, all passing** (105 s). Matches what the archive
> claims, so those numbers are trustworthy.
>
> **61 → 66 filed, 58 closed, 8 open (88%).** No `[C]`, no `[H]`.
>
> **Three things changed underneath this project that no previous handoff knows about. Read
> [§ Read this before you trust any SHA](#read-this-before-you-trust-any-sha) and
> [§ Where the work actually is](#where-the-work-actually-is) before doing anything else.** Skipping
> them costs a sitting: every commit hash in every doc is dead, the work is not on `main`, and
> nothing has been pushed for 10 commits.

## Read this before you trust any SHA

**`git filter-repo` has been run on this repository. Every commit hash cited in `issues.md`,
`archive.md` and previous handoffs no longer exists — all 79 of them, verified one by one.**

```
$ git cat-file -t d8b46a0
fatal: Not a valid object name d8b46a0        # the last handoff's "index is current with" commit
$ git cat-file -t 8c4c509
fatal: Not a valid object name 8c4c509        # AUDIT-F8's commit, cited throughout issues.md
```

This is why the corpus was untracked from this repo's history (`samples/` is third-party
copyrighted scans; a plain delete leaves them in history). It was the right call. The cost is that
every archaeological reference in the docs is now a dangling pointer, and a `git show` on one reads
as "that work never happened" rather than "that hash was rewritten".

**They are all recoverable — `filter-repo` left a commit map (769 entries):**

```bash
grep -E "^<old-sha>" .git/filter-repo/commit-map | awk '{print $2}'
```

Verified working on five of them:

| doc says | actually | subject |
| --- | --- | --- |
| `d8b46a0` | `3a21ae4` | docs: record the confirmed CI result |
| `8c4c509` | `ed54098` | feat(AUDIT-F1,F2,F8): server-side pagination |
| `9d82db4` | `8dbf5aa` | fix: satisfy prettier, close out the CI gap |
| `bcc86e0` | `9efdec0` | perf: optimize queue animation |
| `92f9284` | `41c42c6` | perf: restore worker poll interval to 2s |

**The old hashes were deliberately left in place in `issues.md` and `archive.md` rather than
rewritten.** Rewriting 79 references across 3,000 lines of prose is a large mechanical diff with
real transcription risk, for a benefit one `grep` already provides. If you find yourself editing
them, do it with a script driven by the commit map, not by hand — and do it in its own commit.

**`.git/filter-repo/` is local and not in the repo. If it is ever deleted, the mapping is gone for
good** and the doc history becomes genuinely unrecoverable. Worth copying somewhere safe if that
matters to you.

## Where the work actually is

**Not on `main`, and not pushed.** The last handoff's constraint said "commit straight to `main`,
no feature branches" — that is not what is happening now, and the next sitting should know which
before committing.

```
* region-threshold-validation   aa02ea1   <- HEAD, all recent work
  main                          8a7ea9b   <- 3 commits behind this branch
  remotes/github/main           2a45c06   <- 10 commits behind HEAD
```

`git rev-list --left-right --count github/main...HEAD` → `0  10`. Nothing is pushed, nothing is
behind — it is a clean fast-forward whenever someone decides to push.

**The three commits on this branch beyond `main`:**

| commit | thread |
| --- | --- |
| `dbb47a0` | the loaded-prefix fix — five bugs, frontend |
| `9c5bb7b` | region-merge prior art + research brief |
| `aa02ea1` | corpus/samples restructure |

**Two unrelated threads are interleaved on one branch**, which is worth untangling before pushing:
the frontend bug work and the OCR/corpus work have nothing to do with each other, and the branch is
named after neither. **Ask the user** whether they want this merged to `main` and pushed, kept as a
branch, or split — do not decide it unilaterally, and do not push without asking. There is also a
`worktree-untrack-corpus` worktree at `.claude/worktrees/untrack-corpus` (`196bdca`) still on disk.

## What this sitting did

Documentation consolidation only — no code changed.

1. **Folded `new_bugs.md` into `archive.md` and deleted it.** Everything it held survives: the
   three reports as reported, the red-first evidence for each, the screenshot filenames, and the
   two bugs found while fixing. See the new *What was reported* table in the twentieth-sitting
   section.
2. **`issues.md` updated** — the Queue Manager regression and its general lesson, the loaded-prefix
   family under the frontend section with the directed sweep it suggests, and a sharpened version
   of the standing "is the testing real?" complaint (see below).
3. **Re-ran the full frontend gate** rather than trusting the recorded numbers. Green, and matching.
4. **Verified the SHA and branch situation above**, neither of which any prior handoff knows.

### One new observation worth acting on

**The "is the testing real?" issue has a cheaper target than the mock ratio: incoherent fixtures.**
Two sittings running, every pre-existing test that went red under a new fix was a *bad fixture*,
not a regression:

+ nineteenth: fixtures declaring `size: 25, totalElements: 2` — a one-page resource — that then
  expected a page 1 to exist. They passed only because nothing bounded the walk.
+ twentieth: `ChapterGallery.test.tsx` declaring `pagesTotalCount={1}` while passing **two** loaded
  pages — a chapter containing fewer pages than are loaded from it. That contradiction is exactly
  what hid the reorder bound.

An incoherent fixture is a green test that cannot fail for the right reason. Unlike AUDIT-T1's
mock-ratio problem, this is auditable by reading: ask of each fixture only *"could this state exist
in production?"*. Filed as an update under the standing testing issue, not as a new AUDIT item.

## Where `issues.md` stands

**66 filed. 8 open. 58 closed — 88%.** (Was 61/9/52 = 85%.)

| sev | open | which |
| --- | --- | --- |
| **[C]** | 0 | — |
| **[H]** | 0 | — |
| **[M]** | 2 | W3, B10 |
| **[L]** | 3 | F9, D5, Q2 |
| unranked | 3 | T1, Q1, T3 |

The five new entries are the loaded-prefix family — filed and closed in the same sitting. `AUDIT-F13`
moved from `[L]` open to closed, and was much larger than its severity suggested.

`AUDIT-T3` remains open on its **third bullet only** (`@WebMvcTest` cannot prove a pagination fix);
that one is backend and belongs with AUDIT-B10.

## Roadmap

The user's 2026-08-07 ordering still governs. Step 1 is unchanged and still blocked on the same
thing.

### 1. Next up — AUDIT-B10

**Still needs a live measurement, and still nobody has done it** — it needs the stack up, which has
been out of scope for two sittings running. `PageController.listPages` (`:746-763`) forwards the
caller's `?sort=` into Spring Data unvalidated while its two siblings (`listSeries`, `listChapters`)
allowlist theirs.

**Do the measurement before the fix.** Hit the live endpoint with `?sort=bogus` and `?sort=id,desc`
and record what actually comes back. The expected 500 via `GlobalExceptionHandler`'s catch-all is
**unverified**, and the `@WebMvcTest`s cannot tell you — that is AUDIT-T3's remaining bullet, and it
blocks a real fix here. Then make `listPages` match its siblings.

**The line AUDIT-B11 drew, because it sharpens T3's bullet rather than contradicting it:** a
`@WebMvcTest` *can* prove `max-page-size`, because `PageableHandlerMethodArgumentResolver` applies
the cap before the controller runs and the result is visible in the `Pageable` a mocked repository
is handed. It *cannot* prove B10, because whether a caller `Sort` composes with a derived query's
`OrderBy` is Spring Data's business. **The question is which layer owns the behaviour, not which
annotation is on the test class.** Closing T3's bullet means `@SpringBootTest` + Testcontainers —
`PipelineFlowIntegrationTest` is the working example.

### 2. Then — the loaded-prefix sweep (new, small, recommended before F9)

Five instances of one defect class were found by chasing three symptoms; the sixth has not been
looked for. AUDIT-F8's pagination left this class behind it, so do one directed pass rather than
waiting for the next report: **grep for `.length`, `Math.max` and index arithmetic over any array
sourced from `usePaginatedResource`, and check each against `totalCount`.** `pages.length` and
`chapters.length` are prefix lengths now and neither name says so.

**`totalCount` is not automatically the right substitute.** It was correct for page numbers
(contiguous from 1, verified across all 42 chapters) and **wrong** for chapter numbers (fractional
— a `0.5` interlude is normal, so an 18-chapter series tops out at 17). When the answer must be
exact, ask the server for one row.

### 3. Then — AUDIT-F9 paired with pagination benchmarking

Genuinely unblocked since F11's unbounded request walk was fixed — that was the thing that would
have poisoned any request-count measurement. F9 is the dual-viewport `vitest projects` / Playwright
question; the benchmark is request count, payload size and perceived load time against the old
fetch-everything baseline. Primary device is an Android tablet and nothing checks that today.

### 4. Then — AUDIT-Q1 with AUDIT-Q2 folded in

`Objects.requireNonNull` sweep (249 calls) plus Q2's inline fully-qualified class names — one
mechanical backend pass over the same controllers (`SeriesController`, `PageController` are in
both). Fills slack while step 3's benchmarks run.

### 5. Last, deliberately — AUDIT-T1, AUDIT-D5, AUDIT-W3

Unchanged in reasoning: each needs real experimentation (a wire-protocol test double, a sampled
memory peak, concurrency testing), not a mechanical pass. User's explicit call on 2026-08-07.

## The OCR / region thread — parallel, and now on this branch

**This is no longer "not mine".** Two of the three commits beyond `main` are this thread, so it is
in the same tree as the frontend work. It has **its own handoff** and that one is authoritative for
it — do not duplicate its state here:

+ **[`ocr_region_handoff_2026-08-08.md`](./ocr_region_handoff_2026-08-08.md)** — read §1 for state,
  §3 for the six open bugs, §4 for what to test, §5 for the command crib.
+ [`region_threshold_validation_2026-08-08.md`](./region_threshold_validation_2026-08-08.md) — the
  7-page validation; the fix direction holds everywhere and the value tightens from `0.5` to `0.35`.
+ [`region_merge_prior_art_2026-08-08.md`](./region_merge_prior_art_2026-08-08.md),
  [`research_brief_region_merging.md`](./research_brief_region_merging.md).

Its shape in one paragraph: **six region bugs open, none applied to production.** Work order is
BUG-1 (benchmark-only, biggest corpus win) → BUG-6 (orientation, prerequisite for judging BUG-4) →
BUG-3 (masking) → BUG-2 (`2.0` → `0.35`) → the `OCR_MERGE_THRESHOLD` compose default → BUG-4.
**Bundle the re-run** — four of those change region proposals, which invalidates every stored
candidate; one cloud pass, not four. Budget ~85 min plus the paid-model cost of a 40-page build.

**Two open decisions there need the user, not an agent:** whether to push the ~700 MB corpus repo
(**confirm it exists and is private first** — it contains copyrighted SFW and NSFW scans), and
whether BUG-2 and BUG-6 get applied to production.

## GitNexus — the index is stale, and its anchor commit no longer exists

```json
"lastCommit": "d8b46a0c20d5f2783d58618ae958b5bf6b6e0309",   // .gitnexus/meta.json
"indexedAt":  "2026-08-07T03:53:43.519Z"
```

That commit was destroyed by the `filter-repo` run. The index predates the entire loaded-prefix fix
(`dbb47a0` touched 13 files including 5 components) **and** every SHA in it is from the old history.
`impact()` on anything in `ChapterGallery`, `SeriesDetails`, `QueueManager`, `ChapterPageGrid` or
the new `chapterNumbering.ts` is answering about code that no longer exists. **Reindex before
relying on it.** `CLAUDE.md` still advertises the pre-rewrite stats (5,534 symbols / 13,641
relationships / 300 flows) — `analyze` rewrites those stat lines itself.

**The documented command does not work; this one does.** Plain `analyze` dies in a native worker on
`backend/src/main/c/jni/jni.h` (a 74 KB vendored Oracle JDK header that parses slower than the 30 s
default idle timeout) and **exits 0 having written nothing**, which reads like success:

```
GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS=120000 GITNEXUS_WORKER_MAX_CUMULATIVE_TIMEOUT_MS=600000 \
  ~/.nvm/versions/node/v22.14.0/bin/node \
  ~/.nvm/versions/node/v26.1.0/lib/node_modules/gitnexus/dist/cli/index.js \
  analyze --embeddings --force
```

~145–190 s. It is not a broken install and reinstalling does not help.

**Cross-check any zero with grep.** `impact()` reports 0 direct callers for `React.lazy`-imported
components — an artefact, not a safety signal. It is broader than lazy imports: last sitting a plain
grep found `CreateChapterDialog` had a **second** call site the graph never surfaced, and that
second site is where the upload-numbering bug was found.

**Two indexes.** `manga-library` (parent) and `manga-tl-worker` (the `worker/` submodule).
`detect_changes()` on the parent cannot see inside `worker/` — it sees a pointer and reports
`changed_count: 0`. Use `repo: "manga-tl-worker"`. Reindex each from its own root.

## CI

**Working, and the long-standing "CI never triggers" theory was wrong on both counts** — the probes
queried a repo that does not exist (the slug is `sagniKdas53/manga-tl`, and a 404 from a guessed URL
reads as "no check runs"), and the commits had simply never been pushed. No push event, no run.

**Nothing has been pushed for 10 commits, so nothing has run since.** Expect all three workflows
(`ci-maven.yml`, `ci-npm.yml`, `ci-backend-docker.yml`) to fire on the next push — but see
§ Where the work actually is first, because pushing this branch is a decision, not a formality.

**Use the four-command CI-equivalent gate for frontend work, from `frontend/`.** `vitest` alone once
passed over a `prettier --check` failure that CI caught:

```
npm run format:check   # prettier --check .
npm run lint           # eslint --max-warnings 0
npm run test:coverage  # not plain `vitest run`
npm run build          # tsc + vite, the only typecheck in the pipeline
```

All four verified green this sitting. Frontend workflow is **`ci-npm.yml`**, not `ci-node.yml`.
Query `actions/workflows/<file>/runs` — `commits/<sha>/check-runs` does not answer "did this
workflow run at all". **And note the SHAs in the last handoff's CI section are all dead**, so don't
try to look those runs up by hash.

## Carried forward — deliberately not done

- **The `open-in-view` flip-and-remeasure (Track 2).** Unblocked since the sixteenth sitting, still
  unscheduled, direction undecided. Don't start without asking.
- **Track 3 — the quality gap** (6.85% vs 1.92% flattening, `BUBBLE_CONTOUR_FALLBACK` removal
  checkpoint, VLM benchmarking).
- **AUDIT-F13's fix is unit-tested but never live-verified** — it is a write path behind
  `@PreAuthorize("hasAnyRole('ADMIN','TRANSLATOR')")`, and proving it means reordering pages in the
  real library. Worth exercising once in the UI. **The most likely thing on this list to bite.**
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
- **`NotificationController.currentUser` throws `RuntimeException("Unauthorized")`** — a 500, not a
  401/403.
- **`Reader.tsx`'s dead canvas-pan guards** on `.delete-page-btn`/`.reorder-controls`.
- **`PageService`'s "variant not smaller" branch is uncovered.** Needs a contrived incompressible
  fixture.
- **`JobController` still lists `queue:region-redo`** in its queue-clear `delete`.
- **Only `Dashboard` consumes the hook's `error`.** The chapters and pages surfaces still render an
  empty list on a failed fetch. Cheap to extend; not filed.

## Out of scope unless deliberately reopened

- **The worker pull model.** Measured at 0.83% of queue wait. Build for latency/resilience, never
  throughput.
- **A reader downscale cap.** Real but secondary.
- **`AUDIT-W5`**, the queue-wait share re-derivation. Settled; see `archive.md`.
- **The "should the worker split exist at all" architecture question.** Answered narrowly for B5.
- **Migrating off hand-maintained schema management (Flyway or otherwise).** Explicitly rejected by
  the user in the fifteenth sitting. Do not reopen without asking.

## Working constraints

- **`CLAUDE.md` is binding.** `impact()` before editing any symbol, `detect_changes()` before
  committing — including config-only commits. **But reindex first**, see § GitNexus; the index is
  stale and anchored to a destroyed commit.
- **Every commit SHA in the docs is dead.** Translate via `.git/filter-repo/commit-map`.
- **Check which branch you are on before committing.** Work is on `region-threshold-validation`,
  not `main`, and 10 commits are unpushed. The old "commit straight to main" rule no longer
  describes reality — confirm with the user.
- **The pre-commit gate is `mvn -o clean verify`, not `test`.** `test` skips PMD and jacoco.
- **The frontend gate is four commands, not one**, and **run `vitest` from `frontend/`**. From the
  repo root it loads a different config, jsdom never loads, and every test fails with
  `document is not defined` — a wrong working directory, not a regression.
- **A `@WebMvcTest` with a mocked repository proves very little.** If the behaviour belongs to
  Spring Data or Hibernate, a mocked repository cannot see it. This is AUDIT-T3's remaining bullet
  and it blocks a real AUDIT-B10 fix.
- **Verify red-green.** Write the failing test against the real code before writing a word about a
  suspected defect. It has caught a stale finding and several bad fixtures.
- **But check what a red test is telling you before you fix the code.** Two sittings running, the
  pre-existing reds were incoherent fixtures rather than regressions.
- **A green suite is not the same as covered behaviour.**
- **Read the whole `issues.md` entry, not the headline.**
- **Close the entry in the SAME commit as the fix** — remove from `issues.md`, reasoning into
  `archive.md`. **File new bugs in `issues.md`** — `new_bugs.md` is retired, and having two
  open-bug lists is how AUDIT-F13 sat as `[L]` while it was breaking every long-chapter reorder.
- **`git fetch --all` hangs on `origin`.** Use `git fetch github` / `git push github main`.
- **The GitHub repo slug is `sagniKdas53/manga-tl`.** Don't guess it.
- **Worker source lives at `worker/src/worker/`**, not `worker/`. Fixture is
  `worker/tests/test_providers.json`, forced by `conftest.py`. Worker baseline: **315 passing**.
- **`worker/` and `corpus/` are git submodules.** Each needs its own commit plus a pointer bump;
  push the submodule first. **`corpus/` is private and must stay private** — copyrighted scans.
- **The `postgres` MCP tools query the live database directly.** Cheap, read-only.
- **Say plainly if a finding turns out stale, wrong or incomplete.**

## Prompt for the next chat

<!-- markdownlint-disable MD031 MD040 -->

```
Continuing manga-library. Read docs/next-step.md first — it is written to make
this sitting startable cold. docs/archive.md's "2026-08-08 twentieth sitting"
section has the full reasoning for the loaded-prefix family (5 bugs, 1 root
cause). Don't re-audit that work — it is covered by 332 passing tests and what
survived is written down.

THREE THINGS NO OLDER HANDOFF KNOWS. Check these before anything else:
  1. git filter-repo HAS BEEN RUN. Every commit SHA in issues.md, archive.md
     and older handoffs is DEAD — all 79, verified. `git show <sha>` will say
     the work never happened; it was rewritten. Translate with:
       grep -E "^<old-sha>" .git/filter-repo/commit-map | awk '{print $2}'
     The old hashes were left in the docs deliberately — rewriting 79 refs by
     hand is a big risky diff for what one grep already gives you.
  2. THE WORK IS NOT ON main AND IS NOT PUSHED. HEAD is
     region-threshold-validation, 3 ahead of main, 10 ahead of github/main.
     Two unrelated threads are interleaved on it (the frontend bug fix and the
     OCR/corpus work) and it's named after neither. ASK the user whether to
     merge/push/split. Do not push unilaterally.
  3. THE GITNEXUS INDEX IS STALE and its anchor commit (d8b46a0) was destroyed
     by the rewrite. It predates the whole loaded-prefix fix. REINDEX before
     trusting impact() — command is in the handoff's GitNexus section; plain
     `analyze` exits 0 having written NOTHING.

STATE: 66 filed, 58 closed, 8 open (88%). NO [C], NO [H]. Gate verified this
sitting, not quoted: format:check + lint clean, 332 tests / 47 files passing.

QUEUE — work it in order unless redirected:
  1. AUDIT-B10. NEEDS A LIVE MEASUREMENT FIRST and two sittings have now failed
     to do it because it needs the stack up. PageController.listPages forwards
     the caller's ?sort= into Spring Data unvalidated while its two siblings
     allowlist theirs. Hit the LIVE endpoint with ?sort=bogus and ?sort=id,desc
     and record what actually happens BEFORE fixing — the expected 500 via
     GlobalExceptionHandler's catch-all is UNVERIFIED and @WebMvcTest cannot
     tell you. That's AUDIT-T3's remaining bullet; closing it means
     @SpringBootTest + Testcontainers (PipelineFlowIntegrationTest is the
     working example).
  2. THE LOADED-PREFIX SWEEP (new, small). Five instances of one defect class
     were found by chasing three symptoms; nobody has looked for the sixth.
     Grep for .length / Math.max / index arithmetic over anything sourced from
     usePaginatedResource and check it against totalCount. BUT totalCount is
     not always right: correct for page numbers (contiguous from 1), WRONG for
     chapter numbers (fractional — a 0.5 interlude means an 18-chapter series
     tops out at 17). Ask the server when it must be exact.
  3. AUDIT-F9 + pagination benchmarking. Now genuinely unblocked.
  4. AUDIT-Q1 with AUDIT-Q2 folded in — one mechanical backend pass.
  5. AUDIT-T1, AUDIT-D5, AUDIT-W3 last, deliberately — each needs real
     experimentation, user's explicit call.
Track 2 (open-in-view) and Track 3 (the quality gap) are NOT in this queue —
direction undecided, don't start either without asking.

THE OCR/REGION THREAD is parallel, is now ON THIS BRANCH, and has its OWN
handoff: docs/ocr_region_handoff_2026-08-08.md is authoritative for it. Six
region bugs open, NONE applied. Order: BUG-1, BUG-6, BUG-3, BUG-2 (2.0 -> 0.35,
validated on 7 pages), the compose default, then BUG-4. BUNDLE THE RE-RUN —
four of them invalidate every stored candidate, so it's one cloud pass, not
four (~85 min + paid-model cost). Two decisions there need the USER: pushing
the ~700MB corpus repo (confirm it exists and is PRIVATE — copyrighted scans)
and whether BUG-2/BUG-6 go to production.

GATES: backend `mvn -o clean verify` (not test). Frontend = FOUR commands from
frontend/: format:check, lint, test:coverage, build — vitest alone once passed
over a prettier failure CI caught. Run vitest FROM frontend/; from the repo
root every test fails with "document is not defined" and that's a wrong cwd,
not a regression. Worker baseline 315.

CI works — the old "never triggers" theory was wrong twice over (probes hit a
repo that doesn't exist; the slug is sagniKdas53/manga-tl, and the commits had
never been pushed). Nothing has run for 10 commits because nothing was pushed.
Don't look up the CI SHAs in old handoffs — they're dead too.

REMOTES: git fetch --all hangs on origin. Use git fetch github / git push
github main. worker/ and corpus/ are submodules; corpus/ is private and must
stay private.

CONSTRAINTS
- CLAUDE.md is binding: impact() before edits, detect_changes() before commits.
  But REINDEX FIRST — the index is stale and anchored to a destroyed commit.
- Verify red-green. Write the failing test against the real code first.
- But check what a red test is telling you before fixing the code. TWO sittings
  running, every pre-existing red was an INCOHERENT FIXTURE, not a regression
  (size:25/totalElements:2 then expecting a page 1; pagesTotalCount:1 with two
  loaded pages). An incoherent fixture is a green test that cannot fail for the
  right reason — and unlike the mock-ratio problem it's auditable by reading.
- Close the issues.md entry in the SAME commit as the fix; reasoning into
  archive.md. FILE NEW BUGS IN issues.md — new_bugs.md is retired.
- Read the whole issues.md entry, not the headline.
- Say plainly if a finding turns out stale, wrong or incomplete.
- If the user redirects mid-sitting, revert the discarded approach cleanly and
  record what was tried and undone.
```

<!-- markdownlint-enable MD031 MD040 -->
