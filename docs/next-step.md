# Handoff — 2026-08-06 (fourteenth sitting)

> **The drain queue is empty.** AUDIT-W1, AUDIT-W2 and AUDIT-Q2 are closed. What remains open is
> exactly the three tracks plus AUDIT-D5, which is blocked on a measurement — the goal the
> thirteenth sitting set.
>
> **9 findings open, 43 of 52 closed (83%).** Nothing `[C]` or `[H]` anywhere.
>
> **Two more entries were wrong about their own subject.** W2's *title* describes a throttle that
> does not exist and missed the one that does; Q2 undercounted its own comments and one of them was
> factually wrong about the code beneath it. See [§ What closed](#what-closed-this-sitting).
>
> **Nothing needs deploying**, but one live-config line is worth knowing about — see
> [§ Deployment](#deployment).

## What closed this sitting

| # | id | sev | outcome |
| --- | --- | --- | --- |
| 1 | AUDIT-W1 | L | Fixed. Both QA default-model tables deleted; `providers.json` is the source. |
| 2 | AUDIT-W2 | L | Fixed. **Title was wrong** — the fix was in `docker-compose.yml`, not the worker. |
| 3 | AUDIT-Q2 | — | Fixed. **Was 7 lines across 2 sites, not "two comments"**, and one line was false. |

Full reasoning in `archive.md`, "2026-08-06 fourteenth sitting — the drain queue". Do not re-derive
it.

**That takes the running count of stale, wrong or incomplete findings from twenty-two to
twenty-four.**

### AUDIT-W2 — the finding named the wrong file *and* the wrong mechanism

Two independent errors in one entry, and both are the same failure mode the last three sittings
have been logging.

**Wrong file.** `rate_limit.py` already read `os.environ.get("RATE_LIMIT", "")` — unset was
*already* unlimited in code. The `10` lived in `docker-compose.yml` as `RATE_LIMIT=${RATE_LIMIT:-10}`
and again in `.env.example`. The entry cited only `.env.example`, at a line number that had drifted
from `:105` to `:117`. **Grepping the tell found one of three sites; grepping the shape found all
three.**

**Wrong mechanism.** The title reads *"a single global throttle across all providers and tasks"*.
`enforce_rate_limit` has exactly two callers:

- `services/llm_client.py:208` passes the provider name, so `lock_key = provider`. **Every cloud
  call is keyed on its own provider bucket, never on `"global"`** — including a provider with no
  `rateLimits`. The cross-provider throttle the finding describes has never existed.
- `services/translation.py:526` — a bare `enforce_rate_limit()` inside `try_local_ai`. This is the
  **only** caller that reaches `"global"`, and it is the **local** Ollama/LM Studio path, which has
  no remote limit to respect. At `RATE_LIMIT=10` it spaced calls to your own machine 6 s apart.

So the entry missed the only real instance while describing one that was not there. The unlimited
default neutralises both. The `enforce_rate_limit()` call inside `try_local_ai` was **left in
place** — the local path is AUDIT-W3's, and one variable per change.

### AUDIT-W1 — the tables were incomplete *and* wrong

`QA_DEFAULT_LLM_MODELS` / `QA_DEFAULT_VLM_MODELS` listed `openrouter`, `gemini`, `nvidia`.
`providers.json` ships `openrouter`, `cloudflare`, `nvidia`, `neurometric` and has carried
per-provider `defaultQALLMModel` / `defaultQAVLMModel` all along. So two real providers had no
default, and `gemini` — which had one — **is not a provider in this deployment at all.**

**Two tests were resting on that phantom.** `test_render_and_qa.py`'s two VLM tests set
`QA_CONFIG.provider = "gemini"`. They passed only because `qa.py` listed it. **That is the sitting's
best red-green**: the fix broke exactly the two tests that were asserting against a provider that
does not exist, and they were repointed at `openrouter`.

The fixture `tests/test_providers.json` had **no per-provider defaults at all**, so it could not
exercise the fallback in either direction. It now gives `openrouter` both and `cloudflare` only a
`qaLLM` one, reproducing the real `neurometric` shape (`defaultQAVLMModel: null`) — resolution is
**per task**, not per provider.

### AUDIT-Q2 — the entry undercounted itself

The `JobCoordinatorService` block was **five lines of deliberation, not three**; the anchor had
drifted from `:1318-1320` to `:1438-1442` and the quote stopped one line early. Seven lines across
two sites.

**And `PageService.java:669` was factually wrong.** It said *"Skip TL/QA fields in OCR cloning"* —
the code immediately below does not skip them, it nulls them. Line `:670` was the model catching its
own error mid-thought. Deleting both would have left a genuinely non-obvious block ("why does a
*clone* null fields?") unexplained, so they were replaced by one accurate line, verified against
`cloneTranslationData` (`PageService.java:776`), which writes those same seven fields back.

**The grep was re-run as a shape.** The entry's own grep was three phrases over
`backend/src/main/java`. Re-run across `backend/src`, `frontend/src`, `worker/src`, `worker/tests`
and `scripts`, over `//`, `#` and `*` markers, widened to `hmm`, `let me`, `i should/need to/will`,
`on second thought`, `scratch that`, `never mind`, `as the user asked`: **exactly the same two
sites.** The entry's claim that this is two sites and not a class of problem survives a much wider
net than the one it proposed.

## Where `issues.md` actually stands

**52 `AUDIT-*` findings filed in total. 9 are open. 43 are closed — 83%.**

| sev | open | which |
| --- | --- | --- |
| **[C]** | 0 | — |
| **[H]** | 0 | — |
| **[M]** | 4 | W3, B5, F1, F2 |
| **[L]** | 3 | F8, F9, D5 *(partial — 2 of 5 bullets)* |
| unranked | 2 | T1, Q1 |

**The board is now the three tracks and nothing else.** Every open entry belongs to a track except
AUDIT-D5, which is blocked on a measurement. There is no drain queue left.

## The three tracks

Unchanged from the thirteenth sitting except that Track 2 lost Q2. **Pick one and say which before
you start.**

### Track 1 — The UI is fast and good-looking

| id | sev | what |
| --- | --- | --- |
| AUDIT-F1 | M | Theme rebuilt from scratch on every light/dark toggle → `colorSchemes` + `cssVariables`. Bundle with the next MUI major. |
| AUDIT-F2 | M | `Reader.tsx` at 3,954 lines / 28 `useState`; `ReaderRightSidebar.tsx` with 65 inline `sx`. The profile says **split the component**. |
| AUDIT-F8 | L | No pagination, search or debounce. **Decide the ceiling before building anything** — if a few hundred series is the cap, close it. |
| AUDIT-F9 | L | Responsive behaviour never verified. Wants Playwright, same infrastructure as the ZIP-pixel item. |

**Know the ceiling before starting.** The "UI is laggy" complaint is measured and both remaining
halves are **not fixable in frontend code**: 71% of LongTask wall time is the main thread
*descheduled* (host CPU contention), and of the reader's 8.80 s of JS self CPU only 0.715 s (8%) is
app code — the rest is React reconciliation and MUI. **"Better looking" has far more headroom than
"faster" here**, and that is the honest ordering.

### Track 2 — The backend is complete and clean enough to throw away

**Anything a Go/Python rewrite would have to re-derive must be written down first; anything that is
Java-shaped noise can just die.**

| id | sev | what |
| --- | --- | --- |
| AUDIT-B5 | M | **The gate.** `ddl-auto: update` against a competing `init.sql`. Nobody knows what the live schema actually is. A Flyway/Liquibase baseline is a prerequisite for *any* migration. |
| AUDIT-T1 | — | The "e2e" test isn't one — 19 `@patch` against 4 asserts, 342 `@patch` across 49 files suite-wide. Wants `mock_router.md`. |
| AUDIT-Q1 | — | 249 `Objects.requireNonNull`, concentrated in four classes. One mechanical sweep, not incremental. |
| AUDIT-W3 | M | Cooldowns and lock waits burn a job slot. Half-defused by W10 — only the heavy tier still stalls. **Now also owns `try_local_ai`'s bare `enforce_rate_limit()`** (see W2 above). |

**"Do we really need a separate worker?" has to be answered inside this track, not after it.** It
has been open and unanswered since the audit began, and it changes *what you are migrating*. Answer
it before B5 completes, because the schema baseline differs depending on whether the worker keeps
its own view of job state.

**Do not start B5 casually.** It is a schema-migration project: Flyway or Liquibase, plus
reconciling `init.sql` against whatever `ddl-auto: update` has actually produced live.

### Track 3 — Understand the paid product and close the quality gap

The biggest *product* gap, and the only track whose unknowns are genuinely unknown rather than
merely unmeasured.

Measured against mangatranslator.ai across 31 examples: **we flatten 6.85% of page artwork on average
against their 1.92%**, and we lose on every page in the set — worst case `sample24` at 16%, where a
whole panel becomes one tan rectangle. Full comparison in
`render_quality_gap_2026-08-05.md`; score any render with `scripts/render_quality_metrics.py`.

Root cause is known and is three compounding things: **there is no inpainting anywhere**, erasure is
a flat colour fill over the region polygon, that polygon is the balloon's *outer* contour (so the
outline goes with it), and unconstrained region merging grows those polygons across whole panels.

> **In one line: their unit of erasure is the glyph, ours is the region.** Every upstream mistake
> costs them a few misplaced letters and costs us a panel.

Carried in this track:

- **The `BUBBLE_CONTOUR_FALLBACK` removal checkpoint.** Default off; `TODO.md` holds the baseline
  numbers. **A bigger YOLO is not the detector that replaces it** — `yolo26s_manga109` recovers 4/180
  against yolo11n's 1/180 and every one was already recovered by the contour search. Training
  distribution, not model size.
- **Free-floating text collision handling.** `freeTextBox` squares up the source's vertical column but
  is bounded by the page only — it does not know where the artwork or neighbouring regions are.
- **The VLM benchmarking item**, which is how the remaining unknowns get closed.

### AUDIT-D5 — the one thing outside a track, and it is blocked

**The memory pair. Blocked on a measurement, not on effort.** Kernel 5.15's cgroup v2 has no
`memory.peak` (added in 6.8), so there is no high-water mark to read back and instantaneous
`docker stats` is not a peak. Sample `memory.current` through a thumbnail-heavy run first, then set
the cap and `MaxRAMPercentage` together as one variable.

## Where the work stands

Three commits: the GitNexus reindex chore, the worker submodule fix, and the parent commit carrying
W2's compose half, Q2 and the pointer bump.

**All gates were run and all are green.**

| gate | result |
| --- | --- |
| `mvn -o clean verify` (backend) | **414 tests, 0 failures.** PMD and jacoco both pass. |
| `pytest -q` (worker) | **315 passed**, up from the 310 baseline — 5 new tests. |
| `ruff check .` / `ruff format --check .` | clean |
| `pyright .` | 0 errors, 0 warnings |

The carried-forward worker count of 310 is now **confirmed**, not assumed. Frontend gates were
**not run** — no frontend file changed.

**Red-green, per change:**

- **W1** — the two `gemini` tests went red on the fix and were repointed. Plus a new test that
  fails when `reload_if_changed()` is removed from `_qa_default_model`.
- **W2** — a compose default has no test, so the invariant it now relies on was pinned instead:
  `test_unset_rate_limit_is_unlimited`. Verified sensitive by mutating the code default to `"10"` —
  it fails, printing the 6 s spacing on both buckets. **This is the "no red-green, so verify what
  can break" pattern.**
- **Q2** — none, and none is possible: deleting comments cannot change behaviour. `verify` was run
  to confirm the two files still compile.

No API surface changed, so `npm run generate-api` was not run. A periodic no-change regen is still
worth doing — that is how the seventh sitting found drift.

Dependabot unchanged: four PRs open, all four close-don't-merge. #60 okhttp (the pin is load-bearing
— read the comment in `pom.xml` first) and #52 springdoc are blocked outright; #51 testcontainers-bom
2.x and #40 TypeScript 7 are major-version projects of their own. **GitHub's 2 high-severity
Dependabot alerts are the only security items anywhere**, and they are not covered by any `AUDIT-*`
entry — if they matter, they need filing properly.

### Deployment

**Nothing needs deploying.** The worker and compose changes land with the next
`docker compose build`.

**One live-config line was deliberately not touched.** `.env` (gitignored) carries `RATE_LIMIT=10`
at line 84, so the new unlimited compose default does not change *this* box until that line is
removed. Verified both ways:

```text
docker compose --env-file /dev/null config  →  RATE_LIMIT: ""     # shipped default, now unlimited
docker compose config                       →  RATE_LIMIT: "10"   # this box, still pinned
```

**It is inert either way**: `DISABLE_LOCAL_LLM=true`, so `try_local_ai` — the only caller that
reaches the `"global"` bucket — is not running. Removing the line is a one-word edit whenever you
want it; it was left because `.env` is untracked and changing live config silently is not this
sitting's job.

### GitNexus

**Reindexed and current at `365ad99`**, committed as its own `chore:`. Counts moved 5367 → 5377
symbols, 13372 → 13382 relationships; 300 execution flows unchanged.

**`detect_changes` is blind to submodule contents.** It runs `git diff` in the parent, which sees
`worker` only as a pointer — it reported `changed_count: 0` for a commit that rewrote two worker
modules and four test files. **For worker changes the blast radius has to come from `impact()`**,
which does index worker symbols (`_resolve_qa_model` → LOW, 2 direct callers, both in `qa.py`).

Both documented reindex commands still abort on this box. Use Node 22 explicitly:

```bash
~/.nvm/versions/node/v22.14.0/bin/node \
  ~/.nvm/versions/node/v26.1.0/lib/node_modules/gitnexus/dist/cli/index.js \
  analyze --embeddings --force
```

## Not mine — left alone deliberately

The free-model benchmarking thread is **still active and still commits during a sitting**, so the
pathspec discipline stands:

- `docs/benchmarking.md`, `docs/run_ocr_bench.md`
- `docs/free_openrouter_translation_benchmark_2026-08-06.md`, `docs/translation_bench.md`
- `scripts/benchmark_translation.py`, `scripts/build_translation_corpus.py`, `scripts/test-providers.json`

Every commit used an explicit pathspec. **Keep doing that, and put `-F <file>` before the `--`.**

## Carried forward — deliberately not done

Each was left undone for a stated reason and those reasons hold.

- **The AUDIT-D5 memory pair.** Blocked on a measured peak, not on effort.
- **`try_local_ai`'s bare `enforce_rate_limit()`.** New this sitting. The local path has no remote
  limit to respect, but the call belongs to AUDIT-W3 and the unlimited default already makes it
  inert by default.
- **`RATE_LIMIT=10` in the untracked `.env`.** See Deployment above.
- **Valkey has no `requirepass`.** Loopback removed the LAN reach, not the missing password. Adding
  one has to land in the backend's `SPRING_DATA_REDIS_*` and the worker's `REDIS_*` simultaneously; a
  half-applied Redis password takes the whole pipeline down.
- **`SeriesController.resolveSetting`'s untrimmed placeholder compare.** Dormant — every *reader* now
  treats a padded placeholder as inert, so the consequence is only that such a value can be stored.
- **`updateJobStatus` has no state-machine validation**, only vocabulary validation. A transition
  guard has to tell a stale worker's late callback from a live one, and the `Job` row carries nothing
  to do it with. Needs job generation tracking. A design gap, not a defect. **Track 2 has to decide
  this one explicitly** — it is exactly the kind of thing a rewrite would re-derive badly.
- **The cross-provider fallback rule has not reached `ocr.py` and `qa.py`.** AUDIT-W11 established it
  for translation; the failure was only ever measured there.
- **The exported ZIP's pixel content is unverified.** jsdom has no canvas. Needs a real browser.
- **The `neurometric` key in `secrets/api_keys.json` is still dead.** A chapter pinned to it escapes
  to the global provider.
- **A scan for other `@Transactional` self-invocations has not been done.** AUDIT-B2 was the known
  instance; the class of bug is invisible at the call site and this codebase has hit an
  annotation-binding failure three times.
- **`NotificationController.currentUser` throws `RuntimeException("Unauthorized")`**, so it is still a
  500 rather than a 401/403.
- **`Reader.tsx` guards on `.delete-page-btn` and `.reorder-controls`** in its canvas-pan handlers.
  Provably dead since `b951ee2`. Left because that file is Track 1's.
- **`PageService`'s "variant not smaller" branch is uncovered.** Forcing it needs a contrived
  incompressible fixture.
- **`JobController` still lists `queue:region-redo` in its queue-clear `delete`.** Legacy cleanup.

## Out of scope unless deliberately reopened

- **The worker pull model.** Measured at 408 s of 49,058 s of queue wait (0.83%). Build it for
  latency, resilience and multi-worker scaling — never for throughput.
- **A reader downscale cap.** A 3000 px long-edge cap hits 124 images and saves a further 46 MB. Real
  but secondary, and a second performance variable.
- **AUDIT-W5**, and re-deriving the queue-wait share. Both settled; see `archive.md`.

## Working constraints

- **`CLAUDE.md` is binding.** `impact({target, direction:"upstream", repo:"manga-library"})` before
  editing any symbol, report HIGH/CRITICAL, `detect_changes()` before committing. **`detect_changes`
  attributes by line offset**, so a large insertion flags untouched symbols below it — check `git
  diff -U0` hunk ranges before believing the blast radius. It also **cannot distinguish a flow being
  deliberately deleted from one breaking**, and **it cannot see inside `worker/` at all** — the
  parent repo diffs the submodule as a pointer. But **do not dismiss every CRITICAL as an
  artefact**: the eleventh sitting's `isOverride` CRITICAL was real. **`impact()` does not apply to a
  sitting that edits no symbols** — YAML, compose, Dockerfile and markdown changes have no indexed
  symbols.
- **No section of `issues.md` is exempt from triage.** The security track sat stale for four days
  because a "tracked separately" note was read as "do not verify". If an entry is out of scope for
  the *work*, it is still in scope for *being true*.
- **A finding's title can be wrong about the mechanism while its body is right about the code.**
  AUDIT-W2 described a cross-provider throttle that has never existed and missed a cloud rate limit
  applied to a local endpoint. **Read what the callers pass, not what the function could do.**
- **The pre-commit gate is `mvn -o clean verify`, not `test`.** `test` skips PMD and jacoco's rules.
  Use `mvn -o clean test` for red-green iteration, `verify` before you commit. **Never trust an
  incremental Maven run** — always `clean`.
- **Watch the shell's working directory.** It persists between calls. A `cd backend` in a second
  command after an earlier `cd backend` fails, and a backgrounded build that fails to `cd` can report
  success while never having run. Use absolute paths for anything whose result you intend to trust.
- **Verify a fix red-green, and revert defects INDIVIDUALLY.** If a bullet genuinely has no red-green
  — pure duplication removal, a default change, a comment deletion — **say so** rather than writing
  a test that passes either way, and verify the thing that *can* break instead. **The reliable
  technique is mutation**: write the test, then break the code it is supposed to protect and confirm
  it goes red. This sitting used it twice.
- **When a bullet gives a count or a line anchor, re-derive it across the tree, not the file.** Four
  times now: a recount narrowed to the anchor's file, a bullet that found one of two copies because
  only that one had a comment above it, a fix applied to the two secrets a finding named by variable
  while two more sat four lines above, and W2's `.env.example` anchor that was one of three sites and
  had drifted twelve lines. **Grep for the shape, never for the tell.**
- **A finding can be right and its prescribed fix still wrong.** AUDIT-D5's ports bullet diagnosed the
  exposure correctly and prescribed dropping mappings a working tool depends on. **Check the
  prescription against the consumers, not just the diagnosis against the code.**
- **Read the whole `issues.md` entry before calling it closed** — and check the *mechanism*, not just
  whether the line is still there. **Twenty-four findings** have now been stale, wrong or incomplete.
- **One performance variable per change.** The delta has to be attributable.
- **Commit straight to `main`** — no feature branches. **Use a pathspec** (`git commit -F <msgfile> --
  <paths>`): there is active concurrent work in the tree that commits *during* your sitting. **`-F`
  goes before the `--`**, or git reads it as a pathspec.
- **`git fetch --all` hangs** on `origin` (a pi5 host over Tailscale, unreachable). Use `git fetch
  github` / `git push github main`. The worker submodule's `origin` is a different, working GitHub
  remote, so a plain `git push origin main` is correct *there*.
- **Never run `prettier --write` outside a commit whose purpose is formatting.** `ci-npm.yml` gates on
  `format:check`; verify with `git diff -w`.
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
- **The worker test fixture is `worker/tests/test_providers.json`**, forced by `conftest.py` via
  `PROVIDERS_CONFIG`. It is **not** `config/providers.json` and is much thinner — if a test depends
  on provider config, check the fixture actually carries the key before assuming the behaviour is
  broken.
- **`@MockitoSpyBean` works on Spring Data repositories** in this codebase (spring-test 6.2). It is how
  `JobCoordinatorServiceTest` counts `pageRepository.findById` calls; the spy delegates, so every other
  test in the class is unaffected. Use `mockingDetails(...).getInvocations()` for a count.
- **Secrets resolve through three layers.** `DockerSecretsEnvironmentPostProcessor` maps **any** env
  var ending in `_FILE` to the stripped key, `application-local.yml` holds dev values, and
  `application-test.yml` holds test values. `application.yml` carries **no** credential fallbacks —
  keep it that way. `SecretsStartupValidator` refuses startup on unset, too-short or known-public
  values for `jwt.secret` and `internal.api-token`. **There are two test profiles**, `test` and
  `integration`; enumerate with
  `find src -name "application*.yml" && grep -rho '@ActiveProfiles("[^"]*")' src/test/java | sort -u`.
- **`.env` is gitignored and overrides `docker-compose.yml` defaults.** Verify with `docker compose
  config | grep -E 'CONCURRENT_JOBS|MAX_(HEAVY|LIGHT)_SLOTS'` before trusting a run. Currently
  `CONCURRENT_JOBS=4`, `MAX_HEAVY_SLOTS=1`, `MAX_LIGHT_SLOTS=3`, `DISABLE_LOCAL_LLM=true`,
  `LOG_LEVEL=INFO`, `LOG_LEVEL_WORKER=DEBUG`, `RATE_LIMIT=10`. **To see the *shipped* defaults, run
  `docker compose --env-file /dev/null config`.**
- The frontend compiles **into** the backend image, so any frontend change needs `docker compose build
  backend && docker compose up -d backend` (~10 min). To check just the frontend stage cheaply:
  `docker build --target frontend-build -f backend/Dockerfile .` (~1 min once cached).
- Backend API changes require `npm run generate-api` from `frontend/` with the backend container up.
- Backend build is Maven (no wrapper) **and must be run from `backend/`**. Frontend is `npx vitest run`
  / `npx tsc --noEmit` / `npm run lint` / `npm run format:check`.
- **`worker/` is a git submodule.** Changes need their own commit plus a pointer bump. `git add worker`
  stages the pointer. **Push the submodule first**, or the parent's pointer references a commit nobody
  else can fetch.
- **The local `.venv` is Python 3.13.12 / numpy 2.3.5** and matches the image. It is at the repo root,
  not in `worker/`; run the worker suite as `cd worker && ../.venv/bin/python -m pytest -q`.
- **Testcontainers works.** If the backend suite goes red across many classes at once, read the
  surefire report's `Caused by` chain before blaming the environment.
- **MinIO objects are readable straight off disk** — no container, no port 9000. Single-drive MinIO
  prefixes a 32-byte bitrot checksum to each 1 MiB block; strip those and the bytes come back verbatim.
  Handle three layouts: single-part, multi-part (`part.1..N`, numeric order), and small objects inlined
  into `xl.meta` as a trailing msgpack `bin32`. Verified against all 743 ETags.
- **Never upload Firefox profiles** — use save-to-file; they carry series names and URLs.
- **`sx` is not a free swap for `style`, in two distinct ways:** per-frame values mint an emotion class
  per value, and `sx` loses the cascade to a plain CSS class on a specificity tie. Scope to
  `&.the-class` when overriding one.

## Prompt for the next chat

<!-- markdownlint-disable MD031 MD040 -->

```
Continuing manga-library. Read docs/next-step.md first. docs/archive.md has a
"2026-08-06 fourteenth sitting" section with what closed and why. Do not
re-audit the codebase and do not re-derive the run numbers — both are written
down.

STATE: The drain queue is EMPTY. W1, W2 and Q2 all closed this sitting. 43 of
52 findings closed; 9 open. Nothing [C] or [H] anywhere.

The board is now EXACTLY the three tracks plus one blocked item:
  1. UI is fast and good-looking            — F1, F2, F8, F9
  2. Backend complete enough to throw away  — B5 (the gate), T1, Q1, W3
  3. Understand the paid product, close the quality gap — render/inpainting
  + AUDIT-D5, blocked on a measured backend memory peak (kernel 5.15 has no
    memory.peak; sample memory.current through a thumbnail-heavy run first).

There are no small items left. PICK ONE TRACK and say which and why before you
start. Track 2's gate (AUDIT-B5) is the highest-value thing on the board — no
migration can begin until the schema has a baseline — but it is a project, not
a sitting: Flyway/Liquibase plus reconciling init.sql against whatever
ddl-auto: update has actually produced live. Track 2 also has to ANSWER "do we
really need a separate worker?", open since the audit began, which changes what
you are migrating.

NOTHING NEEDS DEPLOYING. One note: .env (gitignored) still pins RATE_LIMIT=10,
so the new unlimited compose default does not change this box until that line
goes. It is inert either way — DISABLE_LOCAL_LLM=true and the only caller that
reaches the "global" bucket is try_local_ai.

GITNEXUS IS CURRENT at 365ad99. If you need to reindex, both documented commands
abort on this box; use Node 22 explicitly:
  ~/.nvm/versions/node/v22.14.0/bin/node \
    ~/.nvm/versions/node/v26.1.0/lib/node_modules/gitnexus/dist/cli/index.js \
    analyze --embeddings --force
Then commit the CLAUDE.md/AGENTS.md count rewrite as its own chore: commit.

detect_changes() CANNOT SEE INSIDE worker/ — the parent diffs the submodule as a
pointer and reports changed_count: 0. For worker changes get the blast radius
from impact(), which does index worker symbols.

GATE: `mvn -o clean verify`, NOT `mvn -o clean test`. Worker has FOUR gates:
pytest, ruff check, ruff format --check, pyright. Baselines are now CONFIRMED,
not assumed: backend 414, worker 315. Watch the shell's working directory — it
persists between calls, and a backgrounded build that fails to cd can report
success without ever running.

REMOTES: `git fetch --all` hangs on `origin` (pi5 over Tailscale, unreachable).
Use `git fetch github` / `git push github main`.

NOT MINE: the free-model benchmarking thread commits concurrently. Use an
explicit pathspec on every commit, and put -F <msgfile> BEFORE the -- or git
reads it as a pathspec.

Say plainly if a finding turns out stale, wrong or INCOMPLETE when you actually
read the code — that has now paid off TWENTY-FOUR times. This sitting found two
more, and both were the SAME failure in a new disguise: AUDIT-W2's title
described a cross-provider throttle that has never existed while missing the one
real instance (a cloud rate limit applied to the LOCAL LLM path), and its fix
was in docker-compose.yml, not the file the entry named. AUDIT-Q2 undercounted
its own comments and one of them was factually wrong about the code beneath it.

FOUR sittings running: a fix lands on the instances a finding ENUMERATES rather
than every instance of the shape, and an entry's TITLE can be wrong while its
body is right. Grep for the shape, never for the tell. Read what the callers
pass, not what the function could do.

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
- Frontend lint is --max-warnings 0 and CI gates on prettier --check.
- One performance variable per change.
```

<!-- markdownlint-enable MD031 MD040 -->
