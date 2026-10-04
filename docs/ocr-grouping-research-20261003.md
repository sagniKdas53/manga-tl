# Problem statement: OCR line fragments are not reliably converging into groups

<!-- The user's own research (2026-10-03), pasted into the 2026-10-03 session; kept
here verbatim so item B can start from it. Notes added by the session are in the box below. -->

> **Session notes, 2026-10-03 (answers to §7 and links to what is already measured):**
> - Q1: the worker still runs the single-class `yolo11n_bubble.onnx` (`worker/src/worker/config.py`,
>   `YOLO_MODEL_PATH`); no other bubble model is wired in.
> - Q3: the probe doc is `docs/archive/region_waist_probe_2026-08-09.md` (the compose comment's
>   `docs/region_waist_probe_…` path is stale).
> - H1 here (the owner veto over-splits) is already measured: on the dev "Tests" series it split
>   8 groups, 42 regions on 5 pages, back into singletons: 25 for
>   `insufficient-lateral-line-overlap`, 17 for `mixed-line-orientation`; 7 of the 8 sat inside one
>   detected balloon. Cause: when OCR breaks one vertical column in two (ブラ | イダル), the top
>   piece's x-neighbour is the next column, overlap about 28 %, so the whole balloon is vetoed.
>   Separate miss (ch. 1 p. 4): lines 8–9 px apart against a budget of 0.35 × line height ≈ 7 px.
>   Filed as `AUDIT-R21` (`docs/issues.md`); manual merge is the workaround.
>   So H1 is observed, not just a guess. What stays unverified is how common it is across
>   formats and how much of the remaining failures it explains; Step 0 answers both.
> - Step 0 data: `corpus/gaps/_rescued/backup-branches-2026-08-23/` holds the 2026-08-12 grouping
>   A/B layer bundles (region boxes for 40 pages at two settings, 351 and 278 regions); its README
>   maps each to its current corpus page.
> - This is follow-up **B** in `docs/output-quality-r7-close-20261001.md`.

**Repo:** `manga-tl-worker`  |  **Audience:** Claude Code  |  **Status:** code read, nothing run
This revision replaces an earlier draft that was written from the README alone. That draft proposed bubble-containment grouping and size-normalized thresholds, both of which already exist. Everything below is grounded in the source unless marked *unverified*. No page images or captures were available, so no failure was reproduced.

Follow `CLAUDE.md` / `AGENTS.md` and the TDD skill in `.agents/skills/tdd`. Tooling: Python 3.13, `uv`, `pytest`, `ruff`, `pyright` (see `COMMANDS.md`).

## 1. Symptom

PP-OCR detects and recognizes text lines well, but lines belonging to one speech bubble or text block sometimes end up as separate regions, so translation and typesetting receive fragments. Tuning `OCR_MERGE_THRESHOLD` helps some pages and hurts others.

## 2. What the code already does (do not re-propose)

Pipeline, in `src/worker/handlers/ocr.py`:

1. **Bubble assignment.** YOLO bubble masks are rasterized; each OCR fragment is assigned to the bubble with the largest pixel overlap. `bubble_covers_text` rejects a bubble that is really the white stroke around unenclosed lettering (rule R1); such fragments fall to the unmatched path.
2. **In-bubble grouping.** Per bubble, `merge_ocr_regions` -> `group_fragments` (`services/fragment_grouping.py`) builds a proximity graph and takes connected components. Gates in play, from `config.py` defaults: `OCR_MERGE_THRESHOLD=0.35` (multiple of character size), `OCR_ORIENTATION=vote` (orientation from fragment aspect ratios, not reading direction; fixes BUG-6), `OCR_WAIST_GATE=1.0` (balloon-outline clearance veto for fused blobs, `services/bubble_geometry.py`), `OCR_COMPONENT_MAX_AREA_FRACTION=0.25` (oversized components are regrouped at halved thresholds, then singletons).
3. **Owner veto.** `owner_aware_grouping_context` runs `assign_captured_owners` (`services/owner_assignment.py`) on each component. If the decision is not `assigned`, `_bound_components` **splits the entire component into singletons**.
4. **Unmatched fragments** (no bubble: narration, SFX, free text) are partitioned by panel / dark text container (`partition_unmatched_fragments_by_panel`, `detect_text_containers`) and grouped by proximity only. A third fallback path groups the whole page by proximity when no bubble detector output is used.
5. **Observability already exists:** `services/ocr_capture.py` records fragments, detector masks, groups and owner decisions (`OCR_CAPTURE_DIR`) and can replay grouping deterministically. Owner decisions are stored per fragment in `ownershipProvenance.ownerDecision` with a `reason`. `test_fragment_grouping.py` freezes legacy behavior for equivalence tests.
6. The code comments cite hand-annotated measurements (`docs/region_waist_probe_2026-08-09.md`, in the parent repo, not this checkout): distance alone separates same-balloon from cross-balloon pairs barely better than chance; waist clearance does much better.

## 3. Hypotheses for the remaining failures (all *unverified*; rank by evidence, not by this order)

- **H1: Owner veto over-splits.** Any single failing check turns a whole bubble into singletons. Reasons that can fire on legitimate groups: `ambiguous-line-orientation` (all members near-square, e.g. short interjections), `mixed-line-orientation`, `incoherent-oriented-lines` (angle delta > 15 degrees on slightly rotated text), `insufficient-lateral-line-overlap` (< 0.25 between adjacent lines), `line-gap-too-large` (> 2x mean cross-length), `missing-validated-container` / `incomplete-validated-container` (YOLO mask misses or only partly covers the lines; quad inside fraction < 0.75). This matches "everything is detected but nothing converges".
- **H2: Page-wide mean character size on the unmatched and fallback paths.** `group_fragments` computes `avg_width` / `avg_height` over every fragment in the call. On those paths that is the whole page (or panel partition), so a large SFX column inflates the budget for neighbouring dialogue or vice versa. The in-bubble path is per bubble and less exposed.
- **H3: Transitive chaining.** Connected components are unbounded (A-B and B-C adjacent puts A, B, C together). Existing mitigations are area-fraction splitting and the owner veto. The code comment itself names an MST plus adaptive edge cut as the structural fix.
- **H4: Detector coverage.** Free text outside balloons has only proximity grouping; no learned block-level signal is used there.
- **H5: Format mix.** Webtoons (tall strips), manhwa and 4-koma may violate assumptions made for Japanese manga pages (panel detection supports `ttb`, but grouping thresholds and detector training data may not).

## 4. Model landscape (researched; license/behavior claims partly from model cards and mirrors)

- **Current bubble model:** single-class YOLO11n-seg, decoded in `services/bubble_detector.py` with a hard-coded output layout (`[1, 37, 33600]` = 4 box + 1 score + 32 mask coefficients).
- **ShadowB `Manga109-panel-balloon-text-yolov26-segmentation`:** YOLO26s-seg trained on Manga109-derived data, classes `frame`, `text`, `balloon`. Manga-specific, so expect a domain gap on webtoons/manhwa/color. A companion dataset is named "Manga109 Region-Level Text Segmentation", which suggests `text` masks are region-level (block) rather than line-level; *verify by running it*. **Migration risk:** a 3-class export changes the channel layout (4 box + 3 class + 32 coefficients = 39), so the current decoder would silently read the wrong channels. YOLO26 may also export a different output format. *Unverified; inspect the ONNX output shapes.*
- **`mayocream/koharu-yolo26s`:** fine-tune of the ShadowB model with four classes (`frame`, `dialogue_text`, `balloon`, `onomatopoeia_text`); also gives dialogue vs SFX. Its card says use must comply with Manga109, MangaSeg, COO and Ultralytics terms.
- **`ogkalu/comic-text-and-bubble-detector`:** RT-DETR-v2, about 11k images covering manga, webtoon, manhua and western comics; classes `bubble`, `text_bubble`, `text_free`. Broader format coverage, boxes only (no masks), trained at 640. Mirrors list Apache-2.0; verify on the original card. *Coverage of 4-koma is unverified for every model here.*
- **Magi (Sachdeva and Zisserman, CVPR 2024 and follow-ups):** detects panels, text blocks, characters, speakers, reading order. Models are restricted to academic research use. Not recommended as a dependency; its panel-first reading-order idea is the only thing worth borrowing.
- All of these exchange boxes/masks in page-pixel coordinates, so they compose with PP-OCR through geometry; the existing owner assignment already treats detector masks as "validated containers".

## 5. Proposed work, in order

**Step 0: Find which hypothesis is real (no model changes).**
Run the worker with `OCR_CAPTURE_DIR` on 30-50 representative pages across formats (vertical JP manga, webtoon strips, 4-koma, dense pages, pages with SFX). For every fragmented group, record: which path produced it (in-bubble / unmatched / fallback), and for in-bubble paths the owner-veto `reason`. Tabulate reasons. Build a labeled set from the same captures (which fragments belong together) and add a scoring script (exact-group accuracy, over-merge count, under-merge count) that uses the existing deterministic replay.

**Step 1: Fix the dominant cause.** Likely candidates, depending on Step 0:
- H1: relax or reorder owner-veto checks, or make a vetoed component retry at a tighter threshold / split along the weakest edge instead of dropping to singletons; treat near-square members as no evidence rather than `ambiguous`.
- H2: use per-pair local size (e.g. the smaller of the two fragments' character sizes) instead of the page-wide mean on the unmatched and fallback paths.
- H3: replace unbounded BFS components with an MST and an adaptive edge cut (as the code comment proposes).

**Step 2: Detector-proposed text blocks for unmatched text (H4).** Only after Step 1 and only if Step 0 shows unmatched-path failures. Use `text` / `text_free` masks or boxes as additional candidate containers for fragments with no bubble, with the proximity grouping as fallback. Fix the YOLO decoder for the new output layout first, and keep the model optional so the ARM64 path is unaffected.

**Step 3 (only if a residue remains):** a small pairwise classifier on existing features, or a VLM tiebreak on flagged ambiguous clusters.

## 6. Acceptance criteria

- Step 0 deliverables exist: capture set, labels, a reproducible score, and a table of failure causes.
- Exact-group accuracy improves on the labeled set with no increase in over-merging; broken out per format (manga, webtoon, 4-koma).
- `test_fragment_grouping.py` frozen-equivalence behavior is preserved for any default that does not change; new behavior is behind config fields that are off by default until the score justifies flipping them.
- Works on both OCR backends (PaddleOCR on amd64, RapidOCR on ARM64).

## 7. Open questions

1. Is the YOLO model currently in production still the single-class one, and where does the migration stand?
2. Where do the failing pages come from (format mix)? That decides how much H5 matters.
3. What does the parent repo's `docs/region_waist_probe_2026-08-09.md` say about unmatched-path failures?
