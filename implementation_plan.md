# Offline OCR Models Support

Configure the Python worker service to run PaddleOCR, EasyOCR, and MangaOCR models locally/offline by using host-cached model directories under `./data/worker/`, mapping them via Docker volumes, and enforcing offline environment variables.

## User Review Required

> [!WARNING]
> **High Risk Modification:** The GitNexus impact analysis for `ModelManager.get_paddle_ocr_reader` and `ModelManager.get_manga_ocr_reader` indicates a **HIGH** risk blast radius because it affects the main OCR pipeline (`process_ocr` in [ocr.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/handlers/ocr.py)) and the region redo handlers.
>
> **Permission Resolution:** The host folder `data/worker` had ownership permissions resolved using a temporary container to change ownership to `sagnik:sagnik`. We can now use `./data/worker/` directly to cache all models.

## Proposed Changes

---

### Python Worker Environment

#### [MODIFY] [requirements.txt](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/requirements.txt)
- Add missing `easyocr` package dependency.

#### [MODIFY] [model_manager.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/model_manager.py)
- Set environment variables `PADDLEX_OFFLINE_MODE="1"`, `PADDLE_DISABLE_TELEMETRY="1"`, and `HF_HUB_OFFLINE="1"` before importing `paddleocr` inside the try/except block.
- Read environment variables `MANGA_OCR_USE_LOCAL` and `MANGA_OCR_MODEL_PATH` to resolve the local directory snapshot folder containing the `manga-ocr-base` model and pass it as the `pretrained_model_name_or_path` argument to `MangaOcr`.

---

### Docker Service Config

#### [MODIFY] [docker-compose.yml](file:///home/sagnik/Projects/docker-composes/manga-library/docker-compose.yml)
- Change volume mounts for `worker` service to map local cache directories to the container under `data/worker`:
  - `./data/worker/huggingface:/root/.cache/huggingface`
  - `./data/worker/paddleocr:/root/.paddleocr`
  - `./data/worker/paddlex:/root/.paddlex`
  - `./data/worker/easyocr:/root/.EasyOCR`
- Inject the offline/telemetry environment variables into the `worker` container:
  - `HF_HUB_OFFLINE=1`
  - `PADDLEX_OFFLINE_MODE=1`
  - `PADDLE_DISABLE_TELEMETRY=1`
  - `HF_HUB_DISABLE_SYMLINKS_WARNING=1`
  - `MANGA_OCR_USE_LOCAL=true`
  - `MANGA_OCR_MODEL_PATH=/root/.cache/huggingface`

## Verification Plan

### Automated Tests
- Run the python test suite to verify no syntax or runtime import errors are introduced:
  ```bash
  docker compose up -d --build worker
  ```

### Manual Verification
- Monitor the container logs via `docker compose logs -f worker` and verify:
  1. `Importing PaddleOCR` succeeds.
  2. `PaddleOCR reader ready for lang='japan'` initializes without fetching from network hosts.
  3. `Importing EasyOCR` succeeds, and the `EasyOCR Reader` is successfully initialized using local files.
  4. `Initializing MangaOCR Reader...` succeeds and prints that it is using the local resolved model path under `/root/.cache/huggingface`.
