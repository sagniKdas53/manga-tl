# Free OpenRouter models for manga translation — measured, ranked

> **Archived — superseded** by [`../free_model_bench_plan_2026-08.md`](../free_model_bench_plan_2026-08.md),
> which widens this to three providers and a multi-page corpus. Kept because it is the report that
> motivated building a repeatable benchmark — see [`../guides/translation_bench.md`](../guides/translation_bench.md).
> One provider, one hand-made page, translation stage only: read the rankings as a single data point.

**Date:** 2026-08-06
**Input:** `examples/sample28/original.jpg` — 7 text regions (2 system-UI signs, 4 speech
bubbles forming one continuous rant, 1 repeated SFX), transcribed by hand and run through
the exact prompt, system message, and `TRANSLATION_JSON_SCHEMA` that
`worker/services/translation.py`'s `translate_batch_llm()` uses (reused from
`scripts/test_translation.py`).
**Reference/baseline:** `examples/sample28/en-manga-tl-ai.jpg`, watermarked
as mangatranslator.ai running qwen3-235b — a paid competitor pipeline, same convention as
[`render_quality_gap_2026-08-05.md`](../render_quality_gap_2026-08-05.md).
**Candidates:** all 14 chat-capable models on OpenRouter with `pricing.prompt == 0` as of
2026-08-06 (queried live from `GET /api/v1/models`, not scraped from the pricing page —
the screenshot's "Free Models Router," rerank, embed, and audio entries aren't chat
completion models and don't appear in this list).
**Script:** `scripts/benchmark_free_translation.py` (single-provider, single-page prototype
built for this run). For each model it tries, in order, `response_format: json_schema` →
`json_object` → no `response_format`, and records which one actually worked — measuring
real structured-output support rather than trusting OpenRouter's self-reported
`supported_parameters`. **Superseded by `scripts/benchmark_translation.py`**, which
generalizes this same ladder to every provider in `config/providers.json` and every page in
`corpus/` — see [`translation_bench.md`](../guides/translation_bench.md) for the durable methodology
this run's findings turned into. This doc stays as the dated results snapshot.

---

## 1. Verdict

**`google/gemma-4-26b-a4b-it:free` is the best free model for this pipeline, full stop.**
Exact terminology consistency, correct pronoun/referent resolution on every line, fastest
of the high-quality tier (12.5s), and confirmed `json_schema` support. If the worker's
fallback chain needs a second free option, `nvidia/nemotron-3-super-120b-a12b:free` is the
closest in quality at similar latency (16.5s) with a smaller, more sustainably-free model
size than the 550B Ultra variant.

**One model is a latency trap that will look fine in a spot-check and then hang your
pipeline for 35 minutes:** `nvidia/nemotron-nano-9b-v2:free` returned a perfectly valid,
accurate translation — after burning through its **entire 65,536-token completion budget**
on invisible reasoning tokens before emitting 1,460 characters of actual JSON. Confirmed
against the model's own throughput number (65536 / 31 t/s ≈ 2114s, we measured 2099s) —
this isn't a network fluke, it's the model's default reasoning verbosity eating the whole
cap. Don't route production traffic to it without forcing `reasoning: {effort: "low"}` or
`include_reasoning: false` first, and re-benchmark before trusting it.

**One model in the existing fallback chain is confirmed structurally broken:**
`inclusionai/ling-3.0-flash:free` never accepted `response_format` in any mode — it only
produced valid JSON because the prompt begs hard enough. This is the exact model named in
`render_quality_gap_2026-08-05.md`'s deployment log (`model: inclusionai/ling-3.0-flash
does not support feature: structured-outputs`, 110 failed translation batches). This
benchmark reproduces that failure mode directly and confirms it's not provider flakiness —
the model genuinely doesn't support the contract our worker requires.

**The content-safety classifier isn't a translation model** — `nvidia/nemotron-3.5-content-safety:free`
returned empty content on all three response-format attempts, as expected for a moderation
classifier. Included only because it appeared in the free tier listing; excluded from
ranking.

---

## 2. Full ranking

Ranked for **our use case** (structured JSON translation batches feeding the worker's
render pipeline) — quality first, then whether it can actually sit in a production fallback
chain (structured-output reliability, latency).

| # | Model | Quality | Latency (7-region batch) | Structured output | Notable issue |
|---|---|---|---|---|---|
| 1 | `google/gemma-4-26b-a4b-it:free` | **9.5/10** | 12.5s | ✅ `json_schema` | none |
| 2 | `nvidia/nemotron-3-super-120b-a12b:free` | 8.4/10 | 16.5s | ✅ `json_schema`* | minor: "them" not "him" (r4) |
| 3 | `google/gemma-4-31b-it:free` | 8.2/10 | 16.4s | ✅ `json_schema` | picks "anus" not "anal" (internally consistent) |
| 4 | `nvidia/nemotron-3-nano-30b-a3b:free` | 8.6/10 | 33.2s | ✅ `json_schema`* | none major |
| 5 | `nvidia/nemotron-3-ultra-550b-a55b:free` | 9.2/10 | 37.9s | ✅ `json_schema`* | 550B — sustainability risk on a free tier |
| 6 | `nvidia/nemotron-nano-12b-v2-vl:free` | 6.6/10 | 11.0s | ✅ `json_schema`* | systematic I/you→we drift (r4, r5, r6) |
| 7 | `openai/gpt-oss-20b:free` | 8.8/10 | 119.9s | ✅ `json_schema` | too slow for interactive use |
| 8 | `poolside/laguna-s-2.1:free` | 6.8/10 | 31.2s | ✅ `json_schema`* | "Shefield" typo (dropped letter) |
| 9 | `inclusionai/ling-3.0-flash:free` | 7.3/10 | 5.5s | ❌ **none supported** | confirmed prod incident, see §1 |
| 10 | `cohere/north-mini-code:free` | 6.4/10 | 99.9s | ✅ `json_schema`* | flips accusation direction on r6 (see §3) |
| 11 | `poolside/laguna-xs-2.1:free` | 5.9/10 | 4.9s | ✅ `json_schema`* | wrong proper noun + wrong title (see §3) |
| 12 | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 6.9/10 | 15.3s | ✅ `json_schema`* | referent error (r4: "you" not "him") |
| 13 | `nvidia/nemotron-nano-9b-v2:free` | 8.0/10 (quality) | **2099.3s** ⚠️ | ✅ `json_schema`* | disqualifying latency, see §1 |
| 14 | `nvidia/nemotron-3.5-content-safety:free` | n/a | failed | ❌ empty content | not a generative model |

\* = model does **not** declare `response_format`/`structured_outputs` in OpenRouter's
`supported_parameters` metadata, but `json_schema` worked anyway in this test. Only
`ling-3.0-flash`'s declared lack of support held up empirically — for everything else,
OpenRouter's capability listing is a pessimistic lower bound, not a hard constraint.
Treat it as "try, then fall back," not "skip if not declared."

**Structured-*input* fidelity** (did the model correctly echo every one of the 7 input
`id`s with no drops, no duplicates, no hallucinated extras) was **perfect across all 13
models that returned content at all.** This isn't a differentiator here — every free model
that can produce JSON at all handles our id-keyed batch schema correctly.

---

## 3. What actually separates the free models

Not raw model size — the ranking has 550B beating 20B beating 9B beating 30B in different
slots. It's whether the model resolves the ambiguous parts of the source correctly.

### 3.1 The r6 test: who gets accused?

Region r6, `てか毎晩いじるからエラー出ちゃってるし…!`, has no explicit subject — normal for
Japanese, and the reference resolves it as accusatory: **"BESIDES, YOU MESS WITH IT EVERY
NIGHT, SO IT'S CAUSING ERRORS...!"** (the maid blaming the commander).

Two free models flipped it to a self-incriminating confession instead:

- `cohere/north-mini-code:free`: *"By the way, **I'M** fiddling with it every night..."*
- `inclusionai/ling-3.0-flash:free`: *"**And I** mess with it every night..."*

This isn't a minor wording choice — it reverses who the line is blaming, which breaks the
scene. Every other model that produced output got the direction right.

### 3.2 The r4 test: who gets killed?

Region r4, `やはり殺しておくべきでした…!`, reference: **"I REALLY SHOULD'VE KILLED HIM AFTER
ALL...!"** — first person, third-person object.

- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` renders it **"I should have killed
  YOU after all...!"** — turns an interior monologue about a third party into a direct
  address, which doesn't match the panel (nobody else is present to be spoken to).
- `nvidia/nemotron-nano-12b-v2-vl:free`, `poolside/laguna-s-2.1:free`,
  `cohere/north-mini-code:free` all shift "I" → "**We**", diffusing personal culpability
  into a collective decision the source doesn't support.
- `nvidia/nemotron-3-super-120b-a12b:free` and `nvidia/nemotron-nano-9b-v2:free` hedge to
  "**them**" instead of "him" — minor, arguably a reasonable gender-neutral default, but a
  deviation from both the reference and the visual (there's one clearly male commander in
  frame).

### 3.3 Proper nouns and titles

`シェフィールド` (Sheffield — a character name) and `指揮官` (commander) are unambiguous, and
most models got both right. Two didn't:

- `poolside/laguna-s-2.1:free`: **"Shefield"** — dropped letter, not a translation issue,
  just wrong.
- `poolside/laguna-xs-2.1:free`: **"the Shield"** — invented a generic noun in place of the
  proper name entirely, and separately renders 指揮官 as **"captain"** instead of
  "commander." Both wrong in the same response; XS is the least reliable model tested
  despite being tied for fastest.

### 3.4 Terminology register: anal / anus / butt

`肛門認証` appears twice (r1, r5) and every model kept it internally consistent within its
own response, but split three ways across models:

- **"Anal authentication"** — `gemma-4-26b`, `nemotron-3-super`, `nemotron-3-ultra`,
  `nemotron-3-nano-30b-a3b`, `nemotron-nano-9b-v2`, `poolside` (both), `ling-3.0-flash`,
  `nemotron-nano-12b-v2-vl` — matches the reference.
- **"Anus authentication"** — `gemma-4-31b`, `gpt-oss-20b` — more anatomically literal,
  arguably *more* correct, but diverges from the reference wording. Not a defect, a
  register choice.
- **"Butt authentication"** — `nemotron-3-nano-omni-30b-a3b-reasoning` — casualizes the
  deadpan clinical-error tone into something closer to slang, losing the joke (an
  authentication system deadpan-erroring on a crude term is funnier played straight).

### 3.5 Structured output: declared vs. actual

`render_quality_gap_2026-08-05.md` already flagged one structured-output failure in
production (`ling-3.0-flash`, 110 failed batches). This benchmark's empirical pass confirms
that finding and adds nuance: OpenRouter's `supported_parameters` metadata under-reports
capability for at least 7 of these 14 models (marked `*` in §2) — they're not listed as
supporting `response_format`, but `json_schema` mode worked cleanly. Only `ling-3.0-flash`'s
listed incapability turned out to be real. Practical implication for the worker's
fallback-chain config: **don't gate a model out of the chain just because OpenRouter's
metadata doesn't list `structured_outputs`** — the current chain already excludes
`ling-3.0-flash` incorrectly-for-the-wrong-reason (it's in the chain and failing) while
possibly *actually* excluding models that would work fine.

---

## 4. Latency: measured batch time vs. the OpenRouter pricing-page numbers

The screenshot's "Latency" column (485ms–4169ms) is time-to-first-token on OpenRouter's own
synthetic benchmark — not comparable to what our pipeline experiences, which is full
round-trip completion time for a real ~1,350-token-in / structured-JSON-out translation
batch. The two don't even rank the same models in the same order:

| Model | Screenshot latency | Screenshot throughput | **Measured batch time (this test)** |
|---|---|---|---|
| Nemotron 3 Nano Omni | 485ms | 84 t/s | 15.3s |
| Laguna XS 2.1 | 797ms | 74 t/s | 4.9s |
| Nemotron 3 Nano 30B A3B | 818ms | 83 t/s | 33.2s |
| Laguna S 2.1 | 1387ms | 37 t/s | 31.2s |
| Nemotron Nano 12B 2 VL | 1609ms | 20 t/s | 11.0s |
| Nemotron 3 Super | 1727ms | 48 t/s | 16.5s |
| North Mini Code | 1823ms | 19 t/s | **99.9s** |
| Nemotron Nano 9B V2 | 1832ms | 31 t/s | **2099.3s** ⚠️ (65,536 completion tokens — see §1) |
| Nemotron 3 Ultra | 2018ms | 24 t/s | 37.9s |
| Ling-3.0-flash | 2052ms | 75 t/s | 5.5s |
| gpt-oss-20b | 3251ms | 17 t/s | 119.9s |
| Gemma 4 26B A4B | 4169ms | 11 t/s | **12.5s** (fastest of the high-quality tier, despite the *worst* headline throughput number) |

**Use our measured column, not the pricing-page numbers, to pick a model for this
pipeline.** Headline TTFT/throughput on a synthetic single-turn benchmark doesn't predict
real batch latency — Gemma 4 26B has the worst on-paper throughput of the twelve and the
best real-world response time; North Mini Code and Nemotron Nano 9B V2 look completely
unremarkable on the pricing page and turn out to be the two slowest by a wide margin.

---

## 5. Recommendations

1. **Set `TL_LLM_MODEL=google/gemma-4-26b-a4b-it:free`** (or add it first in
   `TL_LLM_MODEL_LIST`) as the primary free-tier translation model. Best measured quality,
   fastest of the reliable tier, confirmed schema support.
2. **Add `nvidia/nemotron-3-super-120b-a12b:free` as the fallback**, not
   `deepseek/deepseek-v4-pro` alone — closest quality to #1, similar latency, still free.
3. **Remove or fix `inclusionai/ling-3.0-flash:free` in the fallback chain.** This
   benchmark reproduces the exact production failure already logged in
   `render_quality_gap_2026-08-05.md` §6. Either drop it, or make the worker fall back to
   `json_object`/plain-JSON parsing (like `test_translation.py` already does for
   Cloudflare) when a model doesn't support `json_schema`.
4. **Never route to `nvidia/nemotron-nano-9b-v2:free` without capping reasoning.** Set
   `reasoning: {effort: "low"}` or `include_reasoning: false` in the request and
   re-benchmark before adding it anywhere near a fallback chain — as configured, a single
   translation batch can hang for 35 minutes.
5. **Don't use OpenRouter's `supported_parameters` list to decide which models are
   eligible for the fallback chain.** Empirically test `json_schema` support instead (this
   script does it in ~5s per model with the retry/fallback ladder already built) — 7 of 14
   models work despite not declaring support.

---

## Appendix: raw per-model outputs

Full request/response JSON (including `translationNotes`, `emotion`, `tone`,
`translationScore`, and the retry ladder log) for all 14 models is at
`.bench_tmp/results/*.json` in the repo root (gitignored — local-only artifact of this run).
Re-run with:

```bash
python3 scripts/benchmark_free_translation.py \
  --regions <regions.json> \
  --out-dir <out-dir>
```

Source regions and reference translations used for this run are at `.bench_tmp/regions.json`
and `.bench_tmp/reference.json`.
