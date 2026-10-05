# Cheap-model benchmark with quantization checks — runbook (not run yet)

Written 2026-10-05. **Nothing in this document has been executed.** It is a plan for a later session.
The survey numbers (prices, hosts, latency) were read from OpenRouter on 2026-10-05 and drift; Stage 0
re-reads them before anything is paid for.

## Why do this (output value)

This picks the model for `TL_LLM_MODEL`, `QA_VLM_MODEL` and their fallbacks, and the rule for which
OpenRouter host (and so which quantization) we allow. It can make outputs better in two ways: a better
translator, and no silent quality loss when OpenRouter routes us to a cheap 4-bit host. If no candidate
beats the current pins by more than the measurement noise, we stop and change nothing.

## Ground rules (from the user, 2026-10-05)

- **Out:** `anthropic/claude-sonnet-5.5`, `anthropic/claude-opus-5.5` (price, moderation). Also out by the
  same rule: `openai/gpt-6-luna` and `gpt-6.1-sol` (moderated), `grok-4.7` ($2/$6 is not cheap).
- **In:** flash and cheap models that do not nag about content. "Does not nag" is measured, not assumed
  (refusal gate, Stage 3).
- **Judge:** Claude in-session, or `xiaomi/mimo-v2.6-pro` pinned to `gmicloud/bf16` over the API.
  This plan uses both (Stage 4), because mimo is itself a candidate.
- **Quantization-aware:** every cheap model is also tested per hosting precision.
- Any single request over 60 s is a failure, however good the answer (standing benchmark rule).
  `bench_common.call_provider()` already enforces this with a hard timeout.

## What we have today

- Golden set: 45 pages, 218 bubbles, human English reference, JA/KO/ZH (15 each), in
  `corpus/translation/golden/<sample>/` (the `corpus` submodule). Evaluator:
  `corpus/scripts/benchmark_free_suite.py`; per-bubble score is `difflib` similarity to one human
  translation. That measures word overlap, not meaning, so it cannot rank models a few points apart.
  The committed leaderboards in `corpus/benchmarks/` predate three scoring fixes and are stale.
- `scripts/benchmark_translation.py` and `scripts/benchmark_qa.py` read models from
  `config/providers.json`. **Neither can pin a provider.** `--free-only` is on by default.
- The golden pages are SFW. The NSFW half (`corpus/samples/NSFW/`, 60 dirs) has **no human gold**, and
  three corpus decisions are still open: keep adult images out of the
  repo, a refusal bucket in the failure taxonomy, and no `Reference B` gate.

## Candidates and arms

An **arm** is one model on one pinned host. Reference arm = highest precision available. Everything is
priced $/M in/out; the host tag is what goes in `provider.only`. Re-check every tag in Stage 0.

| Model | Reference arm | Lower-precision arms | Notes |
|---|---|---|---|
| `xiaomi/mimo-v2.6-pro` | `gmicloud/bf16` (.435/.87) | `deepinfra/fp8` | bf16 host is the slowest of four (p50 5.8 s, p99 42.7 s) but under 60 s |
| `xiaomi/mimo-v2.6-flash` | `gmicloud/bf16` (.14/.28) | `deepinfra/fp8`, `darkbloom/fp4` | bf16 host uptime 94.7 %: a flaky reference, counts as host failures |
| `z-ai/glm-5.3-flash` | `z-ai/fp8` or `streamlake/fp8` | `modal/nvfp4`, `decart/fp4`, `relace` (unknown) | no bf16 anywhere; claims are "vs fp8" |
| `deepseek/deepseek-v4.1-flash` | `deepinfra/fp8` | `decart/fp4`, `inference-net` (unknown) | |
| `deepseek/deepseek-v4-flash` | `streamlake/fp8` | `atlas-cloud/fp4`, `venice` (unknown) | |
| `qwen/qwen3.8-27b` (paid) | `deepinfra/bf16` | `akashml/fp8`, `darkbloom/fp4`, free `modelrun/fp4` | `cerebras/fp16` has only 65k context; skip |
| `minimax/minimax-m3` | `gmicloud/fp8` | `coreweave/fp4`, `together` (unknown) | `:free` variant has 0 endpoints now |
| `google/gemini-3.8-flash`, `google/gemini-3.1-flash-lite` | `google-ai-studio` | none | quantization is not published; one arm each. Do not use `google-vertex/global/flex` (p50 16–39 s) |
| `deepseek/deepseek-v4-pro` | first healthy host | none | **baseline**: the current `TL_LLM_MODEL` pin |

Dropped: `inclusionai/ling-3.1-flash` (one host, p90 107 s, p99 235 s, fails the 60 s bar).
About 26 arms. Two arms are shared by translation and QA (`mimo-*`, `glm`, `qwen`, gemini-lite).

## Stage 0 — preflight (read-only, minutes)

1. `get-credits`; set a hard spend cap (proposed **$25**) that the runner enforces.
2. Re-run the endpoint survey for each tag. Drop any tag that vanished, record the new price.
3. Confirm `xiaomi/mimo-v2.6-pro` still has `gmicloud/bf16` with `response_format`/`structured_outputs`.
4. Confirm `corpus` submodule is checked out and `corpus/translation/golden` has 45 dirs.

## Stage 1 — harness changes (the only code; one small PR)

Each item is needed for a result in a later stage, none is cleanup:

- **Provider pinning.** Add an arm manifest (JSON: model, tag, quant, role) and send
  `"provider": {"only": ["<tag>"], "allow_fallbacks": false}` (add `"require_parameters": true` when
  using `response_format`). A pinned host that is down is a recorded **host-unavailable** failure, never a
  silent reroute (the worker's one-hop translation fallback is the same trap: a pin that is quietly swapped measures the wrong model).
- **Prove the pin held.** Log the provider OpenRouter reports for each response and spot-check with
  `get-generation`. Quantization labels are host-reported; treat "bf16" as a label, not proof.
- **Failure taxonomy.** Split: timeout (>60 s), host-unavailable, refusal/empty/moralizing, schema
  failure, ID mismatch, truncation. Refusals get their own bucket (corpus decision 3).
- **chrF** scorer next to the existing similarity.
- **Judge runner** (Stage 4) and **spend cap**.
- Re-apply `REGEN_RUNBOOK.md` fixes check: failed page scores 0, punctuation-only pairs not 1.0.

## Stage 2 — smoke (one page per arm)

Run the pinned arm on one page (`sample36`). Pass: pin honored, JSON parses, one request under 60 s.
Fix the harness here, not later.

## Stage 3 — translation sweep (mechanical, delegable)

- Arms × 45 SFW golden pages × **2 repeats**, temperature 0, fixed seed where supported.
  The two repeats measure noise inside one arm; a quantization gap only counts if it is bigger.
- NSFW pages (no gold): same arms, **refusal/softening gate only**, plus Stage 4 reference-free scoring.
  Write raw NSFW outputs outside the repo; commit only aggregates.
- Record per request: wall time, tokens (reasoning tokens separately), cost, failure class.
- Verify against artifacts, not the runner's summary: count page files per arm vs. the manifest
  (the report counts invocations; the files count pages).

## Stage 4 — judge

Hybrid, because mimo is both judge and candidate and Claude cannot read thousands of bubbles.

1. **Rubric** (1–5 each): meaning kept, fluency, tone/register. Flags: omitted, added, **softened or
   censored**, refused, moralizing, wrong pronoun/speaker. The judge sees source, human gold, one
   candidate; candidate order shuffled and arm names removed.
2. **Controls on the judge:** the human gold as a candidate must score near 5; the same page's
   translation with bubbles shuffled across bubbles must score low. If either fails, fix the rubric first.
3. **Calibration:** Claude scores a blind sample (~60 bubbles, 20 per language, every model family
   included) in-session. Compare with mimo (`gmicloud/bf16`, temperature 0, `json_schema`): proceed on
   weighted kappa ≥ 0.6 (proposed). Below that, rewrite the rubric or let Claude judge more.
4. **Bulk:** mimo-pro judges everything. Because mimo-family candidates may be favored, Claude re-scores
   a sample of those; if the gap between the two judges on mimo outputs exceeds the gap on others,
   report mimo-family scores with that bias flag.
5. Judge calls are not subject to the 60 s bar, but use a 180 s timeout and one retry.

## Stage 5 — quantization analysis

For every model with more than one precision: paired per-bubble difference against the reference arm
(judge score, chrF), bootstrap interval, **per language** (CJK rare tokens are where low precision hurts
first), plus the behavior rates (refusal, schema, truncation, reasoning-token blow-ups, p90/p99 time).
A lower-precision host is **safe** when, in all three languages, the interval's lower end is no worse
than −0.15 judge points and −0.02 chrF, and no behavior rate is worse than repeat noise
(proposed thresholds; adjust before running). Output: an allow-list of hosts per model, which becomes the
pinning policy. If a model has only "unknown" hosts, say so; nothing can be concluded about quantization.

## Stage 6 — QA VLM arm

Use `benchmark_qa.py --arm vlm` with the same pinned arms that accept images (`mimo-*`, `glm`, `qwen`,
`gemini-3.1-flash-lite` as the current judge, `mistral-small-3.2` as its fallback).
Score as a classifier: defect pages vs **control pages without the defect** — defects caught, clean pages
wrongly flagged (control samples, not a settings toggle), explicit-page refusals, and the 60 s bar.

## Stage 7 — report and decision

One table per use case: quality (with interval), cost per page, p90/p99 time, refusal rate, safe hosts.
Pareto-filter it again with these measured numbers. Recommend `TL_LLM_MODEL`, the fallback, `QA_VLM_MODEL`,
and the host allow-list; stop there. Do not change `config/providers.json` or env files without the user.

## Handoff

- **Delegable to Gemini via antigravity**: Stages 0 (re-survey),
  2, 3, bulk of 4, and 6. Confirm each script's flags with `--help` first.
- **Stays with Claude / the user:** Stage 1 review, the Stage 4 calibration and judge controls, thresholds,
  Stage 7 reading, and the human blind read of ~20 bubbles for the final two or three models.

## Open decisions before running

1. NSFW gold: none exists. This plan uses refusal gate + reference-free judge there. OK?
2. Thresholds in Stage 4–5 and the $25 cap.
3. Who runs the sweep: Gemini/antigravity or a Claude session.
4. Whether to add `corpus/translation/` auto-extracted pages beyond the 45 golden ones (more bubbles,
   noisier references).

## Known limits

- Intelligence-index ranking (used to pick candidates) is not translation quality; Stage 3–5 is what decides.
- Time estimates earlier in this work ignored reasoning tokens. Stage 3 measures real wall time.
- Host quantization labels are self-reported, and "unknown" cannot be tested.
