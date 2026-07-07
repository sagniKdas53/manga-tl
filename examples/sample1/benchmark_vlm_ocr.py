import os
import sys
import cv2
import json
import base64
import time
import argparse
import requests
import numpy as np

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

try:
    from worker.services.bubble_detector import detect_bubbles_yolo
except ImportError:
    print("Warning: Could not import detect_bubbles_yolo. Make sure PYTHONPATH is set correctly.")
    detect_bubbles_yolo = None

load_env(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../.env')))


# Provider configurations
PROVIDERS = {
    "openrouter": {
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "key_env": "OPENROUTER_API_KEY",
        "headers": lambda key: {"Authorization": f"Bearer {key}", "HTTP-Referer": "https://manga-library"}
    },
    "nvidia": {
        "url": "https://integrate.api.nvidia.com/v1/chat/completions",
        "key_env": "NVIDIA_API_KEY",
        "headers": lambda key: {"Authorization": f"Bearer {key}"}
    },
    "openai": {
        "url": "https://api.openai.com/v1/chat/completions",
        "key_env": "OPENAI_API_KEY",
        "headers": lambda key: {"Authorization": f"Bearer {key}"}
    },
    "nvidia_ocr": {
        "url": "https://ai.api.nvidia.com/v1/cv/nvidia/nemotron-ocr-v2",
        "key_env": "NVIDIA_API_KEY",
        "headers": lambda key: {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    }
}

# Target models to benchmark
MODELS_TO_TEST = [
    {"name": "nvidia/nemotron-nano-12b-v2-vl", "provider": "nvidia", "cost_per_m": 0},
    {"name": "qwen/qwen3-vl-8b-instruct", "provider": "openrouter", "cost_per_m": 0.15},
    {"name": "qwen/qwen3-vl-30b-a3b-instruct", "provider": "openrouter", "cost_per_m": 0.40},
    {"name": "qwen/qwen3-vl-32b-instruct", "provider": "openrouter", "cost_per_m": 0.60},
    {"name": "qwen/qwen3-vl-235b-a22b-instruct", "provider": "openrouter", "cost_per_m": 2.50},
    {"name": "qwen/qwen-2.5-vl-72b-instruct", "provider": "openrouter", "cost_per_m": 1.20},
    {"name": "google/gemini-3.5-flash", "provider": "openrouter", "cost_per_m": 0.075},
    {"name": "google/gemini-3.1-flash-lite", "provider": "openrouter", "cost_per_m": 0.075},
    {"name": "nvidia/nemotron-ocr-v2", "provider": "nvidia_ocr", "cost_per_m": 0},
]

def call_vlm_ocr(image_crop, model_info, language):
    """Call the VLM API with the bubble crop."""
    provider_name = model_info["provider"]
    model_name = model_info["name"]
    
    if provider_name not in PROVIDERS:
        return {"error": f"Unknown provider {provider_name}"}
        
    provider_cfg = PROVIDERS[provider_name]
    api_key = os.environ.get(provider_cfg["key_env"])
    
    if not api_key:
        return {"error": f"Missing API key for {provider_cfg['key_env']}"}

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

    if provider_name == "nvidia_ocr":
        payload = {
            "input": [{"type": "image_url", "url": f"data:image/jpeg;base64,{base64_image}"}]
        }
    else:
        payload = {
            "model": model_name,
            "messages": [
                {
                    "role": "user", 
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_image}"}}
                    ]
                }
            ]
        }
        if provider_name == "nvidia":
            payload["response_format"] = {"type": "json_object"}
        elif provider_name == "openrouter":
            payload["response_format"] = {"type": "json_object"}
            payload["plugins"] = [{"id": "response-healing"}]

    # We use json_object for OpenRouter with the response-healing plugin

    headers = provider_cfg["headers"](api_key)
    headers["Content-Type"] = "application/json"

    start_time = time.time()
    try:
        response = requests.post(provider_cfg["url"], headers=headers, json=payload, timeout=30)
        response.raise_for_status()
        data = response.json()
        
        if provider_name == "nvidia_ocr":
            text_lines = []
            for dt in data.get("data", []):
                for det in dt.get("text_detections", []):
                    text_lines.append(det.get("text_prediction", {}).get("text", ""))
            parsed = {
                "text": "\n".join(text_lines).strip(),
                "language": "",
                "writing_direction": ""
            }
            prompt_tokens = 0
            completion_tokens = 0
        else:
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
        print(f"  [!] API Error ({model_name}): {e}")
        return {"error": str(e), "time": time.time() - start_time}

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
            
    # Let's ensure bounding boxes are integers and within image bounds
    for r in regions_list:
        x, y, w, h = r["bbox"]
        rx = max(0, min(img.shape[1]-1, int(x)))
        ry = max(0, min(img.shape[0]-1, int(y)))
        rw = max(1, min(img.shape[1]-rx, int(w)))
        rh = max(1, min(img.shape[0]-ry, int(h)))
        r["bbox"] = [rx, ry, rw, rh]
        
    return regions_list

def main():
    parser = argparse.ArgumentParser(description="Benchmark VLM OCR Models")
    parser.add_argument("--image", default="original.jpeg", help="Input image path")
    parser.add_argument("--lang", default="Japanese", help="Source language (e.g. Japanese, Korean, English)")
    parser.add_argument("--model", help="Specific model name to test (otherwise tests all)")
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

    models_to_run = MODELS_TO_TEST
    if args.model:
        models_to_run = [m for m in MODELS_TO_TEST if args.model.lower() in m["name"].lower()]

    for model_info in models_to_run:
        print(f"\n========================================")
        print(f"Benchmarking Model: {model_info['name']}")
        print(f"========================================")
        
        results = []
        total_time = 0
        total_input_tokens = 0
        total_output_tokens = 0
        
        if model_info["provider"] == "nvidia_ocr":
            print("  -> Running full image OCR for nemotron-ocr-v2...")
            import base64, requests
            start_time = time.time()
            scale = 1.0
            while True:
                resized = cv2.resize(img, (0,0), fx=scale, fy=scale)
                _, buffer = cv2.imencode('.jpg', resized, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
                b64 = base64.b64encode(buffer).decode('utf-8')
                if len(b64) < 175000:
                    break
                scale -= 0.1
            
            provider_cfg = PROVIDERS["nvidia_ocr"]
            api_key = os.environ.get(provider_cfg["key_env"])
            headers = provider_cfg["headers"](api_key)
            headers["Content-Type"] = "application/json"
            payload = {'input': [{'type': 'image_url', 'url': f'data:image/jpeg;base64,{b64}'}]}
            
            try:
                resp = requests.post(provider_cfg["url"], headers=headers, json=payload, timeout=30)
                resp.raise_for_status()
                data = resp.json()
                
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
                            full_text_detections.append({
                                "text": text,
                                "nx1": min_x, "ny1": min_y, "nx2": max_x, "ny2": max_y
                            })
                
                total_time = time.time() - start_time
                print(f"  -> Full image OCR took {total_time:.2f}s. Detected {len(full_text_detections)} text regions.")
                
                for i, r_item in enumerate(regions_list):
                    x, y, w, h = r_item['bbox']
                    px, py = max(0, x-10), max(0, y-10)
                    pw, ph = min(img.shape[1]-px, w+20), min(img.shape[0]-py, h+20)
                    
                    bnx1, bny1 = px / img.shape[1], py / img.shape[0]
                    bnx2, bny2 = (px + pw) / img.shape[1], (py + ph) / img.shape[0]
                    
                    intersecting_texts = []
                    for det in full_text_detections:
                        ix1 = max(bnx1, det["nx1"])
                        iy1 = max(bny1, det["ny1"])
                        ix2 = min(bnx2, det["nx2"])
                        iy2 = min(bny2, det["ny2"])
                        if ix1 < ix2 and iy1 < iy2:
                            intersecting_texts.append(det["text"])
                    
                    final_text = "\n".join(intersecting_texts).strip()
                    if not final_text:
                        final_text = "[No Text Detected]"
                        
                    print(f"  -> Region {i+1}/{len(regions_list)} Text: {final_text}")
                    results.append({
                        "bbox": [px, py, pw, ph],
                        "text": final_text,
                        "language": "",
                        "dir": ""
                    })
            except Exception as e:
                print(f"    Error: {str(e)}")
        else:
            for i, r_item in enumerate(regions_list):
                x, y, w, h = r_item['bbox']
                # Add slight padding
                px, py = max(0, x-10), max(0, y-10)
                pw, ph = min(img.shape[1]-px, w+20), min(img.shape[0]-py, h+20)
            
                crop = img[py:py+ph, px:px+pw]
            
                print(f"  -> Processing Region {i+1}/{len(regions_list)} ({r_item['type']}, Size: {pw}x{ph})")
                res = call_vlm_ocr(crop, model_info, args.lang)
            
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
                
        # Estimate cost
        est_cost = (total_input_tokens + total_output_tokens) / 1_000_000 * model_info['cost_per_m']
        
        print(f"\nSummary for {model_info['name']}:")
        print(f"  Total Time: {total_time:.2f}s")
        print(f"  Average Time/Region: {total_time/max(1, len(regions_list)):.2f}s")
        print(f"  Total Tokens: {total_input_tokens} In, {total_output_tokens} Out")
        print(f"  Estimated Cost: ${est_cost:.6f}")
        
        # Save output image
        safe_name = model_info['name'].replace('/', '_')
        out_path = f"demo_output_{safe_name}.jpg"
        draw_results(img, results, out_path, model_info['name'], {
            "Total Time": f"{total_time:.2f}s",
            "Avg Time/Region": f"{total_time/max(1, len(regions_list)):.2f}s",
            "Est Cost": f"${est_cost:.6f}"
        })
        print(f"  Saved demo image to: {out_path}")

if __name__ == "__main__":
    main()
