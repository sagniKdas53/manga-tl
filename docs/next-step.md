# Handoff — 2026-08-06 (ninth sitting)

> **AUDIT-P6 and P8 are done** — the last two [M] findings outside the B5 migration project. Both
> were **accurate as filed**, which is worth noting after a run of twelve that were not.
>
> **Both had an unmentioned bullet, and both tests first passed for the wrong reason.** P6's entry
> describes a timeout; it has a quieter twin where a 500 loses the update with no exception at all.
> P8's test passed twice with the defect reinstated before it was right. See
> [§ Two traps, both caught the same way](#two-traps-both-caught-the-same-way).
>
> **Everything is pushed and deployed.** The handoff's "10 commits not pushed" was wrong — they were
> already on `github`. See [§ The remote situation](#the-remote-situation).

## What closed this sitting

| # | id | sev | outcome |
| --- | --- | --- | --- |
| 3 | AUDIT-P6 | M | **Closed** (`25e1482` + worker `7d1e0c3`). Accurate as filed, plus one twin. |
| 4 | AUDIT-P8 | M | **Closed** (`47c566f`). Accurate as filed. |

### AUDIT-P6 — the lost `COMPLETED`, and why it costs what it does

The entry's mechanism is exactly right. What is worth writing down is *why* it is as expensive as it
is: **nothing else tells the backend a job finished.** The results callbacks (`handleOcrCallback` and
friends) write results, not status — the single `setStatus("COMPLETED")` in the whole backend is in
`JobCoordinatorService`'s *empty-OCR* branch, which returns early. Job completion depends entirely on
the worker's PATCH, and `recoverStaleProcessingJobs` requeues anything left `PROCESSING` for ten
minutes, on a five-minute scan.

The PATCH now goes through a tenacity-wrapped `_patch_job_status`: four attempts, exponential
backoff, the same idiom as `LLMClient._execute_with_retry`. Worst case ~27 s of a worker slot against
the minutes a duplicate OCR or translation pass costs.

**The unmentioned twin.** `requests` does not raise on an error status and the original never looked
at the response, so a 500 lost the update *more* silently than the timeout that was filed — no
exception even to print. That is the **sixth** time reading past the headline found real work.
Responses are now classified: 5xx/408/429 retry, 404 gives up at once (the row was deleted or
cancelled and will not come back), any other 4xx is a rejected payload logged once.

### AUDIT-P8 — a longer TTL is not the fix; a sliding one is

Both `Duration.ofHours(2)` calls were where the entry said. `startPipeline` wrote the key and nothing
refreshed it, so the window ran from the start of the *pipeline*.

The entry offered two fixes and neither is quite right on its own. A longer TTL is still a bound
picked in advance against an unbounded pipeline — pick any number, a big enough chapter beats it. So
both halves: `PIPELINE_TRACE_TTL = 12h` (one constant replacing both literals, documented in the same
shape as AUDIT-P7's `REDO_REASON_TTL` right above it), **and every hand-off through
`enqueueJobDirectly` now calls `expire()` on the key it just read.** The TTL therefore has to outlive
a single *stage*, not a whole run — and a stalled stage is already given up on by the sweeper after
ten minutes. The bound remains only so a pipeline that dies between stages cannot leak the key.

Moving the trace onto the `Job` row was **not** done: the key is read before the `Job` row exists in
`enqueueJobDirectly`, so that is a restructure, not a fix.

## Two traps, both caught the same way

Both were caught by reverting the defects **individually**, and neither would have been caught by the
green run. This is the discipline paying for itself twice in one sitting.

- **The fixture has to model the thing under test.** `JobCoordinatorServiceTest`'s in-memory Redis
  fake accepted a `Duration` on `set` and dropped it on the floor. Every TTL assertion in that class
  was therefore vacuously true. It had to learn TTLs before it could test them — and `expire()` had
  to be overridden too, or the call would have escaped to a real connection factory.
- **Asserting the surviving value can test the wrong write.** Once the fake recorded TTLs, the test
  *still* passed with the 2-hour literal restored: `startPipeline` hands straight off to
  `enqueueJobDirectly`, whose new sliding refresh overwrites the initial TTL before any assertion can
  read it. The fake now records **every** TTL applied to a key, in order, and the test asserts over
  the whole history. **That is the fifth time a test passed for the wrong reason.**
- **Tenacity's backoff is disarmed per-object, not per-module.** The worker tests swap the `sleep`
  callable on the one `Retrying` instance (`_patch_job_status.retry.sleep`) and restore it in a
  `finally`. Patching `time.sleep` is what neutralised a test in the eighth sitting; this keeps the
  blast radius to the object under test. The four new tests run in 0.7 s.

## The remote situation

**The eighth sitting's "10 commits not pushed" was wrong.** They were already on `github`. There are
two remotes and only one of them works:

| remote | url | state |
| --- | --- | --- |
| `github` | `github.com/sagniKdas53/manga-tl.git` | **live.** Push and fetch both fine. |
| `origin` | `pi5.tail9ece4.ts.net:2222` over Tailscale | **145 behind, times out.** |

`git fetch --all` hangs on `origin` and always will while the pi5 host is unreachable — that is the
timeout the last two handoffs recorded, not a transient. **Use `git fetch github` / `git push github
main`.** The worker submodule has only one remote (`origin` → `github.com/.../manga-tl-worker.git`)
and it is the working one, so a plain `git push origin main` is correct *there*.

Everything is pushed as of this sitting: parent at `25e1482`, worker at `7d1e0c3`.

## The ranked list

Renumbered with P6 and P8 removed. Nothing below was re-derived.

| # | id | sev | what | size |
| --- | --- | --- | --- | --- |
| 1 | AUDIT-B8 | L | Eight verified bullets. `updateJobStatus` accepting arbitrary strings is the real one. | M, splittable |
| 2 | AUDIT-Q3 | L | Seven verified bullets. `isOverride`'s untrimmed `"inherit"` is now a shared predicate. | S–M |
| 3 | AUDIT-D5 | L | Published DB/Valkey/console ports, `LOG_LEVEL=DEBUG`, `npm install` under an `npm ci` comment, no `MaxRAMPercentage`. | S–M |
| 4 | AUDIT-B5 | M | `ddl-auto: update` against a competing `init.sql`. | L — a migration project |
| 5 | AUDIT-Q1 | — | 249 `Objects.requireNonNull`, up 2 since filing. | L, mechanical |
| 6 | AUDIT-T1 | — | The "e2e" test isn't one, and the suite got more mocked. | L — wants `mock_router.md` |
| — | AUDIT-W1, W2 | L | Both re-ranked **[H] → [L]** by the sixth sitting. | S each |
| — | AUDIT-W3 | M | Half-defused by W10: light slots are 4 now, so only the heavy tier still stalls. | M |

**AUDIT-W3 is now the only [M] left outside the B5 migration project.**

**If you want one recommendation: take AUDIT-B8, and start with its `updateJobStatus` bullet.** That
endpoint is `InternalJobController:68-105`, which I read closely this sitting — it writes whatever
`status` string the worker sends straight onto the row, no enum, no state-machine validation, and it
special-cases `PENDING`/`FAILED` for *logging only*. P6 has just made the worker **retry** against
that endpoint, so it is now hit more often and a typo reaching the DB matters slightly more than it
did. The rest of B8's eight bullets are independent and the entry is splittable.

**Do not start item 4 (AUDIT-B5) casually.** It is a schema-migration project — Flyway or Liquibase,
plus reconciling `init.sql` against whatever `ddl-auto: update` has actually produced live.

## Where the work stands

**Backend 401** (was 399; +2 this sitting), `mvn -o clean test`, full suite.
**Worker 305** (was 301; +4). All four gates green: `pytest -q`, `ruff check`, `ruff format --check`,
`pyright`. **Frontend 308**, untouched — no frontend source or schema change this sitting.

Dependabot is unchanged: four PRs open, all four close-don't-merge. #60 okhttp (the pin is
load-bearing — read the comment in `pom.xml` first) and #52 springdoc are blocked outright; #51
testcontainers-bom 2.x and #40 TypeScript 7 are major-version projects of their own. GitHub also
reports 2 high-severity Dependabot alerts on push; those are AUDIT-S\* territory, tracked separately.

### Deployment

- **Worker live.** Rebuilt and restarted this sitting; healthy, no errors in the startup log. This
  deploys P6.
- **Backend live.** Rebuilt and restarted this sitting. This deploys P8.
- Nothing is pending deployment.

### GitNexus

**Reindexing works again** — the eighth sitting's advice to reinstall was right. The globally
installed `gitnexus analyze` succeeds where `node .gitnexus/run.cjs analyze` was aborting; a
`--embeddings --force` pass took 233 s and put the index at **5,115 nodes / 12,929 edges**. Note the
plain `analyze` and the `--force` run disagree slightly (5,129 vs 5,115) and `--embeddings` alone
reports "Already up to date" without doing anything — use `--embeddings --force` when you want both.

The symbol-count rewrite in `CLAUDE.md`/`AGENTS.md` went out as its own `chore:` commit (`746a03b`),
per the standing rule.

## Not mine — left alone deliberately

The free-model benchmarking thread is active and concurrent. Untracked or modified and **not** swept
into any commit this sitting:

- `docs/benchmarking.md` (modified)
- `docs/free_openrouter_translation_benchmark_2026-08-06.md`
- `scripts/benchmark_translation.py`, `scripts/build_translation_corpus.py`
- `corpus/`

Every commit used an explicit pathspec. `scripts/benchmark_free_translation.py` and the OpenRouter
screenshot from the last handoff were committed by that thread in `846a616`.

## Carried forward — deliberately not done

Unchanged; each was left undone for a stated reason and those reasons hold.

- **The cross-provider fallback rule has not reached `ocr.py` and `qa.py`.** AUDIT-W11 established it
  for translation and `is_provider_auth_parked()` is in place for the others. Left alone because the
  failure was only ever measured on translation.
- **The exported ZIP's pixel content is unverified.** jsdom has no canvas, so those PNG bytes are
  placeholders. Needs a real browser.
- **`BUBBLE_CONTOUR_FALLBACK` is compensation, not a feature.** `TODO.md` carries the removal
  checkpoint and the baseline numbers. A *bigger* YOLO is not the detector that replaces it.
- **The `neurometric` key in `secrets/api_keys.json` is still dead.** Housekeeping since W11: a
  chapter pinned to it escapes to the global provider.
- **A scan for other `@Transactional` self-invocations has not been done.** AUDIT-B2 was the known
  instance; the class of bug is invisible at the call site and this codebase has hit an
  annotation-binding failure three times.
- **`NotificationController.currentUser` throws `RuntimeException("Unauthorized")`**, so it is still
  a 500. Making it a 401/403 is its own change.
- **`Reader.tsx` guards on `.delete-page-btn` and `.reorder-controls`** in its canvas-pan handlers.
  Provably dead since `b951ee2`. Left in place because that file is AUDIT-F2's.
- **`PageService`'s "variant not smaller" branch is uncovered.** Forcing it needs a contrived
  incompressible fixture.
- **The larger frontend items** — AUDIT-F1 (theme → `colorSchemes` + `cssVariables`, bundle with the
  next MUI major), AUDIT-F2 (`Reader.tsx` at 3,954 lines / 28 `useState` — the profile says *split
  the component*, which is a project), AUDIT-F8 (pagination — decide the library-size ceiling first;
  if a few hundred series is the cap, close it instead of building it), AUDIT-F9 (Playwright viewport
  smoke test — wants the same real-browser infrastructure as the ZIP-pixel item).

## Out of scope unless deliberately reopened

- **The worker pull model.** Measured at 408 s of 49,058 s of queue wait (0.83%). Build it for
  latency, resilience and multi-worker scaling — never for throughput.
- **AUDIT-S\*** — security is tracked separately, don't fold it in.
- **A reader downscale cap.** A 3000 px long-edge cap hits 124 images and saves a further 46 MB. Real
  but secondary, and a second performance variable.
- **AUDIT-W5**, and re-deriving the queue-wait share. Both settled; see archive.md.

## Working constraints

- **`CLAUDE.md` is binding.** `impact({target, direction:"upstream", repo:"manga-library"})` before
  editing any symbol, report HIGH/CRITICAL, `detect_changes()` before committing. **`detect_changes`
  attributes by line offset**, so a large insertion flags untouched symbols below it — check `git
  diff -U0` hunk ranges before believing the blast radius. This sitting's CRITICAL on
  `enqueueJobDirectly` (29 symbols, 11 processes) was genuine fan-out — it is the single funnel every
  pipeline enqueue passes through — but the twelve repository *properties* it also flagged were pure
  offset artefact from a 16-line constant inserted above them.
- **Running `analyze` rewrites the symbol counts in `CLAUDE.md` and `AGENTS.md`.** Keep that out of a
  feature commit — it gets its own `chore:` commit.
- **Never trust an incremental Maven run.** `mvn -o clean test-compile` after a signature or record
  arity change, and `mvn -o clean test` for any red-green check.
- **Close entries in `issues.md` in the same commit as the fix.** Both closed this sitting did. The
  convention is *remove* from `issues.md` and write the reasoning into `archive.md`.
- **Verify a fix red-green, and revert defects INDIVIDUALLY.** Two defects each for P6 and P8, all
  four reverted separately. **Five times now** a test has passed for the wrong reason — check what
  your fixtures patch, and check whether a later step in the same call overwrites what you assert on.
- **Read the whole `issues.md` entry before calling it closed.** P6's timeout bullet had an
  unmentioned twin; that is the sixth instance after P7, B3, B4, B8 and W8.
- **One performance variable per change.** The delta has to be attributable.
- **Commit straight to `main`** — no feature branches. **Use a pathspec** (`git commit -- <paths>`):
  there is active concurrent work in the tree that must not be swept in.
- **`git fetch --all` hangs.** Use `git fetch github` — see [§ The remote situation](#the-remote-situation).
- **Never run `prettier --write` outside a commit whose purpose is formatting.** `ci-npm.yml` gates
  on `format:check`; verify with `git diff -w`.
- **Frontend lint is `--report-unused-disable-directives --max-warnings 0`.** A warning fails the build.
- **Worker gates are four:** `pytest -q`, `ruff check .`, `ruff format --check .`, `pyright .`. Ruff
  will reformat long assertion lines and strip `f` prefixes off placeholder-less strings — run
  `ruff check --fix . && ruff format .` before the final pytest, not after.
- **Pyright rejects `from tenacity import retry_if_exception_type`** as a private import. Follow
  `llm_client.py`: `from tenacity.retry import ...`, `from tenacity.stop import ...`,
  `from tenacity.wait import ...`.
- **`.env` is gitignored and overrides `docker-compose.yml` defaults.** Verify with `docker compose
  config | grep -E 'CONCURRENT_JOBS|MAX_(HEAVY|LIGHT)_SLOTS'` before trusting a run. Currently
  `CONCURRENT_JOBS=4`, `MAX_HEAVY_SLOTS=1`, `MAX_LIGHT_SLOTS=3`, `DISABLE_LOCAL_LLM=true`.
- The frontend compiles **into** the backend image, so any frontend change needs `docker compose
  build backend && docker compose up -d backend` (~10 min). The worker rebuild is much faster.
- Backend API changes require `npm run generate-api` from `frontend/` with the backend container up.
  **A periodic regen with no backend change is worth doing** just to see whether the diff is empty —
  that is how the seventh sitting found drift from `c3fa119`.
- Backend build is Maven (`mvn -o test`, no wrapper) **and must be run from `backend/`**. Frontend is
  `npx vitest run` / `npx tsc --noEmit` / `npm run lint` / `npm run format:check`.
- **`worker/` is a git submodule.** Changes need their own commit plus a pointer bump. `git add
  worker` stages the pointer; include it in the parent commit's pathspec. **Push the submodule
  first**, or the parent's pointer references a commit nobody else can fetch.
- **The local `.venv` is Python 3.13.12 / numpy 2.3.5** and matches the image. It is at the repo root,
  not in `worker/`; run the worker suite as `cd worker && ../.venv/bin/python -m pytest -q`.
- **Testcontainers works.** If the backend suite goes red across many classes at once, read the
  surefire report's `Caused by` chain before blaming the environment.
- **MinIO objects are readable straight off disk** — no container, no port 9000. Single-drive MinIO
  prefixes a 32-byte bitrot checksum to each 1 MiB block; strip those and the bytes come back
  verbatim. Handle three layouts: single-part, multi-part (`part.1..N`, numeric order), and small
  objects inlined into `xl.meta` as a trailing msgpack `bin32`. Verified against all 743 ETags.
- **Never upload Firefox profiles** — use save-to-file; they carry series names and URLs.
- **`sx` is not a free swap for `style`, in two distinct ways:** per-frame values mint an emotion
  class per value, and `sx` loses the cascade to a plain CSS class on a specificity tie. Scope to
  `&.the-class` when overriding one.

## Prompt for the next chat

<!-- markdownlint-disable MD031 MD040 -->

```
Continuing manga-library. Read docs/next-step.md first. docs/archive.md's
"2026-08-06 ninth sitting" section has what closed and why. Do not re-audit the
codebase and do not re-derive the run numbers — both are written down.

STATE: AUDIT-P6 and P8 are closed, red-green verified with each defect reverted
individually, each closing its issues.md entry in the same commit. issues.md
remains trustworthy. Everything is pushed (parent 25e1482, worker 7d1e0c3) and
both containers are live and current. Nothing is pending deployment.

GITNEXUS: reindexing works again — use the globally installed `gitnexus analyze
--embeddings --force`, not `node .gitnexus/run.cjs analyze`. Index is current.

REMOTES: `git fetch --all` hangs on `origin` (a pi5 host over Tailscale, 145
behind, unreachable). Use `git fetch github` / `git push github main`. The
worker submodule's `origin` is a different, working GitHub remote.

NOT MINE: the free-model benchmarking thread is active — docs/benchmarking.md,
docs/free_openrouter_translation_benchmark_2026-08-06.md, scripts/
benchmark_translation.py, scripts/build_translation_corpus.py, corpus/. Leave
them; every commit used an explicit pathspec.

WHAT I WANT

Work the ranked list in next-step.md, top down. The recommendation is item 1
(AUDIT-B8), starting with its updateJobStatus bullet — P6 has just made the
worker retry against that endpoint.

Say plainly if a finding turns out stale or wrong when you actually read the
code — that has paid off twelve times. P6 and P8 were both accurate as filed,
which is the exception, not the rule.

CONSTRAINTS
- CLAUDE.md is binding: impact() before edits, detect_changes() before commits.
  Its CRITICAL/HIGH is usually the line-offset artefact — check `git diff -U0`
  hunk ranges.
- Close the issues.md entry in the SAME commit as the fix: remove it from
  issues.md, write the reasoning into archive.md.
- Verify red-green, and when an entry has several defects revert them
  INDIVIDUALLY. Five times now a test has passed for the wrong reason — check
  what your fixtures actually model, check whether a later step in the same
  call overwrites the value you assert on, and never trust a Maven run that
  isn't `clean`.
- Read the whole issues.md entry, not the headline. That is now six times a
  bullet the headline omitted turned out to be real work.
- Worker has FOUR gates: pytest, ruff check, ruff format --check, pyright.
- Commit to main directly, with a pathspec; worker/ is a submodule and needs
  its own commit plus a pointer bump, pushed before the parent.
- Frontend lint is --max-warnings 0 and CI gates on prettier --check.
- One performance variable per change.
- Security findings (AUDIT-S*) are tracked separately; don't fold them in.
```

<!-- markdownlint-enable MD031 MD040 -->
