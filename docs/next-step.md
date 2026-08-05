# Handoff — 2026-08-05 (eighth sitting)

> **Items 1–3 are done**: AUDIT-W8, AUDIT-W9 and AUDIT-T2. The first two were the last two **[M]
> worker** findings; the worker board now has nothing above [L] except AUDIT-W3.
>
> **Two findings were wrong and were corrected rather than obeyed.** W9 claims `gemma4:e4b` is not a
> real tag — it is, and renaming it would have broken a working default. T2 asked for a test that
> already existed. See [§ Where findings were wrong](#where-findings-were-wrong).
>
> **The worker is now live.** It was rebuilt and restarted this sitting, so the three fixes that had
> been pending deployment for a sitting are deployed, along with this sitting's two.
>
> **Not pushed.** 10 commits on local `main`. `git fetch` timed out, so "ahead-only" is against the
> last-fetched ref — re-check before pushing.

## What closed this sitting

| # | id | sev | outcome |
| --- | --- | --- | --- |
| 1 | AUDIT-W8 | M | **Closed** (`579377a` + worker `b8ed91f`). All four remaining bullets. |
| 2 | AUDIT-W9 | M | **Closed** (`579377a` + worker `cf78ce6`). One bullet refused as wrong. |
| 3 | AUDIT-T2 | — | **Closed** (`b474581`). Already done; no code written. |

### 1. AUDIT-W8 — accurate as filed, but its severity depended on a provider that isn't configured

All four bullets were real. The headline one — the Anthropic branch ignoring `response_schema`
entirely, because the whole `response_format` ladder sat inside the `else` — is fixed with
`output_config.format`, which is how the Messages API spells structured output; its `json_schema`
variant takes the schema **directly**, not wrapped in the OpenAI `{name, schema, strict}` object.

**Worth knowing before you weigh a similar finding: `config/providers.json` has no `anthropic`
provider at all.** Only `openrouter`, `cloudflare`, `nvidia`, `neurometric`. The Anthropic branch is
reachable only via the hardcoded fallback registry in `provider_config.py`, which fires when
providers.json fails to load. That is a live path, so the fix stands — but nothing in this
deployment was silently producing unstructured Anthropic output, because nothing was reaching
Anthropic. The fallback's default model was also `claude-3-5-sonnet-20241022`, **retired
2025-10-28**, so that branch could only ever have 404'd. Now `claude-sonnet-5`.

The other three bullets *do* affect every provider today: null `content` alongside a refusal
(`json.loads(None)` → `TypeError`), the import-time registry, and lost 429 increments.

**The entry's `:361` bullet had a twin it did not mention.** The Anthropic branch has the same shape
one level over: `content[0]` is not reliably the text block once thinking is on, and `.get("text")`
is `None` on any non-text block. That is the **fifth** time reading past the headline found real
work. Keep doing it.

### 2. AUDIT-W9 — right about the mechanism, wrong about the tag

`format: "json"` is Ollama's **native** `/api/chat` field; the endpoint is its OpenAI-compatible
shim, which ignores it. Confirmed against the deployed instance rather than from documentation —
same prompt, model and endpoint:

| sent | returned |
| --- | --- |
| `response_format: {"type": "json_object"}` | `{"key": "a", "value": 1}` |
| `format: "json"` | `"Sure! Here is an example…"` plus a ` ```javascript ` fence |

The four-way default split is closed to `ollama`/`gemma4:e4b` at both call sites.

**Note this deployment runs `DISABLE_LOCAL_LLM=true`,** so the local path is off for the general
case — but `qa.py:425` gates on `is_explicit_local or not disable_local`, so a chapter *pinned* to a
local model still routes there and does get the fix.

### 3. AUDIT-T2 — the test already existed, in the same commit as the fix it pins

See [§ Where findings were wrong](#where-findings-were-wrong).

## Where findings were wrong

**That is now twelve findings that turned out stale, wrong, or already fixed.** Two more this
sitting, and they failed in different directions — one asserted a fact about the runtime that was
false, one asserted an absence that was false. Both were caught the same way: by checking.

- **AUDIT-W9: `gemma4:e4b` is a real tag.** The entry says it "is not a real tag (probably meant
  `gemma3n:e4b`), so the shipped default pulls nothing." It is present on the deployed Ollama host —
  `gemma4:e4b`, family `gemma4`, 8.0B, Q4_K_M, pulled 2026-07-05. Obeying that bullet would have
  renamed a working default to a non-existent one: the exact inversion of the finding's intent. It
  *looks* like a typo for `gemma3n:e4b` and is not one. Check a claim about the runtime **against
  the runtime**.
- **AUDIT-T2: the test it asked for was already there.**
  `WorkerDispatcherServiceTest.testDispatchJobs_StuckQueueDoesNotBlockTheRestOfItsSlotClass` does
  precisely what the entry describes, Javadoc'd with AUDIT-P3, and `git log -S` places it in
  `19cab6f` — the same commit as P3's fix. Verified rather than assumed: reverting `break` to the
  pre-P3 `return` fails it on `leftPop("queue:ocr")` wanted-but-never-invoked.

## Three process notes, one of them new and nasty

- **`mvn -o test` can report green against stale classes.** The documented trap is `mvn -o
  test-compile` silently no-op'ing. This sitting produced a worse variant: a backgrounded `mvn -o
  test` raced a source edit and reported **26/26 passing with the defect reinstated**. A rerun after
  the compile had definitely landed failed correctly. **A green Maven run that started anywhere near
  an edit is not evidence — only `clean` is.**
- **A test can be neutralised by a fixture it didn't need.** The new concurrency test originally took
  `no_retry_sleep`, which patches `worker.services.llm_client.time.sleep` — that patches the
  attribute on the **shared `time` module object**, so the test's own interleaving delay vanished and
  it passed with the lock removed. It also mattered *where* the delay sat: sleeping before the read
  serialises the threads and hides the race; reading first and holding the stale value across the
  window reproduces it (24 threads, 18 recorded).
- **`node .gitnexus/run.cjs analyze` is broken, not flaky.** Three consecutive runs aborted
  identically: `Worker 0 parse job exhausted cumulative timeout budget (210s > 150s cap)` then a
  native-worker abort. The handoff's "retry once" no longer applies — this needs the documented
  recovery (`npm uninstall -g gitnexus && npm install -g gitnexus@latest`, or Node 22 LTS). **The
  index is therefore still at `215ada4`.** It was accurate for everything touched this sitting
  (neither `llm_client.py` nor `translation.py` had changed since), but do not trust it for the
  backend work below without reindexing first.

## The ranked list

Renumbered with 1–3 removed. Nothing below was re-derived.

| # | id | sev | what | size |
| --- | --- | --- | --- | --- |
| 1 | AUDIT-B8 | L | Eight verified bullets. `updateJobStatus` accepting arbitrary strings is the real one. | M, splittable |
| 2 | AUDIT-Q3 | L | Seven verified bullets. `isOverride`'s untrimmed `"inherit"` is now a shared predicate. | S–M |
| 3 | AUDIT-P6 | M | Lost `COMPLETED` PATCH re-runs the job. Wasted work, not corrupted data. | S–M |
| 4 | AUDIT-P8 | M | 2-hour trace TTL expires mid-pipeline. | S |
| 5 | AUDIT-D5 | L | Published DB/Valkey/console ports, `LOG_LEVEL=DEBUG`, `npm install` under an `npm ci` comment, no `MaxRAMPercentage`. | S–M |
| 6 | AUDIT-B5 | M | `ddl-auto: update` against a competing `init.sql`. | L — a migration project |
| 7 | AUDIT-Q1 | — | 249 `Objects.requireNonNull`, up 2 since filing. | L, mechanical |
| 8 | AUDIT-T1 | — | The "e2e" test isn't one, and the suite got more mocked. | L — wants `mock_router.md` |
| — | AUDIT-W1, W2 | L | Both re-ranked **[H] → [L]** by the sixth sitting. | S each |
| — | AUDIT-W3 | M | Half-defused by W10: light slots are 4 now, so only the heavy tier still stalls. | M |

**If you want one recommendation: do items 3 and 4 together (AUDIT-P6 and P8).** Both are pipeline
lifecycle state in Redis, both are the last two [M] findings outside the B5 migration project, and
P8 is [S]. That is the same shape as this sitting's W8+W9 pairing, which worked well. B8 and Q3 rank
above them only because they were filed with more bullets, not because they matter more.

**Do not start item 6 (AUDIT-B5) casually.** It is a schema-migration project — Flyway or Liquibase,
plus reconciling `init.sql` against whatever `ddl-auto: update` has actually produced live.

## Where the work stands

**Worker 301** (was 290; +11 new tests this sitting). All four gates green: `pytest -q`, `ruff
check`, `ruff format --check`, `pyright`.

**Backend: not re-run in full this sitting** — no backend source changed. `WorkerDispatcherServiceTest`
is 26/26 under `mvn -o clean test`. The last full-suite number is **399** from the seventh sitting
and should still hold. **Frontend 308**, untouched, no source or schema change.

Dependabot is unchanged: four PRs open, all four close-don't-merge. #60 okhttp (the pin is
load-bearing — read the comment in `pom.xml` first) and #52 springdoc are blocked outright; #51
testcontainers-bom 2.x and #40 TypeScript 7 are major-version projects of their own.

### Deployment

- **Backend live.** Unchanged this sitting; still running everything through the seventh.
- **Worker live.** `docker compose build worker && docker compose up -d worker` ran this sitting.
  Healthy, `providers.json v1 (4 providers, 4 active)`, no errors in the startup log. This deploys
  the seventh sitting's three worker fixes (jobId echo, lock fix, HEAD stale check) **and** this
  sitting's two.
- Nothing is pending deployment.

## Not mine — left alone deliberately

Two untracked files, concurrent work on the free-model benchmarking thread:

- `docs/Screenshot 2026-08-05 …OpenRouter.png`
- `scripts/benchmark_free_translation.py`

Every commit used an explicit pathspec, so neither was swept in.

## Carried forward — deliberately not done

Unchanged from the seventh sitting; each was left undone for a stated reason and those reasons hold.

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
  diff -U0` hunk ranges before believing the blast radius. **Reindexing is currently broken** — see
  the process notes above. Both HIGH ratings this sitting (`_build_payload`, `_parse_response`) were
  the expected fan-out of the LLM hot path, confirmed against the hunks; neither signature changed.
- **Running `analyze` rewrites the symbol counts in `CLAUDE.md` and `AGENTS.md`.** Keep that out of a
  feature commit — it gets its own `chore:` commit.
- **Never trust an incremental Maven run.** `mvn -o clean test-compile` after a signature or record
  arity change, and `mvn -o clean test` for any red-green check — see the process notes.
- **Close entries in `issues.md` in the same commit as the fix.** All three closed this sitting did.
- **Verify a fix red-green, and revert defects INDIVIDUALLY.** Six individual reverts for W8, four
  for W9. **Four times now** a test has passed for the wrong reason — check what your fixtures patch.
- **Read the whole `issues.md` entry before calling it closed.** W8's `:361` bullet had an unmentioned
  twin in the Anthropic branch; that is the fifth instance after P7, B3, B4 and B8.
- **One performance variable per change.** The delta has to be attributable.
- **Commit straight to `main`** — no feature branches. **Use a pathspec** (`git commit -- <paths>`):
  there is unrelated untracked work in the tree that must not be swept in.
- **Never run `prettier --write` outside a commit whose purpose is formatting.** `ci-npm.yml` gates
  on `format:check`; verify with `git diff -w`.
- **Frontend lint is `--report-unused-disable-directives --max-warnings 0`.** A warning fails the build.
- **Worker gates are four:** `pytest -q`, `ruff check .`, `ruff format --check .`, `pyright .`.
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
  worker` stages the pointer; include it in the parent commit's pathspec.
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
"2026-08-05 eighth sitting" section has what closed and why. Do not re-audit the
codebase and do not re-derive the run numbers — both are written down.

STATE: items 1-3 of the seventh sitting's board are done (AUDIT-W8, W9, T2),
each red-green verified, each closing its issues.md entry in the same commit.
issues.md remains trustworthy. 10 commits sit on local main, NOT pushed; the
worker submodule has its own with the pointer bumped. `git fetch` timed out last
sitting, so re-check ahead/behind before pushing.

DEPLOYMENT: backend and worker are both live and current. Nothing is pending.

BROKEN: `node .gitnexus/run.cjs analyze` aborted three times in a row with a
native-worker abort after a parse timeout — this is not the flake the old
handoff described. The index is stuck at 215ada4. Either run the documented
recovery (npm uninstall -g gitnexus && npm install -g gitnexus@latest, or Node
22 LTS) or work knowing impact()/detect_changes() are one commit stale.

NOT MINE: two untracked files (docs/Screenshot ...OpenRouter.png,
scripts/benchmark_free_translation.py) are concurrent work on the free-model
benchmarking thread. Leave them or commit them deliberately — every commit used
an explicit pathspec to avoid them.

WHAT I WANT

Work the ranked list in next-step.md, top down. The recommendation is items 3
and 4 together (AUDIT-P6 and P8): both are pipeline lifecycle state in Redis and
they are the last two [M] findings outside the B5 migration project.

Say plainly if a finding turns out stale or wrong when you actually read the
code — that has now paid off twelve times, including twice last sitting
(gemma4:e4b is a real tag, and AUDIT-T2's test already existed in the same
commit as the fix it pins).

CONSTRAINTS
- CLAUDE.md is binding: impact() before edits, detect_changes() before commits.
  Its CRITICAL/HIGH is usually the line-offset artefact — check `git diff -U0`
  hunk ranges. Reindexing is broken; see BROKEN above.
- Close the issues.md entry in the SAME commit as the fix.
- Verify red-green, and when an entry has several defects revert them
  INDIVIDUALLY. Four times now a test has passed for the wrong reason — check
  what your fixtures patch, and never trust a Maven run that isn't `clean`.
- Read the whole issues.md entry, not the headline. That is now five times a
  bullet the headline omitted turned out to be real work.
- Worker has FOUR gates: pytest, ruff check, ruff format --check, pyright.
- Commit to main directly, with a pathspec; worker/ is a submodule and needs
  its own commit plus a pointer bump.
- Frontend lint is --max-warnings 0 and CI gates on prettier --check.
- One performance variable per change.
- Security findings (AUDIT-S*) are tracked separately; don't fold them in.
```

<!-- markdownlint-enable MD031 MD040 -->
