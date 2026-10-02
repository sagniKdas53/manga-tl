# R3 Packet 4 — measurement run `r3p4-20260926`

Covers three harness invocations against one shared stack/database: the canary
(`r3p4-20260926-canary`, `sample177` alone), the six-fixture + short-list batch
(`r3p4-20260926-six`, this directory), and the stress page (`r3p4-20260926-sample61`). Per the
handoff (`docs/quality-checkpoints/R3-packet4-measurement-handoff-20260925.md`): this document
measures and records: it does not assign a pass/fail verdict to any gate. That is left to the
coordinating session, against the R3 handoff's table and R3.md's historical numbers.

## 1. Identity

- **Commits:** parent `1195db8c3615b76d472118ba1344affcfa4dacdb` (`feat/output-quality`), worker
  `ffc97be75a89aaf62d9e621c06eecd04923b917e` — both match `github/*` at the start of the run.
- **Images** (built on chrome-box, `manga-quality-r3p4-20260926` project):
  `manga-quality-r3p4-20260926-backend:latest` `sha256:39c05728f464`,
  `manga-quality-r3p4-20260926-worker:latest` `sha256:a75faa5b46f4`,
  `manga-quality-r3p4-20260926-page-renderer:latest` `sha256:d038b9a6e50a`,
  `postgres:15-alpine` `sha256:fe0737ba566a`, `valkey/valkey:8-alpine` `sha256:d2e18f3410b6`,
  `purevert/minio:backup` `sha256:52dfd5c0bbd3`.
- **Host:** chrome-box (D3), per §2a — a fresh clone at `~/Documents/docker-composes/manga-r3p4`,
  separate from the live `manga-tl` production checkout (left untouched, confirmed `main` /
  `e92fd79a`, 1 pre-existing dirty file not ours). 4 CPUs, 15 GiB RAM (~6.6 GiB available at
  check time). `WORKER_CPUS`, `CLOUD_CONCURRENCY`, `RENDER_DEBOUNCE_SECONDS`,
  `RENDER_BUSY_WAIT_SECONDS` are unset in `.env` (compose/image defaults apply).
  `MAX_HEAVY_SLOTS=1`, `MAX_LIGHT_SLOTS=3`.
- **System Settings:** only override present in `system_settings` is `customModels` (the Luna
  registration below) — cleanup mode, OCR grouping threshold and text-box padding are all at
  their fresh-stack defaults (`auto`, 0.35, 4%/0px/4px/100%), confirmed both by the empty
  override table and by every OCR job logging `Grouping threshold 0.35 characters` (9/9 jobs).
- **Models (D4):** translation pinned to `openai/gpt-6-luna`, one fallback hop to
  `deepseek/deepseek-v4-flash` (`useFallbackModels: true`); QA LLM `deepseek/deepseek-v4-flash`;
  QA VLM `z-ai/glm-5.3-flash`. Luna itself was registered via
  `PUT /api/settings/custom-models` right after the admin account existed, before any upload —
  confirmed by the worker log showing `Provider=openrouter Model=openai/gpt-6-luna` on the
  canary's very first translation call.
- **Reconstruction method (D5):** `auto` only. The optional second forced-`aot` pass was **not
  executed** — not requested, and D1's cap was scoped to one pass.
- **Date/time (UTC):** stack up ~09:48; canary 09:52–09:57; six-fixture batch 10:16–11:01;
  `sample61` 11:05–11:25; cleanup-composite measurement pass through ~17:29.

## 2. Reliability table

One row per page *instance* (10 rows — `sample177` was uploaded twice, once solo in the canary
and once inside the six-fixture batch; see the flag below). Attempts: every job in the whole run
completed on **attempt 1/3** — zero job-level retries anywhere.

| page (instance) | jobs (type: count) | FAILED / 409 / stale-recovery | QA verdicts | `project.json` layers | export == artifact |
| --- | --- | --- | --- | --- | --- |
| sample177 (canary) | panel-detection, ocr, layout, cleanup, translation, render, qa: 1 each | 0 / 0 / 0 | 6/6 regions | 2 (ocr, translation) | ✅ |
| **sample177 (six-fixture, re-upload)** | render: 2, qa: 1 — **no ocr/layout/cleanup/translation of its own** | 0 / 0 / 0 | n/a (inherited) | 2 (ocr, translation) | ✅ |
| sample222 | panel-detection, ocr, layout, cleanup, translation: 1 each; render: 2; qa: 1 | 0 / 0 / 0 | 18 regions incl. 1 uncertain | 2 | ✅ |
| sample99 | panel-detection, ocr, layout, cleanup, translation, render, qa: 1 each | 0 / 0 / 0 | 14 regions | 2 | ✅ |
| sample93 | panel-detection, ocr, layout: 1; cleanup: 1; translation: 2; render: 3; qa: 2; qa-re-ocr: 1 | 0 / 0 / 0 | 11 regions (redo cycle) | **3** (extra translation layer) | ✅ |
| sample83 | panel-detection, ocr, layout, cleanup, translation, qa: 1; render: 2 | 0 / 0 / 0 | 4 regions | 2 | ✅ |
| sample7 | panel-detection, ocr, layout, cleanup, translation, render, qa: 1 each | 0 / 0 / 0 | 28 regions | 2 | ✅ |
| sample197 | panel-detection, ocr, layout, cleanup, translation, qa: 1; render: 2 | 0 / 0 / 0 | 15 regions | 2 | ✅ |
| sample641 | panel-detection, ocr, layout, cleanup, translation, qa: 1; render: 2 | 0 / 0 / 0 | 12 regions | 2 | ✅ |
| sample61 | panel-detection, ocr, layout, cleanup: 1; translation: 2; render: 3; qa: 2 | 0 / 0 / 0 | 63 regions (redo cycle) | 3 (extra translation layer) | ✅ (re-captured, see §2a) |

Zero `FAILED`, `409`, or stale-recovery lines anywhere in the worker log for the whole run
(`grep -c FAILED` / `grep -c " 409 "` both 0 over 18,892 log lines).

### 2a. Two artifact-integrity issues found and corrected before trusting any number

- **The six-fixture `sample177` is a deduplicated re-upload, not an independent measurement.**
  The runbook lists `sample177` in both the canary (§3) and the six-fixture batch (§5). Uploading
  the same source bytes twice made the backend deduplicate the underlying `images` row (same
  `image_id` `0b7369d4-...`, confirmed by direct query) and reuse its OCR/translation regions on
  the new page, rather than reprocessing. Verified directly: this page's `jobs` rows are only
  `render` (×2) and `qa` (×1) — no `ocr`/`layout`/`cleanup`/`translation` ever ran for it — yet it
  already has 6 `ocr_regions` rows. The cleanup-composite pass on it confirms the same thing from
  the cleanup side: **0 of 6 regions have a cleanup patch at all** (all `cleanup_patch_asset_id`
  NULL), so its render falls through to the legacy flat-fill/no-plate path, not fresh CTD/AOT
  cleanup. Its reliability/performance numbers above reflect only its own render+QA pass; its
  OCR/cleanup/translation stages are "not executed (deduplicated upload)", not fast or free. This
  matches a pre-existing, previously-documented backend behavior (R2 runbook, 2026-09-19), not
  something this run broke.
- **The harness's own "pipeline complete" detection for `sample61` fired early.** Its exported
  `project.zip`/`editor.png`/`export.png` were captured at 11:18:11 UTC, right after the *first*
  translation→render→QA cycle, but the QA verdict then triggered **two more** full
  translation→render→QA redo cycles (a `direct_fix`/re-OCR loop), which kept running until
  11:25:14 UTC. Caught by polling `jobs` for this `page_id` directly rather than trusting the
  harness's log line. Re-captured with `scripts/playwright/capture_existing_page.cjs` (the exact
  tool R1 built for this same situation, 2026-09-18) once every job for the page reached a
  terminal state. The reliability/performance/cleanup numbers below for `sample61` are all from
  that re-capture, not the harness's original (stale) one. `export_png_sha256` ==
  `current_render_png_sha256` on the re-capture, confirming it reflects the true final render.

## 3. Performance table

Per-stage durations are `updated_at - started_at` from `jobs` (queue wait is `started_at -
created_at`, all sub-second in this run — the worker was never backed up). "Redo" rows are a
second translation→render→QA cycle triggered by the first QA pass; D2's ceilings are measured
against the *first* cycle's artifact for "first translated artifact" and the *final* settled
state for "completion", per the handoff's own definitions.

| page | regions | queue→ocr | ocr | cleanup | translation | first render | qa | to first render | to completion | slowest single request |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sample177 (canary) | 6 | 2s | 14.3s | 98.1s | 17.7s | 2.0s | 176.1s (GLM fail→Flash Lite fallback) | 2m21s | 5m17s | **170.1s** (GLM 5.3 Flash, failed) |
| sample177 (six, dedup'd) | 6 (inherited) | n/a | n/a | n/a | n/a | 1.4s | 18.3s | 3s | 31s | 18.3s |
| sample222 | 18 | 2s | 18.1s | 367.7s | 17.5s | 5.1s | 31.2s | 6m56s | 7m34s | ~30s |
| sample99 | 14 | 2s | 18.9s | 246.1s | 14.4s | 5.3s | 243.7s | 4m54s | 8m58s | ~240s (QA VLM) |
| sample93 | 11 (+redo) | 1s | 22.6s | 408.2s | 16.0s + 106.7s (redo) | 15.9s | 17.4s + 47.5s (redo) | 7m50s | 11m31s | ~107s (redo translation) |
| sample83 | 4 (1 cleanup-failed) | 2s | 11.8s | 120.1s | 10.0s | 1.9s | 31.9s | 2m32s | 3m06s | ~32s |
| sample7 | 28 | 2s | 23.7s | 132.8s | 27.4s | 1.3s | 213.4s | 3m12s | 6m47s | **213.4s** (QA VLM) |
| sample197 | 15 | 3s | 20.2s | 244.2s | 14.8s | 2.6s | 66.7s | 4m50s | 6m03s | ~65s |
| sample641 | 12 | 2s | 16.7s | 60.3s | 16.7s | 1.1s | 22.2s | 1m44s | 2m10s | ~20s |
| **sample61 (stress)** | 63 (+2 redo cycles) | 2s | 173.9s | 496.7s | 64.6s + 70.5s + (3rd cycle) | 3.3s | 212.9s + 136.2s | 12m28s | **19m39s** | ~213s (first QA) |

**Against D2's numbers (record only, no pass/fail per the user's 2026-09-26 answer):**
- Ordinary-page ceilings were first-artifact ≤5 min, completion ≤10 min. `sample222` (7 min) and
  `sample93` (7m50s/11m31s) exceeded first-artifact; `sample93`'s completion also exceeded 10 min
  — but `sample93` is a 6764×4961 page, arguably closer to "large-page" than "ordinary" by its own
  tracker acceptance note. `sample7` has 28 regions, over D2's own "≤20 regions" definition of
  "ordinary", so it isn't strictly comparable either.
- `sample61`'s **19m39s** total is close to its 20-minute stress-page ceiling, driven almost
  entirely by cleanup (496.7s = 8m17s) and two QA-triggered redo cycles.
- **No single provider request exceeded 60s except QA VLM calls to `z-ai/glm-5.3-flash`** — see
  §3a. Every other stage's individual provider call (translation, QA LLM, the fallback VLM) was
  well under 60s.

### 3a. The QA VLM fallback isn't a rare edge case in this run

D4 pinned QA VLM to `z-ai/glm-5.3-flash` specifically because the previous default
(`google/gemini-3.1-flash-lite`) "returned empty on one explicit page." Across this run:

- **6 of ~12 QA job executions logged `<model>: no usable reply`** for GLM 5.3 Flash — a fallback
  rate of roughly half, not a one-off.
- **9 fallback-VLM calls to `google/gemini-3.1-flash-lite`** were made (the exact model D4 was
  trying to avoid), and every one of them succeeded quickly (5–20s) where GLM had just failed or
  timed out (up to 213s).
- This fallback path is not in the handoff's "harmless noise" list (§7), so it is not treated as
  expected here — it is recorded because it directly bears on whether "the QA VLM is GLM 5.3
  Flash" was actually true for this run's pages. For at least sample177 (canary), sample7,
  sample99, and sample61, at least one QA pass's real verdict-producing model was Gemini 3.1
  Flash Lite, not GLM.
- Translation's own fallback (Luna → DeepSeek V4 Flash) fired **once** across the whole run —
  Luna otherwise translated directly.
- `400 with json_schema — degrading to json_object` (AUDIT-W15, expected noise): **33
  occurrences**, one extra round trip each, all on Luna translation calls.
- `[Render] Renderer was busy; waited`: **0 occurrences** — no render contention observed.

## 4. Cleanup table

From `cleanup.json` per page (built by the new `scripts/quality/cleanup_composite.py` — see §4a
for a design note on what "outside-support invariance" does and doesn't prove here).

| page | outside-support differing px | residual-ink % (min / median / max, n) | regions: patched / total | uncertain / excluded / failed |
| --- | --- | --- | --- | --- |
| sample177 (canary) | 0 | 0.0 / 0.0 / 0.15, n=6 | 6 / 6 | 0 / 0 / 0 |
| sample177 (six, dedup'd) | 0 | n/a, n=0 | **0 / 6** | 0 / 0 / 0 |
| sample222 | 0 | 0.0 / 0.35 / 5.57, n=16 | 16 / 18 | 1 / 1 / 0 |
| sample99 | 0 | 0.0 / 0.0 / 1.36, n=13 | 13 / 14 | 0 / 1 / 0 |
| sample93 | 0 | 0.0 / 0.10 / 1.53, n=9 | 9 / 11 | 0 / 2 / 0 |
| sample83 | 0 | 0.008 / 0.37 / 1.59, n=3 | 3 / 4 | 0 / 0 / **1** |
| sample7 | 0 | 0.0 / 0.0 / 0.21, n=27 | 27 / 28 | 0 / 1 / 0 |
| sample197 | 0 | 0.0 / 0.0 / 3.93, n=15 | 15 / 15 | 0 / 0 / 0 |
| sample641 | 0 | 0.0 / 0.0 / 0.0, n=9 | 9 / 12 | 0 / 3 / 0 |
| sample61 | 0 | 0.0 / 0.0 / 1.69, n=63 | 63 / 63 | 0 / 0 / 0 |

All residual-ink numbers sit well under the 15% ceiling and the 6.1%-median offline baseline
(21-page validation) — the highest single-region value across the whole batch was 5.57%
(sample222).

**Visual review (`cleanup-only.png` crops), by hand:**
- **sample177 (canary):** all 6 caption/name bands cleanly erased, no visible strokes. Two small
  kanji annotations near two portraits remain visible — these fall outside the 6
  OCR-detected regions entirely, an OCR detection gap, not a cleanup defect.
- **sample83:** the 1 failed region is a small (76×117px) SFX-adjacent gasp next to the
  character's hair/face. Central art is untouched (protected) in all 4 regions; the failed
  region's original text remains visible in the no-text composite, which is expected — a failed
  cleanup falls back to the legacy flat-fill/halo path for its translated overlay in the actual
  rendered page, which this tool does not capture (see §4a).
- Full crop review of the remaining 7 pages was not done exhaustively given the run's time
  budget; the numeric residual-ink/outside-support results above did not flag anything requiring
  a closer look (no page exceeded 6% max residual ink, and outside-support was 0 everywhere).

### 4a. What "outside-support invariance" does and doesn't prove here

The tool composites each region's patch onto the source itself (per the handoff's own design in
§4), pasting each patch at its own actual pixel dimensions (not resized to its declared bounds)
so a size mismatch between a patch and its declared bounds would show up as real spillage — this
is a genuine regression guard (covered by the synthetic test,
`scripts/quality/test_cleanup_composite.py`), not a check that's zero by construction. What it
cannot see is whether the pipeline's own renderer diverges from this script's own compositing —
no separately-rendered "background/plate" artifact is part of this packet's inputs, so a 0 here
confirms the compositor (and the patch/bounds data it read) are internally consistent, not that
the live rendered page matches pixel-for-pixel.

## 5. `reference_compare.md` highlights

Full tables: [`reference-compare.md`](reference-compare.md) (six-fixture batch),
[`../r3p4-20260926-sample61/reference-compare.md`](../r3p4-20260926-sample61/reference-compare.md).

- **1 page flagged as a wipe:** `sample222` (`WIPE-PIXELS`, altered 9.60% ours vs 11.9% Torii —
  under Torii's own number, but still flagged).
- **`FLATTEN-REGRESS`** (flattened % over the 3% regression line, not the 5% fail line):
  sample177 (3.83%), sample83 (3.91%), sample99 (3.07%), sample61 (3.49%). None crossed the 5%
  fail line.
- **`REGION-COUNT`** mismatches (ours vs Torii's box count): sample177 (6 vs 11 — Torii's own
  historical-original-vs-corpus-source caveat applies per the tracker's acceptance note),
  sample99 (14 vs 26), sample61 (63 vs 48).
- **`HIDDEN-LAYERS`**: sample93 (1), sample61 (1) — both match the redo-cycle extra translation
  layer already noted in §2/§3.
- **`OUTSIDE-BBOX`**: sample641 (0.54%), sample93 (0.66%), sample61 (1.25%) — all small.
- Zero refusals across all 9 distinct pages.

## 6. Spend

- **Total: $0.1480** of the $1.00 D1 cap (14.8%) — never approached the 80% stop line.
- By job type: `translation` $0.0543 (35 priced calls, 0 unknown), `qa` $0.0935 (21 priced
  calls), `qa-re-ocr` $0.0002 (1 call).
- Luna's custom-registered model ID priced correctly (not $0/NULL) — confirmed on the canary
  (`priced_calls: 3, unknown_calls: 0`) and held for the rest of the run.
- Estimated vs billed: only estimated (`job_costs.estimated_cost`, OpenRouter's own per-call
  pricing) — no separate OpenRouter billing-dashboard reconciliation was done in this packet.

## 7. Protected-art checklist (cleanup-relevant items only)

| Fixture | Tracker requirement (cleanup-relevant part) | Evidence |
| --- | --- | --- |
| sample99 | "preserved SFX unchanged; no large automatic polygon replacing the background" | 1 region excluded by policy (SFX), 13/14 patched with max 1.36% residual ink, 0 outside-support px — no large-polygon wipe. |
| sample83 | "central art protected, cleanup cannot overpaint translated glyphs" | Visually confirmed (§4): central art (face/hair) untouched in all 4 regions including the 1 failed one. |
| sample222 | "Annotated artwork survives; replacement glyphs stay in their allowed containers" | 1 uncertain region (CTD found no glyphs, flagged `cleanup_review`), 1 excluded (SFX); 16/18 patched, 0 outside-support px. Flagged `WIPE-PIXELS` in §5 — worth the coordinator's own look. |
| sample93 | "Visibility/rejection restores the correct original or remaining cleanup" | 2 regions excluded, 9/11 patched, 0 outside-support px; large 6764×4961 page's cleanup stage took 408s (§3) but completed. |
| 24 controls (sample7, sample197, sample641 here) | "Preserve SFX without suppressing dialogue" | sample7: 1 excluded; sample197: 0 excluded (15/15 patched); sample641: 3 excluded — all with 0 outside-support px. |

## 8. Not executed

- **Reliability disturbance cases** (worker killed mid-stage, edit-during-cleanup, cancel,
  page-deleted-during-cleanup) — explicitly out of scope per §6a; the rules forbid a restart
  mid-run. Only integration-test coverage exists (`backend-rust/tests/stage_recovery.rs`), not
  live evidence.
- **Replay-before-live** — no replay tool exists yet (§6a); this packet went straight to a live
  canary as the handoff anticipated.
- **Editor/export equality (R7) and fitting (M7)** — separate gates, not attempted.
- **A second forced-`aot` pass** for D5 comparison — not requested for this packet; only `auto`
  was measured.
- **The 25-control sweep (D6)** — explicitly deferred to after this packet.
- **OpenRouter billing-dashboard reconciliation** against `job_costs.estimated_cost` — not done.
- **Exhaustive by-eye review of every page's `cleanup-only.png`** — only sample177 and sample83
  were reviewed closely (§4); the other 7 pages were judged by the numeric outside-support/
  residual-ink results only, which did not flag anything.
