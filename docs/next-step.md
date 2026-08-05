# Handoff — 2026-08-05 (sixth sitting)

> **The board is ranked again.** The fifth sitting ended with an empty list and two unranked piles.
> This sitting did the verification pass that `Where to go next` recommended, and it paid: **six
> findings were already fixed while still marked open**, one high-severity item had **fallen off the
> board entirely**, and one entry's remaining work turned out to be a single test rather than a
> project.
>
> `issues.md` went **1,262 → ~700 lines**. Everything closed is now in
> [archive.md](./archive.md) under *"The 2026-08-05 verification pass"*, verbatim, in a `<details>`
> block. What is left in `issues.md` is open **as of 2026-08-05 and verified against the tree** —
> for the first time, its status can be trusted on its own.
>
> **No code changed this sitting.** Docs only. Working tree otherwise clean.

## What this sitting did

A read of the actual code behind every open entry in `issues.md`, then archiving. No fixes, by
design — the point was to make the remainder schedulable.

### Already fixed, still marked open

| id | sev | filed as | actually |
| --- | --- | --- | --- |
| AUDIT-P1 | H | `resolveConfigForChapter` passes `translation`/`qa` as provider task keys | Fixed. `:646-655` passes `tl` / `qaLLM` / `qaVLM`, with a comment naming AUDIT-P1. |
| AUDIT-P4 | H | job recovery re-runs in-flight work; callbacks not idempotent | Fixed. `callback_applied_at` + `claimCallback`'s conditional UPDATE guards **all seven** handlers. |
| AUDIT-W6 | M | slot maths can compute to zero or negative, unvalidated | Fixed. `resolve_slot_config` clamps and warns; its docstring quotes the finding's own examples. |
| AUDIT-W10 | C | `MAX_LIGHT_SLOTS=1` serialises four workloads | Fixed by config. Compose is `CONCURRENT_JOBS=5` with light deriving to 4. |
| AUDIT-W8 | M | Anthropic `max_tokens` hardcoded 4096 (1 of 5 bullets) | Fixed → `DEFAULT_MAX_OUTPUT_TOKENS`. Other four bullets stand. |
| AUDIT-B8 | L | `JwtAuthFilter` double-registered (1 of 9 bullets) | Fixed → `FilterRegistrationBean(setEnabled(false))`. Other eight stand. |

That is **six in one pass**, on top of AUDIT-B6, AUDIT-D1 and P9's wrong mechanism from earlier
sittings. The working constraint about not trusting `issues.md`'s status has now been earned nine
times. It should be *retired* rather than repeated — the file is trustworthy as of today, and the
way to keep it that way is to close entries when the fix lands, in the same commit.

### The one that fell off the board

**AUDIT-P4 was never in the fifth sitting's backlog table** — neither closed nor listed. Nor were
P1, W1, W2, W6 or W10. The table carried 17 entries; `issues.md` had 23 open. Six went missing in
the copy, and one of them was the file's own "the one correctness defect measurably costing work."

It happens to have been fixed already. The next one might not be. **Generate the board from
`issues.md` rather than hand-copying it**, or at minimum diff the two before trusting the short list.

### AUDIT-P4's residual is AUDIT-P5, and it undermines P4's fix

This is the finding worth carrying, and it is why P5 moves to the top of the list.

`claimCallback` makes callbacks idempotent with `UPDATE Job SET callback_applied_at = :now WHERE id
= :id AND callback_applied_at IS NULL`. But it chooses *which row to claim* with
`findFirstByImageIdAndTypeOrderByCreatedAtDesc` (`:709`) — the newest job of that type for that
image, which is exactly the guess AUDIT-P5 is about.

**So the idempotency guard is keyed off the ambiguous identifier it exists to make safe.** Claim the
wrong row and it both mis-marks that row *and* leaves the real one unclaimed — so the genuine
callback is free to apply twice, which is the precise failure P4 was closed to prevent. Two claims
that should collide instead both succeed.

`jobId` is already minted, already stored as the row's primary key, and already in the worker's
payload (`:317-327`). Threading it through the callback DTOs fixes P5 and completes P4 in one change.

### AUDIT-T2 shrank to one test

The entry says "none of the dispatcher's failure paths are exercised, so AUDIT-P2 and AUDIT-P3 have
no test to fail." `WorkerDispatcherServiceTest.java` is now **639 lines** covering
`PermanentRejection_400`/`_422` (P2's paths), `MultipleWorkers_AllFail`, `ServerError500`,
`CapabilitiesQueryFails`, `AllWorkersInCooldown` and `LightSlotFull`. Those arrived with P2's and
P3's fixes; nobody updated the note. What is left is a test for P3's `break`-not-`continue`, and
that is one test.

### AUDIT-T1 went the wrong way

The only entry that got *worse* on its own. Filed at 320 `@patch` across 46 files; now **342 across
49**. `test_translation_flow_e2e.py` is **19 `@patch` against 4 `assert`s**. The two tests added
since it was filed have the same shape as the ones it criticises.

## The ranked list

Verified against the code on 2026-08-05. Sizes are honest; nothing here is speculative.

| # | id | sev | what | size |
| --- | --- | --- | --- | --- |
| 1 | AUDIT-P5 | **H** | Thread `jobId` through the callback DTOs. Completes P4. | M — needs OpenAPI regen |
| 2 | AUDIT-P7 | M | Page-redo writes `page:*:reason:` keys nothing reads, and deletes `pipeline:trace:{pageId}` which is stored under imageId. Two one-word fixes. | S |
| 3 | AUDIT-W4 | M | Valkey lock keyed per-container, so it serialises nothing; `finally` deletes other holders' locks. | S–M |
| 4 | AUDIT-W7 | M | Stale-job check: no timeout, on the heaviest endpoint, once per job. | S |
| 5 | AUDIT-W8 | M | Anthropic gets no JSON enforcement at all; `content: null` → `TypeError`. | M |
| 6 | AUDIT-W9 | M | Ollama — the default local provider — is the one case that gets no JSON mode. Plus a four-way default mismatch. | S |
| 7 | AUDIT-T2 | — | One test for P3's `break`. | S |
| 8 | AUDIT-B8 | L | Eight verified bullets. `updateJobStatus` accepting arbitrary strings is the real one. | M, splittable |
| 9 | AUDIT-Q3 | L | Seven verified bullets. `isOverride`'s untrimmed `"inherit"` is now a shared predicate. | S–M |
| 10 | AUDIT-P6 | M | Lost `COMPLETED` PATCH re-runs the job. Overlaps P5. | M |
| 11 | AUDIT-P8 | M | 2-hour trace TTL expires mid-pipeline. | S |
| 12 | AUDIT-D5 | L | Published DB/Valkey/console ports, `LOG_LEVEL=DEBUG`, `npm install` under an `npm ci` comment, no `MaxRAMPercentage`. | S–M |
| 13 | AUDIT-B5 | M | `ddl-auto: update` against a competing `init.sql`. | L — a migration project |
| 14 | AUDIT-Q1 | — | 249 `Objects.requireNonNull`, up 2 since filing. | L, mechanical |
| 15 | AUDIT-T1 | — | The "e2e" test isn't one, and the suite got more mocked. | L — wants `mock_router.md` |
| — | AUDIT-W1, W2 | L | Both re-ranked **[H] → [L]**, applying corrections their own bodies already carried. | S each |
| — | AUDIT-W3 | M | Half-defused by W10: light slots are 4 now, so only the heavy tier still stalls. | M |

**If you want one recommendation: do items 1–4.** Item 1 is the only correctness defect on the list
and it closes a fix that is currently incomplete. Items 2–4 are small, verified, and independent of
each other. That is a coherent sitting.

**Do not start item 13 (AUDIT-B5) casually.** It is a schema-migration project — Flyway or
Liquibase, plus reconciling `init.sql` against whatever `ddl-auto: update` has actually produced in
the live database. It is correctly ranked low only because nothing is currently broken by it.

## Where the work stands

Suites: **frontend 308**, **worker 284**, **backend 395**. **None re-run this sitting** — no code
changed. The numbers are carried from the fifth sitting.

**Dependabot is unchanged:** four PRs open, all four close-don't-merge. #60 okhttp (the pin is
load-bearing — read the comment in `pom.xml` first) and #52 springdoc are blocked outright; #51
testcontainers-bom 2.x and #40 TypeScript 7 are major-version projects of their own.

**Deployment:** the fifth sitting's two frontend commits are pushed but **not live**. The frontend
compiles into the backend image, so they need `docker compose build backend && docker compose up -d
backend` (~10 min). This sitting adds nothing to that.

## Carried forward — deliberately not done

Unchanged from the fifth sitting; each was left undone for a stated reason and those reasons hold.

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
  (`node .gitnexus/run.cjs analyze`). It has earned its keep once, catching a duplicated
  `pipelineStages` chain. Read the list; verify it against the hunks.
- **Running `analyze` rewrites the symbol counts in `CLAUDE.md` and `AGENTS.md`.** Keep that out of a
  feature commit.
- **Close entries in `issues.md` in the same commit as the fix.** Nine entries have now been found
  fixed-but-open. The verification pass on 2026-08-05 made the file trustworthy; only this habit
  keeps it that way.
- **Generate the ranked board from `issues.md`, don't hand-copy it.** The fifth sitting's table
  silently dropped six entries, one of them the highest-severity open item in the file.
- **Verify a fix red-green.** Break it, watch the test fail, restore it. **Three times** a failing
  test has turned out to be pinning a bug rather than the behaviour.
- **Read the whole `issues.md` entry before calling it closed.** B3, B4, W8 and B8 each bundled
  sub-findings the headline did not mention — W8 and B8 each had exactly one bullet already fixed.
- **One performance variable per change.** The delta has to be attributable.
- **Commit straight to `main`** — no feature branches. **Use a pathspec** (`git commit -- <paths>`):
  a bare `git commit` takes everything already staged.
- **Never run `prettier --write` outside a commit whose purpose is formatting.** The repo is
  Prettier-clean and `ci-npm.yml` gates on `format:check`; verify with `git diff -w`.
- **Frontend lint is `--report-unused-disable-directives --max-warnings 0`.** A warning fails the
  build.
- **`.env` is gitignored and overrides `docker-compose.yml` defaults.** Verify with
  `docker compose config | grep -E 'CONCURRENT_JOBS|MAX_(HEAVY|LIGHT)_SLOTS'` before trusting a run.
  Compose now defaults to `CONCURRENT_JOBS=5` with both `MAX_` values blank (light derives to 4);
  `.env` may still pin the older `4 / 1 / 3`.
- The frontend compiles **into** the backend image, so any frontend change needs
  `docker compose build backend && docker compose up -d backend` (~10 min).
- Backend API changes require `npm run generate-api` from `frontend/` with the backend container up.
  It honours `API_DOCS_URL`, defaulting to the previous hardcoded URL. **Item 1 on the list needs
  this.**
- **`worker/` is a git submodule.** Changes need their own commit plus a pointer bump in the parent.
- Backend build is Maven (`mvn -o test`, no wrapper) **and must be run from `backend/`**. Frontend is
  `npx vitest run` / `npx tsc --noEmit` / `npm run lint` / `npm run format:check`. Worker is
  `python3 -m pytest -q`, `ruff check .`, `ruff format --check .` and `pyright .` — the last two are
  CI gates. Worker CI runs Python 3.13 as of `0123ca6`.
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
Continuing manga-library. Read docs/next-step.md first. If you need more
history, docs/archive.md's "2026-08-05 verification pass" section has every
entry that was closed, verbatim. Do not re-audit the codebase and do not
re-derive the run numbers — both are written down.

THE BOARD IS RANKED AGAIN. The 2026-08-05 verification pass read the code
behind every open entry in issues.md and archived the closed ones. issues.md
went 1,262 -> ~700 lines and its status is TRUSTWORTHY AS OF 2026-08-05 —
that is new, and it is the first time that has been true.

Six entries were found already-fixed while still marked open: AUDIT-P1,
AUDIT-P4, AUDIT-W6, AUDIT-W10, one bullet of AUDIT-W8 and one of AUDIT-B8.
AUDIT-T2's backend half was re-scoped by fixes that landed elsewhere. Do not
reopen any of them.

STATE: working tree clean, main pushed. No code changed in the last sitting —
docs only. The fifth sitting's two frontend commits are pushed but NOT live
until `docker compose build backend && docker compose up -d backend` (~10 min).

WHAT I WANT

Work the ranked list in next-step.md, top down. Items 1-4 are the recommended
sitting — item 1 is the only correctness defect on the list, and 2-4 are small
and independent.

Item 1 (AUDIT-P5) is the important one and the reason it is ranked first:
AUDIT-P4 is closed, but claimCallback picks which row to claim using
findFirstByImageIdAndTypeOrderByCreatedAtDesc — the exact guess P5 is about.
The idempotency guard is keyed off the ambiguous identifier it exists to make
safe. jobId is already the row's primary key and already in the worker payload;
threading it through the callback DTOs fixes P5 and completes P4. It changes
the OpenAPI spec, so it needs a backend rebuild + `npm run generate-api`.

Say plainly if a finding turns out stale or wrong when you actually read the
code — that has now paid off nine times.

CONSTRAINTS
- CLAUDE.md is binding: reindex, impact() before edits, detect_changes() before
  commits. Its CRITICAL/HIGH is usually the line-offset artefact — check
  `git diff -U0` hunk ranges. Note `analyze` rewrites symbol counts in CLAUDE.md
  and AGENTS.md — keep that out of a feature commit.
- Close the issues.md entry in the SAME commit as the fix. Nine entries have
  now been found fixed-but-open; that is the habit that prevents it.
- Verify red-green. Three times a failing test has been pinning a bug rather
  than the behaviour, so read what a test asserts before trusting it.
- Commit to main directly, with a pathspec; worker/ is a submodule and needs
  its own commit plus a pointer bump. `git fetch` before assuming this branch
  is ahead-only.
- Frontend lint is --max-warnings 0 and CI gates on prettier --check.
- One performance variable per change.
- Security findings (AUDIT-S*) are tracked separately; don't fold them in.
```

<!-- markdownlint-enable MD031 MD040 -->
