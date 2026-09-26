# R3 Packet 4 — measurement handoff (for a Sonnet session)

Written 2026-09-25 for a delegated run. It turns the three R3 gates into a run you can follow step by step.
The coordinating session keeps the judgement: it reads your artifacts, decides pass or fail, and
updates the tracker. **You measure and record. You do not tune, fix or re-scope.** If something needs a
decision, stop and write it down (section 7).

Read first, in this order:
1. This file.
2. [Tracker status](../output-quality-implementation-tracker.md#status-at-a-glance-2026-09-26--test-round-passed-r3-closes-in-a-new-chat), then the 2026-09-25 sections below it.
3. [R3 handoff § Packet 4](R3-phase-separation-handoff-20260921.md#packet-4--measurement-and-the-bounded-gate) and its "Three separate acceptance decisions" table.
4. [R3.md § time](R3.md#time--this-is-the-failed-part) — the historical numbers you will be compared with.
5. [R6.md § Gate runbook](R6.md#gate-runbook) — the stack and harness commands this runbook reuses.

## 0. Before you start: decisions the user must record

Do not start step 2 until D1–D5 have an answer written into section 8 of this file (date plus the
user's words). If one is blank, stop and ask. **Silence is not approval.**

| # | Decision | Why it blocks the run | Proposal (not approved) |
|---|---|---|---|
| D1 | **Spend cap** for this packet | Every page makes paid translation and QA calls | US$1.00 for canary + six fixtures + short list. The 25 controls are a separate cap, asked for after step 5 |
| D2 | **Latency ceilings** (ordinary page; stress page) | Without numbers the performance gate cannot pass, only be described | Ordinary page (≤ 20 regions): first translated artifact ≤ 5 min, completion ≤ 10 min. Stress (`sample61`, 63 regions): completion ≤ 20 min. No single provider request > 60 s (the project's standing bar: a request over a minute is a failure, however good the answer) |
| D3 | **Timing host** | Laptop timings are contention noise while anything else runs | Quality runs on the laptop; the timed run on chrome-box (quiet box), same tree and images |
| D4 | **Model pins** for the run | The harness pins translation = DeepSeek V4 Pro and QA VLM = Gemini 3.1 Flash Lite. The deployment QA default is now GLM 5.3 Flash, and Flash Lite returned empty on one explicit page | Translation DeepSeek V4 Pro (unchanged); QA VLM GLM 5.3 Flash. Change `PIPELINE_SETTINGS` in `scripts/playwright/capture_quality_baseline.cjs` only if the user says so |
| D5 | **Reconstruction method** measured | Cleanup mode is now selectable (System Settings or per chapter/series: `auto` = TELEA on flat + AOT-GAN on detailed, `telea`, `aot`, `off`). LaMa-mpe measured +1.2 dB over AOT (2026-09-20) but is not available: it needs a clean-room reimplementation first | Measure `auto` (the default). Optionally a second pass of the six fixtures in `aot` to see what forcing AOT costs and buys. Each pass is its own run directory and chapter; record the mode in the README identity |
| D6 | **Control denominator** | Tracker says 24; the harness lists 25 (`sample641`, added 2026-09-19). **Blocks only the 25-control sweep, which comes after this packet**, so a blank D6 does not stop steps 2–6 | 25; report 24 + `sample641` separately |

## 1. Rules

- **No paid work outside the approved cap.** Stop at 80 % of D1 and report.
- **No rebuild, restart or deploy mid-run.** A worker restart costs a running page up to five minutes
  plus the 120 s lease, and makes its timing worthless. If a stack must restart, label the run
  "interrupted" and start a new run directory.
- **Drain before deploying.** Jobs queued before R3 Packet 2 lack lease headers, and the backend
  409s them. Start from a fresh stack (new project name), as in the R6 runbook.
- **Trust artifacts, not success lines.** Count layers in every `project.json` — captures have
  finished "ok" with `"layers": []` when the export raced the pipeline; re-run that page — and read job rows from the database, not the harness summary.
- **Missing evidence is "not executed", never a pass.** A test that skips because a service was
  absent did not run.
- **Do not touch** A09, frozen evidence, `corpus/samples/*` sources, earlier run directories, the
  tracker, `docs/issues.md`, or git (no commits, no pushes).
- **No credentials, source images or raw dialogue** in any document you write. Account files go in
  `logs/` (gitignored), as in R6.
- **Chrome-box hazards** (if D3 says chrome-box): its watchtower restarts the labelled `backend` and
  `worker` containers daily. Pause it for the run. Its root disk is ~98 % full; `docker builder
  prune` is safe, `docker volume prune` is **not**.

## 2. Stack

From the repo root, on the host D3 names (chrome-box: read §2a first; its steps 6–7 replace the
volume loop below). It follows R6's runbook with a new project name:

```bash
RUN=r3p4-$(date +%Y%m%d)
# Model volumes copied from an existing dev stack so the OCR/CTD/AOT models are byte-identical.
for v in paddlex huggingface; do
  docker volume create manga-quality-${RUN}_dev-$v >/dev/null
  docker run --rm -v manga-quality-dev_dev-$v:/from:ro -v manga-quality-${RUN}_dev-$v:/to alpine sh -c 'cp -a /from/. /to/'
done
DEV_PROJECT_NAME=manga-quality-$RUN DEV_HTTP_PORT=18090 docker compose -f docker-compose.dev.yml --env-file .env up -d --build --wait
DEV_PROJECT_NAME=manga-quality-$RUN docker compose -f docker-compose.dev.yml logs -f --no-color backend worker page-renderer > logs/$RUN-stack.log 2>&1 &
```

Record in the run README: the parent and worker commit hashes (`git rev-parse HEAD`,
`git -C worker rev-parse HEAD`), the image IDs (`docker compose … images`), the host's CPU/RAM and
worker CPU limit (`WORKER_CPUS`), and the `.env` values of `MAX_HEAVY_SLOTS`, `MAX_LIGHT_SLOTS`,
`CLOUD_CONCURRENCY`, `RENDER_DEBOUNCE_SECONDS` and `RENDER_BUSY_WAIT_SECONDS`, and from System Settings the
cleanup mode, the OCR grouping threshold, and the text-box padding %, min px, max px and safety %. On a
fresh stack these are the defaults (`auto`, 0.35, 4 %, 0 px, 4 px, 100 %); if any differs, stop and ask.
Leave *Custom model IDs* empty. **Not** the secrets.

**Laptop contention.** If D3 puts any timed run on the laptop, stop the everyday dev stack first
(`docker compose -p manga-quality-dev -f docker-compose.dev.yml stop`, which keeps its data): two
workers on two cores make every timing contention noise. Start it again when the run ends.

The first registration on a fresh database is the admin. Register it through the harness's
`--register` and save the account in `logs/$RUN-account.env`, as R6 did.

## 2a. Chrome-box (D3) and the model chain (D4)

D3 puts this run on **chrome-box** (the quiet box). Chrome-box has no Node, so the stack runs there
and the harness runs on the laptop through an SSH tunnel. The commands in sections 2, 3 and 5 are
the same apart from where they run.

**On chrome-box** (`ssh chrome-box`):
1. **Leave production alone.** `~/Documents/docker-composes/manga-tl` is the live deployment (on
   `main`, ghcr images, with its own staged edits). Do not pull, build, stop or edit anything there.
2. **Pause watchtower for the whole run:** `docker stop watchtower`. It restarts labelled containers
   daily, which would interrupt the run. Start it again at the end with `docker start watchtower`.
3. **Fresh clone of the branch**, worker submodule only (the corpus stays on the laptop):
   ```bash
   git clone --branch feat/output-quality https://github.com/sagniKdas53/manga-tl.git ~/Documents/docker-composes/manga-r3p4
   cd ~/Documents/docker-composes/manga-r3p4 && git submodule update --init worker
   ```
   Check that `git rev-parse HEAD` and `git -C worker rev-parse HEAD` equal the laptop's
   `github/feat/output-quality` and its worker pointer.

**From the laptop, into that clone:**
4. **The cleanup and bubble models.** They are bind-mounted, not built into the image. Copy them,
   then check the hashes on chrome-box:
   ```bash
   scp data/bootstrap/{yolo11n_bubble,ctd_seg_dyn,lama_aot}.onnx chrome-box:Documents/docker-composes/manga-r3p4/data/bootstrap/
   ssh chrome-box 'cd Documents/docker-composes/manga-r3p4 && sha256sum data/bootstrap/*.onnx'
   # expected:
   # c9208cb610aa35b8f8dc7ef0890182322992a43399a853093ad5d04a3764af4f  yolo11n_bubble.onnx
   # a0e08c52bdd493e795ee5572a973f5ea6a4630f068e1c229bf23f41796929de9  ctd_seg_dyn.onnx
   # c5965aca4e5ffa8269051dca1fc30e379d2bded46e0a55366e299ade47086cfc  lama_aot.onnx
   ```
5. **Configuration.** Copy `.env` and `secrets/` (credentials: `scp` only, never into a document), then
   edit **the clone's** `.env`:
   - `TL_LLM_MODEL=deepseek/deepseek-v4-flash`. This is the pipeline's one translation fallback (see D4).
   - `DEV_HTTP_BIND=127.0.0.1`. Reach the stack through the tunnel, not the LAN.

   Then regenerate the runtime env on chrome-box: `python3 scripts/dev_setup.py init --non-interactive`.
   It keeps the existing credentials. Check that `secrets/runtime/models.env` now has
   `TL_LLM_MODEL=deepseek/deepseek-v4-flash`.
6. **Model caches.** The `paddlex`/`huggingface` volumes (section 2) come from the laptop's dev stack
   over SSH, not from a local stack:
   ```bash
   for v in paddlex huggingface; do
     ssh chrome-box docker volume create manga-quality-${RUN}_dev-$v
     docker run --rm -v manga-quality-dev_dev-$v:/from:ro alpine tar -C /from -cf - . \
       | ssh chrome-box docker run --rm -i -v manga-quality-${RUN}_dev-$v:/to alpine tar -C /to -xf -
   done
   ```
7. **Up.** Run the section 2 `docker compose … up` line on chrome-box, in the clone. Send the log
   stream to a file on chrome-box and copy it back at the end.
8. **Tunnel**, from the laptop, for the whole run:
   `ssh -N -L 18090:127.0.0.1:18090 -L 19090:127.0.0.1:19000 chrome-box`. The harness then uses
   `--base http://localhost:18090/tlhub` unchanged, and MinIO is `localhost:19090` (the laptop's own
   dev MinIO holds 19000). The database has no host port: query it with
   `ssh chrome-box docker exec manga-quality-${RUN}-db-1 psql -U tladmin -d manga_library -Atc "…"`.
   `cleanup_composite.py` must take its database and MinIO access as arguments, so that this works.

**The model chain (D4).** The user asked for GPT-6 Luna, falling back to DeepSeek V4 Flash, then
GLM 5.3 Flash. The pipeline supports one translation fallback: the pinned model, then the worker's
global `TL_LLM_MODEL` (set to DeepSeek V4 Flash above), and only when *Use Fallback Models* is on.
There is no third hop. GLM 5.3 Flash is the QA vision model (its default).
1. **Register Luna before anything is uploaded.** Right after the admin account exists:
   `PUT /api/settings/custom-models` with
   `[{"provider":"openrouter","task":"tl","id":"openai/gpt-6-luna"}]`.
   The curated catalog does not list it. Without this step, every job would quietly swap the series
   pin for the global model, and the run would measure DeepSeek V4 Flash while claiming Luna.
2. **Edit the harness** (`scripts/playwright/capture_quality_baseline.cjs`, working tree only):
   - `TL_MODEL = "openai/gpt-6-luna"`;
   - `qaLlmModel: "deepseek/deepseek-v4-flash"` and `qaVlmModel: "z-ai/glm-5.3-flash"`, in both the
     series and the chapter bodies;
   - `useFallbackModels: true` in both;
   - `PIPELINE_SETTINGS` to match, so the capture records what was asked for.

   Revert the edit when the run ends and say so in the README.
3. **Canary check:** the worker log shows `Provider=openrouter Model=openai/gpt-6-luna` for the
   page's translation. If it shows another model, stop: the registration did not take.

## 3. Canary — one page, end to end (≈ US$0.02)

```bash
set -a; . logs/$RUN-account.env; set +a
node scripts/playwright/capture_quality_baseline.cjs --base http://localhost:18090/tlhub --skip-rendered \
  --out docs/quality-runs/$RUN-canary --fixture sample177 > logs/$RUN-canary.log 2>&1
```

Check, and write each result down:
- Jobs: one of each of `ocr`, `layout`, `cleanup`, `translation`, `render`, `qa` for the page;
  retries and statuses from the `jobs` table; no `FAILED`.
- `a04-exports/sample177/project.json` has non-empty layers.
- `/api/pages/{pageId}/rendered` bytes hash equals the ledger artifact (`page_render_jobs`) for the
  current revision.
- Per-stage times, from the worker's `[RQ Worker] Job … (stage) started … Ns since enqueue` and
  `… completed in Ns` lines: queue wait and service time for each stage.

If any check fails, stop (section 7).

## 4. Cleanup-only capture — the missing tool (R3f/R3g)

R3's quality gate scores **cleanup separately from the English**. No tool does this yet. Write one
small, read-only script, `scripts/quality/cleanup_composite.py`, and nothing else:

- **Input:** a run directory and the stack's DB/MinIO. It reads `ocr_regions.cleanup_patch_asset_id`
  / `cleanup_bounds` / `cleanup_mask_*` for each captured page, the source image, and the patch and
  mask PNGs from MinIO (`scene-assets/{page_id}/{sha}.png`).
- **Output**, per page, in `a04-exports/<sample>/cleanup/`:
  - `cleanup-only.png` — the source with every patch composited at its bounds and **no text**;
  - `mask-union.png` — the union of the masks, for the recall check;
  - `regions.json` — one row per region: id, bounds, status, whether a patch exists, and the
    `cleanup_diagnostics` code (review, uncertain or failed; that code only, never the text).
- **Two measurements**, written to `cleanup.json`:
  1. **Outside-support invariance.** The count of pixels that differ from the source outside the
     union of the patch bounds. It must be 0; anything else is a defect to report.
  2. **Residual-ink proxy inside each patch.** Run the worker's CTD (`services/glyph_mask.py
     segment_crop`) on each patched crop of `cleanup-only.png` and report the % of the original
     mask still detected. This is the check removed at runtime in Packet 2
     (`cleanup_reconstruct._residual_ink_pct`, retained for offline use), so call that helper rather than
     writing a new one.
- It makes no paid calls, writes nothing to the database, and performs no retries.
- A focused test on a synthetic 3-region image goes under `scripts/quality/tests/` if that
  directory exists, otherwise beside the script.

Run it on the canary. Put `cleanup-only.png` next to the source in the README, and read it
yourself: note text left behind, smears and broken outlines, region by region, in plain words.

## 5. Six fixtures + short list (≈ US$0.30–0.60)

The harness runs pages in its own order, and `sample61` exceeds its 30-minute window
(`PIPELINE_TIMEOUT_MS`). Run it in two calls, as R2/R3 did:

```bash
node scripts/playwright/capture_quality_baseline.cjs --base http://localhost:18090/tlhub --skip-rendered \
  --out docs/quality-runs/$RUN-six --fixture sample177 --fixture sample222 --fixture sample99 \
  --fixture sample93 --fixture sample83 --fixture sample7 --fixture sample197 --fixture sample641 \
  > logs/$RUN-six.log 2>&1
node scripts/playwright/capture_quality_baseline.cjs --base http://localhost:18090/tlhub --skip-rendered \
  --out docs/quality-runs/$RUN-sample61 --fixture sample61 > logs/$RUN-sample61.log 2>&1
```

If the harness times out on `sample61`, do not requeue it. Wait for the backend to finish the page
(watch its jobs), then capture it with `scripts/playwright/capture_existing_page.cjs`. Record both
the harness abort and the real completion time.

Then, for both run directories:

```bash
.venv/bin/python scripts/quality/reference_compare.py --run docs/quality-runs/$RUN-six
.venv/bin/python scripts/quality/reference_compare.py --run docs/quality-runs/$RUN-sample61
.venv/bin/python scripts/quality/cleanup_composite.py --run docs/quality-runs/$RUN-six      # step 4's tool
.venv/bin/python scripts/quality/cleanup_composite.py --run docs/quality-runs/$RUN-sample61
```

## 6. What to record: the run README

Write `docs/quality-runs/$RUN-six/README.md` with these sections, in this order, filled with
numbers from the artifacts:

1. **Identity:** commits, images, host, limits, models (D4), date/time (UTC).
2. **Reliability table**, one row per page. Columns:
   - job count per stage and the attempts on each;
   - any FAILED, 409 or stale-recovery lines in `logs/$RUN-stack.log`;
   - QA verdict coverage: expected targets vs returned verdicts, from the QA job metadata;
   - whether `project.json` has layers;
   - whether the export hash equals the artifact hash.
3. **Performance table**, one row per page. Columns:
   - queue wait and service time per stage;
   - time to the first translated artifact (the first `render` completion) and to completion;
   - the number of cleanup regions;
   - the slowest provider request and whether it crossed 60 s.

   Compare each row with the D2 ceilings. Mark sample counts; three pages is not a p95.
4. **Cleanup table** (from `cleanup.json`), one row per page. Columns:
   - outside-support differing pixels;
   - residual-ink % per region (min / median / max);
   - regions in review, uncertain or failed.

   Then your per-region visual notes from `cleanup-only.png` crops. Compare with R3.md's five pages
   where they overlap.
5. **reference_compare.md highlights**, copied as numbers, not re-derived.
6. **Spend:** the sum of `job_costs` for these pages (SQL in section 9), estimated vs billed where known.
7. **Protected-art checklist:** one row per item in the tracker's
   [per-fixture acceptance checklist](../output-quality-implementation-tracker.md#per-fixture-acceptance-checklist)
   that concerns cleanup, filled from the `cleanup-only.png` crops. For example, sample99's preserved
   SFX unchanged, sample83's central art protected, sample93's large page completing. Outside-support
   invariance cannot see art damaged *inside* a patch's bounds; these rows are how that gets looked at.
8. **Not executed:** everything this runbook asks for that did not happen, and why.

Do **not** write "passed" or "failed" for a gate. Put the evidence next to each gate's rule from the
R3 handoff's table and leave the verdict to the coordinator.

## 6a. What this packet does not cover (say so in the README)

- **Reliability cases that need a disturbance.** The R3 reliability gate also asks for:
  - a worker killed mid-stage (recovery time, attempts, no duplicate downstream job);
  - an edit during cleanup;
  - a cancel;
  - a page deleted during cleanup.

  The rules above forbid restarts, so this run cannot produce that evidence. If the user wants it
  now, it is a separate, labelled run: its own run directory, one fixture (`sample177`), no timing
  claims. Otherwise list it under "Not executed", so nobody reads this packet as having closed
  reliability. The code paths have integration tests (`backend-rust/tests/stage_recovery.rs`), which
  are not live evidence.
- **Replay before live.** The R3 handoff asks for recorded OCR/translation outputs to be replayed
  first, isolating cleanup without paid calls. No replay tool exists, so this packet goes straight to a live
  canary. Record that deviation.
- **Editor/export equality (R7) and fitting (M7)** are separate gates.

## 7. Stop conditions — stop, write down what you saw, and ask

- Any decision in section 0 is missing.
- Spend reaches 80 % of D1.
- A page FAILs, a job 409s repeatedly, or a stale recovery re-dispatches a live job.
- `project.json` is empty twice for the same page.
- Outside-support invariance is non-zero on any page. This is a defect, not noise.
- The stack or host needs a restart.
- Anything asks you to change pipeline code, thresholds, models or harness pins beyond D4.

Harmless noise you will see (do not fix it):
- ONNX Runtime `VerifyOutputSizes` warnings, one per CTD call.
- `400 with json_schema — degrading to json_object`, once per Luna translation request. OpenAI's
  strict mode rejects our schema, and the client forgets the downgrade between calls
  (`AUDIT-W15`), so each request costs one extra round trip. Count these lines per page.
- `Batch: Falling back to 'openrouter' with model 'deepseek/deepseek-v4-flash'` means Luna failed
  for that chunk. This is not a stop condition, but count it per page: a fallback-translated page is
  not a Luna page.
- `[OCR] Grouping threshold 0.35 characters`, once per OCR job. Any other value means a setting
  was changed: a stop condition.
- `[Render] Renderer was busy; waited N time(s)` when two renders overlap. The render service holds
  one context by design (UR02), and the worker now waits for it inside the job. Record the count.
  A FAILED render with `renderer context capacity is exhausted` would mean the wait ran out (300 s),
  which is a stop condition, not noise.
- Region redos and debounced renders logging "waiting" while other stages run on the page.

## 8. Decisions recorded (fill before step 2)

| # | Decision | User's answer | Date |
|---|---|---|---|
| D1 | Spend cap | US$1.00 (the proposal) | 2026-09-26 |
| D2 | Latency ceilings | "Record only": measure and report every time; no pass line, so the performance gate stays open | 2026-09-26 |
| D3 | Timing host | Chrome-box, whole run: "We can deploy on the chromebox now without any worries as I have fixed the space issues, we just need to pull the new branches and also copy the cleanup models before building the images" (see §2a) | 2026-09-26 |
| D4 | Model pins | Translation GPT-6 Luna (`openai/gpt-6-luna`), then DeepSeek V4 Flash, then GLM 5.3 Flash: "since these are image quality tests and not translation quality tests, so using flash models should be good enough for speed and cost". The pipeline has one fallback hop, so this runs as Luna → DeepSeek V4 Flash, with QA LLM DeepSeek V4 Flash and QA VLM GLM 5.3 Flash (see §2a) | 2026-09-26 |
| D5 | Reconstruction method | `auto`, after comparing forced TELEA and forced AOT-GAN chapters on the dev stack: "The current auto mode is actually perfect for what we are doing now" | 2026-09-26 |
| D6 | Control denominator | | |

## 9. Useful queries

```sql
-- Stage timeline for one page
SELECT type, status, attempt, created_at, started_at, updated_at, left(error, 80)
FROM jobs WHERE page_id = '<page>' ORDER BY created_at;
-- Spend for a run's pages
SELECT j.type, count(*), sum(c.estimated_cost) FROM job_costs c JOIN jobs j ON j.id = c.job_id
WHERE j.page_id = ANY('{<page ids>}') GROUP BY j.type;
-- Cleanup outcome per region
SELECT bubble_reading_order, qa_status, cleanup_patch_asset_id IS NOT NULL AS patched, cleanup_bounds
FROM ocr_regions WHERE page_id = '<page>' ORDER BY 1;
```

Check the column names against `database/init.sql` before trusting these; it is the whole schema
(`LOCK-3`).

## Prompt to start the Sonnet session

> Read `docs/quality-checkpoints/R3-packet4-measurement-handoff-20260925.md` and follow it exactly.
> - Check that section 8 answers D1–D5; if not, stop and ask me.
> - The stack runs on chrome-box and the harness on this laptop, as §2a says. Set `RUN` once and use the same value on both hosts.
> - Never touch the production checkout on chrome-box. Pause watchtower for the run and restart it after.
> - Do not change pipeline code, models, thresholds or the tracker, and do not commit.
> - Write only `scripts/quality/cleanup_composite.py` (+ its test) and the run README. The one exception is the §2a harness edit for D4; revert it at the end.
> - Stop on any section 7 condition.
>
> At the end, give me the README path, the spend, the fallback count, and the list of things not executed.

