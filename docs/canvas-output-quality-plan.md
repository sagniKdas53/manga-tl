# Canvas and pipeline output quality plan

Planning checkpoint: 2026-09-09. Production changes have not started. The authoritative task list, statuses, dependencies, quality gates and resume packet are now in the [implementation tracker](output-quality-implementation-tracker.md). It replaces the earlier eight broad batches with ten milestones and 58 task cards with bounded Luna execution packets and coordinator-owned acceptance reviews.

Read the [investigation](output-quality-investigation.md) for concrete reproductions and their limits, the [architecture decisions](output-quality-architecture-decisions.md) for design rationale, and the [corpus cutoff evidence](quality-evidence/corpus-cutoff.md) for generation dates compared with Git history. Do not start implementation from an older batch number.

## Scope and architecture

The target is newly processed images and a regenerated corpus. There is no legacy project converter, old-output migration, old-renderer fallback or historical rendering parity requirement. The new format must preserve geometry, angle, style, policy and cleanup assets through its own save/import/export cycle. Database schema installation/upgrade remains normal implementation work. Immutable sources, references and historical evidence are retained; regeneration creates a new run before promotion.

ARM64/RapidOCR remains a proof of concept. Its QEMU/build/import checks do not establish page quality or production capacity. The required acceptance route is the existing Linux amd64 stack, with actual hardware/model/font/browser provenance recorded. ARM64 deployment and parity are outside these milestones.

Use one TypeScript layout engine and DOM/SVG content scene in the editor and pinned Chromium output service. Python retains OCR, region analysis, glyph masking, restoration and image operations. Retire both Pillow typography and independent browser Canvas export typography. Downloads, chapter assembly, thumbnails and QA use the current canonical artifact.

Keep independent text owners separate from panel/conversation/reading-order relationships. Resolve nearby text collisions within allowed containers; proximity or overlapping boxes alone cannot authorize a merge. Persist early region actions (`preserve`, `explain`, `replace`, `review`) and enforce them before translation targets, repeated prompt manifests, cleanup and rendering. Preserved SFX retains its source pixels and OCR metadata.

The worker produces a glyph alpha mask **and reconstructed background pixels**. A mask says where changes are permitted; it cannot restore artwork by itself. Composite restored patches only inside approved support, then overlay editable styled text. Source cleanup stays anchored while replacement text moves. Selection handles use a simple frame; detailed mask editing is separate.

## Milestone overview

| Milestone | Deliverable | Exit gate |
| --- | --- | --- |
| M0 | Fresh current-checkout six-page baseline, isolated service tests, reviewed labels and holdout | G0: credible inputs and actual reproduction |
| M1 | New versioned scene/artifact/policy contract across API, worker and browser | G1: validated examples and new-format field preservation |
| M2 | Monotonic edit revisions, immutable jobs and conditional artifact completion | G2: no lost edits or stale outputs marked current |
| M3 | Early SFX classification/action policy and prompt/target suppression | G3: preserve policy enforced, dialogue suppression measured |
| M4 | Shared browser scene, pinned render service and amd64 large-page prototype | G4: real PNGs, consistent layout and bounded resources |
| M5 | Fragment ownership, bounded grouping and fused-container handling | G5: no known cross-owner merges or unaccounted fragments |
| M6 | Evaluated glyph-mask and reconstruction providers, compositing and artifact persistence | G6: glyph cleanup with protected artwork |
| M7 | Source style, constrained fitting and linked editable objects | G7: composition, controls and save/reload behavior |
| M8 | New project archives, canonical exports/QA and duplicate-renderer retirement | G8: consistent current artifacts across all consumers |
| M9 | Six-page acceptance, frozen holdout, measured costs and staged corpus regeneration | G9: complete coverage and reviewed manifest promotion |

M2–M5 foundations can use disjoint tasks after the contract gate. The browser prototype precedes new typography work; policy and ownership precede destructive cleanup. Model choices require recorded candidate comparisons on identical inputs. Do not substitute a global merge threshold, a page-area cap or whole-image similarity to Torii for owner/glyph/style evaluation.

## Evidence that changes the order of work

All 262 active corpus exports predate August 29. The latest recorded processing timestamp among 261 projects with stage metadata is August 28 at 19:11:44 UTC; `ja/sample1` lacks stage timestamps. The six requested JA fixtures have OCR timestamps from August 13–22. Later free-text sizing, rotation and shared-fitting changes cannot be evaluated from those old exports. Exact deployed commits are unknown because the artifacts lack code/image provenance.

Current source-bound probes still expose wrong-ID page invalidation, success-at-enqueue freshness, whitespace/persisted-SFX rendering and unbounded grouping mechanisms. The six local worker replays use old saved geometry and a host fallback font; they are not fresh OCR or deployed-browser comparisons. M0 closes those evidence gaps before any behavior fix. Retain already-correct normal rotation parsing, OCR raster exclusion and other current fixes as regressions instead of reimplementing them.

## Next session

Start with **A01** in the [tracker](output-quality-implementation-tracker.md), not the superseded Batch 1. Inspect current heads, establish isolated integration services and record runtime provenance. A02/A03 then capture and reproduce current processing. Each Luna task saves its own checkpoint after reproduction, edits and validation; the coordinator updates the central milestone table only when the gate passes.

No corpus regeneration, deployment or production rewrite was performed while preparing this plan.
