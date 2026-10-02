# A07-sample222: evidence-only region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `885f0d730c5c39a3ac208dad0499d4816a8db344` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample222/A07-region-action-glyph-style-labels.sample222.reviewed.json` and this checkpoint; both are new. No production code, tracker, prior evidence, source, submodule, or commit changed.

Source-pixel review: inspected immutable `corpus/samples/ja/sample222/source.png`, retained A06 labels, manifest, and exact snapshot. The one A06 record remains `unresolved`: its sole final OCR region is a fused page-scale composite over independent cover typography, headers, and artwork. The record is pixel-preserving `review` only.

Final OCR coverage: snapshot has 1 region; the 1 A06-explicit final OCR ID matches it. The ID documents the fused extent only and is not a segmentation or cleanup boundary.

GitNexus impact: not applicable. This evidence-only packet changes no production symbol, API, worker, route, source, or submodule.

Validation results:

```text
jq empty docs/quality-runs/a07-20260911-sample222/A07-region-action-glyph-style-labels.sample222.reviewed.json
PASS (exit 0)

sha256sum corpus/samples/ja/sample222/source.png
990b1c3b2032e628d4aa6f737d539dd39ae325771369651a3b7c975bbb594738  corpus/samples/ja/sample222/source.png

Input A06 label equality: PASS
Applicable explicit snapshot-ID equality: PASS (1 of 1)
git diff --check: PASS
```

Limitations: no segmentation, source membership, glyph-only support, cleanup mask, replacement text, font, or implementation authorization exists. This child packet does not complete A07.
