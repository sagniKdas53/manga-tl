# Security boundary — what is public on purpose

> **Decision record, 2026-08-03.** This exists so that the open routes below are not closed by a
> future tidy-up. They are open deliberately, for reasons that are measured, not assumed.
>
> The authoritative copy of this reasoning lives on `SecurityConfig.filterChain`'s javadoc, next to
> the matchers themselves. `SecurityConfigTest` enforces it, so closing a route fails a named test
> rather than silently regressing the reader.

## The line

**Image bytes are public. Everything that decides, changes or reveals state is not.**

| route | access | what it is |
| --- | --- | --- |
| `/api/images/*/thumbnail` | **public** | 512 px WebP, gallery |
| `/api/images/*/reader` | **public** | downscaled WebP reading variant |
| `/api/images/*/file` | authenticated | the original, full-resolution |
| `/api/series`, `/api/chapters/**`, `/api/pages/**`, everything else under `/api/**` | authenticated | catalogue, metadata, all writes |
| `/api/auth/**`, `/actuator/**`, `/api/internal/**` | public / separately guarded | `/api/internal/**` is `permitAll` in the chain but guarded by `InternalAuthFilter` (AUDIT-S2) |

## Why the variants are public

1. **An `<img>` cannot send an `Authorization` header.** Requiring one forces the frontend to fetch
   bytes in JavaScript and hand them to the element as a blob URL. That costs progressive decoding
   (nothing paints until the last byte), the browser's own request prioritisation (prefetches
   compete with the visible page), and the HTTP cache. This is not hypothetical: it was done in
   commit `02d9185` to repair the reader after AUDIT-S4 removed `?token=`, and it measurably
   regressed — p50 706 ms per image, 1.5–2.5 s during prefetch, overlays painting over a blank page.
   See [reader_perf_plan_2026-08-03.md](./reader_perf_plan_2026-08-03.md).
2. **Authenticated responses cannot be cached usefully.** A public, immutable image can be cached by
   the browser and any intermediary; a per-user one cannot.
3. **It matches comparable readers.** MangaDex's API documentation instructs clients *not* to send
   authentication headers when fetching page images, and serves them from an unauthenticated CDN.

## Why this is a narrow exposure

- **The catalogue is not enumerable.** Listing, searching and metadata stay authenticated, so
  reaching an image requires already knowing its UUID. The open routes leak nothing that helps you
  discover one.
- **Only derived, lossy, downscaled variants are open.** Originals stay behind auth.
- **Nothing here is a write path.** All three open image routes are `GET`.
- **This deployment is not internet-facing** in the general sense; it is reached over Tailscale.

`/thumbnail` has been public since long before this decision — this record makes that deliberate
rather than incidental, and extends the same reasoning to `/reader`.

## If it ever needs closing

Do **not** move the matchers back under `authenticated()` — that reintroduces the regression in
reason 1. Use a short-TTL signed URL instead (the model `SseTicketAuthFilter` already uses for SSE,
and the model MangaDex uses for images): the credential lives in the URL, expires in minutes, and
native `<img>` loading is preserved.

## Not covered by this decision

Thumbnail *generation* throughput is a separate, still-open problem — **AUDIT-B6**, where the entire
decode of every format is wrapped in `synchronized (WEBP_LOCK)` despite a comment claiming the lock
is WebP-only, serialising the 4-thread `thumbnailExecutor`. Access control never affected it.
