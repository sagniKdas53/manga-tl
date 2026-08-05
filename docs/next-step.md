# Handoff — 2026-08-05 (seventh sitting)

> **Items 1–4 are done**, each verified red-green, each closing its `issues.md` entry in the same
> commit. That is AUDIT-P5, P7, W4 and W7 — including the one correctness defect on the board, which
> also completes AUDIT-P4's fix.
>
> **One finding was partly wrong** and is corrected rather than obeyed: AUDIT-W4 wanted the node id
> stripped from *every* Valkey lock key. That is right for `local-llm` and wrong for `ocr`. See
> [§ Where a finding was wrong](#where-a-finding-was-wrong).
>
> **The sixth sitting's docs were never committed.** They were sitting modified in the working tree
> while its own handoff recorded the tree as clean. Committed as-is in `355d8fe`, unchanged, before
> anything else.
>
> **Not pushed.** Six commits on local `main`, ahead of `github/main`. The worker submodule has
> three commits of its own, and its pointer is bumped in the parent.

## What closed this sitting

| # | id | sev | outcome |
| --- | --- | --- | --- |
| 1 | AUDIT-P5 | **H** | **Closed** (`3be57d4`). Completes AUDIT-P4. |
| 2 | AUDIT-P7 | M | **Closed** (`215ada4`). All three bullets, including the TTL. |
| 3 | AUDIT-W4 | M | **Closed** (`71cbad3` + worker `380c8f2`). One half of the finding corrected. |
| 4 | AUDIT-W7 | M | **Closed** (`71cbad3` + worker `0d2c6c6`). |

### 1. AUDIT-P5 — the guard was keyed off the thing it existed to make safe

The finding was accurate as filed, including its claim on P4, and it is worth restating because the
shape recurs: `claimCallback` ran the correct conditional `UPDATE … WHERE callback_applied_at IS
NULL`, but chose *which row* to claim with `findFirstByImageIdAndTypeOrderByCreatedAtDesc`. Claim
the wrong row and it both mis-marks that row **and** leaves the real one unclaimed — so the genuine
callback is free to apply twice. Two claims that should have collided both succeed, which is
precisely the failure P4 was closed to prevent. A correct guard on an ambiguous key is not a guard.

`jobId` was already minted at enqueue, already the row's primary key, and already in the worker
payload. It is now echoed back on all **12** callback-payload sites across the worker's 8 handlers,
and `resolveCallbackJob` prefers `findById`, falling back to the old query only when a callback
carries none — so an old worker and a new backend still interoperate. A `jobId` resolving to a row
of a *different type* is refused rather than claimed; that would mean the callback reached the wrong
endpoint, and acting on it would mis-mark an unrelated job.

The five `Map`-based handlers take `jobId` as a new first parameter with the previous arities kept
as delegating overloads — the idiom the file already used for the `pageId` retrofit, which kept
every existing test call site compiling.

### 2. AUDIT-P7 — two one-word fixes, and a third bullet worth reading for

Exactly as filed. `triggerPageRedo` wrote `page:{ocr,translation}:reason:{pageId}` and nothing
anywhere reads a page-scoped key; and its `delete("pipeline:trace:" + pageId)` named a key written
under **imageId**, so it was a no-op and the redo inherited the previous run's trace id.
`imageId` was already resolved one line above both statements.

The entry's third bullet — the reason keys are written with no TTL, so a pipeline that dies before
its callback leaves a key that mislabels the *next* run — was also real, and is fixed with
`REDO_REASON_TTL` (24h) at all six write sites. **This is the fourth time reading the whole entry
found work the headline did not mention.** Keep doing it.

### 3. AUDIT-W4 — see below, this one needed pushback

### 4. AUDIT-W7 — the HEAD had to be explicit

Accurate as filed. Worth recording *why* the obvious fix does not work: **Spring answers a HEAD
request by invoking the `@GetMapping` handler and discarding the body.** Switching the worker to
`requests.head` alone would have changed nothing — the presigned URL and every panel, region and
layer would still be built, then thrown away. It takes an explicit
`@RequestMapping(method = RequestMethod.HEAD)` on the same path, which Spring prefers over the GET
handler, to actually skip the work. The red-green check for this is to move the HEAD mapping off
the path and watch the request fall through to the GET handler.

## Where a finding was wrong

**AUDIT-W4 is right about `local-llm` and wrong about `ocr`.** The entry blames
`lock_key = f"lock:{lock_name}:{node_id}"` as such, so the literal fix is to drop the node id
everywhere. Do not.

- `local-llm` **must** be deployment-wide. `LOCAL_LLM_ENDPOINT` resolves to a *shared* address —
  the `ollama` compose service, or LM Studio on the host — so N workers each took their own lock and
  then hit the single instance concurrently. The lock did nothing.
- `ocr` **must stay per-container.** Its own comment says it serialises PP-OCR-Det and YOLO
  executing *on this host*, to avoid CPU/GPU overload and OOM. A deployment-wide `ocr` lock would
  serialise detection across the entire fleet — a throughput regression dressed as a bug fix.

So `acquire_lock` gained `node_scoped` (default `False`, the global behaviour the finding wants),
with `True` passed at the single `ocr` call site. The second defect — an unconditional `DELETE` in
`finally` that frees whatever lock exists, including one a different holder acquired after ours
expired — was real and is fixed with a random token plus a compare-and-delete Lua script.

**That is ten times a finding has turned out stale, wrong, or already fixed.** The habit pays.

## Two process notes worth keeping

- **`mvn -o test-compile` silently no-ops.** It reported `BUILD SUCCESS` over five real
  constructor-arity errors because it decided sources were unchanged. `mvn -o clean test-compile`
  caught them immediately. **Never trust an incremental Maven compile as evidence** that a signature
  change is consistent.
- **`node .gitnexus/run.cjs analyze` failed once with a native-worker abort and succeeded on a plain
  retry**, same tree, no change. If it aborts, retry before debugging it.

## The ranked list

Renumbered from the sixth sitting with 1–4 removed. Nothing below was re-derived — these are the
sixth sitting's verified entries, minus what closed.

| # | id | sev | what | size |
| --- | --- | --- | --- | --- |
| 1 | AUDIT-W8 | M | Anthropic gets no JSON enforcement at all; `content: null` → `TypeError`. Four bullets. | M |
| 2 | AUDIT-W9 | M | Ollama — the default local provider — is the one case that gets no JSON mode. Plus a four-way default mismatch. | S |
| 3 | AUDIT-T2 | — | One test, for P3's `break`-not-`continue`. | S |
| 4 | AUDIT-B8 | L | Eight verified bullets. `updateJobStatus` accepting arbitrary strings is the real one. | M, splittable |
| 5 | AUDIT-Q3 | L | Seven verified bullets. `isOverride`'s untrimmed `"inherit"` is now a shared predicate. | S–M |
| 6 | AUDIT-P6 | M | Lost `COMPLETED` PATCH re-runs the job. **Now smaller — see below.** | S–M |
| 7 | AUDIT-P8 | M | 2-hour trace TTL expires mid-pipeline. | S |
| 8 | AUDIT-D5 | L | Published DB/Valkey/console ports, `LOG_LEVEL=DEBUG`, `npm install` under an `npm ci` comment, no `MaxRAMPercentage`. | S–M |
| 9 | AUDIT-B5 | M | `ddl-auto: update` against a competing `init.sql`. | L — a migration project |
| 10 | AUDIT-Q1 | — | 249 `Objects.requireNonNull`, up 2 since filing. | L, mechanical |
| 11 | AUDIT-T1 | — | The "e2e" test isn't one, and the suite got more mocked. | L — wants `mock_router.md` |
| — | AUDIT-W1, W2 | L | Both re-ranked **[H] → [L]** by the sixth sitting. | S each |
| — | AUDIT-W3 | M | Half-defused by W10: light slots are 4 now, so only the heavy tier still stalls. | M |

**AUDIT-P6 shrank as a side effect of this sitting.** Its entry says the lost `COMPLETED` PATCH
leaves the job `PROCESSING` until the stale sweeper requeues it, "duplicating work per AUDIT-P4."
The duplicate result is now dropped on identity rather than on a guess, so what is left is the
*wasted re-run*, not corrupted data. It is still worth fixing; it is no longer a correctness defect.

**If you want one recommendation: do items 1 and 2 together.** Both are `LLMClient` payload
construction, both are provider-specific JSON enforcement, and doing them in one pass means reading
that builder once. They are the last two [M] worker findings.

**Do not start item 9 (AUDIT-B5) casually.** It is a schema-migration project — Flyway or Liquibase,
plus reconciling `init.sql` against whatever `ddl-auto: update` has actually produced live. Ranked
low only because nothing is currently broken by it.

## Where the work stands

Suites, all re-run this sitting: **backend 399** (was 395; +4 new tests), **worker 290** (was 284;
+6), **frontend 308** (unchanged — no frontend source changed, only the regenerated schema).

**Dependabot is unchanged:** four PRs open, all four close-don't-merge. #60 okhttp (the pin is
load-bearing — read the comment in `pom.xml` first) and #52 springdoc are blocked outright; #51
testcontainers-bom 2.x and #40 TypeScript 7 are major-version projects of their own.

### Deployment — read this before assuming the fixes are live

- **The backend is live.** It was rebuilt and restarted twice this sitting (the OpenAPI regen needed
  it), so it is running everything above, *plus* the fifth sitting's two frontend commits, which
  were pending deployment for two sittings and are now deployed.
- **The worker is NOT live.** All three worker commits — the `jobId` echo, the lock fix, the HEAD
  stale check — need `docker compose build worker && docker compose up -d worker`. **Nothing breaks
  in the meantime:** the backend falls back to the old query when a callback carries no `jobId`, and
  the GET handler the old worker still calls is untouched. But none of the three fixes take effect
  until that rebuild.

### `schema.d.ts` had pre-existing drift

The first regen picked up `layerType`, `layerVisible` and `regionType` on `LayerElement` — nothing
to do with this sitting. They came from `c3fa119`, which added the JSON properties to the model and
never ran `npm run generate-api`. Harmless, and now corrected. It is the exact drift `CLAUDE.md`'s
OpenAPI rule exists to prevent, and it went unnoticed for several sittings, so **a periodic
`npm run generate-api` with no backend change is worth doing** just to see whether the diff is
empty.

## Not mine — left alone deliberately

The working tree has four changes this sitting did not make and did not touch:

- `TODO.md` — a sample-image reference swapped to `page-2-export(2).png`.
- `examples/sample4/en-our-version.png` — deleted.
- `docs/render_quality_gap_2026-08-05.md` — new, untracked.
- `scripts/render_quality_metrics.py` — new, untracked.

All four appeared during the sitting and look like concurrent work on the render-quality thread.
Every commit here used an explicit pathspec, so none of them were swept in.

## Carried forward — deliberately not done

Unchanged from the sixth sitting; each was left undone for a stated reason and those reasons hold.

- **The cross-provider fallback rule has not reached `ocr.py` and `qa.py`.** AUDIT-W11 established it
  for translation and `is_provider_auth_parked()` is in place for the others. Left alone because the
  failure was only ever measured on translation, and a speculative sweep is the opposite of
  one-variable-per-change.
- **The exported ZIP's pixel content is unverified.** The archive opens under test, but jsdom has no
  canvas so those PNG bytes are placeholders. Needs a real browser.
- **`BUBBLE_CONTOUR_FALLBACK` is compensation, not a feature.** `TODO.md` carries the removal
  checkpoint and the baseline numbers. A *bigger* YOLO is not the detector that replaces it — see
  archive.md F.1.
- **The `neurometric` key in `secrets/api_keys.json` is still dead.** AUDIT-W11 made this
  housekeeping rather than an outage: a chapter pinned to it escapes to the global provider.
- **A scan for other `@Transactional` self-invocations has not been done.** AUDIT-B2 was the known
  instance and is fixed, but the class of bug is invisible at the call site and this codebase has hit
  an annotation-binding failure three times.
- **`NotificationController.currentUser` throws `RuntimeException("Unauthorized")`**, so it is still
  a 500. Making it a 401/403 is its own change.
- **`Reader.tsx` guards on `.delete-page-btn` and `.reorder-controls`** in its canvas-pan handlers.
  Provably dead since `b951ee2` removed the class names. Left in place because that file is
  AUDIT-F2's.
- **`PageService`'s "variant not smaller" branch is uncovered.** Forcing it needs a contrived
  incompressible fixture. Not worth one.
- **The larger frontend items** — AUDIT-F1 (theme → `colorSchemes` + `cssVariables`, bundle with the
  next MUI major), AUDIT-F2 (`Reader.tsx` at 3,954 lines / 28 `useState`; the profile says *split the
  component*, which is a project), AUDIT-F8 (pagination — decide the library-size ceiling first, and
  if a few hundred series is the cap, close it instead of building it), AUDIT-F9 (Playwright viewport
  smoke test — wants the same real-browser infrastructure as the ZIP-pixel item).

## Out of scope unless deliberately reopened

- **The worker pull model.** Measured at 408 s of 49,058 s of queue wait (0.83%). Build it for
  latency, resilience and multi-worker scaling — never for throughput.
- **AUDIT-S\*** — security is tracked separately, don't fold it in.
- **A reader downscale cap.** A 3000 px long-edge cap hits 124 images and saves a further 46 MB.
  Real but secondary, and a second performance variable.
- **AUDIT-W5**, and re-deriving the queue-wait share. Both settled; see archive.md.

## Working constraints

- **`CLAUDE.md` is binding.** `impact({target, direction:"upstream", repo:"manga-library"})` before
  editing any symbol, report HIGH/CRITICAL, `detect_changes()` before committing.
  **`detect_changes` attributes by line offset**, so a large insertion flags untouched symbols below
  it — check `git diff -U0` hunk ranges before believing the blast radius, and **reindex first**
  (`node .gitnexus/run.cjs analyze`; retry once if it aborts in a native worker). Both CRITICAL
  ratings this sitting were the expected fan-out of the change plus that artefact, confirmed against
  the hunks.
- **Running `analyze` rewrites the symbol counts in `CLAUDE.md` and `AGENTS.md`.** Keep that out of a
  feature commit — it gets its own `chore:` commit.
- **`mvn -o test-compile` can silently skip recompiling and report success.** Use `mvn -o clean
  test-compile` when a signature or record arity changed.
- **Close entries in `issues.md` in the same commit as the fix.** Nine entries were found
  fixed-but-open before the 2026-08-05 verification pass; all four closed this sitting followed the
  rule.
- **Verify a fix red-green.** Break it, watch the test fail, restore it. **Three times** a failing
  test has turned out to be pinning a bug rather than the behaviour — and twice this sitting a test
  passed for the *wrong reason* until the defects were reverted one at a time. When an entry has two
  defects, revert them **individually**.
- **Read the whole `issues.md` entry before calling it closed.** P7's third bullet was real work the
  headline did not mention; B3, B4, W8 and B8 each bundled sub-findings the same way.
- **One performance variable per change.** The delta has to be attributable.
- **Commit straight to `main`** — no feature branches. **Use a pathspec** (`git commit -- <paths>`):
  a bare `git commit` takes everything already staged, and there is currently unrelated work in the
  tree that must not be swept in.
- **Never run `prettier --write` outside a commit whose purpose is formatting.** The repo is
  Prettier-clean and `ci-npm.yml` gates on `format:check`; verify with `git diff -w`.
- **Frontend lint is `--report-unused-disable-directives --max-warnings 0`.** A warning fails the
  build.
- **Worker gates are four:** `pytest -q`, `ruff check .`, `ruff format --check .`, `pyright .` — the
  last two are CI gates and both catch things (`SIM117`, and a `float`/`int` parameter mismatch, this
  sitting). Run all four.
- **`.env` is gitignored and overrides `docker-compose.yml` defaults.** Verify with
  `docker compose config | grep -E 'CONCURRENT_JOBS|MAX_(HEAVY|LIGHT)_SLOTS'` before trusting a run.
- The frontend compiles **into** the backend image, so any frontend change needs
  `docker compose build backend && docker compose up -d backend` (~10 min).
- Backend API changes require `npm run generate-api` from `frontend/` with the backend container up.
  It honours `API_DOCS_URL`. **Adding a `HEAD` mapping changes the spec too**, not just DTO fields.
- Backend build is Maven (`mvn -o test`, no wrapper) **and must be run from `backend/`**. Frontend is
  `npx vitest run` / `npx tsc --noEmit` / `npm run lint` / `npm run format:check`.
- **`worker/` is a git submodule.** Changes need their own commit plus a pointer bump. `git add
  worker` stages the pointer; include it in the parent commit's pathspec.
- **The local `.venv` is Python 3.13.12 / numpy 2.3.5** and matches the image. It is at the repo
  root, not in `worker/`; run the worker suite as `cd worker && ../.venv/bin/python -m pytest -q`.
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
"2026-08-05 seventh sitting" section has what closed and why; the verification
pass section below it has everything closed on 2026-08-05. Do not re-audit the
codebase and do not re-derive the run numbers — both are written down.

STATE: items 1-4 of the sixth sitting's board are done (AUDIT-P5, P7, W4, W7),
each red-green verified, each closing its issues.md entry in the same commit.
issues.md remains trustworthy. Six commits sit on local main, NOT pushed; the
worker submodule has three of its own with its pointer bumped.

DEPLOYMENT: the backend IS live with all of this. The worker is NOT — it needs
`docker compose build worker && docker compose up -d worker`. Nothing breaks
meanwhile (the backend falls back when a callback carries no jobId), but none
of the three worker fixes take effect until then.

NOT MINE: TODO.md, examples/sample4/en-our-version.png, and two untracked files
(docs/render_quality_gap_2026-08-05.md, scripts/render_quality_metrics.py)
are concurrent work from outside the sitting. Leave them or commit them
deliberately — every commit used an explicit pathspec to avoid them.

WHAT I WANT

Work the ranked list in next-step.md, top down. The recommendation is items 1
and 2 together (AUDIT-W8 and W9): both are LLMClient payload construction and
provider-specific JSON enforcement, so one read of that builder covers both.
They are the last two [M] worker findings.

Say plainly if a finding turns out stale or wrong when you actually read the
code — that has now paid off ten times, including once this sitting (AUDIT-W4
wanted the node id stripped from every lock key; that is correct for local-llm
and a throughput regression for ocr).

CONSTRAINTS
- CLAUDE.md is binding: reindex, impact() before edits, detect_changes() before
  commits. Its CRITICAL/HIGH is usually the line-offset artefact — check
  `git diff -U0` hunk ranges. `analyze` rewrites symbol counts in CLAUDE.md and
  AGENTS.md — keep that in its own chore commit, and retry analyze once if it
  aborts in a native worker.
- Close the issues.md entry in the SAME commit as the fix.
- Verify red-green, and when an entry has two defects revert them INDIVIDUALLY
  — twice this sitting a test passed for the wrong reason otherwise.
- Read the whole issues.md entry, not the headline. P7's third bullet was real
  work the headline did not mention; that is now four times.
- `mvn -o test-compile` silently no-ops and reports success. Use `clean
  test-compile` after any signature or record-arity change.
- Worker has FOUR gates: pytest, ruff check, ruff format --check, pyright.
- Commit to main directly, with a pathspec; worker/ is a submodule and needs
  its own commit plus a pointer bump. `git fetch` before assuming ahead-only.
- Frontend lint is --max-warnings 0 and CI gates on prettier --check.
- One performance variable per change.
- Security findings (AUDIT-S*) are tracked separately; don't fold them in.
```

<!-- markdownlint-enable MD031 MD040 -->
