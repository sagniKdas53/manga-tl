# A07-sample39: region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `885f0d730c5c39a3ac208dad0499d4816a8db344` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample39/A07-region-action-glyph-style-labels.sample39.reviewed.json` and this checkpoint; both are new. No production code, tracker, existing evidence, source, submodule, or commit changed.

Inputs reviewed: exact `corpus/samples/ja/sample39/source.jpg`; A06-C `sample39` owner labels in `A06-C-owner-labels.controls.reviewed.json`; `sample39-overview.png` and `sample39-regions.png`; and `a04-exports/sample39/page-snapshot.json`. The source SHA-256 is `d776a3cc203d65563edfb8c213c3196864f16738e7755876fda3dd4daf34c1f2`, matching A06-C and the snapshot image hash. A06-C records 13 final OCR regions.

Action result: 13 A06-C owner labels and 13 snapshot OCR IDs are represented exactly once. There are 10 `replace` candidates requiring future glyph support, 3 `preserve` actions (2 drawn effects and 1 decorative mark), and no `review` or `explain` action. No mask, cleanup, replacement object, translated layout, font, or implementation authorization was created.

Validation commands and exact results:

```text
sha256sum corpus/samples/ja/sample39/source.jpg
PASS: d776a3cc203d65563edfb8c213c3196864f16738e7755876fda3dd4daf34c1f2

jq empty docs/quality-runs/a07-20260911-sample39/A07-region-action-glyph-style-labels.sample39.reviewed.json
PASS: valid JSON

jq owner-label/snapshot equality and action-count assertions
PASS: 13 A06-C owner-label IDs equal 13 packet owner-label IDs; 13 packet OCR IDs equal 13 snapshot OCR IDs; replace=10, preserve=3, review=0, explain=0

git diff --check --no-index /dev/null <each new file>
PASS: no whitespace errors in either sample39 file
```

Quality-gate result: packet-only source-pixel curation is ready for coordinator review. It does not complete A07, G0, or any later gate.

Remaining uncertainty: every `replace` remains only a candidate. Protected art and preserved source effects cannot be treated as cleanup targets.
