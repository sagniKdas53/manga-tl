# Manga Library OCR & VLM Benchmarking Guide

This guide details how to benchmark different manga pages across local OCR engines and cloud Vision-Language Models (VLMs) using the built-in benchmarking scripts inside the `manga-worker` Docker container.

> **Benchmarking the translation stage instead of OCR?** See
> [`translation_bench.md`](translation_bench.md) — a repeatable, multi-page,
> multi-provider benchmark driven by `config/providers.json` and a text-only corpus in
> `scripts/corpus/`, with a worked example in
> [`free_openrouter_translation_benchmark_2026-08-06.md`](free_openrouter_translation_benchmark_2026-08-06.md).
> This guide covers the OCR stage only (local engines + VLM-as-OCR).

---

## 📋 Prerequisites

1. **Docker Environment Running:**
   Ensure all services (specifically `worker`) are up:

   ```bash
   docker compose up -d
   ```

2. **API Keys Configured:**
   Ensure required API keys for cloud VLMs are defined in the `.env` file at the root of the project:
   * `OPENROUTER_API_KEY` (for Qwen, Gemini, and free-tier VLMs like Gemma)
   * `GEMINI_API_KEY` (direct Google Gemini API access)
   * `NVIDIA_API_KEY` (for Nvidia Nemotron models)
   * `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (for Cloudflare Workers AI VLMs)

---

## 🚀 Step-by-Step Benchmarking Walkthrough

To benchmark a new manga page (e.g. `my_page.png` located on your host):

### 1. Copy the Target Image to the Container

Copy the image into the `/app` directory of the `manga-worker` container:

```bash
docker cp path/to/my_page.png manga-worker:/app/my_page.png
```

> [!NOTE]
> Make sure both scripts `benchmark_local_ocr.py` and `benchmark_vlm_ocr.py` are present in `/app` inside the container. If they are updated on the host, copy them as well:
>
> ```bash
> docker cp examples/sample1/benchmark_local_ocr.py manga-worker:/app/benchmark_local_ocr.py
> docker cp examples/sample1/benchmark_vlm_ocr.py manga-worker:/app/benchmark_vlm_ocr.py
> ```
>
> `benchmark_vlm_ocr.py` now also imports `scripts/provider_config.py` and reads
> `config/providers.json` by default (`--providers-config` to override) — copy
> `provider_config.py` alongside it, and either confirm `config/providers.json` is reachable
> at the path the container resolves (one level up from wherever the script lands), or pass
> `--providers-config` with an explicit in-container path.

---

### 2. Run Local OCR Benchmarks

Execute the local OCR benchmarking script inside the container. This runs a YOLO model to detect speech bubbles and sequentially tests up to six local OCR engines on those bubbles.

```bash
docker compose exec worker python benchmark_local_ocr.py --image my_page.png --lang ja
```

#### Key Arguments for Local OCR

* `--image`: Filename of the target image placed inside the container's `/app` folder (default: `original.jpeg`).
* `--lang`: Language code. Supported: `ja` (Japanese), `en` (English), `ko` (Korean), `zh-tw` / `zh-cn` (Chinese).
* `--engine`: Run a specific engine instead of all six. Options:
  * `paddleocr_v6_mobile` (Edge-optimized small model, default det/rec v6)
  * `paddleocr_v6_server` (Server-grade medium model)
  * `paddleocr_v5_mobile` / `paddleocr_v5_server` (Legacy v5 models)
  * `mangaocr` (Best overall quality for speech bubbles)
  * `easyocr` (Alternative CPU fallback)

---

### 3. Run Cloud VLM OCR Benchmarks

`benchmark_vlm_ocr.py` is **corpus-driven**: it runs every matching model over the pages in
`scripts/ocr_corpus/`, scores each against that corpus's ground-truth text, and writes
everything under `--out-dir`. `--image` remains available for a one-off page, but a one-off page
has no ground truth, so it reports timing and raw text only — no accuracy.

```bash
source .venv/bin/activate

# Smoke test: baseline page, free models
python scripts/benchmark_vlm_ocr.py --provider openrouter --out-dir runs/ocr

# Whole corpus
python scripts/benchmark_vlm_ocr.py --corpus-subset all --out-dir runs/ocr-2026-08

# One-off page outside the corpus (no accuracy scoring)
python scripts/benchmark_vlm_ocr.py --image examples/sample36/source/GhSomnxbIAEPKVw.jpg \
    --out-dir /tmp/ocrbench
```

Region proposals come from the production path — YOLO bubble detection plus PaddleOCR
background text merged by `worker.services.merge_regions` — and are held constant across chat
VLMs, so the score isolates *transcription* quality rather than mixing in detection differences.
Whole-page engines that do their own detection (`nvidia/nemotron-ocr-v2`) additionally report
`detection_recall` against the corpus polygons.

Model source is `config/providers.json`'s `models.ocr` lists — same file the backend reads,
same as [`translation_bench.md`](translation_bench.md)'s approach for the translation stage.
A model is benchmarkable the moment it's added there; no code changes needed.

#### Building the OCR corpus

```bash
# One sample, PaddleOCR + up to 3 cloud vision models voting on each region
python scripts/build_ocr_corpus.py --sample sample36 --provider openrouter

# Everything, local engine only (fast; every region ends up tier "unresolved")
python scripts/build_ocr_corpus.py --local-only
```

Ground truth comes in two tiers:

* **consensus** — the medoid of all engines' transcriptions wins when at least `--min-agree`
  (default 3) land within `--tol` CER (default 0.10) of it. Comparison is NFKC-normalised, so
  full-width/half-width disagreements (`１２３` vs `123`) count as agreement rather than error.
* **gold** — hand-confirmed. `--gold sampleN` writes a self-contained
  `scripts/ocr_corpus/_review/sampleN.html` showing each region's crop beside every engine's
  candidate with the consensus preselected, so review is choose-and-correct rather than
  transcribe-from-scratch. Save from that page, then
  `python scripts/build_ocr_corpus.py --apply-review scripts/ocr_corpus/_review/sampleN.json`.

Regions that reach neither tier are marked **unresolved** and are excluded from scoring — the
engines disagreed, so scoring against that text would measure noise.

> **Pick `--min-agree` against your engine count.** OpenRouter currently exposes only two *free*
> vision models, so `paddleocr + 2 VLMs` with the default `--min-agree 3` demands **unanimity** —
> on the sample36 trial that resolved just 1 of 5 regions, with the other 4 sitting at 2-of-3
> agreement. Either widen the engine pool (`--provider` unset pulls Cloudflare and NVIDIA vision
> models in too, or add `--include-paid`), or drop to `--min-agree 2` with a tighter `--tol 0.05`
> and accept a weaker guarantee. The gold review pass exists precisely because consensus alone
> does not get you to trustworthy ground truth on a small engine pool.

#### Key Arguments for Cloud VLM OCR

* `--corpus-dir` / `--corpus-subset {quick,clean,all}` / `--pages`: which corpus pages to run.
  `quick` (default) is the baseline page; `clean` is pages with no unresolved regions.
* `--out-dir` (**required**): everything lands here, including `_summary.json`.
* `--overlays`: also write annotated demo images next to each result.
* `--image`: one-off page outside the corpus (skips scoring).
* `--lang`: Language name (e.g. `Japanese`, `English`, `Korean`).
* `--providers-config`: Path to a providers.json-shaped file (default: `config/providers.json`).
  Point at `scripts/test-providers.json` for the wider, unvetted candidate pool (§ below).
* `--provider`: Only this provider (`openrouter` / `cloudflare` / `nvidia`).
* `--model`: Only this exact model id — must match the id in the config exactly (e.g.
  `google/gemini-3.5-flash`, not a partial string like `gemini-3.5-flash`).
* `--free-only` (default) / `--include-paid`: `config/providers.json`'s `ocr` lists are
  mostly paid models — pass `--include-paid` to benchmark them, or narrow with `--provider`/`--model`.
* `--skip-specialized`: Skip non-chat specialized OCR endpoints (currently just
  `nvidia/nemotron-ocr-v2`, which uses a different payload shape — see §
  "Exploratory free VLM candidates" below).

---

### 4. Retrieve Annotated Images and Reports

`benchmark_vlm_ocr.py` writes everything under `--out-dir` (it no longer scatters files into the
working directory):

```
runs/ocr/
  _summary.json                                   ranked, CER asc then latency asc
  <provider>/<model>/<sample>.json                per-region text, CER, mode used, errors
  <provider>/<model>/<sample>-overlay.jpg         only with --overlays
```

The summary table is sorted by mean CER, so the top row is the most accurate model, and
`modes_used` shows which structured-output rung each model actually needed.

`benchmark_local_ocr.py` still outputs annotated images and stats to the container's `/app` folder.

Copy the output assets back to the host system using `docker cp`:

```bash
# Retrieve Local OCR assets
docker cp manga-worker:/app/demo_output_local_paddleocr_v6_mobile.jpg ./
docker cp manga-worker:/app/demo_output_local_mangaocr.jpg ./

# Retrieve Cloud VLM OCR assets
docker cp manga-worker:/app/demo_output_google_gemini-3.5-flash.jpg ./
docker cp manga-worker:/app/demo_output_qwen_qwen3-vl-8b-instruct.jpg ./
```

---

## 📊 Preconfigured Cloud VLM Reference

| Model ID | Provider | Cost (per 1M tokens) | Notes |
| --- | --- | --- | --- |
| `google/gemini-3.5-flash` | OpenRouter | $0.075 | Highly accurate, standard model. |
| `google/gemini-3.1-flash-lite` | OpenRouter | $0.075 | Extremely fast, cost-effective VLM. |
| `qwen/qwen3-vl-8b-instruct` | OpenRouter | $0.15 | Best quality-to-cost ratio for bulk runs. |
| `qwen/qwen3-vl-30b-a3b-instruct` | OpenRouter | $0.40 | Outstanding speed and high accuracy. |
| `qwen/qwen3-vl-32b-instruct` | OpenRouter | $0.60 | High quality dense Qwen model. |
| `qwen/qwen-2.5-vl-72b-instruct` | OpenRouter | $1.20 | Premium Qwen VL model. |
| `nvidia/nemotron-nano-12b-v2-vl` | NVIDIA API | $0.00 | Free API, but prone to minor OCR errors. |
| `nvidia/nemotron-ocr-v2` | NVIDIA OCR | $0.00 | Specialized OCR model. |

---

## 🧪 Exploratory free VLM candidates (untested)

OCR needs a model that actually accepts image input — most of a provider's free-tier chat
models don't. `scripts/test-providers.json`'s `models.ocr`/`models.qaVLM` lists per provider are
**pre-filtered to vision-capable models only** (checked against each provider's live model
metadata, refreshed 2026-08-07), unlike its `models.tl`/`models.qaLLM` lists which include
plenty of text-only models that would silently fail here. None of the following have been run
for real yet (beyond a one-region wiring smoke test — see `scripts/benchmark_vlm_ocr.py`'s
commit):

```bash
python scripts/benchmark_vlm_ocr.py --image examples/sample36/source/GhSomnxbIAEPKVw.jpg --lang Japanese \
  --providers-config scripts/test-providers.json
```

| Provider | Vision-capable free candidates |
| --- | --- |
| OpenRouter | `google/gemma-4-26b-a4b-it:free`, `google/gemma-4-31b-it:free`, `nvidia/nemotron-nano-12b-v2-vl:free`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` |
| Cloudflare | `@cf/moondream/moondream3.1-9B-A2B` (small, purpose-built VLM — already in `config/providers.json`'s production list), `@cf/google/gemma-4-26b-a4b-it`, `@cf/meta/llama-3.2-11b-vision-instruct`, `@cf/meta/llama-4-scout-17b-16e-instruct` — **`@cf/moonshotai/kimi-k2.6` and `@cf/moonshotai/kimi-k2.7-code` (the current production `qaVLM`/`ocr` default) now require the Workers Paid plan** per live `require_workers_paid: true` metadata, confirmed 2026-08-07 — not reachable on the free 10,000-neurons/day allowance regardless of balance; see [`free_model_bench_handoff_2026-08-07.md`](free_model_bench_handoff_2026-08-07.md) §2. `@cf/mistralai/mistral-small-3.1-24b-instruct` no longer reports `vision: true` live and was dropped from this list. |
| NVIDIA | `nvidia/nemotron-nano-12b-v2-vl`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`, `nvidia/llama-3.1-nemotron-nano-vl-8b-v1`, `nvidia/cosmos-reason2-8b`, `nvidia/neva-22b`, `nvidia/vila`, `meta/llama-3.2-11b-vision-instruct`, `meta/llama-3.2-90b-vision-instruct`, `microsoft/phi-3-vision-128k-instruct`, `adept/fuyu-8b` (base model, not instruction-tuned — likely needs a different prompt style) |

`nvidia/nemotron-ocr-v2` is listed separately in `test-providers.json` under
`nvidia.models.ocr_specialized_non_chat` — it's a dedicated OCR endpoint
(`https://ai.api.nvidia.com/v1/cv/nvidia/nemotron-ocr-v2`) with an `{"input": [...]}`
payload, not OpenAI-style chat messages, so `benchmark_vlm_ocr.py` special-cases it in
`call_nvidia_ocr_v2()` and runs it in a separate loop from the generic chat-VLM candidates.
Pass `--skip-specialized` to exclude it (e.g. when you only want the generic-shaped models).

---

## 🛠️ Troubleshooting

> [!WARNING]
> **Mangled or Missing Font Overlays:**
> If Japanese/Chinese/Korean characters render as squares or English text doesn't use the expected font, rebuild the worker image to bake all newly registered CJK and English fonts directly into the container:
>
> ```bash
> docker compose build worker && docker compose up -d
> ```

---
> [!IMPORTANT]
> **API 401 Unauthorized Errors:**
> If Nvidia or OpenRouter API requests fail, check that the environment variables in `.env` are correct, then restart the containers to load the new config:
>
> ```bash
> docker compose down && docker compose up -d
> ```
