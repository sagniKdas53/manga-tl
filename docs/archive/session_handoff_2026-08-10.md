# Session handoff — 2026-08-10

Context for whoever (human or Claude) picks this up next. Everything below is
pushed to GitHub as of this writing; nothing is stranded locally.

## Branch map

Two branches, kept in lockstep except for one deliberate difference (OCR
grouping), across two repos:

| Repo | Branch | Tip | Purpose |
|---|---|---|---|
| manga-library | `main` | `2106a70` | current default behaviour |
| manga-library | `ocr-pre-grouping-baseline` | `81089d6` | frozen OCR baseline for A/B testing |
| worker (submodule, separate repo) | `main` | `6fbf4d3` | pinned by manga-library's `main` |
| worker | `ocr-pre-grouping-baseline` | `8eaa499` | pinned by manga-library's `ocr-pre-grouping-baseline` |

**`ocr-pre-grouping-baseline` exists to A/B test OCR fragment-grouping.** It's
`main` with the region-grouping change reverted: `OCR_MERGE_THRESHOLD` back
to `1.0` (from `0.35`), and the `OCR_WAIST_GATE`/`OCR_ORIENTATION` env lines
removed from `docker-compose.yml`. That's the *only* intentional behavioural
difference from `main`. You're using it to build a new 40-SFW + 40-NSFW
sample corpus under pre-grouping conditions.

Everything else — Cloudflare provider removal, and the D3/D7/D12/D13
rendering fixes below — has been applied to **both** branches, in both
repos, so the two stay comparable.

Remotes: `github`/`origin` (GitHub) are the ones this session can reach and
has pushed to. `pi5` (manga-library) and `forgejo` (worker) are Tailscale-
hosted and unreachable from a sandboxed session — fetch/push to those
yourself if you keep a mirror there.

## What happened this session

1. **MinIO + Postgres backup.** Exported real image bytes (not MinIO's
   internal xl.meta erasure-coded format — that requires `mc mirror` against
   the S3 API, not a filesystem copy) to `exported_images/original/` and
   `exported_images/rendered/`. Verified Postgres dump at
   `data/manual-backups/manga_library-preclean-20260809-233023.sql.gz`.

2. **Removed the Cloudflare Workers AI provider** ("useless for real work")
   from the live pipeline: `docker-compose.yml`, `.env.example`,
   `config/providers.json`, plus the worker's `provider_config.py`,
   `llm_client.py`, `qa.py`, `config.py` and their tests. Also stripped the
   real token/account-id out of the gitignored `.env` and
   `secrets/api_keys.json`.

   **This was missed on `ocr-pre-grouping-baseline` in an earlier pass of
   this session** — the baseline branch was cut 22 minutes before the
   removal commit (`b56e894` / worker's `6ccd277`) landed on `main`, so it
   never got ported, despite what I'd told you earlier. Caught it just now
   while preparing this handoff (`config/providers.json` on baseline still
   had a live `"cloudflare"` block). Fixed by cherry-picking onto both
   branch histories: manga-library `81089d6`, worker `8eaa499`. Verified:
   `grep -i cloudflare` clean across `docker-compose.yml`, `.env.example`,
   `config/providers.json`, `.env`, `secrets/api_keys.json` on both branches;
   worker's 342 tests pass on the baseline branch post-port.

3. **Rendering quality bugs**, found and fixed on **both** branches
   (documented in detail in `docs/render_quality_gap_2026-08-05.md`, D-codes
   below refer to sections there):

   - **D3** (worker `ocr.py`) — `detect_background_color`/`_poly` used to
     fall back to `"#ffffff"` on any failure, silently painting solid white
     boxes over textured art when there's no bubble. Now returns `None`
     (falls through to no fill) whenever the sampled region is either
     genuinely unreadable, or textured — measured via per-channel Median
     Absolute Deviation, not stddev (stddev falsely flags solid saturated
     colours as "textured" due to their own cross-channel spread, and MAD
     avoids anti-aliasing edge-pixel outliers). New config knob
     `BACKGROUND_FILL_MAX_SPREAD` (default 20.0).
   - **D7** (worker `render.py` + frontend `fitText.ts`) — the font-size
     search capped itself at `min(height/2, width/3, 72)`. The `width/3`
     term was wrong and was silently capping short text in narrow-but-tall
     bubbles (e.g. sample1's `145×259` box capped at 48px regardless of how
     little text there was). Fixed in both the Python and TypeScript twins:
     `min(height/2, 72)`.
   - **D12** (frontend `fitText.ts`/`Reader.tsx`) — canvas PNG/ZIP exports
     never triggered a web-font load before drawing, so `fillText` silently
     fell back to the browser default font. The live reader never hit this
     because it renders text as real DOM nodes (normal `@font-face` swap
     applies). Fixed with a new `ensureFontsLoaded()` helper, awaited before
     each export's draw loop.
   - **D13** (worker `render.py`) — `fit_text_in_box_py`'s polygon-wrapping
     path computed line width against a slightly inset box, while the
     caller centred/clamped the drawn text against the *outer* box
     (`ex,ey,ew,eh`). Invisible while D7 kept fonts undersized; once D7 was
     fixed and fonts got bigger, a line fit for the bubble's wide middle
     could land a few pixels outside an oval mask's narrower band —
     producing visible text overflow past the bubble edge. Fixed by
     introducing single-source-of-truth `text_box_x/y/w/h` locals used by
     both the fit call and the draw geometry. **Live-verified**: re-rendered
     the same image before/after, overflow gone.
   - **Not a new bug** — a screenshot showing a "wrong-shaped" bubble in the
     live reader is the pre-existing, already-documented **D4** (region
     merging): a YOLO bubble-detection mask spanning two touching balloons,
     detected as one instance. Confirmed by matching `bubble_id` in the DB
     and rendering the exact polygon standalone. Expected behaviour on this
     branch's `OCR_MERGE_THRESHOLD=1.0`, unrelated to anything changed this
     session.

## Known caveats / not yet done

- **D12 and the `fitText.ts` D7 fix are not live-E2E verified.** Coverage
  today is: full lint clean, `tsc -b` clean (66 pre-existing unrelated
  errors elsewhere, none in touched files), full vitest suite passing
  (336/336 including new targeted tests for both). A live check would
  require rebuilding the Java backend image (frontend is bundled into it),
  which wasn't done this session because it's much slower than the
  worker-only rebuild used to verify D13. **Do this before trusting exports
  in production.**
- `corpus/` (separate git repo, submodule-like) has **uncommitted,
  in-progress work** — your own 40-SFW/40-NSFW sample-building task
  (`sample1/created-on-test-branch-v1/`, `sample40/created-on-test-branch/`,
  and renames under `sample1/old/`). Left untouched all session; don't let
  tooling silently commit/reset it.
- `config/providers.json` has your own in-progress model swap
  (`qwen/qwen3-235b-a22b-2507`) — present and untouched by any of the fixes
  above, confirmed still intact after the Cloudflare port.
- Still open, not addressed this session (tracked in
  `docs/render_quality_gap_2026-08-05.md` / `TODO.md`): D1 (real inpainting
  vs. flat-fill), the 72px absolute font-size cap, fill-ratio-targeted
  sizing, dictionary-based hyphenation.
- GitNexus's index is stale as of this session's edits (last indexed
  `6c8da85`); run `node .gitnexus/run.cjs analyze` (or `npx gitnexus
  analyze`) before relying on `impact`/`context`/`detect_changes` next time.

## Push state

Everything above is pushed to `github`/`origin`. `git status` is clean on
both branches in both repos except the pre-existing, intentional `corpus`
dirtiness noted above.
