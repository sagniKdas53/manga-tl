# Local OCR Benchmarking Guide (Docker Environment)

This document provides step-by-step instructions on how to use [benchmark_local_ocr.py](file:///home/sagnik/Projects/docker-composes/manga-library/examples/sample1/benchmark_local_ocr.py) inside the Docker container to benchmark different manga page images across local OCR engines (`paddleocr`, `mangaocr`, and `easyocr`).

---

## Prerequisites

The local OCR engines require heavy ML runtimes (such as PyTorch, PaddlePaddle, and ONNX Runtime) and cached model weights, which are preloaded and configured inside the **`manga-worker`** container. Make sure the Docker services are running:

```bash
docker compose up -d
```

---

## Usage Steps

### 1. Copy the Target Image to the Container
To benchmark a new manga page (e.g. `page_02.png`), copy it from your host system into the `/app` directory of the `manga-worker` container:

```bash
docker cp path/to/your/page_02.png manga-worker:/app/page_02.png
```

### 2. Copy the Latest Benchmark Script (if modified)
If you have made edits to the script on your host, copy the updated script into the container:

```bash
docker cp examples/sample1/benchmark_local_ocr.py manga-worker:/app/benchmark_local_ocr.py
```

### 3. Run the Benchmarking Script
Execute the script inside the container using `docker compose exec`. You can benchmark all local engines or target a specific one.

#### Option A: Benchmark all 3 local engines (default)
```bash
docker compose exec worker python benchmark_local_ocr.py --image page_02.png --lang ja
```

#### Option B: Benchmark a single specific engine
```bash
docker compose exec worker python benchmark_local_ocr.py --image page_02.png --lang ja --engine paddleocr
```

---

## Script Options

* **`--image`**: Filename of the target image placed inside the `/app` directory (default: `original.jpeg`).
* **`--lang`**: Language code or alias. Supported values:
  * Japanese: `ja`, `japanese`
  * English: `en`, `english`
  * Korean: `ko`, `korean`
  * Traditional Chinese: `zh`, `zh-tw`, `chinese`
  * Simplified Chinese: `zh-cn`
* **`--engine`**: Specific engine to test: `paddleocr_v5_mobile`, `paddleocr_v5_server`, `paddleocr_v6_mobile`, `paddleocr_v6_server`, `mangaocr`, or `easyocr`. If omitted, all six will be benchmarked sequentially.

---

## 4. Retrieve Results and Annotated Images
The benchmark script generates annotated images with red text bounding boxes and overlays showing confidence/elapsed time. These are written to the `/app` directory inside the container. 

To export them to your local host's `examples/sample1/` directory:

```bash
# Export PaddleOCR demo outputs
docker cp manga-worker:/app/demo_output_local_paddleocr_v5_mobile.jpg examples/sample1/
docker cp manga-worker:/app/demo_output_local_paddleocr_v5_server.jpg examples/sample1/
docker cp manga-worker:/app/demo_output_local_paddleocr_v6_mobile.jpg examples/sample1/
docker cp manga-worker:/app/demo_output_local_paddleocr_v6_server.jpg examples/sample1/

# Export MangaOCR demo output
docker cp manga-worker:/app/demo_output_local_mangaocr.jpg examples/sample1/

# Export EasyOCR demo output
docker cp manga-worker:/app/demo_output_local_easyocr.jpg examples/sample1/
```

---

## Local OCR Engines Overview

1. **PaddleOCR (v5/v6 Mobile and Server)**:
   * **PP-OCRv6 Server (Medium)**: Highly accurate, server-grade model (34.5M parameters) using a `PPLCNetV4` backbone. Runs ~21% faster than `PP-OCRv5 Server`.
   * **PP-OCRv6 Mobile (Small)**: Extremely fast edge-optimized model (7.7M parameters) which outperforms MangaOCR in latency on CPU.
   * **PP-OCRv5 Server/Mobile**: Legacy v5 models.
2. **MangaOCR (ViT/Transformer)**:
   * Runs crop-based recognition on individual speech bubbles.
   * Provides the highest quality Japanese transcriptions inside speech bubbles.
3. **EasyOCR (CPU-based)**:
   * Runs crop-based OCR on speech bubble crops. Serves as a secondary fallback (has poor performance on vertical Japanese/manga fonts).

---

## Benchmark Findings (Sample1)

Benchmark executed on the 3 detected regions of `/app/original.jpeg` (`Sample1` manga page) on CPU:

| Engine | Target Model | Total Time (s) | Avg Time / Region (s) | Transcription Quality |
| :--- | :--- | :---: | :---: | :--- |
| **paddleocr_v6_mobile** | PP-OCRv6 Small | **3.10s** | **1.03s** | Excellent/Good |
| **mangaocr** | ViT-Transformer | **3.34s** | **1.11s** | Excellent (Best Japanese accuracy, minor bubble 3 noise) |
| **easyocr** | CRAFT / ResNet | **4.13s** | **1.38s** | Very Poor (Garbage characters) |
| **paddleocr_v5_mobile** | PP-OCRv5 Mobile | **4.99s** | **1.66s** | Moderate |
| **paddleocr_v6_server** | PP-OCRv6 Medium | **13.07s** | **4.36s** | High Precision / Excellent |
| **paddleocr_v5_server** | PP-OCRv5 Server | **21.69s** | **7.23s** | High Precision / Moderate |

---

## VLM OCR Benchmark (Consolidated Text Detection)

With our improved text detection pipeline, **both** speech bubbles (YOLO-detected) and background direct text regions (PaddleOCR-detected + clustered via proximity) are consolidated and processed. 

Running **Gemini 3.5 Flash** (via OpenRouter) on the 3 consolidated regions of the `Sample1` manga page yields:

* **Speech Bubbles Processed:** 3/3
* **Background Direct Text Regions Processed:** 0/0
* **Total Regions:** 3
* **Total Time:** 7.40s
* **Average Time per Region:** 2.47s
* **Accuracy:** **100% transcription** of speech bubble dialogue!

### Running the VLM Benchmark

To execute the VLM benchmark script:
```bash
# Copy benchmark script and target image to container
docker cp examples/sample1/benchmark_vlm_ocr.py manga-worker:/app/benchmark_vlm_ocr.py
docker cp examples/sample1/original.jpeg manga-worker:/app/original.jpeg

# Run the benchmark
docker compose exec worker python benchmark_vlm_ocr.py --image original.jpeg --lang Japanese --model gemini-3.5-flash

# Export the results image back to host
docker cp manga-worker:/app/demo_output_google_gemini-3.5-flash.jpg examples/sample1/
```
