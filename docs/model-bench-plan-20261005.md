# Cheap-model benchmark: two parts, host-level, with an NSFW sample — runbook (not run yet)

Written 2026-10-05, revised 2026-10-06. **Nothing in this document has been executed.** It is a plan for a later
session. Prices, host tags, uptime and latency were read from OpenRouter on 2026-10-05/06 and drift; Stage 0
re-reads them before anything is paid for.

## What changed in this revision

1. **Two parts.** Part 1 is SFW only, every cheap candidate. Part 2 is a bigger sample (SFW + NSFW), only models
   and hosts that do not refuse or soften adult content.
2. **An NSFW sample has to be curated.** The 45-page golden set is all SFW. Details and the numbers are in
   "NSFW curation" below.
3. **The unit is the host, not the precision tier.** From the video
   [OpenRouter Is Quietly Giving Nerfed AI Model](https://www.youtube.com/watch?v=ZsnFX5mEJ4s) (Kai, 2026-10-05):
   quantization is one cause of host differences, not the main one. I read the whole transcript and checked what I
   could against the OpenRouter docs, the Hugging Face configs, and our own endpoint data (table below).
4. **The reference arm is the model's native precision, not "the biggest number".** My first draft called
   `gmicloud/bf16` the reference for `mimo`. The lab publishes mimo as FP8, so bf16 is an upcast.

## Why do this (output value)

It picks `TL_LLM_MODEL`, `QA_VLM_MODEL`, their fallbacks, and a **routing rule** (which hosts we allow). It can make
output better in two ways: a better translator, and no silent loss when OpenRouter sends a request to a weak host.
If nothing beats the current pins by more than the measurement noise, we stop and change nothing.

## Ground rules (from the user, 2026-10-05)

- **Out:** `anthropic/claude-sonnet-5.5`, `anthropic/claude-opus-5.5` (price, moderation).
- **Judge:** Claude in-session, or `xiaomi/mimo-v2.6-pro` pinned to `gmicloud/bf16`; this plan uses both (Stage J).
- **Quantization-aware:** yes, but as one covariate among host effects.
- Any single request over 60 s is a failure, however good the answer (standing benchmark rule).
  `bench_common.call_provider()` already enforces this with a hard timeout.
- Adult pages: no images in the repo; raw explicit outputs stay outside the repo, only aggregates are committed.

## What the video claims, and what we checked

| Claim | Verdict here |
|---|---|
| Default routing is price-weighted (inverse square); `sort` or `order` turns it off | **Confirmed** in the OpenRouter docs. Unpinned runs therefore mix random hosts. |
| A "4-bit" label can just be the lab's native weights | **Confirmed for our models** (Hugging Face configs): mimo-v2.6 pro/flash, glm-5.3-flash and deepseek-v4.1-flash publish FP8; deepseek-v4-flash/pro publish FP8 with FP4 experts; qwen3.8-27b and minimax-m3 publish no quantization config. |
| Hosts at the same precision differ a lot (the video quotes 100 % vs 73 % on GLM 5.2) | **Not verified** (comes from Artificial Analysis per-endpoint scores). Part 1 measures it. |
| Hosts cap context or output | **Mostly a non-issue for us.** Of 151 endpoints on our 10 models, none caps output below 16,384; most "context" flags are labelling (native 262k vs a 1M claim by a few hosts). Real cases: `glm` on `reka` (262k of 1.05M), `deepseek-v4-flash` on `cloudflare` (384k of 1M), `deepseek-v4-pro` on `deepinfra` (output exactly 16,384). Still set `max_tokens` ourselves and log `finish_reason`. |
| Some hosts lack structured outputs / tools | **Confirmed.** `relace` (cheapest host on 5 models) has neither `response_format` nor `structured_outputs` on `glm-5.3-flash` and `deepseek-v4.1-flash`; 4 of 13 `minimax-m3` hosts lack them. `require_parameters: true` fixes it. |
| List price is not what you pay (cache rates differ) | **Confirmed.** Cache-read price is below 3 % of the prompt price on some hosts, and equal to or above it on others (e.g. `deepseek-v4-pro` on `relace`). Our frontier used list price, so measure the real bill (`usage.cost`, cached tokens) instead. |
| Auto Exacto fixes routing | Only for requests with tools. We send none, so it does nothing for us. |

## What we have today

- Golden set: 45 pages, 218 bubbles, human English reference, JA/KO/ZH (15 each), in
  `corpus/translation/golden/<sample>/` (the `corpus` submodule), all SFW. Evaluator:
  `corpus/scripts/benchmark_free_suite.py`; per-bubble score is `difflib` similarity to one human translation. That
  measures word overlap, not meaning, so it cannot rank models a few points apart. The committed leaderboards in
  `corpus/benchmarks/` predate three scoring fixes and are stale.
- `scripts/benchmark_translation.py` and `scripts/benchmark_qa.py` read models from `config/providers.json`.
  **Neither can pin a provider.** `--free-only` is on by default.
- I have not checked how the worker builds its OpenRouter requests (whether it sends a `provider` object at all).
  That is Stage 7's first question.

## Candidates and arms

An **arm** is one model on one pinned host (`provider.only` + `allow_fallbacks: false`). Re-check every tag in Stage 0.
"Native" is the precision the lab publishes. A host at lower precision than native is a real **downcast**; a host at
higher precision is an **upcast** (should equal native; included only as a sanity check).

| Model | Native | Reference host | Downcast arms | Other arms |
|---|---|---|---|---|
| `xiaomi/mimo-v2.6-pro` | FP8 | first-party `xiaomi` (fp8), else `deepinfra/fp8` | none listed | `gmicloud/bf16` (upcast, also the judge) |
| `xiaomi/mimo-v2.6-flash` | FP8 | `deepinfra/fp8` (check status) | `darkbloom/fp4` | `gmicloud/bf16` (upcast, uptime 94.9 %) |
| `z-ai/glm-5.3-flash` | FP8 | `z-ai/fp8` first-party | `modal/nvfp4`, `decart/fp4`, `deepinfra/fp4` | `streamlake/fp8`; `relace`, `reka` (flagged hosts) |
| `deepseek/deepseek-v4.1-flash` | FP8 | `deepinfra/fp8` | `decart/fp4` | first-party `deepseek` (unknown label), `inference-net` |
| `deepseek/deepseek-v4-flash` | FP8 + FP4 experts | first-party `deepseek` | none claimable | `streamlake/fp8`, `atlas-cloud/fp4` (may just be native) |
| `qwen/qwen3.8-27b` (paid) | bf16 | `deepinfra/bf16` | `akashml/fp8`, `darkbloom/fp4`, free `modelrun/fp4` | skip `cerebras/fp16` (65k context) |
| `minimax/minimax-m3` | bf16 | none (no bf16 host exists) | `gmicloud/fp8`, `coreweave/fp4` | claims are "vs the fp8 first-party host" |
| `google/gemini-3.8-flash`, `google/gemini-3.1-flash-lite` | not published | `google-ai-studio` | none | one arm each; avoid `google-vertex/global/flex` (p50 14–39 s) |
| `deepseek/deepseek-v4-pro` | FP8 + FP4 experts | first-party `deepseek` | none | **baseline**: current `TL_LLM_MODEL` pin |
| `openai/gpt-6-luna` | n/a | OpenAI | none | **Part 1 only**: moderated; shows the quality ceiling a naggy cheap model reaches on SFW |

Plus a **default-routing arm** per model: no pin, same fixed 10 pages repeated 5 times, log which host answered.
This shows what production gets today when OpenRouter picks by price.
Dropped: `inclusionai/ling-3.1-flash` (one host, p90 107 s, p99 235 s).

## Stage 0 — preflight (read-only)

1. `get-credits`; hard spend cap (proposed **$25**) enforced by the runner.
2. Re-run the endpoint survey for each tag; drop vanished tags, record new prices and uptime.
3. Re-confirm each model's native precision from its Hugging Face config (they can change between versions).
4. `corpus` submodule checked out; `corpus/translation/golden` has 45 dirs.

## Stage 1 — harness changes (the only code; one small PR)

Each item exists because a later result needs it:

- **Arm manifest + pinning:** `"provider": {"only": ["<tag>"], "allow_fallbacks": false, "require_parameters": true}`
  and an explicit `max_tokens`. A pinned host that is down is a recorded **host-unavailable** failure, never a
  silent reroute.
- **Per-request log:** served provider (from the response, spot-checked against the activity log / `get-generation`),
  `finish_reason` (`length` means truncated reasoning looks like a bad answer), `usage.cost`, cached tokens,
  reasoning tokens, wall time.
- **Failure taxonomy:** timeout (>60 s), host-unavailable, refusal/empty/moralizing, schema failure, ID mismatch,
  truncation. Refusals get their own bucket.
- **chrF** scorer beside the existing similarity; **judge runner** (Stage J); **spend cap**.
- Check that `REGEN_RUNBOOK.md`'s three scoring fixes are in (failed page = 0; punctuation-only pairs not 1.0).

## Stage 2 — smoke (one page per arm)

Pin honored, JSON parses, one request under 60 s, `finish_reason` is `stop`. Fix the harness here.

## Part 1 — SFW, every cheap candidate

**Sample:** the 45 golden pages (JA/KO/ZH). **Runs:** every arm above × 2 repeats, temperature 0, fixed seed where
supported, plus the default-routing arms.

**Questions it answers:**
1. Which models translate best (judge score, chrF) inside the 60 s bar?
2. How much do hosts of the **same** model differ? Report **per host**, with precision as one covariate. Where a
   model has two hosts at the same precision (e.g. several `glm` fp8 hosts), that spread is the "not just
   quantization" test.
3. Do downcast hosts (fp4/nvfp4 below an fp8-native model) lose quality? Per language; CJK is where it shows first.
4. What does the default-routing lottery cost? Compare the default arm to the reference host.
5. Real cost per page from the bill, including cache effects, not list price.

**Output and gate:** a ranked table and a shortlist of **at most 4 models with at least 2 vetted hosts each**.
Stop and review before Part 2. Part 1 numbers also set the noise level that sizes Part 2.

## NSFW curation (prerequisite for Part 2)

What exists, from `corpus/docs/SAMPLE_ID_MAP.md` and `meta.json` files: the content rating was retired on
2026-08-23, so there is **no `NSFW/` folder any more**. The old NSFW half is `sample62`–`sample121` (60 pages), now
mixed into `samples/ja|ko|zh`; `origin.previous_path` in each `meta.json` records it. Facts:

- All 60 are **Japanese**. There are no Korean or Chinese adult pages, so refusal behavior on KO/ZH is untested.
- Only **8 of 60** have a human translation (`sample63, 65, 77, 89, 94, 95, 98, 118`); the rest have machine
  references only (e.g. mangatranslator.ai), which are not gold.
- I have **not looked at any page image**. Page choice should be yours.

**Procedure (manual, by the user, per the usual curation workflow):**
1. **Gold tier (8 pages):** extract the human text per bubble and align it to the OCR regions with the existing
   `corpus/scripts/extract_human_gold.py` / `create_golden_standard.py` path. Keep only hand-verified bubbles, same
   rule as the SFW golden set (unverified crops are skipped, not counted). Expect roughly 50 bubbles.
2. **Probe tier (8 more pages):** pick JA pages with explicit dialogue (you choose). Machine references are kept as
   loose context and labelled `machine`; they are never used as gold.
3. **Format:** the same bundle as the golden pages (`regions.json`, `reference.json`, `meta.json`), **text only,
   no images** (translation-corpus rule). Tag each bubble the curator knows is explicit, so "softened" has ground
   truth beyond the judge's opinion.
4. **Result:** 16 pages for the refusal screen; up to all 60 later for Part 2 scoring, reference-free for the 52
   without human text.
5. **Gap to decide:** add a few KO/ZH adult pages, or accept that Part 2 only covers JA for adult content.

## Part 2 — bigger sample, only models that don't nag

**Gate 0, refusal screen (cheap):** run every shortlisted host, plus any model whose "non-naggy" status is unknown
(e.g. the Gemini models), on the 16-page probe set. **It is per host:** a provider can filter content even when the
model does not (earlier measured case: Qwen via Alibaba returned `data_inspection_failed` on explicit pages at
random). A host passes with zero page-level refusals and a softening rate under 2 % of flagged bubbles
(proposed). Only passing hosts continue. OpenAI/Anthropic moderated models are not expected to pass.

**Sample:** sized from Part 1's measured noise (target: bootstrap interval half-width of at most 0.1 judge points per
language). Expect about 120–150 pages: the 45 golden pages (so Part 1 stays comparable), plus further SFW pages
from the corpus, plus the NSFW tiers above. Hard-capped by the spend cap.

**Runs:** passing arms × 2 repeats, the Part 1 per-host analysis repeated on the bigger sample, plus **one
routing-policy arm**: the actual rule we would deploy (`order` of vetted hosts, `require_parameters: true`,
`quantizations` floor where meaningful), unpinned within it. Pass when every served host is inside the allow-list.
Native-precision references stay the comparison point.

**Output:** the decision table (below) and the allow-list.

## Stage J — judge (used by both parts)

Hybrid, because `mimo-v2.6-pro` is both judge and candidate, and Claude cannot read thousands of bubbles.

1. **Rubric** (1–5): meaning kept, fluency, tone/register. Flags: omitted, added, **softened or censored**, refused,
   moralizing, wrong pronoun/speaker. The judge sees source, human gold (or source only for no-gold bubbles),
   one candidate; order shuffled, arm names removed.
2. **Controls on the judge:** the human gold as a candidate must score near 5; the same page's translation
   shuffled across bubbles must score low; 30 items re-judged twice for self-consistency.
3. **Calibration:** Claude scores a blind sample (~60 bubbles, 20 per language, every model family included).
   Compare with `mimo-v2.6-pro` on `gmicloud/bf16` (temperature 0, `json_schema`, always the same host; bf16 there
   is an upcast of FP8 weights, so no quality edge is claimed). Proceed on weighted kappa ≥ 0.6 (proposed).
4. **Bulk:** mimo judges; Claude re-scores a sample of mimo-family outputs to catch self-preference.
5. Judge calls are not subject to the 60 s bar; 180 s timeout, one retry.

## Decision rule

A **host is safe** for a model when, in all languages measured, the lower end of its paired difference from the
reference host is no worse than −0.15 judge points and −0.02 chrF, and no behavior rate (refusal, schema failure,
truncation, timeout) is worse than the repeat noise. **A model wins** when it beats the current pin outside the noise
at equal or lower measured cost, with zero 60 s breaches on its allow-listed hosts. If a model's only hosts are
"unknown", say so; nothing can be concluded from the label. (All thresholds are proposals; adjust before running.)

## Stage 7 — report and decision

Per use case: quality with interval, real cost per page, p90/p99 time, refusal rate, safe hosts, and the routing
rule. Then check how the worker sends its OpenRouter requests and where a `provider` object would go. Do not change
`config/providers.json` or env files without the user.

## QA VLM (separate, runs after Part 1's shortlist)

`benchmark_qa.py --arm vlm` with the same pinned arms that accept images. Score as a classifier: defect pages vs
**control pages without the defect** (defects caught, clean pages wrongly flagged, explicit-page refusals, 60 s bar).
Adult-page refusal for the QA judge is also screened per host.

## Handoff

- **Delegable to Gemini via antigravity:** Stage 0 re-survey, Stage 2, the mechanical runs of Part 1 and Part 2,
  bulk judging. Confirm each script's flags with `--help` first.
- **Stays with Claude / the user:** harness review, NSFW page choice and gold verification, judge calibration and
  controls, thresholds, reading the results, and a human blind read of ~20 bubbles for the final two or three.

## Open decisions before running

1. NSFW curation: which 8 probe pages, and whether to add KO/ZH adult pages.
2. Is `gpt-6-luna` worth including in Part 1 as a quality ceiling, or drop it?
3. Thresholds (refusal 2 %, kappa 0.6, −0.15 / −0.02) and the $25 cap.
4. Who runs it: Gemini/antigravity or a Claude session.

## Known limits

- The intelligence index used to pick candidates is not translation quality; Part 1 and Part 2 decide.
- Earlier latency estimates ignored reasoning tokens; Part 1 measures real wall time.
- Precision labels are host-reported, "unknown" cannot be tested, and Hugging Face configs can hide mixed
  precision (e.g. FP4 experts inside an FP8 model).
- Endpoint data is a one-day snapshot; uptime in particular moves hour to hour.
