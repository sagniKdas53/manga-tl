import os
import sys
import cv2
import json
import base64
import time
import argparse
import requests
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from provider_config import (  # noqa: E402
    load_env,
    load_providers_config,
    resolve_base_url,
    build_headers,
    list_candidate_models,
    list_specialized_models,
)

# worker/src is where worker.* actually lives (see scripts/build_translation_corpus.py's
# same fix) — this previously pointed at a nonexistent ../../unified-workers, which silently
# degraded detect_bubbles_yolo and the background-text merge path to no-ops.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'worker', 'src')))

try:
    from worker.services.bubble_detector import detect_bubbles_yolo
except ImportError:
    print("Warning: Could not import detect_bubbles_yolo. Make sure PYTHONPATH is set correctly.")
    detect_bubbles_yolo = None

load_env(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.env')))

DEFAULT_PROVIDERS_CONFIG = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "config", "providers.json"))

# nemotron-ocr-v2 (and any future entry under a provider's models.ocr_specialized_non_chat)
# is a dedicated computer-vision endpoint, not an OpenAI-style chat completion — it takes a
# flat {"input": [{"type": "image_url", ...}]} payload and returns text_detections, not
# choices[].message.content. It runs once per whole page, not per region crop, and reuses
# its parent provider's auth (keyEnvVar) rather than declaring its own baseUrl/headers, so we
# special-case it here instead of trying to force it through the generic chat call path.
NVIDIA_OCR_URL = "https://ai.api.nvidia.com/v1/cv/nvidia/nemotron-ocr-v2"


def call_vlm_ocr(image_crop, provider_name, provider_cfg, model_id, language):
    """Call a chat-completion-shaped VLM API with the bubble crop. Models under a provider's
    models.ocr_specialized_non_chat (e.g. nemotron-ocr-v2) don't go through this — see
    call_nvidia_ocr_v2() and main()'s specialized-model loop instead."""
    try:
        url = resolve_base_url(provider_cfg["baseUrl"])
        headers = build_headers(provider_cfg)
    except ValueError as e:
        return {"error": str(e)}

    # Encode crop
    _, buffer = cv2.imencode('.jpg', image_crop)
    base64_image = base64.b64encode(buffer).decode('utf-8')

    prompt = f"""You are an OCR engine processing {language} manga.
Extract every visible character from this speech bubble.
Return JSON only.
{{
  "text": "...",
  "language": "...",
  "writing_direction": "horizontal|vertical"
}}
Do not translate.
Do not explain.
Do not infer missing characters."""

    payload = {
        "model": model_id,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_image}"}}
                ]
            }
        ],
        "response_format": {"type": "json_object"},
    }
    if provider_name == "openrouter":
        payload["plugins"] = [{"id": "response-healing"}]

    start_time = time.time()
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=30)
        response.raise_for_status()
        data = response.json()

        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")

        # Clean markdown formatting if present
        content = content.strip()
        if content.startswith("```json"):
            content = content[7:]
        if content.startswith("```"):
            content = content[3:]
        if content.endswith("```"):
            content = content[:-3]

        parsed = json.loads(content.strip())

        usage = data.get("usage", {})
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)

        return {
            "result": parsed,
            "time": time.time() - start_time,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens
        }
    except Exception as e:
        print(f"  [!] API Error ({model_id}): {e}")
        return {"error": str(e), "time": time.time() - start_time}


def call_nvidia_ocr_v2(img, regions_list, nvidia_provider_cfg):
    """Full-page OCR via nemotron-ocr-v2's dedicated CV endpoint, then intersect its
    detections against each already-detected region's bbox. Returns (results, total_time)
    in the same per-region shape the chat-model path produces, or (None, error_message)."""
    try:
        headers = build_headers(nvidia_provider_cfg)
    except ValueError as e:
        return None, str(e)
    headers["Accept"] = "application/json"

    start_time = time.time()
    scale = 1.0
    while True:
        resized = cv2.resize(img, (0, 0), fx=scale, fy=scale)
        _, buffer = cv2.imencode('.jpg', resized, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        b64 = base64.b64encode(buffer).decode('utf-8')
        if len(b64) < 175000:
            break
        scale -= 0.1

    payload = {'input': [{'type': 'image_url', 'url': f'data:image/jpeg;base64,{b64}'}]}

    try:
        resp = requests.post(NVIDIA_OCR_URL, headers=headers, json=payload, timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        return None, str(e)

    full_text_detections = []
    for dt in data.get("data", []):
        for det in dt.get("text_detections", []):
            pts = det.get("bounding_box", {}).get("points", [])
            text = det.get("text_prediction", {}).get("text", "")
            if pts and text:
                min_x = min(p["x"] for p in pts)
                max_x = max(p["x"] for p in pts)
                min_y = min(p["y"] for p in pts)
                max_y = max(p["y"] for p in pts)
                full_text_detections.append({"text": text, "nx1": min_x, "ny1": min_y, "nx2": max_x, "ny2": max_y})

    total_time = time.time() - start_time
    print(f"  -> Full image OCR took {total_time:.2f}s. Detected {len(full_text_detections)} text regions.")

    results = []
    for i, r_item in enumerate(regions_list):
        x, y, w, h = r_item['bbox']
        px, py = max(0, x - 10), max(0, y - 10)
        pw, ph = min(img.shape[1] - px, w + 20), min(img.shape[0] - py, h + 20)

        bnx1, bny1 = px / img.shape[1], py / img.shape[0]
        bnx2, bny2 = (px + pw) / img.shape[1], (py + ph) / img.shape[0]

        intersecting_texts = []
        for det in full_text_detections:
            ix1, iy1 = max(bnx1, det["nx1"]), max(bny1, det["ny1"])
            ix2, iy2 = min(bnx2, det["nx2"]), min(bny2, det["ny2"])
            if ix1 < ix2 and iy1 < iy2:
                intersecting_texts.append(det["text"])

        final_text = "\n".join(intersecting_texts).strip() or "[No Text Detected]"
        print(f"  -> Region {i+1}/{len(regions_list)} Text: {final_text}")
        results.append({"bbox": [px, py, pw, ph], "text": final_text, "language": "", "dir": ""})

    return results, total_time

def draw_results(image, results, output_path, model_name, stats=None):
    """Draw bounding boxes and OCR text on the image, similar to PP-OCRv5 demo."""
    img_draw = image.copy()

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

            draw.rectangle([x, y, x+w, y+h], outline=(255, 0, 0), width=3)

            text = res.get('text', '')
            if not text:
                text = "[No Text Detected]"

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

def get_local_paddle_reader(lang_key):
    # Mapping lang to paddle lang
    LANG_TO_PADDLE = {
        "ja": "japan",
        "zh": "chinese_cht",
        "zh-tw": "chinese_cht",
        "zh-cn": "ch",
        "ko": "korean",
        "en": "en",
        "japanese": "japan",
        "chinese": "chinese_cht",
        "korean": "korean",
        "english": "en",
    }
    paddle_lang = LANG_TO_PADDLE.get(lang_key.lower(), "japan")
    det_model = os.environ.get("PADDLEOCR_DET_MODEL", "PP-OCRv5_mobile_det").strip()
    rec_model = os.environ.get("PADDLEOCR_REC_MODEL", "PP-OCRv5_mobile_rec").strip()
    ocr_device = os.environ.get("PADDLEOCR_DEVICE", "cpu").strip().lower()
    try:
        from paddleocr import PaddleOCR as _PaddleOCR
        print(f"  [PaddleOCR] Initializing for VLM region detection (Det: {det_model}, Rec: {rec_model}, Device: {ocr_device})...")
        return _PaddleOCR(
            lang=paddle_lang,
            device=ocr_device,
            text_detection_model_name=det_model,
            text_recognition_model_name=rec_model,
            use_textline_orientation=False,
            use_doc_unwarping=False,
            use_doc_orientation_classify=False,
            enable_mkldnn=False,
        )
    except Exception as e:
        print(f"Failed to initialize PaddleOCR: {e}")
        return None

def get_all_text_regions(img, lang_key):
    """
    Get all text regions by running YOLO bubble detection and PaddleOCR,
    mapping fragments, and grouping unmatched background fragments.
    """
    regions_list = []

    # 1. Run YOLO bubble detection
    bubbles = []
    if detect_bubbles_yolo is not None:
        try:
            bubbles = detect_bubbles_yolo(img)
        except Exception as e:
            print(f"Failed to run YOLO bubble detection: {e}")

    # Add detected bubbles
    for i, bubble in enumerate(bubbles):
        bx, by, bw, bh = bubble["bbox"]
        regions_list.append({
            "bbox": [bx, by, bw, bh],
            "type": "bubble",
            "id": f"bubble_{i}",
            "mask_polygon": bubble.get("mask_polygon")
        })

    # 2. Run PaddleOCR to find direct background text (if paddleocr is available)
    reader = get_local_paddle_reader(lang_key)
    if reader is not None:
        try:
            from worker.utils.image import downscale_for_ocr
            from worker.services.ocr import parse_paddle_ocr_results
            from worker.services.merge_regions import merge_ocr_regions

            img_h, img_w = img.shape[:2]
            img_scaled, ocr_upscale = downscale_for_ocr(img, max_dim=1024)
            raw = reader.predict(img_scaled)
            parsed = parse_paddle_ocr_results(raw)

            raw_fragments = []
            for bbox, text, confidence in parsed:
                xs = [pt[0] * ocr_upscale for pt in bbox]
                ys = [pt[1] * ocr_upscale for pt in bbox]
                x, y = int(min(xs)), int(min(ys))
                width, height = int(max(xs) - x), int(max(ys) - y)
                raw_fragments.append({
                    "text": text,
                    "detectedLanguage": "ja",
                    "confidence": float(confidence),
                    "x": x,
                    "y": y,
                    "width": width,
                    "height": height
                })

            # Create binary masks for bubbles to match overlap
            bubble_masks = []
            for r in regions_list:
                poly = np.array(r["mask_polygon"], dtype=np.int32)
                mask = np.zeros((img_h, img_w), dtype=np.uint8)
                cv2.fillPoly(mask, [poly], 255)
                bubble_masks.append(mask)

            # Map fragments to bubbles
            for frag in raw_fragments:
                best_b_idx = -1
                max_overlap = 0
                fx1 = max(0, min(img_w - 1, frag["x"]))
                fy1 = max(0, min(img_h - 1, frag["y"]))
                fx2 = max(0, min(img_w, frag["x"] + frag["width"]))
                fy2 = max(0, min(img_h, frag["y"] + frag["height"]))

                if fx2 > fx1 and fy2 > fy1:
                    for b_idx, mask in enumerate(bubble_masks):
                        overlap = np.sum(mask[fy1:fy2, fx1:fx2] > 0)
                        if overlap > max_overlap:
                            max_overlap = overlap
                            best_b_idx = b_idx
                frag["bubble_idx"] = best_b_idx

            # Merge unmatched fragments (direct text)
            unmatched_frags = [f for f in raw_fragments if f.get("bubble_idx", -1) == -1]
            if unmatched_frags:
                merged_unmatched = merge_ocr_regions(unmatched_frags, "rtl") # default to rtl for manga
                for idx, r_sub in enumerate(merged_unmatched):
                    regions_list.append({
                        "bbox": [r_sub["x"], r_sub["y"], r_sub["width"], r_sub["height"]],
                        "type": "direct_text",
                        "id": f"direct_text_{idx}",
                        "mask_polygon": None
                    })
        except Exception as e:
            print(f"Failed to process PaddleOCR background text in benchmark: {e}")

    # Ensure bounding boxes are integers and within image bounds
    for r in regions_list:
        x, y, w, h = r["bbox"]
        rx = max(0, min(img.shape[1]-1, int(x)))
        ry = max(0, min(img.shape[0]-1, int(y)))
        rw = max(1, min(img.shape[1]-rx, int(w)))
        rh = max(1, min(img.shape[0]-ry, int(h)))
        r["bbox"] = [rx, ry, rw, rh]

    return regions_list

def main():
    parser = argparse.ArgumentParser(description="Benchmark VLM OCR Models — driven by config/providers.json (or scripts/test-providers.json)")
    parser.add_argument("--image", default="original.jpeg", help="Input image path")
    parser.add_argument("--lang", default="Japanese", help="Source language (e.g. Japanese, Korean, English)")
    parser.add_argument("--providers-config", default=DEFAULT_PROVIDERS_CONFIG,
                         help="Path to a providers.json-shaped file. config/providers.json is the curated "
                              "production list; scripts/test-providers.json is the wider, unvetted candidate pool.")
    parser.add_argument("--provider", help="Only this provider (openrouter/cloudflare/nvidia)")
    parser.add_argument("--model", help="Only this model id")
    parser.add_argument("--free-only", action="store_true", default=True, help="Default: free models only")
    parser.add_argument("--include-paid", dest="free_only", action="store_false", help="Also test paid models")
    parser.add_argument("--skip-specialized", action="store_true",
                         help="Skip provider models.ocr_specialized_non_chat entries (e.g. nemotron-ocr-v2)")
    args = parser.parse_args()

    img = cv2.imread(args.image)
    if img is None:
        print(f"Could not load image: {args.image}")
        return

    print("Running Consolidated Text Region Detection (Speech Bubbles + Background Direct Text)...")
    regions_list = get_all_text_regions(img, args.lang)
    print(f"Detected {len(regions_list)} text regions in total.")

    if not regions_list:
        return

    providers_cfg = load_providers_config(args.providers_config)
    # models.ocr is pre-filtered to vision-capable models by whoever built the providers
    # config (see docs/translation_bench.md and scripts/test-providers.json's generation
    # notes) — this script trusts that filtering rather than re-deriving modality itself.
    candidates = list(list_candidate_models(providers_cfg, "ocr", args.provider, not args.free_only, args.model))
    specialized = [] if args.skip_specialized else list(
        list_specialized_models(providers_cfg, "ocr_specialized_non_chat", args.provider, args.model)
    )

    if not candidates and not specialized:
        print("[ERROR] No matching OCR (VLM) models found in the providers config for the given filters.")
        print("        config/providers.json's 'ocr' lists are mostly paid — try --providers-config "
              "scripts/test-providers.json --include-paid, or narrow with --provider/--model.")
        return

    print(f"\n[INFO] {len(candidates)} chat-VLM candidate(s), {len(specialized)} specialized non-chat candidate(s)")

    for provider_name, provider_cfg, model_id, model_name, free in candidates:
        free_label = " [FREE]" if free else " [PAID — pricing not tracked here, check the provider's pricing page]"
        print(f"\n========================================")
        print(f"Benchmarking Model: {provider_name}/{model_id}{free_label}")
        if model_name != model_id:
            print(f"Name: {model_name}")
        print(f"========================================")

        results = []
        total_time = 0
        total_input_tokens = 0
        total_output_tokens = 0

        for i, r_item in enumerate(regions_list):
            x, y, w, h = r_item['bbox']
            px, py = max(0, x - 10), max(0, y - 10)
            pw, ph = min(img.shape[1] - px, w + 20), min(img.shape[0] - py, h + 20)

            crop = img[py:py+ph, px:px+pw]

            print(f"  -> Processing Region {i+1}/{len(regions_list)} ({r_item['type']}, Size: {pw}x{ph})")
            res = call_vlm_ocr(crop, provider_name, provider_cfg, model_id, args.lang)

            if "error" in res:
                print(f"    Error: {res['error']}")
            else:
                text = res['result'].get('text', '')
                print(f"    Text: {text} | Time: {res['time']:.2f}s")
                total_time += res['time']
                total_input_tokens += res['prompt_tokens']
                total_output_tokens += res['completion_tokens']

                results.append({
                    "bbox": [px, py, pw, ph],
                    "text": text,
                    "language": res['result'].get('language', ''),
                    "dir": res['result'].get('writing_direction', '')
                })

        _report_and_save(img, results, regions_list, provider_name, model_id, free,
                          total_time, total_input_tokens, total_output_tokens, args.image, args.lang)

    for provider_name, provider_cfg, model_id, model_name, note in specialized:
        print(f"\n========================================")
        print(f"Benchmarking Specialized Model: {provider_name}/{model_id}")
        if note:
            print(f"Note: {note}")
        print(f"========================================")

        if model_id != "nvidia/nemotron-ocr-v2":
            print(f"  [!] No special-case handler wired up for {model_id} yet — skipping. "
                  f"Add one alongside call_nvidia_ocr_v2() if this is a new non-chat CV endpoint.")
            continue

        nvidia_cfg = providers_cfg["providers"].get("nvidia", provider_cfg)
        results, total_time_or_err = call_nvidia_ocr_v2(img, regions_list, nvidia_cfg)
        if results is None:
            print(f"    Error: {total_time_or_err}")
            continue

        _report_and_save(img, results, regions_list, provider_name, model_id, True,
                          total_time_or_err, 0, 0, args.image, args.lang)


def _report_and_save(img, results, regions_list, provider_name, model_id, free,
                      total_time, total_input_tokens, total_output_tokens, image_path, lang):
    free_str = "FREE" if free else "PAID"
    avg_time = total_time / max(1, len(regions_list))

    print(f"\nSummary for {provider_name}/{model_id}:")
    print(f"  Total Time: {total_time:.2f}s")
    print(f"  Average Time/Region: {avg_time:.2f}s")
    print(f"  Total Tokens: {total_input_tokens} In, {total_output_tokens} Out")
    print(f"  Tier: {free_str}")

    safe_name = f"{provider_name}_{model_id}".replace('/', '_').replace(':', '_').replace('@', '')
    out_path = f"demo_output_{safe_name}.jpg"
    draw_results(img, results, out_path, f"{provider_name}/{model_id}", {
        "Total Time": f"{total_time:.2f}s",
        "Avg Time/Region": f"{avg_time:.2f}s",
        "Tier": free_str,
    })
    print(f"  Saved demo image to: {out_path}")

    json_path = f"ocr_results_{safe_name}.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({
            "provider": provider_name,
            "engine": model_id,
            "image": image_path,
            "lang": lang,
            "free": free,
            "total_time": total_time,
            "avg_time_per_bubble": avg_time,
            "regions": results
        }, f, ensure_ascii=False, indent=2)
    print(f"  Saved OCR JSON to: {json_path}")

if __name__ == "__main__":
    main()
