# A07-sample612: ZH region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `885f0d730c5c39a3ac208dad0499d4816a8db344` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample612/A07-region-action-glyph-style-labels.sample612.reviewed.json` and this checkpoint; both are new. No source image, tracker, existing evidence, root or run-level snapshot, application, worker, schema, model, submodule, or commit changed.

Prerequisites and input artifact hashes: A06-C reviewed source ownership for `sample612` is complete: 8 reviewed final OCR records and zero blockers. The immutable `corpus/gaps/pending/zh/sample612/source.jpg` SHA-256 is `4cce048893f940d5826085cad8b2dfb0dc7cbb33dc20a75d917c7a5c0d6b17b1`, matching the A06-C reviewed label set and retained A06-C `a04-exports/sample612/page-snapshot.json` image hash. A06-C is the required predecessor; this is one bounded packet and does not complete A07.

Current-checkout reproduction: inspected the exact source, retained source overview/region sheets, A06-C reviewed owner labels, and retained A06-C page snapshot. Six final OCR records are independent vertical Traditional Chinese dialogue extents in white bordered balloons and are conservative `replace` candidates. A small drawn emotive mark and page-edge creator credit are non-dialogue `preserve` records; neither is a cleanup target.

GitNexus impact: not applicable. This evidence-only packet changes no production symbol, API, worker, route, source, or submodule; no upstream symbol impact exists.

Implementation decision: curation-only `a07-region-action-glyph-style-labels-reviewed/v1`. `replace` remains a candidate action, not permission to alter pixels; future approved glyph support and validated cleanup are required. `preserve` denies automatic cleanup and replacement text. No mask, cleanup patch, translation, font, model, or production policy is created or selected.

Validation commands and results:

```text
jq empty docs/quality-runs/a07-20260911-sample612/A07-region-action-glyph-style-labels.sample612.reviewed.json
PASS (exit 0): JSON parse

jq -n --slurpfile a07 docs/quality-runs/a07-20260911-sample612/A07-region-action-glyph-style-labels.sample612.reviewed.json --slurpfile owner docs/quality-runs/a06-c-20260911-controls/A06-C-owner-labels.controls.reviewed.json '($owner[0].sources[] | select(.sample == "sample612") | .labels | map({owner_label_id: .id, final_ocr_region_id: (.fragment_member_identity | capture("final OCR region (?<id>[0-9a-f-]+);").id)}) | sort_by(.owner_label_id)) as $expected | ($a07[0].labels | map({owner_label_id, final_ocr_region_id}) | sort_by(.owner_label_id)) == $expected'
PASS (exit 0; true): A07 owner-label/final-OCR-ID pairs equal the A06-C sample612 pairs

jq -n --slurpfile a07 docs/quality-runs/a07-20260911-sample612/A07-region-action-glyph-style-labels.sample612.reviewed.json --slurpfile snapshot docs/quality-runs/a06-c-20260911-controls/a04-exports/sample612/page-snapshot.json '([$a07[0].labels[].final_ocr_region_id] | sort) == ([$snapshot[0].ocrRegions[].id] | sort)'
PASS (exit 0; true): A07 final OCR IDs equal retained snapshot OCR IDs

jq -e '([.labels[].final_ocr_region_id] | length == 8 and (unique | length == 8)) and ([.labels[] | select(.action == "replace")] | length == 6) and ([.labels[] | select(.action == "preserve")] | length == 2) and .counts.reviewed_owner_labels == 8 and .counts.replace_candidate == 6 and .counts.preserve == 2 and .counts.explain == 0 and .counts.review == 0' docs/quality-runs/a07-20260911-sample612/A07-region-action-glyph-style-labels.sample612.reviewed.json
PASS (exit 0; true): complete unique coverage and declared action counts

sha256sum corpus/gaps/pending/zh/sample612/source.jpg
PASS (exit 0): 4cce048893f940d5826085cad8b2dfb0dc7cbb33dc20a75d917c7a5c0d6b17b1  corpus/gaps/pending/zh/sample612/source.jpg

git diff --check
PASS (exit 0; no output): no whitespace errors
```

Before/after metrics and artifact paths: new retained packet `docs/quality-runs/a07-20260911-sample612/A07-region-action-glyph-style-labels.sample612.reviewed.json` covers all 8 reviewed A06-C owner labels exactly once: 6 `replace` candidates requiring future glyph support and 2 `preserve` decisions. No alpha mask, cleanup asset, generated output, or implementation change was added.

Quality-gate result and reviewer: source-pixel curation is ready for coordinator review. The packet adds a ZH color-webcomic ordinary-balloon control, protected non-dialogue cases, and per-owner protected-context exclusions. It does not pass or complete A07, G0, or any later gate.

Remaining uncertainty or blocker: no binary glyph support, source-space alpha mask, cleanup patch, font selection, or translated layout exists. Image content outside the eight retained final OCR IDs receives no inferred action.

Files/worktree that must be preserved: immutable `sample612` source; A06-C reviewed owner labels, review sheets, page snapshot, and retained exports; this A07 packet; all historical A01-A06-C evidence; existing tracker; and the worker submodule state.
