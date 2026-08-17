# Reader performance — findings and draft plan (2026-08-03)

> **Status: revised 2026-08-03 after comparing against nhentai / MangaDex / cubari.** The research
> and its consequences are in [§ How other readers do it](#how-other-readers-do-it); the plan at the
> bottom is the revised one.
>
> **The plan below is fully implemented as of 2026-08-03 — items 1–6 all shipped.** For what WebP
> actually bought and why q90, see [comparison.md](comparison.md). Item 1's framing changed along the way: a ~1600 px downscale was
> the wrong lever, because 77% of images are already ≤2000 px, so the win is the WebP re-encode and
> not the resize. **This file is kept for the measurements and the reader-design research**, which
> are what the implementation was built from.
>
> Runs: [`20260803-101946`](../../logs/runs/20260803-101946) (reader only, 800 s) and
> [`20260803-103311`](../../logs/runs/20260803-103311) (reader + queue processing, 1064 s).

## What the runs measured

### The slot change worked

`layout` p50 collapsed **150.64 s → 2.65 s** between `20260803-084755` (2/1/1, the config that was
never actually applied) and `20260803-103311` (4/1/3). That is the AUDIT-W10 win, finally measured.

### The idle heavy slot is never lent out

From `20260803-103311/queues.csv`, 391 usable samples:

| | |
| --- | --- |
| `active_light` max | **3** — never 4; the cap is hard |
| `active_heavy` == 0 | **95.7%** of samples |
| light at cap **and** heavy idle **and** light work queued | **13.3%** |
| ...and no heavy work queued either — a slot simply wasted | **13.0%** |

`WorkerDispatcherService.hasLightCapacity()` is `activeLight < maxLight && activeTotal < maxTotal`.
At `activeLight=3, maxLight=3, activeTotal=3, maxTotal=4` it refuses despite a free slot.
`REUSE_IDLE_SLOTS=true` is set in the worker environment and **the dispatcher never reads it** —
AUDIT-W5, "dead code in the push model", confirmed with a number.

### The reader

Profile figures are de-duplicated: Firefox records every request twice, once in the parent process
and once in the content process.

**The blob cache is not the problem** — 20 distinct images, **20 fetches, 1.00×**. It neither leaks
nor thrashes.

| symptom | measurement |
| --- | --- |
| image size | mean **1.37 MB**, max **4.73 MB**, 27.3 MB for 20 pages |
| link throughput | **0.2–1.9 MB/s** over Tailscale |
| image fetch | p50 **706 ms**, p95/max **2482 ms** |
| the 5 slowest | the startup prefetch storm — 5 images requested within 25 ms, each 1.5–2.5 s |
| page details | 20 distinct, **35 fetches (1.75×)**; some pages 3× |
| backend CPU under load | mean 8.6%, **max 105.2%** (was 25.1% without reader traffic) |
| worker CPU under load | mean 32.5%, p95 181% of a 200% cap |

### Five causes

1. **Overlays are gated on the wrong condition.** `visibility: isLoadingPageDetails ? "hidden" :
   "visible"` — details are small JSON and land in ~400 ms, the image is 1.37 MB and lands in
   700–2500 ms, so overlays become visible over a blank `<img>`. Worse, `viewBox` is built from
   `imageDims`, which only updates in `handleImgLoad`, so until the image arrives the overlays are
   drawn against the *previous* page's dimensions.
2. **No reader-sized image variant.** Thumbnails are 512 px WebP (`PageService:213`); the reader
   always receives the full original. Nothing in between exists.
3. **Nothing is cacheable.** Spring Security's default header writer puts
   `Cache-Control: no-cache, no-store, max-age=0, must-revalidate` on every response including
   images. `PageController:915` sets no `ETag`, no `Last-Modified`, and `StreamingResponseBody`
   means no `Content-Length`, so a conditional GET is not even possible.
4. **Progressive decode was lost — a regression from commit `02d9185`.** `<img src>` paints as bytes
   arrive and starts at render time; `fetch → res.blob() → createObjectURL → setState → re-render`
   paints nothing until the last byte and then adds a React round-trip.
5. **The prefetch storm — same commit.** `new Image()` got low browser priority behind the visible
   image. Five equal-priority `fetch()` calls mean the page being looked at waits for four that are
   not.

Plus the `pageDetailsCache` ±2 window evicts hard on every navigation, so crossing a boundary twice
refetches (the 1.75×).

## How other readers do it

Compared against [MangaDex](https://mangadex.org), [nhentai](https://nhentai.net) and
[cubari/guya](https://guya.cubari.moe) — screenshots in `logs/readers/`, delivery architecture from
the [MangaDex API docs](https://api.mangadex.org/docs/04-chapter/retrieving-chapter/).

**Two stored quality tiers, not one original.** MangaDex serves every page in two modes: `data`
(original PNG, "pixel-for-pixel accurate") and `data-saver` (compressed JPG, "large size savings at
the expense of image quality"). A community-reported example is **1.82 MB → 183 KB**, essentially
the ratio estimated for item 1. The important detail is that data-saver is **precompressed and
stored on first access**, not transformed per request. Confirms item 1, and settles the
implementation: generate and store a variant, never resize on the fly.

**Image bytes are not authenticated per request.** The MangaDex docs are explicit — *"Do NOT send
authentication headers when fetching images"*, because it both risks rejection and leaks tokens to
third-party servers. Access control is instead a base URL that is unguessable and valid for roughly
15 minutes. No major reader authenticates each image byte-range with a bearer token, which is what
`02d9185` made this reader do. This reframes item 4: the question is not "which header mechanism"
but "why is the image endpoint authenticated at all, when `/thumbnail` is already `permitAll`".

**Preloading is small, forward-biased, and user-visible.** nhentai exposes *Image Preloading* as a
setting defaulting to **3 pages** ahead. This reader hardcodes a bidirectional ±2 window (5 pages),
prefetches page *details* as well as images, and gives the user no control — and since `02d9185` all
five requests compete at equal priority with the page actually on screen.

**Space is reserved before the image arrives.** The standard fix for the blank-page/layout-shift
problem is to reserve the box from known dimensions (intrinsic `width`/`height` or `aspect-ratio`)
and show a placeholder inside it. **`images.width` and `images.height` already exist in the model
and the database — and are populated for 0 of 743 rows, and are not exposed in the frontend types
at all.** That is the actual root of cause 1: with no dimensions available, `imageDims` falls back
to a hardcoded 800×1200 and only corrects in `handleImgLoad`, so the SVG `viewBox` is wrong until
the image lands. Populating these two columns fixes the overlay geometry *and* enables a correctly
sized placeholder, and is cheap — the upload path already decodes every image to build a thumbnail.

**Reader settings are a first-class surface.** MangaDex splits them into Page Layout / Image fit /
Keybinds / Behaviors; cubari into Reader / Behavior / Layout / Themes / Advanced; nhentai keeps one
panel with preloading, scaling, zoom, page-turn behaviour and a keyboard-shortcut reference. Ours
has fit-mode and zoom but no preload or image-quality control. Worth having once a quality tier
exists, so the setting is where users expect it.

## Draft plan, ordered by payoff

0. **Populate `images.width` / `images.height` and expose them.** *(new — promoted to first by the
   research; a prerequisite for 3, and independently the cheapest correctness win.)* The upload path
   already decodes every image to build the 512 px thumbnail, so both values are in hand and simply
   never written. Backfill the 743 existing rows, add the fields to the page DTO, regenerate
   `schema.d.ts`.

1. **Reader-sized variant** — extend the WebP path in `PageService` (already has `libwebp-imageio`,
   q0.85) to emit and **store** a ~1600 px `reader/` variant, original kept for zoom. This is
   MangaDex's `data-saver` in all but name; their measured example is 1.82 MB → 183 KB against our
   1.37 MB mean, so expect p50 706 ms → roughly 150 ms. Generate at upload, backfill lazily on first
   request; never resize per-request.

2. **Make images cacheable** — scope Spring Security's header writer so `/api/images/**` sends
   `Cache-Control: private, max-age=31536000, immutable` plus `ETag` and a real `Content-Length`.
   Bytes are immutable per image id, so `immutable` is honest here and removes revalidation
   entirely.

3. **Reserve the box and fix the overlay gate** — with dimensions from item 0, size the canvas from
   the known aspect ratio before the image arrives, drive the SVG `viewBox` from that rather than
   from `handleImgLoad`, and gate overlay visibility on the image, not on `isLoadingPageDetails`.
   Removes both the layout shift and the mispositioned-overlay flash.

4. **Stop authenticating image bytes** — undoes the `02d9185` regression at the root rather than
   working around it, and matches how every reader surveyed does it. `/api/images/*/thumbnail` is
   already `permitAll`, so full images being authenticated is a half-measure that buys little.
   Options, in the order the research supports them:
   - **`permitAll` on `/file`** to match `/thumbnail` — simplest, restores plain `<img src>`,
     progressive decode, browser priority and browser caching for free. Consistent with the fact
     that the gallery is already public.
   - **Short-TTL signed image URL** — MangaDex's model (unguessable base URL, ~15 min). Keeps access
     control without a per-request credential.
   - **HttpOnly `SameSite=Strict` cookie** — keeps strict auth and native `<img>`, at the cost of a
     second auth path to maintain.

   **Needs a decision before implementing.**

5. **Rework prefetch on the nhentai model** — forward-biased, default ~3 pages, `priority: "low"`,
   not started until the current page's image has landed, and exposed as a reader setting. Replaces
   the hardcoded bidirectional ±2 window.

6. **Widen the details cache** — ~15 entries LRU instead of hard ±2 eviction.

7. **Lend the idle heavy slot** (AUDIT-W5) — honour `REUSE_IDLE_SLOTS` in `hasLightCapacity()` while
   still reserving enough capacity that a heavy job is not starved. Its own run; one variable.

Items 0–3 are independent and low-risk, and 0 + 3 together fix the visible "layers on a blank page"
complaint without touching the loading path. Item 4 unblocks 5. Item 7 is backend-only and unrelated
to the reader work.
