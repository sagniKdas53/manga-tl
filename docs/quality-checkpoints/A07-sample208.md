# A07-sample208: ZH region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `885f0d730c5c39a3ac208dad0499d4816a8db344` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample208/A07-region-action-glyph-style-labels.sample208.reviewed.json` and this checkpoint; both are new. No source image, existing evidence, tracker, application, worker, source, submodule, or commit changed.

Prerequisites and input artifact hashes: A06-C reviewed source ownership for `sample208` contains 10 reviewed final OCR records. The immutable `corpus/samples/zh/sample208/source.png` SHA-256 is `eb90fff0ffcc0d2cee63cd6a7b8acb7e5c0ccfb9ac468c9532c0c0ad55ed237e`, matching the A06-C source record and retained A06-C page snapshot image hash. A06-C is the required predecessor; this is one bounded packet and does not complete A07.

Current-checkout reproduction: inspected the exact source, retained A06-C overview and region sheets, reviewed owner labels, and retained `a04-exports/sample208/page-snapshot.json`. All 10 retained records are independent Traditional Chinese dialogue or narration in white bordered balloons and are conservative `replace` candidates requiring future glyph support. No source-outlined, ambiguous, or non-dialogue final OCR record occurs in this fixture.

GitNexus impact: not applicable. This evidence-only packet changes no production symbol, API, worker, route, source, or submodule; no upstream symbol impact exists.

Implementation decision: curation-only `a07-region-action-glyph-style-labels-reviewed/v1`. `replace` remains a candidate action, not permission to alter pixels; future approved glyph support and validated cleanup are required. No mask, cleanup patch, translation, font, model, or production policy is created or selected.

Validation commands and results:

```text
jq empty docs/quality-runs/a07-20260911-sample208/A07-region-action-glyph-style-labels.sample208.reviewed.json
PASS (exit 0): JSON parse

jq -n --slurpfile a07 docs/quality-runs/a07-20260911-sample208/A07-region-action-glyph-style-labels.sample208.reviewed.json --slurpfile owner docs/quality-runs/a06-c-20260911-controls/A06-C-owner-labels.controls.reviewed.json '($owner[0].sources[] | select(.sample == "sample208") | .labels | map({owner_label_id: .id, final_ocr_region_id: (.fragment_member_identity | capture("(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})").id)}) | sort_by(.owner_label_id)) as $expected | (($a07[0].labels | map({owner_label_id, final_ocr_region_id}) | sort_by(.owner_label_id)) == $expected)'
PASS (exit 0; true): A07 owner-label/final-OCR-ID pairs equal the A06-C sample208 pairs exactly once

jq -n --slurpfile a07 docs/quality-runs/a07-20260911-sample208/A07-region-action-glyph-style-labels.sample208.reviewed.json --slurpfile snapshot docs/quality-runs/a06-c-20260911-controls/a04-exports/sample208/page-snapshot.json '([$a07[0].labels[].final_ocr_region_id] | sort) == ([$snapshot[0].ocrRegions[].id] | sort)'
PASS (exit 0; true): A07 final OCR IDs equal retained snapshot OCR IDs

sha256sum corpus/samples/zh/sample208/source.png
PASS (exit 0): eb90fff0ffcc0d2cee63cd6a7b8acb7e5c0ccfb9ac468c9532c0c0ad55ed237e  corpus/samples/zh/sample208/source.png

jq -e '([.labels[].final_ocr_region_id] | length == 10 and (unique | length == 10)) and ([.labels[] | select(.action == "replace")] | length == 10) and ([.labels[] | select(.action == "preserve")] | length == 0) and ([.labels[] | select(.action == "review")] | length == 0) and .counts.replace_candidate == 10 and .counts.preserve == 0 and .counts.review == 0' docs/quality-runs/a07-20260911-sample208/A07-region-action-glyph-style-labels.sample208.reviewed.json
PASS (exit 0; true): complete unique coverage and declared action counts

git diff --check
PASS (exit 0): no whitespace errors
```

Before/after metrics and artifact paths: new retained packet `docs/quality-runs/a07-20260911-sample208/A07-region-action-glyph-style-labels.sample208.reviewed.json` covers all 10 A06-C labels exactly once: 10 `replace` candidates requiring future glyph support, 0 `preserve`, and 0 `review`. No alpha mask, cleanup asset, generated output, or implementation change was added.

Quality-gate result and reviewer: source-pixel curation is ready for coordinator review. This packet adds a ZH color-scene ordinary-balloon control and per-owner protected-context exclusions. It does not pass or complete A07, G0, or any later gate.

Remaining uncertainty or blocker: no binary glyph support, source-space alpha mask, cleanup patch, font selection, or translated layout exists. The packet does not authorize pixel changes.

Files/worktree that must be preserved: immutable `sample208` source; A06-C reviewed owner labels, review sheets, page snapshot, and retained exports; this A07 packet; all historical evidence; existing tracker; and the worker submodule state.
