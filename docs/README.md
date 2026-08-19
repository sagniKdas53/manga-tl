# Documentation

Everything in here is one of four things, and the folder says which:

| Folder | What it holds | Trust it to be… |
| --- | --- | --- |
| *(this level)* | Live work: open bugs and the plans being executed right now | **current** |
| [`reference/`](reference/) | How the system works today | **current** |
| [`guides/`](guides/) | How to run or verify something | **current** |
| [`design/`](design/) | Designed, argued for, **not built** | a proposal, not a description |
| [`archive/`](archive/) | Finished, superseded, or closed | a record of what happened, not of what is |

If a document contradicts the code, the code wins and the document is a bug. File it in
[`issues.md`](issues.md).

> **Open items were re-verified against the code on 2026-08-17.** Most held; four were wrong and
> have been corrected in place (`D8` and `D10` are part-done, `D16`'s title was misleading, and
> `mock-router` Phase 0's first half is fixed). Anything marked `[/]` in TODO.md is partly done,
> with the still-open half named.

---

## Start here

| I want to… | Read |
| --- | --- |
| See what's broken or outstanding | [`issues.md`](issues.md) · [`../TODO.md`](../TODO.md) |
| Understand the whole pipeline | [`reference/translation_pipeline_phases.md`](reference/translation_pipeline_phases.md) |
| Configure the worker | [`reference/configuration_guide.md`](reference/configuration_guide.md) |
| Run the checks before committing | [`guides/quality_gate.md`](guides/quality_gate.md) |
| Benchmark a model | [`guides/benchmarks_guide.md`](guides/benchmarks_guide.md) |
| Know why output looks worse than a paid product | [`render_quality_gap_2026-08-05.md`](render_quality_gap_2026-08-05.md) |

---

## Live work

These are the only documents describing work that is **currently open**.

- [`issues.md`](issues.md) is the bug and audit register. 66 filed, 59 closed, **7 open**, none
  critical or high. Resolved items move to [`archive/history.md`](archive/history.md) rather than
  staying here marked done.
- [`render_quality_gap_2026-08-05.md`](render_quality_gap_2026-08-05.md) covers the measured gap
  against mangatranslator.ai and human scanlation, defects `D1`–`D16`, and the phase plan. This is
  the largest open workstream; TODO.md § "Render quality gap" tracks the items.
- [`free_model_bench_plan_2026-08.md`](free_model_bench_plan_2026-08.md) is the plan to re-run the
  free-model benchmarks across OpenRouter, NVIDIA and Cloudflare. **Prerequisite done 2026-08-07;
  phases A/B/C have never been run.** Not tracked in TODO.md; decide whether it is still wanted.

## Reference: how it works

| Document | Covers |
| --- | --- |
| [`reference/translation_pipeline_phases.md`](reference/translation_pipeline_phases.md) | The phases a page moves through, the QA sub-pipeline, and where thumbnails fit |
| [`reference/configuration_guide.md`](reference/configuration_guide.md) | Worker configuration for the OCR, translation and QA stages |
| [`reference/worker_provider_integration.md`](reference/worker_provider_integration.md) | How the worker talks to LLM providers: payloads, failover, retries, `providers.json` |
| [`reference/models_and_prompts.md`](reference/models_and_prompts.md) | Every local and cloud model in use, and the prompts driving them |
| [`reference/slot_allocation.md`](reference/slot_allocation.md) | The heavy/light dual-slot concurrency model and how to tune it |
| [`reference/duplicate_handling.md`](reference/duplicate_handling.md) | What happens when the same image is uploaded twice, and layer cloning |
| [`reference/security_boundary.md`](reference/security_boundary.md) | Which routes are public **on purpose**. Read before "tidying up" an open endpoint |
| [`reference/webp_thumbnail_encoding.md`](reference/webp_thumbnail_encoding.md) | Why the backend uses `gotson/webp-imageio`, with Alpine-vs-glibc benchmarks |
| [`api/api_evaluation_report.md`](api/api_evaluation_report.md) | REST API review, alongside the generated [`api/openapi.json`](api/openapi.json) |

## Guides: how to do a thing

| Document | Covers |
| --- | --- |
| [`guides/quality_gate.md`](guides/quality_gate.md) | The checks every phase must pass. Run sequentially; this host locks up under parallel load |
| [`guides/testing_isolation_guide.md`](guides/testing_isolation_guide.md) | How the three test suites avoid touching the running stack |
| [`guides/benchmarks_guide.md`](guides/benchmarks_guide.md) | **The map.** Three benchmarks, one per stage, all the same shape. Start here |
| [`guides/translation_bench.md`](guides/translation_bench.md) | Translation stage: deep dive |
| [`guides/run_ocr_bench.md`](guides/run_ocr_bench.md) | OCR stage (local engines + VLM-as-OCR): deep dive |
| [`guides/qa_bench.md`](guides/qa_bench.md) | QA stage: deep dive |
| [`guides/perf_run_playbook.md`](guides/perf_run_playbook.md) | Recording a pipeline run with enough fidelity to analyse it afterwards |
| [`guides/ollama.md`](guides/ollama.md) | Configuring and verifying the remote Ollama host |

## Design: proposed, not built

Nothing in this folder describes running code. Each says so in its own header.

- [`design/mock_router.md`](design/mock_router.md) is a deterministic LLM provider mock so the
  pipeline can be tested end-to-end with no API spend. Phased; tracked in TODO.md § Testing & QA.
- [`design/worker_pull_model.md`](design/worker_pull_model.md) moves job handoff from
  backend-push to worker-pull. **Measured value is 0.83% of queue wait**, so it is worth building
  for tail latency and multi-worker resilience, not for throughput.
- [`design/migration.md`](design/migration.md) is an old sketch for moving the backend off
  Java/Spring. Treat as a starting point, not a current plan.

## Archive

Finished, superseded and closed work. See [`archive/README.md`](archive/README.md) for the index.
The big one is [`archive/history.md`](archive/history.md), the full record of closed items.
