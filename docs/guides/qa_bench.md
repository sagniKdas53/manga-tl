# QA-stage benchmarking: methodology & how to run it

How we decide which model to put in the QA slot — the stage that reviews OCR and translation
output and decides whether to pass it, fix it directly, or send it back.

Companion to [`translation_bench.md`](translation_bench.md) (translation stage) and
[`run_ocr_bench.md`](run_ocr_bench.md) (OCR stage). Same shape: provider/model lists come from
`config/providers.json`, results land under `--out-dir` with a `_summary.json`.

---

## 1. What it measures

A QA model is only useful if it catches real problems *and* leaves good work alone. Measuring
just "how many defects did it flag" rewards a model that fails every region — perfect recall,
zero value. So every case carries a known-good baseline and a single planted defect, and each
model is scored on:

| metric | meaning |
|---|---|
| **recall** | of the regions we deliberately broke, how many did it flag at all? |
| **precision** | of everything it flagged, how much was actually broken? |
| **class accuracy** | did it flag the *right kind* of problem — `escalation.orderBad` for a reading-order swap, not a vague `failed`? |
| **control FP rate** | on a completely undamaged page, what fraction of regions did it flag anyway? |
| **macro-F1** | headline ranking: mean F1 across the six defect classes |

`control_fp_rate` is printed next to `macro_f1` in the summary table specifically so a
trigger-happy model cannot top the table quietly.

---

## 2. The corpus (`scripts/qa_corpus/`)

Built by `scripts/build_qa_corpus.py` from clean pages in `scripts/corpus/` — source text from
`regions.json`, known-good English from `reference.json`'s aligned reference translations. Only
regions that have an aligned reference are used: without one there is no correct English to
corrupt, and a null translation would be a defect we did not plant.

```
scripts/qa_corpus/
  _manifest.json
  sampleN/
    control.json            no defect — measures false positives
    mistranslation.json
    untranslated.json
    ocr_garbage.json
    ocr_unrecoverable.json
    order_swap.json
    sfx_translated.json
```

Each case file records `mutated_region_ids`, which is what lets the runner tell "caught the
planted bug" apart from "flags everything".

### Defect classes

| class | mutation | expected verdict |
|---|---|---|
| `control` | nothing | every region `passed` |
| `mistranslation` | fluent but unrelated English swapped in | `failed` or `direct_fix` |
| `untranslated` | English left identical to the Japanese source | `failed` or `direct_fix` |
| `ocr_garbage` | visually confusable substitutions in the source (ー/一, ロ/口, ツ/シ, カ/力 …) | `escalation.ocrBad`, or a `correctedSourceText` |
| `ocr_unrecoverable` | source replaced with random kana | `needsReOcr` or `needsManualIntervention` |
| `order_swap` | two regions' `readingOrder` swapped | `escalation.orderBad` |
| `sfx_translated` | an SFX region given a literal romaji "translation" | `reject_sfx` |

`mistranslation` deliberately uses *fluent* wrong English. A model that only checks "does this
read like natural English" passes it; only one actually comparing against the source catches it.

Mutations are drawn from a fixed seed (`--seed`, default 1337) so runs are comparable.

### What is **not** covered

Typesetting defects — text overflowing its bubble, overlapping panel borders — are **not
injected**. They cannot be expressed as a metadata mutation; they need the page re-rendered with
a broken layout. The VLM arm therefore measures semantic and OCR review only, even though the
production VLM prompt also asks about typesetting. Closing that gap means driving
`scripts/render.py` with a mutated layout and is the obvious next extension.

---

## 3. The two arms

Both reuse the production contract rather than a benchmark-specific prompt.

**`--arm llm`** — text-only region metadata. Imports `build_qa_prompt` and `QA_JSON_SCHEMA` from
`scripts/test_qa.py`, which mirrors `worker/src/worker/handlers/qa.py::_process_qa_llm()`.
Models come from `config/providers.json` → `models.qaLLM`.

**`--arm vlm`** — the same metadata plus the side-by-side `original | rendered` composite that
`_process_qa_vlm()` builds. Models come from `models.qaVLM`. A case is only VLM-eligible if it
has both OCR-corpus bounding boxes and a worker render (`corpus/samples/sampleN/render.<ext>`); others are
skipped, and `build_qa_corpus.py` reports how many are `vlm_ready`.

> The composite's long edge is capped at 1400 px (`VLM_MAX_EDGE`). Production does not downscale;
> this is a benchmark concession so a run does not spend its whole token budget on pixels.

Both arms walk `bench_common.run_ladder`'s `json_schema → json_object → none` ladder, so a model
that only supports one structured-output mode is measured on its merits rather than recorded as
a hard failure.

---

## 4. Running it

```bash
# Build the cases (needs scripts/corpus/ to exist)
python scripts/build_qa_corpus.py

# Text-only arm, free models
python scripts/benchmark_qa.py --arm llm --provider openrouter --out-dir runs/qa

# Vision arm
python scripts/benchmark_qa.py --arm vlm --provider openrouter --out-dir runs/qa

# Narrow to a couple of pages while iterating
python scripts/benchmark_qa.py --arm llm --samples sample36,sample13 --out-dir /tmp/qabench
```

Output:

```
runs/qa/
  _summary_llm.json
  llm/<provider>/<model>/<sample>__<defect_class>.json    full response + per-case score
```

---

## 5. Reading the output

```
SUMMARY — LLM arm (sorted by macro-F1 desc; ctrlFP is the false-positive rate on
undamaged control pages — lower is better)
  openrouter   deepseek/deepseek-v4-pro    macroF1=0.812  recall=0.867  class=0.744  ctrlFP=0.061
  openrouter   qwen/qwen3.7-flash          macroF1=0.640  recall=0.933  class=0.512  ctrlFP=0.284
```

Read `recall` and `ctrlFP` together. The second model above finds more planted defects but
flags 28% of untouched regions, so in production it would send a large share of good pages back
for rework. `class` (class accuracy) separates "knows something is wrong" from "knows what is
wrong" — a model with high recall but low class accuracy is flagging correctly and diagnosing
badly, which matters because the pipeline routes on the escalation flags, not on the prose.

Per-class numbers in `_summary_*.json` are usually where the decision gets made: `order_swap`
and `ocr_unrecoverable` are the classes weak models miss most, and both are cheap for the
pipeline to act on automatically.
