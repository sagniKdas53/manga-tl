# A07-sample93: region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `885f0d730c5c39a3ac208dad0499d4816a8db344` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample93/A07-region-action-glyph-style-labels.sample93.reviewed.json` and this checkpoint; both are new. No production code, tracker, existing evidence, source, submodule, or commit changed.

Inputs reviewed: exact `corpus/samples/ja/sample93/source.png`; `A06-owner-labels.draft.json`; retained `manifest.json`; `a04-exports/sample93/page-snapshot.json`; and the retained project original. The source SHA-256 is `127b2463b5fbd188dda061b9e8c53b2ddfcdd749359a6d4408c78710a183d38b`, matching A06, manifest, and snapshot image hash. Source-pixel review covered 11 A06 records and 11 snapshot OCR regions.

Action result: all 11 A06 records are represented exactly once, retaining 9 `draft` and 2 `unresolved` states. There are 2 `replace` candidates for clearly bounded dialogue, 1 `preserve` action for a clear drawn effect, and 8 pixel-preserving `review` actions for uncertain source type, fused extent, or missing raw membership. All 11 A06 records explicitly supply a final OCR ID and all 11 match snapshot IDs; unavailable final-OCR coverage is 0. No cleanup mask, glyph asset, replacement object, translated layout, font, or implementation authorization was created.

Validation commands and exact results:

```text
sha256sum corpus/samples/ja/sample93/source.png
PASS: 127b2463b5fbd188dda061b9e8c53b2ddfcdd749359a6d4408c78710a183d38b

jq empty docs/quality-runs/a07-20260911-sample93/A07-region-action-glyph-style-labels.sample93.reviewed.json
PASS: valid JSON

jq A06-label/snapshot equality, provenance, final-OCR coverage, and action-count assertions
PASS: 11 A06 label IDs equal 11 packet label IDs; 11 explicit packet OCR IDs equal 11 snapshot OCR IDs; draft=9, unresolved=2, replace=2, preserve=1, review=8, explain=0; unavailable-final-OCR=0

git diff --check --no-index /dev/null <each new file>
PASS: no whitespace errors in either sample93 file
```

Quality-gate result: packet-only source-pixel curation is ready for coordinator review. It does not complete A07, G0, or any later gate.

Remaining uncertainty: r02-r06 and r09-r11 remain review-only. The packet does not infer memberships, split composites, or convert any A06 draft ownership to verified.
