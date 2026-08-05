# Handoff — opened 2026-08-05 (third sitting)

> The previous board is retired. Items 1–7 are done bar two halves: see [archive.md](./archive.md)
> under *The 2026-08-05 third sitting* for the eleven commits, two corrected findings, one entry that
> was bigger than its headline, and three process notes.
>
> **Resume at:** [§ The list](#the-list). Item 1 is a one-command unblock you have to run yourself.
>
> **Read this first:** the worker image is **built and verified but not deployed**, and deploying it
> needs a `sudo chown` that an agent cannot run. That is item 1 and everything else can proceed
> without it.

## Where the work stands

Closed threads — do not reopen without a measurement that contradicts the file:

| thread | outcome |
| --- | --- |
| Reader performance (7-item plan) | Items 1–6 shipped. Item 7 (AUDIT-W5) is **WON'T DO** at 1.8%. |
| Queue scheduling | **Closed.** Utilisation 80%; the big `layout`/`panel-detection` numbers are an attribution artefact. |
| Correctness sweep (2026-08-04) | **Closed**, each with a red-green test. |
| The SSE subsystem | **Closed 2026-08-05.** B4 (both halves), F3, F7 — nothing outstanding. |
| Scheduler pool, `try_local_ai`, startup `@Transactional`, NPE→500, light-mode contrast | **Closed 2026-08-05.** |
| AUDIT-B3, AUDIT-B4 | **Fully closed 2026-08-05**, leftovers included. |
| AUDIT-F5, AUDIT-F6 | **Closed 2026-08-05**, with corrections — see archive.md. |
| AUDIT-B6, AUDIT-D1 | **Were already fixed** and wrongly still open in `issues.md`. Corrected there. |
| AUDIT-B7, P2, P3, P9 | **Closed 2026-08-05**, each red-green. P9's filed mechanism was wrong — see archive.md. |
| AUDIT-D3, AUDIT-D4 | **Closed 2026-08-05.** D4 breaks in both directions, not just the worker's. |
| AUDIT-D2 multi-stage | **WON'T DO** — measured, no build-toolchain layer to drop. Image unchanged at 1.94 GB. |
| Landmarks / skip link | **Closed 2026-08-05** (`bc81040`). The last of AUDIT-F6. |

Suites: **backend 395, frontend 306, worker 284.** All green, no skips.

**Backend is deployed.** It was rebuilt on 2026-08-05 and came up healthy with no error lines, so
AUDIT-F7's client listener and `server.compression` are live for the first time. The a11y and
ColorPicker commits landed *after* that rebuild, so they need another one to be visible.

**The worker is not deployed.** See item 1 — the image is built and verified, the chown is not done.

**Not pushed.** The branch is now **21 commits ahead** of `github/main`, by decision rather than
oversight. Three remotes exist (`github`, `codeberg`, `origin`/pi5); pick deliberately.

## The list

Ranked by payoff per line changed, which is the ordering this project has asked for.

### 1. Finish deploying the non-root worker *(one command, then one check)*

AUDIT-D2's code is committed and verified — the image runs as `uid=10001(worker)` with both caches
writable, and `ruff` / `ruff format` / `pyright` / 284 tests are all green. What is left cannot be
done by an agent:

```bash
sudo chown -R 10001:10001 data/worker/{huggingface,paddlex,rendered_cache}
docker compose up -d worker
```

374 MB of downloaded models sit in those three directories, still owned by `root:root`. Without the
chown the worker starts and cannot write to them. Until it is done the running container is the
previous root image, so **the stack is consistent, not broken** — this is unfinished, not urgent.

### 2. AUDIT-D2's leftovers *(one commit)*

The entry bundled four sub-items its headline never mentioned, none of them attempted:

- The four font `wget`s hit `raw.githubusercontent.com/.../main/...` — unpinned refs on a moving
  branch, so the build is not reproducible. The Arial pull from `root-project` also has a licensing
  question for a published image.
- `libxrender-dev` leaves a `-dev` package in the runtime image.
- No `PYTHONUNBUFFERED=1`, which is exactly why the worker code is littered with `flush=True`.
- `pip install` has no BuildKit cache mount, unlike the backend's Maven and npm stages.

### 3. `ReaderRightSidebar`'s MUI miss *(its own sitting)*

The other half of item 7 from the last board. 1,590 lines carrying **11 raw `<label>`s with inline
styles and 8 `<span>`s**. `ColorPicker` is done (`64cea19`); this one was deferred on size, not on
difficulty. `Reader.tsx`'s 14 divs remain out of scope — that is AUDIT-F2.

**Take the ColorPicker lesson with you:** `sx` is not a free swap for `style`. Anything that updates
per frame belongs on `style`, because `sx` mints an emotion class per distinct value.

### 4. The transitioning state for queued jobs *(observability, not performance)*

Move a waiting job to a *transitioning* state instead of leaving it labelled with the stage it last
completed, so the shape of the wait is legible. **It will not move wall time** — file and measure it
as observability.

**Scoped on 2026-08-05 but not started.** `getDisplayStatus` (`QueueManager.tsx:695`) already maps
`COMPLETED → "TRANSITIONING..."`, so the *vocabulary* exists but only as a frontend relabel. The
open question is where the state should actually live: the backend leaves the row at `COMPLETED` for
stage N while stage N+1 has not been enqueued, so the UI can say "transitioning" but cannot say
*to what*. Decide whether that is a real job status or a derived display value before writing code.

### 5. A cold-boot check on AUDIT-D3 *(cheap, and it closes a loop)*

`55f9d00` was verified with `docker compose config` and observed on a single-service redeploy
(`Waiting` → `Healthy` for db, minio, valkey). It has **not** been through a full `docker compose
down && up`, which is the case the original db-backup outage came from. Worth one cold boot.

## The unverified backlog

Open in `issues.md`, **not re-checked against the code**, and not ranked against the list above. Any
of these may already be fixed — AUDIT-B6 and AUDIT-D1 both were. Verify before starting, and say so
if the finding turns out stale.

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
  - **AUDIT-F2** — 65 inline `sx` literals in `ReaderRightSidebar`, and `Reader.tsx` at 3,954 lines
    with 28 `useState`. The measurement already exists: of 8.80 s of reader JS self CPU, app code
    is 0.715 s (8%) and React reconciliation + MUI is the rest. That says *split the component*,
    which is a project, not a task. Note `Reader.tsx` is excluded from coverage in `vite.config.ts`,
    so the 79% gate is measured without it.
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
  (`node .gitnexus/run.cjs analyze`). This fired **three more times** on 2026-08-05; in one case the
  method actually rewritten was not even in the changed list while four untouched ones below it
  were. The warning is load-bearing.
- **Verify a fix red-green.** Break it, watch the test fail, restore it. A regression test that has
  never been seen to fail is not evidence — and twice now a failing test has turned out to be
  pinning a bug rather than the behaviour.
- **Read the whole `issues.md` entry before calling it closed.** B3 and B4 each bundled sub-findings
  the headline did not mention.
- **`issues.md` status is not trustworthy on its own.** AUDIT-B6 and AUDIT-D1 sat marked open long
  after they were fixed. Check the code before starting anything from the unverified backlog.
- **One performance variable per change.** The delta has to be attributable.
- **Commit straight to `main`** — no feature branches. **Use a pathspec** (`git commit -- <paths>`):
  a bare `git commit` takes everything already staged.
- **Never run `prettier --write` outside a commit whose purpose is formatting.** The repo is now
  Prettier-clean and `ci-npm.yml` gates on `format:check`, so this should not recur — but before
  that gate existed, formatting the files touched by a small change rewrote 270+ unrelated lines in
  one of them. `npm run format` is the write command; `npm run format:check` is what CI runs.
- **Frontend lint is now `--report-unused-disable-directives --max-warnings 0`.** A warning fails
  the build. This is deliberate: it is what caught a Prettier reflow silently disabling an
  `eslint-disable-line` by moving it off its target line.
- **`.env` is gitignored and overrides `docker-compose.yml` defaults.** Verify with
  `docker compose config | grep -E 'CONCURRENT_JOBS|MAX_(HEAVY|LIGHT)_SLOTS'` before trusting a run.
  Current: `CONCURRENT_JOBS=4 / MAX_HEAVY_SLOTS=1 / MAX_LIGHT_SLOTS=3`.
- The frontend compiles **into** the backend image, so any frontend change needs
  `docker compose build backend && docker compose up -d backend` (~10 min).
- Backend API changes require `npm run generate-api` from `frontend/` with the backend container up.
  It now honours `API_DOCS_URL`, defaulting to the previous hardcoded URL.
- **`worker/` is a git submodule.** Changes need their own commit plus a pointer bump in the parent.
- Backend build is Maven (`mvn -o test`, no wrapper) **and must be run from `backend/`**. Frontend is
  `npx vitest run` / `npx tsc --noEmit` / `npm run lint` / `npm run format:check`. Worker is
  `python3 -m pytest -q`, `ruff check .`, `ruff format --check .` and `pyright .` — the last two are
  CI gates and were both red on 2026-08-05.
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
"2026-08-05 third sitting" and "2026-08-05 second sitting" sections. Between them
they have what shipped, what is settled and why, and what is still open. Do not
re-audit the codebase and do not re-derive the run numbers — both are written
down. docs/issues.md carries file:line anchors and now carries Status: lines too,
but trust next-step.md over its status.

CLOSED — do not reopen without a measurement that contradicts the file:
the performance/scheduling thread, AUDIT-W5 (1.8%, WON'T DO), AUDIT-W2 (1.2%),
AUDIT-W12, the 2026-08-04 correctness sweep, the whole SSE subsystem (B4, F3,
F7), B1, B2, B3, B6, B7, D1, D3, D4, F4, F5, F6, P2, P3, P9, try_local_ai, and
AUDIT-D2's multi-stage half (measured: no build-toolchain layer to drop).

STATE: everything is committed, nothing is pushed — 21 commits ahead of
github/main, three remotes, ask before pushing. The BACKEND IS DEPLOYED as of
the third sitting. The WORKER IS NOT: its image is built and verified but the
host cache dirs are still root-owned. That is item 1 and it needs a sudo chown
you have to run yourself.

WHAT I WANT

Work down "The list" in next-step.md in order, one commit each.

1. Run the chown and bring the worker up (I do this; then you verify it).
2. AUDIT-D2's four leftovers — fonts on a moving branch, libxrender-dev,
   PYTHONUNBUFFERED, BuildKit cache mount. The headline never mentioned them.
3. ReaderRightSidebar's MUI miss — 1,590 lines, 11 labels, 8 spans.
4. The transitioning state. Scoped but not started; decide where the state
   lives before writing code — see the entry.
5. A cold `compose down && up` to close the loop on AUDIT-D3.

For each: run impact() first, verify the fix red-green (break it, watch the test
fail, restore it), and say plainly if the finding turns out to be stale or wrong
when you actually read the code. Two more were corrected that way on 2026-08-05,
including one whose stated mechanism was impossible against the live schema.

CONSTRAINTS
- CLAUDE.md is binding: reindex, impact() before edits, detect_changes() before
  commits. Its CRITICAL/HIGH is usually the line-offset artefact — check
  `git diff -U0` hunk ranges before believing it. Use `git diff -w` when the
  change wraps JSX, which re-indents whole blocks.
- Commit to main directly, with a pathspec; worker/ is a submodule and needs its
  own commit plus a pointer bump.
- Frontend lint is --max-warnings 0 and CI gates on prettier --check. The repo is
  Prettier-clean, so --write on a file you are already changing only touches what
  your change caused — verify with `git diff -w` rather than avoiding it blindly.
- sx is not a free swap for style on a drag path: it mints an emotion class per
  distinct value. Per-frame values stay inline.
- One performance variable per change.
- Security findings (AUDIT-S*) are tracked separately; don't fold them in.
```

<!-- markdownlint-enable MD031 MD040 -->
