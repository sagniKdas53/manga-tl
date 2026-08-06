# Benchmarking Guide (Local OCR & Cloud VLMs)

This document provides step-by-step instructions on how to use `benchmark_local_ocr.py` and `benchmark_vlm_ocr.py` inside the Docker container to benchmark different manga page images.

> Translation-stage benchmarking (repeatable, multi-provider via `config/providers.json`,
> multi-page via `scripts/corpus/`): [`translation_bench.md`](translation_bench.md) — methodology
> and how to run it. [`free_openrouter_translation_benchmark_2026-08-06.md`](free_openrouter_translation_benchmark_2026-08-06.md)
> is the dated report (14 free OpenRouter models) that motivated building it.

---

## 🛠️ Prerequisites

Both local OCR engines (PaddleOCR, MangaOCR, EasyOCR) and Cloud VLMs run inside the **`manga-worker`** container.

1. Configure your API keys in the `.env` file at the root of the project (for cloud VLMs):
   * `OPENROUTER_API_KEY`
   * `NVIDIA_API_KEY`
   * `CLOUDFLARE_API_TOKEN`
   * `NEUROMETRIC_API_KEY`

2. Start the Docker services:

   ```bash
   docker compose up -d
   ```

---

## 🏃‍♂️ Running Benchmarks (Local `.venv` Approach)

Since your local `.venv` contains `paddleocr`, `onnxruntime`, and all necessary dependencies, you can run the benchmarks and tests directly on your host machine without needing to enter the Docker container or manually `docker cp` files.

Make sure your virtual environment is active:
```bash
source .venv/bin/activate
```

### 1. Run the Local OCR Benchmark
This evaluates local text detection and recognition engines and produces an OCR JSON file.

```bash
python scripts/benchmark_local_ocr.py --image examples/sample18/original.jpeg --lang ja --export-components
```

**Options**:
* `--image`: Path to the image on your host.
* `--lang`: Source language code (`ja`, `en`, `ko`, `zh-cn`).
* `--engine`: Run a specific engine instead of all (e.g., `paddleocr_v6_server`, `mangaocr`).
* `--export-components`: Outputs separate JSONs and annotated images for detection (`_det`) vs. recognition (`_rec`).

*The script will output `ocr_results_{engine}.json` and annotated `.jpg` files in the same directory as the script/execution path. We recommend moving them to your `examples/sample18/` folder to keep things organized.*

### 2. Run the Cloud VLM Benchmark (Optional)
This benchmark evaluates various Vision-Language Models for OCR capability.

```bash
python scripts/benchmark_vlm_ocr.py --image examples/sample18/original.jpeg --lang Japanese --free-only
```

### 3. Run the Translation Test
Take the JSON output from the OCR step and feed it into the translation tester.

```bash
python scripts/test_translation.py --provider openrouter --model google/gemma-4-26b-a4b-it:free --input examples/sample18/ocr_results_paddleocr_v6_server.json
```
*This will output a `tl_output_*.json` file containing the translated English text.*

### 4. Run the QA Test
Feed the translation output into the QA script to evaluate its quality.

```bash
python scripts/test_qa.py --provider openrouter --model google/gemma-4-26b-a4b-it:free --input examples/sample18/tl_output_openrouter_google_gemma-4-26b-a4b-it_free.json
```
*This will output a `qa_output_*.json` file containing the evaluation feedback.*

### 5. Render the Translated Image
Finally, use the standalone `render.py` script to draw the translated text back onto the original image using the bounding boxes from the OCR step.

```bash
python scripts/render.py \
  --image examples/sample18/original.jpeg \
  --ocr examples/sample18/ocr_results_paddleocr_v6_server.json \
  --tl examples/sample18/tl_output_openrouter_google_gemma-4-26b-a4b-it_free.json \
  --output examples/sample18/final_rendered_page.jpg
```
*This will output `final_rendered_page.jpg` with the English text placed over the original speech bubbles!*

---

## 📊 Latest Benchmark Results (Sample 18)

Below are the latest OCR benchmarking results run on `examples/sample18/original.jpeg` (Japanese manga page).

### Local OCR Engine (`paddleocr_v6_server`)

* **Bubbles Processed**: 2/2
* **Total Time**: 13.65s (CPU)
* **Average Time per Region**: 6.82s
* **Notes**: High precision text bounding boxes, strong Japanese OCR accuracy. Separate exports available for DET and REC components.

### Cloud VLMs (Free-Tier Only)

Evaluated on the same image, detecting 3 text regions (2 speech bubbles + 1 direct text region).

| Model ID                                          | Provider   | Total Time (s) | Avg Time / Region (s) | Est. Cost | Accuracy Notes                                                                 |
| :------------------------------------------------ | :--------- | :------------: | :-------------------: | :-------: | :----------------------------------------------------------------------------- |
| **nvidia/nemotron-ocr-v2**                        | NVIDIA OCR |   **1.55s**    |       **0.52s**       |   FREE    | Specialized OCR model. Extremely fast full-image processing. Good quality.     |
| **nvidia/nemotron-nano-12b-v2-vl**                | NVIDIA API |   **7.00s**    |       **2.33s**       |   FREE    | Solid standard VLM for OCR. Missed some nuances but fast.                      |
| **google/gemma-4-26b-a4b-it:free**                | OpenRouter |   **25.83s**   |       **8.61s**       |   FREE    | Accurate text extraction but significantly slower.                             |
| **nvidia/nemotron-3-nano-omni-30b-a3b-reasoning** | NVIDIA API |   **34.12s**   |      **11.37s**       |   FREE    | Reasoner VLM; too slow for bulk OCR tasks, generated extra explanation tokens. |

*(Note: See `config/providers.json` for the full list of paid models available, including Qwen3-VL and Gemini 3.5 Flash series, which offer the highest accuracy and speed for production.)*

---

## 🔍 Local OCR Engines Overview

1. **PaddleOCR (v5/v6 Mobile and Server)**:
   * **PP-OCRv6 Server (Medium)**: Highly accurate, server-grade model (34.5M parameters) using a `PPLCNetV4` backbone.
   * **PP-OCRv6 Mobile (Small)**: Fast edge-optimized model (7.7M parameters).
2. **MangaOCR (ViT/Transformer)**:
   * Runs crop-based recognition on individual speech bubbles. Highest quality Japanese transcriptions but computationally heavy.
3. **EasyOCR (CPU-based)**:
   * Basic CRAFT/ResNet based fallback. Not recommended for vertical Japanese/manga fonts.
