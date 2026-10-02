# A07-sample99: region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `885f0d730c5c39a3ac208dad0499d4816a8db344` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample99/A07-region-action-glyph-style-labels.sample99.reviewed.json` and this checkpoint; both are new. No production code, tracker, existing evidence, source, submodule, or commit changed.

Inputs reviewed: exact `corpus/samples/ja/sample99/source.jpg`; `A06-owner-labels.draft.json`; retained `manifest.json`; `a04-exports/sample99/page-snapshot.json`; and the retained project original. The source SHA-256 is `47a74974f97b32ca477046bc971ed2bf2b426d1aa1f6c5fdb244c03940905ac0`, matching A06, manifest, and snapshot image hash. Source-pixel review covered 10 A06 records and 10 snapshot OCR regions.

Action result: all 10 A06 records are represented exactly once, retaining 8 `draft` and 2 `unresolved` states. There are 6 `replace` candidates requiring future glyph support, 2 `preserve` actions for clearly drawn effects, and 2 pixel-preserving `review` actions for the A06 missing-membership/composite cases. All 10 A06 records explicitly supply a final OCR ID and all 10 match snapshot IDs; unavailable final-OCR coverage is 0. No cleanup mask, glyph asset, replacement object, translated layout, font, or implementation authorization was created.

Validation commands and exact results:

```text
sha256sum corpus/samples/ja/sample99/source.jpg
PASS: 47a74974f97b32ca477046bc971ed2bf2b426d1aa1f6c5fdb244c03940905ac0

jq empty docs/quality-runs/a07-20260911-sample99/A07-region-action-glyph-style-labels.sample99.reviewed.json
PASS: valid JSON

jq A06-label/snapshot equality, provenance, final-OCR coverage, and action-count assertions
PASS: 10 A06 label IDs equal 10 packet label IDs; 10 explicit packet OCR IDs equal 10 snapshot OCR IDs; draft=8, unresolved=2, replace=6, preserve=2, review=2, explain=0; unavailable-final-OCR=0

git diff --check --no-index /dev/null <each new file>
PASS: no whitespace errors in either sample99 file
```

Quality-gate result: packet-only source-pixel curation is ready for coordinator review. It does not complete A07, G0, or any later gate.

Remaining uncertainty: r06 and r07 remain review-only because raw membership is absent and their detector extents cannot establish one safe owner. Every `replace` remains only a candidate pending later approval.
