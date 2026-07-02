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
* **`--engine`**: Specific engine to test: `paddleocr`, `mangaocr`, or `easyocr`. If omitted, all three will be benchmarked sequentially.

---

## 4. Retrieve Results and Annotated Images
The benchmark script generates annotated images with red text bounding boxes and overlays showing confidence/elapsed time. These are written to the `/app` directory inside the container. 

To export them to your local host's `examples/sample1/` directory:

```bash
# Export PaddleOCR demo output
docker cp manga-worker:/app/demo_output_local_paddleocr.jpg examples/sample1/demo_output_local_paddleocr.jpg

# Export MangaOCR demo output
docker cp manga-worker:/app/demo_output_local_mangaocr.jpg examples/sample1/demo_output_local_mangaocr.jpg

# Export EasyOCR demo output
docker cp manga-worker:/app/demo_output_local_easyocr.jpg examples/sample1/demo_output_local_easyocr.jpg
```

---

## Local OCR Engines Overview

1. **PaddleOCR (PP-OCRv5 Mobile)**:
   * Runs text detection and recognition on the **entire downscaled image** once (following the worker's design).
   * Spatially maps text regions to YOLO speech bubbles.
   * Highly robust for full page scans and layouts.
2. **MangaOCR (ViT/Transformer)**:
   * Runs crop-based recognition on individual YOLO speech bubbles.
   * Provides the highest quality Japanese transcriptions inside speech bubbles.
3. **EasyOCR (CPU-based)**:
   * Runs crop-based recognition on speech bubbles.
   * Serves as a secondary fallback.
