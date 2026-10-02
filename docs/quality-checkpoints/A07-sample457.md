# A07-sample457: ZH region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `885f0d730c5c39a3ac208dad0499d4816a8db344` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample457/A07-region-action-glyph-style-labels.sample457.reviewed.json` and this checkpoint; both are new. No source image, tracker, existing evidence, root or run-level snapshot, application, worker, schema, model, submodule, or commit changed.

Prerequisites and input artifact hashes: A06-C reviewed source ownership for `sample457` is complete: 7 reviewed final OCR records and zero blockers. The immutable `corpus/gaps/pending/zh/sample457/source.jpg` SHA-256 is `9d780c60ab7ba834e8e95f33cb69bb8d477a8d0ce2b4d0823e114937faff4776`, matching the A06-C reviewed label set and retained A06-C `a04-exports/sample457/page-snapshot.json` image hash. A06-C is the required predecessor; this is one bounded packet and does not complete A07.

Current-checkout reproduction: inspected the exact source, retained source overview/region sheets, A06-C reviewed owner labels, and retained A06-C page snapshot. Three bounded white-container narration/dialogue records are conservative `replace` candidates. Creator attribution and a jacket glyph are `preserve`. The two free-standing white-fill, black-outline captions over colored panel art are `review`: review preserves source pixels and authorizes neither cleanup nor replacement text.

GitNexus impact: not applicable. This evidence-only packet changes no production symbol, API, worker, route, source, or submodule; no upstream symbol impact exists.

Implementation decision: curation-only `a07-region-action-glyph-style-labels-reviewed/v1`. `replace` remains a candidate action, not permission to alter pixels; future approved glyph support and validated cleanup are required. `preserve` denies automatic cleanup and replacement text. `review` preserves pixels and creates no automatic cleanup or replacement text until a later explicit decision. No mask, cleanup patch, translation, font, model, or production policy is created or selected.

Validation commands and results:

```text
jq empty docs/quality-runs/a07-20260911-sample457/A07-region-action-glyph-style-labels.sample457.reviewed.json
PASS (exit 0): JSON parse

jq -n --slurpfile a07 docs/quality-runs/a07-20260911-sample457/A07-region-action-glyph-style-labels.sample457.reviewed.json --slurpfile owner docs/quality-runs/a06-c-20260911-controls/A06-C-owner-labels.controls.reviewed.json '($owner[0].sources[] | select(.sample == "sample457") | .labels | map({owner_label_id: .id, final_ocr_region_id: (.fragment_member_identity | capture("final OCR region (?<id>[0-9a-f-]+);").id)}) | sort_by(.owner_label_id)) as $expected | ($a07[0].labels | map({owner_label_id, final_ocr_region_id}) | sort_by(.owner_label_id)) == $expected'
PASS (exit 0; true): A07 owner-label/final-OCR-ID pairs equal the A06-C sample457 pairs

jq -n --slurpfile a07 docs/quality-runs/a07-20260911-sample457/A07-region-action-glyph-style-labels.sample457.reviewed.json --slurpfile snapshot docs/quality-runs/a06-c-20260911-controls/a04-exports/sample457/page-snapshot.json '([$a07[0].labels[].final_ocr_region_id] | sort) == ([$snapshot[0].ocrRegions[].id] | sort)'
PASS (exit 0; true): A07 final OCR IDs equal retained snapshot OCR IDs

jq -e '([.labels[].final_ocr_region_id] | length == 7 and (unique | length == 7)) and ([.labels[] | select(.action == "replace")] | length == 3) and ([.labels[] | select(.action == "preserve")] | length == 2) and ([.labels[] | select(.action == "review")] | length == 2) and .counts.reviewed_owner_labels == 7 and .counts.replace_candidate == 3 and .counts.preserve == 2 and .counts.explain == 0 and .counts.review == 2 and .counts.outlined_glyph_review_case == 2' docs/quality-runs/a07-20260911-sample457/A07-region-action-glyph-style-labels.sample457.reviewed.json
PASS (exit 0; true): complete unique coverage and declared action/style counts

sha256sum corpus/gaps/pending/zh/sample457/source.jpg
PASS (exit 0): 9d780c60ab7ba834e8e95f33cb69bb8d477a8d0ce2b4d0823e114937faff4776  corpus/gaps/pending/zh/sample457/source.jpg

git diff --check
PASS (exit 0; no output): no whitespace errors
```

Before/after metrics and artifact paths: new retained packet `docs/quality-runs/a07-20260911-sample457/A07-region-action-glyph-style-labels.sample457.reviewed.json` covers all 7 reviewed A06-C owner labels exactly once: 3 `replace` candidates requiring future glyph support, 2 `preserve` decisions, and 2 outlined-caption `review` decisions. No alpha mask, cleanup asset, generated output, or implementation change was added.

Quality-gate result and reviewer: source-pixel curation is ready for coordinator review. The packet adds a ZH color-webcomic ordinary-balloon control, preserved non-dialogue cases, and protected free-standing outlined-caption review cases. It does not pass or complete A07, G0, or any later gate.

Remaining uncertainty or blocker: r003 and r004 remain intentionally unresolved. No binary glyph support, source-space alpha mask, cleanup patch, font selection, or translated layout exists. Image content outside the seven retained final OCR IDs receives no inferred action.

Files/worktree that must be preserved: immutable `sample457` source; A06-C reviewed owner labels, review sheets, page snapshot, and retained exports; this A07 packet; all historical A01-A06-C evidence; existing tracker; and the worker submodule state.
