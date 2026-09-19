# R2 — 24-control sweep runbook

> **2026-09-19, after the short list:** `sample7`, `sample197` and `sample641` already ran on this stack ([`r2-20260919-shortlist`](../quality-runs/r2-20260919-shortlist/)); on *this* database they must not be re-uploaded (dedup, below). The sweep now runs once, after `AUDIT-R20` and R3, on a fresh stack — so the list below includes them again and is 25 pages. `sample641` was added as the 25th control by user decision.

Mechanical sweep for the second half of the R2 gate (tracker row R2: "six fixtures **+ 24 controls**"). The six fixtures ran in `docs/quality-runs/r2-20260919-six/`; this runbook produces `docs/quality-runs/r2-20260919-controls/` on the same stack, the same account and the same images, so the two runs are one measurement. Nothing here needs a decision; anything that does is listed under *Stop and report*.

## Preconditions (already true on the laptop, 2026-09-19)

- Stack `manga-quality-r2-20260919` is up: `DEV_PROJECT_NAME=manga-quality-r2-20260919 docker compose -f docker-compose.dev.yml ps` shows backend, worker, page-renderer healthy. Backend on `http://localhost:18087/tlhub`. Images were built from the R2 working tree (worker `aa28db7` + R2 edits; backend/frontend/page-renderer from `feat/output-quality` + R2 edits). **Do not rebuild** — a rebuild from a different tree makes the controls incomparable with the six.
- Account: `logs/r2-named-cases/r2-account.env` (`TLHUB_EMAIL`, `TLHUB_PASSWORD`; gitignored). It is the admin created by the first registration on this database. Do not `--register` again.
- The six-fixture harness has finished (`ps aux | grep capture_quality_baseline` shows nothing; `docs/quality-runs/r2-20260919-six/manifest.json` exists). Two harnesses at once interleave jobs and confuse the per-page timing.
- Stack log capture is running: `docker compose -f docker-compose.dev.yml logs -f --no-color backend worker page-renderer` into a file. If it is not, start one before the sweep and copy it into the run directory as `stack.log` afterwards.

## Run

From the repo root:

```bash
set -a; . logs/r2-named-cases/r2-account.env; set +a
setsid nohup bash -c '
  node scripts/playwright/capture_quality_baseline.cjs \
    --base http://localhost:18087/tlhub --skip-rendered \
    --out docs/quality-runs/r2-20260919-controls \
    --fixture sample7 --fixture sample139 --fixture sample39 --fixture sample47 \
    --fixture sample123 --fixture sample134 --fixture sample150 --fixture sample172 \
    --fixture sample192 --fixture sample197 --fixture sample199 --fixture sample268 \
    --fixture sample289 --fixture sample320 --fixture sample360 --fixture sample416 \
    --fixture sample206 --fixture sample208 --fixture sample226 --fixture sample261 \
    --fixture sample457 --fixture sample609 --fixture sample611 --fixture sample612 \
    --fixture sample641
  echo "harness exit $?"' > logs/r2-controls-harness.log 2>&1 < /dev/null &
```

- `--skip-rendered` is required: the "Export Rendered PNG" button no longer exists (since R1 the "Export Page (PNG)" download *is* the rendered artifact); without the flag the harness times out on the first page's export.
- Sequential, one page at a time; the R1 six took ~55 minutes, so expect **3–4 hours**. Each page has a 30-minute pipeline window in the harness; a page that exceeds it aborts the whole run (`QUALITY BASELINE FAILED`).
- Progress: `tail -f logs/r2-controls-harness.log` shows `<sample>: pipeline running` / `pipeline complete; capturing browser exports`.
- If the harness aborts part-way: **do not delete the run directory.** Note the last completed sample, then re-run with `--out docs/quality-runs/r2-20260919-controls-b` and only the **not yet uploaded** `--fixture`s. Two directories are fine; say so in the report.
- **Never re-upload a sample that already went through this database.** The backend deduplicates images by hash: a second upload of the same bytes is attached to the already-processed image, skips OCR, and queues a bare `render` job with no scene, which fails three times (`render job carries no logicalScene`) and the harness reports "pipeline stopped with 1 failed job". Seen on the R2 six-fixture run (`R2.md`, stack notes). If a sample must be redone, it needs a fresh database (`docker compose down`, remove the `dev-postgres`/`dev-minio`/`dev-redis`/`dev-rendered` volumes, `up -d`, register the account again) — and then it is a different run.
- The laptop has 4 cores and the worker is capped at 2. Do not run anything else heavy (no cargo builds, no other stacks) during the sweep — see the contention note in the tracker.

## Measure

```bash
.venv/bin/python scripts/quality/reference_compare.py --run docs/quality-runs/r2-20260919-controls
```

(and again for `-b` if there is one). It writes `reference-compare.md` / `.json` into the run directory. Then copy the stack log: `cp <your stack log> docs/quality-runs/r2-20260919-controls/stack.log`.

## Report — counts only, from the artifacts, not from the harness output

Per language slice (ja: 7, 139, 39, 47, 123, 134, 150, 172 · ko: 192, 197, 199, 268, 289, 320, 360, 416 · zh: 206, 208, 226, 261, 457, 609, 611, 612, 641 — `sample641` is the 25th control, added 2026-09-19), read from `reference-compare.md`:

1. pages with `WIPE-REGION` (any region > 25 % of page) — gate says 0;
2. pages with `OUTSIDE-BBOX` and the `outside bbox %` value — gate says ~0 (threshold 0.5 %);
3. pages with `REGION-COUNT` (outside ±30 % of Torii's box count) and their `regions ours (distinct) / torii` cell;
4. pages with `DUP-REGIONS` — should be none after the 214 fix; any hit is a new bug, quote the `regions (distinct)` cell;
5. pages with `REFUSAL`;
6. `flattened %` per page next to the same page's value in `docs/quality-runs/a06-c-20260911-controls/` if that run has a `reference-compare.md` (if not, skip; do not generate one there);
7. the `font px ours / torii` column — `ours` should now be filled for every page; list any page where it is `–`.

Also from `stack.log`: `grep -c 'patch refused' stack.log` (the builder's 25 % gate firing; expected 0) and `grep -c 'reason=refusal' stack.log`.

8. **`AUDIT-R10` / `AUDIT-R12` (balloons).** The six fixtures had balloons on one page only, so these are decided on the controls. For every page run `.venv/bin/python scripts/quality/element_geometry.py docs/quality-runs/r2-20260919-controls/a04-exports/<sample>` and count: (a) elements whose `container` is not `free` (balloon regions); (b) among those, any whose container bbox is overlapped by a region of `regionType` `sfx` (read `page-snapshot.json` `ocrRegions`; overlap = bbox intersection > 0) — R12's hypothesis; (c) any container whose bbox is more than 25 % of the page or that spans two visibly separate balloons in `export.png` — R10. Report the three counts per language slice and name the pages for (b) and (c).

Put the numbers in `docs/quality-checkpoints/R2.md` under **Gate → 24 controls** as a table with one row per page (sample, lang, regions ours/torii, largest %, outside bbox %, flattened %, font px, flags) and the seven counts above. Verify the page count in the run directory (`ls docs/quality-runs/r2-20260919-controls/a04-exports | wc -l`) matches the number of rows — the report counts artifacts, not invocations.

## Stop and report (do not fix)

- Any page with `WIPE-REGION` or `outside bbox %` above 2: name it, attach its `export.png` path and the region row from `page-snapshot.json`.
- A harness abort that repeats on the same page after one re-run.
- `patch refused` in the stack log (means a region > 25 % reached the builder despite the merge gate — the worker's area gate did not fire).
- Backend `ERROR` lines in `stack.log` other than the ones from a deleted series.
