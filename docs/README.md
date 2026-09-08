# Documentation

Organization of project documentation:

| Folder | Contents | Status |
| --- | --- | --- |
| *(this level)* | Active tracking: issue tracker, live plans, and visual gap analyses | Current |
| [`reference/`](reference/) | Technical specifications of existing implementations | Current |
| [`guides/`](guides/) | Runbooks, quality gates, and benchmarking procedures | Current |
| [`design/`](design/) | RFCs and proposals for future architectural work | Proposed (not implemented) |
| [`archive/`](archive/) | Historical implementation plans, migration notes, and session handoffs | Archived records |

If documentation contradicts the code, the code is authoritative. File discrepancies in [`issues.md`](issues.md).

---

## Quick Reference

| Task | Document |
| --- | --- |
| Outstanding defects & audit status | [`issues.md`](issues.md) · [`../TODO.md`](../TODO.md) |
| Pipeline architecture & stages | [`reference/translation_pipeline_phases.md`](reference/translation_pipeline_phases.md) |
| Concurrency & dispatch slot model | [`reference/slot_allocation.md`](reference/slot_allocation.md) |
| WebP thumbnails & cache endpoints | [`reference/webp_thumbnail_encoding.md`](reference/webp_thumbnail_encoding.md) |
| Public routes & security boundaries | [`reference/security_boundary.md`](reference/security_boundary.md) |
| Pre-commit quality gates | [`guides/quality_gate.md`](guides/quality_gate.md) |
| Render quality evaluation (D1–D16) | [`render_quality_gap_2026-08-05.md`](render_quality_gap_2026-08-05.md) |
| Canvas & layer fixes (2026-09-06) | [`canvas_render_fixes_2026-09-06.md`](canvas_render_fixes_2026-09-06.md) |

---

## Live Work & Tracking

- [`issues.md`](issues.md): Defect register and audit tracker. 114 filed, 85 closed, 29 open.
- [`render_quality_gap_2026-08-05.md`](render_quality_gap_2026-08-05.md): Benchmark gap analysis against human scanlation and commercial tools (defects `D1`–`D16`).
- [`canvas_render_fixes_2026-09-06.md`](canvas_render_fixes_2026-09-06.md): Editor and renderer geometry fixes.
- [`PLAN_ocr-provenance_2026-08-30.md`](PLAN_ocr-provenance_2026-08-30.md): Region model provenance tracking plan.

---

## Technical Reference

| Document | Description |
| --- | --- |
| [`reference/translation_pipeline_phases.md`](reference/translation_pipeline_phases.md) | Phase sequencing, QA callback loops, `finalPass` terminal renders, and thumbnails |
| [`reference/slot_allocation.md`](reference/slot_allocation.md) | Dual-tier heavy/light slot concurrency model and dispatcher polling |
| [`reference/webp_thumbnail_encoding.md`](reference/webp_thumbnail_encoding.md) | Native WebP encoding in `thumbnails.rs` and `renderedThumbnailUrl` generation |
| [`reference/security_boundary.md`](reference/security_boundary.md) | Route-level authentication rules and public image asset endpoints |
| [`reference/configuration_guide.md`](reference/configuration_guide.md) | Worker configuration for OCR, translation, and QA stages |
| [`reference/worker_provider_integration.md`](reference/worker_provider_integration.md) | LLM provider integration, failover strategies, and credential resolution |
| [`reference/models_and_prompts.md`](reference/models_and_prompts.md) | Model registries and prompt templates |
| [`reference/duplicate_handling.md`](reference/duplicate_handling.md) | Deduplication on upload and layer cloning |
| [`reference/2026-09-06-torii-comparison/`](reference/2026-09-06-torii-comparison/) | Benchmark analysis comparing our rendering pipeline against Torii |

---

## Guides

| Document | Description |
| --- | --- |
| [`guides/quality_gate.md`](guides/quality_gate.md) | Pre-commit validation gates for frontend, backend, and worker services |
| [`guides/benchmarks_guide.md`](guides/benchmarks_guide.md) | Execution runbook for translation, OCR, and QA benchmark suites |
| [`guides/translation_bench.md`](guides/translation_bench.md) | Translation benchmark execution and metrics evaluation |
| [`guides/run_ocr_bench.md`](guides/run_ocr_bench.md) | OCR engine benchmark procedures |
| [`guides/qa_bench.md`](guides/qa_bench.md) | QA benchmark testing |
| [`guides/perf_run_playbook.md`](guides/perf_run_playbook.md) | High-resolution performance profiling runbook |
| [`guides/ollama.md`](guides/ollama.md) | Remote Ollama server setup and verification |

---

## Design Proposals (Unimplemented)

- [`design/mock_router.md`](design/mock_router.md): Deterministic wire-protocol mock for OpenAI/Anthropic APIs.
- [`design/worker_pull_model.md`](design/worker_pull_model.md): Transitioning dispatcher from HTTP push to worker-pull architecture.

---

## Archive

Completed implementation plans, migration designs, and handoffs are preserved in [`archive/`](archive/). Resolved defect history is cataloged in [`archive/history.md`](archive/history.md).
