import gc
import cv2
import numpy as np
import requests
from PIL import Image
from functools import cmp_to_key

from worker.config import CALLBACK_URL, BACKEND_HEADERS
from worker.model_manager import model_manager
from worker.utils.image import downscale_for_ocr, calculate_overlap_area, download_image
from worker.utils.text import detect_language
from worker.services.ocr import parse_paddle_ocr_results
from worker.services.layout import bubble_compare
from worker.utils.lock import acquire_lock


def process_ocr(job_data):
    image_id = job_data["imageId"]
    # The backend sets these from the series context when it enqueues the job.
    # Defaults preserve the original behaviour (Japanese RTL) when not supplied.
    source_language = (job_data.get("sourceLanguage") or "ja").strip().lower()
    reading_direction = (job_data.get("readingDirection") or "rtl").strip().lower()
    print(
        f"[OCR] Processing image: {image_id} (lang={source_language}, direction={reading_direction})",
        flush=True,
    )

    try:
        backend_url = CALLBACK_URL.replace("/jobs/callback", f"/images/{image_id}")
        res = requests.get(backend_url, headers=BACKEND_HEADERS)
        if res.status_code != 200:
            print(f"[OCR] Failed to get image info: {res.status_code}", flush=True)
            return
        image_info = res.json()
        panels = image_info.get("panels", [])
    except Exception as e:
        print(f"[OCR] Error fetching image details: {e}", flush=True)
        return

    try:
        img_bytes = download_image(image_info)
    except Exception as e:
        print(f"[OCR] Error downloading image: {e}", flush=True)
        return

    try:
        with acquire_lock("ocr"):
            results = []
            ocr_upscale = 1.0  # multiplier to map OCR coords back to original image
            img_decoded = None  # decoded image reused by both PaddleOCR and MangaOCR
            img_original = None  # full-resolution image for MangaOCR crops
            
            # Try PaddleOCR (PP-OCRv5) first — reader is lazily created per language
            paddle_ocr_reader = model_manager.get_paddle_ocr_reader(source_language)
            if paddle_ocr_reader is not None:
                try:
                    print(
                        f"[OCR] Running PaddleOCR (PP-OCRv5 Mobile, lang={source_language}).",
                        flush=True,
                    )

                    try:
                        import psutil
                        rss = psutil.Process().memory_info().rss / 1024 / 1024
                        print(f"[OCR] Memory before OCR: {rss:.1f} MB", flush=True)
                    except Exception:
                        pass

                    nparr = np.frombuffer(img_bytes, np.uint8)
                    img_original = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

                    img_decoded, ocr_upscale = downscale_for_ocr(img_original, max_dim=1024)

                    if ocr_upscale != 1.0:
                        print(
                            f"[OCR] Downscaled image for OCR (upscale factor: {ocr_upscale:.2f}x)",
                            flush=True,
                        )

                    del nparr  # free compressed buffer immediately
                    if img_decoded is not None:
                        print("[OCR] Calling PaddleOCR...", flush=True)
                        raw_results = paddle_ocr_reader.predict(img_decoded)
                        print("[OCR] PaddleOCR returned.", flush=True)
                        results = parse_paddle_ocr_results(raw_results)
                        del raw_results
                        gc.collect()
                    else:
                        print(
                            "[OCR] OpenCV failed to decode image for PaddleOCR", flush=True
                        )
                except Exception as ocr_err:
                    print(
                        f"[OCR] PaddleOCR failed with exception: {ocr_err}. Falling back...",
                        flush=True,
                    )

            # Fallback to EasyOCR if results are empty and reader is available
            easy_reader = model_manager.get_easy_ocr_reader()
            if not results and easy_reader is not None:
                try:
                    print("[OCR] Running EasyOCR fallback...", flush=True)
                    results = easy_reader.readtext(img_bytes)
                except Exception as ocr_err:
                    print(f"[OCR] EasyOCR failed: {ocr_err}", flush=True)

            if not results:
                print("[OCR] No text regions detected", flush=True)
                results = []

            # Force GC to reclaim any large temporary tensors created during inference
            gc.collect()

            # Use the full-resolution original image for MangaOCR crops
            # (img_decoded may be downscaled, so we use img_original instead)
            img = img_original if img_original is not None else img_decoded
            manga_ocr_reader = model_manager.get_manga_ocr_reader()
            if img is None and manga_ocr_reader is not None:
                try:
                    nparr = np.frombuffer(img_bytes, np.uint8)
                    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                    del nparr
                except Exception as e:
                    print(f"[OCR] Error decoding image for MangaOCR: {e}", flush=True)

            regions = []
            for bbox, text, confidence in results:
                # Scale bounding box coords back to original image dimensions
                xs = [pt[0] * ocr_upscale for pt in bbox]
                ys = [pt[1] * ocr_upscale for pt in bbox]
                x, y = int(min(xs)), int(min(ys))
                width, height = int(max(xs) - x), int(max(ys) - y)

                lang = detect_language(text)

                # Run MangaOCR on bubbles with CJK (Japanese/Chinese) characters
                is_manga_ocr = False
                if lang in ("ja", "zh-TW") and manga_ocr_reader is not None and img is not None:
                    try:
                        img_h, img_w = img.shape[:2]
                        x1, y1 = max(0, x), max(0, y)
                        x2, y2 = min(img_w, x + width), min(img_h, y + height)

                        if (x2 - x1) > 0 and (y2 - y1) > 0:
                            crop = img[y1:y2, x1:x2]
                            crop_rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
                            pil_img = Image.fromarray(crop_rgb)
                            manga_text = manga_ocr_reader(pil_img)
                            if manga_text and len(manga_text.strip()) > 0:
                                print(
                                    f"[OCR] Overwriting EasyOCR/PaddleOCR text '{text}' with MangaOCR '{manga_text}'",
                                    flush=True,
                                )
                                text = manga_text
                                is_manga_ocr = True
                    except Exception as e:
                        print(
                            f"[OCR] MangaOCR failed on region ({x},{y},{width},{height}): {e}",
                            flush=True,
                        )

                regions.append(
                    {
                        "text": text,
                        "detectedLanguage": lang,
                        "confidence": 1.0 if is_manga_ocr else float(confidence),
                        "rotation": 0.0,
                        "x": x,
                        "y": y,
                        "width": width,
                        "height": height,
                        "panelId": None,
                        "bubbleReadingOrder": 0,
                    }
                )

            from worker.services.merge_regions import merge_ocr_regions
            regions = merge_ocr_regions(regions, reading_direction)

            panel_regions_map = {}
            unmapped_regions = []

            for r in regions:
                best_panel_idx = -1
                max_overlap = 0
                for idx, p in enumerate(panels):
                    overlap = calculate_overlap_area(r, p)
                    if overlap > max_overlap:
                        max_overlap = overlap
                        best_panel_idx = idx

                if best_panel_idx != -1:
                    if best_panel_idx not in panel_regions_map:
                        panel_regions_map[best_panel_idx] = []
                    panel_regions_map[best_panel_idx].append(r)
                else:
                    unmapped_regions.append(r)

            ordered_regions = []
            sorted_panel_indices = sorted(
                panel_regions_map.keys(), key=lambda idx: panels[idx]["readingOrder"]
            )

            # Curry the reading direction into the comparator so sort is direction-aware
            def _bubble_cmp(a, b):
                return bubble_compare(a, b, reading_direction)

            for panel_idx in sorted_panel_indices:
                panel_bubbles = panel_regions_map[panel_idx]
                panel_bubbles.sort(key=cmp_to_key(_bubble_cmp))

                for b_order, r in enumerate(panel_bubbles, start=1):
                    r["bubbleReadingOrder"] = b_order
                    ordered_regions.append(r)

            unmapped_regions.sort(key=cmp_to_key(_bubble_cmp))
            for b_order, r in enumerate(unmapped_regions, start=1):
                r["bubbleReadingOrder"] = b_order
                ordered_regions.append(r)

            print(
                f"[OCR] Completed OCR. Found {len(ordered_regions)} text regions (lang={source_language}, direction={reading_direction})",
                flush=True,
            )

            callback_payload = {
                "imageId": image_id,
                "sourceLanguage": source_language,
                "readingDirection": reading_direction,
                "regions": ordered_regions,
            }
            try:
                res = requests.post(
                    f"{CALLBACK_URL}/ocr", json=callback_payload, headers=BACKEND_HEADERS
                )
                print(f"[OCR] Callback status code: {res.status_code}", flush=True)
            except Exception as e:
                print(f"[OCR] Failed to post callback to backend: {e}", flush=True)
    except Exception as e:
        print(f"[OCR] Error during locked OCR process: {e}", flush=True)
        return
