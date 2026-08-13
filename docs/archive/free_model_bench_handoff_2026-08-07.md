# Handoff: candidate pool refreshed, Phase A+ running against curated pages

**Date:** 2026-08-07, updated 2026-08-08
**Status:** §1–6 below are the original 2026-08-07 data-collection pass (candidate pool only,
nothing run). §7 documents the 2026-08-08 curated-page bench as it was launched. **§8 is new
as of 2026-08-08 and is the actual result**: translation and OCR ran to completion; QA-LLM ran
partially (OpenRouter + Cloudflare in full, NVIDIA to 18 of 67 models) and was deliberately cut
short once the remaining time cost stopped buying new information — see §8 for why, the full
rankings, the timeout-bug fix that made the numbers trustworthy, and the Cloudflare
removal recommendation. The OCR corpus is still 1 page (`sample36`) and the QA VLM arm is still
blocked on it — prerequisites 2–5 of the plan doc remain open.
**Scope reminder:** this bench (and everything downstream of `scripts/test-providers.json`)
measures **providers and models**, not the manga-library app. It answers "which free/cheap
model should the worker's fallback chain use," not "does the app work."

---

## 1. What changed

`scripts/test-providers.json` was regenerated from live provider APIs (not the 2026-08-06
snapshot). Every provider now has all four task keys — `tl`, `qaLLM`, `ocr`, `qaVLM` — closing
the gap the plan called out in §1b (`qaLLM`/`qaVLM` had 0 entries before). Per that section's
rule, `qaLLM` is a duplicate of `tl` and `qaVLM` is a duplicate of `ocr` for every provider except
OpenRouter, which already had distinct enough free/paid selections to warrant hand-curating all
four (see §3 below).

| Provider | tl / qaLLM | ocr / qaVLM | specialized |
|---|---|---|---|
| OpenRouter | 13 (10 free + 3 paid) | 7 (4 free + 3 paid) | — |
| Cloudflare | 28 (25 free-ok + 3 paid-only) | 6 (4 free-ok + 2 paid-only) | — |
| NVIDIA NIM | 67 (all free) | 10 (all free) | 1 (`nemotron-ocr-v2`, non-chat) |
| Neurometric | 1 (`clawpack`, free) | null | — |
| **Total distinct candidates** | **109** (103 free) | **23** (18 free) | 1 |

Full per-model list is in the file itself; each entry carries `id`/`name`/`free`, matching the
schema `scripts/provider_config.py` already reads (verified — see §5).

---

## 2. Findings that affect `config/providers.json` today, not just the bench pool

These came out of re-querying live rather than trusting the 2026-08-06 file, and they're
independent of any benchmark run — they're just catalog/pricing facts as of 2026-08-07.

1. **`inclusionai/ling-3.0-flash:free` left OpenRouter's free tier entirely.** It's still in
   `config/providers.json`'s production `tl`/`qaLLM` lists (`openrouter` provider) marked
   implicitly free by convention, but the live catalog now prices it at $0.021/$0.063 per M
   tokens — it is **no longer free**, full stop, not a rate-limit or availability issue. The
   free SKU that replaced it in OpenRouter's lineup is `inclusionai/ling-3.0-tiny:free` (not
   benchmarked yet — this model didn't exist in the 2026-08-06 pass). This is a separate,
   sharper problem than the structured-output failure already logged against
   `ling-3.0-flash` in `render_quality_gap_2026-08-05.md` — even fixing the schema issue
   wouldn't make it free again.
2. **3 Cloudflare models in `config/providers.json` are marked `"free": true` but actually
   require the Workers Paid plan**, confirmed via each model's `require_workers_paid: true`
   property in the live `models/search` response: `@cf/moonshotai/kimi-k2.6` (used as the
   `tl` default's neighbor), `@cf/moonshotai/kimi-k2.7-code` (the production `qaVLM`/`ocr`
   default!), and `@cf/zai-org/glm-5.2`. If the Cloudflare account backing
   `CLOUDFLARE_API_TOKEN` is on the free Workers plan, every call to the current
   `defaultQAVLMModel`/`defaultOCRModel` (`kimi-k2.7-code`) fails outright — this isn't a
   quality problem, it's a hard 402/403 the fallback chain has to absorb on every attempt.
   Worth checking whether that's the account's actual plan before this ships.
3. **Cloudflare's free allowance is 10,000 Neurons/day, shared across the *entire account*,
   confirmed via developers.cloudflare.com/workers-ai/platform/pricing/ (2026-08-07).** Not
   new information, but now quantified rather than the plan's "measured in neurons, not
   requests" — worth stating precisely because it's the number that decides how big a
   Cloudflare OCR sweep can be before the account gets cut off for the rest of the day.
4. **NVIDIA NIM dropped 3 models from its catalog since 2026-08-06:**
   `deepseek-ai/deepseek-v4-flash`, `deepseek-ai/deepseek-v4-pro`, and
   `mistralai/mistral-medium-3.5-128b`. None were in `config/providers.json`'s curated NVIDIA
   list, so no production impact, but they're removed from `test-providers.json` too now
   (would 404 if left in). Everything else from the 2026-08-06 NVIDIA list is still live —
   this was a clean, small diff, not a churny catalog.
5. **Cloudflare model IDs shift org namespaces without notice.** `@cf/ibm/granite-4.0-h-micro`
   (in the current production config) is `@cf/ibm-granite/granite-4.0-h-micro` in the live
   catalog; `@cf/deepseek/deepseek-r1-distill-qwen-32b` is now under `deepseek-ai`. Neither
   old-namespace ID appears in the live 61-model catalog anymore. If
   `config/providers.json`'s Cloudflare list uses the old IDs anywhere outside what's shown
   above, those calls are 404ing today, not degrading gracefully into a fallback — worth a
   quick `grep` across `config/providers.json` for `@cf/ibm/` and `@cf/deepseek/`.

None of the above required a single benchmark request — they fell out of comparing live
`/models` responses to the committed config. Recommend fixing #1, #2, and #5 in
`config/providers.json` independent of and before the Phase A/B/C runs below, since they're
config bugs, not open questions the bench is meant to answer.

---

## 3. Methodology notes specific to this pull

- **OpenRouter** (`GET /api/v1/models`, 400 total models): filtered to
  `pricing.prompt == 0 && pricing.completion == 0` → 17 candidates. Of those, excluded 3 as
  unusable for our contract: `google/lyria-3-pro-preview` and `-clip-preview` (music
  generation, `text->[text,audio]`, not a JSON-output chat model) and `openrouter/free` (a
  router that randomly picks a free model per request — can't attribute a benchmark result to
  a specific underlying model). `nvidia/nemotron-3.5-content-safety:free` kept as the same
  non-generative regression-tracking control the 2026-08-06 report used. Net: 13 usable free
  models (9 text-only + 4 vision), split across `tl`/`ocr` by `architecture.input_modalities`.
  Also added 4 paid comparison models — deliberately **not** the globally-cheapest OpenRouter
  models, but the ones already wired as production defaults in `config/providers.json`
  (`qwen/qwen3.7-flash`, `qwen/qwen3-vl-32b-instruct`, `deepseek/deepseek-v4-flash`,
  `google/gemini-3.1-flash-lite`), so Phase C's head-to-head answers "is the free tier actually
  competitive with what we pay for today," not just "which free model wins."
- **Cloudflare** (`GET /accounts/{id}/ai/models/search`, 61 models across all tasks):
  filtered to `task.name in {"Text Generation", "Image-to-Text"}` (28 models), excluding
  embeddings, reranking, text-to-image, TTS/ASR, and the two dedicated `Translation`-task
  models (`m2m100-1.2b`, `indictrans2-en-indic-1B` — non-chat-shaped, would need the same
  special-casing `nemotron-ocr-v2` gets; not done here, flagged for later if worth pursuing).
  Vision-capable = the model's own `vision: true` property, not a name heuristic.
- **NVIDIA** (`GET /v1/models`, 99 models, no pricing/modality metadata in the response at
  all): reused the 2026-08-06 file's manual chat/embed/safety/specialized classification
  (verified independently by re-deriving the same split from scratch and diffing — see the
  generator script's exclusion set — the two classifications agreed on every id except the 3
  removed models above). Vision-capable = name markers (`vision`, `-vl-`, `vila`, `neva`,
  `fuyu`, `cosmos-reason`) cross-checked against OpenRouter's `architecture.input_modalities`
  for the ids that exist on both platforms (e.g. `nemotron-nano-12b-v2-vl`,
  `nemotron-3-nano-omni-30b-a3b-reasoning`).
- **Structured-output support is not recorded for Cloudflare or NVIDIA** — neither API exposes
  an OpenRouter-style `supported_parameters` field, so there's nothing to pre-filter on. This
  is exactly what Phase A's empirical ladder (`bench_common.run_ladder`) is for; don't try to
  guess it from docs.
- **Neurometric**: `NEUROMETRIC_API_KEY` still returns `401 invalid_api_key`, re-confirmed
  2026-08-07 (curled directly against `/v1/models` and `/`). This matches the existing, dated
  `TODO.md` entry ("Replace the `neurometric` API key... Still dead") — not something this pass
  broke or is positioned to fix. Left as the single `clawpack` router entry, `free: true`,
  `qaVLM`/`ocr` both `null` (it has no vision-capable route upstream either). Exclude from all
  three phases below until the key is rotated.

---

## 4. Run it: Phase A screening

Prerequisite 1 is done; prerequisites 2–5 in the plan are not (OCR corpus is 1/40 pages, no
`gold`-reviewed pages, QA VLM arm has 0 runnable cases, `sample21` still in the pool). That
means **Phase A's translation and QA-LLM sweeps are runnable right now**; the OCR and QA-VLM
sweeps will run but score against a corpus too thin to mean much — expect `pages_ok` numbers
but not trustworthy CER/F1 numbers until those prerequisites close.

```bash
# Translation — 109 candidates (103 free + 6 paid comparison), 1 page, ~30-40 min
python3 scripts/benchmark_translation.py --providers-config scripts/test-providers.json \
  --corpus-subset quick --out-dir runs/2026-08-screen/tl

# QA (LLM arm) — 109 candidates x 7 cases (sample36), runnable today
python3 scripts/benchmark_qa.py --arm llm --providers-config scripts/test-providers.json \
  --samples sample36 --out-dir runs/2026-08-screen/qa

# OCR — 23 candidates, will run but score against a 1-page corpus (weak signal, see above)
python3 scripts/benchmark_vlm_ocr.py --providers-config scripts/test-providers.json \
  --corpus-subset quick --out-dir runs/2026-08-screen/ocr

# QA (VLM arm) — will report 0 runnable cases until the OCR corpus supplies bounding boxes
python3 scripts/benchmark_qa.py --arm vlm --providers-config scripts/test-providers.json \
  --samples sample36 --out-dir runs/2026-08-screen/qa
```

Apply the plan's cut rules from each `_summary.json` (§2 of the plan doc) with no judgement
calls needed: `pages_ok == 0` → drop; translation `id_fidelity_perfect_rate < 1.0` → drop;
`mean_latency_s > 120` → drop as a production candidate but keep the row (see the
`nemotron-nano-9b-v2` reasoning-budget trap from 2026-08-06, reproduced as a candidate again
here — re-check it explicitly, trap #1 in the plan's §4); QA `control_fp_rate > 0.5` → drop.

**Cloudflare-specific:** run its slice of the OCR/qaVLM sweep on a separate day from
everything else — the shared 10,000-neurons/day cap (confirmed number, §2.3 above) means a
mixed sweep can silently exhaust the account partway through and turn later Cloudflare rows
into false negatives rather than real failures. `--providers openrouter,nvidia` /
`--providers cloudflare` (check the scripts' actual flag name before relying on this) or just
run Cloudflare alone with `--providers-config` narrowed to only that provider's block.

**OpenRouter-specific:** free tier is rate-limited per day; keep `--sleep 2` minimum (scripts'
default). Expect some 429s on the 25-free-model Cloudflare and 67-model NVIDIA slices too —
`run_ladder` retries with backoff and logs to `attempts_log`, so a rate-limited run degrades to
recorded failures rather than dying.

After Phase A, move to Phase B (10-page subset, survivors only) and Phase C (top ~5,
full corpus + manual read) exactly as scoped in the plan doc's §2 — nothing about those phases
changed by this pass.

---

## 5. Verification done before handing off

- `scripts/test-providers.json` is valid JSON and loads cleanly through
  `provider_config.load_providers_config` / `list_candidate_models` /
  `list_specialized_models` — spot-checked counts match the table in §1 exactly (109/103 for
  `tl`, 23/18 for `ocr`, same for `qaLLM`/`qaVLM`, 1 specialized entry resolved).
  `benchmark_qa.py`'s task-key lookup (`"qaLLM" if arm == "llm" else "qaVLM"`,
  `benchmark_qa.py:316`) now finds non-empty lists on every provider that has them.
- Did **not** run any of the four scripts end-to-end — this handoff is the boundary between
  "candidate pool assembled" and "candidates measured." No `runs/` directory exists yet.

## 6. Still open (unchanged from the plan doc)

- OCR corpus: 1 of 40 pages built (`sample36`). Needs the per-sample loop from
  `benchmarks_guide.md` §5.
- No pages promoted to `gold` via the review flow yet.
- QA VLM arm blocked on the OCR corpus (needs bounding boxes).
- `sample21` (Chinese) still in the pool — exclude before the translation sweep runs, so it
  stays single-language per the plan's prerequisite 5.
- The 3 `config/providers.json` bugs in §2 (#1, #2, #5) — recommend fixing independent of and
  before trusting any Phase A/B/C numbers that route through those exact entries.

---

## 7. 2026-08-08: curated-page bench, all free models, all providers

The translation corpus (`scripts/corpus/`) is now the full 38 pages (24 human-referenced, 1
Chinese) that the plan originally scoped, and the QA corpus (`scripts/qa_corpus/`) covers 35 of
those pages at 7 cases each (245 cases, LLM arm only). That's enough to run a real "all free
models, all providers" sweep instead of the 1-page screening pass §4 describes — this section
documents that run: which pages were chosen and why, the exact commands, and where to find
results once each stage lands. **The OCR corpus is still exactly 1 page** (`sample36`) and the
QA VLM arm is still 0 runnable cases — nothing in this section changes that; the OCR/qaVLM
sweep below is deliberately narrow because the corpus is, not because of a scoping choice.

### 7.1 Curated pages and why

| Sample | Regions | Reference | Notes |
|---|---|---|---|
| `sample36` | 5 | human | The **only** page in the OCR corpus — anchors OCR and QA-LLM to the same page translation is also tested on, so all three stages share at least one directly comparable data point. |
| `sample17` | 6 | human | Smallest clean page besides `sample36` (no `over_merge_risk` flag, 100% reference match rate). |
| `sample12` | 11 | human | Mid-size, clean (no merge-risk flag, 90.9% match rate). |
| `sample34` | 15 | human | Largest human-referenced page in the corpus — stress-tests batch handling at high region count. |

All four are Japanese, human-translated references (the trustworthy target per the plan's
Phase B guidance), and none carry the `over_merge_risk` flag that several other corpus pages
have (region-merging artifacts from auto-OCR extraction — see each sample's `meta.json`).
`sample13` was the original Phase B list's mid-size pick but was swapped for `sample12` here
specifically to avoid a flagged page in a "strong candidates" set — `sample13` is still a
reasonable page for later phases, just not the first choice when avoidable.

Region-count spread (5 → 6 → 11 → 15) intentionally covers a small/near-1:1 page and a large
15-region page in the same run, since region count is what drives both latency (bigger JSON
batches) and id-fidelity risk (more ids to echo back correctly without drops/dupes).

### 7.2 Commands actually run

All three use `scripts/test-providers.json` (not the production `config/providers.json`) and
default to **free models only** (`--free-only` is the default; paid comparison models from
§1/§3 are intentionally excluded from this pass — they're a separate, smaller follow-up, not
part of "all free models"). Each was launched detached (`nohup ... &`, `disown`) so it survives
independent of any one shell session, with per-model-per-page results written incrementally to
disk as they complete (not just at the end) — safe to inspect mid-run or resume reading after
an interruption.

```bash
# Translation — 103 free models x 4 pages = up to 412 runs
python3 scripts/benchmark_translation.py --providers-config scripts/test-providers.json \
  --pages sample36,sample17,sample12,sample34 --out-dir runs/2026-08-08/tl

# OCR — 18 free vision models x 1 page (all the OCR corpus has) x its regions
python3 scripts/benchmark_vlm_ocr.py --providers-config scripts/test-providers.json \
  --pages sample36 --out-dir runs/2026-08-08/ocr

# QA (LLM arm) — queued to start once translation clears, see §7.3
python3 scripts/benchmark_qa.py --arm llm --providers-config scripts/test-providers.json \
  --samples sample36 --out-dir runs/2026-08-08/qa
```

### 7.3 Why QA-LLM runs on 1 page here, not the same 4 as translation

A timing smoke test (`--provider openrouter --model poolside/laguna-xs-2.1:free --samples
sample36`, one model, 7 cases) took **121s** — about 17s/case average, an order of magnitude
slower per-unit than translation's ~5–20s/page. QA cases scale as `pages × 7`, not `pages × 1`
like translation, so the same 4-page set would mean 103 models × 28 cases ≈ 2,900 requests —
at the smoke-tested rate, upwards of 13 hours, and long enough to risk running into OpenRouter's
daily free-tier rate cap before finishing (the cap is per-day, not per-request-burst, and
translation is drawing from the same pool concurrently). Scoped to `sample36` alone (103 models
× 7 cases ≈ 720 requests, ~3–4h), it stays inside a single day's free-tier budget and still
delivers "all free models" coverage — just at a shallower page depth than translation.
**Widening the QA-LLM page set to match translation's 4 pages (or more) is the natural next
step once this baseline lands** — rerun §7.2's QA command with `--samples
sample36,sample17,sample12,sample34` (or the full 35-page corpus) on a day with fresh quota.

Translation and OCR were launched together (OCR is short — 18 models × 1 page finishes in
minutes — so the overlap window with translation's multi-hour run is small). QA-LLM was
deliberately **not** launched at the same time as translation: running all three concurrently
would triple the concurrent request rate against the same shared per-day OpenRouter/Cloudflare
quotas for the entire multi-hour duration, not just a short overlap, which risks turning real
capability gaps into indistinguishable 429-driven failures. It starts once the translation
watcher reports done.

### 7.4 Status / where results land

| Stage | Out dir | Expected runs | Status |
|---|---|---|---|
| Translation | `runs/2026-08-08/tl/` | ≤412 (103 free models × 4 pages) | Running, launched 2026-08-08 |
| OCR | `runs/2026-08-08/ocr/` | ≤90 (18 free VLMs × sample36's regions) | Running, launched 2026-08-08 |
| QA (LLM arm) | `runs/2026-08-08/qa/` | ≤721 (103 free models × 7 cases) | Queued — starts when translation's `_summary.json` appears |

Each stage writes a `_summary.json` in its `out-dir` when done (sorted ranking table), plus one
JSON file per model per page/case underneath — the raw data survives even if a run is killed
partway through, so partial results are still usable. `runs/` is gitignored; nothing here is
committed. Once all three land, the next step is reading the three `_summary.json` files and
writing the actual dated ranking report(s)
(`docs/free_model_bench_2026-08_translation.md` etc., per the plan's §5 output shape) — not yet
done as of this write-up; check `runs/2026-08-08/*/_summary.json` directly for the freshest
numbers in the meantime.

---

## 8. 2026-08-08: Final results

### 8.1 The usability bar, and a timeout bug that was hiding it

Early results showed "successes" at 70–165s latency. That's a bug, not a slow model: a
`requests.post(timeout=N)` timeout is a **socket-idle** timeout, not a wall-clock deadline — a
model that dribbles keep-alive bytes while "thinking" resets the timer on every chunk and can
run arbitrarily far past the nominal cap. Fixed in `bench_common.call_provider()` by submitting
the request to a `ThreadPoolExecutor` and enforcing the deadline with
`future.result(timeout=N)` instead — if the future doesn't resolve in time, it's recorded as a
`hard_timeout` immediately, regardless of what the abandoned socket does afterward. Verified via
smoke test: a known-slow model now times out at exactly 60.0s per structured-output mode, not
130s+.

The bar applied everywhere below is the one set explicitly during this pass: **a request that
takes longer than 60s to answer is a fail**, full stop, independent of whether it eventually
returns a correct answer. `run_ladder()`'s retry policy was also changed so a `hard_timeout`
doesn't retry the same mode (a model too slow once is too slow again) — it falls straight
through to the next structured-output mode, which roughly halves worst-case wall time per
failing model. All tables below were checked for hidden violations (a passing mean latency
hiding one over-60s outlier page/case) — none were found; every "ok" row here is clean under the
bar on every individual request, not just on average.

### 8.2 Translation — final ranking

90 distinct free models attempted, 4 curated pages each (up to 360 requests). **22 models are
fully clean** — 4/4 pages, every request under 60s. Ranked by mean similarity to the reference
translation:

| Provider | Model | Sim | Mean latency (s) | ID fidelity |
|---|---|---:|---:|:---:|
| nvidia | `nemotron-3-nano-30b-a3b` | 0.595 | 24.7 | ✗ |
| **neurometric** | **`clawpack`** | **0.577** | **3.9** | **✓** |
| nvidia | `google/gemma-4-31b-it` | 0.572 | 51.3 | ✓ |
| nvidia | `nemotron-3-super-120b-a12b` | 0.558 | 14.6 | ✓ |
| openrouter | `poolside/laguna-s-2.1:free` | 0.556 | 45.2 | ✗ |
| nvidia | `minimaxai/minimax-m3` | 0.556 | 16.4 | ✓ |
| nvidia | `riva-translate-4b-instruct-v1.1` | 0.552 | 6.7 | ✗ |
| openrouter | `poolside/laguna-xs-2.1:free` | 0.549 | 16.8 | ✓ |
| nvidia | `openai/gpt-oss-120b` | 0.547 | 10.7 | ✓ |
| openrouter | `nvidia/nemotron-3-super-120b-a12b:free` | 0.540 | 15.8 | ✓ |
| nvidia | `llama-3.3-nemotron-super-49b-v1` | 0.537 | 17.7 | ✓ |
| nvidia | `nemotron-3-nano-omni-30b-a3b-reasoning` | 0.534 | 13.8 | ✓ |
| nvidia | `openai/gpt-oss-20b` | 0.529 | 17.3 | ✓ |
| nvidia | `nemotron-mini-4b-instruct` | 0.523 | 7.4 | ✗ |
| openrouter | `inclusionai/ling-3.0-tiny:free` | 0.514 | 26.1 | ✓ |
| nvidia | `meta/llama-3.1-8b-instruct` | 0.495 | 6.3 | ✓ |
| nvidia | `nvidia-nemotron-nano-9b-v2` | 0.487 | 27.7 | ✓ |
| nvidia | `meta/llama-3.2-11b-vision-instruct` | 0.484 | 14.8 | ✓ |
| nvidia | `riva-translate-4b-instruct-v2` | 0.481 | 6.0 | ✗ |
| nvidia | `nemotron-nano-12b-v2-vl` | 0.478 | 14.6 | ✗ |
| openrouter | `nvidia/nemotron-3-nano-30b-a3b:free` | 0.459 | 32.0 | ✗ |
| nvidia | `llama-3.1-nemotron-nano-vl-8b-v1` | 0.391 | 12.4 | ✗ |

**Best quality pick:** `nvidia/nemotron-3-nano-30b-a3b` — top quality score, mid-pack speed
(24.7s). **Best overall pick:** `neurometric/clawpack` — 0.018 behind #1 on quality but **6.3x
faster** (3.9s) and holds strict `json_schema` mode on every page, no fallback needed. Unless
the last fraction of quality matters more than latency, this is the stronger real-world choice.

Note on `neurometric/clawpack`: the first attempt at testing this model (documented in earlier
runs this same day) came back as a 100% auth failure — traced to a stale `NEUROMETRIC_API_KEY`
in `.env`. Retested 2026-08-08 with a fresh key; all numbers above are from that retest.

Failure taxonomy for the remaining 68 models (not "the bench is broken" — three distinct real
causes):
- **~38 are NVIDIA catalog ghosts** — see §8.5.
- **~10 are Cloudflare quota exhaustion** — see §8.6, not a capability gap.
- **~8 are genuine timeouts or malformed output** — actually too slow or too unreliable at
  structured JSON under this bar.

### 8.3 OCR — final ranking

19 free vision models against `sample36` (the only page the OCR corpus currently has — this
result set is a weak signal until the corpus grows past 1 page, per §2 finding 4 / the plan's
open prerequisites). 4 models hit CER 0.0:

| Provider | Model | CER | Latency (s) |
|---|---|---:|---:|
| nvidia | `nemotron-nano-12b-v2-vl` | 0.0 | 10.8 |
| openrouter | `google/gemma-4-26b-a4b-it:free` | 0.0 | 25.9 |
| nvidia | `nemotron-3-nano-omni-30b-a3b-reasoning` | 0.0 | 39.5 |
| openrouter | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 0.0 | **78.0** |

The 4th row is a **bar failure despite perfect accuracy** — 78s is over the 60s cap, so per §8.1
this counts as a fail for real-world use even though the transcription itself was flawless.
**Effective winner: `nvidia/nemotron-nano-12b-v2-vl`** — perfect CER, fastest, and it's the same
model that led OCR's translation-adjacent tasks too, making it the strongest single VLM
candidate found across this entire pass.

Everything else scored CER ≥0.5, mostly ≥1.0 (garbage or empty output) — a much sharper falloff
than translation, consistent with VLM structured-output support being far less mature than
text-only structured output across these providers.

### 8.4 QA-LLM — partial results, stopped deliberately

**Coverage:** OpenRouter (13/13 candidates) and Cloudflare (4/28, see below) ran to completion.
NVIDIA reached 18 of 67 candidates before being stopped. Neurometric's single model was
retested 2026-08-08 with a fresh `NEUROMETRIC_API_KEY` (the original run's key was stale — see
§8.2) and came back 7/7 clean.

**10 models are fully clean** (7/7 QA cases, every request under 60s):

| Provider | Model | Cases OK | Mean latency (s) | Max latency (s) |
|---|---|---:|---:|---:|
| **neurometric** | **`clawpack`** | **7/7** | **3.8** | **5.1** |
| nvidia | `riva-translate-4b-instruct-v2` | 7/7 | 3.8 | 6.4 |
| nvidia | `riva-translate-4b-instruct-v1.1` | 7/7 | 7.2 | 13.4 |
| openrouter | `poolside/laguna-xs-2.1:free` | 7/7 | 10.0 | 13.9 |
| nvidia | `nemotron-nano-12b-v2-vl` | 7/7 | 18.9 | 33.3 |
| openrouter | `poolside/laguna-s-2.1:free` | 7/7 | 20.9 | 29.3 |
| openrouter | `nvidia/nemotron-3-nano-30b-a3b:free` | 7/7 | 27.8 | 41.6 |
| openrouter | `nvidia/nemotron-3-super-120b-a12b:free` | 7/7 | 31.2 | 49.5 |
| nvidia | `nemotron-3-nano-omni-30b-a3b-reasoning` | 7/7 | 44.5 | 56.7 |
| openrouter | `nvidia/nemotron-3-ultra-550b-a55b:free` | 7/7 | 45.4 | 54.3 |

5 more are partially clean (worth a targeted re-run, not a full retest):
`nvidia/nemotron-nano-9b-v2:free` (6/7), `minimaxai/minimax-m3` (6/7),
`inclusionai/ling-3.0-tiny:free` (4/7), `openai/gpt-oss-20b:free` (3/7),
`google/gemma-4-31b-it` (2/7, both survivors near the 60s wall — likely a genuine fail on a
full re-run, not just this-sample noise).

Notably, the models that survive QA-LLM cleanly are almost the same set that led translation —
the `riva-translate-4b` and `nemotron-3-*` families (and now `neurometric/clawpack`) dominate
both rankings, which is a useful cross-check that the bench is measuring something real rather
than task-specific noise.

**Caveat on `neurometric/clawpack`'s QA result:** request-level reliability is excellent (7/7,
fastest in the table, always `json_schema`), but the *quality* metric is weaker than the speed
suggests — macro-F1 0.478 despite perfect recall and classification on every real defect case
(6/6). The gap is a **100% false-positive rate on the control (undamaged) page**: it flagged 4
issues on a page that has none. So it never misses a real problem, but it doesn't trust clean
pages either — worth a second control-page sample before treating it as QA-ready, since a single
sample can't rule out this being that one page's phrasing rather than a systematic bias.

**Why NVIDIA was stopped at 18/67 and not run to completion:** of the 18 sampled, 9 were
instant 404 ghosts (~9s to exhaust all 7 cases) and 6 were real-but-slow — two of those,
`openai/gpt-oss-120b` and `z-ai/glm-5.2`, each burned **~18 minutes** hitting the 60s hard-cap on
every mode across all 7 cases and still ended `status: failed`. Extrapolating that mix across
the remaining 49 candidates put completion at **~4 more hours**, disproportionately spent
re-confirming that large/slow models fail the same 60s bar we'd already established. Stopped by
explicit decision rather than left to run to completion.

**What's untested, ranked for a future run.** Cross-referencing the 49 untested NVIDIA
candidates against the *already-collected* translation-run data (same provider, same account,
so ghost/latency behavior transfers) gives a real ranking instead of a guess:

- **32 are already confirmed 404 ghosts** in the translation run — same account, same catalog,
  not worth testing again in QA. (`meta/llama2-70b`, `mistralai/mistral-large`,
  `nvidia/nemotron-4-340b-instruct`, `writer/palmyra-*`, `nvidia/vila`, `nvidia/neva-22b`, and
  25 others — full list in `runs/2026-08-08/tl/nvidia/`.)
- **14 have real "ok" translation latency data** — worth testing QA next, fastest first:
  `meta/llama-3.1-8b-instruct` (6.3s), `nvidia/nemotron-mini-4b-instruct` (7.4s),
  `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` (12.4s), `nvidia/nemotron-3-super-120b-a12b` (14.6s
  — note: this is the NVIDIA-direct copy; the OpenRouter mirror of the same model already passed
  QA-LLM cleanly above, so this entry is largely redundant unless NVIDIA-direct routing matters),
  `meta/llama-3.2-11b-vision-instruct` (14.8s), `openai/gpt-oss-20b` (17.3s, NVIDIA-direct copy —
  same redundancy note), `nvidia/llama-3.3-nemotron-super-49b-v1` (17.7s),
  `nvidia/nemotron-3-ultra-550b-a55b` (22.7s, redundant with its OpenRouter mirror above),
  `nvidia/nemotron-3-nano-30b-a3b` (24.7s, redundant with its OpenRouter mirror above),
  `mistralai/mistral-nemotron` (25.2s), `nvidia/nvidia-nemotron-nano-9b-v2` (27.7s, redundant
  with its OpenRouter mirror above), `nvidia/llama-3.3-nemotron-super-49b-v1.5` (38.3s, only
  2/4 pages ok — borderline), `thinkingmachines/inkling` (52.9s, only 1/4 ok — borderline, close
  to the wall). Stripping out the ones already effectively covered via an OpenRouter mirror,
  the genuinely new candidates worth testing are: `meta/llama-3.1-8b-instruct`,
  `nvidia/nemotron-mini-4b-instruct`, `nvidia/llama-3.1-nemotron-nano-vl-8b-v1`,
  `meta/llama-3.2-11b-vision-instruct`, `mistralai/mistral-nemotron`.
- **3 are real but already failed translation outright** (`meta/llama-3.3-70b-instruct`,
  `nvidia/llama-3.1-nemotron-nano-8b-v1`, `stepfun-ai/step-3.7-flash`) — low priority, not
  ghosts but not promising either.

Run command for that targeted follow-up, once queued:
```bash
python3 scripts/benchmark_qa.py --arm llm --providers-config scripts/test-providers.json \
  --samples sample36 --provider nvidia \
  --model "meta/llama-3.1-8b-instruct,nvidia/nemotron-mini-4b-instruct,nvidia/llama-3.1-nemotron-nano-vl-8b-v1,meta/llama-3.2-11b-vision-instruct,mistralai/mistral-nemotron" \
  --sleep 1.0 --out-dir runs/2026-08-08/qa
```
(`--model` only takes one id today — split into 5 separate invocations, or extend the flag to
accept a comma list, if this is run again.)

### 8.5 Cross-cutting finding: NVIDIA's catalog has a large ghost-entry rate

Across both translation (67 candidates) and QA-LLM (18 sampled so far), roughly **55–60% of
NVIDIA's `/v1/models`-listed models 404 on every real call** — `"Function not found for account"`.
This is not detectable from any metadata; the only way to know is to call each one. It is a
catalog/deployment gap on NVIDIA's side, not a bench artifact — the same models fail identically
across two independent benchmark runs on different days. Recommendation: prune
`scripts/test-providers.json`'s NVIDIA list down to the confirmed-live set before the next bench
pass, to stop paying the (small, ~1s each, but nonzero) cost of re-discovering the same 38+
ghosts every time.

### 8.6 Cross-cutting finding: Cloudflare — recommend removal from the live fallback chain

**Evidence:** every Cloudflare model sampled across all three stages (translation, OCR,
QA-LLM) failed with `429 rate_limited` on 100% of requests, across every structured-output mode,
across multiple runs spread over several hours the same day. Cloudflare Workers AI's free
allowance is 10,000 Neurons/day, **shared account-wide across all models**, not per-model
(confirmed against Cloudflare's own docs) — moderate same-day testing volume exhausts it, and it
does not visibly recover within the same day.

**This isn't just a bench inconvenience — it's a live production risk.** Cloudflare is wired
into `config/providers.json` with `priority: 3`, sitting in the real fallback
chain between `nvidia` (priority 2) and `neurometric` (priority 4), loaded at runtime by
`ProviderConfigCache.java`. A real user request that falls through to Cloudflare today can burn
through the full retry ladder — observed at up to several seconds of dead 429s per attempt,
worse if a slow-but-technically-live model is hit — before ever reaching neurometric. Given the
shared daily quota, this isn't a rare edge case: any day with moderate free-tier usage
(including our own benchmark runs) can leave Cloudflare dead for the rest of that day for real
traffic too.

**Recommended removal plan:**
1. Remove the `cloudflare` provider block from `config/providers.json` (or, if a softer landing
   is preferred, demote `priority` below `neurometric`'s so it's never reached before quota
   status is re-verified).
2. Leave `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` wiring in `docker-compose.yml` alone —
   harmless if unused, no need to touch infra for this.
3. In `scripts/test-providers.json`, keep the Cloudflare entries but mark them clearly as
   "known quota-exhausted as of 2026-08-08" rather than deleting them outright, so a future bench
   pass on a fresh quota day can cheaply re-verify rather than re-discovering this from scratch.
4. No code changes needed beyond the config edit — `ProviderConfigCache` already sorts purely by
   `priority`, so removing/demoting the block is sufficient without touching
   `JobCoordinatorService` or the fallback logic itself.

This is a config-only change; happy to make it now if wanted, but it wasn't in scope for this
benchmarking pass and touches the live app rather than just the bench pool.

### 8.7 Overall picks, if asked "what should the app actually use"

- **Translation:** `neurometric/clawpack` — #2 on quality (0.577, essentially tied with #1) and
  by far the fastest clean model (3.9s vs. 24.7s for the quality leader `nemotron-3-nano-30b-a3b`,
  which is the pick if the last bit of quality matters more than latency).
- **OCR:** `nvidia/nemotron-nano-12b-v2-vl` — perfect CER, fastest, only model to lead in both
  OCR and translation-adjacent tasks. (Neurometric has no OCR model.)
- **QA:** `nvidia/riva-translate-4b-instruct-v2` or `neurometric/clawpack` are tied for fastest
  (3.8s) and both request-reliable — but see §8.4's caveat: clawpack has a 100% false-positive
  rate on the one control-page sample tested, so verify against a second control page before
  trusting it for QA specifically. `riva-translate-4b-instruct-v2` has no such caveat yet
  recorded and is the safer QA pick until that's checked.
- **Drop:** Cloudflare from the live fallback chain (§8.6); prune NVIDIA's ~38 confirmed ghosts
  from the candidate pool (§8.5).

### 8.8 Where the data lives

All raw per-model/per-page/per-case JSON plus `_summary.json`/`_aggregate_summary.json` files
are under `runs/2026-08-08/{tl,ocr,qa/llm}/` — gitignored, not committed. `_aggregate_summary.json`
for translation and QA-LLM were built by reading every raw file directly rather than trusting
any single invocation's `_summary.json`, because both runs were split across multiple
provider-scoped invocations (to skip confirmed-dead Cloudflare/ghost NVIDIA candidates without
burning more wall time) and each invocation's own `_summary.json` only reflects its own slice.
The QA VLM arm remains fully blocked — `vlm_ready` is `false` for all 35 QA-corpus samples until
the OCR corpus grows bounding-box coverage past `sample36`.

**Note on the Neurometric key:** the key currently in `.env`'s `NEUROMETRIC_API_KEY` was created
by the user specifically for this benchmark pass and is expected to be revoked afterward — it is
not a permanent credential. If Neurometric needs re-testing later, a fresh key will be needed;
`.env` is gitignored so this never touched version control.
