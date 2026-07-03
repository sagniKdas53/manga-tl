# Cloud VLM OCR Benchmarking Guide (Docker Environment)

This document provides step-by-step instructions on how to use [benchmark_vlm_ocr.py](file:///home/sagnik/Projects/docker-composes/manga-library/examples/sample1/benchmark_vlm_ocr.py) inside the Docker container to benchmark different manga page images across various cloud Vision-Language Models (VLMs) like Gemini, Qwen3-VL, and Nemotron.

---

## Prerequisites

The cloud VLM benchmark script requires API keys to connect to external model providers (OpenRouter, NVIDIA AI, OpenAI, Gemini). 

1. Ensure the API keys are set in the `.env` file at the root of the project:
   * `OPENROUTER_API_KEY`
   * `NVIDIA_API_KEY`
   * `NVIDIA_OCR_API_KEY`
   * `OPENAI_API_KEY`
2. Start the Docker services (environment variables from `.env` are automatically forwarded to the container):
   ```bash
   docker compose up -d
   ```

---

## Usage Steps

### 1. Copy the Target Image to the Container
Copy the manga page you wish to benchmark from your host system into the `/app` directory of the `manga-worker` container:

```bash
docker cp path/to/your/page_02.png manga-worker:/app/page_02.png
```

### 2. Copy the VLM Benchmark Script to the Container
Copy the benchmark script from your host system into the container:

```bash
docker cp examples/sample1/benchmark_vlm_ocr.py manga-worker:/app/benchmark_vlm_ocr.py
```

### 3. Run the Benchmarking Script
Execute the script inside the container using `docker compose exec`.

#### Option A: Benchmark all preconfigured cloud VLMs
```bash
docker compose exec worker python benchmark_vlm_ocr.py --image page_02.png --lang Japanese
```

#### Option B: Benchmark a specific model
You can target a specific VLM by passing a partial or full model name string to the `--model` argument:

```bash
# Benchmark only Gemini 3.5 Flash
docker compose exec worker python benchmark_vlm_ocr.py --image page_02.png --lang Japanese --model gemini-3.5-flash

# Benchmark only Qwen3 8B
docker compose exec worker python benchmark_vlm_ocr.py --image page_02.png --lang Japanese --model qwen3-vl-8b
```

---

## Script Options

* **`--image`**: Filename of the target image placed inside the `/app` directory (default: `original.jpeg`).
* **`--lang`**: Source language name (e.g. `Japanese`, `Korean`, `English`).
* **`--model`**: Specific model identifier string to run (e.g. `gemini`, `qwen`, `nemotron`). If not provided, the script benchmarks all pre-configured models.

---

## 4. Retrieve Annotated Images
The script generates annotated images with text bounding boxes and performance stats (speed, cost). They are named as `demo_output_<model_name>.jpg` (where slashes `/` are replaced by underscores `_`).

To copy them from the container back to your host's `examples/sample1/` directory:

```bash
# Copy Gemini 3.5 Flash output
docker cp manga-worker:/app/demo_output_google_gemini-3.5-flash.jpg examples/sample1/demo_output_google_gemini-3.5-flash.jpg

# Copy Qwen3-VL 8B output
docker cp manga-worker:/app/demo_output_qwen_qwen3-vl-8b-instruct.jpg examples/sample1/demo_output_qwen_qwen3-vl-8b-instruct.jpg
```

---

## Preconfigured Models Overview

The benchmark script supports the following cloud VLMs:

| Model ID | Provider | Cost (per 1M tokens) | Notes |
|---|---|---|---|
| `google/gemini-3.5-flash` | OpenRouter | $0.075 | Highly accurate, standard model. |
| `google/gemini-3.1-flash-lite` | OpenRouter | $0.075 | Extremely fast, cost-effective VLM. |
| `qwen/qwen3-vl-8b-instruct` | OpenRouter | $0.15 | Best quality-to-cost ratio for bulk runs. |
| `qwen/qwen3-vl-30b-a3b-instruct` | OpenRouter | $0.40 | Outstanding speed and high accuracy. |
| `qwen/qwen3-vl-32b-instruct` | OpenRouter | $0.60 | High quality dense Qwen model. |
| `qwen/qwen-2.5-vl-72b-instruct` | OpenRouter | $1.20 | Premium Qwen VL model. |
| `nvidia/nemotron-ocr-v2` | NVIDIA OCR API | $0.00 | Specialized OCR model from NVIDIA. |
| `nvidia/nemotron-nano-12b-v2-vl` | NVIDIA API | $0.00 | Free API, but prone to minor OCR errors. |

---

## VLM OCR Benchmark Findings (Consolidated Detection on Sample1)

Benchmark executed on the 3 consolidated text regions (3 speech bubbles + 0 background direct text regions) of `original.jpeg` (`Sample1` manga page):

### Model Comparison Summary
The following table summarizes the performance of all tested VLM configurations:

| Model ID | Provider | Total Time (s) | Avg Time / Region (s) | Total Tokens (In / Out) | Est. Cost | Accuracy Notes |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **qwen/qwen3-vl-8b-instruct** | OpenRouter | **2.44s** | **0.81s** | 510 / 121 | $0.000095 | Excellent transcription |
| **qwen/qwen3-vl-30b-a3b-instruct** | OpenRouter | **4.30s** | **1.43s** | 510 / 137 | $0.000259 | Excellent transcription |
| **qwen/qwen3-vl-32b-instruct** | OpenRouter | **4.36s** | **1.45s** | 510 / 122 | $0.000379 | Excellent transcription |
| **nvidia/nemotron-nano-12b-v2-vl** | NVIDIA API | **5.56s** | **1.85s** | 4577 / 121 | $0.000000 | Good (minor errors/missing characters) |
| **qwen/qwen-2.5-vl-72b-instruct** | OpenRouter | **5.69s** | **1.90s** | 575 / 136 | $0.000853 | Excellent transcription (1 minor typo) |
| **google/gemini-3.1-flash-lite** | OpenRouter | **5.78s** | **1.93s** | 3503 / 147 | $0.000274 | Excellent transcription |
| **google/gemini-3.5-flash** | OpenRouter | **7.40s** | **2.47s** | 3501 / 162 | $0.000275 | Excellent transcription |
| **qwen/qwen3-vl-235b-a22b-instruct** | OpenRouter | **8.57s** | **2.86s** | 510 / 121 | $0.001578 | Excellent transcription |
| **nvidia/nemotron-ocr-v2** | NVIDIA OCR | **0.00s** | **0.00s** | 0 / 0 | $0.000000 | Failed (401 Unauthorized) |

### Highlighted Run: Gemini 3.5 Flash

* **Model ID:** `google/gemini-3.5-flash` (via OpenRouter)
* **Speech Bubbles Processed:** 3/3
* **Background Direct Text Regions Processed:** 0/0
* **Total Regions Processed:** 3
* **Total Elapsed Time:** **7.40s**
* **Average Time per Region:** **2.47s**
* **Total Tokens:** 3,501 In, 162 Out
* **Estimated API Cost:** **$0.000275**
* **Accuracy:** **100% transcription** of speech bubble dialogue!
