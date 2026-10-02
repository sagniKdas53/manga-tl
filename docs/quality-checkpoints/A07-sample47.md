# A07-sample47: region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `885f0d730c5c39a3ac208dad0499d4816a8db344` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample47/A07-region-action-glyph-style-labels.sample47.reviewed.json` and this checkpoint; both are new. No production code, tracker, existing evidence, source, submodule, or commit changed.

Inputs reviewed: exact `corpus/samples/ja/sample47/source.jpg`; A06-C `sample47` owner labels in `A06-C-owner-labels.controls.reviewed.json`; `sample47-overview.png` and `sample47-regions.png`; and `a04-exports/sample47/page-snapshot.json`. The source SHA-256 is `00b19b4cd45c3410920dbdd6d16a8fc8d43f1e3692ad94af5922257d64658854`, matching A06-C and the snapshot image hash. A06-C records 12 final OCR regions.

Action result: 12 A06-C owner labels and 12 snapshot OCR IDs are represented exactly once. There are 7 `replace` candidates requiring future glyph support, 4 `preserve` actions (3 drawn effects and 1 decorative mark), and 1 clipped-edge `review` action. `review` preserves source pixels and authorizes no cleanup or replacement text. No mask, cleanup, replacement object, translated layout, font, or implementation authorization was created.

Validation commands and exact results:

```text
sha256sum corpus/samples/ja/sample47/source.jpg
PASS: 00b19b4cd45c3410920dbdd6d16a8fc8d43f1e3692ad94af5922257d64658854

jq empty docs/quality-runs/a07-20260911-sample47/A07-region-action-glyph-style-labels.sample47.reviewed.json
PASS: valid JSON

jq owner-label/snapshot equality and action-count assertions
PASS: 12 A06-C owner-label IDs equal 12 packet owner-label IDs; 12 packet OCR IDs equal 12 snapshot OCR IDs; replace=7, preserve=4, review=1, explain=0

git diff --check --no-index /dev/null <each new file>
PASS: no whitespace errors in either sample47 file
```

Quality-gate result: packet-only source-pixel curation is ready for coordinator review. It does not complete A07, G0, or any later gate.

Remaining uncertainty: r011 remains a pixel-preserving review item because its source extent is clipped at the page edge. Every `replace` remains only a candidate pending later approval.
