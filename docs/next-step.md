# Handoff — 2026-08-06 (fourteenth sitting)

> **The next sitting is AUDIT-B5.** The drain queue is empty, the board is the three tracks, and
> B5 is the gate on the highest-value one. This handoff is written to make B5 startable cold —
> see [§ Start here: B5](#start-here-audit-b5).
>
> **B5 is far smaller than its entry claims.** The entry says "nobody knows what the live schema
> actually is." It was measured this sitting: **the live schema diverges from `init.sql` by exactly
> one column.**
>
> **9 findings open, 43 of 52 closed (83%).** Nothing `[C]` or `[H]` anywhere.
>
> **CI is red for reasons that are not ours** — a GitHub Actions outage. See [§ CI](#ci-is-red-and-it-is-not-the-code).
>
> **Dependabot #60 (okhttp) — close it.** Verified against 5.4.0, not just the changelog. See
> [§ Dependabot](#dependabot).

## Start here: AUDIT-B5

**`ddl-auto: update` against a competing `init.sql`, with no migration history.** It is the
prerequisite for any backend rewrite, because no migration can begin until the schema has a
baseline. It was the "do not start casually" item for two sittings. It is now scoped.

### What was measured this sitting

Read-only, against the live database. **Do not re-derive this.**

| question | answer |
| --- | --- |
| tables in `init.sql` vs live | **22 vs 22 — identical set, no missing or extra tables** |
| column-level drift | **exactly one column**, `images.reader_storage_path` |
| is Flyway/Liquibase on the classpath? | **No.** Zero references in `backend/pom.xml`. |
| does `flyway_schema_history` exist live? | **Yes — and it is empty (0 rows).** |

**`images.reader_storage_path` is the whole divergence.** It is live, it is absent from `init.sql`,
and it is written by `PageService.java:474` (`setReaderStoragePath`). This is `ddl-auto: update`
doing exactly what the finding predicted — adding a column for a feature and never recording it —
caught in the act, once.

### Three things that reframe the work

**1. `init.sql` is a `pg_dump`, not a hand-written schema.** It carries `-- Name: X; Type: TABLE;
Owner: tladmin` headers throughout. So "two competing sources of truth" is really *one snapshot
that has fallen one column behind the entities*. Regenerating it is a dump, not an authoring job.

**2. There is already an empty `flyway_schema_history` table live**, and it came in through that
dump — `init.sql:99` creates it. Nothing in this repo has ever run Flyway. So the schema was
Flyway-managed in some earlier incarnation, the dump carried the bookkeeping table across, and it
has sat empty ever since. **Adopting Flyway means reckoning with a baseline table that already
exists and is empty** — that is a `baselineOnMigrate` decision, and it is better to know now than
to discover it mid-migration.

**3. `init.sql` only ever runs on an empty data directory.** Postgres init scripts are skipped when
the volume already has data, so on this deployment it ran once at first boot and *every* schema
change since has come from `ddl-auto: update`. The file has not been protecting anything for a long
time.

### What `SchemaValidationTest` does and does not do

`backend/src/test/java/com/manga/library/SchemaValidationTest.java` sounds like it guards this. **It
does not.** It runs `@ActiveProfiles("integration")` against Testcontainers, where the schema is
built **from the entities by `ddl-auto`** — so it validates the entities against themselves. It
asserts 8 named tables exist and that every table has a primary key. It would never have caught
`reader_storage_path`, and it will not catch the next one.

**That is the red-green opening.** A test that compares the entity-derived schema against the
checked-in `init.sql` fails today on exactly one column and passes once they are reconciled. That
is a genuine red-green for a migration baseline, which is normally the hardest kind of change to
verify.

### Suggested order

1. **Reconcile the one column.** Regenerate `init.sql` from the live schema, or add
   `reader_storage_path` to it. Confirm 22/22 tables and 0 column drift.
2. **Decide the tool.** Flyway is the lower-friction choice here — the history table already exists
   and Spring Boot autoconfigures it. Liquibase buys database-independence nobody has asked for.
3. **Baseline, do not migrate.** `V1__baseline.sql` = the reconciled dump, applied with
   `baselineOnMigrate: true` so the existing (empty) history table is adopted rather than fought.
4. **Then turn `ddl-auto` down to `validate`** — not `none`. `validate` makes the next drift a
   startup failure instead of a silent `ALTER TABLE`.
5. **Add the entity-vs-`init.sql` test** so step 1 cannot silently regress.

**Do step 4 last and deliberately.** It is the step that can take the deployment down, and it is
also the entire point of the exercise.

### The question B5 has to answer along the way

**"Do we really need a separate worker?"** — open and unanswered since the audit began, and it
changes *what you are migrating*. Answer it before B5 completes, because the schema baseline differs
depending on whether the worker keeps its own view of job state (`jobs`, `queue_job`, `job_costs`).

`AUDIT-B5` also carries a second bullet that is **not** about migrations: `application.yml:17` sets
`open-in-view: true` explicitly rather than inheriting it, holding a DB connection for the whole
request. It is a plausible contributor to the "backend holds the UI back" complaint and **deserves
its own measurement** — do not fold it into the migration change. One variable at a time.

## CI is red, and it is not the code

**GitHub Actions was in a critical-impact outage** — incident opened 2026-08-06 15:22 UTC, still
`investigating` at 17:02 UTC. The push landed at 16:50 UTC, inside the window.

> "Workflow runs are still failing or delayed in starting, and some queued jobs may time out."

| job on `b0b4390` | what actually happened |
| --- | --- |
| Build and push backend image | failed in **"Set up job"** — step 1, before checkout |
| Build and test backend | **cancelled with zero steps executed.** Maven never started. |
| CodeQL java / js / python | cancelled at 15m; the two light ones passed |

**No CI verdict exists to contradict the local gates.** The backend job never reached `mvn`. The
previous commit `365ad99` — the thirteenth sitting's, not this one's — had the same job cancelled at
16:20 UTC, which is the giveaway that this is platform-side.

**It is not rate limiting.** Unauthenticated API budget was 57/60 at the time, and pushes are not
the throttled resource. **Re-run the two failed workflows once the incident clears; change nothing.**

## Dependabot

**#60 okhttp — close it. Verified, not assumed.** The `pom.xml` comment documented 5.3.2 while the PR
has moved to **5.4.0**, so the jars were re-checked rather than trusting the old note:

```text
okhttp     4.12.0 : 317 .class files, 789531 bytes
okhttp      5.4.0 :   0 .class files,    754 bytes   <- what #60 proposes
okhttp-jvm  5.4.0 : 330 .class files                 <- where the classes actually live
```

`okhttp3/MediaType` is present in 4.12.0 and in `okhttp-jvm` 5.4.0, absent from `okhttp` 5.4.0.
The KMP-stub mechanism is unchanged, so merging reproduces the 73 `NoClassDefFoundError` failures.
**The pin is still load-bearing.** The `pom.xml` comment now records the 5.4.0 re-verification and
says to check the jar rather than the changelog on any future 5.x bump.

The real 5.x migration is a one-line swap of `okhttp` → `okhttp-jvm`, gated on minio accepting it.
Small project, not a merge.

The other three are unchanged and still close-don't-merge: #52 springdoc blocked outright, #51
testcontainers-bom 2.x and #40 TypeScript 7 are major-version projects of their own. **GitHub's 2
high-severity Dependabot alerts are the only security items anywhere** and are not covered by any
`AUDIT-*` entry — if they matter, file them properly.

## Where `issues.md` stands

**52 filed. 9 open. 43 closed — 83%.**

| sev | open | which |
| --- | --- | --- |
| **[C]** | 0 | — |
| **[H]** | 0 | — |
| **[M]** | 4 | **B5**, W3, F1, F2 |
| **[L]** | 3 | F8, F9, D5 *(partial — 2 of 5 bullets)* |
| unranked | 2 | T1, Q1 |

**There is no drain queue left.** Every open entry belongs to a track except AUDIT-D5, which is
blocked on a measurement.

## The other two tracks

### Track 1 — The UI is fast and good-looking

| id | sev | what |
| --- | --- | --- |
| AUDIT-F1 | M | Theme rebuilt from scratch on every light/dark toggle → `colorSchemes` + `cssVariables`. Bundle with the next MUI major. |
| AUDIT-F2 | M | `Reader.tsx` at 3,954 lines / 28 `useState`; `ReaderRightSidebar.tsx` with 65 inline `sx`. The profile says **split the component**. |
| AUDIT-F8 | L | No pagination, search or debounce. **Decide the ceiling before building anything.** |
| AUDIT-F9 | L | Responsive behaviour never verified. Wants Playwright, same infrastructure as the ZIP-pixel item. |

**Know the ceiling before starting.** Both remaining halves of "the UI is laggy" are **not fixable in
frontend code**: 71% of LongTask wall time is the main thread *descheduled* (host CPU contention),
and of the reader's 8.80 s of JS self CPU only 0.715 s (8%) is app code. **"Better looking" has far
more headroom than "faster"**, and that is the honest ordering.

### Track 3 — Understand the paid product and close the quality gap

Measured against mangatranslator.ai across 31 examples: **we flatten 6.85% of page artwork on average
against their 1.92%**, losing on every page — worst case `sample24` at 16%, where a whole panel
becomes one tan rectangle. Full comparison in `render_quality_gap_2026-08-05.md`; score any render
with `scripts/render_quality_metrics.py`.

Root cause is three compounding things: **no inpainting anywhere**, erasure is a flat colour fill
over the region polygon, that polygon is the balloon's *outer* contour (so the outline goes with it),
and unconstrained region merging grows those polygons across whole panels.

> **In one line: their unit of erasure is the glyph, ours is the region.** Every upstream mistake
> costs them a few misplaced letters and costs us a panel.

Carried here: the `BUBBLE_CONTOUR_FALLBACK` removal checkpoint (**a bigger YOLO is not the
replacement** — `yolo26s_manga109` recovers 4/180 vs yolo11n's 1/180 and the contour search already
had all four; training distribution, not model size), free-floating text collision handling, and the
VLM benchmarking item.

### AUDIT-D5 — blocked, not deferred

Kernel 5.15's cgroup v2 has no `memory.peak` (added in 6.8), so there is no high-water mark and
instantaneous `docker stats` is not a peak. Sample `memory.current` through a thumbnail-heavy run
first, then set the cap and `MaxRAMPercentage` together as one variable.

## What this sitting did

Five commits: reindex chore, worker fix (submodule), the W2/Q2 parent commit, the worker's own
index chore (submodule), and the index-split chore.

**AUDIT-W1, AUDIT-W2 and AUDIT-Q2 closed.** Reasoning in `archive.md` under "2026-08-06 fourteenth
sitting". **Two more entries were wrong about their own subject, taking the running count of stale,
wrong or incomplete findings from twenty-two to twenty-four:**

- **W2's title** describes "a single global throttle across all providers" that **has never
  existed** — `llm_client.py:208` always passes the provider name, so every cloud call is keyed on
  its own bucket. The one caller that reaches `"global"` is `try_local_ai`, applying a *cloud* rate
  limit to the *local* LLM path. And the fix was in `docker-compose.yml`, not the file the entry
  named.
- **Q2 undercounted itself** — 7 lines across 2 sites, not "two comments" — and
  `PageService.java:669` was *factually wrong* about the code beneath it.

| gate | result |
| --- | --- |
| `mvn -o clean verify` | **414 tests, 0 failures.** PMD and jacoco pass. |
| worker `pytest -q` | **315 passed**, up from the 310 baseline |
| ruff check / format --check / pyright | clean, 0 errors |

**Both baselines are now confirmed rather than carried forward.** Frontend gates not run — no
frontend file changed. `npm run generate-api` not run — no API surface changed.

### The worker now has its own index

**`worker/` is indexed separately as `manga-tl-worker`** (975 symbols, 1825 relationships, 79
execution flows), because the parent's `detect_changes()` is structurally blind to it: it runs
`git diff` in the parent, which sees the submodule as a pointer, and reported `changed_count: 0` for
a commit that rewrote two worker modules and four test files.

- **For worker changes, run `detect_changes({repo: "manga-tl-worker"})`.** Verified: on a one-line
  probe it returns the changed symbol **plus 6 affected execution flows** — flows the parent index
  does not carry at all.
- `worktree: "<path>/worker"` does **not** work; it is rejected as "not a worktree of repo
  manga-library".
- Nothing was lost by splitting: backend and worker talk over HTTP and Redis, not calls, so no call
  edges spanned the boundary.
- **Reindex them separately** — `analyze` from the repo root for `manga-library`, from `worker/` for
  `manga-tl-worker`.

**The parent count went *down*, 5377 → 5265, and that is mostly not deletions.** The parser exhausted
its cumulative timeout budget on `backend/src/main/c/jni/jni.h` and respawned with that file
excluded, so this index is missing that header's declarations. It is a vendored JNI header nothing
runs `impact()` on, so practical coverage is unchanged — but do not read 5265 as "the codebase shrank
by 112 symbols".

### Deployment

**Nothing needs deploying.** The worker and compose changes land with the next `docker compose
build`.

**One live-config line was deliberately not touched.** `.env` (gitignored) carries `RATE_LIMIT=10` at
line 84, so the new unlimited compose default does not change *this* box until it is removed:

```text
docker compose --env-file /dev/null config  →  RATE_LIMIT: ""     # shipped default, now unlimited
docker compose config                       →  RATE_LIMIT: "10"   # this box, still pinned
```

**Inert either way**: `DISABLE_LOCAL_LLM=true`, so `try_local_ai` — the only caller reaching the
`"global"` bucket — is not running.

## Not mine — left alone deliberately

The free-model benchmarking thread is **still active and still commits during a sitting**:

- `docs/benchmarking.md`, `docs/run_ocr_bench.md`
- `docs/free_openrouter_translation_benchmark_2026-08-06.md`, `docs/translation_bench.md`
- `scripts/benchmark_translation.py`, `scripts/build_translation_corpus.py`, `scripts/test-providers.json`

**Use an explicit pathspec on every commit, and put `-F <file>` before the `--`.**

## Carried forward — deliberately not done

- **The AUDIT-D5 memory pair.** Blocked on a measured peak.
- **`try_local_ai`'s bare `enforce_rate_limit()`.** The local path has no remote limit to respect,
  but the call belongs to AUDIT-W3 and the unlimited default already makes it inert by default.
- **`RATE_LIMIT=10` in the untracked `.env`.** See Deployment.
- **Valkey has no `requirepass`.** Loopback removed the LAN reach, not the missing password. It has
  to land in the backend's `SPRING_DATA_REDIS_*` and the worker's `REDIS_*` simultaneously; a
  half-applied Redis password takes the whole pipeline down.
- **`SeriesController.resolveSetting`'s untrimmed placeholder compare.** Dormant — every *reader*
  treats a padded placeholder as inert, so such a value can only be stored, not acted on.
- **`updateJobStatus` has no state-machine validation**, only vocabulary validation. A transition
  guard has to tell a stale worker's late callback from a live one, and the `Job` row carries nothing
  to do it with. **B5 has to decide this explicitly** — it is exactly what a rewrite would re-derive
  badly, and it touches the `jobs` table the baseline will freeze.
- **The cross-provider fallback rule has not reached `ocr.py` and `qa.py`.** AUDIT-W11 established it
  for translation; the failure was only ever measured there.
- **The exported ZIP's pixel content is unverified.** jsdom has no canvas. Needs a real browser.
- **The `neurometric` key in `secrets/api_keys.json` is still dead.** A chapter pinned to it escapes
  to the global provider.
- **A scan for other `@Transactional` self-invocations has not been done.** AUDIT-B2 was the known
  instance; the class of bug is invisible at the call site and this codebase has hit an
  annotation-binding failure three times.
- **`NotificationController.currentUser` throws `RuntimeException("Unauthorized")`** — a 500, not a
  401/403.
- **`Reader.tsx` guards on `.delete-page-btn` and `.reorder-controls`** in its canvas-pan handlers.
  Provably dead since `b951ee2`. Left because that file is Track 1's.
- **`PageService`'s "variant not smaller" branch is uncovered.** Needs a contrived incompressible
  fixture.
- **`JobController` still lists `queue:region-redo` in its queue-clear `delete`.** Legacy cleanup.

## Out of scope unless deliberately reopened

- **The worker pull model.** Measured at 408 s of 49,058 s of queue wait (0.83%). Build it for
  latency, resilience and multi-worker scaling — never for throughput.
- **A reader downscale cap.** A 3000 px long-edge cap hits 124 images and saves a further 46 MB.
  Real but secondary, and a second performance variable.
- **AUDIT-W5**, and re-deriving the queue-wait share. Both settled; see `archive.md`.

## Working constraints

- **`CLAUDE.md` is binding.** `impact({target, direction:"upstream", repo:"manga-library"})` before
  editing any symbol, report HIGH/CRITICAL, `detect_changes()` before committing. **`detect_changes`
  attributes by line offset**, so a large insertion flags untouched symbols below it — check `git
  diff -U0` hunk ranges before believing the blast radius. It **cannot distinguish a flow being
  deliberately deleted from one breaking**, and **it cannot see inside `worker/`** — use
  `repo: "manga-tl-worker"` there. Do not dismiss every CRITICAL as an artefact: the eleventh
  sitting's `isOverride` CRITICAL was real. **`impact()` does not apply to a sitting that edits no
  symbols.**
- **No section of `issues.md` is exempt from triage.** If an entry is out of scope for the *work*, it
  is still in scope for *being true*.
- **A finding's title can be wrong about the mechanism while its body is right about the code.**
  AUDIT-W2 described a throttle that never existed and missed the real one. **Read what the callers
  pass, not what the function could do.**
- **An entry's difficulty estimate is also a claim, and can also be wrong.** B5 said nobody knows the
  live schema; it is one column. **Measure the scope before believing the scare.**
- **The pre-commit gate is `mvn -o clean verify`, not `test`.** `test` skips PMD and jacoco's rules.
  Use `mvn -o clean test` for red-green iteration, `verify` before you commit. **Never trust an
  incremental Maven run** — always `clean`.
- **Watch the shell's working directory.** It persists between calls, and it bit this sitting: a
  `grep CLAUDE.md` after an unrelated `cd worker` read the wrong file. **Use absolute paths for
  anything whose result you intend to trust**, and `pwd` when in doubt.
- **Verify a fix red-green.** If a change genuinely has none — a default change, a comment deletion —
  **say so** rather than writing a test that passes either way, and verify the thing that *can*
  break. **The reliable technique is mutation**: write the test, break the code it protects, confirm
  it reds. Used twice this sitting.
- **When a bullet gives a count or a line anchor, re-derive it across the tree, not the file.** Four
  times now. **Grep for the shape, never for the tell.**
- **A finding can be right and its prescribed fix still wrong.** Check the prescription against the
  consumers, not just the diagnosis against the code.
- **Read the whole `issues.md` entry before calling it closed** — and check the *mechanism*, not just
  whether the line is still there. **Twenty-four findings** have been stale, wrong or incomplete.
- **One performance variable per change.**
- **Commit straight to `main`** — no feature branches. **Use a pathspec** (`git commit -F <msgfile> --
  <paths>`): there is active concurrent work that commits *during* your sitting. **`-F` goes before
  the `--`**, or git reads it as a pathspec.
- **`git fetch --all` hangs** on `origin` (a pi5 over Tailscale, unreachable). Use `git fetch github`
  / `git push github main`. The worker submodule's `origin` is a different, working GitHub remote, so
  a plain `git push origin main` is correct *there*.
- **Never run `prettier --write` outside a commit whose purpose is formatting.** `ci-npm.yml` gates on
  `format:check`; verify with `git diff -w`.
- **Frontend lint is `--report-unused-disable-directives --max-warnings 0`.** A warning fails the build.
- **Worker gates are four:** `pytest -q`, `ruff check .`, `ruff format --check .`, `pyright .`. Run
  `ruff check --fix . && ruff format .` before the final pytest, not after. **markdownlint does not
  gate the worker** — its CI is ruff/ruff/pyright/pytest only.
- **Pyright rejects `from tenacity import retry_if_exception_type`** as a private import. Follow
  `llm_client.py`: `from tenacity.retry import ...`, `.stop`, `.wait`.
- **Worker source lives at `worker/src/worker/`**, not `worker/`. `issues.md` anchors are relative to
  the package, so resolve them under `src/worker/`. `worker/app.py` is the one file genuinely at the
  submodule root.
- **The worker test fixture is `worker/tests/test_providers.json`**, forced by `conftest.py` via
  `PROVIDERS_CONFIG`. It is **not** `config/providers.json` and is much thinner — check the fixture
  carries a key before assuming behaviour is broken.
- **`@MockitoSpyBean` works on Spring Data repositories** here (spring-test 6.2). It is how
  `JobCoordinatorServiceTest` counts `pageRepository.findById` calls; the spy delegates. Use
  `mockingDetails(...).getInvocations()` for a count.
- **Secrets resolve through three layers.** `DockerSecretsEnvironmentPostProcessor` maps **any** env
  var ending in `_FILE` to the stripped key, `application-local.yml` holds dev values,
  `application-test.yml` holds test values. `application.yml` carries **no** credential fallbacks —
  keep it that way. `SecretsStartupValidator` refuses startup on unset, too-short or known-public
  `jwt.secret` / `internal.api-token`. **There are two test profiles**, `test` and `integration`;
  enumerate with
  `find src -name "application*.yml" && grep -rho '@ActiveProfiles("[^"]*")' src/test/java | sort -u`.
- **`.env` is gitignored and overrides `docker-compose.yml` defaults.** Currently `CONCURRENT_JOBS=4`,
  `MAX_HEAVY_SLOTS=1`, `MAX_LIGHT_SLOTS=3`, `DISABLE_LOCAL_LLM=true`, `LOG_LEVEL=INFO`,
  `LOG_LEVEL_WORKER=DEBUG`, `RATE_LIMIT=10`. **For the *shipped* defaults run `docker compose
  --env-file /dev/null config`.**
- The frontend compiles **into** the backend image, so any frontend change needs `docker compose build
  backend && docker compose up -d backend` (~10 min). Cheap frontend-only check:
  `docker build --target frontend-build -f backend/Dockerfile .` (~1 min cached).
- Backend API changes require `npm run generate-api` from `frontend/` with the backend container up.
- Backend build is Maven (no wrapper) **and must be run from `backend/`**. Frontend is `npx vitest run`
  / `npx tsc --noEmit` / `npm run lint` / `npm run format:check`.
- **`worker/` is a git submodule.** Changes need their own commit plus a pointer bump. `git add worker`
  stages the pointer. **Push the submodule first.**
- **The local `.venv` is Python 3.13.12 / numpy 2.3.5** and matches the image. It is at the parent repo
  root, not in `worker/`; run the suite as `cd worker && ../.venv/bin/python -m pytest -q`.
- **Testcontainers works.** If the backend suite goes red across many classes at once, read the
  surefire report's `Caused by` chain before blaming the environment.
- **The `postgres` MCP tools query the live database directly** and are how B5's drift was measured.
  Read-only queries against `information_schema` are cheap and need no container juggling.
- **MinIO objects are readable straight off disk** — no container, no port 9000. Single-drive MinIO
  prefixes a 32-byte bitrot checksum to each 1 MiB block; strip those and the bytes come back verbatim.
  Handle three layouts: single-part, multi-part (`part.1..N`, numeric order), and small objects inlined
  into `xl.meta` as a trailing msgpack `bin32`. Verified against all 743 ETags.
- **Never upload Firefox profiles** — they carry series names and URLs.
- **`sx` is not a free swap for `style`:** per-frame values mint an emotion class per value, and `sx`
  loses the cascade to a plain CSS class on a specificity tie. Scope to `&.the-class` when overriding.

## Prompt for the next chat

<!-- markdownlint-disable MD031 MD040 -->

```
Continuing manga-library. Read docs/next-step.md first — it is written to make
this sitting startable cold. docs/archive.md has a "2026-08-06 fourteenth
sitting" section. Do not re-audit the codebase and do not re-derive the run
numbers or the schema measurements — all three are written down.

THIS SITTING IS AUDIT-B5, the schema baseline. It is the gate on Track 2 and the
highest-value thing on the board: no migration can begin until the schema has a
baseline.

B5 IS MUCH SMALLER THAN ITS ENTRY CLAIMS. The entry says "nobody knows what the
live schema actually is." It was measured against the live DB last sitting:
  - 22 tables in init.sql, 22 live — identical set.
  - Column drift is EXACTLY ONE COLUMN: images.reader_storage_path, live but
    absent from init.sql, written by PageService.java:474.
  - No Flyway/Liquibase in backend/pom.xml.
  - BUT an empty flyway_schema_history table already exists live — it came in
    via init.sql:99, which is a pg_dump of a previously Flyway-managed DB.
  - init.sql only runs on an empty data dir, so every change since first boot
    came from ddl-auto: update.

SchemaValidationTest does NOT guard this — it builds the schema from the
entities via ddl-auto against Testcontainers, so it validates entities against
themselves. A test comparing entity-derived schema to init.sql fails today on
one column and passes once reconciled: that is your red-green.

Suggested order in the handoff: reconcile the one column, pick Flyway,
baseline with baselineOnMigrate against the existing empty history table, THEN
turn ddl-auto down to `validate` (not none) LAST and deliberately — that is the
step that can take the deployment down.

B5 also has to ANSWER "do we really need a separate worker?", open since the
audit began, because the baseline differs depending on whether the worker keeps
its own view of job state (jobs, queue_job, job_costs). And B5's second bullet,
open-in-view: true, is NOT a migration item — measure it separately.

STATE: 43 of 52 findings closed, 9 open. Nothing [C] or [H]. The drain queue is
empty; the board is the three tracks plus AUDIT-D5 (blocked on a measured memory
peak — kernel 5.15 has no memory.peak).

CI: GitHub Actions had a critical outage on 2026-08-06; the backend job was
cancelled with ZERO steps executed, so there is no CI verdict contradicting the
local gates. Re-run the failed workflows, change nothing.

DEPENDABOT #60 (okhttp): CLOSE IT. Re-verified against 5.4.0 — the jar is 754
bytes with 0 .class files; okhttp-jvm 5.4.0 has 330. The pom comment records it.

GITNEXUS: TWO indexes now. manga-library (parent) and manga-tl-worker (the
submodule). detect_changes() on the parent CANNOT see inside worker/ — use
detect_changes({repo: "manga-tl-worker"}) there. Reindex each from its own root.
If reindexing, both documented commands abort on this box; use Node 22:
  ~/.nvm/versions/node/v22.14.0/bin/node \
    ~/.nvm/versions/node/v26.1.0/lib/node_modules/gitnexus/dist/cli/index.js \
    analyze --embeddings --force

GATE: `mvn -o clean verify`, NOT `mvn -o clean test`. Worker has FOUR gates:
pytest, ruff check, ruff format --check, pyright. Baselines are CONFIRMED:
backend 414, worker 315. Watch the shell's working directory — it persists
between calls and it bit the last sitting; use absolute paths.

REMOTES: `git fetch --all` hangs on `origin` (pi5 over Tailscale, unreachable).
Use `git fetch github` / `git push github main`.

NOT MINE: the free-model benchmarking thread commits concurrently. Use an
explicit pathspec on every commit, and put -F <msgfile> BEFORE the -- or git
reads it as a pathspec.

Say plainly if a finding turns out stale, wrong or INCOMPLETE — that has now
paid off TWENTY-FOUR times. B5 itself is the newest variant: not stale, but its
DIFFICULTY was overstated, and nobody had measured it in four sittings of
calling it "a project, not a sitting". Measure the scope before believing the
scare.

CONSTRAINTS
- CLAUDE.md is binding: impact() before edits, detect_changes() before commits.
  impact() does not apply to a sitting that edits no symbols.
- Close the issues.md entry in the SAME commit as the fix: remove it from
  issues.md, write the reasoning into archive.md.
- Verify red-green. If a change genuinely has no red-green, say so and verify
  the thing that CAN break instead — mutate the code and confirm the test reds.
- Read the whole issues.md entry, not the headline.
- Commit to main directly, with a pathspec; worker/ is a submodule and needs its
  own commit plus a pointer bump, pushed before the parent.
- One variable per change — especially in B5: reconcile, baseline, and flip
  ddl-auto are three separate commits.
```

<!-- markdownlint-enable MD031 MD040 -->
