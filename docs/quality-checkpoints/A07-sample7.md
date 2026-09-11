# A07-sample7: region actions, glyph support, and source style labels
Status: REVIEW

Date / app head / worker head / corpus head: 2026-09-11 / `a78efc1aa5b03b0a835a37da8fd46cb5e3575085` / `7b54f8c1c516eb445e869b2776ffa62e4ee2762b` / `ed9b191da255e4d3d132a2d050ab8fffa1815e26`.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-sample7/A07-region-action-glyph-style-labels.sample7.reviewed.json` and this checkpoint; both are new. No source image, baseline artifact, application, worker, backend, schema, model, or submodule changed.

Prerequisites and input artifact hashes: A06-C reviewed source ownership for `sample7` is complete: 24 reviewed final OCR records and zero blockers. The immutable `corpus/samples/ja/sample7/source.jpeg` SHA-256 is `7e23ae0c9e7ffbec45221c2820a35dcde2e81aae99d34eb922d71f25855f71e9`, matching the A06-C reviewed label set and fresh page snapshot. A06-C is the required predecessor; A07 remains an incomplete multi-fixture task.

Current-checkout reproduction (command, observed result): inspected the exact source, retained source overview/region sheets, A06-C reviewed owner labels, and fresh `page-snapshot.json`. The source contains thirteen independent white-balloon dialogue owners plus one localized name label, one drawn movement SFX, one stylized free-standing effect, one motion mark, and seven decorative asterisks. Ordinary source dialogue is vertical black unoutlined Japanese lettering; the existing `Hi` balloon is bold horizontal Latin lettering.

GitNexus impact (repo, symbols, callers/processes, risk, freshness): not applicable. This evidence-only packet changes no production symbol, API, worker, route, source, or submodule; therefore no upstream symbol impact exists. GitNexus query was used to locate quality-evidence seams, but no executable source was edited.

Implementation decision and schema/config/model/font versions: curation-only `a07-region-action-glyph-style-labels-reviewed/v1`. `replace` is a candidate action, not permission to alter pixels. Every replace candidate requires a future approved glyph mask and validated cleanup; every preserve label denies automatic cleanup/text. The source-style labels record cues rather than selecting a font, reconstruction provider, mask algorithm, or new contract field.

Validation commands and executed/pass/fail/not-executed counts:

```text
sha256sum corpus/samples/ja/sample7/source.jpeg
jq -e '.counts.final_ocr_regions == 24 and .counts.reviewed == 24 and .counts.blocking == 0' A06-C-owner-labels.sample7.reviewed.json
PASS: source identity and A06-C prerequisite / FAIL: 0 / NOT-EXECUTED: 0

jq empty A07-region-action-glyph-style-labels.sample7.reviewed.json
jq -e '[.labels[].final_ocr_region_id] | length == 24 and unique | length == 24' A07-region-action-glyph-style-labels.sample7.reviewed.json
jq -e '([.labels[].final_ocr_region_id] | length == 24 and (unique | length == 24)) and ([.labels[] | select(.action == "replace")] | length == 14) and ([.labels[] | select(.action == "preserve")] | length == 10) and .counts.outlined_glyph_owner == 0' A07-region-action-glyph-style-labels.sample7.reviewed.json
PASS: JSON syntax, complete unique final-region coverage, and declared action/style counts / FAIL: 0 / NOT-EXECUTED: 0

git diff --check
PASS: whitespace validation / FAIL: 0 / NOT-EXECUTED: 0
```

Before/after metrics and artifact paths: new retained packet `docs/quality-runs/a07-20260911-sample7/A07-region-action-glyph-style-labels.sample7.reviewed.json` covers all 24 reviewed final OCR records: 14 `replace` candidates requiring glyph support and 10 `preserve` decisions. The preserved set contains two drawn/stylized effects and eight decorative marks. No source-outlined glyph owner occurs in this fixture.

Quality-gate result and reviewer: source-pixel curation is ready for coordinator review. This packet provides an ordinary JA B&W multi-panel/balloon control, preserve-SFX cases, and per-owner protected-art exclusions. It does not pass A07, G0, or any later gate; A07 still needs source-reviewed JA/KO/ZH fixtures and an outlined-glyph case.

Remaining uncertainty or blocker: no binary glyph support, source-space alpha mask, cleanup patch, font selection, or translated layout has been created. The style labels must not be mistaken for model measurements. `sample7` has no outlined glyph owner, so that required cross-fixture coverage remains open.

Exact next command and expected result: select one unreviewed A07 fixture with an outlined or colored glyph case, recheck its A06-C owner labels and source digest, then save a separate `A07-<fixture>` annotation packet that preserves any uncertain region as `review` rather than guessing.

Files/worktree that must be preserved: the immutable `sample7` source; the A06-C sample7 reviewed labels, review sheets, page snapshot, and fresh exports; this A07 packet; all historical A01-A06-C evidence; and the pre-existing user edits to `docs/output-quality-implementation-tracker.md` and `docs/quality-checkpoints/A06-C.md`.
