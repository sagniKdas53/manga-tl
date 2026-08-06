# Handoff — 2026-08-06 (eleventh sitting)

> **AUDIT-Q3 is closed** — all seven bullets, in two commits plus a submodule commit. The entry is
> gone from `issues.md`.
>
> **The one thing worth more than the fix.** The entry **undercounts the phantom cache key**. Its
> own 2026-08-05 recount corrected "four copies" down to "two" — correct *for `qa.py`*, which is the
> only file it looked at. There is a third at `services/translation.py:756`, and it is the noisiest
> of the three. See [§ What the entry got wrong](#what-the-entry-got-wrong).
>
> **The tenth sitting's outstanding item is done.** Its two commits are deployed, and so are this
> sitting's. The index was reindexed and committed. See [§ Deployment](#deployment).

## What closed this sitting

| # | id | sev | outcome |
| --- | --- | --- | --- |
| 1 | AUDIT-Q3 | L | **Closed** (`b39cc71` + `822257b`, worker submodule `3310433`). Seven of seven accurate; one undercounted, two hiding more than filed. |

Full reasoning is in `archive.md`, "2026-08-06 eleventh sitting" (two sections — the entry was closed
across a worker half and a backend half, each with its own). Do not re-derive it.

### The short version

`b39cc71` (+ worker `3310433`) — the four worker bullets. `[Translation]` → `[RateLimit]` on a
limiter shared by OCR and QA. The dead `queue:region-redo` dispatch branch is gone. The phantom cache
keys are gone from `handlers/qa.py` **and** `services/translation.py`. `cleanup_audit_cache` sweeps
with an explicit per-file loop instead of deleting inside a generator expression.

`822257b` — the three backend bullets. `isOverride` trims once and compares against that.
`resolvePageForCallback` is hoisted out of `handleLayoutCallback`'s conversation loop.
`cloneLayerElement` replaces the copy duplicated in `cloneOcrData` and `cloneTranslationData`.

### What the entry got wrong

**The phantom cache key has three copies, not two.** The bullet reads *"`handlers/qa.py:390-391` and
`:599-600` … **Two** copies, not the four filed"*. That recount was right about `qa.py` and wrong
about the codebase: `services/translation.py:756` builds `tl:{provider}:{model}:{hash(text)}`, logs
it with the same hardcoded `(hit=False)`, and throws it away, with no TL cache behind it either. It
is the worst of the three — the `qa.py` pair fire once per image, this one fires once per **text
segment**.

**That is the fourteenth finding stale, wrong or incomplete.** The pattern this time was a *recount*
that narrowed the search to the file the bullet named. When a bullet says "N copies", grep the whole
tree for the shape, not the anchor.

**Two more bullets were bigger than their wording.** `cleanup_audit_cache`'s generator is described
as "works; should not survive review" — it does not quite work. The unlink happens inside the
generator, so one raising `os.remove` propagates into the enclosing `except Exception` and **aborts
the whole sweep**: later files stay on disk, the count is never printed. On a cache directory being
written to while it is swept, that is a reachable race. And `queue:region-redo` was not merely dead —
it is absent from `/capabilities`, from `HEAVY_QUEUES`/`LIGHT_QUEUES` and from `image_bound_queues`,
so had anything reached it the job would have run a real redo while bypassing both the stale check
and the slot accounting.

### The two bullets with no red-green

Both said plainly rather than papered over with a test that passes either way.

**`cloneLayerElement`** is duplication removal with both copies complete. Normalise the layer
variable and the two 29-line blocks diff byte-identical; every non-`id` field on `LayerElement` is
copied by both. There is no state in which the old code gave a wrong answer, so nothing goes red when
it is restored, and an "all fields are copied" test would pass identically before and after.

**The two `qa.py` cache-key copies** ride on the translation copy's test. They are the same removal
inside a nested `attempt_llm`/`attempt_vlm` reachable only through a ~15-mock harness; writing one to
assert a log line's *absence* would have added exactly the test shape AUDIT-T1 exists to complain
about. `translate_text` is directly callable, so that copy carries the assertion.

### Filed by this sitting, not fixed

**`SeriesController.resolveSetting` has `isOverride`'s bug on the write path.** It nulls `"inherit"` /
`"default"` out of an incoming DTO before persisting and misses `" inherit "` for the same untrimmed
reason. Left alone: different method, different file, outside AUDIT-Q3's bullets. After this sitting
it is dormant rather than live — every *reader* now treats a padded placeholder as inert, so the
consequence is only that such a value can still be stored. Worth its own entry if the write path
should be tightened.

## The ranked list

Renumbered with Q3 removed. Nothing below was re-derived this sitting.

| # | id | sev | what | size |
| --- | --- | --- | --- | --- |
| 1 | AUDIT-D5 | L | Published DB/Valkey/console ports, `LOG_LEVEL=DEBUG`, `npm install` under an `npm ci` comment, no `MaxRAMPercentage`. | S–M |
| 2 | AUDIT-B5 | M | `ddl-auto: update` against a competing `init.sql`. | L — a migration project |
| 3 | AUDIT-Q1 | — | 249 `Objects.requireNonNull`, up 2 since filing. | L, mechanical |
| 4 | AUDIT-T1 | — | The "e2e" test isn't one, and the suite got more mocked. | L — wants `mock_router.md` |
| — | AUDIT-W1, W2 | L | Both re-ranked **[H] → [L]** by the sixth sitting. | S each |
| — | AUDIT-W3 | M | Half-defused by W10: light slots are 4 now, so only the heavy tier still stalls. | M |

**AUDIT-W3 remains the only [M] outside the B5 migration project.**

**If you want one recommendation: take AUDIT-D5.** It is now item 1 on its own merits, it is compose
and Dockerfile work rather than Java, and its first bullet — unauthenticated Valkey and Postgres
published to the host — is the highest real-world exposure left on the list even at [L]. It is also
the last small multi-bullet entry; everything under it is a project.

**Do not start AUDIT-B5 casually.** It is a schema-migration project — Flyway or Liquibase, plus
reconciling `init.sql` against whatever `ddl-auto: update` has actually produced live.

**AUDIT-Q1 is the mechanical one.** 249 `Objects.requireNonNull`, concentrated in four classes. This
sitting deleted two of them incidentally (the `LayerElement` copy extraction did not carry any, but
`handleLayoutCallback`'s hoist walked past four). Worth doing as one sweep, not incrementally.

## Where the work stands

**Backend 414** (was 412; +2 this sitting). `mvn -o clean verify`, full suite, green.
**Worker 310** (was 305; +5). All four gates green: `pytest`, `ruff check`, `ruff format --check`,
`pyright` 0 errors. **Frontend 308**, untouched.

No API surface changed, so `npm run generate-api` was not run. It is still worth a periodic no-change
regen just to see whether the diff is empty — that is how the seventh sitting found drift.

Dependabot is unchanged: four PRs open, all four close-don't-merge. #60 okhttp (the pin is
load-bearing — read the comment in `pom.xml` first) and #52 springdoc are blocked outright; #51
testcontainers-bom 2.x and #40 TypeScript 7 are major-version projects of their own. GitHub reports 2
high-severity Dependabot alerts on push; those are AUDIT-S\* territory, tracked separately.

### Deployment

**Everything is deployed.** The tenth sitting's backend-only rebuild landed first and came up clean —
no errors, and no `Rejecting unknown status` in the worker logs, so nothing in the wild was sending a
status word outside the vocabulary. This sitting's backend **and** worker images were then rebuilt and
restarted.

Nothing about this sitting's changes should surface in the logs; the closest thing to a visible
behaviour change is `[RateLimit]` replacing `[Translation]` on rate-limit sleeps. If you grep worker
logs for translation stalls, that prefix moved.

### GitNexus

Reindexed at `1e4da96` and committed as `8034554` (`chore:`), per the standing rule that the count
rewrite gets its own commit. **It is stale again** — three commits have landed since. Reindex with
the globally installed `gitnexus analyze --embeddings --force` (not `node .gitnexus/run.cjs analyze`,
which aborts).

`detect_changes` on the backend commit was **MEDIUM with 4 affected processes**, all
`LayoutCallback → *` — the method actually edited, doing one fewer query rather than breaking.
`resolveModel` and three test repository fields were flagged as the usual line-offset artefact;
`git diff -U0` showed six real hunks. **`impact` on `isOverride` was CRITICAL and that one was
real** — 2 direct callers, 6 processes, and it genuinely is a shared predicate rather than an
artefact. Worth distinguishing: the artefact is a symbol *below an insertion*, not a symbol with many
callers.

## Not mine — left alone deliberately

The free-model benchmarking thread is **active and committing concurrently.** It landed two commits
during the tenth sitting; it was quiet during this one, but assume it is not.

Untracked or modified and **not** swept into any commit:

- `docs/benchmarking.md`, `docs/run_ocr_bench.md`
- `docs/free_openrouter_translation_benchmark_2026-08-06.md`, `docs/translation_bench.md`
- `scripts/benchmark_translation.py`, `scripts/build_translation_corpus.py`, `scripts/test-providers.json`
- `corpus/`

Every commit used an explicit pathspec. **Keep doing that, and put `-F <file>` before the `--`.**

## Carried forward — deliberately not done

Unchanged from the tenth sitting except where noted; each was left undone for a stated reason and
those reasons hold.

- **`SeriesController.resolveSetting`'s untrimmed placeholder compare.** New this sitting — see
  above. Dormant, not live.
- **`updateJobStatus` has no state-machine validation**, only vocabulary validation. A transition
  guard has to tell a stale worker's late callback from a live one, and the `Job` row carries nothing
  to do it with. Needs job generation tracking. A design gap, not a defect.
- **The cross-provider fallback rule has not reached `ocr.py` and `qa.py`.** AUDIT-W11 established it
  for translation and `is_provider_auth_parked()` is in place for the others. Left alone because the
  failure was only ever measured on translation.
- **The exported ZIP's pixel content is unverified.** jsdom has no canvas, so those PNG bytes are
  placeholders. Needs a real browser.
- **`BUBBLE_CONTOUR_FALLBACK` is compensation, not a feature.** `TODO.md` carries the removal
  checkpoint and the baseline numbers. A *bigger* YOLO is not the detector that replaces it.
- **The `neurometric` key in `secrets/api_keys.json` is still dead.** A chapter pinned to it escapes
  to the global provider.
- **A scan for other `@Transactional` self-invocations has not been done.** AUDIT-B2 was the known
  instance; the class of bug is invisible at the call site and this codebase has hit an
  annotation-binding failure three times.
- **`NotificationController.currentUser` throws `RuntimeException("Unauthorized")`**, so it is still
  a 500. Making it a 401/403 is its own change.
- **`Reader.tsx` guards on `.delete-page-btn` and `.reorder-controls`** in its canvas-pan handlers.
  Provably dead since `b951ee2`. Left in place because that file is AUDIT-F2's.
- **`PageService`'s "variant not smaller" branch is uncovered.** Forcing it needs a contrived
  incompressible fixture.
- **`JobController` still lists `queue:region-redo` in its queue-clear `delete`.** Deleting a key
  that never exists is free, and it is legacy cleanup rather than a dispatch path, so it was left
  when the worker's dead branch went.
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
  diff -U0` hunk ranges before believing the blast radius. It also **cannot distinguish a flow being
  deliberately deleted from one breaking**. But **do not dismiss every CRITICAL as an artefact**:
  this sitting's `isOverride` CRITICAL was real. The artefact is a symbol *below an insertion*; a
  genuinely shared symbol with many callers is not.
- **The pre-commit gate is `mvn -o clean verify`, not `test`.** `test` skips PMD and jacoco's rules;
  CI runs `verify` and will fail on things `test` never sees. Use `mvn -o clean test` for red-green
  iteration, `verify` before you commit. **Never trust an incremental Maven run** — always `clean`.
- **Running `analyze` rewrites the symbol counts in `CLAUDE.md` and `AGENTS.md`.** Keep that out of a
  feature commit — it gets its own `chore:` commit.
- **Close entries in `issues.md` in the same commit as the fix.** The convention is *remove* from
  `issues.md` and write the reasoning into `archive.md`. A multi-bullet entry can be closed across
  several commits — strike bullets as they land (updating the entry's italic header note with the
  running count) and delete the entry with the last one.
- **Verify a fix red-green, and revert defects INDIVIDUALLY.** Six defects reverted separately this
  sitting, each red on its own test; two have no red-green and are explained above.
- **When a bullet gives a count, re-derive the count across the tree, not the file.** A previous
  recount narrowed to the anchor's file and missed a third of the instances.
- **Read the whole `issues.md` entry before calling it closed** — and check the *mechanism*, not just
  whether the line is still there. Fourteen findings have now been stale, wrong or incomplete.
- **One performance variable per change.** The delta has to be attributable.
- **Commit straight to `main`** — no feature branches. **Use a pathspec** (`git commit -F <msgfile> --
  <paths>`): there is active concurrent work in the tree that must not be swept in, and it commits
  *during* your sitting. **`-F` goes before the `--`**, or git reads it as a pathspec.
- **`git fetch --all` hangs** on `origin` (a pi5 host over Tailscale, 145 behind, unreachable). Use
  `git fetch github` / `git push github main`. The worker submodule's `origin` is a different,
  working GitHub remote, so a plain `git push origin main` is correct *there*.
- **Never run `prettier --write` outside a commit whose purpose is formatting.** `ci-npm.yml` gates
  on `format:check`; verify with `git diff -w`.
- **Frontend lint is `--report-unused-disable-directives --max-warnings 0`.** A warning fails the build.
- **Worker gates are four:** `pytest -q`, `ruff check .`, `ruff format --check .`, `pyright .`. Ruff
  will reformat long assertion lines and strip `f` prefixes off placeholder-less strings — run
  `ruff check --fix . && ruff format .` before the final pytest, not after.
- **Pyright rejects `from tenacity import retry_if_exception_type`** as a private import. Follow
  `llm_client.py`: `from tenacity.retry import ...`, `from tenacity.stop import ...`,
  `from tenacity.wait import ...`.
- **Worker source lives at `worker/src/worker/`**, not `worker/`. The `issues.md` anchors are written
  relative to the package (`handlers/qa.py`, `rq_tasks.py`), so resolve them under `src/worker/`.
  `worker/app.py` is the one file genuinely at the submodule root.
- **`@MockitoSpyBean` works on Spring Data repositories** in this codebase (spring-test 6.2,
  `org.springframework.test.context.bean.override.mockito`). It is how
  `JobCoordinatorServiceTest` counts `pageRepository.findById` calls; the spy delegates, so every
  other test in the class is unaffected. Use `mockingDetails(...).getInvocations()` when you need a
  count rather than an exact `verify`.
- **`.env` is gitignored and overrides `docker-compose.yml` defaults.** Verify with `docker compose
  config | grep -E 'CONCURRENT_JOBS|MAX_(HEAVY|LIGHT)_SLOTS'` before trusting a run. Currently
  `CONCURRENT_JOBS=4`, `MAX_HEAVY_SLOTS=1`, `MAX_LIGHT_SLOTS=3`, `DISABLE_LOCAL_LLM=true`.
- The frontend compiles **into** the backend image, so any frontend change needs `docker compose
  build backend && docker compose up -d backend` (~10 min). The worker rebuild is much faster.
- Backend API changes require `npm run generate-api` from `frontend/` with the backend container up.
  **A periodic regen with no backend change is worth doing** just to see whether the diff is empty.
- Backend build is Maven (no wrapper) **and must be run from `backend/`**. Frontend is
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
Continuing manga-library. Read docs/next-step.md first. docs/archive.md has two
"2026-08-06 eleventh sitting" sections with what closed and why. Do not re-audit
the codebase and do not re-derive the run numbers — both are written down.

STATE: AUDIT-Q3 is closed, all seven bullets, in two commits (b39cc71, 822257b)
plus worker submodule 3310433, all pushed to github. Everything is deployed —
backend and worker were rebuilt and restarted at the end of the sitting.
issues.md remains trustworthy.

FIRST: the GitNexus index is stale (last analysed 1e4da96, three commits back).
Run the globally installed `gitnexus analyze --embeddings --force`, then commit
the CLAUDE.md/AGENTS.md count rewrite as its own chore: commit.

GATE: `mvn -o clean verify`, NOT `mvn -o clean test`. Worker has FOUR gates:
pytest, ruff check, ruff format --check, pyright.

REMOTES: `git fetch --all` hangs on `origin` (pi5 over Tailscale, unreachable).
Use `git fetch github` / `git push github main`.

NOT MINE: the free-model benchmarking thread commits concurrently.
docs/benchmarking.md, docs/run_ocr_bench.md, docs/translation_bench.md,
docs/free_openrouter_translation_benchmark_2026-08-06.md, scripts/
benchmark_translation.py, scripts/build_translation_corpus.py,
scripts/test-providers.json, corpus/. Leave them; use an explicit pathspec on
every commit, and put -F <msgfile> BEFORE the -- or git reads it as a pathspec.

WHAT I WANT

Work the ranked list in next-step.md, top down — item 1 is now AUDIT-D5, the
last small multi-bullet entry. Everything below it is a project, so if you would
rather start one, say which and why before you start.

Say plainly if a finding turns out stale, wrong or INCOMPLETE when you actually
read the code — that has now paid off fourteen times. This sitting found a
bullet whose own recount undercounted it: it said "two copies, not four", which
was true of the file it named and false of the tree. When a bullet gives a
count, grep the whole tree for the shape, not the anchor.

CONSTRAINTS
- CLAUDE.md is binding: impact() before edits, detect_changes() before commits.
  Its CRITICAL/HIGH is USUALLY the line-offset artefact — check `git diff -U0`
  hunk ranges — but not always: a genuinely shared symbol with many callers is
  a real CRITICAL. It also cannot tell a flow being deliberately deleted from
  one breaking.
- Close the issues.md entry in the SAME commit as the fix: remove it from
  issues.md, write the reasoning into archive.md. A multi-bullet entry may be
  closed across several commits — strike bullets as they land.
- Verify red-green, and when an entry has several defects revert them
  INDIVIDUALLY. If a bullet genuinely has no red-green (pure duplication
  removal), say so rather than writing a test that passes either way.
- Read the whole issues.md entry, not the headline.
- Commit to main directly, with a pathspec; worker/ is a submodule and needs its
  own commit plus a pointer bump, pushed before the parent.
- Frontend lint is --max-warnings 0 and CI gates on prettier --check.
- One performance variable per change.
- Security findings (AUDIT-S*) are tracked separately; don't fold them in.
```

<!-- markdownlint-enable MD031 MD040 -->
