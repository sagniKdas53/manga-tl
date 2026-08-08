# OCR corpus & region proposals — bug report and testing handoff

**Date:** 2026-08-08 · **Status:** corpus rebuilt and usable; three region bugs open, none applied.

Pick this up by reading §1 (what state things are in), then §3 (what's broken), then §4 (what to
test). §5 is the command crib.

---

## 1. Where everything is now

Corpora and source pages live in the **`manga-tl-corpus-private`** submodule at `corpus/`, not in
this repo:

```
corpus/                     submodule, remote = github.com/sagniKdas53/manga-tl-corpus-private
  samples/                  40 SFW sample dirs + NSFW/ with 16 more (flat, not yet organised)
  translation/              40 pages, 26 scored against a human reference
  ocr/                      40 pages, 291 regions
  ocr/_review/              gitignored, regenerable (~19MB)
  qa/                       265 cases over 38 pages, 30 VLM-ready
  runs/                     benchmark output
```

**Nothing has been pushed.** Both remotes are configured only. The first push is ~700MB. The repo
must stay **private** — `samples/` is third-party copyrighted scans, SFW and NSFW, and git history
keeps them after a delete. The reason is recorded in `corpus/.gitignore` so it doesn't get lost.

A second copy of the pre-samples history exists as `backup-2026-08-08` in
`/home/sagnik/Projects/manga-tl-corpus` (that clone is otherwise stale — don't work in it).

### OCR corpus state

| tier | regions | |
|---|---|---|
| `gold` | 20 | hand-reviewed (`sample7` only) |
| `consensus` | 199 | voted |
| `unresolved` | 72 | excluded from scoring |

**213 / 291 = 73.2%** carry non-empty scoreable ground truth. The gap to 219 is 6 regions
deliberately blanked in review — detection false positives, excluded rather than counted as
misses.

Engine pool: `paddleocr_v6_medium`, `paddleocr_v5_server`, `qwen/qwen3-vl-32b-instruct` (paid),
`google/gemini-3.1-flash-lite` (paid). Voting `--min-agree 2 --tol 0.10` across **families**.

> **Two older figures are wrong; do not cite them.** *61.2%* predates family-collapsed voting, so
> part of its "consensus" was PaddleOCR's shared bug outvoting the truth. *72.5%* predates the
> crop fix. Both overstate quality in ways that hide real errors.

---

## 2. Fixed today (verified, in the corpus)

| bug | effect | evidence |
|---|---|---|
| **Correlated engines voted as independent** | PaddleOCR variants share a vertical-column reading-order bug; 4 variants at `--min-agree 3` = one wrong answer with three seconds. Now one vote per *family*. | Audit of accepted regions: paddle never won alone, no reversal accepted |
| **Engines saw different crops** | `paddle_transcribe_regions` got the raw bbox, cloud VLMs got `crop_for_region`'s 10px-padded one. Disagreement partly measured the crop. | Re-run changed **250 candidates**, 30 regions' ground truth; 8/20 regions on sample7 |
| **Gold-review `use` buttons never worked** | Built as `onclick="pick('r1',{json.dumps(text)})"`; the leading `"` closed the attribute. Every button inert since written — all review to date was typed by hand. | Verified in browser after fix |
| **Review page rendered the raw bbox** | Regions looked clipped in review when engines had seen 10px more. | Now shares `crop_for_region` |
| **`retier` left `_manifest.json` stale** | Manifest advertised pre-retier counts; it's what downstream reads to size the corpus. | Now rewritten, idempotent |
| **QA corpus: 3 data-integrity bugs** | stale dirs surviving page replacement; `_manifest.json` clobbered by `--sample`; orphaned case files. | Fixed at source, corpus rebuilt |

Review page also gained: selection highlighting + badge flip to `resolved`, per-region
**blank (no text)** and **reject all**, a resolved/total counter, and an export guard naming
unresolved regions. All verified end-to-end in a browser.

---

## 3. Open bugs — none applied

### BUG-1 · Benchmark proposes worse regions than production (benchmark-only, no product risk)

`scripts/benchmark_vlm_ocr.py::get_all_text_regions` emits each YOLO detection as **one region**.
Production `worker/src/worker/handlers/ocr.py:605` splits a bubble by clustering the fragments
inside it:

```python
merged_bubble_regions = merge_ocr_regions(assigned_frags, reading_direction, threshold_ratio=2.0)
```

The benchmark path has no equivalent. **The corpus is therefore built from region proposals worse
than the pipeline it exists to measure** — engines are scored on crops the product would never
hand them. This is the direct cause of the giant regions in `corpus/ocr/`.

*Fix:* mirror the production split in `get_all_text_regions`. **Do this first** — it needs no
product change and brings the corpus to parity.

### BUG-2 · `threshold_ratio=2.0` under-splits touching balloons (product change)

> **Validated on 7 pages, 2026-08-08 — see `region_threshold_validation_2026-08-08.md`.**
> The direction of the fix holds everywhere; the recommended value tightened from ≤0.5 to
> **0.35**, because `sample30` needs ≤0.35 and `sample3`'s band merely happened to reach 0.50.

Measured on `sample3` against its human reference (**9 balloons**):

| `threshold_ratio` | regions | giant |
|---|---|---|
| 0.15 – 0.50 | **9** ✓ | 0 |
| 0.75 – 1.0 | 8 | 1 |
| 1.5 – **2.0 (current)** | 6 | 1 |
| *no split (benchmark today)* | 5 | 3 |

At ≤0.5 each region maps to one balloon and the name badge separates from the dialogue on its own.
`0.50` is already the module default (`OCR_MERGE_THRESHOLD`), so the `2.0` override is the
outlier.

*Fix:* `2.0` → **`0.35`** at `ocr.py:605`. Keep the override — 0.35 is not the module default.

> **`0.35` is a workaround, not a tuned parameter.** Every comparable implementation uses a
> distance budget of 1.5–4× character size, but pairs it with an alignment gate, a size-similarity
> gate, an adaptive per-page cut, and an MST instead of connected components. We have none of
> those, so distance is doing all four jobs. Expect the right value to move back up — and to
> matter less — once those land. See `region_merge_prior_art_2026-08-08.md`.

*Risk:* shipped worker code on the live translation path. A merged region is **one translation
unit with one background colour and one typeset target**, so mis-splitting corrupts output, not
just measurements. Needs tests and a go-ahead. Blast radius measured: `merge_ocr_regions` is
**LOW** — 1 direct caller (`process_ocr`), 1 process, 1 module.

### BUG-3 · Irregular balloons crop as their axis-aligned bbox

Polygon fills as little as **34%** of the bbox (`sample6` r4), ~64% on `sample3` r2 / `sample30`
r4 — so a third of the crop is neighbouring art and *text*, which engines transcribe.
`scripts/polygon_mask_crops.py` implements masking standalone (deliberately not wired into
`crop_for_region`).

Measured on 36 low-fill regions: **12 shed cross-balloon spill**, 22 unchanged in length, 1
longer, **1 masked to empty** (polygon excluded the text — needs a fallback to the bbox reading).

### BUG-4 · `merge_ocr_regions` chains across balloons (real, but marginal)

Connected-components merging with no balloon-membership constraint: `sample23` r1 is one
`direct_text` region of **458×1505 on a 1200×1600 page**.

**Scope is smaller than it first appeared.** On `sample3`, only **2 of 29** fragments ever reach
this path — 27 land inside YOLO bubbles. It governs `direct_text` regions only (77 of 291), and
those carry no polygon, so BUG-3's masking is a literal no-op on them.

> An earlier proposed fix — "merge only within the same bubble, or if neither is in a bubble" —
> **does not work.** At the defect site (`ocr.py:663`) every fragment is bubble-less by
> construction, so the second clause permits exactly the chaining it was meant to stop. The
> constraint has to come from elsewhere: panel membership (panels are already detected in that
> handler) or a cap on component extent.

> **Superseded as to its headline evidence, 2026-08-08 (later).** `sample23` r1 is a
> **reading-direction bug**, not chaining — see BUG-6. All 61 fragments on that page are
> horizontal, and merging them with `ltr` yields exactly the hand count of 17 across a wide
> stable threshold band. No membership rule and no extent cap is needed for this page. The
> transitive-chaining argument may still hold on a genuinely vertical page, but BUG-4 must be
> re-assessed after BUG-6 and on different evidence.

### BUG-5 · Junk region proposals (not triaged)

12 regions (4.1%) are `<45×45` — screentone/art false positives with no text. Retire them by
blanking in gold review; they're then excluded from scoring rather than counted as misses.

### BUG-6 · `reading_direction` is used as a proxy for text orientation (product change)

Found 2026-08-08 while running the `sample23` control. `merge_regions.py:103-107` treats
`reading_direction == "rtl"` as "the text is vertical" and sizes the vertical gap budget from
`avg_width`. But `reading_direction` comes from `job_data["readingDirection"]` (`ocr.py:339`,
default `"rtl"`) — a **binding / page-order** setting, not a text-orientation one.

On a horizontally-set Japanese page `avg_width` is a whole line, so the vertical budget becomes
~107px at the code default and ~214px at the deployed `1.0`, and every paragraph chains into its
neighbour. `sample23` collapses from 17 correct regions to 2 page-sized ones.

*Fix:* derive orientation from the fragments (on `sample23`, 61 of 61 are wider than tall — not
a close call) rather than from the binding direction.

*Risk:* LOW blast radius (`merge_ocr_regions`: 1 caller, 1 process), but it is shipped worker
code. Needs tests, and a check against a genuinely vertical page to confirm the common case does
not flip. Full evidence in `region_threshold_validation_2026-08-08.md` §4.

**Related, still unapplied:** `docker-compose.yml:220` deploys `OCR_MERGE_THRESHOLD=1.0`, double
the `0.50` code default — `render_quality_gap_2026-08-05.md` §D4 fix #1.

---

## 4. Testing handoff

### 4.1 Validate the threshold beyond one page — **DONE, 2026-08-08**

Ran on `sample1`, `sample9`, `sample16`, `sample27`, `sample30` plus `sample3`, with `sample23`
as the control. Full results: **`region_threshold_validation_2026-08-08.md`**. Summary:

- **The fix direction holds on all 7 pages** — `2.0` is the worst or joint-worst value everywhere.
- **The value tightens to 0.35.** `sample30` needs ≤0.35; `sample3`'s band merely reached 0.50.
- **`sample30` confirms `sample3` exactly** — 7 regions mapping 1:1 onto 7 balloons, checked
  against the art rather than by count.
- **One page over-splits** (`sample27`, +1 genuine region). Outweighed by 11 recovered elsewhere.
- **Control passed** — `sample23` is constant across the whole in-bubble sweep.
- **New: BUG-6**, found via the control. It relocates BUG-4's headline evidence.

Note for anyone re-running: the *first* sweep script swept one value into both merge paths, which
conflates BUG-2 with BUG-4 and makes the `sample23` control meaningless. Sweep only the in-bubble
threshold and pin the unmatched path.

### 4.2 Order of work, and why

1. **BUG-1** — benchmark-only, no product risk, biggest corpus win.
2. **BUG-6** — orientation from fragments, not binding direction. Prerequisite for judging BUG-4.
3. **BUG-3** — apply masking to *all* engines with the empty-result fallback.
4. **BUG-2** — `2.0` → `0.35`; validated by §4.1, needs worker tests.
5. **`OCR_MERGE_THRESHOLD`** `1.0` → `0.50` in `docker-compose.yml`, matching the code default.
6. **BUG-4** — re-assess after BUG-6, on a vertical page and on production grounds.

**Bundle the re-run.** BUG-1, BUG-2, BUG-3 and BUG-6 all change region proposals, which
invalidates every stored `candidate` (transcribed from the old crops). One cloud pass covering
all four, not four passes. Budget ~85 min and the paid-model cost of a full 40-page build.

### 4.3 What must not regress

- `tier` stays a pure function of `candidates` + voting rule. Never re-run engines to change a
  threshold — `retier_ocr_corpus.py` does it offline for free.
- Every engine gets the **same crop**. If a change feeds one family a different image, the vote
  measures the crop, not the engine. This is BUG-fixed-today and easy to reintroduce.
- Count **families**, not processes, when setting `--min-agree`. Adding paddle variants does not
  add independent votes.
- `--apply-review` golds **every** region on a page, not just edited ones. Review a page fully or
  don't apply it. `gold` is what re-tiering will never revisit.
- A blank region is *excluded* from scoring (`cer()` returns `None` on an empty reference), not
  scored as a miss. That's the intended way to retire a junk detection.

### 4.4 Worker gates (BUG-2 and BUG-4 only)

```bash
cd worker
../.venv/bin/python -m ruff check --fix . && ../.venv/bin/python -m ruff format .
../.venv/bin/python -m ruff check . && ../.venv/bin/python -m ruff format --check .
../.venv/bin/python -m pyright . && ../.venv/bin/python -m pytest -q     # baseline: 315 passed
```

Worker changes need `detect_changes({repo: "manga-tl-worker"})` — the parent's sees the submodule
as a pointer and reports `changed_count: 0`.

---

## 5. Command crib

```bash
# Re-tier offline (free, no engine calls) — sweep thresholds this way, never by rebuilding
.venv/bin/python scripts/retier_ocr_corpus.py --dry-run --min-agree 2 --tol 0.10
.venv/bin/python scripts/retier_ocr_corpus.py           --min-agree 2 --tol 0.10

# Refresh only the local engines (cloud candidates stay valid — do not re-pay for them)
for s in $(ls -d corpus/ocr/sample*/ | xargs -n1 basename); do
    .venv/bin/python scripts/refresh_local_candidates.py --sample "$s"    # ~2GB/page, one process each
done

# Gold-review pages (no engine calls)
.venv/bin/python scripts/build_ocr_corpus.py --review-only --gold sample7,sample27
.venv/bin/python scripts/build_ocr_corpus.py --apply-review ~/Downloads/sample7.json

# Polygon masking experiment (writes nothing without --apply)
.venv/bin/python scripts/polygon_mask_crops.py --min-fill 0.70 --dump-crops /tmp/crops

# Full OCR build (paid; ~2.1 min/page)
.venv/bin/python scripts/build_ocr_corpus.py --sample sampleN \
  --providers-config scripts/test-providers.json --include-paid --max-engines 2 \
  --paddle-variants paddleocr_v6_medium,paddleocr_v5_server --min-agree 2 --tol 0.10

# QA corpus (local, fast)
.venv/bin/python scripts/build_qa_corpus.py
```

**Hard bar:** any model taking over 60s on a single task is a failure regardless of output
quality. Enforced by wall-clock timeout, not socket-idle timeout.

---

## 6. Open decisions

| decision | notes |
|---|---|
| Push the corpus repo? | ~700MB first push. **Confirm the GitHub repo exists and is private first.** |
| Apply BUG-2 to production? | §4.1 validation **done** — 7 pages, value is `0.35` not `0.5`. Still needs worker tests and a go-ahead. |
| Apply BUG-6 to production? | Found 2026-08-08, LOW blast radius. Needs tests + a vertical-page check. Not yet raised with the user. |
| Organise the NSFW samples? | **Done 2026-08-08.** 15 samples (not 16 — sample1's second set was a re-render of the same page, dropped). Flattened, given manifest entries and `meta.json`, so a builder can now reach them. |
| Second (NSFW) corpus | Planned, not started. See `docs/free_model_bench_plan_2026-08.md` §7. |

## 7. Related docs

- `docs/benchmarks_guide.md` — the map; §2 covers all three corpora and the voting rules
- `docs/region_threshold_validation_2026-08-08.md` — the 7-page threshold validation and BUG-6
- `docs/region_merge_prior_art_2026-08-08.md` — how everyone else does this, and why `0.35`
  should not outlive the current algorithm
- `docs/research_brief_region_merging.md` — paste-able brief for deep-research agents
- `docs/region_proposal_defects_2026-08.md` — full evidence for BUG-2/3/4, with the superseded
  framing marked at the top
- `corpus/README.md` — why the corpora are versioned separately and what to look at in a diff
