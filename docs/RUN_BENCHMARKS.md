# Manga Library OCR & VLM Benchmarking Guide

This guide details how to benchmark different manga pages across local OCR engines and cloud Vision-Language Models (VLMs) using the built-in benchmarking scripts inside the `manga-worker` Docker container.

---

## 📋 Prerequisites

1. **Docker Environment Running:**
   Ensure all services (specifically `worker`) are up:

   ```bash
   docker compose up -d
   ```

2. **API Keys Configured:**
   Ensure required API keys for cloud VLMs are defined in the `.env` file at the root of the project:
   * `OPENROUTER_API_KEY` (for Qwen and Gemini models)
   * `GEMINI_API_KEY` (direct Google Gemini API access)
   * `NVIDIA_API_KEY` (for Nvidia Nemotron models)

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

Execute the VLM OCR script. This script detects both speech bubbles (YOLO-detected) and background direct text regions (PaddleOCR-detected + proximity clustered) to feed them as crops to various VLMs.

```bash
docker compose exec worker python benchmark_vlm_ocr.py --image my_page.png --lang Japanese
```

#### Key Arguments for Cloud VLM OCR

* `--image`: Target image filename in `/app` (default: `original.jpeg`).
* `--lang`: Language name (e.g. `Japanese`, `English`, `Korean`).
* `--model`: Benchmark a specific model instead of all preconfigured VLMs. Example: `--model gemini-3.5-flash` or `--model qwen3-vl-8b`.

---

### 4. Retrieve Annotated Images and Reports

The benchmarking scripts output annotated images containing bounding boxes, transcribed text overlays, and runtime performance statistics to the container's `/app` folder.

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
