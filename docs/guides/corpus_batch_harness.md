# Corpus batch harness

`scripts/playwright/corpus_batch.cjs` pushes a list of corpus samples through a tl-hub instance as
**one series + one chapter holding N pages**, then pulls every finished page's artifacts back to
disk. It is the batch-shaped sibling of `scripts/playwright/export_pending.cjs`: that one works a
single sample, captures it, deletes the page to free page-slot 1, and deletes its scratch container
afterwards. This one keeps the pages, which is what makes the reader's "6/50" counter and the
chapter's Inject Context Memory setting mean anything.

Requires a running instance, Playwright (`npm i -D playwright && npx playwright install chromium`)
and the `unzip` binary.

## Quick start

```bash
# First 200 Japanese samples, in corpus order, on the local dev stack
node scripts/playwright/corpus_batch.cjs \
  --base http://localhost:18080/tlhub \
  --lang ja --limit 200 \
  --series-title "Corpus Batch ja" --chapter-title corpus-upload \
  --ocr-provider local --ocr-model PP-OCRv6 \
  --tl-provider openrouter --tl-model deepseek/deepseek-v4-pro --qa-mode auto
```

`--lang ja` with no `--sample-root` resolves both corpus roots that hold Japanese pages —
`corpus/samples/ja` (211) and `corpus/gaps/pending/ja` (52), 263 in all — and sorts sample ids
naturally, so `sample2` precedes `sample10` rather than following it. `--order lex` reproduces the
flat order `corpus/scripts/pair_index.json` uses.

To submit a named subset, list sample directories or bare image paths one per line (`#` comments
allowed) and pass `--file-list`. On its own that list **is** the whole selection; it only gets added
to `--sample-root` entries when you pass both.

## Accounts

`--email/--password` (or `TLHUB_EMAIL`/`TLHUB_PASSWORD`) are used when given. With neither, the run
registers its own throwaway account and prints the credentials. It asks for `translator`
explicitly, because a registration that omits the role or asks for admin is rejected with
"Cannot register as Admin" (`backend-rust/src/routes/auth.rs:274-289`), and uploading a page already
requires TRANSLATOR or ADMIN (`backend-rust/src/routes/page.rs:411-413`).

The first registration on a brand-new instance is always promoted to admin regardless of the role
asked for (`auth.rs:270-272`), which is what happens on a freshly seeded dev database. The address
is stamped with the run id (`corpus-batch-<hex>@example.invalid`) so the leftover account on the
instance is identifiable; it is not deleted afterwards, because no account-delete route is reachable
from the harness.

## What comes back

Per page, under `<out>/NNN-<sampleId>/`:

| File | Source |
| --- | --- |
| `render.png` | `GET /api/pages/{id}/rendered` — the worker's typeset PNG, the ground truth |
| `export.png` | the reader's Export PNG — the frontend canvas composite |
| `project.zip` | the reader's Export ZIP |
| `project/` | that zip unpacked, so masks and `project.json` are greppable |
| `editor.png` | reader screenshot with **Clean scanlation on** |
| `page.json` | `GET /api/pages/{id}` — layers, elements, `ocrRegions`, conversations |

Plus `run.json` at the root, rewritten after every page, carrying each page's id, terminal state,
element counts, artifact names, warnings and timings.

Clean scanlation is a *view* setting, not a processing one: it hides the OCR boxes on screen
(`frontend/src/components/Reader.tsx:4540-4546`). The exports deliberately ignore it —
`EXPORTABLE_LAYER_TYPES` is translation/sfx/mask regardless of the toggle (`Reader.tsx:224-243`) —
so the screenshot and the two downloads are always consistent with each other.

Output defaults to `docs/quality-runs/corpus-batch-<timestamp>/`, which the repository already
ignores wholesale (`.gitignore` covers `docs/quality-runs/**` for png/jpg/zip/json/log/txt).

## How the instance actually processes work

Worth knowing before changing the shape of a run, because it is **not random**:

1. A stage is a row in `jobs`, PENDING at insert, whose JSON payload is RPUSHed onto the Redis list
   `queue:<type>` (`backend-rust/src/jobs/coordinator.rs`).
2. One dispatcher task polls every 2s. It checks a global Redis pause gate, asks each worker for its
   free heavy/light slots, then LPOPs the queues heavy-first and POSTs each payload to the worker
   (`backend-rust/src/jobs/dispatcher.rs:85-136`).
3. The worker runs one thread per accepted job and heartbeats a 120s lease; each stage queues its
   successor inside the callback transaction.

So the order is **FIFO in push order, which is upload order**. Eleven queues split into heavy
(panel-detection, ocr, cleanup, manual-cleanup, qa-re-ocr, region-redo-ocr) and light (layout,
translation, render, qa, region-redo-tl). `GET /api/jobs` lists active jobs ordered by
`created_at ASC`, and pages/chapters carry no processing status of their own — all liveness lives in
`jobs` and `page_render_jobs`.

### Why submit-all-then-harvest

Submitting one page and waiting for it cannot scale: each page costs minutes of
panel → ocr → layout → cleanup → translation → qa → render, multiplied by the page count. The
harness instead pauses the global queue (`POST /api/jobs/pause`, which gates both the dispatcher's
`run_cycle` and every enqueue), uploads every page so they sit at the head of every queue, resumes,
and then harvests pages concurrently as each one finishes.

The pause is released in a `finally`, and only when this process is what set it — `GET /api/jobs`
is read first, so a queue a human paused stays paused. Jobs already PROCESSING are not cancelled by
the pause; they simply stop being joined by new work. `--pause-queue=false` skips the gate
entirely.

`--submit-concurrency` bounds parallel uploads, `--capture-concurrency` bounds how many pages are
captured at once (one browser tab each — a shared tab would race its own `waitForEvent("download")`).

### Inject Context Memory serialises the chapter

With `--inject-context`, a page is held until every earlier page's panel-detection/ocr/layout/
translation job has left PENDING/PROCESSING (`dispatcher.rs:195-214`). On a 200-page chapter that
turns the run into one long serial chain — roughly one page per translation cycle instead of N in
flight. The flag defaults off, and the run prints a warning when it is on with more than one page.

That is also why this harness keeps its pages: context injection only means anything when the
predecessor is the previous *page* of the same chapter.

## Adding to a chapter that already has pages

A run normally starts at page 1. Reusing a chapter that already holds pages needs `--append`, and
that is not a convenience — it is the only safe way in.

`insert_page` clamps the requested number into `1..=max+1` and, when that slot is taken, shifts
every page at or after it up by one (`backend-rust/src/routes/page.rs:330-337`). Uploading page 1
into a chapter holding pages 1..5 therefore does **not** replace page 1: the old five become 2..6 and
the new page takes 1. Every page an earlier run had already captured silently changes number, and
the manifest's page→sample mapping with it.

So the harness refuses a populated chapter outright unless you say what you mean:

```
Error: chapter 8a6a8b80… already holds 4 page(s) (highest number 4).
  Uploading onto occupied slots would renumber the pages already in it, so this run
  refuses to guess. Pass --append to add after the last page, --resume to re-harvest an
  interrupted run, or point --chapter-title/--chapter-id at an empty chapter.
```

`--append` continues from `highest + 1`, so two runs against one chapter give pages 1–2 and 3–4 in
a single chapter with the first run's numbering untouched. It is mutually exclusive with
`--resume`: resume re-uses page ids an earlier run already submitted, append submits new ones.

Verified: run A (`--limit 2`) filled pages 1–2 of chapter `8a6a8b80…`; run B
(`--offset 2 --append`) logged `appending after page 2: this run fills 3..4` and finished both.
The chapter then listed four pages — `1 source.jpeg`, `2 source.jpg`, `3 source.jpeg`,
`4 source.png`, all `renderStatus=ready` — so the first run's numbering survived. Re-running the
same selection without `--append` stopped at the guard above without uploading anything.

## Interrupting and resuming

`--resume` with the same `--out` re-reads `run.json`, keeps the pages whose state is `done` and
whose `page.json` is on disk, and re-attempts the rest. Because the chapter is resolved by title,
resume also reuses the chapter the previous run created — it refuses to resume if the manifest
belongs to a different chapter. A resumed run submits nothing and never touches the pause gate when
every page is already captured.

## Verified runs

All against the local dev stack (`docker compose -f docker-compose.dev.yml up -d`,
`http://localhost:18080/tlhub`), throwaway account, `--ocr-provider local --ocr-model PP-OCRv6`,
TL inherited (`deepseek/deepseek-v4-pro` through OpenRouter on that instance).

`docker compose up -d` reuses a cached backend image, so the stack can be many commits behind
`main` — check before trusting a UI result:
`docker images --format '{{.CreatedAt}}' manga-quality-dev-backend:latest`. The first runs below
were against a 2026-10-04 18:49 image, ~20h and 14 commits stale, which is why they hit the old
"Export Page (PNG)" labels. After `docker compose -f docker-compose.dev.yml build backend`
(image `e105ff0`, 2026-10-05 20:26) the same two-page run passed again, with the reader rendering
the current UI and matching "Export PNG"/"Export ZIP".

```
registered throwaway account corpus-batch-7909530d@example.invalid
reusing series "Corpus Batch Smoke ja" (18f9077e-…)
created chapter "corpus-upload-smoke2" (c3204846-…) [number=2, ocrProvider=local ocrModel=PP-OCRv6, context=false]
queue paused for submission (0 pre-existing job(s) already in flight …)
submitting 2 page(s), 2 at a time
queue resumed
harvesting 2 page(s), 2 at a time, polling every 8s
  [1/2] page 1 sample1: done (ocr 4, tl 4)
  [2/2] page 2 sample2: done (ocr 8, tl 8)
```

Both pages produced all five artifacts, `export.png` and `render.png` at identical pixel
dimensions (832×1248 and 2981×2384), `project.json` carrying inpainting/ocr/translation layers, and
`cleanScanlation: true` recorded in the manifest. A follow-up `--resume` reused the chapter and
reported `resuming: 2 page(s) already captured, 0 to do`.

### Five pages

`--submit-concurrency 3 --capture-concurrency 2` on the same stack, 473s wall clock for five pages:

```
  [1/5] page 1 sample1: done (ocr 4, tl 4)
  [2/5] page 2 sample2: done (ocr 8, tl 8)
  [3/5] page 4 sample4: done (ocr 9, tl 9)
  [4/5] page 5 sample5: done (ocr 4, tl 4)
  [5/5] page 3 sample3: done (ocr 9, tl 9)
```

All five produced all five artifacts with `cleanScanlation: true` and no warnings. Page 3 landing
last is the point: pages finish in whatever order the pipeline finishes them, and the harvest is
per-page rather than in submission order.

That is ~95s per page on a laptop dev stack, so `--limit 200` is roughly a five-hour run there, and
the cost scales with the translation model. Raise `--capture-concurrency` (each lane is its own
browser tab) before `--submit-concurrency`: uploads are cheap, the wait is the pipeline.

Two things that will show up and are not harness bugs:

- **`uploadStatus: "duplicate"`.** The backend dedupes uploads by content hash
  (`routes/page.rs:479-517`) and clones the existing image's layers instead of running OCR again.
  A corpus page that has been through the pipeline before on this instance comes back as a clone.
- **Reader export button labels differ by build.** `frontend/src` currently renders "Export PNG" /
  "Export ZIP"; the image this ran against rendered "Export Page (PNG)" / "Export Project (ZIP)".
  The harness tries both spellings and fails loudly with the labels it looked for if neither is
  visible.