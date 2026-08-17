# WebP for the reader — measurement, decision, and deployed result

**Status: closed.** Measured 2026-08-03, shipped the same day. We serve a stored WebP variant at
**q90, native resolution**. Corpus went **1.142 GB → 0.266 GB of variants**.

## The setup changed from the plan

The handoff doc said the encoding had to run inside the backend container because MinIO objects
can't be read off disk. That was wrong. MinIO's `part.1` files aren't erasure-sharded — on a single
drive they're the original bytes with a **32-byte bitrot checksum prefixed to each 1 MiB block**.
Strip those and the file comes back verbatim.

Validated against every object's stored ETag: **743/743 byte-exact, zero failures**, covering all
three on-disk layouts (single-part, 40 multi-part, and 6 small objects inlined into `xl.meta`).
Multi-part ETags are `md5(concat of part md5s)-N`, not a plain MD5 — compare accordingly.

Net effect: exposing port 9000 wasn't needed either. Nothing has to be running, and there is no
compose edit to remember to revert.

## Corpus census

From the real decoded bytes, not file extensions:

| | count | total | mean | mean MP |
| --- | --- | --- | --- | --- |
| JPEG | 550 | 0.62 GB | 1.13 MB | 3.31 |
| PNG | 162 | 0.50 GB | 3.10 MB | 7.22 |
| WEBP | 31 | 0.01 GB | 0.41 MB | 1.80 |

1.14 GB total, width p50 1806. The 162 PNGs are **44% of all bytes from 22% of the files** — they
are where the win lives.

Correction to the handoff doc: it counted formats by extension, which mislabels at least one file.
Actual decoded formats are 550/162/31, not 549/163/31.

## Encode results

25-image stratified sample (format × screentone density, plus the two largest outliers), native
resolution, `method=6`, SSIM against the original. Bytes-weighted ratio, total variant ÷ total
original:

| source | q80 | q85 | **q90** | q95 | lossless |
| --- | --- | --- | --- | --- | --- |
| JPEG | 0.24× | 0.28× | **0.35×** | 0.44× | 1.08× |
| PNG | 0.12× | 0.14× | **0.17×** | 0.22× | 0.50× |
| WEBP | 0.99× | 1.09× | **1.19×** | 1.41× | 2.56× |

Worst-case SSIM at q90: **JPEG 0.983, PNG 0.993**.

## Why q90

**The plan's core claim held: the win is the re-encode, not a resize.** 77% of images are already
≤2000 px, and no downscaling contributes anything to the numbers above.

**q90 was chosen after eyeballing 1:1 crops of the corpus's densest screentone pages** — screentone
is the pathological case for lossy compression and manga is full of it, so it was the case that had
to be checked visually rather than by SSIM alone. It held up; q85's extra ~18% wasn't worth spending
where quality is most fragile, and q95 gave back a quarter of the win to guard against artefacts
that weren't visible at q90.

Three things the measurement changed about the plan:

**Lossless is the wrong answer for the PNGs.** The doc expected it might win. It does beat PNG
(0.50×) but **q90 beats it by 3×** (0.17×) at SSIM 0.993, and costs a **median 40 s/image, max
374 s** versus ~1 s. Not close on either axis.

**WebP sources must pass through untouched.** Re-encoding the 31 existing WebPs *inflates* them
1.19×. This needed an explicit skip that wasn't in the plan.

**Screentone is real but rare.** The densest JPEG page (4960×7016, tone 105) reaches only **0.84×**
at q90. But corpus tone p50 is 8.2 and p90 is 27.2, so that page is a far outlier. It is the reason
for the per-image guard below rather than a reason to pick a different quality.

## What shipped

Stored variant generated at upload and served from `/api/images/{id}/reader`, with a guard: **never
store a variant that isn't smaller than its source.** When it isn't — already-WebP sources, or dense
screentone — the row records the *original's* path instead of null, so the reader falls back
transparently and the backfill could still retire itself.

## Deployed result

Backfill over the existing corpus: **743 processed, 0 skipped, 686 s.** 694 variants, 49 passthrough
(31 WebP + 18 not-smaller), zero rows left null.

| | before | after |
| --- | --- | --- |
| stored bytes | 1.142 GB | **0.266 GB** (0.233×) |
| mean page | 1.53 MB | 0.37 MB |
| p90 page | 3.78 MB | 0.70 MB |
| 20-page session | ~30.6 MB | ~7.4 MB |

At the measured 0.2–1.9 MB/s over Tailscale, that turns a ~30 s page-load budget into ~7 s.

The Java encoder (`com.github.gotson:webp-imageio`) tracked libwebp `method=6` closely enough that
the 0.274 GB prediction from the Python measurement held to within 3%.

**The guard earned its place:** 18 images produced variants *larger* than the source, one by 6×.
Without it those pages would have gotten slower, not faster.

## Also verified

`/reader` serves `Cache-Control: max-age=31536000, public, immutable` with a real `ETag` and
`Content-Length` — `permitAll` alone does *not* lift Spring Security's blanket `no-store`, so the
explicit override was required. `/thumbnail` gained the same headers plus a `Content-Length` it
never had. `/file` still returns **403** unauthenticated, so the boundary recorded in
[security_boundary.md](../reference/security_boundary.md) is intact.

## Deliberately not done

**A downscale cap.** Measured: a 3000 px long-edge cap hits 124 images and saves a further 46 MB
(0.241× → 0.200×). Real, but secondary, and it is a second performance variable — left as its own
change. Without it the worst page stays 11 MB.
