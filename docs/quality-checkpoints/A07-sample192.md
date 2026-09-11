# A07-sample192: Korean region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `885f0d730c5c39a3ac208dad0499d4816a8db344` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample192/A07-region-action-glyph-style-labels.sample192.reviewed.json` and this checkpoint; both are new. No source image, existing evidence, tracker, application, worker, backend, schema, model, source, submodule, or commit changed.

Prerequisites and input artifact hashes: A06-C reviewed source ownership for `sample192` contains 3 reviewed final OCR records, each with an owner, and no blocker. The immutable `corpus/samples/ko/sample192/source.jpg` SHA-256 is `177c5519f413956cdfb028c9465f6e34ac28452b123bf0c5ca84818d60d141db`, matching the A06-C reviewed labels and archived `a04-exports/sample192/page-snapshot.json`. A06-C is the required predecessor; A07 remains an incomplete multi-fixture task.

Current-checkout reproduction: inspected the exact source, retained source overview/region sheets, A06-C reviewed owner labels, and archived page snapshot. The source shows three independent horizontal Korean dialogue labels in separate white bordered balloons. The glyphs are regular near-black, unoutlined lettering; no source-text ambiguity was identified in the inspected labels. Were any reading ambiguous, it would remain `review` with no inferred glyph support, mask, cleanup, or replacement.

GitNexus impact: not applicable. This evidence-only packet changes no production symbol, API, worker, route, source, or submodule; no upstream symbol impact exists.

Implementation decision: curation-only `a07-region-action-glyph-style-labels-reviewed/v1`. Each `replace` is a candidate action, not authorization to alter pixels; later policy approval, glyph support, and validated cleanup remain required. No mask, cleanup provider, font, model, translation, rendering change, or production policy is selected.

Validation commands and results:

```text
jq empty docs/quality-runs/a07-20260911-sample192/A07-region-action-glyph-style-labels.sample192.reviewed.json
PASS: JSON parse

jq -e --slurpfile owners docs/quality-runs/a06-c-20260911-controls/A06-C-owner-labels.controls.reviewed.json '($owners[0].sources[] | select(.sample == "sample192") | .labels) as $owner_labels | ([.labels[].owner_label_id] | sort) == ([$owner_labels[].id] | sort) and ([.labels[].final_ocr_region_id] | sort) == ([$owner_labels[].fragment_member_identity | capture("final OCR region (?<id>[0-9a-f-]+)").id] | sort)' docs/quality-runs/a07-20260911-sample192/A07-region-action-glyph-style-labels.sample192.reviewed.json
PASS: owner-label and A06-C final-OCR-ID equality

jq -e --slurpfile snapshot docs/quality-runs/a06-c-20260911-controls/a04-exports/sample192/page-snapshot.json '([.labels[].final_ocr_region_id] | sort) == ([$snapshot[0].ocrRegions[].id] | sort)' docs/quality-runs/a07-20260911-sample192/A07-region-action-glyph-style-labels.sample192.reviewed.json
PASS: snapshot final-OCR-ID equality

jq -e '(.counts.reviewed_owner_labels == 3) and ([.labels[] | select(.action == "replace")] | length == 3) and ([.labels[] | select(.action == "preserve")] | length == 0) and ([.labels[] | select(.action == "explain")] | length == 0) and ([.labels[] | select(.action == "review")] | length == 0)' docs/quality-runs/a07-20260911-sample192/A07-region-action-glyph-style-labels.sample192.reviewed.json
PASS: declared owner and action counts

sha256sum corpus/samples/ko/sample192/source.jpg
177c5519f413956cdfb028c9465f6e34ac28452b123bf0c5ca84818d60d141db  corpus/samples/ko/sample192/source.jpg
PASS: source digest matches A06-C labels and snapshot image hash

git diff --check
PASS: whitespace validation

Executed: 6 / PASS: 6 / FAIL: 0 / NOT-EXECUTED: 0
```

Before/after metrics and artifact paths: new retained packet `docs/quality-runs/a07-20260911-sample192/A07-region-action-glyph-style-labels.sample192.reviewed.json` covers all 3 reviewed A06-C owner labels exactly once: 3 `replace` candidates requiring glyph support, 0 `preserve`, 0 `explain`, and 0 `review`. No alpha mask, cleanup patch, generated output, or source mutation was added.

Quality-gate result and reviewer: source-pixel curation is ready for coordinator review. This packet adds a Korean horizontal ordinary-balloon control with per-owner protected-context exclusions. It does not pass or complete A07, G0, or any later gate.

Remaining uncertainty or blocker: this fixture has no outlined glyph case and no source-text ambiguity identified during this bounded review. The packet creates no binary glyph support, source-space alpha mask, cleanup patch, font selection, translated layout, or implementation authorization.

Files/worktree that must be preserved: immutable `sample192` source; A06-C sample192 reviewed labels, review sheets, archived snapshot, and exports; this A07 packet; all historical evidence; and any unrelated pre-existing worktree changes.
