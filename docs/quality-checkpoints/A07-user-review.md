# A07 user-review supplement: container boundaries and reference precedence
Status: DONE

Date: 2026-09-11.

Allowed files and actual changed files: `docs/quality-runs/a07-20260911-user-review/A07-user-reviewed-container-and-reference-corrections.json`, `docs/quality-runs/a07-20260911-coverage/A07-coverage-audit.json`, this checkpoint, and the tracker. No application, worker, backend, source image, historical OCR/translation artifact, A06 label, submodule, or commit changed.

Decision: direct user review and human-authored references take precedence over machine references. Without a human reference, inspect the immutable source first; Torii and Ichigo/mangatranslator.ai are comparison evidence only.

`sample61`: all 50 final OCR regions in the retained snapshot belong to one visible dark document container: 8 upper-left, 11 upper-middle, 21 lower-left, and 10 right. The two regions extending beyond the conservative lower-left A06 bounding box are visually within that container. Future paragraph grouping may join nearby lines only within one listed container; crossing a container, panel, page, or spread boundary is forbidden. This container assignment does not alter retained A06 labels, invent raw fragments, authorize cleanup, or verify text ownership.

`sample117`: user review identifies five source regions: three speech-bubble dialogues, lower-left free-standing dialogue, and top-right free-standing SFX. The supplemental policy records four replace candidates and one preserved SFX. The historical project records all five OCR regions; its historical translation metadata has four entries because the SFX translation element is hidden. Both historical artifacts remain unchanged.

Validation results:

```text
jq empty docs/quality-runs/a07-20260911-user-review/A07-user-reviewed-container-and-reference-corrections.json
PASS

jq: sample61 assigned membership count equals snapshot count and contains no duplicate ID
PASS: 50 / 50

diff: sample61 supplemental IDs equal snapshot OCR IDs
PASS

diff: sample117 supplemental IDs equal historical project OCR IDs
PASS: 5 / 5

sha256sum sample61 and sample117 sources
PASS: matches recorded digests

git diff --check
PASS
```

Limitations: this correction is evidence-only. It does not pass G0, create a mask, select a renderer, authorize replacement, or treat a preserved/review action as translated.
