# A07-sample150: outlined glyph, region actions, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `1384fc6be541fb4a7f89abd67c0068b8805c90ec` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample150/A07-region-action-glyph-style-labels.sample150.reviewed.json` and this checkpoint; both are new. No source image, baseline artifact, application, worker, backend, schema, model, or submodule changed.

Prerequisites and input artifact hashes: A06-C reviewed source ownership for `sample150` is complete: 10 reviewed final OCR records and zero blockers. The immutable `corpus/samples/ja/sample150/source.jpg` SHA-256 is `5e49a2a275e8abe9251404c277ce6d6ded88e0b81a043e9a923b002cfd49d92d`, matching the A06-C reviewed label set and fresh page snapshot. `sample150` is a selected colored four-panel JA control tagged `outlined_dialogue`.

Current-checkout reproduction (command, observed result): inspected the exact source, retained source overview/region sheets, A06-C reviewed owner labels, and fresh `page-snapshot.json`. Eight independent vertical Japanese dialogue balloons are safe replace candidates. The horizontal free-standing page title is `explain` only. Large vertical outlined text in the final panel is a reviewed non-dialogue owner over a radiating graphic between protected character faces; it is `review`, not a cleanup target.

GitNexus impact (repo, symbols, callers/processes, risk, freshness): not applicable. This evidence-only packet changes no production symbol, API, worker, route, source, or submodule; therefore no upstream symbol impact exists.

Implementation decision and schema/config/model/font versions: curation-only `a07-region-action-glyph-style-labels-reviewed/v1`. The r005 source style distinguishes white glyph fill and heavy black outline from nearby art, but provides no mask. Its `review` action preserves pixels and denies automatic cleanup/text. `explain` for the page title is note-only. No font, model, cleanup provider, or production policy was selected.

Validation commands and executed/pass/fail/not-executed counts:

```text
sha256sum corpus/samples/ja/sample150/source.jpg
jq -e '.sources[] | select(.sample == "sample150") | .final_ocr_region_count == 10' A06-C-owner-labels.controls.reviewed.json
PASS: source identity and A06-C prerequisite / FAIL: 0 / NOT-EXECUTED: 0

jq empty A07-region-action-glyph-style-labels.sample150.reviewed.json
jq -e '([.labels[].final_ocr_region_id] | length == 10 and (unique | length == 10)) and ([.labels[] | select(.action == "replace")] | length == 8) and ([.labels[] | select(.action == "explain")] | length == 1) and ([.labels[] | select(.action == "review")] | length == 1) and .counts.outlined_glyph_review_case == 1' A07-region-action-glyph-style-labels.sample150.reviewed.json
PASS: JSON syntax, complete unique final-region coverage, action counts, and outlined-glyph review case / FAIL: 0 / NOT-EXECUTED: 0

git diff --check
PASS: whitespace validation / FAIL: 0 / NOT-EXECUTED: 0
```

Before/after metrics and artifact paths: new retained packet `docs/quality-runs/a07-20260911-sample150/A07-region-action-glyph-style-labels.sample150.reviewed.json` covers all 10 reviewed final OCR records: 8 replace candidates, 1 explain-only page title, and 1 protected outlined-glyph review case. No alpha mask, patch, or generated output was added.

Quality-gate result and reviewer: source-pixel curation is ready for coordinator review. This packet adds a colored JA four-panel ordinary-balloon control, protected-art exclusions, explain-only semantics, and the first reviewed outlined-glyph case. It does not pass A07, G0, or any later gate; KO/ZH labels and further source-style cases remain required.

Remaining uncertainty or blocker: r005 remains intentionally unresolved as a policy `review` item. It cannot become a mask/cleanup experiment until its lettering and adjacent art are separately measured under G01. The packet creates no binary support, cleanup asset, replacement object, font selection, or style measurement.

Exact next command and expected result: select a KO conventional control with a distinct source style, recheck its A06-C owner labels and source digest, then save a separate `A07-<fixture>` annotation packet. Preserve any uncertain region as `review` rather than inferring a replace action.

Files/worktree that must be preserved: the immutable `sample150` source; A06-C sample150 reviewed labels, review sheets, page snapshot, and fresh exports; this A07 packet; all historical A01-A06-C evidence; and the committed tracker/A07-sample7 records.
