# Output quality implementation tracker

Planning checkpoint: 2026-09-09. **Implementation has not started.** This is the authoritative execution tracker for the user's requested unified renderer, SFX policy, independent text ownership and generated cleanup improvements. Read the [architecture recommendations](output-quality-architecture-decisions.md) for rationale and the [investigation](output-quality-investigation.md) for reproductions.

## Scope overrides from the user

- Target newly processed images and a regenerated corpus. Do not implement compatibility readers, old-project converters, legacy output migrations, old renderer fallbacks or legacy rendering parity. New-format save/import/export must still round-trip correctly. Database schema migrations needed to install the new schema are normal implementation work, not legacy artifact support.
- Preserve immutable source images, reference baselines and the historical investigation evidence. Regeneration creates a new run and then promotes its manifest; dropping compatibility is not an instruction to delete sources or old evidence now.
- ARM64/RapidOCR is a proof of concept. Preserve its existing files unless a task specifically needs a change, but exclude native ARM deployment, ARM quality parity, QEMU benchmarks and ARM performance promises from this release. Establish the acceptance baseline on the existing Linux amd64 route; record actual CPU/GPU/runtime before comparing results.
- Corpus outputs are historical. Use embedded OCR/translation/QA timestamps, then Git chronology; export/import time and filesystem mtime do not establish generation time. Historical screenshots are regression prompts, not proof the same issue persists today.
- Use `gpt-5.6-luna` at medium reasoning for bounded implementation tasks and low/medium for inventory or documentation. The coordinating agent owns contract decisions, decomposition and milestone review. No larger-model subagent is required by this plan.

## Evidence cutoff and starting checkpoint

App: `ac13387`; worker: `3a7b46c`; corpus: `607b78b8`. These identify the inspected checkouts, **not the versions that generated the corpus**. The app change since the original investigation is documentation. Recheck all three heads before starting a task.

The [timestamp/Git comparison](quality-evidence/corpus-cutoff.md) covers all 262 active projects (211 JA, 29 KO, 22 ZH). Their exports span August 5–28. Of 261 projects with embedded stage dates, the latest recorded processing timestamp is **2026-08-28 19:11:44 UTC**; the latest export is eleven seconds later. `ja/sample1` has no stage date. The six requested fixtures' OCR dates are August 13–22. Selected August 29–September 8 layout, rotation and OCR changes postdate these outputs. Import commits and file mtimes do not establish when processing ran; dates alone cannot recover deployed image hashes.

The old August 13 OCR cutoff is a historical corpus freshness policy, not proof that current geometry is correct. Existing saved-layout replays prove current rendering behavior on those inputs; they do not reproduce current OCR. **G0 must obtain fresh current-checkout stage outputs before any behavior fix.** If a reported defect no longer reproduces, retain its regression case and omit the obsolete fix.

Planning evidence is complete: [investigation](output-quality-investigation.md), [architecture](output-quality-architecture-decisions.md), [implementation entry points](quality-evidence/implementation-boundaries.md), and [timestamp summary](quality-evidence/corpus-cutoff-summary.json). No implementation gate is passed by those documents.

## Tracker and execution order

Task statuses: `TODO`, `READY`, `ACTIVE`, `REVIEW`, `DONE`, `BLOCKED`. Only A01 starts `READY`; the coordinator advances tasks after their dependencies and the applicable entry gate pass. All task cards below start `TODO` unless stated otherwise. A milestone checkbox means its exit gate has passed, with evidence linked here. An unresolved or unexecuted gate is not a pass.

| Complete | Milestone | Task IDs | Entry condition | Exit gate | Checkpoint |
| --- | --- | --- | --- | --- | --- |
| [ ] | M0 — current baseline and reviewed acceptance data | A01–A09 | Planning complete | G0 | Pending |
| [ ] | M1 — new artifact and API contract | B01–B05 | G0 | G1 | Pending |
| [ ] | M2 — revision-safe output lifecycle | C01–C05 | G1 | G2 | Pending |
| [ ] | M3 — SFX decisions before paid/destructive work | D01–D05 | G1 | G3 | Pending |
| [ ] | M4 — shared browser scene and render service | E01–E06 | G1; G2 before queue integration | G4 | Pending |
| [ ] | M5 — independent owners and bounded grouping | F01–F04 | G1 | G5 | Pending |
| [ ] | M6 — glyph masks and reconstructed backgrounds | G01–G07 | G3 and G5 | G6 | Pending |
| [ ] | M7 — source style, fitting and editor objects | H01–H06 | G4; G6 before editor integration | G7 | Pending |
| [ ] | M8 — export/QA cutover and renderer retirement | I01–I06 | G2, G3, G6, G7 | G8 | Pending |
| [ ] | M9 — acceptance, holdout and corpus regeneration | J01–J05 | G8 | G9 | Pending |

Default order is the table order. To conserve usage, run one Luna at a time unless two ready tasks have disjoint files and useful independent outputs. After G1, the policy, grouping and browser foundations can proceed independently; do not hold the browser prototype until cleanup is finished. No final typography features go into Pillow.

```mermaid
flowchart LR
  M0 --> M1
  M1 --> M2
  M1 --> M3
  M1 --> M4
  M2 --> M4
  M1 --> M5
  M3 --> M6
  M5 --> M6
  M4 --> M7
  M6 --> M7
  M2 --> M8
  M7 --> M8
  M8 --> M9
```

## Rules for Luna task packets

1. Assign **one task ID**, a frozen input contract, exact allowed paths, one expected behavior, a focused validation command and its checkpoint path. Each table row is a packet specification; select concrete files from its stated seams before dispatch. Normally limit a packet to three production files plus relevant tests. If exploration reveals more than one independent behavior or a large shared-handler rewrite, checkpoint and split it into numbered child tasks before editing. There is no requirement to finish a whole milestone in one session.
2. Use Luna medium for implementation; low/medium for inventories and evidence reports. The coordinator makes interface/model choices and reviews visual gates. A task asking for a candidate comparison produces measurements and a recommendation, not an autonomous model replacement. No larger-model subagent is a prerequisite.
3. At task start: inspect worktree status and heads, read applicable AGENTS/skills, reproduce the relevant behavior on that checkout, and run GitNexus upstream impact on each symbol to be changed. Use the worker index for worker flows. Report HIGH/CRITICAL findings before edits. `touch_page` currently has CRITICAL fan-out across six operations; keep its first fix at the incorrect caller. If the index is stale, refresh it or record why graph results are incomplete and inspect actual callers.
4. Serialize shared files: `Reader.tsx`, `coordinator.rs`, `models.rs`, `ocr.py`, `schemas.py`, API generation, manifests/lockfiles and submodule pointers. At most two concurrent Luna agents, with disjoint worktrees or explicit file ownership. The coordinator owns this tracker and integration; agents own their task checkpoint documents.
5. Save `docs/quality-checkpoints/<TASK-ID>.md` after reproduction, after the change, after validation and before stopping. Save partial failures too. Put artifacts in a run-specific directory; never overwrite the historical evidence. A worker-only checkout keeps its checkpoint locally and the coordinator copies it into the parent report.
6. Focused tests run first. At the milestone, run the relevant full repository gates once. A test that returned early because PostgreSQL/Redis/storage was absent is **not executed**, even if the test command exits zero. Do not install global Python packages. Backend API changes require live OpenAPI regeneration. Before any eventual commit, run `detect_changes` for every changed repository; coordinate worker/corpus commits and parent pointers separately.

## Contract to freeze at B01

These decisions bound downstream tasks; B01 supplies exact field names, examples and validation rules. Proposed **new paths**, not existing modules: `contracts/page-scene-v1.schema.json`, `packages/page-scene/`, `services/page-renderer/`, `docs/quality-checkpoints/`. The parent schema is authoritative; worker distribution must include a real versioned copy or generated models with a digest check, not a parent-path symlink.

| Record | Required semantics |
| --- | --- |
| Run provenance | Source SHA-256, source pixel dimensions, stage inputs/outputs and their hashes, app/worker/renderer commits, model/config/prompt versions, font files/hashes, actual runtime, timings and warnings. |
| OCR fragment | Stable ID, unmerged oriented quad, recognition text/confidence, detector-to-source transform and optional glyph evidence. Confidence `0` is valid; it is not missing. |
| Text owner | Stable block ID, member fragment IDs, independent container/panel IDs, grouping evidence and vetoes. Conversation/reading-order links never imply a shared mask. |
| Region policy | Kind, confidence, reason, action `preserve / explain / replace / review`, and explicit user override. Only `replace` authorizes cleanup; unresolved `review` preserves pixels and remains visible in the review list. `explain` creates a note, not destructive page replacement. |
| Cleanup artifact | Source-space alpha mask, bounded reconstructed patch, source digest, owner IDs, generator/config digest, active-set dependency and diagnostics. Mask geometry, restoration pixels and text layout geometry are different fields. |
| Editable object | Owner/cleanup links, text, allowed layout container, source-anchored cleanup, independently movable text geometry, visibility and style. Coordinates/dimensions are finite source-pixel floats; signed rotation degrees, writing mode and alignment are separate. Fill/stroke/weight/font ID and padding are explicit. Manual cleanup is an explicit kind, not an empty automatic text object. |
| Render job/result | Immutable logical scene snapshot at a monotonic page revision, source and render-input digest. The service resolves layout once and returns layout diagnostics, lossless PNG/hash, browser/font provenance and the same revision/digest. Assets use revision/digest paths; latest pointers update only on matching completion. |
| New project archive | Versioned editable records, immutable source, referenced cleanup assets, settings and fonts by digest. New-format round trip only. Reject unsupported versions clearly; no converter, legacy default geometry or old-renderer fallback. |

Keep one live editable source of truth in the backend. Assemble immutable scene snapshots from it; do not maintain an independently editable duplicate scene JSON alongside normalized rows. All auto cleanup composites before replacement glyphs. Selection handles/OCR metadata never enter the content scene. Preserve intentional manual z-order and explicit manual cleanup as separate object semantics.

Cache dependencies: source/model/preprocess change invalidates OCR and dependent stages; owner changes invalidate policy, affected translations and cleanup; action changes invalidate affected targets/cleanup/scene; English/font/position changes invalidate layout/render only; active overlapping cleanup changes invalidate the joint patch. Record dependencies, not a universal “rerun page” flag.

## Task cards

Paths in each row are permitted starting seams, not permission to rewrite every listed module. Tests named as new are deliverables to add, not commands already available. Every task must also satisfy the task-packet rules above.

### M0 — reproduce and freeze the evaluation inputs

| ID | Depends on | Bounded output / allowed seams | Task gate |
| --- | --- | --- | --- |
| A01 (`DONE`; [checkpoint](quality-checkpoints/A01.md)) | — | Add a fail-fast local quality-run preflight and isolated test-service recipe under `scripts/` and `docs/quality-checkpoints/`; inventory actual heads, containers, model/font hashes and hardware. Use existing Compose definitions only as inputs. | Passed: isolated DB sentinel, Redis and MinIO checks succeeded without production DB mutation. Effective runtime fonts remain an environment finding for later baseline capture. |
| A02 (`DONE`; [checkpoint](quality-checkpoints/A02.md)) | A01 | Add a capture/replay harness around current OCR/grouping stage seams (`worker/` test tooling plus a narrowly bounded hook if needed). Save raw quads, scale transforms, detector masks, recognition, grouping edges and final owners; no algorithm change. | Passed: deterministic capture/replay test retains stable IDs, geometry, edges and owners; paths state `live`, `cached` or `stubbed`. |
| A03 (`DONE`; [checkpoint](quality-checkpoints/A03.md)) | A02 | Run the six current source → OCR → translation → cleanup/render baselines in a new run directory, one page at a time. Record real model calls and stage artifacts; no algorithm edit. | Six fresh, retained isolated-stack chapters completed at `a03a04-20260910-retained`; source/page snapshots, resolved settings, model calls and QA outcomes are saved. |
| A04 (`DONE`; [checkpoint](quality-checkpoints/A04.md)) | A03 | Capture actual editor and PNG/ZIP outputs for the six baseline projects using existing `scripts/playwright/` tooling. | All six live baseline chapters produced editor screenshots, browser export PNGs, rendered PNGs, ZIPs/unpacked projects, page snapshots and browser font inventories. |
| A05 (`DONE`; [checkpoint](quality-checkpoints/A05.md)) | A04 | Produce comparison sheets and the fixed/remaining/not-reproduced issue matrix from A03/A04. Evidence/report task only. | [A05 comparison](quality-runs/a03a04-20260910-retained/A05-comparison.md) records all seven reported defect classes as remaining; no issue is fixed or not reproduced. Service/model availability was verified for the retained run. |
| A06 (`DONE`; [checkpoint](quality-checkpoints/A06.md)) | A05 | Prepare independent owner/container/fragment labels for the six exact source images in evaluation data. Luna drafts; coordinator visually reviews assignments. | Six `sample177` portrait owners are coordinator-verified in [the label set](quality-runs/a03a04-20260910-retained/A06-owner-labels.draft.json). Composite regions and raw-fragment gaps remain draft/unresolved; no positional guess is verified. |
| A07 | A06 | Prepare region-action, glyph-support and source-style annotations for the reviewed owners, one fixture per bounded curation packet. Luna drafts; coordinator reviews pixels and labels. | Required dialogue/SFX, outlined glyph, protected-art and style cases have reviewed labels. Unsupported/unlabelled regions remain coverage gaps. |
| A08 | A05 | Create PDF-derived synthetic scene inputs for fractional rotation, blank/manual objects, padding/handles and narrow/overlapping containers. | Fixtures encode measurable expected behavior without claiming screenshots contain editable original geometry. |
| A09 | A07, A08 | Select a stratified JA/KO/ZH holdout and freeze the source/label/threshold evaluation manifest. Coordinator-reviewed inventory task; no model tuning. | Acceptance data and at least 20 held-out IDs are frozen before candidate tuning. Required unverified labels cannot pass a gate. |

G0 checkpoint: six fresh baselines, machine/environment provenance, real integration preflight, reviewed evaluation manifest and unresolved hypotheses. If model/services are unavailable, stop dependent quality work at a saved checkpoint; do not silently substitute old OCR.

### M1 — define and implement the new contract

| ID | Depends on | Bounded output / allowed seams | Task gate |
| --- | --- | --- | --- |
| B01 | A09 | Write schema, valid/invalid examples and canonical digest rules in `contracts/`; freeze logical vs resolved scene and policy semantics above. Coordinator reviews before consumers change. | Fixtures cover rotated/fractional geometry, empty/manual objects, preserved SFX, overlapping cleanup and missing assets. Coordinator freezes units/nullability/version; B03–B05 subsequently prove each consumer against these fixtures, and G1 passes only after all three. |
| B02 | B01 | Install new storage fields through `database/init.sql` and the repository's actual DB update mechanism; first verify how existing installations receive schema updates. Include page revision, job input/result digest and owner/artifact references. | Fresh isolated DB and existing-schema upgrade both work without deleting sources. No legacy project/output conversion. |
| B03 | B02 | Implement the new backend DTO/serialization slice in `backend-rust/src/models.rs` and a small dedicated mapping module. | Contract fixtures serialize/validate identically; unknown versions, non-finite geometry and mismatched source assets fail explicitly. |
| B04 | B01 | Update `worker/src/worker/schemas.py` plus one artifact-validation module; package its schema/version independently of the parent checkout. | Standalone worker validates the same fixtures and digest; no parent symlink dependency. |
| B05 | B03 | Wire the bounded API read/write mapping and regenerate `frontend/src/api/schema.d.ts` from the running backend; add a narrow frontend scene adapter. Split endpoints into child packets if more than one route family is required. | Live API agrees with generated types; save/read retains all new fields. New-format floats and 12.5° rotation survive without legacy defaults. |

G1 checkpoint: approved schema/examples and storage/API/worker mapping evidence. Mark cross-repository version compatibility only for this new contract; no support matrix for historical formats.

### M2 — make output freshness reliable

| ID | Depends on | Bounded output / allowed seams | Task gate |
| --- | --- | --- | --- |
| C01 | B05 | Reproduce the wrong-ID path through real API/DB, then fix `update_layer_element` in `backend-rust/src/routes/layers.rs` to identify the correct page/layer. | Editing element X advances its owning page only. A deliberately different element/layer UUID catches the existing bug. |
| C02 | C01 | Inventory all render-affecting write paths and add transactional page-revision increments. Dispatch one child packet per route family (`layers.rs`, `layers_ops.rs`, page/settings as discovered). | Text, transform, cleanup, visibility, order and render-setting edits each invalidate output. No edit commits without its revision increment. |
| C03 | C02 | In `jobs/recovery.rs` plus a scene snapshot helper, queue immutable revision/digest inputs; deduplicate same-revision jobs. | Enqueue does not mark success. Repeated debounce scans queue once; edits during a queued/running job retain a newer pending revision. |
| C04 | C03 | In the render callback branch of `jobs/coordinator.rs`, persist revision-specific artifacts and conditionally advance the current-artifact pointer. | Old/out-of-order/duplicate callbacks cannot mark newer edits rendered. Failed jobs remain retryable; retry does not consume completion prematurely. |
| C05 | C04 | Update the bounded page/export read boundary to serve the artifact matching the current revision/digest; expose pending/failed state and revision URLs. | Grid, download and QA cannot label an old artifact current. Save during render → eventual latest output; no false success at enqueue. |

G2 checkpoint: real PostgreSQL/queue/storage trace for edit → enqueue → completion → read, including failure and out-of-order callbacks. Timestamp-only helper probes are supporting evidence, not the gate.

### M3 — preserve SFX before translation and cleanup

| ID | Depends on | Bounded output / allowed seams | Task gate |
| --- | --- | --- | --- |
| D01 | B04 | Evaluate existing `classify_region_type` and cheap source features against A09 labels; correct zero-confidence handling in `services/layout.py` only after reproducing it. Save false positives/negatives and proposed calibrated rules. | Kana length alone never authorizes suppression. Decorated dialogue, vertical dialogue and low-confidence bubble cases appear in the report. Coordinator freezes the initial rule set. |
| D02 | D01 | Implement pure region-action selection with explicit user override and uncertainty in a small worker policy module; wire one classification seam. | Preserve/review authorize no erasure; explain is note-only; explicit replace overrides only that region. All labelled dialogue remains accounted for. |
| D03 | D02 | Apply policy to target selection **and repeated page manifests** in `handlers/translation.py`; retain OCR records outside provider prompts. | Captured provider payload has zero preserved-SFX target IDs/raw repeated entries. Already-filtered typed targets stay filtered. Measure tokens and chunks, not assumed per-region calls. |
| D04 | D03 | Apply policy to retry/translation-QA scheduling in their actual handlers; separate policy skip from failed translation. | Preserved/review regions cause no translation retries or per-region translation QA calls; selected dialogue failure remains retryable. Page-wide visual QA can still inspect original SFX. |
| D05 | D02, B05 | Add a shared contract-level validator used when creating replacement objects/cleanup requests. Cover tampered or contradictory new payloads. | `preserve/review` produces no automatic patch/text object, including re-render and new-format import. Empty/whitespace automatic translation cannot leave a blank patch. |

G3 checkpoint: labelled classification results, provider payload/token evidence and policy matrix at the currently available request/object boundaries. Final pixel invariance is rechecked with actual cleanup/browser integration at G6/G8 and J01; it is not claimed from validator tests. Preserve metadata without rasterizing OCR. Ambiguous dialogue is visibly queued for review and counted as unresolved; it is not reported translated.

### M4 — one browser renderer, proven early

| ID | Depends on | Bounded output / allowed seams | Task gate |
| --- | --- | --- | --- |
| E01 | B01 | Extract reusable text metrics/layout primitives from `frontend/src/utils/fitText.ts` and `textFitBox.ts` into proposed `packages/page-scene/`; keep adapters small. | Existing fitting cases pass; callers consume one implementation. Extraction makes no unsupported quality claim. |
| E02 | E01 | Implement a pure DOM/SVG content scene with source, explicit cleanup assets and styled text; emit resolved line boxes/diagnostics. | Synthetic rotation, stroke, blank/manual/preserve, clipping diagnostics and cleanup-before-glyph scenes render without editor handles or OCR pixels. |
| E03 | E02 | Add proposed `services/page-renderer/` with pinned Chromium/Playwright and fonts, bounded reusable contexts, a trusted static entry and scene input validation. | Await fonts/images; render source-sized PNG plus digest/diagnostics. Missing required asset/font fails visibly. Two same-input jobs on the pinned build produce the same result. |
| E04 | E03, C04 | Add the worker transport adapter and render-job dispatcher binding; consume the immutable snapshot rather than refetch mutable page geometry mid-render. | Queue job → browser result → callback passes revision/digest tests. Timeout/crash follows normal retry semantics. No PIL typography fallback for new jobs. |
| E05 | E04 | Add amd64 renderer container/Compose wiring, pinned assets and explicit memory/job limits. Deployment configuration packet only. | Service starts with the expected browser/font hashes; missing assets and configured limits fail explicitly. |
| E06 | E05 | Measure prepared ordinary and large scenes, including `sample93` (6764×4961), through the assembled service. Luna runs the harness; coordinator reviews capacity results. | Cold/warm time, RSS, dimensions and failure behavior recorded. Prototype passes before new typography work expands; no automatic high-concurrency default. |

G4 checkpoint: actual pinned-browser PNGs, layout diagnostics, working queue transport and large-page resource measurements. This proves the rendering seam, not final cleanup quality. No ARM64 job or speedup over PIL is required.

### M5 — group only fragments belonging to one text unit

| ID | Depends on | Bounded output / allowed seams | Task gate |
| --- | --- | --- | --- |
| F01 | B04, D02 | Implement owner assignment using captured oriented fragments, validated containers, line continuity and source scale/style; preserve unknown owners. Limit changes to a pure ownership module and its adapter. | Same panel/conversation or overlapping boxes alone never imply one owner. Diagnostics explain assignment and uncertainty. |
| F02 | F01 | Add component-level bounds and owner vetoes in `services/fragment_grouping.py`; test graph components, not just pairwise thresholds. | A–B–C bridge and close independent labels remain separate; labelled fragments from one true unit still join. Save both false-merge and false-split counts. |
| F03 | F02 | Bound the fused-container split path in `services/merge_regions.py`. Preserve raw memberships; unresolved contour splits keep local fragments/review status. | Failed crop/split never grants the whole fused detector mask. Separate dark containers and crossed-panel fixtures pass. |
| F04 | F03 | Wire grouping into the OCR/layout handlers in separate packets if needed; keep conversation/read-order relationships independent. | Fresh six-page OCR has zero reviewed cross-owner merges and complete fragment accounting; replay is deterministic. No sample-specific coordinate rules. |

G5 checkpoint: old/current/new owner overlays, edge decisions, split/merge counts and sample177's six illustration-label assignments. Region count alone cannot pass this gate.

### M6 — mask glyphs and reconstruct their background

| ID | Depends on | Bounded output / allowed seams | Task gate |
| --- | --- | --- | --- |
| G01 | F04, D05 | Compare at most two glyph-mask approaches on A09 labelled crops: a scale-aware local threshold/component baseline and one segmentation candidate if the baseline is inadequate. Use recorded pixels, no whole-corpus run. | Report glyph recall, off-target support, outlines, texture cases, dependencies/license/runtime. Coordinator chooses or records a blocked quality gate; no unmeasured default model. |
| G02 | G01 | Implement the selected mask provider in a dedicated worker module; retain source coordinates, alpha and conservative edge margin. | Source fill and stroked outline are included; orientation/resize transforms round-trip. Preserve/review generates no mask. Neighbor cleanup may not erase preserved SFX or protected art; conflicting support requires review. |
| G03 | G02 | Implement validated uniform-interior cleanup as a separate provider. | Flat fill changes approved glyph support only; nonuniform/art backgrounds fail classification into the reconstruction path. |
| G04 | G01 | Compare at most two local background-reconstruction candidates on **identical approved masks and source crops**. Store inputs, patches, timings and visual review. | Report gradients, halftones, line art and colored backgrounds separately. Select a pinned model/config only after review; no generative whole-page redesign. |
| G05 | G04, G02 | Implement the selected reconstruction adapter and narrowly scoped dependencies in `worker/requirements.txt`; package model provenance/cache behavior. | Offline replay with pinned inputs works. Missing model or poor reconstruction yields review/failure, never a successful flat slab. |
| G06 | G03, G05 | Implement source-space compositing and joint active-support handling in a pure cleanup module; cache by source/mask/active-set/provider digest. | Outside approved alpha support is losslessly unchanged. Hiding one of two overlapping replacements restores correct source/remaining cleanup; moving English does not rerun cleanup. |
| G07 | G06, B05 | Wire bounded artifact upload/callback/reference persistence, one boundary per child packet if needed. Connect the browser scene to the cleanup asset contract. | Source/owner/hash validation catches wrong patches. Cleanup-only PNG and final scene use the same active assets. Rejected/empty automatic objects leave no orphan cleanup. |

G6 checkpoint: chosen providers with comparison evidence, glyph/support metrics and full-page cleanup-only images for all six. Model selection is an explicit decision checkpoint. If no candidate passes, save failed crops and narrow the next experiment; do not quietly relax the gate or replace the source with a generated page.

### M7 — match composition and keep objects editable

| ID | Depends on | Bounded output / allowed seams | Task gate |
| --- | --- | --- | --- |
| H01 | F04 | Add source style estimation in a bounded worker module: angle, fill/stroke, relative weight/size, writing mode and confidence. | Reviewed plain/decorated/colored/rotated examples have traceable estimates; unknown values stay explicit instead of unconditional bold black/white. |
| H02 | H01, B05 | Wire source style and explicit overrides through the backend-to-scene mapping; remove unconditional style replacement at that seam. | Save/read/job snapshot retain style and font IDs/hashes. Manual override wins; source vertical writing does not force vertical English. |
| H03 | E02, F04 | Add allowed-container line spans, neighbor exclusions and overflow diagnostics to the shared TS fitter. | Rotated glyph bounds stay within owner geometry; separate containers never merge to make room. Impossible fits produce review, not silent clipping or translation truncation. |
| H04 | H03, H02 | Add per-object padding, spacing and source-relative hierarchy constraints to the shared layout module. | Minimum readability, title/label hierarchy and reviewed whitespace bands pass; no universal “fill 100%” rule. |
| H05 | H04, G07 | Mount the shared content scene in the editor via a small Reader adapter; implement a separate simple selection frame and linked cleanup/text object panel. Split scene adapter and controls into child packets if necessary. | Four corner handles in normal mode; detailed mask mode separate. Text move/rotation leaves source cleanup anchored. Selection highlights the corresponding layer/order. |
| H06 | H05, D05 | Wire object actions: preserve/explain/replace/review override, hide/reject, cleanup adjustment, undo/redo and explicit manual cleanup. | Hide/reject recomposes source plus remaining patches; empty auto text hides its cleanup; manual cleanup remains intentional. Actions persist and advance page revision. |

G7 checkpoint: actual browser editing at normal zoom and native resolution, screenshots and new-format state snapshots. The PDF-derived blank/rotation/padding/handle/overflow cases must be exercised through save/reload, not only helpers.

### M8 — route all outputs through the canonical artifact

| ID | Depends on | Bounded output / allowed seams | Task gate |
| --- | --- | --- | --- |
| I01 | H06, C05 | Implement **new-format archive export** at the backend packaging boundary: editable records plus hashed source/cleanup/font assets. | Archive manifest is complete and assets match source/digests; no legacy export mode or converter. |
| I02 | I01 | Implement new-format archive import/validation and field mapping at the backend import boundary; split asset validation from persistence if needed. | Export → import → edit → render preserves floats, angle, style, owner, action and visibility. Unsupported old versions fail clearly. |
| I03 | I02, E04 | Route page PNG, chapter/ZIP rendered images, thumbnails and frontend download actions to the matching canonical artifact. Dispatch backend packaging and Reader download wiring as separate child packets. | Same page revision uses the same PNG digest everywhere. Pending/failed output is explicit; save/export cannot silently use a previous revision. |
| I04 | I03, D04 | Bind deterministic/optional visual QA to artifact revision/digest and separate correctness, owner, cleanup, style and layout verdicts. | Old QA cannot approve a new edit. Missing translations count as missing, policy skips separately, and visual QA never revives rejected SFX. |
| I05 | I04 | Remove unused PIL text-fitting/drawing code and final-render-only dependencies after checking callers in `manga-tl-worker`; preserve image IO/masks/thumbnails. | New pipeline, retries and QA have no Python typography caller. Relevant worker full checks pass. |
| I06 | I03, I05 | Remove duplicate browser Canvas export typography and obsolete layout switches/helpers; retain the shared scene renderer and justified image operations. | Preview and all export entry points have one content/layout implementation. Frontend full checks and real-browser tests pass. |

G8 checkpoint: new-format save/export round trip, current-artifact identity across consumers, renderer call-graph audit and relevant full test results. Retire obsolete renderers in the implementation branch before release; historical evidence remains static files, not a fallback runtime.

### M9 — validate, regenerate and promote

J01–J03 and J05 are **coordinator-owned acceptance runs**, not code-rewrite assignments. Luna may execute one existing harness/batch and write one report per packet; the coordinator reviews visuals, failures, spend and promotion. J04 is bounded Luna tooling work. A run requiring a code fix returns to a separate task with reproduction and impact analysis. Long-running jobs save progress to disk; they do not require a single long agent turn.

| ID | Depends on | Bounded output / allowed seams | Task gate |
| --- | --- | --- | --- |
| J01 | I06 | Run all six originals and synthetic PDF cases end to end on the assembled amd64 stack; save source/reference/current-baseline/candidate sheets plus cleanup-only views. | All hard quality gates below pass; reviewer signs per-case ownership, cleanup, style, layout and policy. Old export comparisons are labelled historical. |
| J02 | J01 | Evaluate the frozen stratified holdout without tuning on its labels. Include JA/KO/ZH, dense/colored pages, decorated dialogue, SFX, thin strokes, close boxes and large images. | At least 20 held-out pages, coverage recorded. Any failure returns to the responsible task with a new regression; evaluate another reserved set after tuning. |
| J03 | J02 | Measure stage cache behavior, provider tokens/retries, throughput and memory under a bounded batch. | English edit reruns no OCR/translation/cleanup; preserve-SFX targets zero. Record p50/p95/cost per completed page and review rate. Bound memory/concurrency; do not claim hypothetical savings. |
| J04 | J03 | Add a corpus run manifest and dry-run enumerator in the corpus's standalone tooling. Inventory current sources again; choose new run paths and record expected IDs/hashes and estimated paid work. | No existing originals/references/evidence overwritten. Invalid source/reference lanes quarantined, not guessed. Resume skips only matching successful stage digests. |
| J05 | J04 | Execute the staged regenerated run, first a small canary then the remaining manifest; validate output coverage, archive format and provenance, then promote the run manifest. Coordinator owns promotion/submodule coordination. | Every requested page accounted for as pass/failure/review; required failures block promotion. Full-run metrics/actual spend and final app/worker/corpus revisions saved. No ARM64 gate. |

G9 checkpoint: signed six-page/holdout/full-run reports, required repository checks, coverage and cost accounting, manifest promotion and resumable run state. Corpus regeneration is a later execution task, not performed by creating this plan.

## Quality gate registry

These are proposed acceptance requirements to freeze with A09; they are not measured achievements. Six curated cases are hard regression gates. Larger-set scores are reported separately and cannot hide a failing curated case in an average.

| Gate | Required evidence and pass rule |
| --- | --- |
| G0 — credible baseline | Fresh current-checkout stages for six exact source hashes; runtime/font/model provenance; real service preflight; reviewed labels and held-out IDs. Unknown mappings/timestamps remain unknown. |
| G1 — contract | Same valid/invalid fixtures accepted/rejected by backend, worker and browser. Finite fractional geometry retained; angle error ≤0.1°; policy/asset/source identity checked. Only new-format round trip required. |
| G2 — freshness | Real service tests for all edit kinds, deduplication, failure, retry, concurrent edit and out-of-order completion. Artifact revision/digest equals the requested revision; old callbacks never mark newer state complete. |
| G3 — SFX | Preserved/review SFX has zero translation target IDs/raw repeated-manifest entries; contract-level cleanup/object authorization denies it. Integrated zero-asset/object and preserved-pixel checks repeat at G6/G8/J01. Zero falsely suppressed reviewed dialogue. Record classifier precision/recall, review rate, actual tokens and skipped-policy counts. Full-page image inputs may still carry SFX visually. |
| G4 — renderer | Pinned browser/fonts and repeated-input render; actual ordinary/large PNGs; geometry diagnostics; no UI/OCR layers. A service limit/timeout produces a failure, not a fallback render. |
| G5 — ownership | Zero known cross-owner/panel/container merges in six fixtures and adversarial tests; all annotated fragments accounted for. All reviewed same-unit joins correct, or explicitly unresolved and blocking acceptance until reviewed. Track false splits as well as false merges. |
| G6 — cleanup | Clean plate identical to source outside approved alpha support, excluding no arbitrary rectangle. Proposed glyph-mask recall ≥98% on reviewed masks with a fixed 1px boundary tolerance; off-target support reviewed before reconstruction. No visible source lettering/outline remnants or unacceptable invented/broken art in reviewed crops. Pixel recall alone cannot pass visual cleanup. |
| G7 — composition/editor | Zero unreported automatic glyph overflow/collisions on curated owners; test actual glyph bounds with ≤1px raster-edge tolerance. Angle ≤0.1°, resolved geometry ≤1px across preview/export, identical line breaks for the same fonts. Reviewed minimum size, hierarchy, colors/strokes and whitespace pass. Moves, visibility, undo and padding persist; handles are separate from masks. |
| G8 — output consistency | PNG/chapter/ZIP/thumbnail/QA derive from the same current canonical artifact; editor uses the same scene/layout. New archive round trip works. Required tests actually execute. Call audit finds no alternate final typography loop. |
| G9 — release/regeneration | Six fixtures, ≥20 frozen holdout pages, then full regenerated manifest accounted for. Zero hard invariant failures; unresolved required regions/pages block promotion. Record stage time/tokens/retries/review rate, effective fonts and runtime. Set throughput/cost ceilings from measured G0/G4 and available hardware before J03; do not invent a speedup target. |

For G4/J03 resource checks, test the largest source in the chosen manifest as well as sample93, at one and then two concurrent renders only if capacity permits. Reserve headroom (target peak RSS ≤80% of the configured memory limit), record cold start and warm p95, and check a repeated batch returns to a bounded idle footprint. Failure is a capacity finding to fix or an explicit supported-size limit to review, not permission to downsample silently. ARM64 import/QEMU smoke tests cannot satisfy these quality or performance gates.

Do not use Torii whole-image similarity, polygon area, raw region count or total changed pixels as the primary score. Torii is a comparison baseline. Untouched untranslated text and missing translations must not improve the quality score. Capture cleanup-only and final images separately; report model/recognition failures and abstentions rather than burying them in visual metrics.

## Per-fixture acceptance checklist

| Fixture | Required outcome |
| --- | --- |
| sample177 | Six illustration labels retain six owners and illustration associations; headings separate. Use one verified source lane: its historical project original differs slightly from the corpus source. Do not set total OCR count to Torii's object count. |
| sample222 | Cover text blocks retain local position/angle/style; no page-spanning automatic cover. Annotated artwork survives; replacement glyphs stay in their allowed containers. |
| sample61 | Every paragraph stays within its own dark container; no border crossing or owner merging despite nearby/overlapping boxes. Readable size and intentional spacing, not maximal fill. |
| sample99 | Source outline cleanup and replacement stroke/color reviewed separately; preserved SFX unchanged; no large automatic polygon replacing the background. |
| sample93 | No cross-composition owner grouping. Visibility/rejection restores the correct original or remaining cleanup; large-page rendering completes within the measured capacity. |
| sample83 | Left/right local owners separate, central art protected, cleanup cannot overpaint translated glyphs. |
| PDF-derived scenes | Automatic whitespace has no blank plate; explicit manual cleanup works; 186.43×187.91 geometry at 12.5° survives new-format save/import/export; narrow/connected containers, four normal corner handles, padding/overflow/underfill and edit-during-render tested. Screenshots alone do not establish hidden source geometry. |

## Commands and verification discipline

Starting commands, from the parent root:

```bash
git status --short
git submodule status
git log -1 --format=fuller
git -C worker log -1 --format=fuller
git -C corpus log -1 --format=fuller
```

Existing deterministic investigations can be rerun with the root `.venv`; read their limits in the investigation. A01/A02 must add the missing real-service/current-stage coverage. Do not equate replaying archived elements with rerunning OCR.

Existing focused test commands (choose the affected set; new gates need new tests):

```bash
# frontend/ cwd
npm test -- src/__tests__/utils/fitText.test.ts src/__tests__/utils/textFitBox.test.ts
npm test -- src/__tests__/utils/maskPaint.test.ts src/__tests__/components/ReaderExportZip.test.tsx

# worker/ cwd; project root venv only
../.venv/bin/python -m pytest -q tests/test_translation_pipeline.py tests/test_translation_flow_e2e.py
../.venv/bin/python -m pytest -q tests/test_merge_regions.py tests/test_fragment_grouping.py tests/test_ocr_grouping_wiring.py

# backend-rust/ cwd; isolated services must be verified first
cargo test --test jobs_endpoints recovery_reset_stale_and_debounced_render
cargo test --test pages_endpoints rendered_output_reaches_the_page_grid
```

Backend integration tests currently use `SPRING_DATASOURCE_URL` in JDBC PostgreSQL form, separate username/password variables, and some require `REDIS_TEST_ADDR`. Several return early without those services. A01 must inspect the exact test's storage/env requirements, provision an isolated database/queue/bucket, verify a sentinel, and report **executed/passed/failed/not-executed** separately. Do not print credentials or use the user's normal database for test cleanup.

At an affected milestone, run frontend `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`; worker root-venv `ruff check .`, `ruff format --check .`, `pyright .`, `pytest -q`; backend `cargo fmt --check`, applicable lint/build and full tests with required services. Use the repository CI's actual flags and record preexisting failures separately. New renderer package/service gets its own typecheck, focused tests and real Chromium smoke suite in E03. Run real browser editing/export scenarios in M7–M9. No docs-only planning change requires these application suites now.

For backend API changes, run the backend container and `npm run generate-api` from `frontend/`, checking the live OpenAPI URL and generated diff. Do not hand-edit generated schemas. Every code task ends with focused verification; broaden at milestone boundaries or when failures/new changes justify it.

## Durable checkpoint template

Each agent fills this in `docs/quality-checkpoints/<TASK-ID>.md` and returns a short handoff. Link larger reports instead of copying the entire task history into every agent context.

```markdown
# <TASK-ID>: <one behavior>
Status: ACTIVE | REVIEW | DONE | BLOCKED
Date / app head / worker head / corpus head:
Allowed files and actual changed files:
Prerequisites and input artifact hashes:
Current-checkout reproduction (command, observed result):
GitNexus impact (repo, symbols, callers/processes, risk, freshness):
Implementation decision and schema/config/model/font versions:
Validation commands and executed/pass/fail/not-executed counts:
Before/after metrics and artifact paths:
Quality-gate result and reviewer:
Remaining uncertainty or blocker:
Exact next command and expected result:
Files/worktree that must be preserved:
```

For every model/browser/batch run also persist a machine-readable manifest with per-stage hashes, timing, cache-hit reason, token/call counts and outcome per expected region/page. Save before starting another major checkpoint so a usage interruption loses no diagnostic state.

## Resume packet

> Read this tracker, the latest completed task checkpoint and the relevant source seams. Recheck app/worker/corpus heads. Start **A01 only**, using Luna medium with a bounded path list. Establish isolated test services and runtime provenance; do not implement rendering/grouping fixes or regenerate the corpus yet. After A01's evidence is reviewed, mark A02 ready. For later sessions, choose the next dependency-satisfied task, reproduce it on that checkout, run upstream impact, implement only that task and save its checkpoint before stopping. If a behavior already passes, retain a regression check and remove the obsolete fix from the task scope.

Planning checkpoint: all ten milestones and 58 task cards are specified; implementation and quality gates remain pending. The corpus cutoff and ARM64/new-format scope are integrated. Dependency, local-link, timestamp/Git and clean-submodule checks passed; see the [planning validation record](quality-evidence/implementation-plan-validation.json). Update the milestone table with checkpoint links as work passes review.
