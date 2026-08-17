# Archive

Finished, superseded and closed work. **Nothing here describes current behaviour** — read it for
the reasoning and the measurements, not for how the system works today. For that, see
[`../reference/`](../reference/).

Kept rather than deleted because most of these documents record a *measurement* or a *negative
result*, which is the expensive part and the part worth not repeating.

## The full record

- [`history.md`](history.md) — the running log of every closed item, failed experiment and
  reverted change. Large. Was `docs/archive.md`.

## Session handoffs

Written to hand a sitting to whoever picked it up next. Historical.

- [`session_handoff_2026-08-10.md`](session_handoff_2026-08-10.md) — branch map across both repos,
  and why `ocr-pre-grouping-baseline` exists.
- [`next-step.md`](next-step.md) — 2026-08-08, the twenty-first sitting. Closed the loaded-prefix
  bug family (five bugs, one root cause).
- [`ocr_region_handoff_2026-08-08.md`](ocr_region_handoff_2026-08-08.md) — corpus rebuild plus
  three open region bugs, with a command crib.
- [`free_model_bench_handoff_2026-08-07.md`](free_model_bench_handoff_2026-08-07.md) — the free-model
  candidate pool refresh and the Phase A+ run against curated pages.

## Performance work (2026-08-01 → 08-03)

All of it shipped; the numbers are still the reference points quoted in TODO.md.

- [`perf_analysis_backend_2026-08-02.md`](perf_analysis_backend_2026-08-02.md) — the first run that
  drained to idle. Source of the "worker pull recovers 0.83%" finding.
- [`perf_analysis_frontend_2026-08-02.md`](perf_analysis_frontend_2026-08-02.md) — Firefox profile
  analysis; found the permanent CSS animation costing 27.8% of a core.
- [`perf_plan_2026-08-02.md`](perf_plan_2026-08-02.md) — the day's execution order. Done.
- [`reader_perf_plan_2026-08-03.md`](reader_perf_plan_2026-08-03.md) — reader research against
  nhentai / MangaDex / cubari. Items 1–6 all shipped. Kept for the reader-design research.
- [`comparison.md`](comparison.md) — WebP for the reader: measured, decided, shipped. Corpus went
  1.142 GB → 0.266 GB. **Closed.**

## OCR region grouping (2026-08-08 → 08-09)

The chain that produced the current `OCR_MERGE_THRESHOLD`. Read in this order:

1. [`region_proposal_defects_2026-08.md`](region_proposal_defects_2026-08.md) — the original
   framing, **partly wrong**; its own header says where.
2. [`region_threshold_validation_2026-08-08.md`](region_threshold_validation_2026-08-08.md) —
   validated the threshold across seven pages.
3. [`region_merge_prior_art_2026-08-08.md`](region_merge_prior_art_2026-08-08.md) — why everyone
   else can use a 1.5–4× character-size budget and we cannot.
4. [`research_brief_region_merging.md`](research_brief_region_merging.md) — the self-contained
   brief handed to a deep-research agent.
5. [`region_grouping_plan_2026-08-09.md`](region_grouping_plan_2026-08-09.md) — what to change and
   how to know it worked.
6. [`region_waist_probe_2026-08-09.md`](region_waist_probe_2026-08-09.md) — the result: bubble-mask
   clearance separates balloons at a 1.6% error rate, text-gap distance at 17.8%.

> Two PDFs cited by items 3 and 5 (the MANPU 2020 paper, and the deep-research report) were
> untracked local copies and have been deleted. The papers are findable by title; the report's
> conclusions are summarised in item 5.

## Benchmarking history

- [`corpus_benchmark_rework_2026-08-07.md`](corpus_benchmark_rework_2026-08-07.md) — the plan that
  produced today's `corpus/` layout, the unified runners and the QA bench. Executed. Was
  `we-already-have-benchmarking-replicated-aurora.md`.
- [`free_openrouter_translation_benchmark_2026-08-06.md`](free_openrouter_translation_benchmark_2026-08-06.md)
  — 14 free OpenRouter models on one hand-made page. **Superseded** by
  [`../free_model_bench_plan_2026-08.md`](../free_model_bench_plan_2026-08.md); kept because it is
  the report that motivated building a repeatable benchmark at all.
- [`benchmarking.md`](benchmarking.md) — the original OCR/VLM benchmarking walkthrough.
  **Superseded** by [`../guides/run_ocr_bench.md`](../guides/run_ocr_bench.md), which covers the
  same scope and is the one [`../guides/benchmarks_guide.md`](../guides/benchmarks_guide.md) points at.

## Other

- [`frontend_improvements.md`](frontend_improvements.md) — 2026-08-04 backlog from reading this
  frontend against `yt-diff`'s. Never tracked in TODO.md; a source of ideas, not commitments.
