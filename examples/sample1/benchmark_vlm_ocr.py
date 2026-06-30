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
    # For openrouter, forcing json_object might cause 400 on brand new models
    # We will rely on the prompt instructions.

    headers = provider_cfg["headers"](api_key)
    headers["Content-Type"] = "application/json"

    start_time = time.time()
    try:
        response = requests.post(provider_cfg["url"], headers=headers, json=payload, timeout=30)
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
                continue
                
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

    if detect_bubbles_yolo is None:
        print("YOLO bubble detection not available.")
        return

    print("Running YOLO Bubble Detection...")
    bubbles = detect_bubbles_yolo(img)
    print(f"Detected {len(bubbles)} bubbles.")
    
    if not bubbles:
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
        
        for i, bubble in enumerate(bubbles):
            x, y, w, h = [int(v) for v in bubble['bbox']]
            # Add slight padding
            px, py = max(0, x-10), max(0, y-10)
            pw, ph = min(img.shape[1]-px, w+20), min(img.shape[0]-py, h+20)
            
            crop = img[py:py+ph, px:px+pw]
            
            print(f"  -> Processing Bubble {i+1}/{len(bubbles)} (Size: {pw}x{ph})")
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
                
        # Estimate cost (assuming input is $X/M and output is $X/M roughly for simplicity if openrouter pricing varies)
        # Often input is cheaper than output, but we use a blended rate for simple estimation here.
        est_cost = (total_input_tokens + total_output_tokens) / 1_000_000 * model_info['cost_per_m']
        
        print(f"\nSummary for {model_info['name']}:")
        print(f"  Total Time: {total_time:.2f}s")
        print(f"  Average Time/Bubble: {total_time/max(1, len(bubbles)):.2f}s")
        print(f"  Total Tokens: {total_input_tokens} In, {total_output_tokens} Out")
        print(f"  Estimated Cost: ${est_cost:.6f}")
        
        # Save output image
        safe_name = model_info['name'].replace('/', '_')
        out_path = f"demo_output_{safe_name}.jpg"
        draw_results(img, results, out_path, model_info['name'], {
            "Total Time": f"{total_time:.2f}s",
            "Avg Time/Bubble": f"{total_time/max(1, len(bubbles)):.2f}s",
            "Est Cost": f"${est_cost:.6f}"
        })
        print(f"  Saved demo image to: {out_path}")

if __name__ == "__main__":
    main()
