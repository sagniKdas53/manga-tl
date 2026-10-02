# Terra handoff: close G0 evidence gaps

## Mission and authority

Complete G0: a trustworthy current-pipeline baseline and an honest, independent evaluation procedure. **Do not fix output quality in this assignment.** Bad baseline output is useful evidence; G0 does not require the later renderer, grouping, SFX or cleanup improvements to pass.

The user authorized this documentation/handoff. It does not authorize unlimited provider spend. Use an existing explicit budget if one applies; otherwise present the bounded rerun plan and request one batch spending approval before paid calls. Continue unpaid tooling and evidence work while approval is pending.

Read [G0 review](G0.md), the [tracker](../output-quality-implementation-tracker.md), and [A09's current instruction](A09.md) first. Those current instructions supersede historical checkpoint conclusions. Read relevant repository rules and quality-holdout, Python-isolation, Compose and browser skills before the corresponding work. Use the root `.venv`; no global installs. Run required symbol impact/reference checks before code edits.

## Facts already established — do not restart the investigation

- The retained evidence is real: 428 artifact hashes and all six A09 manifest input hashes matched during review. Development/A09 source IDs and bytes do not overlap.
- Keep the six originals: sample177, sample222, sample61, sample99, sample93, sample83. Keep all 24 controls in [resolved-selection.json](../quality-evidence/style-coverage-20260910/resolved-selection.json). They are two separate reporting populations.
- Original/control captures used worker `7d70b64`. G0 pins `7b54f8c`, which adds a real `should_typeset_region` eligibility change alongside OCR instrumentation. The guard rejects recorded mixed-script original inputs; this is not a sample47-only change. The old sample47 snapshot, not its corrected r3 run, was used for threshold derivation.
- A09 already has 30 frozen roster pages, 10 per language, 346 reviewed labels, and 47 staged reserves. Do not source replacements or repeat reference acquisition. The 34 roster `review` regions remain unresolved, pixel-preserving cases; reserve labels remain drafts.
- Saved development metrics reproduce, but describe rectangles/metadata. The scorer does not consume reviewed owner/action labels, misnames multiple-elements-per-region as merged owners, skips two threshold checks and passes missing font measurements.
- All 30 browser-font inventories list 38 registered faces but only 8 loaded. Only sample416/sample609 have a non-null stored font-size minimum. Neither fact establishes the final fitted font size or a universal 24 px readability floor.
- The old A09 threshold file says `frozen-pending-coordinator-approval`. Preserve it and every manifest-pinned artifact unchanged. A corrected evaluation package must be a linked, versioned successor derived only from development evidence.

## Scope boundaries

Allowed work: existing capture/preflight/scoring/evidence tooling under `scripts/`; narrowly necessary non-behavioral observation hooks; focused regression checks; new run-specific evidence; G0/A09/tracker documentation and a versioned evaluation correction. Prefer existing tooling over new infrastructure.

Starting seams: `scripts/score_page_quality.py`, `scripts/playwright/capture_quality_baseline.cjs`, `scripts/playwright/export_pending.cjs`, the existing quality preflight/dev setup tools, and retained manifests. Read each actual interface before using it; do not invent CLI flags. Preserve exact six-source identity, especially sample177's corpus-source lane.

Out of scope: changing production OCR/grouping/typesetting policy, selecting new models, fixing the current eligibility guard, building the canonical renderer, changing APIs/archive formats, corpus-wide regeneration, ARM64 work, new source acquisition, artist/creator provenance research, and evaluating/tuning on A09 roster or reserves. If an observed quality defect belongs to M1–M8, record it against that task and leave it alone.

## Ordered work packets

### G0-R1 — pin the execution inputs

Record current app/worker/corpus revisions and relevant uncommitted changes once. Include the real `backend-rust/` path, frontend, worker, build/runtime configuration and observation-tool revision in the scope assessment. Do not reset unrelated user work.

Create one run-specific closure directory under `docs/quality-runs/` and a manifest enumerating all 30 development source IDs/hashes and their required stages/exports. Record the planned run and paid work before launching it. Default to fresh capture of pre-change development pages on one pinned runtime; reuse only evidence with demonstrated matching source/config/model/behavior provenance. Do not spend the task trying to prove speculative equivalence. Keep any reused page and its justification explicit.

### G0-R2 — make capture and measurement truthful

Correct the existing tools before the paid batch so it does not need to be repeated for missing metadata:

- Capture actual stage timestamps, model/provider identifiers, local model/config/prompt digests where accessible, resolved settings, app/worker revisions, container image identities, actual CPU/GPU execution provider, browser version, effective font assets/hashes, per-stage outcomes/timings and available token/retry data. Distinguish unavailable remote provider internals from locally obtainable provenance; never invent remote weight hashes or block on them.
- Count loaded fonts separately from registered fonts. Record final fitted font data when the current surface exposes it; otherwise say unknown. Do not treat stored `size` as measured glyph size.
- Give rectangle metrics accurate names/definitions. Use explicit reviewed owner/action associations for owner and policy measurements. If those associations cannot be established, report unresolved coverage instead of guessing from OCR IDs, order or proximity. Count missing expected replacement text separately from policy-preserved text so omissions cannot improve the score.
- Check real source/export dimensions, page-level overlap incidence and every declared supported threshold. Read bounds from the approved artifact rather than displaying one bound while executing another. Missing required inputs/checks must be unknown/not executed or an evaluation failure, never silently passing.
- Report per page, language and available reviewed style/layout slice. Keep controls and original defect cases separate. Distinguish a successful baseline measurement run from a quality pass.
- Implement and exercise manifest-selected candidate input handling using development/synthetic inputs: required IDs/source hashes/artifacts/revisions must match; missing, duplicate, wrong-source and stale candidates must fail visibly. Reserves/extraneous pages must not silently enter scoring. Never test this by scoring the actual A09 outputs.

Do not implement the future renderer or full glyph-mask evaluator just to fill unavailable current fields. Record which later G5/G6/G7 evidence requires actual glyph/pixel review, the measurement method and the responsible gate. Unknown current measurements cannot satisfy those future gates. A narrowly scoped manual visual protocol is preferable to a fake automatic score.

Keep regression checks for the demonstrated scorer failures and manifest selection boundaries. Exercise the real corrected capture path on a development page; helper tests alone do not establish runtime/font provenance.

### G0-R3 — capture and account for the development baseline

Provision or reuse an explicitly isolated amd64 quality stack with separate DB/queue/storage. Save actual preflight output, including DB sentinel, Redis round trip and storage object round trip in the isolated namespace. Never clean the user's normal database or volumes. Do not print secrets.

Run one development canary to prove capture completeness, then the remaining required pages one at a time. Capture fresh source-to-OCR-to-translation-to-cleanup/render output plus actual browser editor/PNG/project exports. Use the existing capture harness, not a new batch framework. Pin the available model/config and disclose differences from historical runs; no silent fallback to old OCR or another model.

Record success/failure/review per page and stage as work finishes. Persist source/snapshot/export/ZIP hashes, provider calls and provenance before moving on. Keep artifacts from failed attempts too. Do not mix snapshots or outputs from different attempts. Resume only matching completed entries; no repeated successful paid pages just because the coordinator restarted.

Bad translations, white plates, known merges and overflow are baseline findings, not reasons to alter the pipeline or rerun indefinitely. A missing stage/export or unavailable required service is an evidence failure and cannot pass G0. If an existing capture bug prevents observing a completed stage, fix only that harness bug with focused verification.

### G0-R4 — reconcile labels and freeze the evaluation correction

Keep source-authored labels and immutable images. Fresh OCR UUIDs or changed grouping require an explicit mapping from reviewed source owners/actions to the new regions; map many-to-one failures honestly. Never copy old UUIDs by array position or quietly redefine owners to fit output. Keep unresolved assignments visible and pixel-preserving. Ask for human source interpretation only where needed, using a small annotated crop and a precise question.

Remeasure the 24 controls with the corrected tool. Report the six originals separately. Prepare a versioned evaluation correction linking the old manifest/threshold digests, new development baseline, metric definitions, coverage, proposed bounds, reviewer and approval state. Preserve the original frozen JSON and its hashes. The successor must unambiguously pin the unchanged roster/labels and the corrected protocol/thresholds used at J02.

Separate baseline non-regression bounds from final quality requirements. Do not weaken the tracker's hard ownership/policy/pixel constraints to accommodate the baseline. Obtain human approval only for genuinely subjective readability/style choices that existing instructions do not resolve. Keep a precise pending decision instead of fabricating approval.

### G0-R5 — independent review and final checkpoint

Have a separate reviewing agent verify the corrected metrics, artifact identities, all-30 page accounting, source-label reconciliation, provenance and holdout isolation. It must inspect evidence, not just accept the implementation agent's report. Review representative source/baseline images across JA/KO/ZH and every original defect class; do not score A09 outputs.

Update G0, A09 and the tracker with the exact run paths, measured results, remaining limitations, reviewer, and the actual tested evaluator command for later J02 use. No recursive scoring of the old 77-page directory. Keep J02 after G1–G8 and reserves out of development/model selection. Mark G0 passed only when the finish line below is met; do not begin B01 within this assignment.

## Staying focused and making progress

- Every action must close one of R1–R5. Before expanding scope, name the required evidence it supplies. Park unrelated findings against their later task rather than fixing them now.
- Do not repeatedly audit unchanged hashes, re-read the whole repository, reindex for docs-only changes, research optional provenance or run unrelated full test suites. Follow required repository checks for actual changes; report unrelated preexisting failures separately.
- If a command fails, inspect the concrete error and correct that prerequisite. Do not repeat the same unchanged command indefinitely. After repeated failure without new evidence, save the blocker and continue an independent packet; try a supported alternative where available. Never bypass source identity, isolation, missing stages or failed required checks to manufacture a pass.
- Continue normal technical work without asking permission at every step. Escalate only unavailable credentials/services after reasonable diagnosis, necessary paid-run authorization, a material scope change or a genuine human visual/source judgment. Ask once with evidence, a recommended choice and its consequence.
- One coordinator owns the manifests, thresholds, tracker and integration. If delegation helps, use at most two implementation agents with disjoint files and explicit contracts. Do not let agents concurrently alter shared manifests or production behavior during capture. Serialize integration and run final checks once.
- After each packet and completed/failed page, persist progress. On interruption, resume the existing manifest rather than start a new investigation. Never rely on chat history as the only record.

## Resume record

Keep the current state at the end of G0.md and in the run manifest: active packet; run directory; pinned revisions/runtime; expected/completed/failed/pending page IDs; changed files; validation performed; spend so far if available; exact next tested command and expected result; blockers and their required decision. Another agent must be able to resume without repeating successful model calls.

## Finish line

G0 may pass when all of these are evidenced:

- All six originals and 24 controls are accounted for by source hash with defensibly current, complete stage/editor/export evidence and recorded provenance. Any reused evidence has a concrete equivalence justification, not a later app-only diff.
- Real isolated service checks and capture smoke evidence are retained. Local effective fonts/models/runtime are identified; unavailable information remains explicitly unavailable.
- Development source-owner/action mappings are reviewed or explicitly unresolved. Known quality defects remain recorded rather than silently fixed, relabelled or treated as passes.
- Corrected measurements reproduce, describe what they actually measure, report missing data honestly and separate language/style slices and the two development populations. No claimed passing metric is actually unmeasured.
- A versioned, explicitly approved evaluation correction defines development-derived bounds, future hard-gate measurement methods and roster-only candidate evaluation. The original frozen artifacts remain intact; A09 has not been scored or used for tuning.
- An independent reviewer signs the evidence and G0/A09/tracker statuses agree. Necessary human judgments are resolved; optional metadata and later quality defects do not block this baseline gate.

If a genuine external prerequisite prevents closure, complete every reachable packet, leave G0 in REVIEW/BLOCKED with the exact missing evidence and next action, and report it honestly. Do not substitute a documentation-only pass. Final delivery: concise changes, verification, new artifact paths, spend, remaining uncertainties, reviewer verdict, and whether G0 really passed.
