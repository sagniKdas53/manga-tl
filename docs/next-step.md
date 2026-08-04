# Handoff — opened 2026-08-05

> The 2026-08-04 handoff is retired. Items 1–5 and the AUDIT-F4 half of 6 are done, deployed and
> archived: see [archive.md](./archive.md) under *The 2026-08-05 sitting* for the commits, the four
> corrections that came out of reading the code, and the `detect_changes` process note.
>
> **Resume at:** [§ The list](#the-list). Item 1 is roughly 20 lines and finishes a subsystem that is
> otherwise complete.

## Where the work stands

Closed threads — do not reopen without a measurement that contradicts the file:

| thread | outcome |
| --- | --- |
| Reader performance (7-item plan) | Items 1–6 shipped. Item 7 (AUDIT-W5) is **WON'T DO** at 1.8%. |
| Queue scheduling | **Closed.** Utilisation 80%; the big `layout`/`panel-detection` numbers are an attribution artefact. |
| Correctness sweep (F6/F7/F8, `/api` 404, prefetch gate, ZIP, W11) | **Closed 2026-08-04**, each with a red-green test. |
| Session renewal + ErrorBoundary (`04a29ac`) | **Closed and now deployed.** |
| Scheduler pool, `try_local_ai`, SSE multi-tab, SSE backoff, startup `@Transactional`, NPE→500, light-mode contrast | **Closed 2026-08-05.** See archive.md. |

Suites: **backend 366, frontend 297 + 1 skipped, worker 284.** All green.

**Deployed.** The backend image was rebuilt and is running; AUDIT-B1 is confirmed live in the
container logs (`scheduling-1`/`-3`/`-4` concurrent, where before there was only `scheduling-1`).

**Not pushed.** The branch is 12 commits ahead of `github/main`, by decision rather than oversight.
Three remotes exist (`github`, `codeberg`, `origin`/pi5); pick deliberately.

## The list

Ranked by payoff per line changed, which is the ordering this project has asked for. Every item was
re-verified in the code — on 2026-08-04 for the carried-over ones, and on 2026-08-05 for the two new
entries at 2 and 3, which came out of finishing their parent findings.

### 1. AUDIT-F7 — push session expiry down the SSE channel *(~40–60 lines, not the ~20 previously estimated)*

The last piece of the SSE subsystem; AUDIT-B4 and AUDIT-F3 are both done, so this closes it out.
`SseTicketAuthFilter` should emit `session-expired` at the token's `exp`, the way yt-diff's socket
layer does (`yt-diff/src/socket/index.ts:75-100`). The client half already exists: the
`SESSION_EXPIRED_EVENT` listener in `App.tsx` consumes it unchanged.

**Re-scoped 2026-08-05 after reading the code — the ~20-line estimate was wrong.** The ticket does
not currently carry the session expiry at all. `SseTicketService.issue(UUID)` stores only the user id
in Redis (`sse:ticket:<t>` → `userId`, 60 s TTL), and `redeem` returns only a `UUID`. Making the push
possible needs, in order:

1. `SseTicketService` to store and return the session `exp` alongside the user id — so `issue` takes
   it and `redeem` returns a pair, not a bare `UUID`.
2. `NotificationController.ticket()` to read `exp` off the presented JWT. It currently only has
   `@AuthenticationPrincipal User`, so this means going through the existing JWT service.
3. `SseService.subscribe` to accept the expiry and arm a scheduled push against it, cancelled when
   the emitter completes. **The scheduler pool from AUDIT-B1 is what makes this safe** — arming
   per-connection timers against a pool of 1 would have been a bad idea.

**This does not replace the client-side timer.** A frozen mobile tab has no live SSE connection to
receive a push — the exact case that produced the original blank-screen report. It closes the *other*
case: an idle tab with an open connection learning the moment it happens rather than on next use.

*It touches the auth path, which is the highest-consequence surface in the app. Worth its own
sitting rather than the tail of one.*

### 2. AUDIT-B4's leftover — the Redis race in `sendPendingNotifications` *(~10 lines)*

**New entry, 2026-08-05.** Surfaced while closing AUDIT-B4: the `issues.md` entry bundled two
unrelated bugs and only the map-keying one was fixed. `SseService.sendPendingNotifications` does
`range(key, 0, -1)` and then `delete(key)` as two separate Redis calls, so a notification pushed
between them is dropped silently. Wants an atomic drain — `RENAME` to a scratch key then read, or a
Lua script, or `LPOP` in a loop.

Cheap, self-contained, and the same subsystem as item 1 — fold it into that rebuild.

### 3. AUDIT-B3's leftovers — the error handler still leaks and still mis-reports 403 *(~15 lines)*

**New entry, 2026-08-05.** Same shape as item 2: closing the NPE half of AUDIT-B3 left two
sub-findings from the same `issues.md` entry untouched.

- `GlobalExceptionHandler.handleInternalError` returns `"Something went wrong: " + ex.getMessage()`
  to the client, leaking SQL fragments, file paths and internal identifiers. It should log the
  message and send a generic detail — exactly what the new `handleNullPointer` already does, so
  there is a pattern in the file to copy.
- There is **no `AccessDeniedException` handler**, so a method-level `@PreAuthorize` denial falls
  through to the catch-all and returns **500 instead of 403**.

### 4. AUDIT-F6 — the other half of the accessibility pass *(one sitting)*

AUDIT-F4 is done; this is what remains of item 6. 5 `aria-label`s across 40 components.
`Reader.tsx`, `ReaderTopNav`, `ReaderLeftSidebar`, `ReaderRightSidebar` and `NavBar` have **zero**
between them, and they are almost entirely icon-only buttons. yt-diff has 56 across 11 components.
Sweep icon-only `IconButton`/`Fab` for accessible names, then focus order in the reader.

*The `frontend/.claude/skills/web-design-guidelines` skill covers exactly this and is scoped to
`frontend/` — worth invoking rather than working from memory.*

### 5. AUDIT-F5 — the small frontend items *(one commit)*

Six originals plus three from the yt-diff comparison, all listed in `issues.md`. **The ordering
constraint is now satisfied:** `QueueManager.tsx:427`'s 30 s poll existed to paper over SSE
dropping, and AUDIT-F3 closed that — the poll is safe to delete. The rest are independent: the
duplicate `manga_theme` writer (`App.tsx:287` vs `useColorMode.ts:3`), `getSnapshot` allocating per
call, `esbuild` in `dependencies`, the hardcoded `generate-api` URL, `--max-warnings 0`, and the
compression plugin.

### 6. Infrastructure hygiene *(one commit each)*

- **AUDIT-D3** — `docker-compose.yml` still uses the plain-list `depends_on` for backend and worker,
  so the six healthchecks defined right above them are ignored on startup. Only `db-backup` uses the
  `condition:` form. Same class of bug that took backups down for three days.
- **AUDIT-D4** — **verified latent, not live (2026-08-05).** `MINIO_ENDPOINT` means two different
  things: the backend's default wants a scheme (`http://minio:9000`), the worker's wants bare
  (`minio:9000`). `docker compose config` confirms both currently resolve correctly *because `.env`
  does not set `MINIO_ENDPOINT` at all* — so the two defaults apply independently. It breaks the
  moment anyone sets that one variable. Fix it as a trap, not an outage.
- **AUDIT-D2** — the worker image is single-stage, runs as root, and pins nothing
  (`worker/Dockerfile:1`, no `USER`). Also the largest image in the stack.

### 7. The transitioning state for queued jobs *(observability, not performance)*

Move a waiting job to a *transitioning* state instead of leaving it labelled with the stage it last
completed, so the shape of the wait is legible. **It will not move wall time** — file and measure it
as observability. `getDisplayStatus` already renders `COMPLETED` as `TRANSITIONING...`
(`QueueManager.tsx:681`), so some of the vocabulary exists.

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
  hit an annotation-binding failure three times (`f3aa160`'s record insertion, AUDIT-B2, and the
  `@Transactional`-with-internal-catch variant found while fixing it). A mechanical pass over
  `this.`-prefixed calls to annotated methods would settle it.
- **The larger frontend items are deliberately not on the list.** Each is a multi-sitting refactor
  whose payoff-per-line loses to everything above, and two of them want the profiler first:
  - **AUDIT-F1** — migrate the theme to `colorSchemes` + `cssVariables`. Also removes the `mode`
    prop drilled into `Dashboard`, `ChapterGallery` and `Reader`, and the ~20 ternaries in
    `theme.ts`. Bundle it with the next MUI major, not before. *Note the new `theme.test.ts` pins
    contrast per mode; that migration must keep it passing.*
  - **AUDIT-F2** — 65 inline `sx` literals in `ReaderRightSidebar`, and `Reader.tsx` at 3,954 lines
    with 28 `useState`. The measurement already exists: of 8.80 s of reader JS self CPU, app code
    is 0.715 s (8%) and React reconciliation + MUI is the rest. That says *split the component*,
    which is a project, not a task. Note `Reader.tsx` is currently excluded from coverage in
    `vite.config.ts`, so the 79% gate is measured without it.
  - **AUDIT-F8** — pagination and search. Decide the library-size ceiling first; if a few hundred
    series is the cap, close it instead of building it.
  - **AUDIT-F9** — a Playwright viewport smoke test. The only thing that can actually verify
    responsive layout, since jsdom does not lay out CSS and there are no `useMediaQuery` branches
    to unit-test. Wants the real-browser work in the ZIP-pixel item to land first — same
    infrastructure, two consumers.

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
  (`node .gitnexus/run.cjs analyze`); a stale index is the main source of false HIGH/CRITICAL. This
  fired again on 2026-08-05 and cost nothing only because the warning was already written down.
- **Verify a fix red-green.** Break it, watch the test fail, restore it. A regression test that has
  never been seen to fail is not evidence — and twice now a failing test has turned out to be
  pinning a bug rather than the behaviour.
- **Read the whole `issues.md` entry before calling it closed.** Both AUDIT-B3 and AUDIT-B4 bundled
  sub-findings under a headline that described only one of them; items 2 and 3 above exist because
  of that. The entry's title is not its scope.
- **One performance variable per change.** The delta has to be attributable.
- **Commit straight to `main`** — no feature branches for this project. **Use a pathspec**
  (`git commit -- <paths>`): a bare `git commit` takes everything already staged, which on
  2026-08-05 swept three unrelated doc files into a backend fix.
- **`.env` is gitignored and overrides `docker-compose.yml` defaults.** This is how the W10 change
  was missed for a day. Verify with
  `docker compose config | grep -E 'CONCURRENT_JOBS|MAX_(HEAVY|LIGHT)_SLOTS'` before trusting a run.
  Current: `CONCURRENT_JOBS=4 / MAX_HEAVY_SLOTS=1 / MAX_LIGHT_SLOTS=3`.
- The frontend compiles **into** the backend image, so any frontend change needs
  `docker compose build backend && docker compose up -d backend` (~10 min).
- Backend API changes require `npm run generate-api` from `frontend/` with the backend container up.
- **`worker/` is a git submodule.** Changes need their own commit plus a pointer bump in the parent.
- Backend build is Maven (`mvn -o test`, no wrapper) **and must be run from `backend/`**. Frontend is
  `npx vitest run` / `npx tsc --noEmit` / `npx eslint`. Worker is `python3 -m pytest -q` plus
  `ruff check src tests`.
- **Testcontainers works.** If the backend suite goes red across many classes at once, read the
  surefire report's `Caused by` chain before blaming the environment — a schema-validation failure
  and a Ryuk failure both surface as "ApplicationContext failure threshold exceeded" on every class
  after the first.
- **MinIO objects are readable straight off disk** — no container, no port 9000. Single-drive MinIO
  prefixes a 32-byte bitrot checksum to each 1 MiB block; strip those and the bytes come back
  verbatim. Handle three layouts: single-part, multi-part (`part.1..N`, numeric order), and small
  objects inlined into `xl.meta` as a trailing msgpack `bin32`. Verified against all 743 ETags.
- **Never upload Firefox profiles** — use save-to-file; they carry series names and URLs.

## Prompt for the next chat

<!-- markdownlint-disable MD031 MD040 -->

```
Continuing manga-library. Read docs/next-step.md first, then docs/archive.md's
"2026-08-05 sitting" and "2026-08-04 handoff" sections. Between them they have what
shipped, what is settled and why, and what is still open. Do not re-audit the
codebase and do not re-derive the run numbers — both are written down. The AUDIT-*
findings in docs/issues.md carry file:line anchors and now carry RESOLVED markers,
but trust next-step.md over issues.md's own status.

CLOSED — do not reopen without a measurement that contradicts the file:
the performance/scheduling thread, AUDIT-W5 (1.8%, WON'T DO), AUDIT-W2 (1.2%),
AUDIT-W12 (confirmed), the 2026-08-04 correctness sweep, and the 2026-08-05 batch
(B1, B2, F3, F4, the multi-tab half of B4, the NPE half of B3, try_local_ai).

STATE: everything is committed and deployed, nothing is pushed — the branch is 12
commits ahead of github/main and there are three remotes. Ask before pushing.

WHAT I WANT

Work down "The list" in next-step.md in order, one commit each:

1. AUDIT-F7 — push session expiry down the SSE channel. Re-scoped to ~40-60 lines
   and it touches the auth path; read the numbered plan in the item before starting.
2. AUDIT-B4's leftover — the non-atomic range/delete race in sendPendingNotifications.
3. AUDIT-B3's leftovers — handleInternalError leaks ex.getMessage() to the client,
   and a @PreAuthorize denial returns 500 instead of 403.
4. AUDIT-F6 — icon-only buttons have no accessible name.
5. AUDIT-F5's small items. The QueueManager poll is now safe to delete.

Then the D3/D4/D2 infrastructure items, then the transitioning-state change.

Items 1-3 are all backend/SSE and land in one image rebuild (~10 min) — batch them
rather than rebuilding per commit.

For each: run impact() first, verify the fix red-green (break it, watch the test
fail, restore it), and say plainly if the finding turns out to be stale or wrong
when you actually read the code. Several items on this board were wrong until
someone checked — four were corrected on 2026-08-05 alone.

CONSTRAINTS
- CLAUDE.md is binding: reindex, impact() before edits, detect_changes() before commits.
- Commit to main directly, with a pathspec; worker/ is a submodule and needs its own
  commit plus a pointer bump.
- Read the whole issues.md entry before calling it closed — B3 and B4 each bundled
  sub-findings that the headline did not mention.
- One performance variable per change.
- Security findings (AUDIT-S*) are tracked separately; don't fold them in.
```

<!-- markdownlint-enable MD031 MD040 -->
