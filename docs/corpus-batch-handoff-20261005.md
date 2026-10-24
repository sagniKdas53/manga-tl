# Corpus batch harness — handoff (2026-10-05)

State of `corpus_batch.cjs` work at end of session, for whoever picks it up next.

## What this is

`scripts/playwright/corpus_batch.cjs` submits N corpus samples to a tl-hub instance as **one
series + one chapter**, then harvests each finished page's artifacts back to disk. Runbook:
`docs/guides/corpus_batch_harness.md`. No service code is touched.

**PR:** https://github.com/sagniKdas53/manga-tl/pull/232 — branch `feat/corpus-batch-harness`,
commit `989a1e3` (3 files, 1575 insertions).

**Committed in `e6d2e5d`** (were uncommitted when this was first written): `scripts/playwright/corpus_batch.cjs` (+68/−3):

- `--submit-concurrency` default changed **4 → 1** (see Defect 1) with a loud warning when >1.
- Post-submit **page-number reconciliation**: after uploads, look up each `pageId`'s real
  `pageNumber` and correct entries whose requested number was clamped (also marks pages that never
  landed as `upload-failed` instead of letting them hang for the full timeout).
- Upload 500s now explain the concurrent-upload race instead of raw `Internal Server Error`.
- `ensureChapter` reports the real 409 body and the numbers it tried instead of the generic
  "no free chapter number" message.

## Verified results (all in gitignored `docs/quality-runs/`)

| run | sample(s) | state | output dir |
| --- | --- | --- | --- |
| `corpus-batch-smoke` | sample1 | 5/5 artifacts | `docs/quality-runs/corpus-batch-smoke/001-sample1/` |
| `corpus-batch-smoke2` | sample1, 2 | 5/5 each; `--resume` → "2 already captured, 0 to do" | `…/corpus-batch-smoke2/00{1,2}-sample{1,2}/` |
| `corpus-batch-smoke5` | sample1–5 | 5/5 each, no warnings, 473s | `…/corpus-batch-smoke5/00{1..5}-sample{1..5}/` |
| `corpus-batch-append/runA` + `runB` | 1–2 then 3–4 | **one chapter** `8a6a8b80…`, page 1–2 numbering intact, guard refuses populated chapter without `--append` | `…/corpus-batch-append/{runA,runB}/` |
| `corpus-batch-current` | sample1, 2 | on **rebuilt** image `e105ff0` | `…/corpus-batch-current/00{1,2}-sample{1,2}/` |
| `corpus-batch-qwen3` | sample242, 136, 263 | **3/3 done**, QA inherited (defaults) | `…/corpus-batch-qwen3/00{1,2,3}-sample{242,136,263}/` |
| `corpus-batch-qwen3-qa` | sample242, 136, 263 | 1 done / 1 upload-500 / 1 timeout — see Defects | `…/corpus-batch-qwen3-qa/` |
| `corpus-batch-qwen3-qa2` | — | aborted before submit — see Defect 2 | (no dir) |

Each page dir: `render.png`, `export.png`, `project.zip`, `project/` (unpacked), `editor.png`
(Clean scanlation on), `page.json`, plus `run.json` at each run root.

**⚠ `corpus-batch-qwen3-qa/003-sample263/` is INVALID.** Its `page.json` says captured page
number 2 with image id `543e774d…`, and its `project.json` says image id `aaf1baca…` — neither
matches sample263's page id `66d6d9b0…`. The entry asked for page 3 in a 2-page chapter; the
reader clamped, and unrelated page-2 project bytes were saved under sample263's name. Delete the
directory. The reconciliation fix above prevents this class of corruption but the fix is NOT yet
in a committed run.

Good data: `corpus-batch-qwen3` (all 3), `corpus-batch-current` (2), `corpus-batch-append` (4),
`corpus-batch-smoke5` (5), `corpus-batch-smoke2` (2), `corpus-batch-smoke` (1).

## Local stack

- Dev compose is up with a **freshly rebuilt** backend: `docker compose -f
  docker-compose.dev.yml up -d --build` (image `e105ff0`, built 2026-10-05 20:26 IST). The earlier
  verification ran against a cached 2026-10-04 18:49 image that was **20h / 14 commits stale** —
  that is why early runs hit the old "Export Page (PNG)" labels. Check
  `docker images --format '{{.CreatedAt}}' manga-quality-dev-backend:latest` before trusting UI.
- Base URL `http://localhost:18080/tlhub`. Worker uses `deepseek/deepseek-v4-pro` via OpenRouter
  as the instance TL default.
- Throwaway accounts registered by the runs (role admin — first registrations on a fresh DB) are
  left on the instance: `corpus-batch-*@example.invalid`, passwords printed in each run's log
  under `logs/corpus-batch-*.log`. No account-delete route is reachable.
- Leftover test series: `Corpus Batch Smoke ja` (`18f9077e-32bd-4226-a64c-b1e976e7df78`) with
  chapters 1–9, including an **empty-title chapter 7** (`ff6357fc…`) and a `probe-create` chapter 9
  (curl probe). Safe to delete; they only clutter the dev DB.

## How jobs are actually processed (the "is it random?" answer)

FIFO in push order = upload order, not random:

1. A stage is a `jobs` row (PENDING) whose payload is RPUSHed onto Redis `queue:<type>`
   (`backend-rust/src/jobs/coordinator.rs`).
2. One dispatcher polls every 2s, gates on a global Redis pause flag, asks workers for free
   heavy/light slots, then LPOPs heavy-first and POSTs each payload (`jobs/dispatcher.rs:85-136`).
3. Worker runs one thread per accepted job, heartbeats a 120s lease; each stage queues its
   successor inside the callback transaction.

No page/chapter-level status exists; all liveness lives in `jobs` + `page_render_jobs`. The
harness predicates "done" on: renderStatus `ready` **and** no PENDING/PROCESSING/PAUSED jobs for
the page.

## Defects found (service-side; do NOT fix per "test only" instruction)

**1. Concurrent uploads into one chapter can panic the backend (500).**
`insert_page` reads `MAX(page_number)+1`, clamps the requested number into that range, then
inserts with no lock between read and insert; the losing INSERT trips the `(chapter_id,
page_number)` unique constraint on a `.expect()` and the catch-panic layer answers a 500 with
`instance: "/unknown"` (`backend-rust/src/routes/page.rs:330-348`, `routes/mod.rs:104-105`).
Repro: `--submit-concurrency 3` into one empty chapter — here sample136 500'd, and sample263 got
silently clamped from page 3 to page 2. Harness mitigation (committed in `e6d2e5d`): default
concurrency 1 + reconciliation.

**2. `create_chapter` 409 anomaly (UNRESOLVED).** On the rebuilt image, with chapter numbers
1–9 already in the series, `ensureChapter` computed 10 as the next free number but the POST came
back `409 {"message":"Chapter 8 already exists in this series…"}`. Creating chapter number 9 via
curl on the same series right after **succeeded** (200). The message reports a different number
than was sent, so either the dup query or the message is not looking at what the client sent.
Repro (on current branch): run the script with a fresh `--chapter-title` against series
`18f9077e-…` — it now dies 8× with that message. Next step: capture the raw request body /
backend `create_chapter` trace with the number it parsed, then decide whether the bug is in
`routes/series.rs:757-767` (dup check) or in the client serialisation.

**3. `insert_page` clamping is by-design, not a bug** — it is exactly why `--append` exists.
Uploading onto an occupied slot shifts every later page up by one, silently renumbering what an
earlier run captured. The harness now refuses a populated chapter without `--append`/`--resume`.

## QA findings

- QA text/vision **inherit from instance settings unless pinned** — that is the documented
  default (unset = inherit). First qwen run showed `deepseek/deepseek-v4-flash` +
  `gemini-3.1-flash-lite` for QA and QA ran fine (all `qa` jobs COMPLETED).
- Pinning QA to the same model: `--qa-provider openrouter --qa-mode auto --qa-llm-model
  qwen/qwen3.8-27b:free --qa-vlm-model qwen/qwen3.8-27b:free --fallback-models false`. Valid even
  for the vision slot — Qwen3.8-27B is a vision-language model (image-to-text), per the model card.
- `qwen/qwen3.8-27b:free` is **not** in `config/providers.json` (which only lists qwen3.7-flash,
  qwen3.7-plus, qwen3-235b, qwen3-vl-*). `resolve_setting` stores unknown model strings verbatim
  instead of rejecting them, so OpenRouter accepted it and translation completed. Keep an eye on it.
- Lease/timeout reality: translation on the free qwen is slow. The 3-page concurrent run took
  10 min; one `qa-re-ocr` fix loop on page 1 re-ran translation 3× (15 → 30 elements) and all
  completed fine.

## Next steps

1. **Resolve the 409 mystery** (Defect 2, repro above) — it blocks every subsequent chapter
   creation on an already-populated series.
2. ~~Commit the harness fixes~~ (done, `e6d2e5d`). Still to do: re-run the 3 samples **serially** (new default)
   with QA pinned to `qwen/qwen3.8-27b:free`, and confirm 3/3 valid + `qa` jobs used qwen
   (check via the DB: `SELECT type,status FROM jobs WHERE image_id IN (…)`).
3. ~~Push + update PR #232~~ (done). The corrected three-sample run above still needs verifying.
   2026-10-08: CodeRabbit's round on #232 is fixed on the branch (`--flag=value`, no password in
   the log, 500 bodies kept, the poller survives a failed tick, resume matches pages by source
   file and never re-uploads a page still on the server).
4. Decide with the owner whether Defects 1 and 2 get proper service fixes (out of scope here).
5. Delete the invalid `corpus-batch-qwen3-qa/003-sample263/` artifacts and, when the dev stack is
   done being used, the leftover test series/chapters.

## Stray files

- `omp-session-2026-10-05T15-53-24-530Z_*.html` at repo root: session harness artifact, untracked,
  not part of the PR. Delete when done.
- `/tmp/random3-list.txt`, `/tmp/random3.txt`: the 3 randomly picked samples (sample242, sample136,
  sample263) and the file list used for the qwen runs.