# Handoff — 2026-08-07 (fifteenth sitting)

> **AUDIT-B5 is closed, deployed, and validated against a real boot.** `ddl-auto: validate`
> started clean against the live database — see [§ Deployment
> validation](#deployment-validation-run-4-no-flyawaylog) for the log evidence, not just the
> reasoning.
>
> **No migration framework was adopted.** The user rejected Flyway mid-sitting: fresh installs
> must keep working out of the box from `database/init.sql` alone, schema changes are made by hand
> from here on. A full Flyway build existed and was discarded — see
> [archive.md](./archive.md#the-2026-08-07-fifteenth-sitting--audit-b5-the-schema-baseline) if
> that decision is ever revisited.
>
> **44 of 53 findings closed (83%). 9 open, nothing `[C]` or `[H]`.** One new finding
> (`AUDIT-B9`) was filed this sitting, spun off from B5's own second bullet. See [§ Where issues.md
> stands](#where-issuesmd-stands).
>
> **Pushed to `github/main` for the first time in three sittings** (`5f7f0f6..cf118de`) — CI has
> not been checked yet. See [§ CI](#ci-not-yet-checked).

## Deployment validation (`run-4-no-flyaway.log`)

The user deployed and supplied `logs/run-4-no-flyaway.log` (2395 lines, `docker compose up`
through steady-state health checks). Read in full, not sampled:

| check | result |
| --- | --- |
| `ERROR` lines anywhere in the log | **zero** |
| `EntityManagerFactory` init (where `ddl-auto: validate` would throw) | `19:14:11.669Z ... Initialized JPA EntityManagerFactory for persistence unit 'default'` — no `SchemaManagementException` |
| App startup | `Started MangaLibraryApplication in 20.897 seconds` |
| `images.reader_storage_path` exercised for real | `PageService` wrote it twice — `Generated reader variant reader/cdea1b43....webp` (19:15:12) and `reader/27b7f568....webp` (19:17:17) — a live `imageRepository.save()` against the exact column this sitting reconciled |
| Worker | started, processed at least one real job (`5084f907`), health checks green through the end of the log |

This is stronger evidence than the sitting's own reasoning chain (live-db == init.sql == init-test.sql
== entities) — it is the live database itself, under `validate`, accepting a write to the
previously-drifted column. **`AUDIT-B5` is not just closed in `issues.md`, it is deployed and
confirmed.**

## Where `issues.md` stands

**53 filed. 9 open. 44 closed — 83%.**

| sev | open | which |
| --- | --- | --- |
| **[C]** | 0 | — |
| **[H]** | 0 | — |
| **[M]** | 4 | W3, **B9** *(new)*, F1, F2 |
| **[L]** | 3 | F8, F9, D5 *(partial — 2 of 5 bullets)* |
| unranked | 2 | T1, Q1 |

`AUDIT-B5` closed. `AUDIT-B9` is new, spun off from B5's own `open-in-view` bullet — see below.

### AUDIT-B9 **[M]** — `open-in-view: true`, measured not fixed

Filed this sitting (`docs/issues.md`). Every entity in the codebase `@JsonIgnore`s its lazy
`@ManyToOne` relations except one: `LayerEditHistory.layerElement` and `.editedBy` (`:14-17`,
`:27-29`). `LayerController.getLayerElementHistory` (`:141`) returns `List<LayerEditHistory>`
directly, no `@Transactional`, no DTO. Disabling `open-in-view` today would turn every call to that
one endpoint into a `LazyInitializationException`. Small fix (either `@JsonIgnore` both fields, or
DTO-ify the endpoint), and it's the one thing standing between "measured" and "can actually flip
the flag and remeasure the backend-holds-the-UI-back claim." **Reasonable next-sitting candidate**
precisely because it's small and self-contained — see the prompt at the bottom.

### A twenty-fifth stale/wrong/incomplete finding

`AUDIT-B5`'s own claim about `SchemaValidationTest` was wrong about the mechanism.
`application-integration.yml` already sets `ddl-auto: validate`, not `update` — the test never
built its schema from the entities, it validated entities against a *second* hand-maintained file
(`init-test.sql`) that happened to already carry `reader_storage_path`. The practical conclusion
("it wouldn't have caught this") was still right, for the wrong reason. Full writeup in
`archive.md`.

### The worker question, answered for B5's slice of it

`docs/issues.md`'s open "Do we really need a separate worker?" section now carries a
2026-08-07 update: the worker has zero Postgres coupling (no `POSTGRES_*`/`SPRING_DATASOURCE_*` env
vars, no DB client dependency anywhere in `worker/`), so the schema baseline never had a second
schema to reconcile regardless of that answer. The bigger "should the split exist at all" question
is untouched and still open.

### Five confirmed-dead tables (not filed, not fixed, recorded)

`queue_job`, `search_index`, `translations`, `translation_regions`, `volumes` — 0 rows live, 0
`@Entity` mappings, 0 code references anywhere in `backend/`, `worker/` or `scripts/`. Pure
pg_dump carry-over from superseded designs. Not filed as its own `AUDIT-*` because this paragraph
(and the fuller one in `archive.md`) already is the actionable form of the finding — baselining
what exists is not cleanup, and dropping tables is a separate, narrower-schema change with its own
blast radius.

## CI: not yet checked

This sitting pushed to `github/main` for the first time since the thirteenth sitting
(`5f7f0f6..cf118de`, 3 commits). The prior two sittings' commits sat local-only. **No CI verdict
exists yet for this push** — check `gh run list` (unavailable in this environment; the two prior
sittings' outage-diagnosis pattern still applies if it's red: check whether the failure is platform
or these changes before assuming the latter). GitHub's 2 high-severity Dependabot alerts remain
present at push time, unrelated to this sitting's changes (confirmed absent from any `AUDIT-*`
scope, per the fourteenth sitting's note).

## The three tracks

Unchanged in shape from the fourteenth sitting's framing, except **Track 2's gate (`AUDIT-B5`) is
now clear** — there is no more "no migration can begin until the schema has a baseline" blocker.
That does **not** mean a Java-to-something-else rewrite is scheduled: `issues.md`'s "Plan a better
backend one that doesn't use java" is still an unscoped complaint, not a plan, and nothing this
sitting did picks a direction for it. Don't read the cleared gate as a mandate to start that
migration — it just means the prerequisite work (know the schema, know how it's owned, know the
worker's coupling to it) is now actually done if someone decides to.

### Track 1 — The UI is fast and good-looking

Unchanged: `AUDIT-F1` (theme rebuild on toggle), `AUDIT-F2` (`Reader.tsx` / `ReaderRightSidebar.tsx`
size and inline `sx`), `AUDIT-F8` (no pagination/search/debounce — decide the ceiling first),
`AUDIT-F9` (responsive behaviour unverified). Same headroom note as before: 71% of LongTask wall
time is host CPU contention, not app code — "better looking" has more headroom than "faster."

### Track 2 — Plan a better backend (gate cleared, direction still undecided)

What's now known and doesn't need re-deriving: 22 live tables (17 in active use, 5 confirmed dead),
schema ownership is 100% the backend's (worker has zero DB coupling), `open-in-view` has exactly
one unsafe endpoint (`AUDIT-B9`), and `updateJobStatus` still has no state-machine validation
against the `jobs` table (carried forward below — a rewrite would re-derive this badly if it isn't
decided explicitly first).

### Track 3 — Understand the paid product and close the quality gap

Unchanged: the 6.85% vs 1.92% flattening gap, `BUBBLE_CONTOUR_FALLBACK` removal checkpoint, the VLM
benchmarking item. See the fourteenth sitting's handoff (preserved in this file's git history) for
the full writeup if picking this up.

### AUDIT-D5 — still blocked

Kernel 5.15 has no `memory.peak`. Unchanged; needs a sampled `memory.current` run through a
thumbnail-heavy load before it can move.

## What this sitting did

Three commits, one variable each, matching the handoff's ask exactly (reconcile / adopt-a-tool /
flip-ddl-auto), except step 2 became "adopt no tool" after the user's mid-sitting redirect:

1. `ad113a9` — reconciled `database/init.sql` (added `images.reader_storage_path`), added
   `InitScriptReconciliationTest` (diffs `database/init.sql` against `init-test.sql` in a
   throwaway Postgres; red-green verified by reverting and rerunning).
2. `fc987c4` — `ddl-auto: update` → `validate`; closed `AUDIT-B5` in `issues.md`; filed `AUDIT-B9`;
   updated the worker-question section; wrote the reasoning into `archive.md`. Verified the
   `validate` mechanism itself by mutating `Image.java`'s `@Column` name and confirming
   `SchemaValidationTest` fails to boot with `SchemaManagementException`; reverted.
3. `cf118de` — GitNexus reindex chore (5265 → 5414 symbols, 13261 → 13437 relationships, still 300
   flows).

A full Flyway adoption (dependency, `V1__baseline.sql`, `baselineOnMigrate`, a
`FlywayBaselineTest` proving it applies cleanly to an empty Postgres, an `application-test.yml`
exclusion for the H2 profile) was built, verified working, then entirely reverted per the user's
redirect. Nothing of it shipped; `git diff HEAD~3 -- backend/pom.xml
backend/src/test/resources/application-test.yml` is empty. Full detail in `archive.md` under "the
Flyway detour" in case the decision is revisited later.

| gate | result |
| --- | --- |
| `mvn -o clean verify` | **415 tests, 0 failures** (414 baseline + `InitScriptReconciliationTest`) |
| `detect_changes()` | `risk_level: low` on both code commits |
| Live deployment | **validated against `logs/run-4-no-flyaway.log`** — see above |

Worker not touched — no reindex, no gate run there. Frontend not touched.

## GitNexus

`manga-library` reindexed at `cf118de`: **5414 symbols, 13437 relationships, 300 execution flows.**
(The post-reindex commit itself always leaves the index one commit stale by construction — that's
expected, not a problem to chase.) `manga-tl-worker` untouched this sitting, still indexed at its
last recorded point since no `worker/` file changed.

## Not mine — left alone deliberately

Same as last sitting — the free-model benchmarking thread (`docs/benchmarking.md`,
`docs/run_ocr_bench.md`, `docs/free_openrouter_translation_benchmark_2026-08-06.md`,
`docs/translation_bench.md`, `scripts/benchmark_translation.py`,
`scripts/build_translation_corpus.py`, `scripts/test-providers.json`) commits concurrently. Use an
explicit pathspec on every commit, `-F <file>` before the `--`.

**One thing this sitting discovered about "not mine":** `origin` (the pi5 remote) had a commit
(`3896bc3`) `github` didn't, from that thread. It never blocked anything here — `github/main` was a
clean fast-forward behind all three of this sitting's commits — but if a future sitting needs
`origin` for something, check `git log origin/main..github/main` and vice versa before assuming
the two remotes agree.

## Carried forward — deliberately not done

- **The `AUDIT-D5` memory pair.** Blocked on a measured peak.
- **`AUDIT-B9`.** Measured, not fixed — see above. Reasonable small next sitting.
- **Five confirmed-dead tables.** Not cleaned up — baselining isn't cleanup.
- **`updateJobStatus` has no state-machine validation**, only vocabulary validation. Still
  unaddressed; still exactly what a rewrite would re-derive badly, and it touches the `jobs` table
  the (informal, hand-maintained) baseline now tracks.
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

## Working constraints

- **`CLAUDE.md` is binding.** `impact()` before editing any symbol, `detect_changes()` before
  committing — **including config-only commits**; `application.yml` isn't indexed as symbols so
  `detect_changes()` reports 0 changed symbols for a pure-YAML change, but the tool still needs to
  run so an unexpected code change riding alongside isn't missed. `impact()` does not apply to a
  sitting that edits no symbols.
- **A user correction mid-sitting overrides the handoff that started it.** This sitting's own
  handoff prescribed Flyway in detail; the user rejected it after most of that work was already
  built and verified. Revert cleanly (`git diff HEAD~N` against the untouched files to confirm),
  don't half-keep pieces of the discarded approach, and say plainly what was undone rather than
  quietly dropping it from the record — see "the Flyway detour" in `archive.md`.
- **Deployment logs are a stronger red-green than reasoning chains, when available.** The sitting's
  own transitive proof (live-db == init.sql == init-test.sql == entities) was solid, but the actual
  `logs/run-4-no-flyaway.log` — a clean boot under `ddl-auto: validate` plus a real write to the
  reconciled column — is direct evidence, not inference. Ask for the log rather than trusting the
  chain alone when a live deployment is available to check against.
- **Two git remotes, `origin` and `github`, can diverge without warning.** `origin` (the pi5 over
  Tailscale) is usually unreachable (`git fetch --all` hangs) but was not, this time, and carried a
  commit `github` didn't. Diff `origin/main..github/main` before assuming `git status -sb`'s
  "ahead N" against whichever remote is tracked tells the whole story.
- **The pre-commit gate is `mvn -o clean verify`, not `test`.** `test` skips PMD and jacoco.
- **Watch the shell's working directory.** It persists between calls in the *foreground*, but a
  `run_in_background` command's `cd` does **not** carry back to the main session — confirmed this
  sitting when a background `mvn` run's directory change had no effect on the next foreground
  command. Use absolute paths or an explicit `cd` in every command you intend to trust.
- **Verify a fix red-green; when there is none, verify the mechanism instead.** Two cases this
  sitting: `InitScriptReconciliationTest` has a direct red-green (revert the reconciliation, it
  fails). The `ddl-auto` flip has no test-suite red-green at all (no profile exercises the base
  `application.yml` value) — mutated `Image.java`'s `@Column` name and confirmed
  `SchemaValidationTest` fails to boot, proving `validate` catches drift in this exact
  configuration, then reverted the mutation.
- **Say plainly if a finding turns out stale, wrong or incomplete** — twenty-five times now.
  `AUDIT-B5`'s own claim about `SchemaValidationTest`'s mechanism was the twenty-fifth: the
  practical conclusion held, the reasoning was wrong.
- **Commit straight to `main`, no feature branches, always a pathspec.** `-F <msgfile>` goes
  *before* the `--`. The free-model benchmarking thread still commits concurrently.
- **`git fetch --all` hangs on `origin`.** Use `git fetch github` / `git push github main`. Worker
  submodule's `origin` is a separate, working remote — `git push origin main` is correct *there*.
- **Worker source lives at `worker/src/worker/`**, not `worker/`. Fixture is
  `worker/tests/test_providers.json`, forced by `conftest.py`.
- **`worker/` is a git submodule.** Its own commit plus a pointer bump; push the submodule first.
- **The `postgres` MCP tools query the live database directly.** Cheap, read-only, and how both
  this sitting's and last sitting's schema measurements were made.
- **GitNexus: two indexes.** `manga-library` (parent) and `manga-tl-worker` (submodule).
  `detect_changes()` on the parent cannot see inside `worker/` — use `repo: "manga-tl-worker"`
  there. If reindexing, both documented commands abort on this box; use Node 22:
  `~/.nvm/versions/node/v22.14.0/bin/node ~/.nvm/versions/node/v26.1.0/lib/node_modules/gitnexus/dist/cli/index.js analyze --embeddings --force`

## Prompt for the next chat

<!-- markdownlint-disable MD031 MD040 -->

```
Continuing manga-library. Read docs/next-step.md first — it is written to make
this sitting startable cold. docs/archive.md has a "2026-08-07 fifteenth
sitting" section. Do not re-audit the codebase and do not re-derive the schema
measurements, the deployment validation, or the run numbers — all are written
down.

AUDIT-B5 IS CLOSED AND DEPLOYED. The schema baseline exists: 22 live tables (17
active, 5 confirmed dead with zero code references), ddl-auto is validate (not
update), database/init.sql is reconciled and guarded by
InitScriptReconciliationTest. Validated against a real deployment log
(logs/run-4-no-flyaway.log): clean boot under validate, plus a real write to
the reconciled images.reader_storage_path column. NO MIGRATION FRAMEWORK WAS
ADOPTED — the user explicitly rejected Flyway; schema changes are made by hand
from here on. Do not reopen that decision without asking.

SUGGESTED NEXT SITTING: AUDIT-B9, small and self-contained. open-in-view:
true is currently load-bearing for exactly one endpoint —
LayerController.getLayerElementHistory returns List<LayerEditHistory> whose
layerElement/editedBy lazy relations aren't @JsonIgnore'd, unlike every other
entity in the codebase. Fix it (add @JsonIgnore to both fields, matching the
codebase's existing pattern, OR convert the endpoint to a DTO), then it's
possible to actually flip open-in-view off and re-measure whether it's really
contributing to "backend holds the UI back" — that second half is a distinct,
larger measurement, don't fold it into the B9 fix itself. Board otherwise
unchanged: Track 1 (F1, F2, F8, F9), Track 3 (quality gap), AUDIT-D5 (blocked
on a measured memory peak), AUDIT-W3 (worker concurrency, larger effort),
AUDIT-T1/Q1 (unranked).

STATE: 53 filed, 44 closed, 9 open (83%). Nothing [C] or [H].

CI: this sitting pushed to github/main for the first time in three sittings
(5f7f0f6..cf118de). NOT YET CHECKED — gh CLI was unavailable in the sitting
that pushed it. Check it before assuming green.

GITNEXUS: manga-library reindexed at cf118de (5414 symbols, 13437
relationships, 300 flows). manga-tl-worker untouched, still at its prior
index point. Two separate indexes — detect_changes() on the parent cannot see
inside worker/, use repo: "manga-tl-worker" there. Reindex command (both
documented ones abort on this box):
  ~/.nvm/versions/node/v22.14.0/bin/node \
    ~/.nvm/versions/node/v26.1.0/lib/node_modules/gitnexus/dist/cli/index.js \
    analyze --embeddings --force

GATE: mvn -o clean verify (not test) — currently 415 passing. Worker gates
(pytest, ruff check, ruff format --check, pyright) untouched this sitting,
still at the 315-test baseline. A backgrounded command's `cd` does NOT persist
to the next foreground command in this environment — use absolute paths.

REMOTES: git fetch --all hangs on origin (pi5, usually unreachable, but
carried an unrelated commit this sitting that github didn't — diff
origin/main..github/main before trusting one remote's view). Use git fetch
github / git push github main for the parent; the worker submodule's origin is
a separate, working remote.

NOT MINE: the free-model benchmarking thread commits concurrently. Explicit
pathspec on every commit, -F <msgfile> BEFORE the --.

Say plainly if a finding turns out stale, wrong or incomplete — twenty-five
times now, most recently AUDIT-B5's own claim about how SchemaValidationTest
worked (right conclusion, wrong mechanism).

CONSTRAINTS
- CLAUDE.md is binding: impact() before edits, detect_changes() before
  commits (yes, even for YAML-only changes — the point is catching an
  unexpected code change riding along, not just symbol-diffing the YAML
  itself). impact() does not apply to a sitting that edits no symbols.
- Close the issues.md entry in the SAME commit as the fix: remove it from
  issues.md, write the reasoning into archive.md.
- Verify red-green. If a change genuinely has no red-green, say so and verify
  the mechanism instead — mutate the code and confirm it reds, or point to a
  real deployment log if one exists.
- Read the whole issues.md entry, not the headline.
- Commit to main directly, with a pathspec; worker/ is a submodule and needs
  its own commit plus a pointer bump, pushed before the parent.
- If the user redirects mid-sitting, revert the discarded approach cleanly
  (verify with git diff against untouched files) and record what was tried
  and undone — don't just quietly drop it.
```

<!-- markdownlint-enable MD031 MD040 -->
