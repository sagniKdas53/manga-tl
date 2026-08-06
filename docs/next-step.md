# Handoff — 2026-08-06 (thirteenth sitting)

> **The security track is closed, and it was already closed before this sitting started.** All four
> `AUDIT-S*` entries were fixed on 2026-08-02 and archived that day. They stayed in `issues.md` for
> four days because every handoff said *"security is tracked separately, don't fold it in"* and the
> triage pass read that as *don't look at it*. See [§ What closed](#what-closed-this-sitting).
>
> **Nothing `[C]` or `[H]` is open anywhere in this project now** — not "outside the security track".
> Anywhere.
>
> **The board is now three tracks, not a ranked list.** That is a deliberate change of format, agreed
> with the owner: everything left either belongs to one of three projects or drains into them. See
> [§ The three tracks](#the-three-tracks).
>
> **Nothing needs deploying.** The one code change is inert on this deployment — see
> [§ Deployment](#deployment).

## What closed this sitting

| # | id | sev | outcome |
| --- | --- | --- | --- |
| 1 | AUDIT-S1 | C | **Stale.** Fixed 2026-08-02. One real residual found and fixed here. |
| 2 | AUDIT-S2 | C | **Stale.** Fixed 2026-08-02. Verified live: 401, including against the old default token. |
| 3 | AUDIT-S3 | H | **Stale.** Fixed 2026-08-02. Guard inverted to fail closed, plus a FATAL startup check. |
| 4 | AUDIT-S4 | H | **Stale.** Fixed 2026-08-02. Single-use 60 s SSE ticket; access log is `%U`, not `%r`. |

Full reasoning and the live probes are in `archive.md`, "2026-08-06 thirteenth sitting — the whole
security track was already closed". Do not re-derive it.

**That takes the running count of stale, wrong or incomplete findings from eighteen to twenty-two.**

### Why four critical findings sat open for four days

Not carelessness. A rule that was doing the opposite of its job.

Every handoff carried **"AUDIT-S\* — security is tracked separately, don't fold it in."** That was
written to stop security work being casually mixed into performance sittings, which is reasonable.
What it produced was a section marked *not mine to touch*, so the 2026-08-05 triage — the pass that
explicitly claims "nothing in it is stale" — skipped it entirely. A section nobody triages is a
section whose staleness compounds silently.

**The rule is gone.** Security is a track like any other and gets verified like any other. If a
security finding lands in `issues.md` again, it gets read against the code before anyone believes it.

### The one thing that was genuinely open

`application.yml` still shipped the `postgres` and `minioadmin` fallbacks that `application-local.yml`
was created to own. The S1 fix de-defaulted the two secrets the finding **named by variable**
(`jwt.secret`, `internal.api-token`), *copied* the datasource password and MinIO keys into the local
profile, and never deleted the originals — leaving a second source of truth directly above a comment
reading "No fallbacks here on purpose".

**Third instance of this exact lesson in three sittings.** The eleventh had a phantom cache key, the
twelfth had a second `npm install` that only the first copy had a comment above, and this one had a
fix applied to the enumerated instances rather than to every instance of the shape.

> **Grep for the shape, never for the tell — and when a fix names its targets, check whether the
> class is bigger than the list.**

**Framed honestly: a consistency fix, not a hole.** Both credentials come from `_FILE` mounts in the
real deployment, so the fallbacks were unreachable in production, and a missing secret failed loudly
before and fails loudly after. What was wrong is that the file contradicted its own documented intent.

**It does have a red-green, and it is not the production path.** `MinioConfig:14,17` reads
`${minio.accessKey}` / `${minio.secretKey}` with no annotation default, and both test profiles were
silently inheriting `minioadmin` from the base config. Dropping the fallback without giving them
their own values fails **every `@SpringBootTest`** at context load with
`AccessKey and SecretKey must not be empty`. Confirmed red before the fix and green after.

> **The same lesson recurred inside this sitting, one file after it was written down.** The fix went
> into `application-test.yml` only, and `verify` came back with 5 errors — all
> `activeProfiles = ["integration"]`. **There are two test profiles**, `test` and `integration`, and
> the second was found only by enumerating rather than by inference. Knowing the rule does not
> protect you from it; enumerating does:
>
> ```bash
> find src -name "application*.yml" && grep -rho '@ActiveProfiles("[^"]*")' src/test/java | sort -u
> ```

## Where `issues.md` actually stands

**52 `AUDIT-*` findings filed in total. 12 are open. 40 are closed — 77%.**

There is no longer a separate security track, so the working list and the open list are the same
twelve entries.

| sev | open | which |
| --- | --- | --- |
| **[C]** | 0 | — |
| **[H]** | 0 | — |
| **[M]** | 4 | W3, B5, F1, F2 |
| **[L]** | 5 | W1, W2, F8, F9, D5 *(partial — 2 of 5 bullets)* |
| unranked | 3 | T1, Q1, Q2 |

Two `[L]`s are effectively neutralised already: **W2 is falsified** (measured inert twice, 0.0 s then
1.2%; only an unlimited-default hardening survives) and **W1 was re-ranked `[H]` → `[L]`** when its
dispatch half turned out stale. **W3** is half-defused by W10.

`issues.md` also carries five prose sections above the audit that are not `AUDIT-*` entries and are
not counted above. Three of them are now track owners rather than complaints — see below.

## The three tracks

The ranked list is retired. It kept recommending whatever was smallest, and then ending with
"after this, everything is a project". These are the projects. **The goal is that these three are the
only things open.**

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

The framing does the prioritising: **anything a Go/Python rewrite would have to re-derive must be
written down first, and anything that is Java-shaped noise can just die.**

| id | sev | what |
| --- | --- | --- |
| AUDIT-B5 | M | **The gate.** `ddl-auto: update` against a competing `init.sql`. Nobody knows what the live schema actually is. A Flyway/Liquibase baseline is a prerequisite for *any* migration. |
| AUDIT-T1 | — | The "e2e" test isn't one — 19 `@patch` against 4 asserts, 342 `@patch` across 49 files suite-wide. Wants `mock_router.md`. |
| AUDIT-Q1 | — | 249 `Objects.requireNonNull`, concentrated in four classes. One mechanical sweep, not incremental. |
| AUDIT-W3 | M | Cooldowns and lock waits burn a job slot. Half-defused by W10 — only the heavy tier still stalls. |
| AUDIT-Q2 | — | Two LLM thinking-out-loud comments. Two lines. |

**"Do we really need a separate worker?" has to be answered inside this track, not after it.** It has
been open and unanswered since the audit began, and it changes *what you are migrating*. Answer it
before B5 completes, because the schema baseline differs depending on whether the worker keeps its
own view of job state.

**Do not start B5 casually.** It is a schema-migration project: Flyway or Liquibase, plus reconciling
`init.sql` against whatever `ddl-auto: update` has actually produced live.

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

### The drain queue

Small, unglamorous, and the fastest route to a three-item board. **Take these first when a sitting has
no appetite for a project.**

| id | sev | what | size |
| --- | --- | --- | --- |
| AUDIT-W2 | L | Make the global `RATE_LIMIT` fallback default to unlimited. | **S** |
| AUDIT-W1 | L | Delete `QA_DEFAULT_LLM_MODELS` / `QA_DEFAULT_VLM_MODELS` in favour of `providers.json`. | **S** |
| AUDIT-Q2 | — | Delete two comments. | **XS** |
| AUDIT-D5 | L | The memory pair — **blocked**, needs a measured backend peak first. | S once measured |

**W1 and W2 are still the recommendation for the next sitting if you want momentum**: both `[L]`,
both worker, both *deletions*, both in files the eleventh sitting already worked in.

**AUDIT-D5 stays blocked.** Kernel 5.15's cgroup v2 has no `memory.peak` (added in 6.8), so there is
no high-water mark to read back and instantaneous `docker stats` is not a peak. Sample
`memory.current` through a thumbnail-heavy run first, then set the cap and `MaxRAMPercentage`
together as one variable.

## Where the work stands

**No Java, Python or TypeScript source changed this sitting.** The commit is two YAML resources and
three docs.

`mvn -o clean verify` was run **twice, and it is the reason this sitting has a red-green at all**:
green on the unmodified tree, red on a single `@SpringBootTest` with the test-profile MinIO values
removed, green again with them in place. Worker and frontend gates were **not run** — no worker or
frontend file changed. Counts carried forward unverified from the eleventh sitting: backend 414,
worker 310, frontend 308.

`markdownlint-cli2` on the three changed docs reports only the pre-existing MD012, which moved from
`docs/issues.md:491` to `:434` as a result of this sitting's 65-line deletion. Not introduced here.

No API surface changed, so `npm run generate-api` was not run. A periodic no-change regen is still
worth doing — that is how the seventh sitting found drift.

Dependabot unchanged: four PRs open, all four close-don't-merge. #60 okhttp (the pin is load-bearing
— read the comment in `pom.xml` first) and #52 springdoc are blocked outright; #51 testcontainers-bom
2.x and #40 TypeScript 7 are major-version projects of their own. **GitHub's 2 high-severity
Dependabot alerts are now the only security items anywhere**, and they are no longer covered by an
`AUDIT-S*` entry — if they matter, they need filing properly rather than inheriting a closed track.

### Deployment

**Nothing needs deploying, and nothing was deployed.**

The twelfth sitting's loopback binding **is** now live — verified this sitting:

```text
manga-db      127.0.0.1:5432->5432/tcp
manga-valkey  127.0.0.1:6379->6379/tcp
manga-minio   9000/tcp, 127.0.0.1:9001->9001/tcp
```

`manga-backend` is still `0.0.0.0:8080` and that is correct — Traefik routes to it and the documented
`npm run generate-api` flow fetches `http://localhost:8080/tlhub/v3/api-docs`.

This sitting's `application.yml` change is **inert on this deployment**: `MINIO_ACCESS_KEY` is set
directly in compose and both secrets arrive via `_FILE` mounts, so the removed fallbacks were never
being read. It lands with the next `docker compose build backend`; there is no reason to spend the
~10 minutes now.

### GitNexus

**Still stale**, last analysed at `1290f18` — now five commits behind. No `impact()` call was needed
this sitting: **no function, class or method was edited**, only YAML and markdown, and the working
constraints already record that `impact()` does not apply to such a sitting.

**Both documented reindex commands abort on this box.** Use Node 22 explicitly, since the global
install lives under the Node 26 prefix:

```bash
~/.nvm/versions/node/v22.14.0/bin/node \
  ~/.nvm/versions/node/v26.1.0/lib/node_modules/gitnexus/dist/cli/index.js \
  analyze --embeddings --force
```

Takes ~190 s. It warns about no VECTOR index (exact-scan fallback) and one parse-job idle timeout it
recovers from by splitting the job — both normal, exit code 0. **Running `analyze` rewrites the symbol
counts in `CLAUDE.md` and `AGENTS.md`; that gets its own `chore:` commit.**

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
  deliberately deleted from one breaking**. But **do not dismiss every CRITICAL as an artefact**: the
  eleventh sitting's `isOverride` CRITICAL was real. **`impact()` does not apply to a sitting that
  edits no symbols** — YAML, compose, Dockerfile and markdown changes have no indexed symbols.
- **No section of `issues.md` is exempt from triage.** The security track sat stale for four days
  because a "tracked separately" note was read as "do not verify". If an entry is out of scope for
  the *work*, it is still in scope for *being true*.
- **The pre-commit gate is `mvn -o clean verify`, not `test`.** `test` skips PMD and jacoco's rules.
  Use `mvn -o clean test` for red-green iteration, `verify` before you commit. **Never trust an
  incremental Maven run** — always `clean`.
- **Watch the shell's working directory.** It persists between calls. A `cd backend` in a second
  command after an earlier `cd backend` fails, and a backgrounded build that fails to `cd` can report
  success while never having run. Use absolute paths for anything whose result you intend to trust.
- **Verify a fix red-green, and revert defects INDIVIDUALLY.** If a bullet genuinely has no red-green
  — pure duplication removal, a default change, a reproducibility fix — **say so** rather than writing
  a test that passes either way, and verify the thing that *can* break instead. This sitting's config
  change had no production red-green but a real test-context one; that is the pattern.
- **When a bullet gives a count, re-derive the count across the tree, not the file.** Three times now:
  a recount narrowed to the anchor's file, a bullet that found one of two copies because only that one
  had a comment above it, and a fix applied to the two secrets a finding named by variable while two
  more sat four lines above. **Grep for the shape, never for the tell.**
- **A finding can be right and its prescribed fix still wrong.** AUDIT-D5's ports bullet diagnosed the
  exposure correctly and prescribed dropping mappings a working tool depends on. **Check the
  prescription against the consumers, not just the diagnosis against the code.**
- **Read the whole `issues.md` entry before calling it closed** — and check the *mechanism*, not just
  whether the line is still there. **Twenty-two findings** have now been stale, wrong or incomplete.
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
- **`@MockitoSpyBean` works on Spring Data repositories** in this codebase (spring-test 6.2). It is how
  `JobCoordinatorServiceTest` counts `pageRepository.findById` calls; the spy delegates, so every other
  test in the class is unaffected. Use `mockingDetails(...).getInvocations()` for a count.
- **Secrets resolve through three layers.** `DockerSecretsEnvironmentPostProcessor` maps **any** env
  var ending in `_FILE` to the stripped key, `application-local.yml` holds dev values, and
  `application-test.yml` holds test values. `application.yml` carries **no** credential fallbacks —
  keep it that way. `SecretsStartupValidator` refuses startup on unset, too-short or known-public
  values for `jwt.secret` and `internal.api-token`.
- **`.env` is gitignored and overrides `docker-compose.yml` defaults.** Verify with `docker compose
  config | grep -E 'CONCURRENT_JOBS|MAX_(HEAVY|LIGHT)_SLOTS'` before trusting a run. Currently
  `CONCURRENT_JOBS=4`, `MAX_HEAVY_SLOTS=1`, `MAX_LIGHT_SLOTS=3`, `DISABLE_LOCAL_LLM=true`,
  `LOG_LEVEL=INFO`, `LOG_LEVEL_WORKER=DEBUG`. **To see the *shipped* defaults, run `docker compose
  --env-file /dev/null config`.**
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
"2026-08-06 thirteenth sitting" section with what closed and why. Do not
re-audit the codebase and do not re-derive the run numbers — both are written
down.

STATE: The security track is CLOSED. All four AUDIT-S entries were stale — fixed
2026-08-02, verified against the code and the live stack on 2026-08-06, removed
from issues.md. Nothing [C] or [H] is open anywhere now. 40 of 52 findings
closed; 12 open.

The board is now THREE TRACKS, not a ranked list:
  1. UI is fast and good-looking      — F1, F2, F8, F9
  2. Backend complete enough to throw away — B5 (the gate), T1, Q1, W3, Q2
  3. Understand the paid product, close the quality gap — render/inpainting
Plus a drain queue of small items: W2, W1, Q2, and D5 (blocked on a measurement).
The goal is that those three tracks are the ONLY things open.

NOTHING NEEDS DEPLOYING. The loopback binding from the twelfth sitting is live
and verified. This sitting's application.yml change is inert on this deployment
and lands with the next backend build.

GitNexus is stale (last analysed 1290f18, now 5 commits behind). BOTH documented
reindex commands abort on this box. Use Node 22 explicitly:
  ~/.nvm/versions/node/v22.14.0/bin/node \
    ~/.nvm/versions/node/v26.1.0/lib/node_modules/gitnexus/dist/cli/index.js \
    analyze --embeddings --force
Then commit the CLAUDE.md/AGENTS.md count rewrite as its own chore: commit.

GATE: `mvn -o clean verify`, NOT `mvn -o clean test`. Worker has FOUR gates:
pytest, ruff check, ruff format --check, pyright. Watch the shell's working
directory — it persists between calls, and a backgrounded build that fails to cd
can report success without ever running.

REMOTES: `git fetch --all` hangs on `origin` (pi5 over Tailscale, unreachable).
Use `git fetch github` / `git push github main`.

NOT MINE: the free-model benchmarking thread commits concurrently. Use an
explicit pathspec on every commit, and put -F <msgfile> BEFORE the -- or git
reads it as a pathspec.

WHAT I WANT

If you want momentum, take the drain queue: W2 and W1 together, then Q2. They
are the last small items on the board and all three are deletions.

Otherwise pick ONE track and say which and why before you start. Track 2's gate
(AUDIT-B5) is the highest-value thing on the whole board, because no migration
can begin until the schema has a baseline — but it is a project, not a sitting.
Track 2 also has to ANSWER "do we really need a separate worker?", which has been
open and unanswered since the audit began and changes what you are migrating.

Say plainly if a finding turns out stale, wrong or INCOMPLETE when you actually
read the code — that has now paid off TWENTY-TWO times. This sitting found four
stale entries in one section, and the reason they survived is worth remembering:
a handoff note saying "tracked separately, don't fold it in" was read as "don't
verify it". No section of issues.md is exempt from triage.

Three sittings running, the same lesson has appeared in a new disguise: a fix
lands on the instances a finding ENUMERATES rather than every instance of the
shape. Grep for the shape, never for the tell.

CONSTRAINTS
- CLAUDE.md is binding: impact() before edits, detect_changes() before commits.
  impact() does not apply to a sitting that edits no symbols.
- Close the issues.md entry in the SAME commit as the fix: remove it from
  issues.md, write the reasoning into archive.md.
- Verify red-green. If a change genuinely has no red-green, say so and verify
  the thing that CAN break instead.
- Read the whole issues.md entry, not the headline.
- Commit to main directly, with a pathspec; worker/ is a submodule and needs its
  own commit plus a pointer bump, pushed before the parent.
- Frontend lint is --max-warnings 0 and CI gates on prettier --check.
- One performance variable per change.
```

<!-- markdownlint-enable MD031 MD040 -->
