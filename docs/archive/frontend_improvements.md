# Frontend Improvements — findings from the yt-diff comparison

> **Archived — never actioned.** None of this was tracked in TODO.md and none of it has been
> picked up. It is a source of ideas, not a list of commitments. Re-read it before starting
> frontend work; do not assume any item here is still accurate against the current code.

**Written:** 2026-08-04. **Method:** read this frontend against `yt-diff/frontend`, the other
React + MUI app in this workspace. yt-diff was built by hand before LLM assistance, so it
represents an independent solution to a very similar problem shape (auth'd SPA, live server
events, long media lists, MUI theming). Divergences between the two are the interesting part:
where they differ, one of them usually made a decision the other never consciously made.

Nothing here is a bug report against working code — this is a backlog of things worth looking
into. Each item has evidence, a reason, and a direction. Companion document:
`yt-diff/docs/FRONTEND_IMPROVEMENTS.md`.

## Scale of the two codebases

| | manga-library | yt-diff |
|---|---|---|
| Source lines (excl. tests) | 20,837 | 7,163 |
| Components | 40 | 11 |
| Largest component | `Reader.tsx` — 3,954 | `App.jsx` — 1,478 |
| Language | TypeScript | JS + PropTypes |
| Routing | react-router 7, deep links + slugs | none (conditional render) |
| Realtime | SSE + single-use ticket | socket.io |
| MUI | v9 | v5 |
| React | 19 | 18 |

## What this frontend already does better

Worth knowing, both to avoid regressing it and because yt-diff should borrow it:

- **Generated API types.** `npm run generate-api` pulls the live OpenAPI doc and regenerates
  `src/api/schema.d.ts`. This is the single strongest DX asset across both projects — yt-diff
  has no typed client surface at all.
- **Real routing.** Deep links, slugs, `matchPath`, browser Back. yt-diff cannot link to a
  playlist.
- **Route-level code splitting with `manualChunks`** (`vite.config.ts`) — deliberate vendor
  splits, not just default chunking.
- **`LazyImage`** — IntersectionObserver + blob fetch, used by 5 components. yt-diff has exactly
  one `loading="lazy"` attribute.
- **Coverage gate** — `thresholds: { lines: 79 }`. yt-diff has no thresholds.
- **Typed theme extensions** — `mui.d.ts` augments the palette for the custom `conversation`
  token. yt-diff adds a custom `background.menu` key with no type story at all.
- **An error boundary** (added 2026-08-04). yt-diff still has none despite 5 lazy routes.

---

## Findings

### ML-F1 — Accessibility is effectively absent · impact HIGH · effort MED

**Evidence:** 5 `aria-label`s across 40 components. `Reader.tsx` (3,954 lines, the primary
surface, almost entirely icon-only controls) has **zero**. yt-diff has 56 across 11 components
and labels every icon button — `Pagination.jsx` alone has 5 (`aria-label="first page"` etc.),
`VideoPlayer.jsx` 15, `Nav.jsx` 13.

**Why it matters:** icon-only `IconButton`s with no label are unusable with a screen reader and
give tests nothing stable to query — which is probably why component tests here lean on text and
test ids. This is the clearest single quality gap between the two apps, and yt-diff got it right
without trying.

**Direction:** sweep every icon-only `IconButton`/`Fab` for `aria-label`; start with `Reader.tsx`,
`ReaderTopNav`, `ReaderLeftSidebar`, `ReaderRightSidebar`, `NavBar`. Then keyboard focus order in
the reader, and `aria-live` on the queue/progress regions. The `web-design-guidelines` skill in
`frontend/.claude/skills` covers the audit checklist.

### ML-F2 — SSE reconnect has no backoff, jitter, or cap · impact HIGH · effort LOW

**Evidence:** `src/utils/useSSE.ts:8` — `RETRY_DELAY_MS = 5000`, used as a flat delay in
`scheduleRetry()` (`:52-57`), retried forever, regardless of tab visibility.

**Why it matters:** if the backend is down or restarting, every open tab requests a ticket every
5 s indefinitely. socket.io gives yt-diff exponential backoff with jitter for free, which is why
this never came up there. A backgrounded mobile tab also keeps burning the retry once it thaws.

**Direction:** exponential backoff with jitter (5 s → 60 s cap), stop retrying while
`document.visibilityState !== "visible"` and retry immediately on wake — the same wake events
`SessionWatcher` already listens to in `App.tsx`.

### ML-F3 — No server-push session expiry · impact MED · effort MED

**Evidence:** expiry is discovered only client-side (token `exp` check) or on a 401.

**Why it matters:** yt-diff's server arms a `setTimeout` at socket-connect for the token's exact
`exp` and pushes `token-expired` before disconnecting (`yt-diff/src/socket/index.ts:75-100`) —
the client learns the moment it happens rather than on next use. It also re-verifies on an
interval so a password change kills live sessions.

**Direction:** emit a `session-expired` SSE event at token `exp` from `SseTicketAuthFilter`; the
`SESSION_EXPIRED_EVENT` listener added in `App.tsx` would pick it up with no client change. Note
this complements rather than replaces the client-side timer — a frozen tab has no live SSE
connection to receive a push, which is the exact Firefox-on-Android case that started this.

### ML-F4 — Theme is MUI-v5-shaped on MUI v9 · impact MED · effort MED

**Evidence:** `src/theme.ts` — `themeObj(mode)` rebuilds the whole theme, `App.tsx` wraps it in
`useMemo(() => themeObj(mode), [mode])`, and `mode` is then prop-drilled into `Dashboard`,
`ChapterGallery` and `Reader`. No `colorSchemes`, no `cssVariables`, no `theme.vars` anywhere in
either project.

**Why it matters:** this is *the same function* as yt-diff's `themeObj(theme)`
(`yt-diff/src/components/App.jsx:51`) — a v5-era idiom carried forward. It was correct then. On
MUI v9 it means the theme object is rebuilt and every styled component re-evaluated on toggle,
there's a flash of wrong theme before hydration, and `mode` has to be threaded through props to
any component that wants to branch on it.

**Direction:** `createTheme({ cssVariables: true, colorSchemes: { light, dark } })` +
`useColorScheme()`. Removes the rebuild, the prop drilling, and the flash. The
`frontend:material-ui-theming` skill covers the migration.

### ML-F5 — Lists are fetched whole; no pagination, search, or debounce · impact MED · effort HIGH

**Evidence:** `App.tsx:216` fetches `/api/series` wholesale; series details fetch all chapters.
There is **no search UI anywhere** in the app, and **zero** uses of debounce or throttle.

**Why it matters:** yt-diff paginates server-side (`rowsPerPage` 10/25/50, start/stop offsets,
`PlayList.jsx:380`) and debounces its search input at 1000 ms (`PlayList.jsx:401`,
`SubList.jsx:662`) — because it was built against libraries big enough to force the issue. This
app hasn't hit that wall yet, but a manga library only grows, and the fetch-everything pattern is
in the routing layer where it's most expensive to change later.

**Direction:** decide the ceiling now. If a few hundred series is the realistic cap, do nothing
and record that decision. Otherwise add server-side paging to `/api/series` and
`/api/series/{id}/chapters` before the UI ossifies. Debounced search is a cheap independent win.

### ML-F6 — God components, and the biggest one is excluded from coverage · impact MED · effort HIGH

**Evidence:** `Reader.tsx` 3,954 lines, `ReaderRightSidebar.tsx` 1,588, `QueueManager.tsx` 1,258.
`vite.config.ts` excludes `src/components/Reader.tsx` from coverage.

**Why it matters:** `Reader.tsx` is larger than yt-diff's entire component layer minus two files,
and the 79% line gate is measured with the most complex component removed from the denominator.
That is a coverage number about the easy parts of the codebase.

**Direction:** don't attempt a big-bang split. Peel off self-contained concerns that already have
natural seams (overlay geometry → `polygonUtils`, image pipeline → `readerImage`, text fitting →
`fitText` are already extracted; keep going with the export/zip path and the page-navigation
state machine). Then drop the coverage exclusion and let the number tell the truth.

### ML-F7 — Global `window.fetch` override vs. an explicit client · impact LOW · effort MED

**Evidence:** `src/utils.ts` replaces `window.fetch` at module load with a wrapper doing context
rewriting, token renewal, 5xx retry, and 401 handling. yt-diff's `hooks/useApi.js` does the same
job as an explicit `apiFetch(url, options)` a component opts into.

**Why it matters:** the override applies to every consumer including library code that never
asked for retries, and it's why the token-renewal logic ended up buried inside a URL rewriter,
where it sat unreachable for a year. The trade is real though: the override is why `useSSE`'s
ticket request and every component's bare `fetch` got the fix for free, whereas yt-diff's cleaner
abstraction was **never mounted** (see `YD-F1`) and does nothing. Worth noting that the better
shape lost to the worse shape on delivered behaviour.

**Direction:** low priority. If touched, keep the override as a thin context-path shim and move
auth/retry into an explicit exported client that components import.

### ML-F8 — Responsive behaviour is never verified · impact MED · effort MED

**Evidence:** **zero** uses of `useMediaQuery` or `theme.breakpoints` in this codebase — all
responsiveness is `sx`/CSS. `vitest.setup.ts` mocks localStorage, ResizeObserver and
`URL.createObjectURL`, but not `matchMedia`, and all 43 test files run at one implicit viewport.

**Why it matters:** yt-diff runs its whole suite twice, at 375×667 and 1280×720, via vitest
`projects` with per-viewport `matchMedia` shims (`tests/setup.mobile.js`, `setup.desktop.js`) —
and that pays off there because yt-diff genuinely branches on `useMediaQuery` in 9 places. Here
the branches don't exist, so copying that setup would prove nothing: jsdom doesn't lay out CSS.
The gap is real but the fix is different.

**Direction:** a Playwright viewport smoke test (tablet portrait, phone, desktop) over the
reader and the dashboard — the `webapp-testing` skill covers this. Given the primary device is an
Android tablet, this is the only way any of it is actually checked today.

### ML-F9 — No precompressed assets · impact LOW · effort LOW

**Evidence:** `vite.config.ts` has no compression plugin; the MUI vendor chunk ships at 380 kB
(119 kB gzip). yt-diff emits both `.gz` and `.br` at build time via `vite-plugin-compression2`.

**Direction:** add the plugin and let Spring Boot serve precompressed variants. Brotli on the MUI
chunk is worth roughly 20–25% over gzip on a mobile connection. yt-diff also aliases
`@mui/icons-material` → `/esm` in `vite.config.js`; check whether that still helps under v9.

### ML-F10 — Spinner-only loading states · impact LOW · effort MED

**Evidence:** `LoadingSpinner` in `App.tsx`; no `Skeleton` usage in either project.

**Why it matters:** the grid layouts (dashboard, chapter gallery, page grid) have known cell
shapes, so skeletons map onto them directly and remove the layout jump a centered spinner causes.
Shared gap — worth doing in both.

### ML-F11 — Lint is not failing on warnings · impact LOW · effort LOW

**Evidence:** `"lint": "eslint ."` here vs. yt-diff's
`eslint src --report-unused-disable-directives --max-warnings 0`.

**Direction:** adopt yt-diff's flags. Cheap, and stops warning drift.

---

## Appendix — shared fingerprints

Both codebases independently converged on the same idioms, which is worth recording because it
means a fix to one is usually portable to the other:

- **`themeObj(...)` factory** returning `createTheme` with palette + typography +
  `shape.borderRadius: 8` + a `MuiButton` transition override — near-identical in both.
- **"Latest value in a ref"** — `onMessageRef` in `useSSE.ts` here; twelve mirror refs in
  yt-diff's `App.jsx:284-302`. Both are hand-rolled `useEffectEvent`.
- **Self-rescheduling `setTimeout`** — `SessionWatcher` here (2026-08-04);
  `useSignedUrlRefresh.js` in yt-diff, which arrived at the identical shape years earlier,
  including the `2147483647` clamp for `setTimeout`'s 32-bit delay.
- **Context-per-domain** — Notification/Toast/Upload here, Notification/Download/Auth/Socket
  there (though yt-diff's are unmounted).
- **`localStorage` for view prefs** — `manga_theme` / `ytdiff_theme`.
