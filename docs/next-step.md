# Handoff — 2026-08-06 (twelfth sitting)

> **AUDIT-D5 is three-fifths closed.** The ports, the `DEBUG` log defaults and the `npm install` are
> fixed. The remaining two bullets are the memory pair, **deliberately deferred by decision** — see
> [§ The memory pair](#the-memory-pair). The entry is still in `issues.md`, rewritten.
>
> **⚠️ NOTHING IS DEPLOYED.** The loopback port change needs `docker compose up -d db redis minio`
> to take effect and it was left un-run because that recreates the database container. This is the
> one outstanding action from this sitting. See [§ Deployment](#deployment).
>
> **The reindex command in the last handoff no longer works.** Both documented invocations now abort
> on this box. The working one is in [§ GitNexus](#gitnexus).

## What closed this sitting

| # | id | sev | outcome |
| --- | --- | --- | --- |
| 1 | AUDIT-D5 | L | **Three of five bullets** (`829a073`). Of the five, one was stale, one inverted, one undercounted, and one had an over-broad prescription. |

Full reasoning is in `archive.md`, "2026-08-06 twelfth sitting — AUDIT-D5, three of five bullets".
Do not re-derive it.

### The short version

`829a073` — Postgres, Valkey and the MinIO console move from `0.0.0.0` to `127.0.0.1`. The compose
`LOG_LEVEL` defaults go `DEBUG` → `INFO` for backend and worker. Both `npm install` calls become
`npm ci`. `bca2d8f` is the separate `chore:` reindex.

### What the entry got wrong

Four things in five bullets. **That takes the running count from fourteen to eighteen.**

**Bullet 5 is stale.** *"No `deploy.resources` limits on any service"* — the worker has had them since
2026-08-01 (`docker-compose.yml:305-312`, 2 CPUs / 4 GiB), and `TODO.md:163`, the very box the bullet
cites as its evidence, is ticked. It is true of db, db-backup, redis, minio and backend, and that is
now what it says.

**Bullet 4's reasoning is inverted, and the fix is unsafe alone.** It asks for `-XX:MaxRAMPercentage`
because *"the JVM defaults to 25% of container RAM, which is both wasteful and prone to OOM-kill"*.
But the backend has **no** memory limit, so there is no container RAM to take 25% of — the JVM takes
25% of the *host*, which on this 19.3 GiB box is already a **~4.8 GiB max heap**. The heap is not
starved. Setting `MaxRAMPercentage=75` with no cap in place raises it to **~14.5 GiB**, strictly
worse than the state the bullet complains about. Bullets 4 and 5 are **one change**, and 4 must never
land alone.

**Bullet 3 undercounted — there is a second `npm install`, at `frontend/Dockerfile:5`.** The bullet
names only `backend/Dockerfile:9-12`, where the tell is loud: a comment praising `npm ci` sits
directly above an `npm install`. The frontend copy has no comment, so **grepping for the tell finds
one and grepping for the shape finds two.** Same lesson as the eleventh sitting's phantom cache key,
in a new disguise: that one hid behind a *recount* scoped to one file, this one hides behind the
absence of the thing that made the first copy findable. That image is genuinely vestigial —
`docker-compose.yml` does not build it, and `ci-npm.yml` lists it as a `paths:` trigger only while
installing with `npm ci` on the runner — but the fix is one word.

**Bullet 1's prescription was over-broad.** *"Drop the port mappings — everything that needs them is
on `manga-net`"* holds for Postgres and Valkey and is **false for MinIO**. 9001 is the console, not
the S3 API; 9000 is not published at all and every in-stack consumer reaches it over `manga-net`. A
browser UI has no in-network consumer, so dropping it removes access rather than relocating it.
**This is a new failure mode for the list: not a wrong finding, a wrong fix.** The diagnosis was
right and the prescription would have broken a working tool.

Loopback closes the exposure the bullet actually names — *"on a multi-user or bridged host that is an
unauthenticated data store on the LAN"* — while psql, MCP clients, `redis-cli`, the console and
`scripts/migrate_thumbnails.py`'s `DB_HOST`/`DB_PORT` override keep working. It is also the pattern
already established on this host: the sibling `yt-diff` stack binds `127.0.0.1:5433` and
`127.0.0.1:6380`. `docs/testing_isolation_guide.md:9-11` documents these ports as host-reachable and
stays accurate under loopback, where a drop would have invalidated it.

### The memory pair

**Deferred by decision, not by omission.** Both remaining bullets were wrong as filed (above), and
neither can be sized from anything this box can measure.

The worker's 4 GiB is defensible only because it came from a **measured** 2.1 GiB peak. There is no
equivalent number for the backend and no cheap way to get one here: **kernel 5.15's cgroup v2 has no
`memory.peak`** — that landed in 6.8 — so there is no high-water mark to read back, and
instantaneous `docker stats` is not a peak. Idle readings are backend 433 MiB, db 69 MiB, valkey
10 MiB, minio 123 MiB. Capping a JVM currently permitted 4.8 GiB on the basis of a 433 MiB idle
reading is how the thumbnail path gets OOM-killed in production.

**What unblocks it:** sample `memory.current` through a thumbnail-heavy run, or run the backend
briefly under a generous cap and watch `memory.events`. Then set the cap and `MaxRAMPercentage`
together, as one variable. This is written into the `issues.md` entry too.

### The bullet with no red-green

**`npm install` → `npm ci`** is a reproducibility change, not a behaviour change — `npm install` also
succeeds, so nothing goes red when it is restored. Said plainly rather than papered over with a test
that passes either way. What *was* verified is the only way the swap can go wrong: `npm ci` aborts
outright on a lockfile out of sync with `package.json`. It exits 0 against a copy of
`frontend/package*.json`, and `docker build --target frontend-build -f backend/Dockerfile .` builds
clean through `npm run build`.

The other two do have a before/after, and both were checked — see `archive.md` § Verification.

### Left alone deliberately

**Valkey still has no `requirepass`.** Loopback removes the LAN reach, not the missing password.
Adding one has to land in the backend's `SPRING_DATA_REDIS_*` and the worker's `REDIS_*` config
simultaneously, and a half-applied Redis password takes the whole pipeline down. Noted in the compose
comment rather than filed, since nothing but this host can now reach it.

**`backend:8080` stays on `0.0.0.0`.** Traefik routes to it and the documented `npm run generate-api`
flow fetches `http://localhost:8080/tlhub/v3/api-docs`.

**`.env.example:37-38` ships the same `INFO`/`DEBUG` split as the live `.env` and was not changed.**
The asymmetry is uncommented but consistent across two files, which reads as a deliberate operational
choice rather than the drift the bullet is about. The bullet says *"in the shipped compose file"*, and
that is what changed.

## Where `issues.md` actually stands

**52 `AUDIT-*` findings have been filed in total. 16 are open. 36 are closed — 69%.**

Of the 16 open, **4 are `AUDIT-S*`**, which are tracked separately and out of scope. So the working
list is **12 entries**, and:

> **Nothing `[C]` or `[H]` remains outside the security track.**

| sev | open | which |
| --- | --- | --- |
| **[C]** | 2 | S1, S2 — *security, separate track* |
| **[H]** | 2 | S3, S4 — *security, separate track* |
| **[M]** | 4 | W3, B5, F1, F2 |
| **[L]** | 5 | W1, W2, F8, F9, D5 *(partial — 2 of 5 bullets)* |
| unranked | 3 | T1, Q1, Q2 |

Two of the `[L]`s are effectively neutralised already: **W2 is falsified** (measured inert twice,
0.0 s then 1.2%; only an unlimited-default hardening survives) and **W1 was re-ranked `[H]` → `[L]`**
when its dispatch half turned out stale. **W3** is half-defused by W10. So the genuinely live
severity on the non-security list is four `[M]`s, of which **B5 is a migration project** and **F1/F2
are frontend projects**.

Separately, `issues.md` still carries **five prose sections** above the audit that are not `AUDIT-*`
entries and are not counted above: the queue-management complaint *(in progress, partial fix)*, the
UI-lag complaint *(partially fixed, both remaining halves measured and not fixable in frontend
code)*, "plan a better backend that doesn't use java" *(a project, gated on B5)*, "do we really need
a separate worker?" *(an open question, never answered)*, and "validate if the testing is really
testing" *(open, and AUDIT-T1 is its concrete instance)*.

## The ranked list

D5's remainder is now **blocked on a measurement**, not on effort, so it is no longer the obvious
pick-up.

| # | id | sev | what | size |
| --- | --- | --- | --- | --- |
| 1 | AUDIT-W2 | L | Make the global `RATE_LIMIT` fallback default to unlimited. | **S** |
| 2 | AUDIT-W1 | L | Delete `QA_DEFAULT_LLM_MODELS` / `QA_DEFAULT_VLM_MODELS` in favour of `providers.json`. | **S** |
| 3 | AUDIT-D5 | L | The memory pair — **blocked**: needs a measured backend peak first. | S once measured |
| 4 | AUDIT-Q1 | — | 249 `Objects.requireNonNull`, up 2 since filing. | L, mechanical |
| 5 | AUDIT-B5 | M | `ddl-auto: update` against a competing `init.sql`. | L — a migration project |
| 6 | AUDIT-T1 | — | The "e2e" test isn't one, and the suite got more mocked. | L — wants `mock_router.md` |
| — | AUDIT-W3 | M | Half-defused by W10: light slots are 4 now, so only the heavy tier still stalls. | M |

**AUDIT-W3 remains the only [M] outside the B5 and F1/F2 projects.**

**If you want one recommendation: take AUDIT-W1 and AUDIT-W2 together.** They are the last two small
entries on the list — both `[L]`, both worker, both in files the eleventh sitting already worked in,
and both are *deletions* rather than additions. W2 is a one-line default change plus its test; W1 is
deleting two hardcoded maps that `providers.json` already supersedes. After those, **everything left
is a project** and the next sitting has to pick one deliberately.

**Do not start AUDIT-B5 casually.** It is a schema-migration project — Flyway or Liquibase, plus
reconciling `init.sql` against whatever `ddl-auto: update` has actually produced live.

**AUDIT-Q1 is the mechanical one.** 249 `Objects.requireNonNull`, concentrated in four classes. Worth
doing as one sweep, not incrementally.

## Where the work stands

**No Java, Python or TypeScript source changed this sitting** — the commit is compose, two
Dockerfiles and two docs. The Maven and worker gates were therefore **not run**, and the counts are
carried forward unverified from the eleventh sitting: backend 414, worker 310, frontend 308.

`docker compose config` parses clean, and `markdownlint-cli2` on the two changed docs reports only
the pre-existing MD012 at `docs/issues.md:491` (it was at `:481` before this sitting's insertion —
not introduced here).

No API surface changed, so `npm run generate-api` was not run. It is still worth a periodic no-change
regen just to see whether the diff is empty — that is how the seventh sitting found drift.

Dependabot is unchanged: four PRs open, all four close-don't-merge. #60 okhttp (the pin is
load-bearing — read the comment in `pom.xml` first) and #52 springdoc are blocked outright; #51
testcontainers-bom 2.x and #40 TypeScript 7 are major-version projects of their own. GitHub still
reports 2 high-severity Dependabot alerts on push; those are AUDIT-S\* territory, tracked separately.

### Deployment

**⚠️ Nothing from this sitting is deployed, and one thing needs to be.**

`docker compose up -d db redis minio` applies the loopback binding. It was left un-run because it
recreates the **database** container, which is not something to do unannounced. Expect the backend's
HikariCP pool to log reconnects while db bounces; it recovers on its own.

Verify after with:

```bash
docker ps --format '{{.Names}}\t{{.Ports}}' | grep manga-
```

`manga-db`, `manga-valkey` and `manga-minio` should read `127.0.0.1:PORT->PORT/tcp`. They currently
read `0.0.0.0:PORT->PORT/tcp`.

**Nothing else needs a rebuild.** The `npm ci` change only affects the next `docker compose build
backend`, and the compose log-level defaults are shadowed by `.env` on this deployment either way —
the live stack stays backend `INFO` / worker `DEBUG` before and after.

### GitNexus

Reindexed at `1290f18` and committed as `bca2d8f` (`chore:`), per the standing rule that the count
rewrite gets its own commit. 5346 → **5367** symbols, 13370 → **13372** relationships, 300 flows
unchanged. **It is stale again** — two commits have landed since, three once this handoff is in.

**Both documented reindex commands now fail on this box.** `node .gitnexus/run.cjs analyze` was
already known to abort; `gitnexus analyze --embeddings --force` on the global install now aborts too,
under Node **v26.1.0**, with *"Analysis aborted in a native worker or native binding path"*. The
tool's own hint is to use Node 22 LTS, and that works — invoke the same CLI entrypoint explicitly,
since the global install lives under the Node 26 prefix:

```bash
~/.nvm/versions/node/v22.14.0/bin/node \
  ~/.nvm/versions/node/v26.1.0/lib/node_modules/gitnexus/dist/cli/index.js \
  analyze --embeddings --force
```

Takes ~190 s. It emits a warning about no VECTOR index (exact-scan fallback) and one parse-job idle
timeout that it recovers from by splitting the job — both are normal, exit code 0.

`detect_changes` on the fix commit was **LOW with 0 affected processes** — the changed files are
compose, Dockerfiles and markdown, none of which carry indexed code symbols, so only markdown
`Section:` nodes were flagged. No `impact()` call was needed: no function, class or method was
edited this sitting.

## Not mine — left alone deliberately

**The free-model benchmarking thread's files are now all committed and tracked**, and `corpus/` is
gone from the tree — the working tree was clean at the start of this sitting. The list below is kept
because **the thread is still active and still commits during a sitting**, so the pathspec discipline
stands regardless:

- `docs/benchmarking.md`, `docs/run_ocr_bench.md`
- `docs/free_openrouter_translation_benchmark_2026-08-06.md`, `docs/translation_bench.md`
- `scripts/benchmark_translation.py`, `scripts/build_translation_corpus.py`, `scripts/test-providers.json`

Every commit used an explicit pathspec. **Keep doing that, and put `-F <file>` before the `--`.**

## Carried forward — deliberately not done

Unchanged from the eleventh sitting except where noted; each was left undone for a stated reason and
those reasons hold.

- **The AUDIT-D5 memory pair.** New this sitting — see above. Blocked on a measured peak, not on
  effort.
- **Valkey has no `requirepass`.** New this sitting — see above. Needs a simultaneous backend and
  worker config change.
- **`SeriesController.resolveSetting`'s untrimmed placeholder compare.** Dormant, not live — every
  *reader* now treats a padded placeholder as inert, so the consequence is only that such a value can
  still be stored.
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
  that never exists is free, and it is legacy cleanup rather than a dispatch path.
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
  deliberately deleted from one breaking**. But **do not dismiss every CRITICAL as an artefact**: the
  eleventh sitting's `isOverride` CRITICAL was real. The artefact is a symbol *below an insertion*; a
  genuinely shared symbol with many callers is not. **`impact()` does not apply to a sitting that
  edits no symbols** — compose, Dockerfile and markdown changes have no indexed symbols, and
  `detect_changes` correctly returns LOW with 0 affected processes.
- **The pre-commit gate is `mvn -o clean verify`, not `test`.** `test` skips PMD and jacoco's rules;
  CI runs `verify` and will fail on things `test` never sees. Use `mvn -o clean test` for red-green
  iteration, `verify` before you commit. **Never trust an incremental Maven run** — always `clean`.
- **Reindexing needs Node 22**, not the default Node 26 — see [§ GitNexus](#gitnexus) for the exact
  invocation. **Running `analyze` rewrites the symbol counts in `CLAUDE.md` and `AGENTS.md`.** Keep
  that out of a feature commit — it gets its own `chore:` commit.
- **Close entries in `issues.md` in the same commit as the fix.** The convention is *remove* from
  `issues.md` and write the reasoning into `archive.md`. A multi-bullet entry can be closed across
  several commits — delete the landed bullets and update the entry's italic header note with the
  running count, then delete the entry with the last one.
- **Verify a fix red-green, and revert defects INDIVIDUALLY.** If a bullet genuinely has no red-green
  — pure duplication removal, a default change, a reproducibility fix — **say so** rather than
  writing a test that passes either way, and verify the thing that *can* break instead.
- **When a bullet gives a count, re-derive the count across the tree, not the file.** Twice now: a
  recount narrowed to the anchor's file, and a bullet found one of two copies because only that copy
  had a comment marking it. **Grep for the shape, never for the tell.**
- **A finding can be right and its prescribed fix still wrong.** AUDIT-D5's ports bullet diagnosed
  the exposure correctly and prescribed dropping mappings that a working tool depends on. **Check the
  prescription against the consumers, not just the diagnosis against the code.**
- **Read the whole `issues.md` entry before calling it closed** — and check the *mechanism*, not just
  whether the line is still there. **Eighteen findings** have now been stale, wrong or incomplete.
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
  `CONCURRENT_JOBS=4`, `MAX_HEAVY_SLOTS=1`, `MAX_LIGHT_SLOTS=3`, `DISABLE_LOCAL_LLM=true`,
  `LOG_LEVEL=INFO`, `LOG_LEVEL_WORKER=DEBUG`. **To see the *shipped* defaults instead, run
  `docker compose --env-file /dev/null config`** — that is how this sitting verified the log-level
  change in both directions.
- The frontend compiles **into** the backend image, so any frontend change needs `docker compose
  build backend && docker compose up -d backend` (~10 min). The worker rebuild is much faster. To
  check just the frontend stage cheaply: `docker build --target frontend-build -f backend/Dockerfile .`
  (~1 min once cached).
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
Continuing manga-library. Read docs/next-step.md first. docs/archive.md has a
"2026-08-06 twelfth sitting" section with what closed and why. Do not re-audit
the codebase and do not re-derive the run numbers — both are written down.

STATE: AUDIT-D5 is THREE-FIFTHS closed (829a073, pushed). The entry is still in
issues.md: the remaining two bullets are the memory pair, deferred on purpose
because they cannot be sized without a measured backend peak and this kernel
(5.15) has no cgroup memory.peak to read. Both were also WRONG as filed and are
rewritten in the entry. issues.md remains trustworthy.

FIRST, TWO THINGS:
1. NOTHING IS DEPLOYED. `docker compose up -d db redis minio` applies the
   loopback port binding. It recreates the db container, so it was left for you.
   Verify with: docker ps --format '{{.Names}}\t{{.Ports}}' | grep manga-
   The three should read 127.0.0.1:PORT->PORT, not 0.0.0.0:PORT->PORT.
2. The GitNexus index is stale (last analysed 1290f18). BOTH documented reindex
   commands now abort on this box — `gitnexus analyze --embeddings --force`
   dies in a native worker path under Node 26. Use Node 22 explicitly:
     ~/.nvm/versions/node/v22.14.0/bin/node \
       ~/.nvm/versions/node/v26.1.0/lib/node_modules/gitnexus/dist/cli/index.js \
       analyze --embeddings --force
   Then commit the CLAUDE.md/AGENTS.md count rewrite as its own chore: commit.

GATE: `mvn -o clean verify`, NOT `mvn -o clean test`. Worker has FOUR gates:
pytest, ruff check, ruff format --check, pyright.

REMOTES: `git fetch --all` hangs on `origin` (pi5 over Tailscale, unreachable).
Use `git fetch github` / `git push github main`.

NOT MINE: the free-model benchmarking thread commits concurrently. Its files are
all tracked now (docs/benchmarking.md, docs/run_ocr_bench.md,
docs/translation_bench.md, docs/free_openrouter_translation_benchmark_2026-08-06.md,
scripts/benchmark_translation.py, scripts/build_translation_corpus.py,
scripts/test-providers.json) but it is still active. Use an explicit pathspec on
every commit, and put -F <msgfile> BEFORE the -- or git reads it as a pathspec.

WHAT I WANT

Work the ranked list in next-step.md, top down — items 1 and 2 are AUDIT-W2 and
AUDIT-W1, the last two small entries on the whole list. Take them together.
After those, everything left is a project, so say which one you want and why
before you start.

Say plainly if a finding turns out stale, wrong or INCOMPLETE when you actually
read the code — that has now paid off eighteen times. This sitting found four in
one five-bullet entry: one stale, one whose reasoning was inverted (the fix as
written would have made it strictly worse), one that named one of two copies,
and one whose diagnosis was right but whose prescribed fix would have broken a
working tool. Check the prescription against the consumers, not just the
diagnosis against the code. And grep for the SHAPE, never for the tell — the
missed npm install copy was missed because only the other one had a comment
above it.

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
  removal, a default change), say so rather than writing a test that passes
  either way — and verify the thing that CAN break instead.
- Read the whole issues.md entry, not the headline.
- Commit to main directly, with a pathspec; worker/ is a submodule and needs its
  own commit plus a pointer bump, pushed before the parent.
- Frontend lint is --max-warnings 0 and CI gates on prettier --check.
- One performance variable per change.
- Security findings (AUDIT-S*) are tracked separately; don't fold them in.
```

<!-- markdownlint-enable MD031 MD040 -->
