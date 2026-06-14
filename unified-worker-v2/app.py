import os
import gc
import json
import time
import re
import redis
import requests
import numpy as np
import cv2
from minio import Minio
from functools import cmp_to_key
from manga_ocr import MangaOcr

# Import PaddleOCR
paddle_ocr_reader = None
try:
    print("[Unified Worker] Importing PaddleOCR...", flush=True)
    from paddleocr import PaddleOCR
    import os
    os.environ["FLAGS_use_mkldnn"] = "0"
    os.environ["PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT"] = "0"

    # TODO: lang and text direction should not be hardcoded here.
    # The backend should pass the source language (ja/zh/en) and direction
    # (rtl/ltr) as part of the OCR job payload so the worker can configure
    # PaddleOCR per-request instead of being locked to Japanese.

    # Initialize PaddleOCR with PP-OCRv5 Mobile (lighter, lower memory)
    print("[Unified Worker] Initializing PaddleOCR (PP-OCRv5 Mobile, lang='japan')...", flush=True)
    paddle_ocr_reader = PaddleOCR(
        lang='japan',
        device='cpu',

        # lighter models
        text_detection_model_name='PP-OCRv5_mobile_det',
        text_recognition_model_name='PP-OCRv5_mobile_rec',

        # save memory
        use_textline_orientation=False,
        use_doc_unwarping=False,
        use_doc_orientation_classify=False,

        enable_mkldnn=False
    )
except Exception as e:
    print(f"[Unified Worker] Failed to initialize PaddleOCR: {e}", flush=True)

# Initialize EasyOCR reader with Japanese and English support (Fallback)
reader = None
try:
    print("[Unified Worker] Importing EasyOCR...", flush=True)
    import easyocr
    print("[Unified Worker] Initializing EasyOCR Reader (ja, en)...", flush=True)
    reader = easyocr.Reader(['ja', 'en'], gpu=False)
except Exception as e:
    print(f"[Unified Worker] Failed to initialize EasyOCR: {e}", flush=True)

# Initialize MangaOCR reader with Japanese support (for text inside CJK bubbles)
manga_ocr_reader = None
try:
    print("[Unified Worker] Initializing MangaOCR Reader...", flush=True)
    # Check if we should force CPU from environment (defaults to True)
    force_cpu = os.environ.get('MANGA_OCR_FORCE_CPU', 'true').lower() in ('true', '1', 't')
    if force_cpu:
        print("[Unified Worker] Forcing CPU for MangaOCR...", flush=True)
        manga_ocr_reader = MangaOcr(force_cpu=True)
    else:
        try:
            manga_ocr_reader = MangaOcr()
        except Exception as init_err:
            print(f"[Unified Worker] Failed to initialize MangaOCR with default settings (likely GPU compatibility issue: {init_err}). Retrying with force_cpu=True...", flush=True)
            manga_ocr_reader = MangaOcr(force_cpu=True)
except Exception as e:
    print(f"[Unified Worker] Failed to initialize MangaOCR: {e}. Falling back to EasyOCR recognition.", flush=True)

# Configurations
REDIS_HOST = os.environ.get('REDIS_HOST', 'localhost')
REDIS_PORT = int(os.environ.get('REDIS_PORT', 6379))
MINIO_ENDPOINT = os.environ.get('MINIO_ENDPOINT', 'localhost:9000')
MINIO_ACCESS_KEY = os.environ.get('MINIO_ACCESS_KEY', 'minioadmin')
MINIO_SECRET_KEY = os.environ.get('MINIO_SECRET_KEY', 'minioadmin')
CALLBACK_URL = os.environ.get('BACKEND_CALLBACK_URL', 'http://localhost:8080/api/internal/jobs/callback')

# Clients
redis_client = redis.Redis(
    host=REDIS_HOST,
    port=REDIS_PORT,
    socket_timeout=15,
    socket_connect_timeout=5,
    socket_keepalive=True,
    retry_on_timeout=True
)
minio_client = Minio(
    MINIO_ENDPOINT,
    access_key=MINIO_ACCESS_KEY,
    secret_key=MINIO_SECRET_KEY,
    secure=False
)

# --- PANEL DETECTION HELPER FUNCTIONS ---
def detect_panels(image_bytes):
    # Decode image
    nparr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return []

    h, w, _ = img.shape
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Threshold to find white gutters/spaces between panels
    _, thresh = cv2.threshold(gray, 240, 255, cv2.THRESH_BINARY_INV)

    # Perform morphology to close small gaps in lines
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)

    # Find contours
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    panels = []
    min_area = (w * h) * 0.02  # Must be at least 2% of the image

    for c in contours:
        x, y, width, height = cv2.boundingRect(c)
        area = width * height
        if area >= min_area and width < w * 0.98 and height < h * 0.98:
            panels.append({
                'x': x,
                'y': y,
                'width': width,
                'height': height
            })

    # If no panels were detected, default to a single panel containing the whole image
    if not panels:
        panels.append({
            'x': 0,
            'y': 0,
            'width': w,
            'height': h
        })

    # Sort panels for reading order (RTL: right-to-left, top-to-bottom)
    panels.sort(key=lambda p: p['y'])
    rows = []
    for p in panels:
        added = False
        for row in rows:
            # Check if this panel y overlaps with the row's typical y
            avg_y = sum(item['y'] for item in row) / len(row)
            avg_h = sum(item['height'] for item in row) / len(row)
            # Overlap threshold: 25% of height
            if abs(p['y'] - avg_y) < avg_h * 0.25:
                row.append(p)
                added = True
                break
        if not added:
            rows.append([p])

    # Sort each row right-to-left (for RTL) and flatten
    final_panels = []
    reading_order = 1
    for r_idx, row in enumerate(rows):
        row.sort(key=lambda p: p['x'], reverse=True) # Rightmost panel first in RTL
        for c_idx, p in enumerate(row):
            p['gridRow'] = r_idx
            p['gridCol'] = c_idx
            p['readingOrder'] = reading_order
            reading_order += 1
            final_panels.append(p)

    return final_panels

# --- OCR HELPER FUNCTIONS ---
def detect_language(text):
    # Regex ranges for CJK
    # Japanese Hiragana/Katakana
    if re.search(r'[\u3040-\u309F\u30A0-\u30FF]', text):
        return 'ja'
    # Chinese Hanzi (CJK Unified Ideographs)
    elif re.search(r'[\u4E00-\u9FFF]', text):
        return 'zh-TW'
    # Otherwise fallback to English
    return 'en'

def calculate_overlap_area(r, p):
    # r is ocr region dict, p is panel dict (from db)
    rx, ry, rw, rh = r['x'], r['y'], r['width'], r['height']
    px, py, pw, ph = p['bboxX'], p['bboxY'], p['bboxW'], p['bboxH']
    
    overlap_x = max(0, min(rx + rw, px + pw) - max(rx, px))
    overlap_y = max(0, min(ry + rh, py + ph) - max(ry, py))
    return overlap_x * overlap_y

def bubble_compare(a, b):
    # RTL comparator
    y_diff = a['y'] - b['y']
    if abs(y_diff) > 100:
        return 1 if y_diff > 0 else -1
    
    x_diff = b['x'] - a['x']
    return 1 if x_diff > 0 else -1


def parse_paddle_ocr_results(raw_results):
    results = []

    if raw_results is None:
        return results

    try:
        if not isinstance(raw_results, list):
            raw_results = [raw_results]

        for result in raw_results:

            dt_polys = result.get("dt_polys", [])
            rec_texts = result.get("rec_texts", [])
            rec_scores = result.get("rec_scores", [])

            count = min(
                len(dt_polys),
                len(rec_texts),
                len(rec_scores)
            )

            for i in range(count):

                bbox = dt_polys[i]

                if hasattr(bbox, "tolist"):
                    bbox = bbox.tolist()

                results.append(
                    (
                        bbox,
                        rec_texts[i],
                        float(rec_scores[i])
                    )
                )

    except Exception as e:
        print(
            f"[OCR] Failed parsing PaddleOCR results: {e}",
            flush=True
        )

    return results


def downscale_for_ocr(img, max_dim=1024):
    """
    Reduce memory consumption before OCR.
    Returns (downscaled_img, scale_factor).
    scale_factor is the multiplier to convert downscaled coords back to original.
    """

    if img is None:
        return img, 1.0

    h, w = img.shape[:2]

    largest = max(h, w)

    if largest <= max_dim:
        return img, 1.0

    scale = max_dim / largest

    new_w = int(w * scale)
    new_h = int(h * scale)

    resized = cv2.resize(
        img,
        (new_w, new_h),
        interpolation=cv2.INTER_AREA
    )

    # inverse scale: multiply OCR coords by this to get original-image coords
    return resized, 1.0 / scale


# --- TRANSLATION AND REDO HELPERS ---

# --- TRANSLATION AND REDO HELPERS ---

LAST_REQUEST_TIME = 0.0

def enforce_rate_limit():
    global LAST_REQUEST_TIME
    rate_limit_env = os.environ.get('RATE_LIMIT', '').strip()
    if not rate_limit_env:
        return
    try:
        # Parse formats like "60", "60/m", "60/min", "5/s", "5/sec"
        rpm = None
        if '/' in rate_limit_env:
            parts = rate_limit_env.split('/')
            val = float(parts[0])
            unit = parts[1].lower().strip()
            if unit in ('s', 'sec', 'second', 'seconds'):
                rpm = val * 60.0
            else:
                rpm = val
        else:
            rpm = float(rate_limit_env)
        
        if rpm > 0:
            min_delay = 60.0 / rpm
            now = time.time()
            elapsed = now - LAST_REQUEST_TIME
            if elapsed < min_delay:
                sleep_time = min_delay - elapsed
                print(f"[Translation] Rate limit: Sleeping for {sleep_time:.2f} seconds to respect {rate_limit_env} rate limit...", flush=True)
                time.sleep(sleep_time)
            LAST_REQUEST_TIME = time.time()
    except Exception as e:
        print(f"[Translation] Error enforcing rate limit: {e}", flush=True)

TRANSLATION_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "translations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "translation": {"type": "string"}
                },
                "required": ["id", "translation"]
            }
        }
    },
    "required": ["translations"]
}

MANGA_TRANSLATION_JSON_SYSTEM_PROMPT = """You are an expert manga translator.
Translate the list of manga text bubbles into natural English.
These bubbles appear in reading order. Maintain context, tone, emotion, and relationships between speakers.
Return ONLY valid JSON format conforming to the requested schema. No conversational prefix, suffix, or markdown formatting."""

def contains_japanese(text):
    return bool(re.search(r'[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]', text))

def is_valid_translation(source, translated):
    if not translated:
        return False
        
    translated_stripped = translated.strip()
    source_stripped = source.strip()
    
    # Check forbidden phrases / boilerplate
    forbidden_substrings = [
        "translate the following text",
        "text:",
        "output:",
        "json"
    ]
    for pattern in forbidden_substrings:
        if pattern in translated_stripped.lower():
            print(f"[Sanity Check] Rejected translation containing boilerplate '{pattern}': '{translated}'", flush=True)
            return False
            
    # Check if translated == source for Japanese
    if contains_japanese(source_stripped) and translated_stripped == source_stripped:
        print(f"[Sanity Check] Rejected translation identical to Japanese source: '{translated}'", flush=True)
        return False
        
    # Check if translated is pathologically longer than source
    if len(source_stripped) <= 5 and len(translated_stripped) > len(source_stripped) * 20:
        print(f"[Sanity Check] Rejected pathologically long translation for short source: '{translated}' (source: '{source}')", flush=True)
        return False
        
    return True

def should_translate_region(region):
    text = region.get('text', '')
    stripped = text.strip()
    confidence = region.get('confidence', 1.0)
    width = region.get('width', 0)
    height = region.get('height', 0)

    # Reject regions smaller than 10x10
    if width < 10 or height < 10:
        print(f"[Quality Filter] Rejecting region: too small ({width}x{height}) - text: '{text}'", flush=True)
        return False

    # Reject low confidence regions (< 0.30)
    if confidence < 0.30:
        print(f"[Quality Filter] Rejecting region: low confidence ({confidence:.2f}) - text: '{text}'", flush=True)
        return False

    # Special handling for SFX and Japanese kana-only text
    sfx_whitelist = {'ドン', 'ガッ', 'ぱんッ', 'ズキュン'}
    
    # Check if text is in whitelist
    if stripped in sfx_whitelist:
        return True
        
    # Check if text is Japanese kana-only
    cleaned_for_kana = re.sub(r'[\s！？\?!\.\,\-\_\"]', '', stripped)
    is_kana_only = False
    if cleaned_for_kana:
        is_kana_only = bool(re.match(r'^[\u3040-\u309F\u30A0-\u30FF\u30FC\uFF66-\uFF9F]+$', cleaned_for_kana))
        
    if is_kana_only:
        return True

    # Otherwise, reject obvious garbage / non-Japanese low quality texts
    if len(stripped) < 2:
        print(f"[Quality Filter] Rejecting region: too short (len={len(stripped)}) - text: '{text}'", flush=True)
        return False

    # Reject alphanumeric-only when confidence is low
    if re.match(r'^[A-Za-z0-9._-]+$', stripped):
        if confidence < 0.50:
            print(f"[Quality Filter] Rejecting region: alphanumeric-only with low confidence ({confidence:.2f}) - text: '{text}'", flush=True)
            return False

    return True

def validate_translation_response(parsed_json):
    items = []
    if isinstance(parsed_json, dict):
        if 'translations' in parsed_json:
            items = parsed_json['translations']
        elif 'items' in parsed_json:
            items = parsed_json['items']
        else:
            if all(isinstance(k, str) and isinstance(v, str) for k, v in parsed_json.items()):
                return parsed_json
    elif isinstance(parsed_json, list):
        items = parsed_json
        
    if not isinstance(items, list):
        return None
        
    validated = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        rid = item.get('id')
        translation = item.get('translation')
        if rid and translation and isinstance(rid, str) and isinstance(translation, str) and translation.strip():
            validated[rid] = translation.strip()
            
    return validated if validated else None

def parse_and_validate_batch(response_text, unmatched_regions):
    if not response_text:
        return None
        
    cleaned_text = response_text.strip()
    if cleaned_text.startswith("```"):
        lines = cleaned_text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        cleaned_text = "\n".join(lines).strip()
        
    try:
        parsed = json.loads(cleaned_text)
        validated = validate_translation_response(parsed)
        if validated:
            return validated
    except Exception as e:
        print(f"[Translation] Failed to parse batch translation JSON response: {e}. Raw response: {response_text}", flush=True)
        
    return None

def try_cloud_ai(provider, api_key, model, prompt, response_schema=None):
    enforce_rate_limit()
    url = ""
    headers = {}
    payload = {}
    
    if provider == 'openrouter':
        url = "https://openrouter.ai/api/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": model or "meta-llama/llama-3-8b-instruct:free",
            "messages": [{"role": "user", "content": prompt}]
        }
        if response_schema:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "manga_translation",
                    "schema": response_schema
                }
            }
    elif provider == 'openai':
        url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": model or "gpt-4o-mini",
            "messages": [{"role": "user", "content": prompt}]
        }
        if response_schema:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "manga_translation",
                    "schema": response_schema
                }
            }
    elif provider == 'nvidia':
        url = "https://integrate.api.nvidia.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": model or "nvidia/riva-translate-4b-instruct-v1.1",
            "messages": [{"role": "user", "content": prompt}]
        }
        if response_schema:
            payload["response_format"] = {"type": "json_object"}
    elif provider == 'anthropic':
        url = "https://api.anthropic.com/v1/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
        }
        payload = {
            "model": model or "claude-3-5-sonnet-20241022",
            "max_tokens": 1000,
            "messages": [{"role": "user", "content": prompt}]
        }
    elif provider == 'gemini':
        gemini_model = model or "gemini-1.5-flash"
        if "/" not in gemini_model:
            gemini_model = f"models/{gemini_model}"
        url = f"https://generativelanguage.googleapis.com/v1beta/{gemini_model}:generateContent?key={api_key}"
        headers = {
            "Content-Type": "application/json"
        }
        payload = {
            "contents": [{"parts": [{"text": prompt}]}]
        }
        if response_schema:
            payload["generationConfig"] = {
                "responseMimeType": "application/json",
                "responseSchema": response_schema
            }
    else:
        return None

    try:
        print(f"[Translation] Sending request to Cloud LLM provider '{provider}' using model '{model}'...", flush=True)
        res = requests.post(url, json=payload, headers=headers, timeout=12)
        if res.status_code == 200:
            res_json = res.json()
            if provider == 'gemini':
                return res_json['candidates'][0]['content']['parts'][0]['text']
            elif provider == 'anthropic':
                return res_json['content'][0]['text']
            else:
                return res_json['choices'][0]['message']['content']
        else:
            print(f"[Translation] Cloud LLM provider '{provider}' returned error: {res.status_code} - {res.text}", flush=True)
    except Exception as e:
        print(f"[Translation] Cloud LLM Translation failed: {e}", flush=True)
    return None

def try_cloud_ai_vision(provider, api_key, model, prompt, base64_image, response_schema=None):
    enforce_rate_limit()
    url = ""
    headers = {}
    payload = {}
    
    if provider == 'openrouter':
        url = "https://openrouter.ai/api/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{base64_image}"
                            }
                        }
                    ]
                }
            ]
        }
        if response_schema:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "manga_translation",
                    "schema": response_schema
                }
            }
    elif provider == 'gemini':
        gemini_model = model or "gemini-1.5-flash"
        if "/" not in gemini_model:
            gemini_model = f"models/{gemini_model}"
        url = f"https://generativelanguage.googleapis.com/v1beta/{gemini_model}:generateContent?key={api_key}"
        headers = {
            "Content-Type": "application/json"
        }
        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {
                            "inlineData": {
                                "mimeType": "image/jpeg",
                                "data": base64_image
                            }
                        }
                    ]
                }
            ]
        }
        if response_schema:
            payload["generationConfig"] = {
                "responseMimeType": "application/json",
                "responseSchema": response_schema
            }
    else:
        return None

    try:
        print(f"[Translation VLM] Sending vision request to provider '{provider}' using model '{model}'...", flush=True)
        res = requests.post(url, json=payload, headers=headers, timeout=20)
        if res.status_code == 200:
            res_json = res.json()
            if provider == 'gemini':
                return res_json['candidates'][0]['content']['parts'][0]['text']
            else:
                return res_json['choices'][0]['message']['content']
        else:
            print(f"[Translation VLM] Provider '{provider}' returned error: {res.status_code} - {res.text}", flush=True)
    except Exception as e:
        print(f"[Translation VLM] Vision Translation failed: {e}", flush=True)
    return None

MANGA_TRANSLATION_SYSTEM_PROMPT = """You are an expert manga translator.

Translate Japanese manga dialogue into natural English.

Rules:
- Keep names unchanged.
- Preserve tone and emotion.
- Do not explain.
- Do not add notes.
- Do not add quotation marks.
- Return only the translated text."""

def try_local_ai(prompt, text, response_schema=None):
    enforce_rate_limit()
    local_provider = os.environ.get('LOCAL_LLM_PROVIDER', os.environ.get('LLM_PROVIDER', 'lmstudio')).lower().strip()
    local_endpoint = os.environ.get('LOCAL_LLM_ENDPOINT', os.environ.get('LLM_ENDPOINT', '')).strip()
    model = os.environ.get('LOCAL_LLM_MODEL', 'gemma3:4b')

    if not local_endpoint:
        if local_provider == 'ollama':
            local_endpoint = "http://ollama:11434/v1/chat/completions"
        else:
            local_endpoint = "http://host.docker.internal:1234/v1/chat/completions"

    endpoints_to_try = [local_endpoint]
    if "localhost" in local_endpoint:
        endpoints_to_try.append(local_endpoint.replace("localhost", "host.docker.internal"))
    elif "host.docker.internal" in local_endpoint:
        endpoints_to_try.append(local_endpoint.replace("host.docker.internal", "localhost"))

    system_pr = MANGA_TRANSLATION_JSON_SYSTEM_PROMPT if response_schema else MANGA_TRANSLATION_SYSTEM_PROMPT

    for endpoint in endpoints_to_try:
        try:
            print(f"[Translation] Trying Local AI endpoint '{endpoint}' using model '{model}'...", flush=True)
            
            if "/api/v1/chat" in endpoint:
                payload = {
                    "model": model,
                    "system_prompt": system_pr,
                    "input": text
                }
            else:
                payload = {
                    "model": model,
                    "messages": [
                        {"role": "system", "content": system_pr},
                        {"role": "user", "content": text}
                    ]
                }
                if response_schema:
                    if "ollama" in endpoint or local_provider == 'ollama':
                        payload["format"] = "json"
                    else:
                        payload["response_format"] = {"type": "json_object"}
            
            res = requests.post(endpoint, json=payload, headers={"Content-Type": "application/json"}, timeout=30)
            if res.status_code == 200:
                res_json = res.json()
                translated = None
                if "/api/v1/chat" in endpoint:
                    if 'choices' in res_json:
                        choice = res_json['choices'][0]
                        if 'message' in choice:
                            translated = choice['message']['content']
                        elif 'text' in choice:
                            translated = choice['text']
                    elif 'output' in res_json:
                        translated = res_json['output']
                    elif 'response' in res_json:
                        translated = res_json['response']
                else:
                    if 'choices' in res_json:
                        translated = res_json['choices'][0]['message']['content']
                    elif 'response' in res_json:
                        translated = res_json['response']
                
                if translated:
                    return translated
        except Exception as e:
            print(f"[Translation] Local AI connection failed for '{endpoint}': {e}", flush=True)
            
    return None

def try_deepl(text, target_lang='en'):
    deepl_key = os.environ.get('DEEPL_API_KEY', os.environ.get('DEEPL_KEY', '')).strip()
    if not deepl_key:
        return None
    
    if deepl_key.endswith(':fx'):
        url = "https://api-free.deepl.com/v2/translate"
    else:
        url = "https://api.deepl.com/v2/translate"
        
    try:
        print("[Translation] Sending request to DeepL API...", flush=True)
        headers = {
            "Authorization": f"DeepL-Auth-Key {deepl_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "text": [text],
            "target_lang": target_lang.upper()
        }
        res = requests.post(url, json=payload, headers=headers, timeout=8)
        if res.status_code == 200:
            res_json = res.json()
            translated = res_json['translations'][0]['text']
            print(f"[Translation] DeepL Translation Success: '{translated}'", flush=True)
            return translated
        else:
            print(f"[Translation] DeepL API returned error: {res.status_code} - {res.text}", flush=True)
    except Exception as e:
        print(f"[Translation] DeepL Translation failed: {e}", flush=True)
    return None

def try_google_translate(text, source_lang='auto', target_lang='en'):
    try:
        print(f"[Translation] Falling back to free Google Translate API...", flush=True)
        import urllib.parse
        url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl={source_lang}&tl={target_lang}&dt=t&q=" + urllib.parse.quote(text)
        res = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=5)
        if res.status_code == 200:
            data = res.json()
            translated = "".join([part[0] for part in data[0] if part[0]])
            print(f"[Translation] Google Translate Success: '{translated}'", flush=True)
            return translated
    except Exception as e:
        print(f"[Translation] Google Translate fallback failed: {e}", flush=True)
    return None

def clean_translated_text(translated):
    if not translated:
        return translated
    if isinstance(translated, list) and len(translated) > 0:
        if isinstance(translated[0], dict) and 'content' in translated[0]:
            translated = translated[0]['content']
        elif isinstance(translated[0], str):
            translated = translated[0]
    if isinstance(translated, str):
        translated = translated.strip()
        if (translated.startswith('"') and translated.endswith('"')) or (translated.startswith("'") and translated.endswith("'")):
            translated = translated[1:-1].strip()
        return translated
    return translated

def translate_text(text, source_lang='auto', target_lang='en'):
    provider = os.environ.get('MODEL_PROVIDER', '').lower().strip()
    api_key = os.environ.get('API_KEY', '').strip()
    
    openrouter_key = os.environ.get('OPENROUTER_API_KEY', '').strip() or (api_key if provider == 'openrouter' else '')
    nvidia_key = os.environ.get('NVIDIA_API_KEY', '').strip() or (api_key if provider == 'nvidia' else '')

    prompt = f"Translate the following text to natural English, maintaining its tone and context. Respond ONLY with the translated text. Do not include any tags, notes, or explanations.\n\nText: {text}"

    # 1. Cloud LLM Layer (DeepSeek V4 Pro or Nemotron)
    if openrouter_key:
        translated = try_cloud_ai('openrouter', openrouter_key, 'deepseek-ai/deepseek-v4-pro', prompt)
        if translated:
            cleaned = clean_translated_text(translated)
            if is_valid_translation(text, cleaned):
                return cleaned

    if nvidia_key:
        translated = try_cloud_ai('nvidia', nvidia_key, 'nvidia/nemotron-3-nano-30b-a3b', prompt)
        if translated:
            cleaned = clean_translated_text(translated)
            if is_valid_translation(text, cleaned):
                return cleaned

    # 2. Local Ollama/LMStudio Layer
    translated = try_local_ai(prompt, text)
    if translated:
        cleaned = clean_translated_text(translated)
        if is_valid_translation(text, cleaned):
            return cleaned

    # 3. DeepL Layer
    translated = try_deepl(text, target_lang)
    if translated:
        cleaned = clean_translated_text(translated)
        if is_valid_translation(text, cleaned):
            return cleaned

    # 4. Google Translate Layer
    translated = try_google_translate(text, source_lang, target_lang)
    if translated:
        cleaned = clean_translated_text(translated)
        if is_valid_translation(text, cleaned):
            return cleaned

    print(f"[Translation] All translation tiers failed for text: '{text}'", flush=True)
    return None


def translate_batch_llm(unmatched_regions, response_schema=None):
    bubbles_input = []
    for r in unmatched_regions:
        bubbles_input.append({
            "id": r['id'],
            "panel": r.get('panelReadingOrder') or r.get('panelId') or 0,
            "bubble": r.get('bubbleReadingOrder') or 0,
            "speaker": None,
            "text": r['text']
        })
    bubbles_json = json.dumps(bubbles_input, ensure_ascii=False, indent=2)
    
    prompt = f"""These bubbles appear in reading order.
Translate each bubble into natural manga English.
Preserve:
- tone
- emotional state
- relationships
- ongoing conversation

Return JSON only.

Input:
{bubbles_json}
"""
    provider = os.environ.get('MODEL_PROVIDER', '').lower().strip()
    api_key = os.environ.get('API_KEY', '').strip()
    
    openrouter_key = os.environ.get('OPENROUTER_API_KEY', '').strip() or (api_key if provider == 'openrouter' else '')
    nvidia_key = os.environ.get('NVIDIA_API_KEY', '').strip() or (api_key if provider == 'nvidia' else '')

    # Try DeepSeek V4 Pro
    if openrouter_key:
        print("[Translation] Batch: Trying DeepSeek V4 Pro...", flush=True)
        try:
            res = try_cloud_ai('openrouter', openrouter_key, 'deepseek-ai/deepseek-v4-pro', prompt, response_schema)
            if res:
                return res
        except Exception as e:
            print(f"[Translation] DeepSeek batch translation failed: {e}", flush=True)

    # Try Nemotron
    if nvidia_key:
        print("[Translation] Batch: Trying Nemotron...", flush=True)
        try:
            res = try_cloud_ai('nvidia', nvidia_key, 'nvidia/nemotron-3-nano-30b-a3b', prompt, response_schema)
            if res:
                return res
        except Exception as e:
            print(f"[Translation] Nemotron batch translation failed: {e}", flush=True)

    # Try Local LLM (Ollama)
    local_provider = os.environ.get('LOCAL_LLM_PROVIDER', os.environ.get('LLM_PROVIDER', 'lmstudio')).lower().strip()
    print(f"[Translation] Batch: Trying Local LLM ({local_provider})...", flush=True)
    try:
        res = try_local_ai(prompt, bubbles_json, response_schema)
        if res:
            return res
    except Exception as e:
        print(f"[Translation] Local LLM batch translation failed: {e}", flush=True)

    return None

def translate_vlm_vision(img_bytes, unmatched_regions, response_schema=None):
    if not img_bytes:
        return None
        
    import base64
    base64_image = base64.b64encode(img_bytes).decode('utf-8')
    
    bubbles_input = []
    for r in unmatched_regions:
        bubbles_input.append({
            "id": r['id'],
            "panel": r.get('panelReadingOrder') or r.get('panelId') or 0,
            "bubble": r.get('bubbleReadingOrder') or 0,
            "speaker": None,
            "text": r['text']
        })
        
    prompt = f"""These OCR regions were extracted from this manga page.
Use the page image to understand context (characters, expressions, speech bubble placements).
Translate each bubble into natural manga English.
Preserve:
- tone
- emotional state
- relationships
- ongoing conversation

Return JSON only.

Input:
{json.dumps(bubbles_input, ensure_ascii=False, indent=2)}
"""
    provider = os.environ.get('MODEL_PROVIDER', '').lower().strip()
    api_key = os.environ.get('API_KEY', '').strip()
    
    openrouter_key = os.environ.get('OPENROUTER_API_KEY', '').strip() or (api_key if provider == 'openrouter' else '')
    nvidia_key = os.environ.get('NVIDIA_API_KEY', '').strip() or (api_key if provider == 'nvidia' else '')

    if openrouter_key:
        print("[Translation] VLM: Trying vision model via OpenRouter...", flush=True)
        vlm_model = os.environ.get('VLM_MODEL', 'google/gemini-2.5-flash')
        try:
            res = try_cloud_ai_vision('openrouter', openrouter_key, vlm_model, prompt, base64_image, response_schema)
            if res:
                return res
        except Exception as e:
            print(f"[Translation] VLM vision translation via OpenRouter failed: {e}", flush=True)

    if provider == 'gemini' and api_key:
        print("[Translation] VLM: Trying vision model via Gemini...", flush=True)
        vlm_model = os.environ.get('PREFERRED_MODEL', 'gemini-1.5-flash')
        try:
            res = try_cloud_ai_vision('gemini', api_key, vlm_model, prompt, base64_image, response_schema)
            if res:
                return res
        except Exception as e:
            print(f"[Translation] VLM vision translation via Gemini failed: {e}", flush=True)

    return None

def translate_batch_deepl(unmatched_regions, target_lang='en'):
    deepl_key = os.environ.get('DEEPL_API_KEY', os.environ.get('DEEPL_KEY', '')).strip()
    if not deepl_key:
        return None
    
    if deepl_key.endswith(':fx'):
        url = "https://api-free.deepl.com/v2/translate"
    else:
        url = "https://api.deepl.com/v2/translate"
        
    try:
        print(f"[Translation] Sending batch request of {len(unmatched_regions)} bubbles to DeepL API...", flush=True)
        headers = {
            "Authorization": f"DeepL-Auth-Key {deepl_key}",
            "Content-Type": "application/json"
        }
        texts = [r['text'] for r in unmatched_regions]
        payload = {
            "text": texts,
            "target_lang": target_lang.upper()
        }
        res = requests.post(url, json=payload, headers=headers, timeout=8)
        if res.status_code == 200:
            res_json = res.json()
            translations = res_json['translations']
            mapping = {}
            for i, r in enumerate(unmatched_regions):
                mapping[r['id']] = translations[i]['text']
            return mapping
        else:
            print(f"[Translation] DeepL API returned error: {res.status_code} - {res.text}", flush=True)
    except Exception as e:
        print(f"[Translation] DeepL batch translation failed: {e}", flush=True)
    return None


# --- JOB PROCESSORS ---

def process_panel_detection(job_data):
    image_id = job_data['imageId']
    print(f"[Panel Detection] Processing image: {image_id}", flush=True)

    try:
        backend_url = CALLBACK_URL.replace('/jobs/callback', f'/images/{image_id}')
        res = requests.get(backend_url)
        if res.status_code != 200:
            print(f"[Panel Detection] Failed to get image info: {res.status_code}", flush=True)
            return
        image_info = res.json()
        storage_path = image_info['storagePath']
    except Exception as e:
        print(f"[Panel Detection] Error fetching image details: {e}", flush=True)
        return

    try:
        response = minio_client.get_object('manga-library', storage_path)
        img_bytes = response.read()
    except Exception as e:
        print(f"[Panel Detection] Error downloading from MinIO: {e}", flush=True)
        return

    panels = detect_panels(img_bytes)
    print(f"[Panel Detection] Detected {len(panels)} panels for image {image_id}", flush=True)

    callback_payload = {
        'imageId': image_id,
        'panels': panels
    }
    try:
        res = requests.post(f"{CALLBACK_URL}/panel", json=callback_payload)
        print(f"[Panel Detection] Callback status code: {res.status_code}", flush=True)
    except Exception as e:
        print(f"[Panel Detection] Failed to post callback to backend: {e}", flush=True)


def process_ocr(job_data):
    image_id = job_data['imageId']
    print(f"[OCR] Processing image: {image_id}", flush=True)

    try:
        backend_url = CALLBACK_URL.replace('/jobs/callback', f'/images/{image_id}')
        res = requests.get(backend_url)
        if res.status_code != 200:
            print(f"[OCR] Failed to get image info: {res.status_code}", flush=True)
            return
        image_info = res.json()
        storage_path = image_info['storagePath']
        panels = image_info.get('panels', [])
    except Exception as e:
        print(f"[OCR] Error fetching image details: {e}", flush=True)
        return

    try:
        response = minio_client.get_object('manga-library', storage_path)
        img_bytes = response.read()
    except Exception as e:
        print(f"[OCR] Error downloading from MinIO: {e}", flush=True)
        return

    try:
        results = []
        ocr_upscale = 1.0  # multiplier to map OCR coords back to original image
        img_decoded = None  # decoded image reused by both PaddleOCR and MangaOCR
        img_original = None  # full-resolution image for MangaOCR crops
        # Try PaddleOCR (PP-OCRv5) first
        if paddle_ocr_reader is not None:
            try:
                print("[OCR] Running PaddleOCR (PP-OCRv5 Mobile).", flush=True)

                try:
                    import psutil

                    rss = psutil.Process().memory_info().rss / 1024 / 1024

                    print(
                        f"[OCR] Memory before OCR: {rss:.1f} MB",
                        flush=True
                    )

                except Exception:
                    pass

                nparr = np.frombuffer(img_bytes, np.uint8)
                img_original = cv2.imdecode(
                    nparr,
                    cv2.IMREAD_COLOR
                )

                img_decoded, ocr_upscale = downscale_for_ocr(
                    img_original,
                    max_dim=1024
                )

                if ocr_upscale != 1.0:
                    print(f"[OCR] Downscaled image for OCR (upscale factor: {ocr_upscale:.2f}x)", flush=True)

                del nparr  # free compressed buffer immediately
                if img_decoded is not None:
                    print("[OCR] Calling PaddleOCR...", flush=True)
                    raw_results = paddle_ocr_reader.predict(img_decoded)
                    print("[OCR] PaddleOCR returned.", flush=True)
                    results = parse_paddle_ocr_results(raw_results)
                    del raw_results
                    gc.collect()
                else:
                    print("[OCR] OpenCV failed to decode image for PaddleOCR", flush=True)
            except Exception as ocr_err:
                print(f"[OCR] PaddleOCR failed with exception: {ocr_err}. Falling back...", flush=True)

        # Fallback to EasyOCR if results are empty and reader is available
        if not results and reader is not None:
            try:
                print("[OCR] Running EasyOCR fallback...", flush=True)
                results = reader.readtext(img_bytes)
            except Exception as ocr_err:
                print(f"[OCR] EasyOCR failed: {ocr_err}", flush=True)

        if not results:
            print("[OCR] No text regions detected", flush=True)
            results = []

        # Force GC to reclaim any large temporary tensors created during inference
        gc.collect()
    except Exception as e:
        print(f"[OCR] Error during OCR: {e}", flush=True)
        return

    # Use the full-resolution original image for MangaOCR crops
    # (img_decoded may be downscaled, so we use img_original instead)
    img = img_original if img_original is not None else img_decoded
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
        if lang in ('ja', 'zh-TW') and manga_ocr_reader is not None and img is not None:
            try:
                img_h, img_w = img.shape[:2]
                x1, y1 = max(0, x), max(0, y)
                x2, y2 = min(img_w, x + width), min(img_h, y + height)

                if (x2 - x1) > 0 and (y2 - y1) > 0:
                    crop = img[y1:y2, x1:x2]
                    from PIL import Image
                    crop_rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
                    pil_img = Image.fromarray(crop_rgb)
                    manga_text = manga_ocr_reader(pil_img)
                    if manga_text and len(manga_text.strip()) > 0:
                        print(f"[OCR] Overwriting EasyOCR text '{text}' with MangaOCR '{manga_text}'", flush=True)
                        text = manga_text
                        is_manga_ocr = True
            except Exception as e:
                print(f"[OCR] MangaOCR failed on region ({x},{y},{width},{height}): {e}", flush=True)

        regions.append({
            'text': text,
            'detectedLanguage': lang,
            'confidence': 1.0 if is_manga_ocr else float(confidence),
            'rotation': 0.0,
            'x': x,
            'y': y,
            'width': width,
            'height': height,
            'panelId': None,
            'bubbleReadingOrder': 0
        })

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
    sorted_panel_indices = sorted(panel_regions_map.keys(), key=lambda idx: panels[idx]['readingOrder'])
    
    for panel_idx in sorted_panel_indices:
        panel_bubbles = panel_regions_map[panel_idx]
        panel_bubbles.sort(key=cmp_to_key(bubble_compare))
        
        for b_order, r in enumerate(panel_bubbles, start=1):
            r['bubbleReadingOrder'] = b_order
            ordered_regions.append(r)
            
    unmapped_regions.sort(key=cmp_to_key(bubble_compare))
    for b_order, r in enumerate(unmapped_regions, start=1):
        r['bubbleReadingOrder'] = b_order
        ordered_regions.append(r)

    print(f"[OCR] Completed OCR. Found {len(ordered_regions)} text regions", flush=True)

    callback_payload = {
        'imageId': image_id,
        'regions': ordered_regions
    }
    try:
        res = requests.post(f"{CALLBACK_URL}/ocr", json=callback_payload)
        print(f"[OCR] Callback status code: {res.status_code}", flush=True)
    except Exception as e:
        print(f"[OCR] Failed to post callback to backend: {e}", flush=True)


def process_stub(job_data, job_type):
    image_id = job_data['imageId']
    print(f"[Stub - {job_type}] Processing image: {image_id}", flush=True)

    # Mimic work
    time.sleep(0.5)

    callback_payload = {
        'imageId': image_id
    }
    try:
        res = requests.post(f"{CALLBACK_URL}/{job_type}", json=callback_payload)
        print(f"[Stub - {job_type}] Callback status code: {res.status_code}", flush=True)
    except Exception as e:
        print(f"[Stub - {job_type}] Failed to post callback: {e}", flush=True)


def process_translation(job_data):
    image_id = job_data['imageId']
    print(f"[Translation] Processing image: {image_id}", flush=True)

    try:
        backend_url = CALLBACK_URL.replace('/jobs/callback', f'/images/{image_id}')
        res = requests.get(backend_url)
        if res.status_code != 200:
            print(f"[Translation] Failed to get image info: {res.status_code}", flush=True)
            return
        image_info = res.json()
        ocr_regions = image_info.get('ocrRegions', [])
    except Exception as e:
        print(f"[Translation] Error fetching image details: {e}", flush=True)
        return

    # OCR Quality Filter & Separation
    resolved_translations = {}
    unmatched_regions = []
    
    for r in ocr_regions:
        if not should_translate_region(r):
            # Bypass translation for garbage, keep original text
            resolved_translations[r['id']] = r['text']
        else:
            unmatched_regions.append(r)

    # Translate unmatched regions
    if unmatched_regions:
        use_vlm_translation = os.environ.get('USE_VLM_TRANSLATION', 'false').lower() in ('true', '1', 't')
        batch_mapping = None
        
        # 1. (Optional) VLM vision translation pass
        if use_vlm_translation:
            storage_path = image_info.get('storagePath')
            img_bytes = None
            if storage_path:
                try:
                    response = minio_client.get_object('manga-library', storage_path)
                    img_bytes = response.read()
                except Exception as e:
                    print(f"[Translation] Error downloading image from MinIO for VLM pass: {e}", flush=True)
            
            if img_bytes:
                print(f"[Translation] VLM vision translation pass starting for {len(unmatched_regions)} regions...", flush=True)
                try:
                    vlm_res = translate_vlm_vision(img_bytes, unmatched_regions, TRANSLATION_JSON_SCHEMA)
                    batch_mapping = parse_and_validate_batch(vlm_res, unmatched_regions)
                except Exception as e:
                    print(f"[Translation] VLM vision translation pass failed: {e}", flush=True)
        
        # 2. Standard LLM batch translation
        if not batch_mapping:
            print(f"[Translation] Running standard batch translation for {len(unmatched_regions)} regions...", flush=True)
            try:
                batch_res = translate_batch_llm(unmatched_regions, TRANSLATION_JSON_SCHEMA)
                batch_mapping = parse_and_validate_batch(batch_res, unmatched_regions)
            except Exception as e:
                print(f"[Translation] Standard batch translation failed: {e}", flush=True)

        failed_batch_regions = []
        if batch_mapping:
            # Validate output for each unmatched region
            for r in unmatched_regions:
                rid = r['id']
                translated = batch_mapping.get(rid)
                
                # Run sanity check
                if translated and is_valid_translation(r['text'], translated):
                    resolved_translations[rid] = translated
                else:
                    failed_batch_regions.append(r)
        else:
            # Entire batch failed, all unmatched are failed
            failed_batch_regions = unmatched_regions

        # 3. Retry failed items only in a smaller batch
        if failed_batch_regions:
            print(f"[Translation] Retrying {len(failed_batch_regions)} failed items in batch...", flush=True)
            retry_mapping = None
            try:
                retry_res = translate_batch_llm(failed_batch_regions, TRANSLATION_JSON_SCHEMA)
                retry_mapping = parse_and_validate_batch(retry_res, failed_batch_regions)
            except Exception as e:
                print(f"[Translation] Retry batch translation failed: {e}", flush=True)

            still_failed_regions = []
            if retry_mapping:
                for r in failed_batch_regions:
                    rid = r['id']
                    translated = retry_mapping.get(rid)
                    if translated and is_valid_translation(r['text'], translated):
                        resolved_translations[rid] = translated
                    else:
                        still_failed_regions.append(r)
            else:
                still_failed_regions = failed_batch_regions

            # 4. Individual fallback for still failed regions (DeepSeek/Nemotron -> Local -> DeepL -> Google Translate)
            if still_failed_regions:
                print(f"[Translation] Falling back to individual translation for {len(still_failed_regions)} regions...", flush=True)
                for r in still_failed_regions:
                    rid = r['id']
                    text = r['text']
                    lang = r['detectedLanguage']
                    
                    translated = translate_text(text, source_lang=lang)
                    if translated and is_valid_translation(text, translated):
                        resolved_translations[rid] = translated
                    else:
                        resolved_translations[rid] = None # failed

    # Format the final callback response
    translations = []
    for r in ocr_regions:
        rid = r['id']
        text = r['text']
        lang = r['detectedLanguage']
        
        translated = resolved_translations.get(rid)
        
        translations.append({
            'regionId': rid,
            'translatedText': translated,
            'translationFailed': (translated is None)
        })
        print(f"[Translation] Final: '{text}' ({lang}) -> '{translated}' (failed={translated is None})", flush=True)

    callback_payload = {
        'imageId': image_id,
        'translations': translations
    }
    try:
        res = requests.post(f"{CALLBACK_URL}/translation", json=callback_payload)
        print(f"[Translation] Callback status code: {res.status_code}", flush=True)
    except Exception as e:
        print(f"[Translation] Failed to post callback to backend: {e}", flush=True)


def try_cloud_ocr(img_crop_bytes, provider, api_key, model):
    import base64
    base64_image = base64.b64encode(img_crop_bytes).decode('utf-8')
    prompt = "Respond ONLY with the text shown in this image. Do not add any explanations, notes, or markdown. If there is no text, respond with empty string."
    
    url = ""
    headers = {}
    payload = {}
    
    if provider == 'openai':
        url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": model or "gpt-4o-mini",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{base64_image}"
                            }
                        }
                    ]
                }
            ]
        }
    elif provider == 'openrouter':
        url = "https://openrouter.ai/api/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "model": model or "google/gemini-2.5-flash",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{base64_image}"
                            }
                        }
                    ]
                }
            ]
        }
    elif provider == 'gemini':
        gemini_model = model or "gemini-1.5-flash"
        if "/" not in gemini_model:
            gemini_model = f"models/{gemini_model}"
        url = f"https://generativelanguage.googleapis.com/v1beta/{gemini_model}:generateContent?key={api_key}"
        headers = {
            "Content-Type": "application/json"
        }
        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {
                            "inlineData": {
                                "mimeType": "image/jpeg",
                                "data": base64_image
                            }
                        }
                    ]
                }
            ]
        }
    elif provider == 'anthropic':
        url = "https://api.anthropic.com/v1/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
        }
        payload = {
            "model": model or "claude-3-5-sonnet-20241022",
            "max_tokens": 1000,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": base64_image
                            }
                        },
                        {"type": "text", "text": prompt}
                    ]
                }
            ]
        }
    else:
        return None

    try:
        res = requests.post(url, json=payload, headers=headers, timeout=12)
        if res.status_code == 200:
            res_json = res.json()
            if provider == 'gemini':
                return res_json['candidates'][0]['content']['parts'][0]['text']
            elif provider == 'anthropic':
                return res_json['content'][0]['text']
            else:
                return res_json['choices'][0]['message']['content']
        else:
            print(f"[OCR Redo] Cloud OCR error {res.status_code}: {res.text}", flush=True)
    except Exception as e:
        print(f"[OCR Redo] Cloud OCR HTTP post failed: {e}", flush=True)
    return None

def perform_redo_ocr(img_crop_bytes, lang):
    provider = os.environ.get('MODEL_PROVIDER', os.environ.get('LLM_PROVIDER', 'none')).lower().strip()
    api_key = os.environ.get('API_KEY', os.environ.get('LLM_API_KEY', ''))
    model = os.environ.get('PREFERRED_MODEL', os.environ.get('LLM_MODEL', ''))
    
    if api_key and provider in ('openai', 'openrouter', 'gemini', 'anthropic'):
        try:
            print(f"[OCR Redo] Trying Cloud AI OCR with provider '{provider}'...", flush=True)
            text = try_cloud_ocr(img_crop_bytes, provider, api_key, model)
            if text and len(text.strip()) > 0:
                print(f"[OCR Redo] Cloud AI OCR Success: '{text}'", flush=True)
                return text.strip(), 1.0
        except Exception as e:
            print(f"[OCR Redo] Cloud AI OCR failed: {e}", flush=True)

    # Try PP-OCRv5 first
    if paddle_ocr_reader is not None:
        try:
            print("[OCR Redo] Trying local PP-OCRv5...", flush=True)
            nparr = np.frombuffer(img_crop_bytes, np.uint8)
            img_crop = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            del nparr
            if img_crop is not None:
                img_crop, _ = downscale_for_ocr(img_crop, max_dim=1024)
                crop_results = paddle_ocr_reader.predict(img_crop)
                del img_crop
                gc.collect()
                parsed_crop_results = parse_paddle_ocr_results(crop_results)
                if parsed_crop_results:
                    text = " ".join([line[1] for line in parsed_crop_results])
                    confidence = float(np.mean([line[2] for line in parsed_crop_results]))
                    print(f"[OCR Redo] PP-OCRv5 Success: '{text}' (conf={confidence})", flush=True)
                    return text.strip(), confidence
        except Exception as e:
            print(f"[OCR Redo] PP-OCRv5 failed: {e}", flush=True)

    # Fallback to local MangaOCR if initialized
    if manga_ocr_reader is not None:
        try:
            print("[OCR Redo] Trying local MangaOCR...", flush=True)
            nparr = np.frombuffer(img_crop_bytes, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            from PIL import Image
            crop_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            pil_img = Image.fromarray(crop_rgb)
            manga_text = manga_ocr_reader(pil_img)
            if manga_text and len(manga_text.strip()) > 0:
                print(f"[OCR Redo] Local MangaOCR Success: '{manga_text}'", flush=True)
                return manga_text.strip(), 1.0
        except Exception as e:
            print(f"[OCR Redo] Local MangaOCR failed: {e}", flush=True)

    # Fallback to EasyOCR
    if reader is not None:
        try:
            print("[OCR Redo] Trying local EasyOCR...", flush=True)
            crop_results = reader.readtext(img_crop_bytes)
            if crop_results:
                text = " ".join([res[1] for res in crop_results])
                confidence = float(np.mean([res[2] for res in crop_results]))
                print(f"[OCR Redo] Local EasyOCR Success: '{text}' (conf={confidence})", flush=True)
                return text, confidence
        except Exception as e:
            print(f"[OCR Redo] Local EasyOCR failed: {e}", flush=True)

    return "", 0.0

def process_region_redo(job_data):
    image_id = job_data['imageId']
    region_id = job_data['regionId']
    redo_type = job_data['redoType'] # 'ocr' or 'translation'
    print(f"[Region Redo] Processing region: {region_id} on image {image_id} with type {redo_type}", flush=True)

    try:
        backend_url = CALLBACK_URL.replace('/jobs/callback', f'/images/{image_id}')
        res = requests.get(backend_url)
        if res.status_code != 200:
            print(f"[Region Redo] Failed to get image info: {res.status_code}", flush=True)
            return
        image_info = res.json()
        storage_path = image_info['storagePath']
        ocr_regions = image_info.get('ocrRegions', [])
    except Exception as e:
        print(f"[Region Redo] Error fetching image details: {e}", flush=True)
        return

    region = None
    for r in ocr_regions:
        if r['id'] == region_id:
            region = r
            break
            
    if region is None:
        print(f"[Region Redo] Region {region_id} not found in image details", flush=True)
        return

    try:
        response = minio_client.get_object('manga-library', storage_path)
        img_bytes = response.read()
    except Exception as e:
        print(f"[Region Redo] Error downloading from MinIO: {e}", flush=True)
        return

    callback_payload = {}

    if redo_type == 'ocr':
        try:
            nparr = np.frombuffer(img_bytes, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            img_h, img_w = img.shape[:2]
            
            x, y, width, height = region['bboxX'], region['bboxY'], region['bboxW'], region['bboxH']
            x1, y1 = max(0, x), max(0, y)
            x2, y2 = min(img_w, x + width), min(img_h, y + height)
            
            if (x2 - x1) > 0 and (y2 - y1) > 0:
                crop = img[y1:y2, x1:x2]
                is_success, buffer = cv2.imencode(".jpg", crop)
                crop_bytes = buffer.tobytes()
                
                text, confidence = perform_redo_ocr(crop_bytes, region['detectedLanguage'])
                detected_lang = detect_language(text)
                callback_payload['text'] = text
                callback_payload['confidence'] = confidence
                callback_payload['detectedLanguage'] = detected_lang
                print(f"[Region Redo] Redo OCR success: '{text}' (conf={confidence}, lang={detected_lang})", flush=True)
        except Exception as e:
            print(f"[Region Redo] Redo OCR failed: {e}", flush=True)
            return

    elif redo_type == 'translation':
        try:
            text = region['text']
            lang = region['detectedLanguage']
            translated = translate_text(text, source_lang=lang)
            callback_payload['translatedText'] = translated
            callback_payload['translationFailed'] = (translated is None)
            print(f"[Region Redo] Redo Translation result: '{translated}' (failed={translated is None})", flush=True)
        except Exception as e:
            print(f"[Region Redo] Redo Translation failed: {e}", flush=True)
            return

    try:
        callback_url = CALLBACK_URL.replace('/jobs/callback', f'/ocr-regions/{region_id}/callback')
        res = requests.post(callback_url, json=callback_payload)
        print(f"[Region Redo] Callback status code: {res.status_code}", flush=True)
    except Exception as e:
        print(f"[Region Redo] Failed to post callback: {e}", flush=True)


# --- MAIN RUNNER ---
def main():
    queues = [
        'queue:panel-detection',
        'queue:ocr',
        'queue:layout',
        'queue:translation',
        'queue:render',
        'queue:region-redo'
    ]
    print(f"[Unified Worker] Listening to Redis queues: {queues}...", flush=True)
    while True:
        try:
            # Print queue states on each tick
            states = ", ".join([f"{q}: {redis_client.llen(q)}" for q in queues])
            print(f"[Unified Worker] Queue states: {states}", flush=True)
            job_tuple = redis_client.blpop(queues, timeout=5)
            if job_tuple:
                queue_bytes, job_json = job_tuple
                queue_name = queue_bytes.decode('utf-8')
                job_data = json.loads(job_json)

                if queue_name == 'queue:panel-detection':
                    process_panel_detection(job_data)
                elif queue_name == 'queue:ocr':
                    process_ocr(job_data)
                elif queue_name == 'queue:layout':
                    process_stub(job_data, 'layout')
                elif queue_name == 'queue:translation':
                    process_translation(job_data)
                elif queue_name == 'queue:region-redo':
                    process_region_redo(job_data)
                elif queue_name == 'queue:render':
                    process_stub(job_data, 'render')
        except Exception as e:
            print(f"[Unified Worker] Error in main loop: {e}", flush=True)
            time.sleep(1)

if __name__ == '__main__':
    main()
