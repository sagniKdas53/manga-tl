# The benchmarks, end to end

There are three benchmarks, one per pipeline stage, and three corpora that feed them. They all
share the same shape, so learning one teaches you the others.

| Stage | Runner | Corpus | Headline metric |
|---|---|---|---|
| Translation | `scripts/benchmark_translation.py` | `corpus/translation/` | mean lexical similarity to a reference translation |
| OCR | `scripts/benchmark_vlm_ocr.py` | `corpus/ocr/` | mean CER against ground-truth text |
| QA | `scripts/benchmark_qa.py` | `corpus/qa/` | macro-F1 over injected defect classes |

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

### `corpus/translation/` — translation (text only, 40 pages)

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

### `corpus/ocr/` — OCR (40 pages, 291 regions)

A downscaled WebP per page (long edge 1600, matching the pipeline's `downscale_for_ocr`) plus
`regions.json` and `meta.json`. All 40 pages come to 7.4 MB.

> **The corpora live in a submodule, not in this repo.** `corpus/` is `manga-tl-corpus`, holding
> all three corpora plus `runs/`. They are derived from `examples/` — gitignored *and* purged from
> this repo's history — so they have no source this repo can track and don't belong in its
> history. But they are not disposable: ground truth is expensive, partly hand-confirmed, and a
> silent change to it is exactly the regression that is otherwise invisible. Hence versioned,
> separately. See `corpus/README.md`.
>
> Practical consequences: a clean clone needs `git submodule update --init`, and **rebuilding a
> corpus produces a reviewable diff** — that is the point. `ocr/_review/` is not committed
> (regenerable, ~19 MB); rebuild it with `--review-only`.

Built out from 1 page to 40 on 2026-08-08: **291 regions**, voted by two PaddleOCR generations
(`v6_medium`, `v5_server`) plus two paid cloud VLMs (`qwen3-vl-32b`, `gemini-3.1-flash-lite`).

| tier | regions | |
|---|---|---|
| `gold` | 20 | hand-confirmed (`sample7`) |
| `consensus` | 199 | voted |
| `unresolved` | 72 | 24.7% — excluded from scoring |

**213 of 291 (73.2%) carry non-empty scoreable ground truth.** The gap between that and the
219 gold+consensus is 6 regions deliberately blanked in review: detection false positives with no
text in them, excluded from scoring rather than counted as misses.

Two earlier figures should **not** be cited. *61.2%* came from treating the four PaddleOCR
variants as four independent votes when they are one (see below), so part of that "consensus" was
a shared bug outvoting the truth. *72.5%* came before the crop fix, when paddle was fed a tighter
image than the VLMs. False consensus is worse than `unresolved`: unresolved is excluded from
scoring, while wrong ground truth silently penalises engines that got the region right.

The remaining 72 unresolved concentrate in SFX-heavy and dense pages (`sample7` 6/20, `sample27`
5/16, `sample3` 4/5) and are the queue for gold review (§4) — `_review/*.html` is generated for
all 31 pages that still have unresolved regions.

#### Engines are not independent, and the vote must know it

The naive rule — every engine gets one vote — assumes engines fail independently. PaddleOCR
variants don't: they share a vertical-column ordering bug on Japanese text, so **every** variant
reverses the reading order of the same region, identically. Four variants at `--min-agree 3` is
then not a robust majority but one wrong answer with three seconds. Observed on `sample1` r1:

```
paddleocr_v6_medium    本当にやるの？お兄ちゃん…      <- reversed
paddleocr_v5_server    本当にやるの？お兄ちゃん…      <- reversed, same bug
qwen3-vl-32b           お兄ちゃん…\n本当にやるの？     <- correct
gemini-3.1-flash-lite  お兄ちゃん…\n本当にやるの？     <- correct
```

So `scripts/retier_ocr_corpus.py` collapses each **engine family** to a single vote (its own
medoid) before voting across families, leaving three real opinions: paddle, qwen, gemini. Paddle
keeps the strength it genuinely has — it beats both VLMs on short SFX crops they hallucinate over
(`めざといなー`, which qwen read as `めんこいなー`) — without being able to outvote them on
reading order. Auditing the accepted regions: paddle never won alone, and no reversal was
accepted. The 6 regions where paddle beat a dissenting qwen were short SFX that qwen hallucinated
(`これにしよ！` read as `りょじゅうもー！`) — exactly the complementarity the rule preserves.

Because `tier` is a pure function of the stored `candidates` plus the voting rule, **the
threshold is free to revisit and expensive to get wrong up front.** Re-tier offline, never re-run
engines:

```bash
python scripts/retier_ocr_corpus.py --dry-run --min-agree 2 --tol 0.10   # report
python scripts/retier_ocr_corpus.py           --min-agree 2 --tol 0.10   # apply
```

`--min-agree 2` (of 3 families) is the operating point; 3 is unanimity and collapses coverage to
18%. `--tol` was swept and left at **0.10** deliberately, even though loosening buys regions:

| `--tol` | scoreable |
|---|---|
| 0.05 | 70.1% |
| **0.10** | **75.3%** |
| 0.15 | 78.0% |
| 0.20 | 81.1% |
| 0.30 | 83.5% |

The 17 regions gained between 0.10 and 0.20 are mostly cases where the two VLMs differ by one
character (`だろっ？` vs `だろう？`, `…はずなの` vs `…はすなの`). The vote resolves, but picks
arbitrarily between a right and a wrong reading — putting a ~0.1 CER floor under every engine on
that region. Coverage bought that way costs the discrimination the benchmark exists to provide;
those regions belong in gold review instead.

#### Every engine must see the same crop

`crop_for_region(img, bbox, pad=10)` is the one cropping function. It was not always used
everywhere, and that was a real bug: `paddle_transcribe_regions` passed the raw bbox while the
cloud VLMs got the padded crop, so **the two families were transcribing different images.** Any
box that clipped a glyph penalised paddle alone, which inflated the apparent disagreement between
local and cloud engines and made the vote partly a measurement of the crop. Measured on sample7,
switching paddle to the padded crop changed **8 of 20 regions**, consistently toward the truth
(`*これもmD7*` → `*これもヨロジり*` against gold `これもヨロシク`); on sample3 it changed all 5.

The review page had the same bug in the other direction — it rendered the raw bbox, so regions
looked clipped in review when the engines had actually seen 10px more. All three sites now share
`crop_for_region`.

When only the *local* half of the candidates needs recomputing, don't re-run the build — the
cloud calls cost money and would return identical answers, having already seen the padded crop:

```bash
for s in $(ls -d corpus/ocr/sample*/ | xargs -n1 basename); do
    python scripts/refresh_local_candidates.py --sample "$s"     # ~2GB/page, so one process each
done
python scripts/retier_ocr_corpus.py --min-agree 2 --tol 0.10
```

#### Region proposals are not clean, and that caps what the corpus can measure

Regions come from the production path, so its detection failures are in the corpus. Of 291:

| pathology | count | what it is |
|---|---|---|
| tiny (`<45x45`) | 12 (4.1%) | screentone/art false positives — no text at all |
| over-merged (`>50%` of a page dimension) | 11 (3.8%) | one box swallowing several bubbles |

Over-merging is the damaging one, because the ground truth becomes genuinely ambiguous rather
than merely hard: `sample3` r2/r3/r4 are ~900px column-height boxes containing multiple bubbles,
so engines disagree on the order they should be concatenated in and no threshold can resolve
that. `sample23` has a 458x1505 box on a 1200x1600 page. Those pages are weak OCR-corpus members
regardless of engine quality.

**To retire a bad region, blank its text in gold review.** `cer()` returns `None` against an
empty reference and `score_page` skips it, so a blank region is excluded from scoring rather than
counted as a total miss — the right outcome for a box that never contained text.

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

### `corpus/qa/` — QA (265 cases over 38 pages)

Built by mutating clean pages: each case carries exactly **one** labelled defect plus the list of
regions that were mutated. That list is what lets the runner separate "caught the planted bug"
from "flags everything" — untouched regions that get flagged count as false positives, and every
page also gets an undamaged `control` case.

Classes: `control`, `mistranslation`, `untranslated`, `ocr_garbage`, `ocr_unrecoverable`,
`order_swap`, `sfx_translated`. The seed is keyed on the sample id, so `--sample X` and a full
run produce the same cases for X.

**VLM readiness: 30 of 38 pages.** A case needs both a worker render (all 40 have one) and
bounding boxes from the OCR corpus, which is why the arm had 0 runnable cases until that corpus
was built out. The 8 that still lack boxes fail one check — `attach_bboxes` requires the OCR
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

(`sample36` was previously a ninth, held back while a QA-LLM sweep scoped to that page was in
flight. That sweep is done and the page is rebuilt — it now has boxes and is VLM-ready.)

Not covered: typesetting/overflow defects. They need the page re-rendered with a broken layout,
not a metadata mutation, so the VLM arm currently measures semantic and OCR review only.

---

## 3. Where the pages come from

`corpus/samples/sampleN/` after `corpus/scripts/flatten_samples.py` — one flat directory per sample,
every name derivable from the role:

```
corpus/samples/sampleN/
  source.<ext>                     the source-language page
  ref-<provenance>.<ext>           0..n human / competitor renders
  ref-unknown-<n>.<ext>            ...where the provenance was never recorded
  export.<ext>                     the frontend export
  render.<ext>                     the worker render
  project.zip                      the layer bundle the frontend emits
  project/                         project.zip unpacked, so the layers are greppable
  legacy-bench/                    sample5 and sample18 only — stale ad-hoc run output
  meta.json                        names the above, with provenance per reference
```

Extensions are **not** normalised — `source.jpeg` and `source.png` both occur. Making them
uniform would mean re-encoding, which changes bytes and silently invalidates every OCR result
derived from them.

The 15 NSFW pages live under `corpus/samples/NSFW/sampleN/` in the same shape, kept separate so
the whole NSFW half can be excluded wholesale. Their sample ids are `NSFW/sampleN` — page numbers
collide with the SFW ones. Their source language is recorded as `ja` but was never actually
confirmed; no NSFW page has been through a builder yet.

`meta.json` is generated from **`corpus/scripts/examples_manifest.json`**, which is committed. That
matters because the filenames no longer say what a file is — the manifest is the durable record
of which original file plays which role. Roles were established by inspecting all 40 SFW pages,
which corrected things filename heuristics got wrong (11 samples keep their human TL under its
own Twitter id; sample24/25 have the English render under the *plain* filename and the Japanese
source under `(copy 1)`). None of the `(copy 1)` files were duplicates — every one differs from
its namesake; they are mangatranslate.com renders that collided on download.

Verify the layout any time with:

```bash
python corpus/scripts/flatten_samples.py --verify
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

**The SFW set is now Japanese-only.** `sample21` used to be the one Chinese page and was swapped
for a Japanese one on 2026-08-08; the Chinese original is parked under
`corpus/samples/_parked/sample21-do-not-use-wrong-language/`. `sample20` was swapped the same day (the previous
scan was too low-quality) and now carries a *human* reference — a Danbooru screenshot with that
site's translation notes, cropped to within 4px of the source page, so it aligns fine.

A `"parked"` list in `examples_manifest.json` names the directories under `corpus/samples/_parked/`
holding a superseded version of a page. They are deliberate, and `--verify` ignores them instead
of calling them stray. Their contents were left in the old role-subfolder shape — they are
retired, not worth restructuring.

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

That writes `corpus/ocr/_review/sample36.html` — a self-contained page showing each
region's crop next to every engine's candidate. Regenerate the HTML for pages already in the
corpus without calling a single engine:

```bash
python scripts/build_ocr_corpus.py --review-only --gold sample3,sample7,sample9
```

Per region you can:

| control | effect |
|---|---|
| **use** | takes that candidate — the row highlights and the badge flips to `resolved` |
| **blank (no text)** | declares the box empty; it is then *excluded from scoring*, the right outcome for a detection false positive |
| **reject all** | strikes every candidate through and clears the box for you to type; stays unresolved until you do |
| typing | resolves the region as `resolved · edited` |

The work is mostly confirming reading order and truncation against the crop — comparing shapes,
not reading Japanese. The Save button tracks progress (`4/5 resolved`) and turns orange while
anything is outstanding. Then:

```bash
python scripts/build_ocr_corpus.py --apply-review corpus/ocr/_review/sample36.json
```

> **`--apply-review` marks every region on the page `gold`, not just the ones you edited.** So a
> half-reviewed page promotes unreviewed consensus text to hand-confirmed ground truth — and
> `gold` is exactly what re-tiering will never revisit. Export warns and names the outstanding
> regions if any are unresolved; take the warning seriously rather than clicking through it.
>
> Manually emptying a textarea does **not** count as resolved — use **blank** to say "no text
> here" deliberately, so an untouched box is never mistaken for a decision.

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

1. Drop the new file into `corpus/samples/sampleN/` under any name.
2. Update `corpus/scripts/examples_manifest.json` (roles/provenance for the new file).
3. `python corpus/scripts/flatten_samples.py --apply --sample sampleN` — renames it to its role name
   and rewrites `meta.json`.
4. `python scripts/build_translation_corpus.py --sample sampleN`
5. `python scripts/build_ocr_corpus.py --sample sampleN`
6. `python scripts/build_qa_corpus.py --sample sampleN`

> **`--apply` is idempotent**, so step 3 is the same command whether the file you dropped in is
> still under its download name or you already named it `source.png` yourself: a name that is
> already correct is simply not moved. Run it with no `--apply` first to see the plan. It refuses
> to run at all if `corpus/samples/` has uncommitted changes, so a half-applied run can always be
> told apart from unrelated edits.
>
> Note the builders never join the role paths themselves — they read `meta.json` and join what it
> says. That is why flattening the tree needed no builder change, and why step 3 is the only
> thing standing between a renamed file and a correct rebuild.

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

Default is `paddleocr_v6_medium,paddleocr_v5_server` — two generations, for *cross-checking within
the family*, not for two votes. Adding variants does not make the local pool more independent:
they share failure modes, so under the family-collapsed rule (§3) all of them together still cast
one vote. Running more than two mostly buys runtime.

> **Do not raise `--min-agree` to compensate for a large paddle pool.** That was the original
> mistake: four variants at `--min-agree 3` looks like a strict rule but is satisfied by three
> copies of one bug, while genuinely independent engines that outnumber nothing get discarded.
> Count *families*, not processes.

**Local and cloud engines resolve different regions, so the best pool has both:**

- paddle recovers short SFX crops (`トッ`, `だーれだ`) where the VLMs hallucinate plausible-looking
  wrong text — it won 6 regions over a dissenting qwen;
- the VLMs carry multi-line dialogue, where paddle's column ordering reverses the reading.

A pool of two paddle variants + two independent cloud VLMs gives three families, which makes
`--min-agree 2` a real two-of-three majority. That is the configuration behind the 72.5% figure:

```bash
python scripts/build_ocr_corpus.py --sample sampleN \
  --providers-config scripts/test-providers.json --include-paid --max-engines 2 \
  --paddle-variants paddleocr_v6_medium,paddleocr_v5_server --min-agree 2 --tol 0.10
```

Cost note: `gemini-3.1-flash-lite` is cheap and fast but **truncates long regions** — on
`sample3` r3 it stops early where qwen continues. On dense pages that leaves one strong opinion
and the region won't resolve at any threshold. It is a reasonable third family for speed; it is
not a substitute for a second strong VLM if unresolved coverage is the thing you're fixing.

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
