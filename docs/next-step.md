# Handoff — 2026-08-06 (tenth sitting)

> **AUDIT-B8 is closed** — all eight open bullets, in two commits. The entry is gone from
> `issues.md`.
>
> **Two things worth more than the fix itself.** One filed bullet was **precisely inverted** —
> `JwtAuthFilter`'s logging defect is the opposite of what was written down, verified empirically
> rather than argued. And **`mvn -o clean test` is the wrong gate**: CI runs `verify`, which runs PMD,
> and a violation from the first commit got through. See
> [§ Use `verify`, not `test`](#use-verify-not-test).
>
> **Nothing is deployed.** Both commits are pushed but neither container has been rebuilt. This is
> the one thing outstanding — see [§ Deployment](#deployment).

## What closed this sitting

| # | id | sev | outcome |
| --- | --- | --- | --- |
| 1 | AUDIT-B8 | L | **Closed** (`1a8bc18` + `46bb937`). Seven of eight bullets accurate; one inverted. |

Full reasoning is in `archive.md`, "2026-08-06 tenth sitting" (two sections — the entry was closed in
two commits and each has its own). Do not re-derive it.

### The short version

`1a8bc18` — the callback path. `updateJobStatus` now rejects any status outside `Job.status`'s
documented vocabulary with a 400, via a new `JobStatus` enum that is a **validator, not a mapping**
(the entity is serialised onto SSE, into Redis and into the frontend schema, so making the field an
enum is a schema change well past this entry). `resolveNotificationContext` resolves off the echoed
`pageId` instead of `pages.get(0)`. Reader mode now marks the layout job `COMPLETED`. The five
`DEBUG_TL` lines drop to DEBUG.

`46bb937` — config and dispatcher. `WORKER_URLS` default 9091 → 8000. The `@PostConstruct` secret-file
re-read is gone. `jwtExpirationMs` is a `long`. `JwtAuthFilter` gets its own SLF4J logger.

### The one that was filed backwards

`JwtAuthFilter:58` was filed as *"fills the placeholder with `e.toString()` instead of attaching the
throwable, so no stack trace is ever logged."* That is inverted. The inherited `logger` is a
commons-logging `Log` from `GenericFilterBean`, whose only two-arg overload is `error(Object,
Throwable)` — the throwable was **always** attached and the stack trace **was** written. The real
defect is the other half: commons-logging does not interpolate, so the `{}` printed literally.

**This was confirmed by running it, not by reading the API.** With the original line restored and the
`{}` assertion removed from the test, `event.getThrowableProxy()` comes back non-null with the right
class name. That is the evidence; the argument alone would have been a guess.

**That is the thirteenth finding stale or wrong, and the first with the mechanism precisely
inverted.** Both directions of a claim are worth checking, not just whether the line is still there.

### The one bullet with no red-green

The `@PostConstruct` removal has no failing test and that is deliberate: it is duplication removal,
not a defect. There is no state in which the old code gave a wrong answer, so nothing goes red when
it is restored. Its two tests covered the deleted method; they are replaced by one pinning the
contract the deletion *depends* on — that the bean resolves its secret from the `WORKER_API_SECRET`
property. Written down rather than papered over with a test that would have passed either way.

## Use `verify`, not `test`

**`mvn -o clean test` does not run PMD or jacoco's coverage rules. CI runs `mvn --batch-mode clean
verify`, which runs both.** The first commit passed `clean test` and would have failed CI: deleting
`regionCallback`'s discarded `resolveNotificationContext(imageId)` left `imageId` unused, and
`maven-pmd-plugin` fails the build on `UnusedLocalVariable`. Caught before pushing and folded into the
second commit.

The last several handoffs have all said "`mvn -o clean test` for any red-green check". That is fine
for red-green, but **the gate before a commit is `mvn -o clean verify`.** Corrected in the working
constraints below.

Spotless is *not* lifecycle-bound and CI does not run `spotless:check`, so Java formatting is not
gated. Do not let that tempt you into reformatting.

## The ranked list

Renumbered with B8 removed. Nothing below was re-derived this sitting.

| # | id | sev | what | size |
| --- | --- | --- | --- | --- |
| 1 | AUDIT-Q3 | L | Seven verified bullets. `isOverride`'s untrimmed `"inherit"` is now a shared predicate. | S–M |
| 2 | AUDIT-D5 | L | Published DB/Valkey/console ports, `LOG_LEVEL=DEBUG`, `npm install` under an `npm ci` comment, no `MaxRAMPercentage`. | S–M |
| 3 | AUDIT-B5 | M | `ddl-auto: update` against a competing `init.sql`. | L — a migration project |
| 4 | AUDIT-Q1 | — | 249 `Objects.requireNonNull`, up 2 since filing. | L, mechanical |
| 5 | AUDIT-T1 | — | The "e2e" test isn't one, and the suite got more mocked. | L — wants `mock_router.md` |
| — | AUDIT-W1, W2 | L | Both re-ranked **[H] → [L]** by the sixth sitting. | S each |
| — | AUDIT-W3 | M | Half-defused by W10: light slots are 4 now, so only the heavy tier still stalls. | M |

**AUDIT-W3 remains the only [M] outside the B5 migration project.**

**If you want one recommendation: deploy first** (below), then take **AUDIT-Q3**. It is the same shape
as B8 — a multi-bullet [L] entry, splittable, each bullet small — and the sitting just built the
muscle for that. **AUDIT-D5 is the better choice if you would rather not touch Java**; it is compose
and Dockerfile work, and its first bullet (unauthenticated Valkey and Postgres published to the host)
is the highest real-world exposure left on the list even at [L].

**Do not start AUDIT-B5 casually.** It is a schema-migration project — Flyway or Liquibase, plus
reconciling `init.sql` against whatever `ddl-auto: update` has actually produced live.

## Where the work stands

**Backend 412** (was 401; +11 this sitting: +8 in the first commit, +5 −2 in the second).
`mvn -o clean verify`, full suite, green. **Worker 305**, untouched — no worker change this sitting.
**Frontend 308**, untouched.

No API surface changed, so `npm run generate-api` was not run. It is still worth a periodic no-change
regen just to see whether the diff is empty — that is how the seventh sitting found drift.

Dependabot is unchanged: four PRs open, all four close-don't-merge. #60 okhttp (the pin is
load-bearing — read the comment in `pom.xml` first) and #52 springdoc are blocked outright; #51
testcontainers-bom 2.x and #40 TypeScript 7 are major-version projects of their own. GitHub reports 2
high-severity Dependabot alerts on push; those are AUDIT-S\* territory, tracked separately.

### Deployment

**Nothing is deployed. This is the outstanding item.** Both commits are pushed to `github` (`46bb937`)
but neither container has been rebuilt or restarted.

- **Backend needs a rebuild.** Both commits are backend-only. No frontend source changed, so this is
  the backend image alone — still ~10 min because the frontend compiles into it.
- **Worker unchanged**, no rebuild needed.

The behaviour changes worth watching once it is up: `updateJobStatus` now returns **400** on an
unknown status word where it used to return 200 and write it. If anything in the wild is sending a
status outside `PENDING`/`PROCESSING`/`COMPLETED`/`FAILED`/`PAUSED`, it will start failing loudly
instead of silently — which is the point, but it is the one change that could surface as a new error
in the logs. Grep the worker logs for `Rejecting unknown status` after the restart.

### GitNexus

**The index is stale** — last analysed at `846a616`, three commits back. The post-commit hook has been
saying so all sitting. Reindex with the globally installed `gitnexus analyze --embeddings --force`
(not `node .gitnexus/run.cjs analyze`, which aborts).

**That rewrites the symbol counts in `CLAUDE.md` and `AGENTS.md` — give it its own `chore:` commit**,
per the standing rule.

Note for next time: `detect_changes` was **CRITICAL with 36 affected processes** on the first commit,
and about thirty of those were `OcrCallback → GetChapter`-shaped flows that exist *only* because of
the seven dead `resolveNotificationContext` calls being deleted. They do not break; they cease to
exist. `formatMessage` and `FREE_TEXT_MAX_WIDEN` were the usual line-offset artefacts. **The tool
cannot tell "this flow is being removed on purpose" from "this flow is breaking"** — check `git diff
-U0` hunk ranges, as ever.

## Not mine — left alone deliberately

The free-model benchmarking thread is **active and committing concurrently.** It landed two commits
*during* this sitting (`566a007`, `29d3efe`), which is also how the first commit attempt failed — a
`-F` flag placed after `--` was read as a pathspec while HEAD had moved underneath.

Untracked or modified and **not** swept into either commit:

- `docs/benchmarking.md`, `docs/run_ocr_bench.md`
- `docs/free_openrouter_translation_benchmark_2026-08-06.md`, `docs/translation_bench.md`
- `scripts/benchmark_translation.py`, `scripts/build_translation_corpus.py`, `scripts/test-providers.json`
- `corpus/`

Every commit used an explicit pathspec. **Keep doing that, and put `-F <file>` before the `--`.**

## Carried forward — deliberately not done

Unchanged from the ninth sitting; each was left undone for a stated reason and those reasons hold.

- **`updateJobStatus` has no state-machine validation**, only vocabulary validation. A transition
  guard has to tell a stale worker's late callback from a live one, and the `Job` row carries nothing
  to do it with — AUDIT-P4 solved the duplicate-*result* half with `callbackAppliedAt`, not the
  status half. Needs job generation tracking. **This is new this sitting** and is the one part of B8
  deliberately left open; it is not filed as an issue because it is a design gap, not a defect.
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
  deliberately deleted from one breaking**; this sitting's CRITICAL was mostly the former.
- **The pre-commit gate is `mvn -o clean verify`, not `test`.** `test` skips PMD and jacoco's rules;
  CI runs `verify` and will fail on things `test` never sees. Use `mvn -o clean test` for red-green
  iteration, `verify` before you commit. **Never trust an incremental Maven run** — always `clean`.
- **Running `analyze` rewrites the symbol counts in `CLAUDE.md` and `AGENTS.md`.** Keep that out of a
  feature commit — it gets its own `chore:` commit.
- **Close entries in `issues.md` in the same commit as the fix.** The convention is *remove* from
  `issues.md` and write the reasoning into `archive.md`. A multi-bullet entry can be closed across
  several commits — strike bullets as they land and delete the entry with the last one.
- **Verify a fix red-green, and revert defects INDIVIDUALLY.** Nine defects this sitting, eight
  reverted separately and each red on its own test; the ninth is explained above. Check what your
  fixtures patch, and whether a later step in the same call overwrites what you assert on.
- **Read the whole `issues.md` entry before calling it closed** — and check the *mechanism*, not just
  whether the line is still there. That is the seventh time a bullet the headline omitted was real
  work, and the first time a filed mechanism was exactly backwards.
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
"2026-08-06 tenth sitting" sections with what closed and why. Do not re-audit the
codebase and do not re-derive the run numbers — both are written down.

STATE: AUDIT-B8 is closed, all eight bullets, in two commits (1a8bc18, 46bb937),
both pushed to github. issues.md remains trustworthy.

FIRST THING: nothing is deployed. Both commits are backend-only and the backend
container has not been rebuilt. `docker compose build backend && docker compose
up -d backend` (~10 min). After it is up, grep the worker logs for "Rejecting
unknown status" — updateJobStatus now 400s on a status word outside
PENDING/PROCESSING/COMPLETED/FAILED/PAUSED where it used to accept and persist it.

SECOND: the GitNexus index is stale (last analysed 846a616, three commits back).
Run the globally installed `gitnexus analyze --embeddings --force`, then commit
the CLAUDE.md/AGENTS.md count rewrite as its own chore: commit.

GATE: use `mvn -o clean verify`, NOT `mvn -o clean test`. test skips PMD and
jacoco's rules; CI runs verify. A PMD violation got through this sitting because
of exactly this.

REMOTES: `git fetch --all` hangs on `origin` (pi5 over Tailscale, unreachable).
Use `git fetch github` / `git push github main`.

NOT MINE: the free-model benchmarking thread is active AND COMMITTING WHILE YOU
WORK — it landed two commits mid-sitting. docs/benchmarking.md,
docs/run_ocr_bench.md, docs/translation_bench.md,
docs/free_openrouter_translation_benchmark_2026-08-06.md, scripts/
benchmark_translation.py, scripts/build_translation_corpus.py,
scripts/test-providers.json, corpus/. Leave them; use an explicit pathspec on
every commit, and put -F <msgfile> BEFORE the -- or git reads it as a pathspec.

WHAT I WANT

Deploy and reindex first. Then work the ranked list in next-step.md, top down —
item 1 is AUDIT-Q3, or take AUDIT-D5 instead if you would rather not touch Java
(its unauthenticated-Valkey bullet is the highest real exposure left).

Say plainly if a finding turns out stale or wrong when you actually read the
code — that has now paid off thirteen times. This sitting found one filed
BACKWARDS: JwtAuthFilter's logging bullet described the exact inverse of the real
defect. Check the mechanism, not just whether the line is still there, and verify
by running it rather than by reasoning about the API.

CONSTRAINTS
- CLAUDE.md is binding: impact() before edits, detect_changes() before commits.
  Its CRITICAL/HIGH is usually the line-offset artefact — check `git diff -U0`
  hunk ranges. It also cannot tell a flow being deliberately deleted from one
  breaking.
- Close the issues.md entry in the SAME commit as the fix: remove it from
  issues.md, write the reasoning into archive.md. A multi-bullet entry may be
  closed across several commits — strike bullets as they land.
- Verify red-green, and when an entry has several defects revert them
  INDIVIDUALLY. If a bullet genuinely has no red-green (pure duplication
  removal), say so rather than writing a test that passes either way.
- Read the whole issues.md entry, not the headline. Seven times now a bullet the
  headline omitted turned out to be real work.
- Worker has FOUR gates: pytest, ruff check, ruff format --check, pyright.
- Commit to main directly, with a pathspec; worker/ is a submodule and needs its
  own commit plus a pointer bump, pushed before the parent.
- Frontend lint is --max-warnings 0 and CI gates on prettier --check.
- One performance variable per change.
- Security findings (AUDIT-S*) are tracked separately; don't fold them in.
```

<!-- markdownlint-enable MD031 MD040 -->
