# The benchmarks, end to end

There are three benchmarks, one per pipeline stage, and three corpora that feed them. They all
share the same shape, so learning one teaches you the others.

| Stage | Runner | Corpus | Headline metric |
|---|---|---|---|
| Translation | `scripts/benchmark_translation.py` | `scripts/corpus/` | mean lexical similarity to a reference translation |
| OCR | `scripts/benchmark_vlm_ocr.py` | `scripts/ocr_corpus/` | mean CER against ground-truth text |
| QA | `scripts/benchmark_qa.py` | `scripts/qa_corpus/` | macro-F1 over injected defect classes |

Deep dives: [`translation_bench.md`](translation_bench.md), [`run_ocr_bench.md`](run_ocr_bench.md),
[`qa_bench.md`](qa_bench.md). This document is the map.

---

## 1. The shape they all share

Every runner does the same five things, which is why adding a model anywhere is a config edit
rather than a code change.

**1. Models come from `config/providers.json`.** The same file the backend reads to build its
fallback chain. Each provider has `models.tl`, `models.qaLLM`, `models.qaVLM`, `models.ocr`.
`scripts/provider_config.py::list_candidate_models(cfg, task, provider, include_paid, model)`
is the one place that resolves them, so `--provider`, `--model` and `--free-only /
--include-paid` behave identically in all three runners.

**2. They reuse the production prompt.** The benchmarks import the real prompt and schema rather
than restating them:

- translation → `build_batch_prompt`, `MANGA_TRANSLATION_JSON_SYSTEM_PROMPT`,
  `TRANSLATION_JSON_SCHEMA` from `scripts/test_translation.py`
- QA (LLM arm) → `build_qa_prompt`, `QA_JSON_SCHEMA` from `scripts/test_qa.py`
- QA (VLM arm) → the side-by-side composite and prompt from `_process_qa_vlm()`

If a prompt changes in the worker, update the `test_*.py` mirror and every benchmark follows.

**3. The structured-output ladder.** `scripts/bench_common.py::run_ladder()` tries
`response_format: json_schema` → `json_object` → none, in that order, and records which one
actually worked. This exists because providers under-report capability: the 2026-08-06 run found
7 of 14 OpenRouter models supported `json_schema` despite not declaring it. Retry policy: retry
the same rung on a network error or 429 (linear backoff); fall through to the next rung on any
other HTTP error, empty content, or unparseable JSON — those mean "unsupported", not "flaky".

**4. Everything lands under `--out-dir`.**

```
<out-dir>/
  _summary.json                          ranked; the printed table is a view of this
  <provider>/<model>/<page>.json         full response, per-item scores, attempts_log
```

`attempts_log` is the first place to look when a model shows as failed — it records each rung and
why it was abandoned.

**5. Corpus subsets.** `--corpus-subset quick|clean|all` (`quick` = one baseline page, currently
`sample36`), or `--pages a,b,c` to name pages explicitly.

---

## 2. The corpora

### `scripts/corpus/` — translation (text only, 40 pages)

No images: source pages can be adult content, so nothing here carries pixels even though the
corpus is no longer committed at all (see the note under the OCR corpus below). Per page:
`regions.json` (source text in reading order), `reference.json` (id → reference translation),
`meta.json` (reliability signals).

The reference translation is the **quality target**, so where it comes from matters. The builder
prefers a human translation over a competitor's machine output — scoring against `en-<name>`
(watermarked *mangatranslator.ai / qwen3-235b*) would mean grading models with a model. Current
split: **26 pages score against a human translation**, 13 against a machine one (12
mangatranslator.ai, 1 mangatranslate.com), 1 against a hand-edited render.

> The score is `difflib` similarity — a **repeatable proxy**, not a semantic judgement. A model
> can translate correctly and score low by choosing different words. Use it to rank and to catch
> regressions, then read the actual output of the top few.

### `scripts/ocr_corpus/` — OCR (40 pages, 291 regions)

A downscaled WebP per page (long edge 1600, matching the pipeline's `downscale_for_ocr`) plus
`regions.json` and `meta.json`. All 40 pages come to 7.4 MB.

> **None of the three corpora are in git as of 2026-08-08.** They used to be — the OCR corpus in
> particular committed its WebPs so the benchmark had a stable input. That is no longer true.
> Every corpus is derived from `examples/`, which is gitignored *and* purged from history, so a
> committed corpus is a snapshot with no trackable source: it can't be regenerated from the repo
> and its diffs mean nothing. Rebuild instead (§5). The durable record is
> `scripts/examples_manifest.json`, which stays tracked.
>
> Practical consequence: **a clean clone has no corpora.** Anyone benchmarking needs the
> `examples/` tree first, then the three builders.

Built out from 1 page to 40 on 2026-08-08, **local engines only** — the four PaddleOCR variants
at `--min-agree 3`, no API calls, because the free-tier QA-LLM sweep was still running and a
cloud pass would have competed with it for the same quota. Current tiers:

| tier | regions | |
|---|---|---|
| `consensus` | 178 | 61.2% — scoreable |
| `unresolved` | 113 | 38.8% — excluded from scoring |

9 of 40 pages resolve every region. The weak ones are SFX-heavy (`sample37` 1/10, `sample36` 1/5,
`sample6` 1/4): at `--tol 0.10`, a single character's disagreement on a 3-character crop is a CER
of 0.33, so short regions almost never clear the bar. Adding cloud vision engines is the next
lever — see §6 for why they resolve regions the local pool can't.

Region proposals come from the production path — YOLO bubble detection plus PaddleOCR background
text merged by `worker.services.merge_regions` — and are **held constant across chat VLMs**, so
the score isolates transcription quality instead of mixing in detection differences.

Ground truth has three tiers:

- **gold** — hand-confirmed via the review page (§4).
- **consensus** — the medoid of all engines' transcriptions, accepted when at least `--min-agree`
  engines land within `--tol` CER of it. Comparison is NFKC-normalised, so `１２３` vs `123`
  counts as agreement, not error.
- **unresolved** — engines disagreed. **Excluded from scoring**, so disagreement never silently
  becomes a noise target.

### `scripts/qa_corpus/` — QA (265 cases over 38 pages)

Built by mutating clean pages: each case carries exactly **one** labelled defect plus the list of
regions that were mutated. That list is what lets the runner separate "caught the planted bug"
from "flags everything" — untouched regions that get flagged count as false positives, and every
page also gets an undamaged `control` case.

Classes: `control`, `mistranslation`, `untranslated`, `ocr_garbage`, `ocr_unrecoverable`,
`order_swap`, `sfx_translated`. The seed is keyed on the sample id, so `--sample X` and a full
run produce the same cases for X.

**VLM readiness: 29 of 38 pages.** A case needs both a worker render (all 40 have one) and
bounding boxes from the OCR corpus, which is why the arm had 0 runnable cases until that corpus
was built out. The 9 that still lack boxes fail one check — `attach_bboxes` requires the OCR
corpus to have found *at least* as many regions as the translation corpus, then zips the two
positionally. Detection runs on the downscaled page for the OCR corpus and on the full-resolution
page for the translation corpus, so small regions drop out of the former:

| page | TL regions | OCR regions |
|---|---|---|
| `sample30` | 7 | 4 |
| `sample3` | 9 | 5 |
| `sample4` | 8 | 6 |
| `sample29` | 8 | 7 |
| `sample38` | 11 | 9 |
| `sample34` | 15 | 12 |
| `sample17` | 6 | 5 |
| `sample1` | 4 | 3 |

`sample36` is the ninth: its cases were deliberately left untouched while a QA-LLM sweep scoped to
that page was in flight. Rebuild it once that finishes.

Not covered: typesetting/overflow defects. They need the page re-rendered with a broken layout,
not a metadata mutation, so the VLM arm currently measures semantic and OCR review only.

---

## 3. Where the pages come from

`examples/sampleN/` after `scripts/organize_examples.py`:

```
examples/sampleN/
  source/<original filename>       the source-language page
  reference/<original filename>    0..n human / competitor renders
  output/frontend-export.png
  output/worker-render.png
  output/project.zip
  meta.json                        names the above, with provenance per reference
```

`meta.json` is generated from **`scripts/examples_manifest.json`**, which is committed. That
matters because `examples/` is gitignored *and* purged from history — the manifest is the only
durable record of which file plays which role. Roles were established by inspecting all 40 pages,
which corrected things filename heuristics got wrong (11 samples keep their human TL under its
own Twitter id; sample24/25 have the English render under the *plain* filename and the Japanese
source under `(copy 1)`).

Verify the layout any time with:

```bash
python scripts/organize_examples.py --verify
```

### Coverage, and which pages fall out where

As of **2026-08-08 all 40 pages are in the translation corpus** and `EXCLUDED_SAMPLES` is empty.
`sample5` and `sample22`, the last two with no reference at all, were each given a human, a
google-lens and a mangatranslate.com render, so there is now something to align against on every
page. The set is kept only for deliberate exclusions; `pick_reference()` already skips a sample
whose `references` list is empty, so a page with no reference drops out on its own.

Two pages are in the translation corpus but not the QA corpus, both for the same reason — fewer
than 3 of their regions got an aligned reference translation, the minimum for a meaningful
defect case:

| page | why |
|---|---|
| `sample21` | only 2 text regions on the whole page |
| `sample23` | dense text, but alignment matched too few regions |

`sample23` is also the corpus's **stress page**: text everywhere, far denser than a typical
page. Keep it, but read its scores as a worst case rather than as representative.

**`examples/` is now Japanese-only.** `sample21` used to be the one Chinese page and was swapped
for a Japanese one on 2026-08-08; the Chinese original is parked under
`examples/sample21/do-not-use-wrong-language/`. `sample20` was swapped the same day (the previous
scan was too low-quality) and now carries a *human* reference — a Danbooru screenshot with that
site's translation notes, cropped to within 4px of the source page, so it aligns fine.

A `"parked"` list in `examples_manifest.json` names sibling directories holding a superseded
version of a page. They are deliberate, and `--verify` ignores them instead of calling them stray.

---

## 4. Running them

```bash
source .venv/bin/activate

# Translation — free models, baseline page
python scripts/benchmark_translation.py --provider openrouter --out-dir runs/tl

# OCR — free models only (the default)
python scripts/benchmark_vlm_ocr.py --provider openrouter --out-dir runs/ocr

# QA — text arm, then vision arm
python scripts/benchmark_qa.py --arm llm --provider openrouter --out-dir runs/qa
python scripts/benchmark_qa.py --arm vlm --provider openrouter --out-dir runs/qa
```

Widen with `--corpus-subset clean` or `--corpus-subset all`. Paid models are opt-in everywhere
via `--include-paid`; **the default is free-only** for all three benches.

### The OCR gold review

For pages you want as ground truth rather than consensus:

```bash
python scripts/build_ocr_corpus.py --sample sample36 --gold sample36
```

That writes `scripts/ocr_corpus/_review/sample36.html` — a self-contained page showing each
region's crop next to every engine's candidate, with the consensus preselected. You pick or edit
(you are confirming, not transcribing — no Japanese needed), hit **Save**, then:

```bash
python scripts/build_ocr_corpus.py --apply-review scripts/ocr_corpus/_review/sample36.json
```

Those regions become tier `gold`. The review pages are gitignored — they embed base64 crops and
are ~350 KB each.

---

## 5. Re-indexing the corpora

All three builders are idempotent and support `--sample` for a single page.

### Translation corpus

```bash
# What would be built, and which reference each page would use
python scripts/build_translation_corpus.py --list-eligible

# One page (after swapping an image, or adding a new sampleN)
python scripts/build_translation_corpus.py --sample sample21

# Everything — SEE THE WARNING BELOW
python scripts/build_translation_corpus.py
```

> **Rebuild the full corpus one process per page.** PaddleOCR retains memory across the builder's
> sample loop — a single page peaks at ~2 GB, and a full in-process run was OOM-killed after 3
> pages on a 19 GB machine. Loop externally instead; the full 38-page rebuild takes ~35 minutes:
>
> ```bash
> for s in $(python scripts/build_translation_corpus.py --list-eligible \
>              | grep -oP '^sample\d+(?=:)' | sort -V); do
>   python scripts/build_translation_corpus.py --sample "$s"
> done
> ```
>
> `_manifest.json` is rebuilt from what is actually on disk on every run, so pages you delete stop
> lingering in it.

### OCR corpus

```bash
# One page, local engines + free cloud vision models
python scripts/build_ocr_corpus.py --sample sample36

# Local engines only — fast, no API calls
python scripts/build_ocr_corpus.py --local-only
```

Same memory caveat applies; loop per sample for a full build.

### QA corpus

Cheap and instant — it is pure text mutation, no OCR and no API calls. **Re-run it after any
translation-corpus rebuild**, since it derives from it:

```bash
python scripts/build_qa_corpus.py
```

### Order of operations after changing an image

1. Update `scripts/examples_manifest.json` (roles/provenance for the new file).
2. Regenerate that sample's `meta.json`, then `--verify`:
   - files still flat at the top of `examples/sampleN/` → `organize_examples.py --apply --sample sampleN`
   - files already in `source/ reference/ output/` → `organize_examples.py --refresh-meta --sample sampleN`
3. `python scripts/build_translation_corpus.py --sample sampleN`
4. `python scripts/build_ocr_corpus.py --sample sampleN`
5. `python scripts/build_qa_corpus.py --sample sampleN`

> **`--apply` only reads the pre-migration layout** — everything flat at the top of
> `examples/sampleN/`. Once files live in the role folders it finds nothing to move and exits
> with `manifest does not match the tree`. Dropping a replacement page straight into `source/`
> and `reference/` is the normal way to swap one, so `--refresh-meta` is the usual step 2: it
> canonicalises the `output/` filenames and rewrites `meta.json`, moving nothing else.

---

## 6. Engines and models

### Local OCR engines (consensus voting)

`--paddle-variants` selects which local PaddleOCR generations vote. All four are in
`~/.paddlex/official_models/` as of 2026-08-08:

| variant | det / rec |
|---|---|
| `paddleocr_v6_medium` | PP-OCRv6_medium (default) |
| `paddleocr_v6_small` | PP-OCRv6_small |
| `paddleocr_v5_server` | PP-OCRv5_server (default) |
| `paddleocr_v5_mobile` | PP-OCRv5_mobile |

> Only `v6_medium` and `v5_mobile` were cached originally — `v5_server` and `v6_small` were
> fetched on 2026-08-08. Worth knowing because `build_ocr_corpus.py` sets
> `PADDLEX_OFFLINE_MODE=1`, so an uncached variant does not download: `init_paddleocr` returns
> `None`, the engine is skipped with a one-line `[warn]`, and the pool silently shrinks. If a
> variant needs fetching once, run it with `PADDLEX_OFFLINE_MODE=0 HF_HUB_OFFLINE=0`. Always
> check `meta.json`'s `engines` list to see who actually voted.

Default is `paddleocr_v6_medium,paddleocr_v5_server` — two generations, deliberately. **This is
the fix for a real problem:** only two *free* cloud vision models exist on OpenRouter, so a
one-paddle-plus-two-VLM pool made the default `--min-agree 3` equivalent to unanimity, and a
sample36 trial resolved just 1 of 5 regions. Four independent engines means one dissenter no
longer sinks the region.

**Local and cloud engines resolve different regions, so the best pool has both.** On sample36:

- the four paddle variants agree on long dialogue that the VLMs "disagree" on only because they
  concatenate vertical lines in a different order;
- the VLMs agree on short SFX crops (`トッ`) where the *mobile* and *small* recognisers garble
  a 2–3 character image.

With `--min-agree 3` and four variants, no single generation can carry a region on its own —
reaching 3 always needs agreement across the v5/v6 line, which is the point.

Free vision models currently available per provider: OpenRouter 2, Cloudflare 3, NVIDIA 2.

### Adding a model

Add it to the right `models.*` list in `config/providers.json`. Nothing else. It is picked up by
whichever benchmarks cover that task key on the next run.

---

## 7. Reading results

**Translation** — sorted by lexical similarity desc, then latency asc. Check `modes_used` (which
structured-output rung the model needed) and `id_fidelity_perfect_rate` (did it echo every region
id). A model that can't hold the id-keyed batch contract can't sit in the fallback chain
regardless of quality.

**OCR** — sorted by CER asc. `exact_match_rate` is the stricter companion; a model can have
decent CER and near-zero exact matches if it consistently adds or drops a character.

**QA** — sorted by macro-F1 desc, with `ctrlFP` (false-positive rate on undamaged pages) printed
beside it. Read them together: a model with high recall and high `ctrlFP` is distrusting
everything and would send good pages back for rework. `class` (class accuracy) separates "knows
something is wrong" from "knows what is wrong" — the pipeline routes on the escalation flags, not
on the prose, so a model that flags `failed` when it should flag `orderBad` is not actionable.
