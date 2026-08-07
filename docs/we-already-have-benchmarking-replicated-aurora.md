# Benchmark corpora rework: SFW curation, OCR corpus, unified runners, QA bench, history purge

## Context

`examples/` was re-curated: NSFW pages were moved to `examples/NSFW/` and 40 SFW samples
remain. That broke things downstream and exposed structural debt:

- **`scripts/corpus/` still references the NSFW pages.** 11 of its 31 entries
  (`sample17,20,21,23,24,25,26,27,28,30,31`) have `reference.json` `source_image` paths that
  no longer resolve — verified by resolving every path against the working tree. The other 20
  resolve cleanly. Worse, `sample28` was the *hand-verified* `extraction_method: "manual"`
  baseline **and** `benchmark_translation.py`'s `QUICK_SUBSET` default, so the default
  invocation now points at a deleted page.
- **9 SFW samples never made it into the corpus** (`sample3, 22, 34–40`). Several are invisible
  to `build_translation_corpus.py`'s `find_source_and_reference()` heuristics because the EN
  reference carries an unrelated Twitter filename with no `en-` prefix (e.g. sample34's
  `HPAP_YkakAAYNwp.jpg` is the EN render of `GsdYUt8b0AUpzsE.jpg`). On `sample31` the heuristic
  picks the **English** page as the source.
- **There is no OCR corpus at all.** `benchmark_vlm_ocr.py` takes a single `--image`, has no
  ground truth, no accuracy metric, and writes demo JPEGs into the CWD.
- **There is no QA benchmark**, despite `config/providers.json` already carrying `qaLLM` and
  `qaVLM` model lists and the worker running both arms (`worker/src/worker/handlers/qa.py`).
- `examples/` is gitignored but 14 files were committed before the ignore landed; 43 commits
  touch the path and 374 blobs live in history (`.git` is 235 MB).

**SFW verification is done.** All 40 originals were reviewed visually. Every one is SFW —
nothing needs moving to `NSFW/`. A few are mildly suggestive (swimwear in sample26/28,
an undergarment gag panel in sample29, revealing fantasy outfits in sample22) but none are
explicit. `examples/NSFW/` stays where it is and is excluded by construction: the corpus
builder globs `examples/sample*`, which does not match `examples/NSFW/sample*`.

**Outcome:** a committable, SFW, ground-truthed corpus for OCR alongside the existing text-only
TL corpus; OCR and QA benchmarks that share `benchmark_translation.py`'s provider-driven shape;
and `examples/` gone from git history.

---

## Order of work

5 (reorganize examples) → 1 (purge + rebuild TL corpus) → 2 (OCR corpus) → 3 (unify OCR bench)
→ 4 (QA bench) → 6 (history rewrite, last, once every `examples/` path has settled).

---

## 1. Reorganize `examples/` (task 5)

Per-sample role subfolders, **original filenames preserved** inside them:

```
examples/sampleN/
  source/<original filename>          # exactly one, the source-language page
  reference/<original filename>       # 0..n reference renders (human / competitor)
  output/frontend-export.png          # was page-N-export*.png
  output/worker-render.png            # was page-N-rendered*.png
  output/project.zip                  # was page-N-layers*.zip
  output/legacy-bench/                # stale demo_output_*/ocr_results_*/tl_output_*/qa_output_*
  meta.json
```

`meta.json` is the single source of truth — scripts stop guessing filenames:

```json
{
  "sample_id": "sample34",
  "sfw": true,
  "source": { "file": "source/GsdYUt8b0AUpzsE.jpg", "lang": "ja" },
  "references": [
    { "file": "reference/HPAP_YkakAAYNwp.jpg", "lang": "en",
      "provenance": "human", "attribution": "@kaede_fortune, TS+TL u/duoblue" }
  ],
  "output": { "frontend_export": "output/frontend-export.png",
              "worker_render": "output/worker-render.png",
              "project": "output/project.zip" },
  "notes": ""
}
```

`provenance` vocabulary: `human`, `mangatranslator.ai`, `mangatranslate.com`,
`mangatranslate.online`, `google-lens`, `local`, `manually-edited`.

Source/reference roles confirmed by eye during the SFW pass — these are the ones the old
heuristics get wrong or miss:

| sample | source | reference(s) |
| --- | --- | --- |
| 17 | `0.jpg` | `1.jpg` (human EN) |
| 20 | `HN5-X5UaoAAOOhE.jpeg` | `HN7kEItXEAEueWo.jpeg` |
| 27 | `HNJNqLGbcAA_JBg.jpeg` | `HONiqFSWkAAVWaI.jpeg` |
| 28 | `HN5iU6qaEAAAYLo.jpeg` | `HN7dL-VXgAAqNW_.jpeg` |
| 30 | `HN_OVsabcAA2-0t.jpeg` | `en-HN_OVsabcAA2-0t.jpeg`, `HOFxwnKWcAA1CH1.jpeg` |
| 31 | `HOD7g4-bMAAXGLG.jpeg` | `HOE0stWaQAA8a2n.jpeg` — **old heuristic picks the EN as source** |
| 34 | `GsdYUt8b0AUpzsE.jpg` | `HPAP_YkakAAYNwp.jpg` |
| 35 | `HPAgSMOaQAAPIrS.jpg` | `HPA1RGOWoAAslOV.jpg` |
| 36 | `GhSomnxbIAEPKVw.jpg` | `HPCfmSdXoAAbaPf.jpg` |
| 37 | `FOiznJ2VQAIIlw0.jpg` | `HPCVCYSaIAAAt0l.jpg` |
| 22 | `original.jpg` | *(none — `references: []`)* |

Cleanup, all verified before deleting:

- `*(copy 1)*` files in samples 2, 20, 21, 23, 24, 25 — confirm byte-identical via sha256, then delete.
- `task-*.zip` in samples 2, 20, 21, 23, 24, 25 — **not** project archives; each contains exactly
  one file, the source image re-downloaded. Delete. (The real project zip is `page-N-layers.zip`.)
- `sample4/note.txt` → fold its text into `meta.json` `notes`, delete the file.
- `examples/immich-ocr-models.jpg` (stray screenshot at the root) → `docs/img/`.
- `sample3/HNH3MvUXoAAQko3.jpeg` is a second, unrelated page with no counterpart — **flag for your
  call** during implementation: own sample, or delete.

Code to update for the new layout:

- `scripts/build_translation_corpus.py` — delete `find_source_and_reference()`,
  `ORIGINAL_STEMS`, `REFERENCE_PREFERENCE`; read `meta.json` instead. Add
  `--bootstrap-meta` that emits *draft* `meta.json` files from the old heuristics for review,
  so the migration is scripted rather than hand-typed 40 times. Emit
  `source_image`/`reference_image` as `examples/sampleN/source/...` paths.
- `scripts/render_quality_metrics.py` — `score_suite()` scans `examples/sampleN` for an
  original plus an export; point it at `meta.json`.
- `scripts/render.py` docstring paths, `docs/run_ocr_bench.md`, `docs/translation_bench.md` §2–3.

## 2. Make `scripts/corpus/` SFW (task 1)

- Delete the 11 dangling entries listed in Context.
- Fix `build_translation_corpus.py`'s manifest merge: it currently merges by `sample_id` into the
  existing `_manifest.json`, so removed samples linger. Prune ids with no on-disk directory.
- Rebuild across all SFW samples. `sample22` has no reference and stays in `EXCLUDED_SAMPLES`.
  Expected coverage ≈ 28 entries.
- **Re-seat the manual baseline.** `MANUAL_SAMPLES = {"sample28"}` and `QUICK_SUBSET = ["sample28"]`
  both point at a deleted page. Set both to one of the 10 gold samples chosen in task 3 —
  `sample36` is a good default: clean 3-panel layout, well-separated bubbles, a clear human EN
  reference with attribution.

## 3. OCR corpus, committable (task 2)

New `scripts/build_ocr_corpus.py` → `scripts/ocr_corpus/`:

```
scripts/ocr_corpus/
  _manifest.json
  sampleN/
    page.webp       # long edge 1600, WebP q80 — matches downscale_for_ocr(max_dim=1600)
    regions.json    # [{id, bbox:[x,y,w,h], polygon, text, lang, direction, tier}]
    meta.json       # tier counts, per-engine agreement, provenance, source sample
  _review/sampleN.html
```

Committing ~40 WebP pages at 1600px lands around 8–14 MB. That is deliberate and is the one
thing that *does* go into git — call it out in the commit message so it doesn't read as a
regression of the `examples/` purge.

**Region proposal** reuses the production path already written in `benchmark_vlm_ocr.py`:
`get_all_text_regions()` → `detect_bubbles_yolo` (YOLO bubbles) + PaddleOCR background text
merged through `worker.services.merge_regions.merge_ocr_regions`. No new detection code.

**Ground truth — hybrid, as you chose:**

- *Consensus tier (all 40).* Transcribe each region with local PaddleOCR plus 2–3 vision models
  from `config/providers.json` `models.ocr` (via `list_candidate_models`). Normalize NFKC + strip
  whitespace/width variance, then accept the modal candidate as `tier: "consensus"` when ≥3
  engines land within CER ≤ 0.10 of it (or 2 of 3 within CER ≤ 0.05). Everything else is
  `tier: "unresolved"` and excluded from the default subset.
- *Gold tier (10 samples).* Since you don't read Japanese, the review step is
  **choose-and-confirm, not transcribe**: `_review/sampleN.html` shows each region's crop
  enlarged, every engine's candidate side by side, disagreeing characters highlighted, and the
  consensus pre-selected. You accept or correct; `--apply-review` writes `tier: "gold"`.
  Suggested 10, picked for legible text and clean bubbles: **17, 34, 35, 36, 37, 12, 13, 16, 38, 39**.

`--corpus-subset` follows the TL bench's vocabulary: `quick` (the manual/gold baseline page),
`clean` (gold + consensus-only samples), `all`.

## 4. Unify the OCR benchmarks (task 3)

Extract `scripts/bench_common.py` first so the two runners can't drift: `strip_fences`,
`call_provider`, and a generic `run_ladder(url, headers, payload_builder, retries)` implementing
the empirical structured-output ladder (`json_schema` → `json_object` → `none`, 429 backoff,
`attempts_log`). Refactor `benchmark_translation.py`'s `try_model_on_page` onto it — behaviour
unchanged, and this is the shared contract the OCR and QA benches then reuse.

Reshape **`scripts/benchmark_vlm_ocr.py`** to match `benchmark_translation.py`:

- Corpus-driven: `--corpus-dir` (default `scripts/ocr_corpus`), `--corpus-subset {quick,clean,all}`,
  `--pages`, `--out-dir` (required). Keep `--image` as a one-off escape hatch that skips the corpus.
- Add `OCR_JSON_SCHEMA` for the existing `{text, language, writing_direction}` prompt contract and
  drive it through `run_ladder` — today it hardcodes `response_format: json_object` and has no
  retry, so a model that only supports `json_schema` or plain prompting reads as a hard failure.
- Scoring against `regions.json`: mean **CER**, exact-match rate, plus language/direction accuracy.
  For `nvidia/nemotron-ocr-v2` (whole-page CV endpoint, already special-cased in
  `call_nvidia_ocr_v2`) additionally report detection IoU coverage against the corpus polygons.
- Outputs move from CWD to `{out_dir}/{provider}/{model}/{sample}.json` plus
  `{sample}-overlay.jpg`, with `_summary.json` sorted by CER asc then latency asc and the same
  printed table `benchmark_translation.py` ends with.

Do the same corpus/`--out-dir`/`_summary.json` treatment to **`scripts/benchmark_local_ocr.py`**
so local engines and cloud VLMs land in one comparable table. Update `docs/run_ocr_bench.md`.

## 5. QA benchmark, LLM + VLM (task 4)

`scripts/build_qa_corpus.py` (defect injector) + `scripts/benchmark_qa.py` (runner).

The runner reuses `build_qa_prompt` and `QA_JSON_SCHEMA` from `scripts/test_qa.py` — exactly the
way `benchmark_translation.py` reuses `test_translation.py` — so it measures the production
prompt, and pulls models from `list_candidate_models(cfg, "qaLLM")` and `(cfg, "qaVLM")`, both of
which already exist in `config/providers.json`.

Each case starts from a gold OCR page plus its trusted EN reference, and gets **one** labeled
defect (plus unmutated controls, which is how false positives get measured):

| class | mutation | expected verdict |
| --- | --- | --- |
| `mistranslation` | fluent but semantically wrong EN line | `failed` or `direct_fix` |
| `untranslated` | EN left identical to the JA source | `failed` |
| `ocr_garbage` | plausible OCR confusions in the source (ー/一, ロ/口, ツ/シ) | `escalation.ocrBad = true` |
| `ocr_unrecoverable` | source replaced with random kana | `escalation.needsReOcr = true` |
| `order_swap` | two regions' reading order swapped | `escalation.orderBad = true` |
| `sfx_translated` | an SFX region given a literal English translation | `reject_sfx` |
| `overflow` *(VLM only)* | re-render with font size forced 2× so text spills the bubble | `failed`/`direct_fix`, typesetting feedback |
| `control` | unmodified | `passed` |

The VLM arm needs pixels: render the mutated `project.json` with `scripts/render.py`, then build
the JA-left / EN-right composite the same way `_process_qa_vlm()` does in
`worker/src/worker/handlers/qa.py`, so the bench feeds models the production input shape.

Per model, per defect class: **detection recall**, **verdict-match accuracy** (flagged the right
defect, not merely "something's wrong"), **false-positive rate on controls**, `directFix`
usefulness (CER of `correctedText` against the clean original), latency, tokens. Headline ranking
is macro-F1 across defect classes with FP rate reported alongside — a model that flags everything
must not top the table. Write `docs/qa_bench.md` mirroring `docs/translation_bench.md`.

## 6. Purge `examples/` from git history (task 6)

Rewrite locally; **I will not push.** Both remotes (`github`, `origin`) keep their current
history until you force-push.

1. Backup: `git bundle create ../manga-library-backup.bundle --all`; record `main`'s sha and both
   remote URLs.
2. `git filter-repo --path examples/ --invert-paths` (install via pipx if absent).
3. Verify: `git log --all -- examples/` is empty; `git rev-list --all --objects -- examples | wc -l`
   is 0; `git count-objects -vH` shows the shrink; `git submodule status` still resolves `worker`;
   `.gitignore` still carries `examples/`; `git diff <backup-sha-tree> HEAD -- . ':!examples'` is
   empty (nothing but `examples/` changed).
4. Leave the exact force-push commands in the final report for you to run.

Note: `filter-repo` removes the `origin`/`github` remotes as a safety measure — re-adding them is
part of step 4's instructions.

---

## Verification

- **SFW:** already done for all 40 originals; re-confirm nothing new appears under `examples/sample*`.
- **Task 5:** `python scripts/build_translation_corpus.py --list-eligible` resolves a source *and*
  the right reference for all 40 (sample22 correctly reports no reference; sample31 reports the
  Japanese page as source).
- **Task 1:** every `scripts/corpus/*/reference.json` `source_image` and `reference_image` resolves
  on disk — rerun the same path-resolution check used to find the 11 breakages.
  `python scripts/benchmark_translation.py --provider openrouter --out-dir /tmp/tlbench` runs on
  the new `QUICK_SUBSET` without a missing-page error.
- **Tasks 2–3:** `python scripts/build_ocr_corpus.py --sample sample36` then
  `python scripts/benchmark_vlm_ocr.py --provider openrouter --corpus-subset quick --out-dir /tmp/ocrbench`
  → `_summary.json` with non-null CER, and per-model overlays under the out-dir, not CWD.
  Confirm `benchmark_translation.py` still produces identical output after the `bench_common.py`
  refactor by diffing a before/after run on the same page.
- **Task 4:** `python scripts/benchmark_qa.py --arm llm --provider openrouter --out-dir /tmp/qabench`
  → controls score near-zero false positives on a strong model; a deliberately weak model shows
  low recall. Then `--arm vlm` to exercise the render + composite path.
- **Task 6:** the four checks in §6 step 3, plus `git fsck --no-dangling` clean.

## Open item

`sample3/HNH3MvUXoAAQko3.jpeg` — unrelated second page, no counterpart. Promote to its own sample
or delete? I'll pause on that one file rather than guess.

---

I have exported the plan here @docs/we-already-have-benchmarking-replicated-aurora.md (I need to leave for work now) Also HNH3MvUXoAAQko3.jpeg is the human tl version of the HM8EpisaIAAUhSd.jpeg, there should be more images that have human tl equivalent right?
