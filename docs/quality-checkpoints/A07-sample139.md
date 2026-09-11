# A07-sample139: region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `885f0d730c5c39a3ac208dad0499d4816a8db344` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample139/A07-region-action-glyph-style-labels.sample139.reviewed.json` and this checkpoint; both are new. No production code, tracker, existing evidence, source, submodule, or commit changed.

Inputs reviewed: exact `corpus/samples/ja/sample139/source.png`; A06-C `sample139` owner labels in `A06-C-owner-labels.controls.reviewed.json`; `sample139-overview.png` and `sample139-regions.png`; and `a04-exports/sample139/page-snapshot.json`. The source SHA-256 is `192040b01567524ea7cfb7a9c7962b2a4f98c08a6ad6e4f0201ebb024dc796db`, matching A06-C and the snapshot image hash. A06-C records 13 final OCR regions.

Action result: 13 A06-C owner labels and 13 snapshot OCR IDs are represented exactly once. There are 9 `replace` candidates requiring future glyph support, 3 `preserve` actions for drawn effects, 1 explain-only page title, and no `review` action. No mask, cleanup, replacement object, translated layout, font, or implementation authorization was created.

Validation commands and exact results:

```text
sha256sum corpus/samples/ja/sample139/source.png
PASS: 192040b01567524ea7cfb7a9c7962b2a4f98c08a6ad6e4f0201ebb024dc796db

jq empty docs/quality-runs/a07-20260911-sample139/A07-region-action-glyph-style-labels.sample139.reviewed.json
PASS: valid JSON

jq owner-label/snapshot equality and action-count assertions
PASS: 13 A06-C owner-label IDs equal 13 packet owner-label IDs; 13 packet OCR IDs equal 13 snapshot OCR IDs; replace=9, preserve=3, review=0, explain=1

git diff --check --no-index /dev/null <each new file>
PASS: no whitespace errors in either sample139 file
```

Quality-gate result: packet-only source-pixel curation is ready for coordinator review. It does not complete A07, G0, or any later gate.

Remaining uncertainty: the explain-only title and all preserved effects retain their source pixels. Every `replace` remains only a candidate pending later approval.
