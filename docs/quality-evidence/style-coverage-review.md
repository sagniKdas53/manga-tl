# Conventional-page and language coverage review

Date: 2026-09-10. App `d6bd527d44077ec5dfa98edeadeafe26aa2bb7b3`; worker `7d70b64baca51690abf4dfbd7a89c2cde56b2c7e`; corpus `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

## Decision

The concern is supported: the six current quality regressions are all Japanese and target unusual composition/ownership/cleanup failures. They are not a representative ordinary-page acceptance set. This does not prove that an algorithm has already overfit; it identifies a selection bias that could reward such overfitting.

**Add 24 conventional-page development controls, eight each for JA/KO/ZH, without replacing any of the six regressions.** The resulting development inventory is 30 pages: 14 JA / 8 KO / 8 ZH (46.7% / 26.7% / 26.7%). Report the balanced 24-page control set separately from the six adversarial regressions, rather than pooling them into one flattering score.

- [Selection recipe and exclusions](style-coverage-selection.json): reviewed source IDs, styles, reasons and language problems.
- [Resolved selection](style-coverage-20260910/resolved-selection.json): actual source paths, SHA-256, dimensions, active/pending lane and provenance.
- [Machine-readable audit summary](style-coverage-20260910/summary.json).
- [Tracker checkpoint](../quality-checkpoints/A06-C0.md).

These are selected source inputs, **not newly processed results, verified region labels, a frozen holdout, or a passed quality gate**. All 24 are development-only. A06-C must capture fresh baselines and owner labels, and A07 must annotate actions/masks/styles before candidate tuning. A09 still needs an independent holdout.

## Audit scope and language distribution

Enumerated current `meta.json` files in `corpus/samples/{ja,ko,zh}` and `corpus/gaps/pending/{ja,ko,zh}`, resolved their actual `source.file`, decoded every source, measured pixel dimensions and hashed bytes. Parked assets, references, historical outputs and external download collections were not counted as source candidates. No OCR, translation, browser pipeline or paid model calls ran.

| Source lane | JA | KO | ZH | Total |
| --- | ---: | ---: | ---: | ---: |
| Active | 211 (80.5%) | 29 (11.1%) | 22 (8.4%) | 262 |
| Pending | 24 (6.4%) | 192 (51.2%) | 159 (42.4%) | 375 |
| Both | 235 (36.9%) | 221 (34.7%) | 181 (28.4%) | 637 |
| Existing six regressions | 6 | 0 | 0 | 6 |
| Added development controls | 8 | 8 | 8 | 24 |

**The first three rows are declared metadata language, not corrected linguistic truth.** Metadata and directory names agree mechanically, but several disagree with source pixels. All 24 selected controls were reviewed at enlarged page-preview scale for the visible dialogue script. That is not a complete transcription or a native-language translation review. Chinese dialogue and Chinese creator origin are different claims; no artist nationality or original publication language is inferred here.

All 637 source entries decoded successfully. There are **636 distinct byte hashes**: active `ja/sample258` and pending `ja/sample637` are identical. Neither is selected. Exact hashing does not detect resized/recompressed art or alternate-language typesetting of the same art; A09 needs the additional family/near-duplicate review below.

Visual screening covered all 16 inventory sheets (7 active and 9 pending), then all six enlarged selection sheets. Contact sheets are private local JPGs in `style-coverage-20260910/` and ignored by Git; the recipe regenerates them from the private corpus. Thumbnail screening is not a complete per-page style annotation of all 637 entries. No global color/style percentages are inferred from the obsolete 120-page report.

## Selected controls

All paths below resolve through the hashed manifest. The active/pending distinction must be retained: a pending page's `output` metadata block is not evidence that processing occurred.

| Language | IDs | Source layout and reason |
| --- | --- | --- |
| JA | `sample7`, `sample39` | Clean B&W panel grids, several conventional balloons, multi-speaker conversation and dense dialogue. |
| JA | `sample139` | Conventional workplace four-panel B&W gag, adult cast, angular balloons and screentones; broadens beyond game-character aesthetics. |
| JA | `sample47` | B&W action panel layout with drawn SFX beside ordinary dialogue. Keeps mainstream action coverage without making decorative text the entire benchmark. |
| JA | `sample123`, `sample134` | Traditional rounded-character B&W dialogue page at 540x720, plus a clean high-resolution fantasy page at 4299x6071. Small dialogue/ruby and large-page screentones are distinct resolution controls. |
| JA | `sample150`, `sample172` | Colored four-panel strips, clean gutters and conventional dialogue; outlined/emphatic text remains a secondary challenge. |
| KO | `sample197`, `sample199`, `sample360` | Limited-palette multi-panel dialogue, sparse thin-line two-panel dialogue, and conventional monochrome panel tiers. |
| KO | `sample268`, `sample289`, `sample320`, `sample416` | Clean color panel comics/short strips: everyday dialogue, dense conversation, dark blue backgrounds and warm painted backgrounds. |
| KO | `sample192` | B&W single-panel multi-speaker balloon control. Not counted as a multi-panel or scroll case. |
| ZH | `sample206` | Clean monochrome two-panel action/dialogue page. Chinese dialogue but Hangul-like drawn SFX: retain mixed-script policy coverage. |
| ZH | `sample226`, `sample457`, `sample609`, `sample612` | Color panel comics spanning vertical/horizontal Chinese dialogue, colored type, flat-color and painted backgrounds. Only one example of the dominant flat-color two-panel family. |
| ZH | `sample261`, `sample611` | Grayscale single-panel balloon controls: dense independent speech units and sparse two-bubble composition. Not substitutes for multi-panel manhua. |
| ZH | `sample208` | One dense scene-collage balloon control for continuity with hard cases. Explicitly **not** counted as clean panels. |

The 24 additions contain **20 panel/strip pages**, **3 single-panel balloon pages**, and **1 scene collage**. Nineteen are tagged with clean gutters; the action page is separate. Nine are B&W panel pages, three B&W single-panel pages, one limited-palette page, and eleven color pages. All 24 contain conventional speech balloons, although some also contain free-standing dialogue, narration or SFX. This is deliberate mixed-case coverage, not a claim that every text region has a white bubble.

Fifteen controls are active sources and nine are pending sources. No source was copied, moved, deleted or relabelled in the corpus; selection is by immutable hash/path. No reference translation was promoted to ground truth.

## Language integrity findings

These source files were opened individually to confirm the visible script. The selection's exclusion list prevents their use as declared-language controls until the source/reference roles and metadata are repaired in a separate corpus packet. Existing historical evidence remains unchanged.

| ID | Declared | Source-pixel finding | Evaluation action |
| --- | --- | --- | --- |
| `sample4` | JA | Chinese dialogue and Chinese chart labels. | Exclude from JA quotas; review Chinese source/reference routing. |
| `sample204` | JA | Hangul speech balloons. | Exclude from JA quotas; review Korean routing. |
| `sample266` | KO | Japanese narration/title and reading-direction instruction. | Exclude from KO quotas; review original/reference roles. |
| `sample312` | KO | Already-English dialogue. | Exclude from KO-to-English input evaluation. |
| `sample361` | KO | Already-English title and dialogue. | Exclude from KO-to-English evaluation; apparent artwork variant `sample363` needs joint review. |
| `sample409` | KO | Japanese balloon and margin dialogue. | Exclude from KO quotas; review original/reference roles. |
| `sample138` | ZH | Very low-resolution action page with Japanese drawn SFX, no verified Chinese dialogue. | Language coverage unresolved; cannot satisfy Chinese dialogue quota. |

This establishes **at least six incorrect declared dialogue languages plus one unresolved Chinese case**, not an exhaustive corrected language census. Some other pending previews also appear to be translated variants or text-free images. Check the selected source pixels before counting any further page. `sample68`, suspected from its tiny preview, was opened and confirmed Japanese; it is not an error. This is why script decisions must not be made from directory names, titles or tiny thumbnails alone.

Selected Chinese controls include both simplified forms (`sample206`, `sample208`, `sample226`, `sample261`) and traditional forms (`sample457`, `sample609`, `sample611`, `sample612`). Their labels remain broad `zh`; A07/A09 must record reviewed script variants explicitly. English snippets and mixed-script SFX must not automatically reclassify the whole page.

## Remaining style gaps

"Not found" here means no verified qualifying example from this source-screening pass, not proof that no image anywhere in the private collections could qualify.

| Style / coverage | Finding | Consequence |
| --- | --- | --- |
| Traditional clean B&W Japanese manga | Available and now explicitly selected, including sparse/dense dialogue, screentones and action. | No longer left to chance in the quality set. Still needs fresh processing and reviewed labels. |
| Short webcomics / four-panel strips | Available in JA and KO; Chinese two-panel webcomics also available. | Covered as short formats, not evidence for long-scroll performance. |
| Full long-scroll KO webtoon / ZH manhua episodes | **No verified full long-scroll episode selected or identified.** Short stacked strips and tall cropped scenes exist. | Source a genuine multi-screen episode/segment with many panels, large vertical whitespace transitions and readable source dialogue. Aspect ratio alone cannot close this gap. |
| Traditional serialized/print manhua, especially dense B&W or ink-heavy action | **No provenance-verified representative identified.** Chinese-language images mostly establish translated/fan-webcomic styles, not print-manhua origin. | Obtain independently sourced conventional Chinese narrative pages; do not rename a Chinese-translated manga page "traditional manhua" to satisfy the quota. |
| Distinctive sports/technical sequential pages and ornate shoujo page design | **No dedicated verified controls selected in this pass.** Fantasy/action is present, so action as a whole is not missing. | Additional targeted sourcing/annotation required for these styles; do not claim complete genre coverage. |
| Physical print-scan damage | **No verified representative selected.** `sample138` is degraded but its 358x506 raster and uncertain language cannot establish physical-scan provenance. | Binding curvature, bleed-through, paper aging and scan moire remain unvalidated. Keep separate from the requested clean-digital baseline. |
| Rough pencil/storyboard and handwriting | Corpus candidates exist (`sample143`, `sample152`); not in this conventional-control addition. | Not absent from the corpus. No new reviewed acceptance claim; retain the distinction from polished pages. |
| Chinese/Korean source-family diversity | The pending ZH sheets are overwhelmingly a repeated flat-color two-panel fancomic family, with a few other visual families; KO also repeats several artists/series and includes wrong-language variants. | Equal language counts alone would still be biased. Record original creators/series and cluster related art before holdout selection; an uploader/translator handle is not an artist ID. |

The selected controls still contain substantial game/fancomic and character-art subject matter. They improve **layout and balloon representation**, not necessarily demographic, genre or publisher representation. Those limitations must stay visible instead of turning "24 more pages" into a claim of corpus completeness.

## Anti-overfitting requirements

1. Keep the six exact regressions as hard tests; add all 24 ordinary controls to baseline capture, labelling and final J01 evaluation. Do not replace one biased set with another.
2. Require results by language **and** layout family: ordinary bubble/panel pages, strips, single-panel dialogue and adversarial free-text/composition cases. No pooled score may hide missing dialogue, border damage or a failing conventional-page slice.
3. A09 must freeze **at least 24 separate held-out pages, eight per language**, rather than sampling in proportion to the JA-heavy active set. At least four per language must have multiple panels and conventional speech balloons; at least four JA pages must be B&W panel manga. Include KO short strips and ZH panel comics explicitly. Covers, collages, portraits and single-panel illustrations cannot satisfy the multi-panel minimum.
4. Review near-duplicates and source families before splitting. No same original page, alternate-language rendering, adjacent chapter episode or identified creator/series family may cross development/holdout. Aim for at least four independent families per language in the holdout, at most two pages per family. Missing creator provenance is unresolved, not automatic independence.
5. In particular, keep `sample258`/`sample637` together; review `sample361`/`sample363`; group `sample123` with related `sample122`/`sample124`/`sample125`, the `sample208`/`sample209` family and related `sample226`/`sample227`/`sample230`/`sample231` pages. Check the large families represented by `sample47`, `sample134`, `sample172`, `sample289`, `sample320`, `sample360` and `sample457` against prospective holdout pages. These examples are not a complete family map.
6. Do not tune on holdout outputs or labels. If the corpus cannot supply independent, correctly labelled styles/languages after exclusions, **A09 remains blocked and requests additional sources**. Do not backfill with English-translated sources, related pages or more free-standing illustration text simply to reach 24.
7. Missing styles remain explicit gaps. Do not silently promote short four-panel strips to full-scroll coverage, or infer manhua/manhwa authorship from `zh`/`ko` metadata.

## Reproduction and validation

From the parent root, using the existing isolated environment:

```bash
./.venv/bin/python docs/quality-evidence/audit_style_coverage.py \
  --output docs/quality-evidence/style-coverage-20260910 \
  --selection docs/quality-evidence/style-coverage-selection.json

# Use resolved input for a subsequent hash-pinned verification in a new output directory.
./.venv/bin/python docs/quality-evidence/audit_style_coverage.py \
  --output /tmp/opencode/style-coverage-verify \
  --selection docs/quality-evidence/style-coverage-20260910/resolved-selection.json

./.venv/bin/python -m ruff check docs/quality-evidence/audit_style_coverage.py
./.venv/bin/python -m ruff format --check docs/quality-evidence/audit_style_coverage.py
git diff --check
```

The tool verifies source decoding, metadata/path consistency, unique selected IDs/bytes, separation from the original regressions/exclusions, and pinned language/path/hash when resolved input is supplied. It does **not** automatically verify linguistic correctness, styles, source-family independence or acceptance labels. Full app/worker/backend suites are not relevant to this source-curation change. No application or worker production code changed.

Executed: full source inventory/selection generation and a second hash-pinned verification both passed (637 decoded entries each, zero source errors; 24 unique controls). Recipe/resolved-row equality, selected hashes, summary counts and local Markdown links passed the [consistency check](style-coverage-20260910/validation.json). Ruff lint/format and `git diff --check` passed. One earlier inventory invocation hit the 120-second command timeout; rerunning with a 600-second allowance completed without substituting cached output. GitNexus change detection reports LOW risk/no affected execution flows for the tracked tracker edit; the new untracked evidence/script files were reviewed separately because that diff analysis does not cover them. Corpus and worker worktrees remain clean.
