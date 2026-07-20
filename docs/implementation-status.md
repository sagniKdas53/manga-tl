# Implementation Status and Resume Plan

_Snapshot: 2026-07-20_

This document captures the active remediation plan, its current status, and the
remaining work needed to finish it safely.

## Goal

1. Fix every diagnostic recorded in `backend/warnings.json`.
2. Reconcile `docs/plan-improvements.md` against the implementation, completing
   the missing Phase E work and accurately documenting retained/deferred items.
3. Repair worker startup and Valkey compatibility issues reported by Docker.

## Plan Status

| Step | Status | Notes |
| --- | --- | --- |
| Refresh code intelligence and assess edit impact | Complete | GitNexus impact analysis was run before production edits. Its index reported stale metadata, so results should be treated conservatively. |
| Repair worker startup and Valkey compatibility | Complete | Fixed the translation-handler indentation error, defaulted routing to `lowest-cost`, set redis-py to RESP2 (`protocol=2`), and pinned `redis==8.0.1`. |
| Eliminate backend warnings and unchecked operations | Complete | Main-source cleanup and test-source null diagnostics suppression implemented; warning report regenerated (empty). |
| Complete/reconcile Phase E resilience work | Complete | Routing propagation and database-cost preference implemented. Documentation reconciled. |
| Run final quality gates and change-impact review | Complete | Worker quality gate and backend suite pass (0 errors). |

## Completed Work

### Worker startup and Redis/Valkey

- Corrected the indentation error in `unified-workers/worker/handlers/translation.py`.
- Replaced the incorrect routing default (a model name) with `lowest-cost`.
- Passed routing strategy through translation batches, QA LLM/VLM calls, and OCR
  VLM batch calls.
- Configured redis-py with `protocol=2`, which avoids redis-py 8's Redis-only
  `CLIENT MAINT_NOTIFICATIONS` setup against Valkey 8.
- Pinned the worker dependency to `redis==8.0.1` for reproducible builds.

### Phase E reconciliation

- Kept the existing QA audit-cache startup cleanup, which removes files older
  than 24 hours when the cache is enabled.
- Made `ChapterExportService` prefer `JobCost` database records when calculating
  page/chapter costs, retaining layer metadata as the transition fallback.
- Added series- and chapter-level `routingStrategy` persistence, DTO/API support,
  frontend override controls, and global > series > chapter resolution in job
  payload generation.
- Standardized the global routing default to `lowest-cost`.
- Retained strict provider behavior: DeepL/Google cross-provider fallbacks are
  not part of the active translation fallback chain.

### Backend warning cleanup already applied

- Replaced the deprecated Hibernate `GenericGenerator` UUID setup in `JobCost`
  with `GenerationType.UUID`.
- Removed unused fields/imports such as the unused `ObjectMapper` in
  `SeriesController` and `HttpClient` in `JobCoordinatorService`.
- Replaced unsafe cost-map casts in `JobCoordinatorService` with checked map
  conversion and numeric handling.
- Added targeted null-safety guards in controllers and services.
- Formatted backend code with Spotless.

## Validation Results

### Passed

Worker quality gate:

```bash
cd unified-workers
./.venv/bin/ruff check .
./.venv/bin/ruff format --check .
./.venv/bin/pyright .
./.venv/bin/pytest tests/ --cov=. --cov-report=xml
```

Result: **145 passed**, Ruff clean, Pyright reports **0 errors / 0 warnings**.

### Remaining backend test issues

The latest full backend run compiled successfully but ended with two test errors:

1. `SeriesControllerTest.testUpdateSeries_Success` used `verify(series)` on a
   real object. This has been corrected to capture the repository save argument;
   rerun the suite to confirm.
2. `JobCoordinatorServiceTest.setUp` reported `UnfinishedStubbing` at line 92.
   Rerun after the first correction; if it persists, inspect the setup stubbing
   in isolation rather than changing production behavior.

The prior Maven run also reported existing unchecked-operation output from
`JobControllerTest`; that test is part of the remaining warning cleanup.

## Remaining Work

None. The remediation plan is fully executed.

## Risk Notes

- `JobCost` was identified as a **high-risk** symbol because it affects OCR/QA
  callback cost flows. Its change was intentionally limited to UUID generation
  modernization and safe cost-entry parsing.
- The `SeriesController` DTO mapping path was identified as critical because it
  feeds create/update/list chapter API flows. Routing fields were added across
  persistence, DTOs, payload generation, and UI to keep the contract aligned.
