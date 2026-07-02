import os
import sys
import gc
import cv2
import json
import time
import argparse
import numpy as np
from PIL import Image

def load_env(filepath):
    if not os.path.exists(filepath):
        return
    with open(filepath, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split('=', 1)
            if len(parts) == 2:
                key = parts[0].strip()
                val = parts[1].strip().strip('\'"')
                os.environ[key] = val

# Ensure we can import from unified-workers if run from examples dir
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../unified-workers')))

load_env(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../.env')))

# --- Configure PaddleOCR environment BEFORE importing worker modules ---
os.environ.setdefault("PADDLEX_OFFLINE_MODE", "1")
os.environ.setdefault("PADDLE_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")

try:
    from worker.services.bubble_detector import detect_bubbles_yolo
except ImportError:
    print("Warning: Could not import detect_bubbles_yolo. Make sure PYTHONPATH is set correctly.")
    detect_bubbles_yolo = None

try:
    from worker.utils.image import downscale_for_ocr
except ImportError:
    def downscale_for_ocr(img, max_dim=1024):
        """Fallback: reduce largest dimension to max_dim, preserving aspect ratio."""
        if img is None:
            return img, 1.0
        h, w = img.shape[:2]
        largest = max(h, w)
        if largest <= max_dim:
            return img, 1.0
        scale = max_dim / largest
        resized = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        return resized, 1.0 / scale


# ---------------------------------------------------------------------------
# Language mapping tables (mirrors worker/model_manager.py)
# ---------------------------------------------------------------------------
LANG_TO_PADDLE = {
    "ja": "japan",
    "zh": "chinese_cht",
    "zh-tw": "chinese_cht",
    "zh-cn": "ch",
    "ko": "korean",
    "en": "en",
    # Friendly aliases used on the CLI
    "japanese": "japan",
    "chinese": "chinese_cht",
    "korean": "korean",
    "english": "en",
}

LANG_TO_EASY = {
    "ja": "ja",
    "zh": "ch_tra",
    "zh-tw": "ch_tra",
    "zh-cn": "ch_sim",
    "ko": "ko",
    "en": "en",
    "japanese": "ja",
    "chinese": "ch_tra",
    "korean": "ko",
    "english": "en",
}

# Engines to benchmark (in the order they are tried by the worker)
ENGINES = ["paddleocr", "mangaocr", "easyocr"]


# ---------------------------------------------------------------------------
# Parse PaddleOCR output (mirrors worker/services/ocr.py)
# ---------------------------------------------------------------------------
def parse_paddle_ocr_results(raw_results):
    results = []
    if raw_results is None:
        return results
    try:
        if not isinstance(raw_results, list):
            raw_results = [raw_results]
        for result in raw_results:
            dt_polys   = result.get("dt_polys", [])
            rec_texts  = result.get("rec_texts", [])
            rec_scores = result.get("rec_scores", [])
            count = min(len(dt_polys), len(rec_texts), len(rec_scores))
            for i in range(count):
                bbox = dt_polys[i]
                if hasattr(bbox, "tolist"):
                    bbox = bbox.tolist()
                results.append((bbox, rec_texts[i], float(rec_scores[i])))
    except Exception as e:
        print(f"[OCR] Failed parsing PaddleOCR results: {e}", flush=True)
    return results


# ---------------------------------------------------------------------------
# Per-engine OCR helpers
# Each init_* function creates the reader once; ocr_* runs it on one crop.
# ---------------------------------------------------------------------------
import traceback


def init_paddleocr(paddle_lang):
    """Initialize and return a PaddleOCR reader, or None on failure."""
    try:
        from paddleocr import PaddleOCR
    except ImportError:
        print("  [PaddleOCR] paddleocr package not installed.")
        return None
    try:
        print(f"  [PaddleOCR] Initializing (lang={paddle_lang})...")
        reader = PaddleOCR(
            lang=paddle_lang,
            device="cpu",
            text_detection_model_name="PP-OCRv5_mobile_det",
            text_recognition_model_name="PP-OCRv5_mobile_rec",
            use_textline_orientation=False,
            use_doc_unwarping=False,
            use_doc_orientation_classify=False,
            enable_mkldnn=False,
        )
        print("  [PaddleOCR] Ready.")
        return reader
    except Exception:
        print("  [PaddleOCR] Failed to initialize:")
        traceback.print_exc()
        return None


def ocr_paddleocr(reader, crop_bgr):
    """Run PaddleOCR on a single crop. Returns (text, confidence, elapsed)."""
    try:
        crop_scaled, _ = downscale_for_ocr(crop_bgr, max_dim=1024)
        t0 = time.time()
        raw = reader.predict(crop_scaled)
        elapsed = time.time() - t0
        parsed = parse_paddle_ocr_results(raw)
        if parsed:
            text = " ".join(line[1] for line in parsed)
            conf = float(np.mean([line[2] for line in parsed]))
        else:
            text, conf = "", 0.0
        return text.strip(), conf, elapsed
    except Exception:
        print("  [PaddleOCR] Crop error:")
        traceback.print_exc()
        return "", 0.0, 0.0


def init_mangaocr():
    """Initialize and return a MangaOCR reader, or None on failure."""
    try:
        from manga_ocr import MangaOcr
    except ImportError:
        print("  [MangaOCR] manga_ocr package not installed.")
        return None
    try:
        model_path = os.environ.get("MANGA_OCR_MODEL_PATH", "kha-white/manga-ocr-base")
        force_cpu  = os.environ.get("MANGA_OCR_FORCE_CPU", "true").lower() in ("true", "1", "t")
        use_local  = os.environ.get("MANGA_OCR_USE_LOCAL", "false").lower() in ("true", "1", "t")
        
        pretrained_path = "kha-white/manga-ocr-base"
        if use_local:
            resolved_path = model_path
            if not os.path.exists(os.path.join(resolved_path, "config.json")):
                hub_dir = os.path.join(model_path, "hub/models--kha-white--manga-ocr-base/snapshots")
                if os.path.exists(hub_dir):
                    snapshots = [
                        os.path.join(hub_dir, d)
                        for d in os.listdir(hub_dir)
                        if os.path.isdir(os.path.join(hub_dir, d))
                    ]
                    if snapshots:
                        for snap in snapshots:
                            if os.path.exists(os.path.join(snap, "config.json")):
                                resolved_path = snap
                                break
            pretrained_path = resolved_path
            print(f"  [MangaOCR] Using local cached MangaOCR model resolved to: {pretrained_path}")
        else:
            print(f"  [MangaOCR] Initializing (model={model_path}, force_cpu={force_cpu})...")
            pretrained_path = model_path

        reader = MangaOcr(pretrained_model_name_or_path=pretrained_path, force_cpu=force_cpu)
        print("  [MangaOCR] Ready.")
        return reader
    except Exception:
        print("  [MangaOCR] Failed to initialize:")
        traceback.print_exc()
        return None


def ocr_mangaocr(reader, crop_bgr):
    """Run MangaOCR on a single crop. Returns (text, confidence, elapsed)."""
    try:
        crop_rgb = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB)
        pil_img  = Image.fromarray(crop_rgb)
        t0 = time.time()
        text = reader(pil_img)
        elapsed = time.time() - t0
        return (text.strip() if text else ""), 1.0, elapsed
    except Exception:
        print("  [MangaOCR] Crop error:")
        traceback.print_exc()
        return "", 0.0, 0.0


def init_easyocr(easy_lang):
    """Initialize and return an EasyOCR reader, or None on failure."""
    try:
        import easyocr
    except ImportError:
        print("  [EasyOCR] easyocr package not installed.")
        return None
    try:
        langs = [easy_lang]
        if easy_lang != "en":
            langs.append("en")
        print(f"  [EasyOCR] Initializing (langs={langs})...")
        reader = easyocr.Reader(langs, gpu=False)
        print("  [EasyOCR] Ready.")
        return reader
    except Exception:
        print("  [EasyOCR] Failed to initialize:")
        traceback.print_exc()
        return None


def ocr_easyocr(reader, crop_bgr):
    """Run EasyOCR on a single crop. Returns (text, confidence, elapsed)."""
    try:
        _, buf = cv2.imencode('.jpg', crop_bgr)
        img_bytes = buf.tobytes()
        t0 = time.time()
        crop_results = reader.readtext(img_bytes)
        elapsed = time.time() - t0
        if crop_results:
            text = " ".join(res[1] for res in crop_results)
            conf = float(np.mean([res[2] for res in crop_results]))
        else:
            text, conf = "", 0.0
        return text.strip(), conf, elapsed
    except Exception:
        print("  [EasyOCR] Crop error:")
        traceback.print_exc()
        return "", 0.0, 0.0


# ---------------------------------------------------------------------------
# Drawing helper (mirrors benchmark_vlm_ocr.py's draw_results)
# ---------------------------------------------------------------------------
def draw_results(image, results, output_path, model_name, stats=None):
    """Draw bounding boxes and OCR text on the image, similar to PP-OCRv5 demo."""
    img_draw = image.copy()
    
    # Try to load a font that supports CJK if available, else fallback
    # For a simple OpenCV script, we might just draw English/Romaji or simple text if Pillow isn't heavily used.
    # To fully support CJK rendering, we use PIL.
    try:
        from PIL import Image, ImageDraw, ImageFont
        img_pil = Image.fromarray(cv2.cvtColor(img_draw, cv2.COLOR_BGR2RGB))
        draw = ImageDraw.Draw(img_pil)
        
        # Attempt to find a standard CJK font on Linux
        font_paths = [
            "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
            "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
            "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
            "arial.ttf"
        ]
        font = None
        for path in font_paths:
            if os.path.exists(path):
                font = ImageFont.truetype(path, 20)
                break
        if not font:
            font = ImageFont.load_default()

        for res in results:
            box = res['bbox']
            x, y, w, h = box
            
            # Draw red bounding box
            draw.rectangle([x, y, x+w, y+h], outline=(255, 0, 0), width=3)
            
            text = res.get('text', '')
            if not text:
                text = "[No Text Detected]"
                
            # Draw text above the box with a small background for visibility
            text_bbox = draw.textbbox((0, 0), text, font=font)
            tw = text_bbox[2] - text_bbox[0]
            th = text_bbox[3] - text_bbox[1]
            
            text_y = y - th - 4
            if text_y < 0:
                text_y = y + h + 4
                
            text_x = x
            if text_x + tw + 4 > img_pil.width:
                text_x = img_pil.width - tw - 4
            if text_x < 0:
                text_x = 0
            
            draw.rectangle([text_x, text_y, text_x+tw+4, text_y+th+4], fill=(255, 0, 0))
            draw.text((text_x+2, text_y+2), text, font=font, fill=(255, 255, 255))
            
        # Draw model name in corner
        overlay_text = f"Model: {model_name}"
        if stats:
            for k, v in stats.items():
                overlay_text += f"\n{k}: {v}"
                
        overlay_bbox = draw.textbbox((0, 0), overlay_text, font=font)
        draw.rectangle([0, 0, overlay_bbox[2] + 20, overlay_bbox[3] + 20], fill=(0, 0, 0, 180))
        draw.text((10, 10), overlay_text, font=font, fill=(0, 255, 0))
        
        img_draw = cv2.cvtColor(np.array(img_pil), cv2.COLOR_RGB2BGR)
    except Exception as e:
        print(f"Failed to use PIL for drawing CJK characters, falling back to basic OpenCV: {e}")
        for res in results:
            box = res['bbox']
            x, y, w, h = box
            cv2.rectangle(img_draw, (x, y), (x+w, y+h), (0, 0, 255), 2)
            cv2.putText(img_draw, "TEXT", (x, max(0, y-5)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)

    cv2.imwrite(output_path, img_draw)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Benchmark Local OCR Engines")
    parser.add_argument("--image", default="original.jpeg", help="Input image path")
    parser.add_argument(
        "--lang", default="ja",
        help="Source language ISO code or name (e.g. ja, en, ko, zh, japanese, english)"
    )
    parser.add_argument(
        "--engine",
        choices=ENGINES,
        help="Specific engine to test (default: all engines)"
    )
    args = parser.parse_args()

    img = cv2.imread(args.image)
    if img is None:
        print(f"Could not load image: {args.image}")
        return

    if detect_bubbles_yolo is None:
        print("YOLO bubble detection not available.")
        return

    print("Running YOLO Bubble Detection...")
    bubbles = detect_bubbles_yolo(img)
    print(f"Detected {len(bubbles)} bubbles.")

    if not bubbles:
        return

    lang_key = args.lang.lower()
    paddle_lang = LANG_TO_PADDLE.get(lang_key, "japan")
    easy_lang   = LANG_TO_EASY.get(lang_key, "ja")

    engines_to_run = [args.engine] if args.engine else ENGINES

    # Pre-crop all bubbles once so per-engine loop is clean
    crops = []
    for bubble in bubbles:
        x, y, w, h = [int(v) for v in bubble['bbox']]
        px = max(0, x - 10)
        py = max(0, y - 10)
        pw = min(img.shape[1] - px, w + 20)
        ph = min(img.shape[0] - py, h + 20)
        crops.append((px, py, pw, ph, img[py:py + ph, px:px + pw]))

    summary_rows = []

    for engine in engines_to_run:
        print(f"\n{'=' * 42}")
        print(f"Benchmarking Engine: {engine}")
        print(f"{'=' * 42}")

        results     = []
        total_time  = 0.0
        error_count = 0

        # --- Initialize reader ONCE for all bubbles ---
        if engine == "paddleocr":
            reader = init_paddleocr(paddle_lang)
        elif engine == "mangaocr":
            reader = init_mangaocr()
        elif engine == "easyocr":
            reader = init_easyocr(easy_lang)
        else:
            reader = None

        if reader is None:
            print(f"  [!] Could not initialize {engine}. Skipping.")
            summary_rows.append({
                "engine":        engine,
                "bubbles_ok":    0,
                "bubbles_total": len(crops),
                "errors":        len(crops),
                "total_time":    0.0,
                "avg_time":      0.0,
            })
            continue

        if engine == "paddleocr":
            # Follow worker's example: run PaddleOCR on the full image once!
            t0 = time.time()
            img_scaled, ocr_upscale = downscale_for_ocr(img, max_dim=1024)
            raw = reader.predict(img_scaled)
            elapsed = time.time() - t0
            total_time = elapsed
            
            parsed = parse_paddle_ocr_results(raw)
            raw_fragments = []
            for bbox, text, confidence in parsed:
                xs = [pt[0] * ocr_upscale for pt in bbox]
                ys = [pt[1] * ocr_upscale for pt in bbox]
                x, y = int(min(xs)), int(min(ys))
                width, height = int(max(xs) - x), int(max(ys) - y)
                raw_fragments.append({
                    "text": text,
                    "confidence": float(confidence),
                    "x": x,
                    "y": y,
                    "width": width,
                    "height": height
                })

            for i, (px, py, pw, ph, crop) in enumerate(crops):
                print(f"  -> Processing Bubble {i + 1}/{len(crops)} (Size: {pw}x{ph})")
                
                # Check intersection in pixel space
                intersecting_frags = []
                for frag in raw_fragments:
                    fx1, fy1 = frag["x"], frag["y"]
                    fx2, fy2 = frag["x"] + frag["width"], frag["y"] + frag["height"]
                    
                    bx1, by1 = px, py
                    bx2, by2 = px + pw, py + ph
                    
                    ix1 = max(fx1, bx1)
                    iy1 = max(fy1, by1)
                    ix2 = min(fx2, bx2)
                    iy2 = min(fy2, by2)
                    
                    if ix1 < ix2 and iy1 < iy2:
                        intersecting_frags.append(frag)
                
                # Sort top-to-bottom, then left-to-right
                intersecting_frags.sort(key=lambda f: (f["y"], f["x"]))
                text = " ".join(f["text"] for f in intersecting_frags)
                if intersecting_frags:
                    conf = float(np.mean([f["confidence"] for f in intersecting_frags]))
                else:
                    text, conf = "", 0.0
                
                # Estimate time per bubble as total time / num bubbles
                time_per_bubble = elapsed / len(crops)
                
                print(f"    Text: {text!r:<50} | Conf: {conf:.3f} | Time: {time_per_bubble:.2f}s")
                
                results.append({
                    "bbox":       [px, py, pw, ph],
                    "text":       text,
                    "confidence": round(conf, 4),
                })
        else:
            for i, (px, py, pw, ph, crop) in enumerate(crops):
                print(f"  -> Processing Bubble {i + 1}/{len(crops)} (Size: {pw}x{ph})")

                if engine == "mangaocr":
                    text, conf, elapsed = ocr_mangaocr(reader, crop)
                elif engine == "easyocr":
                    text, conf, elapsed = ocr_easyocr(reader, crop)
                else:
                    continue

                total_time += elapsed
                print(f"    Text: {text!r:<50} | Conf: {conf:.3f} | Time: {elapsed:.2f}s")

                results.append({
                    "bbox":       [px, py, pw, ph],
                    "text":       text,
                    "confidence": round(conf, 4),
                })

        del reader
        gc.collect()

        n_ok  = len(results)
        n_all = len(crops)
        avg   = total_time / max(1, n_ok)

        print(f"\nSummary for {engine}:")
        print(f"  Bubbles processed : {n_ok}/{n_all}")
        print(f"  Errors            : {error_count}")
        print(f"  Total time        : {total_time:.2f}s")
        print(f"  Avg time/bubble   : {avg:.2f}s")

        summary_rows.append({
            "engine":        engine,
            "bubbles_ok":    n_ok,
            "bubbles_total": n_all,
            "errors":        error_count,
            "total_time":    round(total_time, 3),
            "avg_time":      round(avg, 3),
        })

        # Save annotated image
        safe_name = engine.replace("/", "_")
        out_path  = f"demo_output_local_{safe_name}.jpg"
        draw_results(img, results, out_path, engine, {
            "Total Time": f"{total_time:.2f}s",
            "Avg/Bubble": f"{avg:.2f}s",
            "Lang":       args.lang,
        })
        print(f"  Saved demo image to: {out_path}")

    # Final comparison table
    if len(summary_rows) > 1:
        print(f"\n{'=' * 60}")
        print("COMPARISON SUMMARY")
        print(f"{'=' * 60}")
        header = f"{'Engine':<15} {'OK/Total':<10} {'Errors':<8} {'Total(s)':<12} {'Avg/Bubble(s)':<15}"
        print(header)
        print("-" * len(header))
        for row in summary_rows:
            print(
                f"{row['engine']:<15} "
                f"{row['bubbles_ok']}/{row['bubbles_total']:<8} "
                f"{row['errors']:<8} "
                f"{row['total_time']:<12.3f} "
                f"{row['avg_time']:<15.3f}"
            )

    # No need to output a JSON summary as per user request


if __name__ == "__main__":
    main()
