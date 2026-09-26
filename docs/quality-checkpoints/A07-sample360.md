# A07-sample360: region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `885f0d730c5c39a3ac208dad0499d4816a8db344` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample360/A07-region-action-glyph-style-labels.sample360.reviewed.json` and this checkpoint; both are new. No source image, A06-C input, A04 snapshot, production code, tracker, existing evidence, submodule, or commit changed.

Prerequisites and input artifact hashes: A06-C reviewed source ownership for `sample360` contains 9 final OCR records. The immutable `corpus/gaps/pending/ko/sample360/source.jpg` SHA-256 is `a816bf10406ba91e1e2bdc00d6544de56d185257dc0fc2c9a15783d7c8caf14a`, matching the A06-C control record and A04 snapshot source. A06-C and the retained source overview/region sheets were inspected before this bounded packet.

Current-checkout reproduction: inspected the exact Korean black-and-white source, its A06-C owner records, source overview/region sheets, and `a04-exports/sample360/page-snapshot.json`. Seven independent locally bounded dialogue owners are replace candidates. The free-standing title r001 is explain-only. Unboxed lettering r003 over halftone and adjacent face/hair art is `review`: it preserves pixels and cannot authorize cleanup.

GitNexus impact: not applicable. This evidence-only packet changes no production symbol, API, worker, route, source, or submodule; no upstream symbol impact exists.

Implementation decision: curation-only `a07-region-action-glyph-style-labels-reviewed/v1`. `replace` remains a candidate action requiring later approved glyph support and validated cleanup. `review` preserves source pixels and permits neither cleanup nor replacement text. No mask, cleanup patch, font, model, provider, or production policy was selected.

Validation commands and exact results:

```text
sha256sum corpus/gaps/pending/ko/sample360/source.jpg
PASS: a816bf10406ba91e1e2bdc00d6544de56d185257dc0fc2c9a15783d7c8caf14a  corpus/gaps/pending/ko/sample360/source.jpg

jq empty docs/quality-runs/a07-20260911-sample360/A07-region-action-glyph-style-labels.sample360.reviewed.json
jq -e --slurpfile a06 docs/quality-runs/a06-c-20260911-controls/A06-C-owner-labels.controls.reviewed.json --slurpfile packet docs/quality-runs/a07-20260911-sample360/A07-region-action-glyph-style-labels.sample360.reviewed.json '($a06[0].sources[] | select(.sample == "sample360") | [.labels[].id] | sort) == ([$packet[0].labels[].owner_label_id] | sort)'
jq -e --slurpfile snapshot docs/quality-runs/a06-c-20260911-controls/a04-exports/sample360/page-snapshot.json --slurpfile packet docs/quality-runs/a07-20260911-sample360/A07-region-action-glyph-style-labels.sample360.reviewed.json '([$snapshot[0].ocrRegions[].id] | sort) == ([$packet[0].labels[].final_ocr_region_id] | sort)'
jq -e '([.labels[].final_ocr_region_id] | length == 9 and (unique | length == 9)) and ([.labels[] | select(.action == "replace")] | length == 7) and ([.labels[] | select(.action == "explain")] | length == 1) and ([.labels[] | select(.action == "review")] | length == 1) and .counts.unboxed_lettering_review_case == 1' docs/quality-runs/a07-20260911-sample360/A07-region-action-glyph-style-labels.sample360.reviewed.json
PASS: JSON syntax, A06 owner equality, A04 snapshot equality, unique coverage, and declared action counts / FAIL: 0 / NOT-EXECUTED: 0

git diff --check -- docs/quality-runs/a07-20260911-sample360/A07-region-action-glyph-style-labels.sample360.reviewed.json docs/quality-checkpoints/A07-sample360.md
git diff --check --no-index /dev/null docs/quality-runs/a07-20260911-sample360/A07-region-action-glyph-style-labels.sample360.reviewed.json
git diff --check --no-index /dev/null docs/quality-checkpoints/A07-sample360.md
PASS: no whitespace diagnostics; the two no-index commands return 1 only because each inspected path is newly added / FAIL: 0 / NOT-EXECUTED: 0
```

Before/after metrics and artifact paths: new retained packet `docs/quality-runs/a07-20260911-sample360/A07-region-action-glyph-style-labels.sample360.reviewed.json` covers all 9 reviewed final OCR records: 7 `replace` candidates requiring glyph support, 1 `explain`, and 1 pixel-preserving `review`. No alpha mask, patch, generated output, or source-pixel alteration was added.

Quality-gate result and reviewer: source-pixel curation is ready for coordinator review. This packet contributes Korean ordinary-balloon, title-policy, unboxed-lettering review, and protected-art evidence. It does not pass A07, G0, or any later gate.

Remaining uncertainty or blocker: r003 is intentionally unresolved. It must remain `review` until later measurement separates lettering from halftone and adjacent protected art; this packet cannot authorize cleanup.
