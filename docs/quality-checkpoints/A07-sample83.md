# A07-sample83: region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `885f0d730c5c39a3ac208dad0499d4816a8db344` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample83/A07-region-action-glyph-style-labels.sample83.reviewed.json` and this checkpoint; both are new. No production code, tracker, existing evidence, source, submodule, or commit changed.

Inputs reviewed: exact `corpus/samples/ja/sample83/source.jpg`; `A06-owner-labels.draft.json`; retained `manifest.json`; `a04-exports/sample83/page-snapshot.json`; and the retained project original. The source SHA-256 is `508d4269d36317c7e38f263b84398fdf10ad36d2c1441097969cf8e0cff0e8ab`, matching A06, manifest, and snapshot image hash. Source-pixel review covered 3 A06 records and 3 snapshot OCR regions.

Action result: all 3 A06 records are represented exactly once, retaining 2 `draft` and 1 `unresolved` states. There is 1 `replace` candidate for clear bounded dialogue and 2 pixel-preserving `review` actions for the fused missing-membership extent and uncertain standalone mark. All 3 A06 records explicitly supply a final OCR ID and all 3 match snapshot IDs; unavailable final-OCR coverage is 0. No cleanup mask, glyph asset, replacement object, translated layout, font, or implementation authorization was created.

Validation commands and exact results:

```text
sha256sum corpus/samples/ja/sample83/source.jpg
PASS: 508d4269d36317c7e38f263b84398fdf10ad36d2c1441097969cf8e0cff0e8ab

jq empty docs/quality-runs/a07-20260911-sample83/A07-region-action-glyph-style-labels.sample83.reviewed.json
PASS: valid JSON

jq A06-label/snapshot equality, provenance, final-OCR coverage, and action-count assertions
PASS: 3 A06 label IDs equal 3 packet label IDs; 3 explicit packet OCR IDs equal 3 snapshot OCR IDs; draft=2, unresolved=1, replace=1, preserve=0, review=2, explain=0; unavailable-final-OCR=0

git diff --check --no-index /dev/null <each new file>
PASS: no whitespace errors in either sample83 file
```

Quality-gate result: packet-only source-pixel curation is ready for coordinator review. It does not complete A07, G0, or any later gate.

Remaining uncertainty: r01 is fused with raw members absent, and r02 remains an uncertain-type source mark. Every `replace` remains only a candidate pending later approval.
