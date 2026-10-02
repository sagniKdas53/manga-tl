# A07-sample199: region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `885f0d730c5c39a3ac208dad0499d4816a8db344` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Packet files created by this task: `docs/quality-runs/a07-20260911-sample199/A07-region-action-glyph-style-labels.sample199.reviewed.json` and this checkpoint; both are new. No production code, tracker, existing evidence, source, submodule, or commit was changed by this packet.

Prerequisites and input artifact hashes: A06-C reviewed source ownership for `sample199` contains 4 reviewed final OCR records. The immutable `corpus/samples/ko/sample199/source.png` SHA-256 is `b9dcc5435eddb9087656cc8714106fd1160186acd7f495e262cad63f948e2478`, matching the A06-C source record and `a04-exports/sample199/page-snapshot.json` image hash.

Current-checkout reproduction: inspected the exact source, retained A06-C overview and region sheets, reviewed owner labels, and page snapshot. Three owners are ordinary white-balloon Korean dialogue. The remaining owner is a printed package label held by a character, retained as `review`; review preserves pixels and cannot authorize cleanup.

GitNexus impact: not applicable. This evidence-only packet changes no production symbol, route, API, worker, source, or submodule.

Implementation decision: curation-only `a07-region-action-glyph-style-labels-reviewed/v1`. `replace` is a candidate action only and needs future approved glyph support and validated cleanup. No mask, cleanup asset, replacement text, font, model, or production policy was selected.

Validation commands and exact results:

```text
sha256sum corpus/samples/ko/sample199/source.png
jq empty docs/quality-runs/a07-20260911-sample199/A07-region-action-glyph-style-labels.sample199.reviewed.json
jq -e --arg sample sample199 --slurpfile owners docs/quality-runs/a06-c-20260911-controls/A06-C-owner-labels.controls.reviewed.json --slurpfile snapshot docs/quality-runs/a06-c-20260911-controls/a04-exports/sample199/page-snapshot.json '($owners[0].sources[] | select(.sample == $sample) | [.labels[].id] | sort) as $owner_ids | ($owners[0].sources[] | select(.sample == $sample) | [.labels[].fragment_member_identity | capture("final OCR region (?<id>[0-9a-f-]+);").id] | sort) as $snapshot_ids | ([.labels[].owner_label_id] | sort) == $owner_ids and ([.labels[].final_ocr_region_id] | sort) == $snapshot_ids and ([.labels[].final_ocr_region_id] | sort) == ($snapshot[0].ocrRegions | [.[] | .id] | sort) and (([.labels[].final_ocr_region_id] | length) == 4 and ([.labels[].final_ocr_region_id] | unique | length) == 4) and ([.labels[] | select(.action == "replace")] | length == 3) and ([.labels[] | select(.action == "review")] | length == 1)' docs/quality-runs/a07-20260911-sample199/A07-region-action-glyph-style-labels.sample199.reviewed.json
git diff --check
PASS: digest, JSON syntax, owner equality, snapshot equality, unique coverage, action counts, and diff check / FAIL: 0 / NOT-EXECUTED: 0
```

Before/after metrics and artifact paths: new packet `docs/quality-runs/a07-20260911-sample199/A07-region-action-glyph-style-labels.sample199.reviewed.json` covers all 4 owners: 3 `replace` candidates with future glyph support and 1 pixel-preserving `review` package label.

Quality-gate result: source-pixel curation is ready for coordinator review. This bounded KO packet does not pass or complete A07, G0, or any later gate.

Remaining uncertainty or blocker: r001 cannot become a cleanup or mask experiment without a later explicit package-label policy and measured support. No binary support, alpha mask, cleanup patch, font selection, or translated layout was created.
