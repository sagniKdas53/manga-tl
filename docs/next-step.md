# Handoff — 2026-08-05 (fifth sitting)

> **The list is empty.** Both items on the fourth-sitting board are closed, each in one commit,
> each verified red-green. The local `.venv` is rebuilt on Python 3.13 and the worker suite has
> been re-run on it. Nothing on the ranked list remains.
>
> What is left is the **unverified backlog** and the **carried-forward** section — neither has ever
> been a ranked list, and both need a judgement call about what is worth doing before anything is
> picked up. See [§ Where to go next](#where-to-go-next).
>
> **Not pushed.** Two commits sit on local `main` ahead of `github/main`. Everything else is clean.

## What closed this sitting

| item | outcome |
| --- | --- |
| `ReaderRightSidebar`'s MUI miss | **Closed** (`5b721c0`). Bigger than its headline — see below. |
| The transitioning state for queued jobs | **Closed** (`6876723`). Decided *and* implemented. |
| Local `.venv` on the wrong interpreter | **Closed.** Rebuilt on 3.13.12 / numpy 2.3.5. |

### 1. `ReaderRightSidebar` — it was not only a styling miss

The 11 raw `<label>`s and 8 `<span>`s are gone, but reading them turned up a real defect the board
had not recorded: **not one of the 11 labels carried `htmlFor`**. A `<label>` that is only a sibling
of its input associates with nothing, so every number box and dropdown in the inspector reached
assistive technology unnamed. The styling swap alone would have preserved that bug perfectly.

Three things worth carrying forward:

- **`htmlFor` does not work on `Select` or `Slider`.** Only labelable elements (`input`, `select`,
  `textarea`, `button`, `meter`, `output`, `progress`) associate that way, and MUI's non-native
  `Select` renders a `div[role=combobox]`. Those four use `labelId` and the `Slider` uses
  `aria-labelledby`, both pointing back at the label's `id`. The six real text fields use
  `htmlFor`/`id`.
- **`sx` is not a free swap for `style` against a plain CSS class either.** The four `.meta-badge`
  tints were inline styles, which always beat the class. As plain `sx` they would only win on
  emotion happening to inject after `index.css` — injection order, not a rule, and this app sets no
  `injectFirst`. The rule is scoped to `&.meta-badge`, making specificity (0,2,0) against (0,1,0),
  which wins outright. It matters most for the `capitalize` badge, which directly contradicts the
  class's `text-transform: uppercase`. **This is a second, distinct way `sx` is not `style`** — the
  ColorPicker lesson was about per-frame values; this one is about the cascade.
- `FieldLabel` and `MetaBadge` now live in the file's "Shared presentational helpers" section,
  which had been sitting there empty.

### 2. The transitioning state — derived, and the derivation was the bug

The open question was where the state should live. **It stays a derived display value**, and
`fetchJobs` settles why: a queue row is a **pipeline projection, not a job row**. It keys by
`imageId` and keeps only the newest job per image, so stage N+1 *replaces* stage N in place.
"Transitioning" describes the gap between two rows, so there is no row to store it on — and it is a
pure function of `job.type`, so a status column would buy nothing while adding a second write to
clear it, which is one more way for a row to get stuck.

**What was actually wrong was the derivation.** `getDisplayStatus` relabelled *every* `COMPLETED`
job as `TRANSITIONING...`, so the end of a pipeline was unreadable: a finished `qa` — the whole
chapter done — announced itself as mid-flight for the ten seconds before the row was pruned, as did
the one-shot `region-redo-*` jobs that nothing follows. Rows now name their successor
(`TRANSITIONING → LAYOUT`) and terminal stages read `COMPLETED`.

The successor is read off the **existing `pipelineStages` array** rather than a second copy of the
chain — `detect_changes` surfaced that duplication, which is the first time it has caught something
real rather than a line-offset artefact. `qa-re-ocr` is the one detour, rejoining at `translation`.

**Known imprecision, deliberately left:** `render` only enqueues `qa` when the page has no manual
edits, so a hand-edited page reads `TRANSITIONING → QA` until the row is pruned. Telling those apart
needs an edit flag the queue payload does not carry.

### 3. The `.venv`

Was Python 3.10.12 / numpy 2.2.6 against an image on 3.13 — the same class of bug as the CI
mismatch, so local `pytest` had never run on the production stack. Rebuilt on **3.13.12 / numpy
2.3.5**: numpy now matches the image exactly and the interpreter to the patch (image is 3.13.14).
Re-verified on the new stack: **worker 284 passed, `ruff check` clean, `ruff format` clean,
`pyright` 0 errors.** The superseded 3.10 venv was deleted.

## Where the work stands

Closed threads — do not reopen without a measurement that contradicts the file. Everything in the
fourth-sitting table still holds; see [archive.md](./archive.md) for the detail. Added to it:

| thread | outcome |
| --- | --- |
| `ReaderRightSidebar` MUI + label association | **Closed 2026-08-05** (`5b721c0`). |
| The transitioning state | **Closed 2026-08-05** (`6876723`). Derived, not a job status. |
| Local `.venv` interpreter mismatch | **Closed 2026-08-05.** 3.13.12 / numpy 2.3.5. |

Suites: **frontend 308** (was 306; +2 this sitting) and **worker 284**, both re-run and green.
**Backend was not re-run** — nothing this sitting touched `backend/`, and it stood at 395.

**Dependabot is unchanged:** four PRs open, all four close-don't-merge. #60 okhttp (the pin is
load-bearing — read the comment in `pom.xml` first) and #52 springdoc are blocked outright; #51
testcontainers-bom 2.x and #40 TypeScript 7 are major-version projects of their own.

## Where to go next

Nothing is ranked any more, and that is the honest state. Two bodies of work remain, and picking
between them is a judgement call rather than a queue pop:

1. **The unverified backlog below.** Open in `issues.md`, never re-checked against the code. This is
   the larger and more likely-valuable pile, but **expect some of it to be stale** — AUDIT-B6 and
   AUDIT-D1 were both already fixed while still marked open, and P9's filed mechanism was wrong.
   The cheapest first move is a verification pass that reads the code for each entry and closes what
   is already done, *before* any of it is scheduled.
2. **The carried-forward items.** Each was left undone for a stated reason and those reasons mostly
   still hold. Two of them — the ZIP pixel check and AUDIT-F9 — want the same real-browser
   infrastructure and would sensibly land together.

If you want a single recommendation: **do the verification pass on the backlog first.** It is the
only task here whose size is known, and it makes everything after it schedulable.

## The unverified backlog

Open in `issues.md`, **not re-checked against the code**. Verify before starting, and say so if the
finding turns out stale.

| id | sev | one line |
| --- | --- | --- |
| AUDIT-P5 | M | Callbacks resolve "which job" by guessing instead of by `jobId`. Adding the field changes the OpenAPI spec, so it needs a rebuild + `generate-api`. |
| AUDIT-P6 | M | A lost `COMPLETED` PATCH silently re-runs the whole job. |
| AUDIT-P7 | M | Page-scoped Redis keys are written and never read. |
| AUDIT-P8 | M | `pipeline:trace` expires mid-pipeline on slow runs. |
| AUDIT-W3 | M | Cooldowns and lock waits burn a job slot doing nothing. |
| AUDIT-W4 | M | The Valkey lock is per-container and releases other holders' locks. |
| AUDIT-W7 | M | The stale-job check hammers the heaviest endpoint, without a timeout. |
| AUDIT-W8 | M | Provider payload defects in `LLMClient`. |
| AUDIT-W9 | M | Local JSON mode is not actually enforced. |
| AUDIT-B5 | M | Schema is managed by `ddl-auto: update` with a competing `init.sql`. |
| AUDIT-B8 | L | Assorted backend defects. The `JwtAuthFilter` double-registration is already done; the rest — `WORKER_URLS` port 9091 vs 8000, `jwtExpirationMs` as an `int`, `DEBUG_TL` logging at INFO, unvalidated status strings, `pages.get(0)` in `resolveNotificationContext` — are not. |
| AUDIT-D5 | L | Remaining infrastructure items. |
| AUDIT-T1 | — | The "e2e" test is not an e2e test. |
| AUDIT-T2 | — | The error branches, which is where the bugs are, have no coverage. |
| AUDIT-Q1 | — | 247 `Objects.requireNonNull` calls, most impossible to trigger. |
| AUDIT-Q2 | — | LLM thinking-out-loud committed as comments. |
| AUDIT-Q3 | — | Vestigial and misleading code. |

## Carried forward — deliberately not done

Not tasks, but not forgotten either. Each was left undone for a stated reason.

- **The cross-provider fallback rule has not reached `ocr.py` and `qa.py`.** AUDIT-W11 established it
  for translation and `is_provider_auth_parked()` is in place for the others. Left alone because the
  failure was only ever measured on translation, and a speculative sweep is the opposite of
  one-variable-per-change.
- **The exported ZIP's pixel content is unverified.** The archive opens under test, but jsdom has no
  canvas so those PNG bytes are placeholders. How an exported page actually *looks* has never been
  checked and needs a real browser.
- **`BUBBLE_CONTOUR_FALLBACK` is compensation, not a feature.** `TODO.md` carries the removal
  checkpoint and the baseline numbers to re-measure against, for when a detector lands that finds
  irregular bubbles directly. A *bigger* YOLO is not that detector — see archive.md F.1.
- **The `neurometric` key in `secrets/api_keys.json` is still dead.** AUDIT-W11 changed what that
  costs: a chapter pinned to it now escapes to the global provider instead of failing 100% of its
  translations. Housekeeping now, not an outage.
- **A scan for other `@Transactional` self-invocations has not been done.** AUDIT-B2 was the known
  instance and is fixed, but the class of bug is invisible at the call site and this codebase has now
  hit an annotation-binding failure three times. A mechanical pass over `this.`-prefixed calls to
  annotated methods would settle it.
- **`NotificationController.currentUser` throws `RuntimeException("Unauthorized")`**, so it is still
  a 500 — now with a generic detail rather than a leaked message. Making it a 401/403 is its own
  change; noted while closing AUDIT-B3.
- **`Reader.tsx` guards on `.delete-page-btn` and `.reorder-controls`** in its canvas-pan handlers.
  Those selectors never matched anything — `ChapterPageGrid` only mounts in `ChapterGallery`, never
  inside the Reader — and `b951ee2` removed the class names, so they are now provably dead. Left in
  place because that file is AUDIT-F2's.
- **`PageService`'s "variant not smaller" branch is uncovered.** A 4×4 PNG re-encodes *smaller*, so
  forcing that branch needs a contrived incompressible fixture. Not worth one.
- **The larger frontend items are deliberately not on the list.** Each is a multi-sitting refactor
  whose payoff-per-line loses to everything above, and two of them want the profiler first:
  - **AUDIT-F1** — migrate the theme to `colorSchemes` + `cssVariables`. Also removes the `mode`
    prop drilled into `Dashboard`, `ChapterGallery` and `Reader`, and the ~20 ternaries in
    `theme.ts`. Bundle it with the next MUI major, not before. *Note `theme.test.ts` pins contrast
    per mode; that migration must keep it passing.*
  - **AUDIT-F2** — `Reader.tsx` at 3,954 lines with 28 `useState`, and its 14 raw divs. The
    measurement already exists: of 8.80 s of reader JS self CPU, app code is 0.715 s (8%) and React
    reconciliation + MUI is the rest. That says *split the component*, which is a project, not a
    task. Note `Reader.tsx` is excluded from coverage in `vite.config.ts`, so the 79% gate is
    measured without it. **`ReaderRightSidebar`'s inline `sx` literals are untouched by this
    sitting** — the count is 66, against the 65 `issues.md` records, because the two new helpers
    each hold one. That work converted raw `style` props on `<label>`/`<span>`, which is a
    different axis from AUDIT-F2's `sx`-identity-per-render problem. The file is 1,562 lines now,
    down from 1,590.
  - **AUDIT-F8** — pagination and search. Decide the library-size ceiling first; if a few hundred
    series is the cap, close it instead of building it.
  - **AUDIT-F9** — a Playwright viewport smoke test. The only thing that can actually verify
    responsive layout, since jsdom does not lay out CSS. Wants the real-browser work in the
    ZIP-pixel item to land first — same infrastructure, two consumers.

## Out of scope unless deliberately reopened

- **The worker pull model.** Measured at 408 s of 49,058 s of queue wait (0.83%). Build it for
  latency, resilience and multi-worker scaling — never for throughput.
- **AUDIT-S\*** — security is tracked separately, don't fold it in.
- **A reader downscale cap.** A 3000 px long-edge cap hits 124 images and saves a further 46 MB
  (0.241× → 0.200×). Real but secondary, and a second performance variable.
- **AUDIT-W5**, and re-deriving the queue-wait share. Both settled; see archive.md.

## Working constraints

- **`CLAUDE.md` is binding.** `impact({target, direction:"upstream", repo:"manga-library"})` before
  editing any symbol, report HIGH/CRITICAL, `detect_changes()` before committing.
  **`detect_changes` attributes by line offset**, so a large insertion flags untouched symbols below
  it — check `git diff -U0` hunk ranges before believing the blast radius, and **reindex first**
  (`node .gitnexus/run.cjs analyze`). This fired **twice more** on 2026-08-05: a 47-line helper
  insertion flagged four untouched symbols in each file. **But it also earned its keep once** —
  the `QueueManager` run surfaced a `pipelineStages` array that already held the chain the new code
  was about to duplicate. Read the list; just verify it against the hunks.
- **Running `analyze` rewrites the symbol counts in `CLAUDE.md` and `AGENTS.md`.** That shows up as
  an unrelated diff on two files you did not edit. Keep it out of a feature commit.
- **Verify a fix red-green.** Break it, watch the test fail, restore it. A regression test that has
  never been seen to fail is not evidence — and **three times now** a failing test has turned out to
  be pinning a bug rather than the behaviour. The latest: `"filters out old COMPLETED jobs"`
  asserted that a finished `qa` job reads `TRANSITIONING...`, which was the bug it was meant to be
  indifferent to.
- **Read the whole `issues.md` entry before calling it closed.** B3 and B4 each bundled sub-findings
  the headline did not mention.
- **`issues.md` status is not trustworthy on its own.** AUDIT-B6 and AUDIT-D1 sat marked open long
  after they were fixed. Check the code before starting anything from the unverified backlog.
- **One performance variable per change.** The delta has to be attributable.
- **Commit straight to `main`** — no feature branches. **Use a pathspec** (`git commit -- <paths>`):
  a bare `git commit` takes everything already staged.
- **Never run `prettier --write` outside a commit whose purpose is formatting.** The repo is
  Prettier-clean and `ci-npm.yml` gates on `format:check`, so `--write` on a file you are already
  changing only touches what your change caused — verify with `git diff -w` rather than avoiding it
  blindly. That held both times this sitting.
- **Frontend lint is `--report-unused-disable-directives --max-warnings 0`.** A warning fails the
  build. This is deliberate: it is what caught a Prettier reflow silently disabling an
  `eslint-disable-line` by moving it off its target line.
- **`.env` is gitignored and overrides `docker-compose.yml` defaults.** Verify with
  `docker compose config | grep -E 'CONCURRENT_JOBS|MAX_(HEAVY|LIGHT)_SLOTS'` before trusting a run.
  Current: `CONCURRENT_JOBS=4 / MAX_HEAVY_SLOTS=1 / MAX_LIGHT_SLOTS=3`.
- The frontend compiles **into** the backend image, so any frontend change needs
  `docker compose build backend && docker compose up -d backend` (~10 min). **Both commits this
  sitting are frontend-only and are therefore not live** until that rebuild happens.
- Backend API changes require `npm run generate-api` from `frontend/` with the backend container up.
  It now honours `API_DOCS_URL`, defaulting to the previous hardcoded URL.
- **`worker/` is a git submodule.** Changes need their own commit plus a pointer bump in the parent.
- Backend build is Maven (`mvn -o test`, no wrapper) **and must be run from `backend/`**. Frontend is
  `npx vitest run` / `npx tsc --noEmit` / `npm run lint` / `npm run format:check`. Worker is
  `python3 -m pytest -q`, `ruff check .`, `ruff format --check .` and `pyright .` — the last two are
  CI gates. Worker CI runs Python 3.13 as of `0123ca6`.
- **The local `.venv` is now Python 3.13.12 / numpy 2.3.5** and matches the image. It is at the repo
  root, not in `worker/`; run the worker suite as `cd worker && ../.venv/bin/python -m pytest -q`.
- **Testcontainers works.** If the backend suite goes red across many classes at once, read the
  surefire report's `Caused by` chain before blaming the environment.
- **MinIO objects are readable straight off disk** — no container, no port 9000. Single-drive MinIO
  prefixes a 32-byte bitrot checksum to each 1 MiB block; strip those and the bytes come back
  verbatim. Handle three layouts: single-part, multi-part (`part.1..N`, numeric order), and small
  objects inlined into `xl.meta` as a trailing msgpack `bin32`. Verified against all 743 ETags.
- **Never upload Firefox profiles** — use save-to-file; they carry series names and URLs.

## Prompt for the next chat

<!-- markdownlint-disable MD031 MD040 -->

```
Continuing manga-library. Read docs/next-step.md first, then docs/archive.md's
"2026-08-05 third sitting" and "2026-08-05 second sitting" sections. Between
them they have what shipped, what is settled and why, and what is still open.
Do not re-audit the codebase and do not re-derive the run numbers — both are
written down. docs/issues.md carries file:line anchors and Status: lines, but
trust next-step.md over its status.

THE RANKED LIST IS EMPTY. Both remaining items closed on 2026-08-05:
ReaderRightSidebar's MUI miss (5b721c0) and the transitioning state (6876723).
The local .venv was also rebuilt on Python 3.13. Do not reopen any of the three.

STATE: two commits on local main are NOT pushed. Working tree clean. Both
commits are frontend-only, so they are not live until
`docker compose build backend && docker compose up -d backend` (~10 min).

CLOSED — do not reopen without a measurement that contradicts the file:
the performance/scheduling thread, AUDIT-W5 (1.8%, WON'T DO), AUDIT-W2 (1.2%),
AUDIT-W12, the 2026-08-04 correctness sweep, the whole SSE subsystem (B4, F3,
F7), B1, B2, B3, B6, B7, D1, D2 (leftovers included, multi-stage WON'T DO),
D3, D4, F4, F5, F6, P2, P3, P9, try_local_ai, the worker's non-root deploy,
and both Python-version mismatches (CI and the local venv).

Dependabot: four PRs open, all four close-don't-merge. Do not spend a sitting
on them; for okhttp read the comment in backend/pom.xml before touching the pin.

WHAT I WANT

Nothing is ranked any more — that is the real state, not an omission. Two piles
are left and next-step.md's "Where to go next" argues for one of them:

1. RECOMMENDED — a verification pass over the unverified backlog in issues.md.
   Read the code for each entry and close what is already fixed, before any of
   it gets scheduled. Expect stale findings: AUDIT-B6 and AUDIT-D1 were already
   fixed while still marked open, and P9's filed mechanism was wrong.
2. The carried-forward items. The ZIP-pixel check and AUDIT-F9 want the same
   real-browser infrastructure and would sensibly land together.

Pick one and say which. Say plainly if a finding turns out stale or wrong when
you actually read the code — that has now paid off repeatedly.

CONSTRAINTS
- CLAUDE.md is binding: reindex, impact() before edits, detect_changes() before
  commits. Its CRITICAL/HIGH is usually the line-offset artefact — check
  `git diff -U0` hunk ranges before believing it. It is not always noise: on
  2026-08-05 it caught a real duplicated constant. Use `git diff -w` when the
  change wraps JSX. Note `analyze` rewrites symbol counts in CLAUDE.md and
  AGENTS.md — keep that out of a feature commit.
- Verify red-green. Three times now a failing test has been pinning a bug
  rather than the behaviour, so read what a test asserts before trusting it.
- Commit to main directly, with a pathspec; worker/ is a submodule and needs
  its own commit plus a pointer bump. `git fetch` before assuming this branch
  is ahead-only — dependabot PRs get merged on GitHub without this clone
  knowing.
- Frontend lint is --max-warnings 0 and CI gates on prettier --check.
- sx is not a free swap for style, in two distinct ways: per-frame values mint
  an emotion class per value, AND sx loses the cascade to a plain CSS class on
  a specificity tie. Scope to `&.the-class` when overriding one.
- One performance variable per change.
- Security findings (AUDIT-S*) are tracked separately; don't fold them in.
```

<!-- markdownlint-enable MD031 MD040 -->
