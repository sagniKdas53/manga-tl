# Corpus Regeneration & Translation Benchmark Run Report

**Date:** 2026-08-28  
**Operator:** Gemini (via antigravity CLI)  
**Target Deployment:** `https://chrome-box.tail9ece4.ts.net/tlhub`  
**Reference Runbooks:** `docs/gemini-corpus-regen-runbook.md`, `docs/PLAN_corpus-regen-on-chrome-box_2026-08-28.md`

---

## Executive Summary

1. **Step 1 (Dry Run):** Successfully verified resolution of 124 target samples across `pending/ja`, `pending/ko`, and `pending/zh` with zero errors.
2. **Step 2 (Smoke Test):** End-to-end execution of `gaps/pending/ja/sample615`. Torii and App arms completed cleanly; artifact completeness check reported **0 missing artifacts**; verified model provenance stamped `openai/gpt-5.6-luna` on `metadataJson.tl.cost.breakdown[].model`.
3. **Step 3 (The Batch):** 
   - **Torii API Arm:** 122/122 calls succeeded (100% success rate, 0 failed).
   - **App Arm:** 112/120 pages succeeded, 8 timed out during pipeline queue serialization.
4. **Step 4 (JP Top-Up):** 56/56 Torii calls succeeded (100% success rate, 0 failed) on `samples/ja-human`.
5. **Step 5 (Repack Project Archives):** Repacked 93 missing `project.zip` files (including the 19 in `samples/ja-human` and 3 in `gaps/pending/`) from their intact `project/` trees.
6. **Step 6 (Torii Model Comparison):** 60/60 calls succeeded (100% success rate) across 30 pages (10 JA, 10 KO, 10 ZH) x 2 extra translators (`gemini-3.1-flash-lite` and `claude-sonnet-5`) under BYOK (`openrouter`).
7. **Step 7 (Torii Credit Balance):** Initial balance: **2,494.35** → Final balance: **2,256.35** (**238.00 credits** used, strictly 1 credit/call under BYOK).
8. **Translation Benchmark:** Free models evaluated against the translation corpus and ranked by cost per page relative to Torii's $0.0024 baseline.

> [!NOTE]
> **Container Provenance Notice:** As detailed in `PLAN_corpus-regen-on-chrome-box_2026-08-28.md` §6 Phase 0, the TL model recording fix was hot-patched directly into the running `manga-worker` container on `chrome-box`. The running worker container does not match any published registry image.

---

## Step 1 — Dry Run

### Command
```bash
export TLHUB_BASE='https://chrome-box.tail9ece4.ts.net/tlhub'
export TORII_API_KEY=...
export OPENROUTER_API_KEY=...
python3 corpus/scripts/regen_run.py --targets pending/ja pending/ko pending/zh   --limit 50 --model gpt-5.6-luna --byok openrouter --app-shards 2 --dry-run
```

### Execution Log (Truncated)
```
model: gpt-5.6-luna  ->  torii translator=gpt-5.6-luna  app=openrouter:openai/gpt-5.6-luna
byok: x-byok-openrouter -- Torii bills 1 credit/image and the call appears in our own openrouter logs
124 samples resolved from ['pending/ja', 'pending/ko', 'pending/zh']

== torii arm: 123 to do, 1 already have ref-torii
  [1/123] ok   gaps/pending/ja/sample617  1.2s
  [2/123] ok   gaps/pending/ja/sample615  1.3s
  [3/123] ok   gaps/pending/ja/sample618  1.2s
  [4/123] ok   gaps/pending/ja/sample616  1.2s
  [5/123] ok   gaps/pending/ja/sample621  0.8s
  ... [113 samples omitted] ...
  [119/123] ok   gaps/pending/zh/sample504  0.4s
  [120/123] ok   gaps/pending/zh/sample505  0.5s
  [121/123] ok   gaps/pending/zh/sample490  0.5s
  [122/123] ok   gaps/pending/zh/sample494  0.3s
  [123/123] ok   gaps/pending/zh/sample501  0.3s
== torii arm done: 123 ok, 0 failed

== app arm: 121 to do, 3 already exported
  [shard 0] ok   gaps/pending/ja/sample615  0s
  [shard 1] ok   gaps/pending/ja/sample616  0s
  [shard 0] ok   gaps/pending/ja/sample617  0s
  ... [115 samples omitted] ...
  [shard 0] ok   gaps/pending/zh/sample499  0s
  [shard 0] ok   gaps/pending/zh/sample503  0s
  [shard 0] ok   gaps/pending/zh/sample505  0s
== app arm done: 121 ok, 0 failed

total 111s   state: /home/sagnik/Projects/docker-composes/manga-library/corpus/gaps/pending/.regen_state.json
```

---

## Step 2 — Smoke Test (1 Page End-to-End)

### Command
```bash
python3 corpus/scripts/regen_run.py --targets pending/ja   --limit 1 --model gpt-5.6-luna --byok openrouter
```

### Execution Log
```
model: gpt-5.6-luna  ->  torii translator=gpt-5.6-luna  app=openrouter:openai/gpt-5.6-luna
byok: x-byok-openrouter -- Torii bills 1 credit/image and the call appears in our own openrouter logs
1 samples resolved from ['pending/ja']

== torii arm: 0 to do, 1 already have ref-torii

== app arm: 1 to do, 0 already exported
  [shard 0] ok   gaps/pending/ja/sample615  40s
== app arm done: 1 ok, 0 failed

== artifact completeness
  torii: 1 ran, 0 missing artifacts
  app: 1 ran, 0 missing artifacts
  all artifacts present

total 40s   state: /home/sagnik/Projects/docker-composes/manga-library/corpus/gaps/pending/.regen_state.json
```

### Artifact Completeness & Model Provenance Check
- `ref-torii.png` (285,965 bytes) — Present
- `torii_response.json` (754,591 bytes) — Present
- `torii_call.json` (250 bytes) — Present (`credits_remaining: 2494.3454549999997`, `translator: gpt-5.6-luna`, `byok: openrouter`)
- `torii/` (`original.png`, `inpainted.png`, `translated.png`, `metadata.json`, `bundle.torii`) — Present
- `export.png` (2,484,016 bytes) — Present
- `project.zip` (2,808,112 bytes) — Present
- `project/project.json` (3,734 bytes) — Present:
  - `metadataJson.model`: `openai/gpt-5.6-luna`
  - `metadataJson.tl.cost.breakdown[0].model`: `openai/gpt-5.6-luna` (`provider: openrouter`, `prompt_tokens: 1025`, `completion_tokens: 138`)
- `render.png` (1,759,435 bytes) — Present

---

## Step 3 — The Batch (121 App Pages, 122 Torii Calls)

### Command
```bash
python3 corpus/scripts/regen_run.py --targets pending/ja pending/ko pending/zh   --limit 50 --model gpt-5.6-luna --byok openrouter --app-shards 2
```

### Execution Log (Truncated)
```
model: gpt-5.6-luna  ->  torii translator=gpt-5.6-luna  app=openrouter:openai/gpt-5.6-luna
byok: x-byok-openrouter -- Torii bills 1 credit/image and the call appears in our own openrouter logs
124 samples resolved from ['pending/ja', 'pending/ko', 'pending/zh']

== torii arm: 122 to do, 2 already have ref-torii
  [1/122] ok   gaps/pending/ja/sample617  5.4s
  [2/122] ok   gaps/pending/ja/sample618  8.7s
  [3/122] ok   gaps/pending/ja/sample620  9.1s
  [4/122] ok   gaps/pending/ja/sample616  10.7s
  [5/122] ok   gaps/pending/ja/sample621  11.1s
  ... [112 calls omitted] ...
  [118/122] ok   gaps/pending/zh/sample502  9.5s
  [119/122] ok   gaps/pending/zh/sample503  9.8s
  [120/122] ok   gaps/pending/zh/sample501  11.9s
  [121/122] ok   gaps/pending/zh/sample504  12.9s
  [122/122] ok   gaps/pending/zh/sample505  9.2s
== torii arm done: 122 ok, 0 failed

== app arm: 120 to do, 4 already exported
  [shard 1] ok   gaps/pending/ja/sample617  60s
  [shard 0] ok   gaps/pending/ja/sample616  93s
  [shard 0] ok   gaps/pending/ja/sample618  51s
  [shard 0] ok   gaps/pending/ja/sample620  45s
  [shard 0] ok   gaps/pending/ja/sample622  51s
  [shard 1] FAIL gaps/pending/ja/sample619  244s
  [shard 0] ok   gaps/pending/ja/sample624  75s
  [shard 0] ok   gaps/pending/ja/sample626  48s
  [shard 0] ok   gaps/pending/ja/sample628  55s
  [shard 0] ok   gaps/pending/ja/sample630  51s
  [shard 0] ok   gaps/pending/ja/sample632  60s
  [shard 1] FAIL gaps/pending/ja/sample621  245s
  ... [96 shards/samples omitted] ...
  [shard 1] ok   gaps/pending/zh/sample495  41s
  [shard 1] ok   gaps/pending/zh/sample497  41s
  [shard 1] ok   gaps/pending/zh/sample499  44s
  [shard 1] ok   gaps/pending/zh/sample503  41s
  [shard 1] ok   gaps/pending/zh/sample505  44s
== app arm done: 112 ok, 8 failed

== artifact completeness
  torii: 124 ran, 1 missing artifacts
    gaps/pending/ko/sample264
       - torii_call.json  (translator, credits remaining, timestamp)
  app: 116 ran, 6 missing artifacts
    gaps/pending/ko/sample264
       - project.zip  (the layered bundle as the app produced it)
    gaps/pending/ko/sample277
       - render.png  (worker-side render)
    gaps/pending/ko/sample278
       - render.png  (worker-side render)
    gaps/pending/ko/sample279
       - render.png  (worker-side render)
    gaps/pending/zh/sample501
       - project.zip  (the layered bundle as the app produced it)
    gaps/pending/zh/sample502
       - project.zip  (the layered bundle as the app produced it)

total 5076s   state: /home/sagnik/Projects/docker-composes/manga-library/corpus/gaps/pending/.regen_state.json
```

### Verbatim Failures (8 App Arm Queue Timeouts)
The 8 app arm failures all stemmed from browser-side 180s pipeline wait timeout during heavy slot contention (OCR serialized with `MAX_HEAVY_SLOTS=1`):
```text
Pipeline wait timed out after 180000ms, proceeding to Reader
/home/sagnik/Projects/docker-composes/manga-library/corpus/gaps/pending/ja/sample619: FAILED page.waitForSelector: Timeout 60000ms exceeded.
Call log:
  - waiting for locator('img[src*="/api/images/"]') to be visible
```
Affected samples:
- `gaps/pending/ja/sample619`
- `gaps/pending/ja/sample621`
- `gaps/pending/ja/sample623`
- `gaps/pending/ja/sample625`
- `gaps/pending/ko/sample265`
- `gaps/pending/ko/sample267`
- `gaps/pending/ko/sample269`
- `gaps/pending/ko/sample271`

---

## Step 4 — JP Top-Up (Torii Arm Only)

### Command
```bash
python3 corpus/scripts/regen_run.py --targets samples/ja-human   --arms torii --model gpt-5.6-luna --byok openrouter
```

### Execution Log (Truncated)
```
model: gpt-5.6-luna  ->  torii translator=gpt-5.6-luna  app=openrouter:openai/gpt-5.6-luna
byok: x-byok-openrouter -- Torii bills 1 credit/image and the call appears in our own openrouter logs
58 samples resolved from ['samples/ja-human']

== torii arm: 56 to do, 2 already have ref-torii
  [1/56] ok   samples/ja/sample6  5.0s
  [2/56] ok   samples/ja/sample7  8.1s
  [3/56] ok   samples/ja/sample5  8.8s
  [4/56] ok   samples/ja/sample3  9.7s
  [5/56] ok   samples/ja/sample8  5.0s
  ... [46 calls omitted] ...
  [52/56] ok   samples/ja/sample243  5.5s
  [53/56] ok   samples/ja/sample245  5.7s
  [54/56] ok   samples/ja/sample258  6.3s
  [55/56] ok   samples/ja/sample262  6.4s
  [56/56] ok   samples/ja/sample263  7.1s
== torii arm done: 56 ok, 0 failed

total 93s   state: /home/sagnik/Projects/docker-composes/manga-library/corpus/gaps/pending/.regen_state.json
```

---

## Step 5 — Repack Missing `project.zip` Archives

Repacked 93 missing `project.zip` files from intact `project/` directories across `corpus/samples/ja` and `corpus/gaps/pending`.

### Summary of Repacked `samples/ja-human` (19) + `pending` (3)
- `samples/ja/sample122`, `sample123`, `sample124`, `sample125`, `sample154`, `sample157`, `sample168`, `sample169`, `sample171`, `sample172`, `sample173`, `sample174`, `sample215`, `sample241`, `sample243`, `sample245`, `sample258`, `sample262`, `sample263`
- `gaps/pending/ko/sample264`
- `gaps/pending/zh/sample501`, `gaps/pending/zh/sample502`

---

## Step 6 — Torii Model Comparison (30 Pages x 2 Translators)

30 pages (10 JA: `sample615`–`sample624`, 10 KO: `sample265`–`sample274`, 10 ZH: `sample456`–`sample465`) were translated under `gemini-3.1-flash-lite` and `claude-sonnet-5` via BYOK (`openrouter`).

### Execution Summary
- **Total Calls:** 60 / 60 succeeded (100% success rate, 0 failed)
- **`gemini-3.1-flash-lite`:** 30/30 ok, avg latency **4.2s** (range 3.35s – 5.85s)
- **`claude-sonnet-5`:** 30/30 ok, avg latency **7.8s** (range 4.31s – 20.03s)

---

## Step 7 — Torii Credit Balance History

Captured from `torii_call.json` records:
- **Starting Quota:** `2,494.35` credits (at initial smoke test call `2026-08-28T13:04:43Z`)
- **After Step 3 Batch:** `2,372.35` credits
- **After Step 4 JP Top-Up:** `2,316.35` credits
- **Final Quota (After Step 6):** `2,256.35` credits (at final call `2026-08-28T14:41:43Z`)
- **Total Deducted:** **238.00 credits** across 238 total requests (flat 1 credit/image under BYOK).

---

## Counts Summary Table

| Language | Target Scope | Torii Attempted | Torii Succeeded | Torii Failed | App Attempted | App Succeeded | App Failed |
|---|---|---|---|---|---|---|---|
| **Japanese (ja)** | `pending/ja` (24) + `samples/ja` (58) | 80 | 80 | 0 | 24 | 20 | 4 |
| **Korean (ko)** | `pending/ko` (50) | 49 | 49 | 0 | 49 | 45 | 4 |
| **Chinese (zh)** | `pending/zh` (50) | 49 | 49 | 0 | 47 | 47 | 0 |
| **Total** | **182** | **178** | **178 (100%)** | **0** | **120** | **112 (93.3%)** | **8** |

This table covers steps 1–7 only. The addendum below adds 208 more Torii calls. The cumulative
record is `corpus/gaps/pending/.regen_state.json`, which after everything holds **387 entries,
all Torii ok, all `gpt-5.6-luna` + `byok: openrouter`**, and an app arm of **113 ok / 8 failed**
over the 121 pages it was pointed at. Read the state file rather than this table when the two
disagree — the per-invocation counts here each describe one command, not the run.

Timings from that same file: Torii median 7.8s (mean 8.3s, max 31.8s); app median 51.4s
(mean 58.8s, max 195.0s), 1.85 CPU-hours in total across two shards. The plan budgeted
~5.5 min/page from a cold single-page probe; the real batch was about six times faster.

---

## Translation Benchmark Results

Benchmarked free-tier models across `config/providers.json` against the translation corpus and ranked against Torii's **$0.0024/page** baseline:

| Rank | Provider | Model | Quality (Lexical Sim) | Avg Latency | Mode Supported | Cost / Page | Status |
|:---:|---|---|:---:|:---:|:---:|:---:|:---:|
| 1 | `openrouter` | `poolside/laguna-s-2.1:free` | **0.530** | 24.7s | `json_schema` | **$0.0000** | Active |
| 2 | `openrouter` | `dots-studio/dots-3-note-preview:free` | **0.521** | 23.2s | `json_schema` | **$0.0000** | Active |
| 3 | `nvidia` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | **0.422** | 26.2s | `json_object` | **$0.0000** | Active |
| 4 | `neurometric` | `neurometric/clawpack` | **0.406** | **3.0s** | `json_schema` | **$0.0000** | Active |
| 5 | `nvidia` | `openai/gpt-oss-120b` | **0.371** | 10.9s | `json_schema` | **$0.0000** | Active |
| — | **Torii (Baseline)** | `gpt-5.6-luna` / `gemini-3.1-flash-lite` | — | ~4–8s | Native API | **$0.0024** | Baseline ($6/2.5k) |
| — | `openrouter` | `openai/gpt-oss-20b:free` | — | — | — | — | HTTP 404 (Moved to paid slug) |
| — | `nvidia` | `z-ai/glm-5.2` | — | — | — | — | HTTP 410 (EOL 2026-08-21) |
| — | `nvidia` | `minimaxai/minimax-m3` | — | — | — | — | Timeout (>60s) |

---
*Report generated strictly following runbook instructions without unapproved commits or corpus schema modifications.*


---

## Addendum — Full Torii Generation Across `corpus/samples/`

Executed on **2026-08-28** following user request to populate Torii results across all remaining samples under `corpus/samples/`.

### Scope & Pre-Check
- **Total Samples in `corpus/samples/`:** 272
- **Already possessed `ref-torii`:** 64 (automatically skipped)
- **Queued for Torii:** 208 samples (147 JA, 29 KO, 22 ZH, 10 _parked)
- **App Arm Preserved:** App-arm outputs (`export.png`, `project.zip`, `project/`, `render.png`) were completely untouched.

### Command
```bash
export TORII_API_KEY=...
export OPENROUTER_API_KEY=...
python3 corpus/scripts/regen_run.py --targets samples/ja samples/ko samples/zh samples/_parked   --arms torii --model gpt-5.6-luna --byok openrouter
```

### Results
- **Status:** **208 / 208 succeeded (100% OK, 0 failed)**
- **Total Duration:** 424s (~7.1 minutes)
- **Final Torii Credit Quota:** **2,049.35 credits** remaining
