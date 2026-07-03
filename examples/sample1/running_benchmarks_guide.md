# How to Run Benchmarks for Other Manga Images

This guide describes how to run the local and cloud VLM OCR benchmarks on any new manga page image using the Docker worker container.

---

## 🛠️ Step 1: Copy the Image to the Container

Place your target image (e.g. `manga_page_03.png`) in the running `manga-worker` container:

```bash
docker cp path/to/manga_page_03.png manga-worker:/app/manga_page_03.png
```

---

## 🏃‍♂️ Step 2: Run the Benchmarks

Execute the benchmark scripts inside the container using `docker compose exec`.

### Option A: Local OCR Engine Benchmark

To benchmark all local engines (PaddleOCR, MangaOCR, EasyOCR):

```bash
docker compose exec worker python benchmark_local_ocr.py --image manga_page_03.png --lang ja
```

* **`--image`**: Filename of the target image placed inside the `/app` directory.
* **`--lang`**: Language code (`ja`, `en`, `ko`, `zh-tw`, `zh-cn`).
* **`--engine`**: Target a single engine (`paddleocr_v6_mobile`, `mangaocr`, etc.) instead of all six.

### Option B: Cloud VLM OCR Benchmark

To benchmark all preconfigured cloud Vision-Language Models (Gemini, Qwen, Nemotron):

```bash
docker compose exec worker python benchmark_vlm_ocr.py --image manga_page_03.png --lang Japanese
```

* **`--image`**: Filename of the target image placed inside the `/app` directory.
* **`--lang`**: Source language name (e.g. `Japanese`, `English`, `Korean`).
* **`--model`**: Target a specific VLM model name (e.g. `--model gemini-3.5-flash` or `--model qwen3-vl-8b-instruct`).

---

## 📥 Step 3: Retrieve the Annotated Output Images

The scripts draw bounding boxes and transcribed CJK/English text overlays directly on the images, then save them in the container. Retrieve them by running:

```bash
# Export Local OCR demo output
docker cp manga-worker:/app/demo_output_local_mangaocr.jpg ./

# Export Cloud VLM OCR demo output
docker cp manga-worker:/app/demo_output_google_gemini-3.5-flash.jpg ./
```

---

## ⚙️ How to Rebuild the Image (To update fonts)

If you need to bake the newly added fonts (Chinese, Korean, Arial, Courier New) into the worker container:

```bash
docker compose build worker
docker compose up -d
```
