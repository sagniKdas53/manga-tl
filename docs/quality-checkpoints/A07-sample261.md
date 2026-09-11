# A07-sample261: ZH region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `885f0d730c5c39a3ac208dad0499d4816a8db344` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample261/A07-region-action-glyph-style-labels.sample261.reviewed.json` and this checkpoint; both are new. No source image, existing evidence, tracker, application, worker, source, submodule, or commit changed.

Prerequisites and input artifact hashes: A06-C reviewed source ownership for `sample261` contains 12 reviewed final OCR records. The immutable `corpus/samples/zh/sample261/source.png` SHA-256 is `ff8c69ff142d3d09f7473c3e2a4d532ec6d5a0d25eaff99e44dfde2c2aec14d3`, matching the A06-C source record and retained A06-C page snapshot image hash. A06-C is the required predecessor; this is one bounded packet and does not complete A07.

Current-checkout reproduction: inspected the exact source, retained A06-C overview and region sheets, reviewed owner labels, and retained `a04-exports/sample261/page-snapshot.json`. Ten independent Traditional Chinese dialogue owners in white or grey bordered balloons are conservative `replace` candidates. The small reaction-punctuation record has an OCR/source mismatch, so `review` preserves its pixels and authorizes neither cleanup nor replacement text. The A06-C non-dialogue decorative expression mark is `preserve`.

GitNexus impact: not applicable. This evidence-only packet changes no production symbol, API, worker, route, source, or submodule; no upstream symbol impact exists.

Implementation decision: curation-only `a07-region-action-glyph-style-labels-reviewed/v1`. `replace` remains a candidate action, not permission to alter pixels; future approved glyph support and validated cleanup are required. `review` preserves pixels and creates no automatic cleanup or replacement text. `preserve` denies automatic cleanup and replacement text. No mask, cleanup patch, translation, font, model, or production policy is created or selected.

Validation commands and results:

```text
jq empty docs/quality-runs/a07-20260911-sample261/A07-region-action-glyph-style-labels.sample261.reviewed.json
PASS (exit 0): JSON parse

jq -n --slurpfile a07 docs/quality-runs/a07-20260911-sample261/A07-region-action-glyph-style-labels.sample261.reviewed.json --slurpfile owner docs/quality-runs/a06-c-20260911-controls/A06-C-owner-labels.controls.reviewed.json '($owner[0].sources[] | select(.sample == "sample261") | .labels | map({owner_label_id: .id, final_ocr_region_id: (.fragment_member_identity | capture("(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})").id)}) | sort_by(.owner_label_id)) as $expected | (($a07[0].labels | map({owner_label_id, final_ocr_region_id}) | sort_by(.owner_label_id)) == $expected)'
PASS (exit 0; true): A07 owner-label/final-OCR-ID pairs equal the A06-C sample261 pairs exactly once

jq -n --slurpfile a07 docs/quality-runs/a07-20260911-sample261/A07-region-action-glyph-style-labels.sample261.reviewed.json --slurpfile snapshot docs/quality-runs/a06-c-20260911-controls/a04-exports/sample261/page-snapshot.json '([$a07[0].labels[].final_ocr_region_id] | sort) == ([$snapshot[0].ocrRegions[].id] | sort)'
PASS (exit 0; true): A07 final OCR IDs equal retained snapshot OCR IDs

sha256sum corpus/samples/zh/sample261/source.png
PASS (exit 0): ff8c69ff142d3d09f7473c3e2a4d532ec6d5a0d25eaff99e44dfde2c2aec14d3  corpus/samples/zh/sample261/source.png

jq -e '([.labels[].final_ocr_region_id] | length == 12 and (unique | length == 12)) and ([.labels[] | select(.action == "replace")] | length == 10) and ([.labels[] | select(.action == "preserve")] | length == 1) and ([.labels[] | select(.action == "review")] | length == 1) and .counts.replace_candidate == 10 and .counts.preserve == 1 and .counts.review == 1' docs/quality-runs/a07-20260911-sample261/A07-region-action-glyph-style-labels.sample261.reviewed.json
PASS (exit 0; true): complete unique coverage and declared action counts

git diff --check
PASS (exit 0): no whitespace errors
```

Before/after metrics and artifact paths: new retained packet `docs/quality-runs/a07-20260911-sample261/A07-region-action-glyph-style-labels.sample261.reviewed.json` covers all 12 A06-C labels exactly once: 10 `replace` candidates requiring future glyph support, 1 `preserve`, and 1 pixel-preserving `review`. No alpha mask, cleanup asset, generated output, or implementation change was added.

Quality-gate result and reviewer: source-pixel curation is ready for coordinator review. This packet adds a ZH B&W ordinary-balloon control, a preserved non-dialogue mark, a review-only reaction case, and per-owner protected-context exclusions. It does not pass or complete A07, G0, or any later gate.

Remaining uncertainty or blocker: the r002 reaction punctuation remains intentionally unresolved as a policy `review` item. It cannot become a mask or cleanup experiment until a later explicit decision. No binary glyph support, source-space alpha mask, cleanup patch, font selection, or translated layout exists.

Files/worktree that must be preserved: immutable `sample261` source; A06-C reviewed owner labels, review sheets, page snapshot, and retained exports; this A07 packet; all historical evidence; existing tracker; and the worker submodule state.
