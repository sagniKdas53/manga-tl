# Corpus reorganisation

I want to reorganise `corpus/` in the manga-tl repo. Two jobs: **triage the gaps queue**, and
**regroup `samples/` by language pair**. Read `corpus/README.md`, `corpus/gaps/README.md` and
`corpus/docs/` before proposing anything.

## Where things stand

- `corpus/` is a **separate git repo**, mounted as the submodule `corpus/`. It commits separately
  from the parent, and the parent must never carry these files.
- `corpus/samples/` — 213 flat sample dirs, `sample1..sample213`. Every page has `meta.json`,
  `source.<ext>`, and 0-5 `ref-<provenance>.<ext>` files. I measured the language split:
  **ja 177, ko 22, zh 14 — and the target language is `en` for all 213.**
- `corpus/gaps/` is the queue of pages that are not samples yet:
  - `Japanese/` 35, `Chinese/` 10, `Korean/` 8, and one vendor-named dir with 6 — mostly proper page dirs, but many are
    still named `New Folder`, `New Folder (1)` … `New Folder (12)`. Contents look like
    `source.png`, `en-source.png`, `meta.json`, `page-1-export(2).png`, `page-1-rendered(2).png`,
    `page-1-layers(2).zip`.
  - `Uncategorized/` — **2,754 loose image files** with UUID filenames (1484 jpg, 1039 png,
    166 jpeg, 61 webp, 3 gif, 1 webm) and no metadata or language labels. This is a raw dump.
  - `Japanese/comparison/` is a hand-built pipeline comparison I am using elsewhere — **leave it
    alone.**
- Existing tooling that must keep working: `corpus/scripts/flatten_samples.py`,
  `fold_corpus.py`, `verify_samples.py`, `corpus_audit.py`, `identify_source.py`,
  `id_map.json`. Recent commits were specifically about keeping `fold_corpus.py` runnable
  post-fold and making `flatten_samples.py` round-trip the folded schema — do not regress that.

## What I want

**1. Regroup `samples/` as `source→target/sample_num`**, e.g. `samples/ja-en/sample1/`.

Push back on this first if you think it is wrong. Target is `en` for all 213 pages today, so the
pair axis is a constant and the layout collapses to `ja/`, `ko/`, `zh/` plus a suffix that never
varies. Tell me whether you would (a) do it as asked and future-proof for `ja→zh` etc., (b) group
by source only, or (c) leave the directory flat and put the pair in `meta.json` with an index.
Give me a recommendation, not a survey.

**2. Renumbering is the risky part.** `sample_id` is referenced from `corpus/benchmarks/`,
`corpus/docs/SAMPLE_ID_MAP.md`, `corpus/scripts/id_map.json`, `scripts/region_truth.json` in the
parent repo, and the run JSON under `corpus/runs/`. Before moving anything, grep the whole tree —
both repos — for sample-id references and show me what would break. Whatever you do must keep the
old ids resolvable; extend `SAMPLE_ID_MAP.md` rather than rewriting it. **Preserve git history —
use `git mv`.**

**3. Triage `gaps/Uncategorized/`.** 2,754 loose images is the bulk of the work. I want a plan
before any bulk move:
- Deduplicate — perceptual hash, not byte hash; report how many are dupes of each other and of
  existing `samples/`.
- Detect source language per image. `identify_source.py` may already do some of this.
- Classify what each file actually is: a manga page, a crop/fixture, a reference render someone
  saved, or junk (the `.webm` is certainly junk).
- Propose which are worth promoting to samples and which should be parked or dropped. Do not
  promote anything without a `meta.json` that matches the existing schema.

**4. Normalise the named gap dirs.** `New Folder (11)` should become a real id. Match the naming
already used in `gaps/`, e.g. `sample_gap_zh12_catgirl_dense_dialogue`.

**5. I will add more Chinese samples soon** — zh is the thinnest language at 14. Leave the layout
and scripts ready to absorb them without another reorganisation.

## How to work

Do the analysis and show me the plan **before** moving files — this is destructive and
history-sensitive. Bulk moves in a branch, verified with `verify_samples.py` and `corpus_audit.py`
before and after, with the before/after counts diffed. Run `detect_changes({repo: "manga-tl-corpus"})`
if the corpus is separately indexed; note that `detect_changes()` on `manga-library` cannot see
inside submodules.

One caveat worth knowing: parts of this corpus are NSFW. That is expected and is what it is for —
handle the files without commentary.


## Required: strip vendor names from the corpus

The docs now refer to commercial pipelines as **toriitranslate.com/B/C/D** only. The corpus still spells
them out on disk, and that is the larger exposure — these are paid competitors we are reverse
engineering, and their names have no business in our repository.

In scope for this reorg:

- **Reference files** — 211 `ref-<vendor>.{jpg,png,jpeg}`, 13 more for another vendor. Rename to a
  neutral scheme (`ref-a`, `ref-b`, …) preserving the extension.
- **`provenance` values in `meta.json`** — 211 + 13 + 5 entries spell vendor names. Same mapping.
- **`corpus/gaps/<vendor>/`** — one directory named after a vendor, 6 pages.

Two consumers must be updated in the same change or they silently stop matching:

- `scripts/render_quality_metrics.py` and `scripts/build_translation_corpus.py` glob these filenames.
- `corpus/docs/`, `corpus/benchmarks/` and `corpus/runs/` reference the provenance vocabulary.

**Keep the A/B/C/D mapping out of both repos.** It is recorded only in the assistant's local memory.
Use `git mv` so history follows, and do this as its own commit, separate from any restructuring —
a rename touching 400+ files should not be tangled with a directory reshuffle.
