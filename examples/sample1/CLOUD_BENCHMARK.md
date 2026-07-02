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
