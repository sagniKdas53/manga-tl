# Repository, corpus, and product recommendations

- **Status:** decision document
- **Reviewed:** 2026-08-30 at commit `3b89da119141e66f94ec6aa216ba6325b8e17c6d`
- **Scope:** repository layout, documentation, worker architecture, editor, regression corpus,
  Torii parity, mangatranslator.ai comparison, and the linked OCR and inpainting research

## Executive verdict

The project has good raw material and several unusually strong investigations, but it is not yet a
reliable regression system or a coherent product platform.

The strongest parts are the captured page artifacts, the measured erasure work, the language-aware
PaddleOCR routing, the layered editor model, and the effort spent comparing real outputs rather than
arguing from screenshots. The weakest parts are truth separation, corpus identity, documentation
state, stage boundaries, and the size of the central orchestration and editor files.

The immediate objective should not be to add every model in the linked Rust project. It should be to
make the pipeline and corpus capable of comparing models without contaminating ground truth or
adding more branches to already oversized functions.

The recommended direction is:

1. Freeze the current corpus as a recoverable v1 snapshot. Do not promote the pending tree in bulk.
2. Build a manifest-driven corpus v2 with immutable source identity, reviewed annotations, external
   baselines, application runs, and benchmark splits stored as separate concepts.
3. Split OCR orchestration, erasure, rendering, and editor commands into explicit stage interfaces.
4. Replace flat polygon painting with a glyph-mask and inpainted-patch stage while preserving the
   existing non-destructive layer model.
5. Keep PaddleOCR as the production baseline. Evaluate CTD, Manga OCR, DB-family detectors, AOT,
   LaMa, and ZITS as registered candidates against stage-specific gold sets.
6. Complete the existing DeepL path by adding source language, page context, glossary, model choice,
   and provenance. Do not treat DeepL as a new subsystem.
7. Match Torii first on reliable workflow fundamentals: context, independent translate and inpaint
   actions, editable clean plates, page-wide operations, undo and redo, text export, and reproducible
   project export. Warp effects and colorization come later.

If only one product-quality change is funded, make it glyph-level erasure with an inpainted patch.
If only one repository-quality change is funded, make it corpus v2 with hard identity and provenance
gates.

## What was inspected

This review covers the root repository, the Python worker submodule, the Rust backend, the React
editor, benchmark scripts, the active and pending corpus trees, current documentation, stored Torii
artifacts, and the live Torii image workspace.

The external review used the following sources:

- [manga-image-translator-rust](https://github.com/frederik-uni/manga-image-translator-rust) and its
  [roadmap](https://frederik-uni.github.io/manga-image-translator-rust/roadmap.html)
- [manga-image-translator](https://github.com/zyddnys/manga-image-translator)
- the [DBNet paper](https://arxiv.org/abs/1911.08947) and
  [DBNet++ paper](https://arxiv.org/abs/2202.10304)
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) and its
  [recognition training guide](https://www.paddleocr.ai/main/en/version2.x/ppocr/model_train/recognition.html)
- [Manga OCR](https://github.com/kha-white/manga-ocr)
- [ZITS](https://github.com/DQiaole/ZITS_inpainting) and its
  [paper](https://arxiv.org/abs/2203.00867)
- [LaMa](https://github.com/advimman/lama) and its
  [paper](https://arxiv.org/abs/2109.07161)
- the public [DeepL API documentation](https://developers.deepl.com/api-reference/translate/request-translation)
- the live [Torii image workspace](https://toriitranslate.com/image) and
  [mangatranslator.ai upload page](https://mangatranslator.ai/upload)

No private DeepL account page or API key was accessed. Secrets are not evidence and should never be
captured in a corpus or review document.

## Current repository assessment

### What is genuinely good

- The worker already resolves detection and recognition models as language-compatible pairs. It
  correctly avoids using PP-OCRv6 recognition for Korean and falls back to PP-OCRv5 Korean
  recognition. That is a real production safeguard, not cosmetic configuration.
- The project retains original pages, editable project data, rendered images, frontend exports,
  masks, and third-party outputs for many samples. This is far better than keeping only a final PNG.
- The erasure investigation is empirical. It measures mask coverage, outline damage, component size,
  residual ink, latency, and vendor clean plates.
- The current layer model can hold per-pixel RGBA content. Neural inpainting does not require
  flattening or abandoning editable masks.
- The Rust backend has broad endpoint tests, and the worker has meaningful OCR, grouping,
  translation, QA, rendering, and provider tests.
- The repository already has separate benchmark builders for OCR, translation, and QA. The idea is
  sound even though the paths and truth quality need repair.

### Structural problems

The central files are now carrying too many responsibilities:

| File or symbol | Current size | Problem |
| --- | ---: | --- |
| `worker/handlers/ocr.py` | 1,490 lines | detection, bubble assignment, grouping, recognition, geometry, colors, masks, and persistence preparation |
| `process_ocr` | about 934 lines | orchestration and implementation are inseparable |
| `worker/handlers/render.py` | 1,293 lines | text layout, mask flow, erasure, drawing, and diagnostics are coupled |
| `fit_text_in_box_py` | about 514 lines | fit policy, mask geometry, binary search, wrapping, and diagnostics live together |
| `frontend/components/Reader.tsx` | 3,973 lines | document state, canvas, editing tools, export, keyboard behavior, network work, and UI layout |
| `worker/services/translation.py` | 1,109 lines | provider calls, fallback, prompts, batching, context, and response handling |

These are not merely large files. They make experiments unsafe because a new detector, inpainter,
or editor action is likely to become another conditional inside a shared execution path.

The next feature should introduce interfaces and adapters, not another mode flag in these files.

### Recommended stage contracts

Use explicit, serializable contracts between stages:

```text
SourcePage
  -> DetectionResult[]
  -> RecognitionCandidate[]
  -> ReviewedRegion[]
  -> TranslationBatchResult
  -> GlyphMaskArtifact
  -> CleanPlateArtifact
  -> TypesetLayer
  -> RenderArtifact
```

Every artifact should carry:

- input asset digest
- stage name and schema version
- implementation and model identifier
- model artifact digest
- complete effective configuration
- code revision
- start and finish time
- warnings and fallback decisions
- parent artifact digests

This creates a traceable directed graph of work. It also makes it possible to rerun only detection,
recognition, translation, inpainting, or rendering without pretending the whole pipeline changed.

### Refactoring boundary

The sensible split is:

```text
worker/
  stages/
    detection/
    recognition/
    region_assembly/
    translation/
    mask_generation/
    inpainting/
    typesetting/
    render/
  artifacts/
  registries/
  policies/
```

The orchestrator should select adapters and pass typed artifacts. It should not know OpenCV details,
Paddle result shapes, DeepL request fields, or Canvas-compatible mask rules.

For the frontend, move editor behavior behind commands:

```text
commands/
  addText
  deleteSelection
  moveSelection
  editTypography
  editMask
  paintPatch
  findReplace
  applyToPages
```

Commands should be reversible and serializable. That gives undo and redo, macro operations, audit
history, and project replay from one mechanism.

## Documentation assessment

### The documentation index describes an organization that the directory does not follow

`docs/README.md` says top-level files are current live work and that completed or superseded work
belongs in `docs/archive/`. The directory currently contains completed checklists, dated handoffs,
run reports, deployment plans, an old resume note, and overlapping erasure reports at top level.

Examples that should not remain presented as live entry points include:

- `CHECKLIST_2026-08-28.md`
- `RESUME_2026-08-28.md`
- `PLAN_corpus-regen-on-chrome-box_2026-08-28.md`
- `gemini-run-report-2026-08-27.md`
- `gemini-corpus-regen-runbook.md`, once the run is no longer repeatable as written
- old corpus rebuild and handoff documents under `corpus/docs/`

The erasure documents are individually useful, but their roles overlap:

- `erasure_overhaul_plan_2026-08-26.md`
- `ctd_mask_validation_2026-08-26.md`
- `erasure_method_history_2026-08-27.md`
- `mask_precision_2026-08-27.md`
- `render_quality_gap_2026-08-05.md`

Keep the evidence, but add one current design page that states the active decision and links to the
dated reports as supporting experiments. A reader should not have to reconcile five narratives to
learn what is actually planned.

### Some current documentation is false

The most visible example is `corpus/README.md`, which says there are 613 pages under `samples/`.
The current tree has 262 active samples:

| Language | Active | Pending |
| --- | ---: | ---: |
| Japanese | 211 | 24 |
| Korean | 29 | 192 |
| Chinese | 22 | 159 |
| **Total** | **262** | **375** |

`corpus/gaps/README.md` says the queue drained, while 375 directories remain in the pending tree.
`corpus/scripts/pair_index.json` still indexes the older 613-page view. These are not harmless stale
numbers. They change which pages users believe are active, reviewed, and benchmarkable.

There is also a licensing error. `erasure_overhaul_plan_2026-08-26.md` says the Rust port and the
Python project are both GPL-3.0 and marks licensing resolved. The inspected Python project is
GPL-3.0. The inspected Rust repository has no top-level license file and no Cargo license metadata.
This project also has no root license file even though the same document says one should be added.
The claim is therefore unresolved and should be corrected.

### Recommended documentation rules

Add front matter to every document:

```yaml
status: current | proposed | completed | superseded | historical
owner: team-or-person
last_verified: YYYY-MM-DD
supersedes: []
superseded_by: null
applies_to_revision: git-sha-or-range
```

Then enforce these rules:

- `docs/reference/` describes running behavior only.
- `docs/design/` contains approved or debated proposals.
- `docs/guides/` contains commands that are tested in CI.
- `docs/reports/` contains dated measurements and run results.
- `docs/archive/` contains superseded handoffs, resumes, and closed plans.
- Top-level `docs/` contains only the index and a small set of active decision registers.
- Generated files say how they were generated and are either CI-checked or gitignored.
- Every number in an index is generated from manifests, not hand-maintained.

Add a link checker and a small documentation test that verifies local targets, status values, and
the `last_verified` age of reference pages.

## Corpus assessment

### Current state

The active set contains 262 samples, and all 262 currently have the basic application triple of a
frontend export, worker render, and project JSON. The pending set contains 375 samples, of which 120
currently have that same triple.

There are 387 Torii call records and 388 raw Torii responses across active and pending areas. Raw
Torii call and response JSON consumes about 701 MiB, much of it duplicated base64 image data that is
also stored as decoded files. The corpus Git pack is about 5.19 GiB and the working tree is about
12 GiB.

The current verifier does not pass. `python3 corpus/scripts/verify_samples.py` reports 508 `STRAY`
failures because `torii_call.json` and `torii_response.json` are present but undeclared in sample
metadata. A corpus that fails its own schema check at HEAD cannot be a trustworthy release artifact.

### The central semantic error

The corpus mixes five different kinds of data inside a sample directory:

1. source material
2. human truth or annotations
3. third-party product baselines
4. this application's generated run
5. raw provider transport captures

Those are not interchangeable. In particular, a Torii render, mangatranslator.ai render, or another
model's translation is a baseline, not ground truth. A machine-generated OCR layer with QA comments
is not reviewed OCR truth. A human-translated page is not useful as a pixel reference until source
and translation images are confirmed to represent the same page and edition.

The current pending pairs have serious identity risk. The screening performed for this review found
107 strong structural outliers among 375 pairs. `sample443` is a confirmed example where the source
and alleged human reference are different pages. These samples may still be useful as independent
images, but they cannot enter paired translation or render evaluation.

`sample138` is another warning pattern: the stored Torii reference is byte-identical to the source,
the call reports no text boxes, and the language notes disagree. A successful HTTP request is not a
successful baseline.

### Corpus v2 layout

Use immutable sample identity and separate annotations, baselines, and runs:

```text
corpus-v2/
  schema/
  assets/
    sha256/ab/cd/<digest>
  samples/
    <sample-uuid>/sample.json
  annotations/
    <sample-uuid>/
      identity/v1.json
      detection/v1.json
      recognition/v1.json
      translation/en/v1.json
      glyph-mask/v1.json
      clean-plate/v1.json
      typesetting/en/v1.json
  baselines/
    <sample-uuid>/<product>/<capture-uuid>/manifest.json
  runs/
    <sample-uuid>/<run-uuid>/manifest.json
  splits/
    smoke.json
    regression.json
    challenge.json
    context.json
    holdout.json
  inbox/
  quarantine/
  archive/
  tools/
```

Content-addressed assets prevent silent replacement and deduplicate identical bytes. Stable UUIDs
prevent a directory move from changing sample identity. Human-readable aliases can remain in the
manifest, but `sample138` must never be the primary identity.

### Required sample manifest

At minimum, `sample.json` should contain:

```json
{
  "schema_version": "2.0",
  "sample_id": "uuid",
  "source_asset": "sha256:digest",
  "source_language": "ja",
  "target_languages": ["en"],
  "page_kind": "manga_page",
  "reading_direction": "rtl",
  "width": 1600,
  "height": 2400,
  "provenance": {},
  "rights": {},
  "content_tags": [],
  "challenge_tags": [],
  "series_group": null,
  "ingest_state": "accepted"
}
```

Do not put model outputs or current file paths into the immutable identity fields.

### Ingest gates

No sample should leave `inbox/` until it passes:

1. File integrity and image decode.
2. SHA-256 registration and exact duplicate detection.
3. Source language confirmation.
4. Rights and attribution record.
5. Same-page identity verification for every paired reference.
6. Dimension and orientation sanity checks.
7. Content and challenge tagging.
8. Split leakage check by source, series, artist, and near-duplicate cluster.
9. Annotation status validation.
10. Human review for any automated identity score below the acceptance threshold.

Same-page verification should combine exact hash, perceptual similarity, local feature matching,
estimated homography, OCR token overlap, and a final human decision. A translated page may change
every glyph while leaving panels and artwork stable, so a single global perceptual hash is not
enough.

### Annotation policy

Every annotation needs:

- author or tool
- creation time
- review status
- reviewer
- source artifact digest
- schema version
- confidence
- edit history or parent version

Use statuses such as `draft`, `machine`, `human_unreviewed`, `human_reviewed`, `adjudicated`, and
`rejected`. Only `human_reviewed` or `adjudicated` data should count as gold.

The single existing `gold_human.json` is not enough to call the corpus human-labelled, especially
when it contains machine OCR drafts. Gold should be granular by task and region.

### Split design

Recommended splits:

| Split | Purpose | Suggested size and policy |
| --- | --- | --- |
| smoke | every pull request | 20 to 30 pages, deterministic, fast, all core languages |
| regression | scheduled and release gate | 100 to 150 reviewed pages, stable for a release cycle |
| challenge | known failure modes | 100 or more pages, can grow, tagged by defect |
| context | chapter and series consistency | multi-page groups, never shuffled into page-only splits |
| holdout | model and threshold selection guard | hidden or access-controlled, series-disjoint |

Split by series or near-duplicate cluster, not by page. Otherwise adjacent pages and alternate
editions leak into both tuning and evaluation.

Balance at least these axes:

- Japanese, Korean, Simplified Chinese, and Traditional Chinese
- vertical and horizontal writing
- single pages, double spreads, long webtoons, and mixed layouts
- monochrome, screentone, color, low contrast, and photographic backgrounds
- clean scans, compression damage, low resolution, rotation, and perspective
- dialogue, narration, captions, signage, handwritten text, furigana, and SFX
- text inside bubbles, borderless text, text over art, and text crossing panel boundaries
- small dense text, long paragraphs, extreme aspect ratios, and sparse pages
- safe and restricted content, with explicit access and evaluation policy

### Stage metrics

Do not use one image similarity score as the product metric.

| Stage | Core metrics |
| --- | --- |
| detection | region precision and recall, polygon IoU, missed text rate, false artwork rate |
| recognition | CER, normalized CER, exact region accuracy, confidence calibration |
| grouping and order | merge and split error, pairwise reading-order accuracy |
| translation | reviewed adequacy, fluency, name consistency, omission and hallucination rate |
| glyph mask | ink recall, artwork spill, component size, residual source ink, outline damage |
| inpainting | masked PSNR and SSIM where true clean plates exist, LPIPS, seam score, structure damage |
| typesetting | overflow, minimum font violations, mask escape, contrast, reading order |
| end to end | human preference, required edit count, time to acceptable page, cost and latency |

External product outputs should be scored as named baselines. They should never define the gold
labels by themselves.

### Baseline lanes

Each product comparison needs three explicit lanes:

1. **Controlled model lane:** same translation model and equivalent prompt settings where possible.
2. **Product-default lane:** what a normal user receives without tuning.
3. **Capability lane:** each product configured for its best supported result.

Record model, provider, BYOK state, context sharing, bubbles-only behavior, custom prompt, font,
target language, API or UI version, and capture time. Do not average results from these lanes.

### Storage policy

Keep decoded canonical artifacts. Avoid storing the same images again as base64 inside ordinary
JSON.

For raw provider responses, use one of these approaches:

- strip binary payloads after verifying and recording their content digests
- store the raw response as compressed content-addressed data outside Git
- retain a small redacted fixture for parser tests

Large models, PDFs, archives, and vendor bundles should be in LFS or object storage with checksums,
licenses, and retrieval metadata. A Git pack above 5 GiB makes routine contribution and CI more
fragile than necessary.

## Product gap against Torii

Torii is the right primary reference because it exposes both a broad workflow and a useful project
artifact. The live page currently exposes:

- multi-image, ZIP, PDF, and project import
- context sharing
- custom translation prompts
- several BYOK providers and a self-hosted OpenAI-compatible endpoint
- source-language whitelisting
- independent translate, inpaint, and colorize actions
- editable original and inpainted paint sources
- erase, paint, AI inpaint, OCR-area, text, warp, and image modes
- typography, stroke, spacing, box, opacity, and distortion controls
- per-image and all-image actions
- undo, redo, find and replace, and text export
- ZIP, PDF, PSD, and reopenable project export

This project does not need every visual effect to become competitive. It needs the following product
slice, in order.

### Priority 0: trustworthy output

- A real clean-plate stage with glyph masks.
- Independent rerun controls for OCR, translation, inpainting, and rendering.
- Provenance shown in the UI for every stage.
- Reliable project save and reopen with no loss of masks, text, configuration, or model identity.
- Page and chapter context controls that visibly report whether context was used.
- Undo and redo for every destructive editor operation.

### Priority 1: editing efficiency

- Multi-select and page-wide actions.
- Find and replace across one page, a chapter, or a series.
- Export original and translated text with stable region IDs.
- Editable glyph masks and clean-plate brush repair.
- Original, clean plate, and translated image comparison modes.
- Apply typography changes to a selection, page, chapter, or series.
- Retry failed stages without rerunning successful stages.

### Priority 2: import and export parity

- A documented, versioned native project archive.
- ZIP with preserved folder structure.
- PDF export.
- PSD only after layers and typography round-trip correctly.
- Optional import of Torii archives only if legally and technically maintainable. Do not make an
  undocumented competitor format the canonical project format.

### Priority 3: advanced effects

- text warp and distortion
- image-layer transforms
- pattern and blur brushes
- colorization

These are useful for SFX and polished lettering, but they should not outrank OCR correctness,
inpainting, context, project safety, or bulk editing.

The mangatranslator.ai upload page did not expose useful static details during this review. Its
stored corpus outputs remain useful as a secondary rendered baseline, especially for balloon-outline
survival and finished-page comparisons. It should not drive architecture decisions when Torii gives
clean plates and richer metadata.

## Findings from the linked OCR and detector work

### DBNet and DBNet++

DBNet's key contribution is differentiable binarization: the network learns a probability map and
an adaptive threshold map so binarization participates in training. This is valuable for curved text
and extreme aspect ratios. DBNet++ adds adaptive scale fusion to improve robustness across text
sizes.

The project should not add a separate DBNet implementation merely because the paper is good.
PaddleOCR detection already uses DB-family ideas, and the worker already loads explicit Paddle
detection models. The practical question is whether a candidate improves manga-specific region and
glyph-mask metrics at acceptable latency.

Recommendation:

- Keep the current Paddle detector as baseline.
- Add DBNet, DBNet-ConvNeXt, and CTD only through a detector registry.
- Benchmark them on the same reviewed region and mask set.
- Keep detection boxes and glyph-mask generation as distinct outputs even when one network supplies
  both.
- Prefer CTD first for the erasure path because the existing repository investigation has already
  measured its segmentation head on manga pages.

### PaddleOCR

PaddleOCR remains the sensible default. Its official training path supports custom recognition
datasets, language-specific dictionaries, augmentation, fine-tuning, multi-language training,
knowledge distillation, and export.

The current project is already doing one important thing correctly: the model catalog distinguishes
detection from recognition and routes Korean to a compatible recognizer.

The next improvement should be data quality, not immediate retraining. A manga-specific Paddle model
trained on noisy machine labels would make errors harder to diagnose.

Recommended sequence:

1. Build reviewed crop and transcription sets for Japanese, Korean, Simplified Chinese, and
   Traditional Chinese.
2. Measure the current PP-OCRv6 and PP-OCRv5 models per language and challenge tag.
3. Calibrate confidence so fallback thresholds mean something.
4. Fine-tune only when a stable error cluster has enough reviewed examples.
5. Include manga punctuation, hearts, elongation marks, furigana, and common SFX characters in the
   dictionary and evaluation policy.
6. Export and pin the model with an artifact digest and training-data manifest.

### Manga OCR

Manga OCR is a Japanese recognizer, not a text detector. Its useful properties are vertical and
horizontal recognition, furigana, text over images, varied fonts, low-quality inputs, and multi-line
bubble recognition in one forward pass.

It is a good candidate for:

- Japanese bubble-level fallback when Paddle confidence is low
- disagreement review between two recognizers
- full-bubble recognition where line splitting damages reading order
- a challenge baseline for furigana and stylized manga fonts

It should not replace the multilingual production path. It does not solve Korean or Chinese, and
running it on every Japanese region may add substantial latency. Start as an offline benchmark and
then a guarded fallback.

### The stale model links

The linked `zyddnys/manga-image-translator/tree/main/models/dbnet`, `models/ctd`, and
`models/convnext` URLs are obsolete. The current repository stores implementations under:

- `manga_translator/detection/default.py` and `default_utils/`
- `manga_translator/detection/ctd.py` and `ctd_utils/`
- `manga_translator/detection/dbnet_convnext.py`
- `manga_translator/ocr/`
- `manga_translator/inpainting/`

Weights are obtained from releases or external model storage rather than those old source-tree
directories. Documentation should link to the current implementation directories and pin release
assets by digest, not assume a `models/` directory exists.

## Findings from the linked inpainting work

### Preserve the layer architecture

The current project should not overwrite its original page. Produce a clean-plate artifact and use
that per-pixel content in the editable layer or as a derived base. Keep the original immutable.

The current defect is the fill method and mask granularity, not the concept of layers.

### Routing recommendation

Use a tiered inpainting policy:

| Region | First choice | Reason |
| --- | --- | --- |
| flat bubble interior | OpenCV TELEA or direct sampled fill | fast and sufficient when the background is truly flat |
| structured manga crop | AOT or LaMa candidate | better reconstruction of line art, screentone, and texture |
| large structural hole | LaMa quality lane | image-wide receptive field and robustness to periodic structure |
| exceptional perspective or long-line damage | ZITS challenge lane | explicit low-resolution structure restoration and masking positional encoding |

The existing project measurements already show that AOT materially beats TELEA on text over real
artwork while TELEA is much faster on flat interiors. Use the existing local complexity statistic to
route instead of deciding globally per page.

### LaMa

LaMa uses fast Fourier convolutions to obtain an image-wide receptive field and was trained for large
masks. It is particularly relevant to screentone, repeating patterns, and long structures. The
official repository also demonstrates that its old model download links have aged poorly, which is
another reason to mirror approved artifacts with checksums rather than download from mutable URLs at
runtime.

LaMa should be a quality candidate, not automatically the CPU default. The existing repository
measurement found the large variant too slow on the current two-core worker budget. Evaluate cropped
inference, ONNX runtime providers, and GPU workers before changing the default.

### ZITS

ZITS restores structure in a fixed low-resolution sketch space, upsamples edge and line maps, then
uses that structure to guide texture restoration. Its masking positional encoding targets large,
irregular holes.

That makes it attractive for panel borders, speed lines, architecture, and long contours crossing an
erased area. It also makes the official implementation a poor first production dependency: the
repository uses an old Python and Torch environment, multiple checkpoints, wireframe extraction,
square-image assumptions in the single-image path, and a heavier pipeline.

Use ZITS to define a challenge set and a future quality lane. Do not put it on the critical path
until LaMa or AOT failures show that explicit structure restoration justifies the cost.

### The Rust manga-image-translator project

The Rust project is most valuable as an architecture and interoperability reference. Its workspace
separates detector, OCR, mask refinement, inpainter, translator, renderer, upscaler, model loading,
and runtime concerns. Its JSON Schema configuration is also a good pattern for discoverable,
validated stage selection.

Useful ideas to adopt independently:

- stage-specific interfaces
- model registries and lazy loading
- model source plus digest metadata
- explicit detector and inpainter options
- configuration schema generation
- ONNX-based adapters
- separate structured, image, HTML, and export renderers
- mask refinement as its own stage

Do not vendor the project wholesale. At inspected commit
`2a45f687e2750a85e1e4db2dd33825a875fc5703`, it had no explicit repository license, 59 placeholder
model hashes written as `###`, an incomplete roadmap, 36 TODO or unimplemented markers, and many
unchecked `unwrap` or `expect` calls. Those numbers do not make it useless, but they make it an
unsafe foundation for a production service without independent hardening.

The original Python manga-image-translator is GPL-3.0 and has clearer provenance for the algorithms,
but copying its code creates reciprocal license obligations. Architecture and published algorithm
ideas may be reimplemented, but actual code and model licenses must be reviewed separately. This is
an engineering recommendation, not legal advice.

The four Apache-2.0 repositories inspected here are PaddleOCR, Manga OCR, ZITS, and LaMa. Model
weights can carry additional terms or dataset restrictions, so repository license alone is not
enough.

## DeepL recommendation

The worker already has `try_deepl` and `translate_batch_deepl`. The batch implementation currently
sends only `text` and `target_lang`. It does not send source language, narrative context, glossary,
formality, model selection, or custom instructions.

DeepL's API explicitly supports context for short ambiguous snippets, and context characters are not
billed. This is well suited to manga bubbles, but array elements are translated independently. A
batch of bubbles does not automatically share context.

Recommended request design:

- set `source_lang` from the verified page language
- send the page or chapter summary through `context`
- attach a per-series glossary for names, terms, honorific policy, and recurring phrases
- use `prefer_quality_optimized` by default and record the model actually used
- expose a latency-optimized option for interactive edits
- use `custom_instructions` for concise manga-specific style only where supported
- choose formality deliberately and fall back with `prefer_*` behavior
- preserve region IDs and response order
- record billed characters, latency, status, and provider response metadata
- never log authorization headers or store keys in project archives

DeepL should be one translator adapter in the same registry as LLM and local translation providers.
It should receive the same `TranslationBatch` contract and produce the same result schema.

Do not pass each bubble as an isolated request. Batch for cost and latency, and supply shared context
explicitly. Do not assume DeepL replaces translation QA, name consistency checks, or layout-aware
shortening.

## What not to build yet

- Do not port the entire Rust project into the worker.
- Do not add DBNet, DBNet++, CTD, Manga OCR, LaMa, and ZITS to one production image at once.
- Do not train PaddleOCR on the current machine-generated OCR layer and call it gold.
- Do not use Torii or mangatranslator.ai output as ground truth.
- Do not promote all pending pairs after checking only that files exist.
- Do not rerun every stage when only translation, inpainting, or typography changed.
- Do not add warp and colorization before clean plates, project safety, and undo are reliable.
- Do not continue storing large base64 API payloads beside decoded copies without a retention policy.
- Do not mark licensing resolved until this repository and every imported model have explicit terms.
- Do not add more behavior directly to `process_ocr`, `fit_text_in_box_py`, or `Reader.tsx`.

## Recommended implementation roadmap

### Phase 0: stop further entropy

Deliverables:

- freeze and tag corpus v1
- correct active and pending counts in documentation
- fix or update the sample verifier so HEAD passes
- quarantine confirmed identity failures
- stop generated indexes from masquerading as authoritative state
- decide and add the repository license
- move completed plans and handoffs to reports or archive
- publish one current architecture and one current corpus specification

Exit gate:

- clean corpus verification
- no known secret in current files
- all generated indexes reproducible
- no unresolved same-page pair in the regression split

### Phase 1: corpus v2 foundation

Deliverables:

- v2 JSON Schemas
- content-addressed asset registry
- importer from v1 that defaults uncertain samples to quarantine
- identity report and review queue
- reviewed smoke split
- run and baseline manifests
- stage metric harness

Exit gate:

- one command validates the entire corpus
- one command materializes the smoke split
- external baselines and application runs cannot be confused with annotations

### Phase 2: pipeline boundaries

Deliverables:

- detector and recognizer registries
- extracted OCR orchestration stages
- translation provider interface
- mask and clean-plate artifact contracts
- render input contract
- frontend command and undo framework

Exit gate:

- a detector, recognizer, translator, or inpainter can be swapped without editing the main
  orchestrator
- stage outputs can be replayed from disk

### Phase 3: erasure quality

Deliverables:

- CTD segmentation candidate
- reviewed glyph-mask set
- mask refinement implementation
- TELEA fast lane
- AOT or LaMa structured-art lane
- editable clean-plate artifacts
- cache invalidation on region or mask edits

Exit gate:

- mask component and outline-damage gates from the existing erasure reports pass
- no silent residual text increase
- p95 latency stays inside the agreed worker budget

### Phase 4: recognition and translation quality

Deliverables:

- reviewed multilingual OCR crop set
- confidence calibration
- Manga OCR Japanese fallback experiment
- completed DeepL adapter
- context, glossary, and provider provenance in UI and project archives
- page and chapter consistency metrics

Exit gate:

- fallback improves reviewed CER without unacceptable latency
- translator comparisons are model- and context-controlled

### Phase 5: Torii workflow parity

Deliverables:

- independent stage actions
- page and chapter bulk editing
- find and replace
- text export
- original, clean plate, and render comparison
- stable project archive
- ZIP and PDF export
- PSD evaluation

Exit gate:

- a user can correct a failed page without rerunning or losing unrelated work
- a saved project reopens pixel- and metadata-equivalent

### Phase 6: advanced quality lanes

Deliverables:

- DB-family detector comparison
- LaMa quality lane and GPU profile
- ZITS structural challenge experiment
- typography effects for SFX
- optional colorization research

Exit gate:

- each added model wins a named reviewed slice and has a supported operational profile

## Definition of done for this program

The work is successful when:

- repository documentation tells a new contributor what is current without archaeology
- corpus verification passes at every revision
- every evaluation sample has immutable identity and review status
- no vendor output is silently treated as truth
- every run can be reproduced from code, model, config, and input digests
- stage regressions can be localized without running unrelated stages
- the editor can repair masks, clean plates, translations, and typography non-destructively
- the project matches Torii's core workflow on context, inpainting, editing, bulk operations, and
  project safety
- model additions are justified by reviewed metrics rather than roadmap checkboxes

## Final priority order

1. Corpus identity, truth separation, and a passing verifier.
2. Documentation state and license correction.
3. Stage contracts and decomposition of the OCR and editor monoliths.
4. Glyph masks and clean-plate inpainting.
5. Context-aware translation and complete DeepL integration.
6. Multilingual OCR gold data and Manga OCR fallback evaluation.
7. Bulk editor operations and durable project export.
8. Additional detectors and high-cost inpainting lanes.
9. Warp, PSD polish, and colorization.

That order is intentionally conservative about new models and aggressive about foundations. The
project already has enough algorithms to build a strong translator. What it lacks is a reliable way
to know which change helped, which stage regressed, and which files are actually true.
