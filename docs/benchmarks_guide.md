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

### `scripts/corpus/` — translation (text only, 38 pages)

No images: source pages can be adult content, so the corpus stays committable without carrying
them. Per page: `regions.json` (source text in reading order), `reference.json` (id → reference
translation), `meta.json` (reliability signals).

The reference translation is the **quality target**, so where it comes from matters. The builder
prefers a human translation over a competitor's machine output — scoring against `en-<name>`
(watermarked *mangatranslator.ai / qwen3-235b*) would mean grading models with a model. Current
split: **24 pages score against a human translation**, 13 against a machine one, 1 against a
hand-edited render.

> The score is `difflib` similarity — a **repeatable proxy**, not a semantic judgement. A model
> can translate correctly and score low by choosing different words. Use it to rank and to catch
> regressions, then read the actual output of the top few.

### `scripts/ocr_corpus/` — OCR (commits its images)

This one *does* commit pixels: a downscaled WebP per page (long edge 1600, matching the
pipeline's `downscale_for_ocr`), so the benchmark has a stable input that survived the
`examples/` history purge. ~40 pages lands around 8–14 MB.

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

### `scripts/qa_corpus/` — QA (245 cases over 35 pages)

Built by mutating clean pages: each case carries exactly **one** labelled defect plus the list of
regions that were mutated. That list is what lets the runner separate "caught the planted bug"
from "flags everything" — untouched regions that get flagged count as false positives, and every
page also gets an undamaged `control` case.

Classes: `control`, `mistranslation`, `untranslated`, `ocr_garbage`, `ocr_unrecoverable`,
`order_swap`, `sfx_translated`. Mutations use a fixed seed so runs are comparable.

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

### Pages with no reference translation

**`sample5` and `sample22` are the only two of the 40 with no reference at all.** Both are
excluded from the translation corpus (`EXCLUDED_SAMPLES`) because there is nothing to align
against. They are still perfectly usable for the **OCR** corpus, which only needs source text.

Three more are in the translation corpus but absent from the QA corpus — `sample20`, `sample23`,
`sample25` — because fewer than 3 of their regions got an aligned reference translation, which is
the minimum for a meaningful defect case.

`sample21` is the only non-Japanese page (Chinese; `meta.json` records `"lang": "zh"`). If you
swap in a Japanese replacement, drop `scripts/corpus/sample21/` and re-index that one page.

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
2. `python scripts/organize_examples.py --apply --sample sampleN` then `--verify`.
3. `python scripts/build_translation_corpus.py --sample sampleN`
4. `python scripts/build_ocr_corpus.py --sample sampleN`
5. `python scripts/build_qa_corpus.py --sample sampleN`

---

## 6. Engines and models

### Local OCR engines (consensus voting)

`--paddle-variants` selects which local PaddleOCR generations vote. Both PP-OCR generations are
already in the model cache:

| variant | det / rec |
|---|---|
| `paddleocr_v6_medium` | PP-OCRv6_medium (default) |
| `paddleocr_v6_small` | PP-OCRv6_small |
| `paddleocr_v5_server` | PP-OCRv5_server (default) |
| `paddleocr_v5_mobile` | PP-OCRv5_mobile |

Default is `paddleocr_v6_medium,paddleocr_v5_server` — two generations, deliberately. **This is
the fix for a real problem:** only two *free* cloud vision models exist on OpenRouter, so a
one-paddle-plus-two-VLM pool made the default `--min-agree 3` equivalent to unanimity, and a
sample36 trial resolved just 1 of 5 regions. Four independent engines means one dissenter no
longer sinks the region.

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
