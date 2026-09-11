# A07-sample172: region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `885f0d730c5c39a3ac208dad0499d4816a8db344` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample172/A07-region-action-glyph-style-labels.sample172.reviewed.json` and this checkpoint; both are new. No source image, review sheet, snapshot, application, worker, backend, schema, model, tracker, or submodule changed.

Prerequisites and input artifact hashes: A06-C reviewed source ownership for `sample172` is complete: 11 reviewed final OCR records. The immutable `corpus/samples/ja/sample172/source.jpeg` SHA-256 is `0c579dfaabb65bae96b7f69e1645fd747bd4c25954769152a0601a97a79659a1`, matching both the A06-C reviewed label set and `a04-exports/sample172/page-snapshot.json` image hash.

Current-checkout reproduction: inspected the exact source, retained overview/region sheets, A06-C reviewed owner labels, and the exact page snapshot. Seven independent white-balloon dialogue owners and two bounded white panel-caption owners are replace candidates. Two drawn chewing effects over character art are preserve-only; neither authorizes cleanup.

GitNexus impact: not applicable. This evidence-only packet changes no production symbol, API, worker, route, source, or submodule; therefore no upstream symbol impact exists.

Implementation decision: curation-only `a07-region-action-glyph-style-labels-reviewed/v1`. `replace` is a candidate action, not permission to alter pixels. `preserve` retains source pixels and forbids automatic cleanup and replacement text. No mask, cleanup provider, font, reconstruction method, or production policy was selected.

Validation commands and exact results:

```text
sha256sum corpus/samples/ja/sample172/source.jpeg
0c579dfaabb65bae96b7f69e1645fd747bd4c25954769152a0601a97a79659a1  corpus/samples/ja/sample172/source.jpeg

jq -e --slurpfile snapshot docs/quality-runs/a06-c-20260911-controls/a04-exports/sample172/page-snapshot.json '.source.source_digest == $snapshot[0].image.hash' docs/quality-runs/a07-20260911-sample172/A07-region-action-glyph-style-labels.sample172.reviewed.json
true

jq empty docs/quality-runs/a07-20260911-sample172/A07-region-action-glyph-style-labels.sample172.reviewed.json
PASS (exit 0; no output)

jq -e --slurpfile owners docs/quality-runs/a06-c-20260911-controls/A06-C-owner-labels.controls.reviewed.json --slurpfile snapshot docs/quality-runs/a06-c-20260911-controls/a04-exports/sample172/page-snapshot.json '([.labels[].owner_label_id] | sort) == ([$owners[0].sources[] | select(.sample == "sample172") | .labels[].id] | sort) and ([.labels[].final_ocr_region_id] | sort) == ([$owners[0].sources[] | select(.sample == "sample172") | .labels[].fragment_member_identity | capture("final OCR region (?<id>[0-9a-f-]+);").id] | sort) and ([.labels[].final_ocr_region_id] | sort) == ([$snapshot[0].ocrRegions[].id] | sort)' docs/quality-runs/a07-20260911-sample172/A07-region-action-glyph-style-labels.sample172.reviewed.json
true

jq -e '([.labels | length == 11] and ([.labels[].owner_label_id] | unique | length == 11) and ([.labels[].final_ocr_region_id] | unique | length == 11) and ([.labels[] | select(.action == "replace")] | length == 9) and ([.labels[] | select(.action == "preserve")] | length == 2) and ([.labels[] | select(.action == "review")] | length == 0) and .counts.replace_with_required_glyph_support == 9)' docs/quality-runs/a07-20260911-sample172/A07-region-action-glyph-style-labels.sample172.reviewed.json
true

git diff --check
PASS (exit 0; no output)
```

Before/after metrics and artifact paths: new retained packet `docs/quality-runs/a07-20260911-sample172/A07-region-action-glyph-style-labels.sample172.reviewed.json` covers all 11 reviewed final OCR records: 9 `replace` candidates requiring future glyph support and 2 `preserve` decisions. No alpha mask, cleanup patch, generated output, or source mutation was added.

Quality-gate result and reviewer: source-pixel curation is ready for coordinator review. This bounded packet provides a colored JA four-panel ordinary-balloon and caption-field control, preserve-only drawn-effect cases, and per-owner protected-context exclusions. It does not complete A07, G0, or any later gate.

Remaining uncertainty or blocker: no binary glyph support, source-space alpha mask, cleanup patch, font selection, translated layout, or implementation authorization exists. The preserved records cannot be used to infer cleanup.

Files/worktree that must be preserved: the immutable `sample172` source; A06-C reviewed labels, review sheets, and snapshot; this A07 packet; all historical evidence; the tracker; and pre-existing user worktree changes.
