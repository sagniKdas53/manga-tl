# Output quality — next-session starting point, 2026-09-24

## Start here

Read the [cleanup failure checkpoint](quality-runs/oq-20260923-cleanup/README.md) and the [implementation tracker](output-quality-implementation-tracker.md) first. This handoff records the cleanup checkpoint after the 2026-09-23 implementation session. The tracker has been updated to this September 24 checkpoint.

**R3 remains NOT PASSED.** Reader cleanup parity, project round-trip, fitting, broad benchmarking and full output-quality acceptance remain deferred. Do not claim a speedup or begin a broad fixture benchmark from this checkpoint.

## Verified implementation state

- Prior session backend: 210 tests passed; formatting and Clippy clean.
- Prior session worker: 587 tests passed; full lint, formatting and Pyright clean. The final focused source-retry/crop-cap checks passed (7 tests).
- Prior session frontend: typecheck and lint clean. Live OpenAPI generation produced no schema diff.
- Empty CTD masks now produce an explicit uncertain/review outcome. The worker records local OCR small-glyph and false-OCR diagnostics before review, preserves source pixels, skips translation for the uncertain region, and continues with valid regions.
- QA includes unresolved cleanup review, so cleanup review cannot be hidden by otherwise passing translated-region checks. Reader shows a persistent notice.
- Source-expired 403 retry uses configured storage and still verifies the immutable digest. The backend cleanup callback owns terminal status; an accepted failure cannot be followed by a worker COMPLETED patch.

These are code and test gates, not R3 quality acceptance. The uncertain-region heuristic is diagnostic only: it is not an erasure threshold and does not prove that a region contains text.

## Runtime checkpoint and exact next check

On September 24 the dev containers were absent; existing built images and volumes survived. Restarted project `manga-quality-dev` with `docker compose --env-file .env -p manga-quality-dev -f docker-compose.dev.yml up -d --no-build --wait`. Backend `862bf20b999c`, worker `7a4b3f5b594a`; all healthy. Retried only the two original cleanup jobs once through the API:

| Page | Page ID | Cleanup job ID |
| --- | --- | --- |
| 8 | `13cef009-5293-4fb2-adc4-db00d67e81d2` | `912bc3f1-0e27-46f5-9751-a55a0cb3e618` |
| 9 | `3e3867c7-fed5-4881-8b5a-5ac551ac081b` | `fc21e36d-1296-49d5-a489-82a7bb974dd9` |

Both cleanup jobs COMPLETED, accepted callbacks in 87.5s/51.9s, both dispatched translation. Each uncertain region retains no cleanup patch and has `cleanup_review`. Local checks estimated 97.7px/255.2px glyphs, neither small. These old job payloads lack original OCR text; diagnostics honestly say comparison unavailable. New jobs carry original text for agreement checks. Prior manual inspection identified handwriting on page 8 and an ornament false-positive on page 9; OCR disagreement alone is not permission to erase.

Both Reader notices and expanded diagnostics were verified using headless Chromium and local screenshot inspection. Worker completion/review-skip markers were observed; no contradictory transition was observed in the focused log window. Today’s focused regression rerun passed 12 tests. Full gates above are retained prior-session evidence, not rerun today.

**Final snapshot:** both translation jobs, initial renders, QA jobs, and post-QA renders COMPLETED. Each page retains one `cleanup_review`; the other regions are passed/fixed (page 8: three/three; page 9: two/one). Overall QA remains manual review, not passed.

**Next bounded check:** inspect the final rendered page 8/9 outputs and exports against their latest reviewed scene, without requeueing. Job completion and notices were verified; final artifact pixel quality and export equality were not checked in this checkpoint. Record remaining problems honestly, then discuss whether to resume Reader parity.

Chapter route: `/tlhub/chapters/2298c931-16ce-419c-b5e4-367984fd5e6d/reader/8` (or `/9`), base `http://127.0.0.1:18080`. Browser screenshots under `/tmp` are ephemeral and not committed; no need to inspect other pages.

Worker checkpoint: `2bda51f` (pushed to `origin/feat/output-quality` per worker AGENTS requirement). Parent checkpoint contains this handoff, tracker, backend, Reader notice and worker pointer; find it with `git log -1`. The unrelated untracked `codex-session-01a0ce65-7870-7623-86e4-75f7a45df818.md` is intentionally excluded.

## Deferred scope

Reader cleanup parity and fitting remain explicitly deferred. R3 still lacks its independent reliability, measured performance, and cleanup-only visual quality gates. Do not start a broad benchmark or corpus sweep. This document describes remaining work; follow the next session’s user instructions for scope.

No source images, raw dialogue, credentials or sensitive user material are included here.

## Next-session prompt

> Read this September 24 handoff and tracker. Inspect the completed page 8/9 final render outputs and exports without retrying them. Verify current-artifact equality and record remaining visible problems; preserve the manual-review verdict. Keep this a single bounded checkpoint, update evidence, and stop before Reader parity or fitting. R3 remains NOT PASSED.
