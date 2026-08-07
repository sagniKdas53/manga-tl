# Plan: re-run the free-model benchmarks across OpenRouter, NVIDIA and Cloudflare

**Status:** plan only, nothing run yet.
**Supersedes:** [`free_openrouter_translation_benchmark_2026-08-06.md`](free_openrouter_translation_benchmark_2026-08-06.md)
— one provider, one hand-made page, translation stage only.

## Why re-run

The 2026-08-06 report is a single data point in every dimension that matters:

| | 2026-08-06 | Now |
|---|---|---|
| Pages | 1 (`sample28`, hand-transcribed) | 38 translation / 40 OCR-eligible |
| Reference | a paid competitor's machine output (mangatranslator.ai / qwen3-235b) | human translation on 24 of 38 pages |
| Providers | OpenRouter | OpenRouter, NVIDIA, Cloudflare |
| Stages | translation | translation, OCR, QA (LLM + VLM) |
| Runner | one-off prototype | corpus-driven, shared ladder, `_summary.json` |

That page is also gone — it was NSFW and moved to `examples/NSFW/` during the re-curation, which
is what orphaned the old `manual` corpus entry. So the old numbers can't even be reproduced, let
alone extended. Everything below is free-tier only.

---

## 1. Fix the candidate pool first (blocker)

Two config problems to resolve before any run:

**a. `config/providers.json` free lists are far narrower than reality.** It has 3 free OpenRouter
`tl` models; the live API had 14 on 2026-08-06. `scripts/test-providers.json` is the wide,
unvetted pool and already carries **107 free `tl`** and **21 free `ocr`** entries. Use the wide
pool for discovery, promote winners into `config/providers.json`.

**b. `scripts/test-providers.json` has no `qaLLM` or `qaVLM` lists at all** (0 free entries), so
the QA bench cannot sweep the wide pool. These are the same underlying models under a different
task key. Generate them:

```
qaLLM  := the tl list  (text-only reasoning over region metadata)
qaVLM  := the ocr list (vision-capable)
```

Then refresh free-tier membership from each provider's live model list rather than trusting the
committed snapshot — the 2026-08-06 run did this via `GET /api/v1/models` filtering
`pricing.prompt == 0`, and free tiers churn.

**Deliverable:** an updated `scripts/test-providers.json` with all four task keys populated per
provider, dated in a comment.

---

## 2. Sizing — why this must be phased

Naive full sweeps are not runnable on free tiers:

| Stage | Models | Unit | Full sweep | Est. wall time |
|---|---|---|---|---|
| Translation | 107 | 1 request / page | 107 × 38 = **4,066** | ~19 h at 15 s + 2 s sleep |
| OCR | 21 | 1 request / **region** | 21 × ~300 regions = **6,300** | ~25 h |
| QA LLM | ~107 | 1 request / case | 107 × 245 = **26,215** | days |

OCR is per-region, which is the expensive one people underestimate. So: **screen wide and
shallow, then measure narrow and deep.**

### Phase A — screening (1 page / minimal cases, all free models)

Purpose: eliminate models that can't hold the contract at all. Cheap and highly discriminating —
the 2026-08-06 run disqualified 3 of 14 models on this basis alone.

```bash
# Translation: 107 runs, ~35 min
python scripts/benchmark_translation.py --providers-config scripts/test-providers.json \
  --corpus-subset quick --out-dir runs/2026-08-screen/tl

# OCR: 21 models x ~5 regions, ~1 h
python scripts/benchmark_vlm_ocr.py --providers-config scripts/test-providers.json \
  --corpus-subset quick --out-dir runs/2026-08-screen/ocr

# QA: both arms, one page = 7 cases
python scripts/benchmark_qa.py --arm llm --providers-config scripts/test-providers.json \
  --samples sample36 --out-dir runs/2026-08-screen/qa
python scripts/benchmark_qa.py --arm vlm --providers-config scripts/test-providers.json \
  --samples sample36 --out-dir runs/2026-08-screen/qa
```

**Cut rules** (apply from `_summary.json`, no judgement needed):
- `pages_ok == 0` → drop (never returned usable output)
- `id_fidelity_perfect_rate < 1.0` (translation) → drop; it can't hold the id-keyed batch contract
- `mean_latency_s > 120` → drop as a production candidate, but **record it** — see the
  `nemotron-nano-9b-v2` trap below
- QA `control_fp_rate > 0.5` → drop; it flags everything

Expect roughly 25–40 survivors for translation.

### Phase B — measurement (survivors, 10-page subset)

Pick 10 pages weighted toward **human** references, since those are the trustworthy targets, and
spanning region counts (sample34 has 13, sample36 has 4). Candidate set:
`sample3, sample12, sample13, sample17, sample27, sample29, sample34, sample35, sample36, sample37`
— all human-referenced.

```bash
python scripts/benchmark_translation.py --providers-config scripts/test-providers.json \
  --pages sample3,sample12,sample13,sample17,sample27,sample29,sample34,sample35,sample36,sample37 \
  --out-dir runs/2026-08/tl
```

~35 survivors × 10 pages ≈ 350 runs ≈ 1.7 h. Same shape for OCR (use `--corpus-subset clean`
once the OCR corpus is built) and QA (`--samples` with the same 10).

### Phase C — head-to-head

Top ~5 per stage, full `--corpus-subset all`, plus a manual read of actual output. The lexical
similarity score ranks; it does not judge. The 2026-08-06 report's most valuable findings (who
gets accused in r6, who gets killed in r4) came from reading translations, not from the metric.

---

## 3. Provider-specific handling

**OpenRouter** — free tier is rate-limited per day; `:free` suffixed model ids are a distinct SKU
from the paid ones. Use `--sleep 2` minimum. Expect 429s on the wide sweep; `run_ladder` already
retries with linear backoff and logs them in `attempts_log`, so a run that hits limits degrades to
recorded failures rather than dying.

**Cloudflare Workers AI** — free allowance is measured in neurons per day, not requests, so large
vision payloads burn it much faster than text. Run the OCR/qaVLM sweep for Cloudflare on its own
day. `baseUrl` needs `CLOUDFLARE_ACCOUNT_ID`; `resolve_base_url()` already templates it, and will
raise a clear error if unset. Also note Cloudflare models historically needed the `json_object` or
plain rung — `test_translation.py` already had a Cloudflare-specific fallback, which is exactly
what the ladder generalises.

**NVIDIA** — 70 free `tl` entries in the wide pool, by far the biggest sweep, and the source of
last run's worst trap. Also hosts `nvidia/nemotron-ocr-v2`, a **non-chat CV endpoint** handled
separately by `call_nvidia_ocr_v2()`; it's the only engine that does its own detection, so it's
the only one with a `detection_recall` number. Keep it in the OCR run.

---

## 4. Traps to re-check explicitly

Carried forward from 2026-08-06 — each needs a yes/no this time:

1. **`nvidia/nemotron-nano-9b-v2:free` burned its entire 65,536-token completion budget on
   invisible reasoning and took 2,099 s for one batch.** Re-test with and without
   `reasoning: {effort: "low"}`. Note the runner does **not** currently send reasoning controls —
   if this reproduces, that's a feature to add to `bench_common.build_payload` callers, not just a
   footnote.
2. **`inclusionai/ling-3.0-flash:free` supported no `response_format` mode** and caused 110 failed
   production batches. It is still in `config/providers.json`'s free `tl` list. Confirm or clear.
3. **Declared vs. actual structured output.** 7 of 14 models supported `json_schema` while not
   declaring it. The `modes_used` field answers this for free now — report it as a table.
4. **Content-safety / non-generative models** in free listings (`nemotron-3.5-content-safety`)
   return empty content. Exclude from ranking rather than scoring them as failures.

---

## 5. Output

One dated report per stage, following the structure of the 2026-08-06 doc (verdict → ranking →
what separates them → latency reality-check → recommendations):

```
docs/free_model_bench_2026-08_translation.md
docs/free_model_bench_2026-08_ocr.md
docs/free_model_bench_2026-08_qa.md
```

Raw `runs/2026-08*/` stays gitignored; the reports carry the tables. Each should end with concrete
`config/providers.json` edits (which models to promote into the fallback chain, in what order),
because that file is what the backend actually reads.

---

## 6. Prerequisites

- [ ] `scripts/test-providers.json` refreshed, with `qaLLM`/`qaVLM` lists added (§1)
- [ ] OCR corpus built beyond `sample36` — currently 1 of 40 pages, so the OCR bench has almost
      nothing to score against. Needs the per-sample loop from
      [`benchmarks_guide.md`](benchmarks_guide.md) §5.
- [ ] At least a few OCR pages promoted to `gold` via the review flow, so OCR numbers rest on
      confirmed text rather than consensus alone
- [ ] QA VLM arm has 0 runnable cases until the OCR corpus supplies bounding boxes — it is blocked
      on the item above
- [ ] `sample21` (Chinese) replaced or excluded, so the translation sweep is single-language
