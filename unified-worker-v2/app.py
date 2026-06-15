import os
import gc
import json
import time
import re
import redis
import requests
import numpy as np
import cv2
import logging
import uuid
from minio import Minio
from functools import cmp_to_key
from manga_ocr import MangaOcr

# Configure structured logging
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL), format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("translation")

# Import PaddleOCR — lazy-initialized per language on first use.
# The backend passes sourceLanguage + readingDirection in each OCR job payload
# (read from series context) so the worker is not locked to Japanese.
PaddleOCR = None
try:
    print("[Unified Worker] Importing PaddleOCR...", flush=True)
    from paddleocr import PaddleOCR as _PaddleOCR
    import os

    os.environ["FLAGS_use_mkldnn"] = "0"
    os.environ["PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT"] = "0"
    PaddleOCR = _PaddleOCR
    print(
        "[Unified Worker] PaddleOCR imported successfully (readers will be initialized on first use per language).",
        flush=True,
    )
except Exception as e:
    print(f"[Unified Worker] Failed to import PaddleOCR: {e}", flush=True)

# Cache of already-initialized PaddleOCR readers keyed by PaddleOCR language string.
# Readers are created lazily on first OCR request for a given language.
_paddle_ocr_readers: dict = {}

# Map from ISO 639-1 source language codes (as stored in the series table) to
# the corresponding PaddleOCR lang identifier.
LANG_TO_PADDLE: dict = {
    "ja": "japan",
    "zh": "chinese_cht",  # Traditional Chinese (most scanlations)
    "zh-tw": "chinese_cht",
    "zh-cn": "ch",  # Simplified Chinese
    "ko": "korean",
    "en": "en",
}


def get_paddle_ocr_reader(source_language: str):
    """Return a cached PaddleOCR reader for *source_language* (ISO 639-1 code).

    If no reader for this language has been created yet it is instantiated now
    and cached for future calls.  Falls back to 'japan' when the language code
    is unknown so existing behaviour is preserved.
    """
    if PaddleOCR is None:
        return None

    paddle_lang = LANG_TO_PADDLE.get((source_language or "ja").lower(), "japan")

    if paddle_lang not in _paddle_ocr_readers:
        try:
            print(
                f"[Unified Worker] Initializing PaddleOCR (PP-OCRv5 Mobile, lang='{paddle_lang}')...",
                flush=True,
            )
            _paddle_ocr_readers[paddle_lang] = PaddleOCR(
                lang=paddle_lang,
                device="cpu",
                # lighter models
                text_detection_model_name="PP-OCRv5_mobile_det",
                text_recognition_model_name="PP-OCRv5_mobile_rec",
                # save memory
                use_textline_orientation=False,
                use_doc_unwarping=False,
                use_doc_orientation_classify=False,
                enable_mkldnn=False,
            )
            print(
                f"[Unified Worker] PaddleOCR reader ready for lang='{paddle_lang}'.",
                flush=True,
            )
        except Exception as e:
            print(
                f"[Unified Worker] Failed to initialize PaddleOCR for lang='{paddle_lang}': {e}",
                flush=True,
            )
            _paddle_ocr_readers[paddle_lang] = None

    return _paddle_ocr_readers.get(paddle_lang)


# Initialize EasyOCR reader with Japanese and English support (Fallback)
reader = None
try:
    print("[Unified Worker] Importing EasyOCR...", flush=True)
    import easyocr

    print("[Unified Worker] Initializing EasyOCR Reader (ja, en)...", flush=True)
    reader = easyocr.Reader(["ja", "en"], gpu=False)
except Exception as e:
    print(f"[Unified Worker] Failed to initialize EasyOCR: {e}", flush=True)

# Initialize MangaOCR reader with Japanese support (for text inside CJK bubbles)
manga_ocr_reader = None
try:
    print("[Unified Worker] Initializing MangaOCR Reader...", flush=True)
    # Check if we should force CPU from environment (defaults to True)
    force_cpu = os.environ.get("MANGA_OCR_FORCE_CPU", "true").lower() in (
        "true",
        "1",
        "t",
    )
    if force_cpu:
        print("[Unified Worker] Forcing CPU for MangaOCR...", flush=True)
        manga_ocr_reader = MangaOcr(force_cpu=True)
    else:
        try:
            manga_ocr_reader = MangaOcr()
        except Exception as init_err:
            print(
                f"[Unified Worker] Failed to initialize MangaOCR with default settings (likely GPU compatibility issue: {init_err}). Retrying with force_cpu=True...",
                flush=True,
            )
            manga_ocr_reader = MangaOcr(force_cpu=True)
except Exception as e:
    print(
        f"[Unified Worker] Failed to initialize MangaOCR: {e}. Falling back to EasyOCR recognition.",
        flush=True,
    )

# Configurations
REDIS_HOST = os.environ.get("REDIS_HOST", "localhost")
REDIS_PORT = int(os.environ.get("REDIS_PORT", 6379))
MINIO_ENDPOINT = os.environ.get("MINIO_ENDPOINT", "localhost:9000")
MINIO_ACCESS_KEY = os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
MINIO_SECRET_KEY = os.environ.get("MINIO_SECRET_KEY", "minioadmin")
CALLBACK_URL = os.environ.get(
    "BACKEND_CALLBACK_URL", "http://localhost:8080/api/internal/jobs/callback"
)
INTERNAL_API_TOKEN = os.environ.get("INTERNAL_API_TOKEN", "")
BACKEND_HEADERS = {"X-Internal-Token": INTERNAL_API_TOKEN} if INTERNAL_API_TOKEN else {}

# Clients
redis_client = redis.Redis(
    host=REDIS_HOST,
    port=REDIS_PORT,
    socket_timeout=15,
    socket_connect_timeout=5,
    socket_keepalive=True,
    retry_on_timeout=True,
)
minio_client = Minio(
    MINIO_ENDPOINT,
    access_key=MINIO_ACCESS_KEY,
    secret_key=MINIO_SECRET_KEY,
    secure=False,
)


# --- PANEL DETECTION HELPER FUNCTIONS ---
def detect_panels(image_bytes, reading_direction="rtl"):
    """Detect panels in a manga page and sort them by *reading_direction*.

    Supported reading directions:
      'rtl' — Japanese manga: row-grouped, rightmost panel first
      'ltr' — Western comics: row-grouped, leftmost panel first
      'ttb' — Webtoons / manhwa: pure top-to-bottom, no row grouping
    """
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
            panels.append({"x": x, "y": y, "width": width, "height": height})

    # If no panels were detected, default to a single panel containing the whole image
    if not panels:
        panels.append({"x": 0, "y": 0, "width": w, "height": h})

    # --- TTB (top-to-bottom, webtoons) ---
    if reading_direction == "ttb":
        panels.sort(key=lambda p: p["y"])
        for idx, p in enumerate(panels, start=1):
            p["gridRow"] = idx - 1
            p["gridCol"] = 0
            p["readingOrder"] = idx
        return panels

    # --- RTL / LTR: row-grouped sorting ---
    panels.sort(key=lambda p: p["y"])
    rows = []
    for p in panels:
        added = False
        for row in rows:
            # Check if this panel y overlaps with the row's typical y
            avg_y = sum(item["y"] for item in row) / len(row)
            avg_h = sum(item["height"] for item in row) / len(row)
            # Overlap threshold: 25% of height
            if abs(p["y"] - avg_y) < avg_h * 0.25:
                row.append(p)
                added = True
                break
        if not added:
            rows.append([p])

    # Sort each row by x — RTL reverses, LTR does not
    reverse_x = reading_direction != "ltr"
    final_panels = []
    reading_order = 1
    for r_idx, row in enumerate(rows):
        row.sort(key=lambda p: p["x"], reverse=reverse_x)
        for c_idx, p in enumerate(row):
            p["gridRow"] = r_idx
            p["gridCol"] = c_idx
            p["readingOrder"] = reading_order
            reading_order += 1
            final_panels.append(p)

    return final_panels


# --- OCR HELPER FUNCTIONS ---
def detect_language(text):
    # Regex ranges for CJK
    # Japanese Hiragana/Katakana
    if re.search(r"[\u3040-\u309F\u30A0-\u30FF]", text):
        return "ja"
    # Chinese Hanzi (CJK Unified Ideographs)
    elif re.search(r"[\u4E00-\u9FFF]", text):
        return "zh-TW"
    # Otherwise fallback to English
    return "en"


def calculate_overlap_area(r, p):
    # r is ocr region dict, p is panel dict (from db)
    rx, ry, rw, rh = r["x"], r["y"], r["width"], r["height"]
    px, py, pw, ph = p["bboxX"], p["bboxY"], p["bboxW"], p["bboxH"]

    overlap_x = max(0, min(rx + rw, px + pw) - max(rx, px))
    overlap_y = max(0, min(ry + rh, py + ph) - max(ry, py))
    return overlap_x * overlap_y


def bubble_compare(a, b, reading_direction="rtl"):
    """Sort OCR bubbles within a panel according to *reading_direction*.

    Supported values (matching the series table field):
      'rtl' — right-to-left, top-before-bottom  (Japanese manga default)
      'ltr' — left-to-right, top-before-bottom  (Western comics)
      'ttb' — top-to-bottom strip               (webtoons / manhwa)
    """
    y_diff = a["y"] - b["y"]

    if reading_direction == "ttb":
        # Pure top-to-bottom: y position decides everything
        return 1 if y_diff > 0 else (-1 if y_diff < 0 else 0)

    # For both RTL and LTR, cluster into rows first (within 100 px)
    if abs(y_diff) > 100:
        return 1 if y_diff > 0 else -1

    # Within the same row: RTL puts rightmost bubble first, LTR puts leftmost first
    if reading_direction == "ltr":
        x_diff = a["x"] - b["x"]
    else:  # default: rtl
        x_diff = b["x"] - a["x"]

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

            count = min(len(dt_polys), len(rec_texts), len(rec_scores))

            for i in range(count):

                bbox = dt_polys[i]

                if hasattr(bbox, "tolist"):
                    bbox = bbox.tolist()

                results.append((bbox, rec_texts[i], float(rec_scores[i])))

    except Exception as e:
        print(f"[OCR] Failed parsing PaddleOCR results: {e}", flush=True)

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

    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)

    # inverse scale: multiply OCR coords by this to get original-image coords
    return resized, 1.0 / scale


# --- TRANSLATION AND REDO HELPERS ---

# --- TRANSLATION AND REDO HELPERS ---

LAST_REQUEST_TIME = 0.0


def enforce_rate_limit():
    global LAST_REQUEST_TIME
    rate_limit_env = os.environ.get("RATE_LIMIT", "").strip()
    if not rate_limit_env:
        return
    try:
        # Parse formats like "60", "60/m", "60/min", "5/s", "5/sec"
        rpm = None
        if "/" in rate_limit_env:
            parts = rate_limit_env.split("/")
            val = float(parts[0])
            unit = parts[1].lower().strip()
            if unit in ("s", "sec", "second", "seconds"):
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
                print(
                    f"[Translation] Rate limit: Sleeping for {sleep_time:.2f} seconds to respect {rate_limit_env} rate limit...",
                    flush=True,
                )
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
                    "translation": {"type": "string"},
                },
                "required": ["id", "translation"],
            },
        }
    },
    "required": ["translations"],
}

MANGA_TRANSLATION_JSON_SYSTEM_PROMPT = """You are an expert manga translator.
Translate the list of manga text bubbles into natural English.
These bubbles appear in reading order. Maintain context, tone, emotion, and relationships between speakers.
Return ONLY valid JSON format conforming to the requested schema. No conversational prefix, suffix, or markdown formatting."""

PROMPT_VERSION = "batch-v3"


def contains_japanese(text):
    return bool(re.search(r"[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]", text))


def is_valid_translation(source, translated, request_id=None):
    req_prefix = f"[{request_id}] " if request_id else ""
    if not translated:
        logger.warning(
            f"{req_prefix}Validation failed reason=empty_translation source={source}"
        )
        return False

    translated_stripped = translated.strip()
    source_stripped = source.strip()

    # Check forbidden phrases / boilerplate
    forbidden_substrings = ["translate the following text", "text:", "output:", "json"]
    for pattern in forbidden_substrings:
        if pattern in translated_stripped.lower():
            logger.warning(
                f"{req_prefix}Validation failed "
                f"reason=contains_boilerplate "
                f"boilerplate='{pattern}' "
                f"source={source} "
                f"translation={translated}"
            )
            return False

    # Check if translated == source for Japanese
    if contains_japanese(source_stripped) and translated_stripped == source_stripped:
        logger.warning(
            f"{req_prefix}Validation failed "
            f"reason=identical_to_source "
            f"source={source}"
        )
        return False

    # Check if translated is pathologically longer than source
    if (
        len(source_stripped) <= 5
        and len(translated_stripped) > len(source_stripped) * 20
    ):
        logger.warning(
            f"{req_prefix}Validation failed "
            f"reason=pathologically_long "
            f"source={source} "
            f"translation={translated}"
        )
        return False

    return True


def should_translate_region(region):
    text = region.get("text", "")
    stripped = text.strip()
    confidence = region.get("confidence")
    if confidence is None:
        confidence = 1.0
    width = region.get("width") or region.get("bboxW") or 0
    height = region.get("height") or region.get("bboxH") or 0
    region_type = region.get("regionType") or region.get("region_type") or "speech"

    # SFX regions identified by layout analysis are always kept — even if small
    if region_type == "sfx":
        return True

    # Reject regions smaller than 10x10
    if width < 10 or height < 10:
        print(
            f"[Quality Filter] Rejecting region: too small ({width}x{height}) - text: '{text}'",
            flush=True,
        )
        return False

    # Reject low confidence regions (< 0.30)
    if confidence < 0.30:
        print(
            f"[Quality Filter] Rejecting region: low confidence ({confidence:.2f}) - text: '{text}'",
            flush=True,
        )
        return False

    # Special handling for SFX and Japanese kana-only text
    sfx_whitelist = {"ドン", "ガッ", "ぱんッ", "ズキュン"}

    # Check if text is in whitelist
    if stripped in sfx_whitelist:
        return True

    # Check if text is Japanese kana-only
    cleaned_for_kana = re.sub(r"[\s！？\?!\.\,\-\_\"]", "", stripped)
    is_kana_only = False
    if cleaned_for_kana:
        is_kana_only = bool(
            re.match(
                r"^[\u3040-\u309F\u30A0-\u30FF\u30FC\uFF66-\uFF9F]+$", cleaned_for_kana
            )
        )

    if is_kana_only:
        return True

    # Otherwise, reject obvious garbage / non-Japanese low quality texts
    if len(stripped) < 2:
        print(
            f"[Quality Filter] Rejecting region: too short (len={len(stripped)}) - text: '{text}'",
            flush=True,
        )
        return False

    # Reject alphanumeric-only when confidence is low
    if re.match(r"^[A-Za-z0-9._-]+$", stripped):
        if confidence < 0.50:
            print(
                f"[Quality Filter] Rejecting region: alphanumeric-only with low confidence ({confidence:.2f}) - text: '{text}'",
                flush=True,
            )
            return False

    return True


def validate_translation_response(parsed_json):
    items = []
    if isinstance(parsed_json, dict):
        if "translations" in parsed_json:
            items = parsed_json["translations"]
        elif "items" in parsed_json:
            items = parsed_json["items"]
        else:
            if all(
                isinstance(k, str) and isinstance(v, str)
                for k, v in parsed_json.items()
            ):
                return parsed_json
    elif isinstance(parsed_json, list):
        items = parsed_json

    if not isinstance(items, list):
        return None

    validated = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        rid = item.get("id")
        translation = item.get("translation")
        if (
            rid
            and translation
            and isinstance(rid, str)
            and isinstance(translation, str)
            and translation.strip()
        ):
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
        print(
            f"[Translation] Failed to parse batch translation JSON response: {e}. Raw response: {response_text}",
            flush=True,
        )

    return None


def estimate_cost(model, prompt_tokens, completion_tokens, provider=None):
    if not prompt_tokens or not completion_tokens:
        return 0.0
    in_rate = 0.0
    out_rate = 0.0
    model_lower = (model or "").lower()

    if "deepseek-v4-pro" in model_lower:
        in_rate = 0.435 / 1_000_000
        out_rate = 0.87 / 1_000_000
    elif "gemini-2.5-flash" in model_lower:
        if provider == "gemini":
            in_rate = 0.075 / 1_000_000
            out_rate = 0.30 / 1_000_000
        else:  # OpenRouter
            in_rate = 0.30 / 1_000_000
            out_rate = 2.50 / 1_000_000
    elif "claude-3-5-sonnet" in model_lower:
        in_rate = 3.0 / 1_000_000
        out_rate = 15.0 / 1_000_000

    return (prompt_tokens * in_rate) + (completion_tokens * out_rate)


def try_cloud_ai(
    provider, api_key, model, prompt, response_schema=None, request_id=None
):
    req_prefix = f"[{request_id}] " if request_id else ""
    enforce_rate_limit()
    url = ""
    headers = {}
    payload = {}

    if provider == "openrouter":
        url = "https://openrouter.ai/api/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model or "meta-llama/llama-3-8b-instruct:free",
            "messages": [{"role": "user", "content": prompt}],
        }
        if response_schema:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "manga_translation", "schema": response_schema},
            }
    elif provider == "openai":
        url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model or "gpt-4o-mini",
            "messages": [{"role": "user", "content": prompt}],
        }
        if response_schema:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "manga_translation", "schema": response_schema},
            }
    elif provider == "nvidia":
        url = "https://integrate.api.nvidia.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        system_pr = (
            MANGA_TRANSLATION_JSON_SYSTEM_PROMPT
            if response_schema
            else MANGA_TRANSLATION_SYSTEM_PROMPT
        )
        payload = {
            "model": model or "nvidia/riva-translate-4b-instruct-v1.1",
            "messages": [
                {"role": "system", "content": system_pr},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.6,
            "top_p": 0.95,
            "max_tokens": 4096,
        }
        if response_schema:
            payload["response_format"] = {"type": "json_object"}
    elif provider == "anthropic":
        url = "https://api.anthropic.com/v1/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model or "claude-3-5-sonnet-20241022",
            "max_tokens": 1000,
            "messages": [{"role": "user", "content": prompt}],
        }
    elif provider == "gemini":
        gemini_model = model or "gemini-1.5-flash"
        if "/" not in gemini_model:
            gemini_model = f"models/{gemini_model}"
        url = f"https://generativelanguage.googleapis.com/v1beta/{gemini_model}:generateContent?key={api_key}"
        headers = {"Content-Type": "application/json"}
        payload = {"contents": [{"parts": [{"text": prompt}]}]}
        if response_schema:
            payload["generationConfig"] = {
                "responseMimeType": "application/json",
                "responseSchema": response_schema,
            }
    else:
        return None

    try:
        logger.info(
            f"{req_prefix}Sending request to Cloud LLM provider '{provider}' using model '{model}'..."
        )
        start = time.perf_counter()
        res = requests.post(
            url,
            json=payload,
            headers=headers,
            timeout=45 if provider == "nvidia" else 30,
        )
        elapsed = time.perf_counter() - start
        logger.info(
            f"{req_prefix}Provider={provider} " f"Model={model} " f"Time={elapsed:.2f}s"
        )

        response_text = res.text
        logger.debug(f"{req_prefix}Raw Model Output:\n{response_text}")

        if res.status_code == 200:
            res_json = res.json()

            # Extract and log token usage
            usage = res_json.get("usage")
            usage_meta = res_json.get("usageMetadata")
            prompt_tokens = None
            completion_tokens = None
            total_tokens = None
            if usage:
                prompt_tokens = usage.get("prompt_tokens") or usage.get("input_tokens")
                completion_tokens = usage.get("completion_tokens") or usage.get(
                    "output_tokens"
                )
                total_tokens = usage.get("total_tokens") or (
                    (prompt_tokens + completion_tokens)
                    if prompt_tokens and completion_tokens
                    else None
                )
            elif usage_meta:
                prompt_tokens = usage_meta.get("promptTokenCount")
                completion_tokens = usage_meta.get("candidatesTokenCount")
                total_tokens = usage_meta.get("totalTokenCount")

            if prompt_tokens is not None:
                logger.info(
                    f"{req_prefix}Tokens "
                    f"in={prompt_tokens} "
                    f"out={completion_tokens} "
                    f"total={total_tokens}"
                )
                cost = estimate_cost(model, prompt_tokens, completion_tokens, provider)
                logger.info(f"{req_prefix}Estimated cost: ${cost:.5f}")

            if provider == "gemini":
                return res_json["candidates"][0]["content"]["parts"][0]["text"]
            elif provider == "anthropic":
                return res_json["content"][0]["text"]
            else:
                return res_json["choices"][0]["message"]["content"]
        else:
            logger.error(
                f"{req_prefix}Cloud LLM provider '{provider}' returned error: {res.status_code} - {res.text}"
            )
    except Exception as e:
        logger.error(f"{req_prefix}Cloud LLM Translation failed: {e}")
    return None


def try_cloud_ai_vision(
    provider,
    api_key,
    model,
    prompt,
    base64_image,
    response_schema=None,
    request_id=None,
):
    req_prefix = f"[{request_id}] " if request_id else ""
    enforce_rate_limit()
    url = ""
    headers = {}
    payload = {}

    if provider == "openrouter":
        url = "https://openrouter.ai/api/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
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
                            },
                        },
                    ],
                }
            ],
        }
        if response_schema:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "manga_translation", "schema": response_schema},
            }
    elif provider == "gemini":
        gemini_model = model or "gemini-1.5-flash"
        if "/" not in gemini_model:
            gemini_model = f"models/{gemini_model}"
        url = f"https://generativelanguage.googleapis.com/v1beta/{gemini_model}:generateContent?key={api_key}"
        headers = {"Content-Type": "application/json"}
        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {
                            "inlineData": {
                                "mimeType": "image/jpeg",
                                "data": base64_image,
                            }
                        },
                    ]
                }
            ]
        }
        if response_schema:
            payload["generationConfig"] = {
                "responseMimeType": "application/json",
                "responseSchema": response_schema,
            }
    else:
        return None

    try:
        logger.info(
            f"{req_prefix}Sending vision request to provider '{provider}' using model '{model}'..."
        )
        start = time.perf_counter()
        res = requests.post(url, json=payload, headers=headers, timeout=45)
        elapsed = time.perf_counter() - start
        logger.info(
            f"{req_prefix}Provider={provider} " f"Model={model} " f"Time={elapsed:.2f}s"
        )

        response_text = res.text
        logger.debug(f"{req_prefix}Raw Model Output:\n{response_text}")

        if res.status_code == 200:
            res_json = res.json()

            # Extract and log token usage
            usage = res_json.get("usage")
            usage_meta = res_json.get("usageMetadata")
            prompt_tokens = None
            completion_tokens = None
            total_tokens = None
            if usage:
                prompt_tokens = usage.get("prompt_tokens") or usage.get("input_tokens")
                completion_tokens = usage.get("completion_tokens") or usage.get(
                    "output_tokens"
                )
                total_tokens = usage.get("total_tokens") or (
                    (prompt_tokens + completion_tokens)
                    if prompt_tokens and completion_tokens
                    else None
                )
            elif usage_meta:
                prompt_tokens = usage_meta.get("promptTokenCount")
                completion_tokens = usage_meta.get("candidatesTokenCount")
                total_tokens = usage_meta.get("totalTokenCount")

            if prompt_tokens is not None:
                logger.info(
                    f"{req_prefix}Tokens "
                    f"in={prompt_tokens} "
                    f"out={completion_tokens} "
                    f"total={total_tokens}"
                )
                cost = estimate_cost(model, prompt_tokens, completion_tokens, provider)
                logger.info(f"{req_prefix}Estimated cost: ${cost:.5f}")

            if provider == "gemini":
                return res_json["candidates"][0]["content"]["parts"][0]["text"]
            else:
                return res_json["choices"][0]["message"]["content"]
        else:
            logger.error(
                f"{req_prefix}Provider '{provider}' returned error: {res.status_code} - {res.text}"
            )
    except Exception as e:
        logger.error(f"{req_prefix}Vision Translation failed: {e}")
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


def try_local_ai(prompt, text, response_schema=None, request_id=None):
    req_prefix = f"[{request_id}] " if request_id else ""
    enforce_rate_limit()
    local_provider = (
        os.environ.get("LOCAL_LLM_PROVIDER", os.environ.get("LLM_PROVIDER", "lmstudio"))
        .lower()
        .strip()
    )
    local_endpoint = os.environ.get(
        "LOCAL_LLM_ENDPOINT", os.environ.get("LLM_ENDPOINT", "")
    ).strip()
    # Keep gemma3:4b as fallback as requested by user
    model = os.environ.get("LOCAL_LLM_MODEL", "gemma3:4b")

    if not local_endpoint:
        if local_provider == "ollama":
            local_endpoint = "http://ollama:11434/v1/chat/completions"
        else:
            local_endpoint = "http://host.docker.internal:1234/v1/chat/completions"

    endpoints_to_try = [local_endpoint]
    if "localhost" in local_endpoint:
        endpoints_to_try.append(
            local_endpoint.replace("localhost", "host.docker.internal")
        )
    elif "host.docker.internal" in local_endpoint:
        endpoints_to_try.append(
            local_endpoint.replace("host.docker.internal", "localhost")
        )

    system_pr = (
        MANGA_TRANSLATION_JSON_SYSTEM_PROMPT
        if response_schema
        else MANGA_TRANSLATION_SYSTEM_PROMPT
    )

    for endpoint in endpoints_to_try:
        try:
            logger.info(
                f"{req_prefix}Trying Local AI endpoint '{endpoint}' using model '{model}'..."
            )

            if "/api/v1/chat" in endpoint:
                payload = {"model": model, "system_prompt": system_pr, "input": text}
            else:
                payload = {
                    "model": model,
                    "messages": [
                        {"role": "system", "content": system_pr},
                        {"role": "user", "content": text},
                    ],
                }
                if response_schema:
                    if "ollama" in endpoint or local_provider == "ollama":
                        payload["format"] = "json"
                    else:
                        payload["response_format"] = {"type": "json_object"}

            start = time.perf_counter()
            res = requests.post(
                endpoint,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=300,
            )
            elapsed = time.perf_counter() - start
            logger.info(
                f"{req_prefix}Provider={local_provider} "
                f"Model={model} "
                f"Time={elapsed:.2f}s"
            )

            response_text = res.text
            logger.debug(f"{req_prefix}Raw Model Output:\n{response_text}")

            if res.status_code == 200:
                res_json = res.json()
                translated = None
                if "/api/v1/chat" in endpoint:
                    if "choices" in res_json:
                        choice = res_json["choices"][0]
                        if "message" in choice:
                            translated = choice["message"]["content"]
                        elif "text" in choice:
                            translated = choice["text"]
                    elif "output" in res_json:
                        translated = res_json["output"]
                    elif "response" in res_json:
                        translated = res_json["response"]
                else:
                    if "choices" in res_json:
                        translated = res_json["choices"][0]["message"]["content"]
                    elif "response" in res_json:
                        translated = res_json["response"]

                if translated:
                    return translated
        except Exception as e:
            logger.error(
                f"{req_prefix}Local AI connection failed for '{endpoint}': {e}"
            )

    return None


def try_deepl(text, target_lang="en", request_id=None):
    req_prefix = f"[{request_id}] " if request_id else ""
    deepl_key = os.environ.get("DEEPL_API_KEY", os.environ.get("DEEPL_KEY", "")).strip()
    if not deepl_key:
        return None

    if deepl_key.endswith(":fx"):
        url = "https://api-free.deepl.com/v2/translate"
    else:
        url = "https://api.deepl.com/v2/translate"

    try:
        logger.info(f"{req_prefix}Sending request to DeepL API...")
        headers = {
            "Authorization": f"DeepL-Auth-Key {deepl_key}",
            "Content-Type": "application/json",
        }
        payload = {"text": [text], "target_lang": target_lang.upper()}

        start = time.perf_counter()
        res = requests.post(url, json=payload, headers=headers, timeout=8)
        elapsed = time.perf_counter() - start
        logger.info(
            f"{req_prefix}Provider=deepl " f"Model=deepl " f"Time={elapsed:.2f}s"
        )

        if res.status_code == 200:
            res_json = res.json()
            translated = res_json["translations"][0]["text"]
            logger.info(f"{req_prefix}DeepL Translation Success: '{translated}'")
            return translated
        else:
            logger.error(
                f"{req_prefix}DeepL API returned error: {res.status_code} - {res.text}"
            )
    except Exception as e:
        logger.error(f"{req_prefix}DeepL Translation failed: {e}")
    return None


def try_google_translate(text, source_lang="auto", target_lang="en", request_id=None):
    req_prefix = f"[{request_id}] " if request_id else ""
    try:
        logger.info(f"{req_prefix}Falling back to free Google Translate API...")
        import urllib.parse

        url = (
            f"https://translate.googleapis.com/translate_a/single?client=gtx&sl={source_lang}&tl={target_lang}&dt=t&q="
            + urllib.parse.quote(text)
        )

        start = time.perf_counter()
        res = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=5)
        elapsed = time.perf_counter() - start
        logger.info(
            f"{req_prefix}Provider=google_translate "
            f"Model=free_api "
            f"Time={elapsed:.2f}s"
        )

        if res.status_code == 200:
            data = res.json()
            translated = "".join([part[0] for part in data[0] if part[0]])
            logger.info(f"{req_prefix}Google Translate Success: '{translated}'")
            return translated
    except Exception as e:
        logger.error(f"{req_prefix}Google Translate fallback failed: {e}")
    return None


def clean_translated_text(translated):
    if not translated:
        return translated
    if isinstance(translated, list) and len(translated) > 0:
        if isinstance(translated[0], dict) and "content" in translated[0]:
            translated = translated[0]["content"]
        elif isinstance(translated[0], str):
            translated = translated[0]
    if isinstance(translated, str):
        translated = translated.strip()
        if (translated.startswith('"') and translated.endswith('"')) or (
            translated.startswith("'") and translated.endswith("'")
        ):
            translated = translated[1:-1].strip()
        return translated
    return translated


def translate_text(text, source_lang="auto", target_lang="en", request_id=None):
    if not request_id:
        request_id = str(uuid.uuid4())[:8]
    req_prefix = f"[{request_id}] "

    provider = os.environ.get("MODEL_PROVIDER", "").lower().strip()
    api_key = os.environ.get("API_KEY", "").strip()

    # LOCAL_ONLY mode: when provider is a local runtime, skip all cloud tiers
    local_only = provider in ("ollama", "lmstudio")

    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "").strip() or (
        api_key if provider == "openrouter" else ""
    )
    nvidia_key = os.environ.get("NVIDIA_API_KEY", "").strip() or (
        api_key if provider == "nvidia" else ""
    )
    gemini_key = os.environ.get("GEMINI_API_KEY", "").strip() or (
        api_key if provider == "gemini" else ""
    )
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "").strip() or (
        api_key if provider == "anthropic" else ""
    )
    deepl_key = os.environ.get("DEEPL_API_KEY", os.environ.get("DEEPL_KEY", "")).strip()

    prompt = f"Translate the following text to natural English, maintaining its tone and context. Respond ONLY with the translated text. Do not include any tags, notes, or explanations.\n\nText: {text}"

    # Log Strategy
    logger.info(f"{req_prefix}Translation Strategy:")
    strategy_idx = 1
    if not local_only:
        if openrouter_key:
            logger.info(f"{req_prefix}{strategy_idx}. DeepSeek V4 Pro (OpenRouter)")
            strategy_idx += 1
            logger.info(f"{req_prefix}{strategy_idx}. Gemini 2.5 Flash (OpenRouter)")
            strategy_idx += 1
        elif gemini_key:
            logger.info(f"{req_prefix}{strategy_idx}. Gemini 2.5 Flash (Direct)")
            strategy_idx += 1

        if nvidia_key and provider == "nvidia":
            nvidia_model = os.environ.get("PREFERRED_MODEL", "google/gemma-3n-e4b-it")
            logger.info(f"{req_prefix}{strategy_idx}. {nvidia_model} (Nvidia)")
            strategy_idx += 1
        if anthropic_key:
            logger.info(f"{req_prefix}{strategy_idx}. Claude 3.5 Sonnet (Direct)")
            strategy_idx += 1

    logger.info(f"{req_prefix}{strategy_idx}. Local LLM")
    strategy_idx += 1
    if not local_only:
        if deepl_key:
            logger.info(f"{req_prefix}{strategy_idx}. DeepL")
            strategy_idx += 1
        logger.info(f"{req_prefix}{strategy_idx}. Google Translate")

    if local_only:
        logger.info(
            f"{req_prefix}LOCAL_ONLY mode (provider='{provider}') — skipping cloud AI tiers."
        )
    else:
        # 1. Cloud LLM Layer (DeepSeek V4 Pro, then Gemini 2.5 Flash / Claude Sonnet fallback)
        if openrouter_key:
            translated = try_cloud_ai(
                "openrouter",
                openrouter_key,
                "deepseek-ai/deepseek-v4-pro",
                prompt,
                request_id=request_id,
            )
            if translated:
                cleaned = clean_translated_text(translated)
                if is_valid_translation(text, cleaned, request_id=request_id):
                    return cleaned

            # Fallback to Gemini 2.5 Flash via OpenRouter
            translated = try_cloud_ai(
                "openrouter",
                openrouter_key,
                "google/gemini-2.5-flash",
                prompt,
                request_id=request_id,
            )
            if translated:
                cleaned = clean_translated_text(translated)
                if is_valid_translation(text, cleaned, request_id=request_id):
                    return cleaned

        elif gemini_key:
            # Direct Gemini API fallback
            preferred = os.environ.get("PREFERRED_MODEL", "gemini-2.5-flash")
            translated = try_cloud_ai(
                "gemini", gemini_key, preferred, prompt, request_id=request_id
            )
            if translated:
                cleaned = clean_translated_text(translated)
                if is_valid_translation(text, cleaned, request_id=request_id):
                    return cleaned
        if nvidia_key and provider == "nvidia":
            nvidia_model = os.environ.get("PREFERRED_MODEL", "google/gemma-3n-e4b-it")
            translated = try_cloud_ai(
                "nvidia",
                nvidia_key,
                nvidia_model,
                prompt,
                request_id=request_id,
            )
            if translated:
                cleaned = clean_translated_text(translated)
                if is_valid_translation(text, cleaned, request_id=request_id):
                    return cleaned

        if anthropic_key:
            translated = try_cloud_ai(
                "anthropic",
                anthropic_key,
                "claude-3-5-sonnet-20241022",
                prompt,
                request_id=request_id,
            )
            if translated:
                cleaned = clean_translated_text(translated)
                if is_valid_translation(text, cleaned, request_id=request_id):
                    return cleaned

    # 2. Local Ollama/LMStudio Layer
    translated = try_local_ai(prompt, text, request_id=request_id)
    if translated:
        cleaned = clean_translated_text(translated)
        if is_valid_translation(text, cleaned, request_id=request_id):
            return cleaned

    if local_only:
        logger.info(
            f"{req_prefix}LOCAL_ONLY mode — not falling back to DeepL/Google Translate."
        )
        logger.error(f"{req_prefix}All translation tiers failed for text: '{text}'")
        return None

    # 3. DeepL Layer
    translated = try_deepl(text, target_lang, request_id=request_id)
    if translated:
        cleaned = clean_translated_text(translated)
        if is_valid_translation(text, cleaned, request_id=request_id):
            return cleaned

    # 4. Google Translate Layer
    translated = try_google_translate(
        text, source_lang, target_lang, request_id=request_id
    )
    if translated:
        cleaned = clean_translated_text(translated)
        if is_valid_translation(text, cleaned, request_id=request_id):
            return cleaned

    logger.error(f"{req_prefix}All translation tiers failed for text: '{text}'")
    return None


def translate_batch_llm(unmatched_regions, response_schema=None, request_id=None):
    if not request_id:
        request_id = str(uuid.uuid4())[:8]
    req_prefix = f"[{request_id}] "

    bubbles_input = []
    for r in unmatched_regions:
        bubbles_input.append(
            {
                "id": r["id"],
                "panel": r.get("panelReadingOrder") or r.get("panelId") or 0,
                "bubble": r.get("bubbleReadingOrder") or 0,
                "speaker": None,
                "text": r["text"],
            }
        )
    bubbles_json = json.dumps(bubbles_input, ensure_ascii=False, indent=2)

    logger.debug(f"{req_prefix}Batch Input:\n{bubbles_json}")
    logger.info(f"{req_prefix}Prompt={PROMPT_VERSION}")

    prompt = f"""These bubbles appear in reading order.
Translate each bubble into natural manga English.
Preserve:
- tone
- emotional state
- relationships
- ongoing conversation

You MUST return a JSON object containing a "translations" key with an array of objects.
Each object in the array MUST have exactly two keys: "id" (the original string ID) and "translation" (your English translation).
Example structure:
{{
  "translations": [
    {{
      "id": "some-id-1",
      "translation": "Translated text here"
    }},
    {{
      "id": "some-id-2",
      "translation": "Another translated text"
    }}
  ]
}}

Return ONLY valid JSON.

Input:
{bubbles_json}
"""
    provider = os.environ.get("MODEL_PROVIDER", "").lower().strip()
    api_key = os.environ.get("API_KEY", "").strip()

    # LOCAL_ONLY mode: when provider is a local runtime, skip all cloud tiers
    local_only = provider in ("ollama", "lmstudio")

    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "").strip() or (
        api_key if provider == "openrouter" else ""
    )
    nvidia_key = os.environ.get("NVIDIA_API_KEY", "").strip() or (
        api_key if provider == "nvidia" else ""
    )
    gemini_key = os.environ.get("GEMINI_API_KEY", "").strip() or (
        api_key if provider == "gemini" else ""
    )
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "").strip() or (
        api_key if provider == "anthropic" else ""
    )

    if local_only:
        logger.info(
            f"{req_prefix}Batch: LOCAL_ONLY mode (provider='{provider}') — skipping cloud AI tiers."
        )
    else:
        # Try DeepSeek V4 Pro
        if openrouter_key:
            logger.info(f"{req_prefix}Batch: Trying DeepSeek V4 Pro...")
            try:
                res = try_cloud_ai(
                    "openrouter",
                    openrouter_key,
                    "deepseek-ai/deepseek-v4-pro",
                    prompt,
                    response_schema,
                    request_id=request_id,
                )
                if res:
                    return res
            except Exception as e:
                logger.error(f"{req_prefix}DeepSeek batch translation failed: {e}")

            # Try Gemini 2.5 Flash via OpenRouter
            logger.info(f"{req_prefix}Batch: Trying Gemini 2.5 Flash (OpenRouter)...")
            try:
                res = try_cloud_ai(
                    "openrouter",
                    openrouter_key,
                    "google/gemini-2.5-flash",
                    prompt,
                    response_schema,
                    request_id=request_id,
                )
                if res:
                    return res
            except Exception as e:
                logger.error(
                    f"{req_prefix}Gemini OpenRouter batch translation failed: {e}"
                )

        elif gemini_key:
            # Try Direct Gemini API
            preferred = os.environ.get("PREFERRED_MODEL", "gemini-2.5-flash")
            logger.info(f"{req_prefix}Batch: Trying Gemini ({preferred}) Direct...")
            try:
                res = try_cloud_ai(
                    "gemini",
                    gemini_key,
                    preferred,
                    prompt,
                    response_schema,
                    request_id=request_id,
                )
                if res:
                    return res
            except Exception as e:
                logger.error(f"{req_prefix}Gemini Direct batch translation failed: {e}")

        # Try Nvidia NIM (only if provider is nvidia and nvidia key is provided)
        if nvidia_key and provider == "nvidia":
            nvidia_model = os.environ.get("PREFERRED_MODEL", "google/gemma-3n-e4b-it")
            logger.info(f"{req_prefix}Batch: Trying Nvidia model {nvidia_model}...")
            try:
                res = try_cloud_ai(
                    "nvidia",
                    nvidia_key,
                    nvidia_model,
                    prompt,
                    response_schema,
                    request_id=request_id,
                )
                if res:
                    return res
            except Exception as e:
                logger.error(f"{req_prefix}Nvidia batch translation failed: {e}")

    # Try Local LLM (Ollama/LMStudio)
    local_provider = (
        os.environ.get("LOCAL_LLM_PROVIDER", os.environ.get("LLM_PROVIDER", "lmstudio"))
        .lower()
        .strip()
    )
    logger.info(f"{req_prefix}Batch: Trying Local LLM ({local_provider})...")
    try:
        res = try_local_ai(prompt, bubbles_json, response_schema, request_id=request_id)
        if res:
            return res
    except Exception as e:
        logger.error(f"{req_prefix}Local LLM batch translation failed: {e}")

    return None


def translate_vlm_vision(
    img_bytes, unmatched_regions, response_schema=None, request_id=None
):
    if not img_bytes:
        return None
    req_prefix = f"[{request_id}] " if request_id else ""

    import base64

    base64_image = base64.b64encode(img_bytes).decode("utf-8")

    bubbles_input = []
    for r in unmatched_regions:
        bubbles_input.append(
            {
                "id": r["id"],
                "panel": r.get("panelReadingOrder") or r.get("panelId") or 0,
                "bubble": r.get("bubbleReadingOrder") or 0,
                "speaker": None,
                "text": r["text"],
            }
        )

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
    provider = os.environ.get("MODEL_PROVIDER", "").lower().strip()
    api_key = os.environ.get("API_KEY", "").strip()

    openrouter_key = os.environ.get("OPENROUTER_API_KEY", "").strip() or (
        api_key if provider == "openrouter" else ""
    )
    gemini_key = os.environ.get("GEMINI_API_KEY", "").strip() or (
        api_key if provider == "gemini" else ""
    )

    if openrouter_key:
        logger.info(f"{req_prefix}VLM: Trying vision model via OpenRouter...")
        vlm_model = os.environ.get("VLM_MODEL", "google/gemini-2.5-flash")
        try:
            res = try_cloud_ai_vision(
                "openrouter",
                openrouter_key,
                vlm_model,
                prompt,
                base64_image,
                response_schema,
                request_id=request_id,
            )
            if res:
                return res
        except Exception as e:
            logger.error(
                f"{req_prefix}VLM vision translation via OpenRouter failed: {e}"
            )

    if (provider == "gemini" or gemini_key) and gemini_key:
        logger.info(f"{req_prefix}VLM: Trying vision model via Gemini...")
        vlm_model = os.environ.get("PREFERRED_MODEL", "gemini-1.5-flash")
        try:
            res = try_cloud_ai_vision(
                "gemini",
                gemini_key or api_key,
                vlm_model,
                prompt,
                base64_image,
                response_schema,
                request_id=request_id,
            )
            if res:
                return res
        except Exception as e:
            logger.error(f"{req_prefix}VLM vision translation via Gemini failed: {e}")

    return None


def translate_batch_deepl(unmatched_regions, target_lang="en", request_id=None):
    req_prefix = f"[{request_id}] " if request_id else ""
    deepl_key = os.environ.get("DEEPL_API_KEY", os.environ.get("DEEPL_KEY", "")).strip()
    if not deepl_key:
        return None

    if deepl_key.endswith(":fx"):
        url = "https://api-free.deepl.com/v2/translate"
    else:
        url = "https://api.deepl.com/v2/translate"

    try:
        logger.info(
            f"{req_prefix}Sending batch request of {len(unmatched_regions)} bubbles to DeepL API..."
        )
        headers = {
            "Authorization": f"DeepL-Auth-Key {deepl_key}",
            "Content-Type": "application/json",
        }
        texts = [r["text"] for r in unmatched_regions]
        payload = {"text": texts, "target_lang": target_lang.upper()}

        start = time.perf_counter()
        res = requests.post(url, json=payload, headers=headers, timeout=8)
        elapsed = time.perf_counter() - start
        logger.info(
            f"{req_prefix}Provider=deepl " f"Model=deepl_batch " f"Time={elapsed:.2f}s"
        )

        if res.status_code == 200:
            res_json = res.json()
            translations = res_json["translations"]
            mapping = {}
            for i, r in enumerate(unmatched_regions):
                mapping[r["id"]] = translations[i]["text"]
            return mapping
        else:
            logger.error(
                f"{req_prefix}DeepL API returned error: {res.status_code} - {res.text}"
            )
    except Exception as e:
        logger.error(f"{req_prefix}DeepL batch translation failed: {e}")
    return None


# --- JOB PROCESSORS ---


def process_panel_detection(job_data):
    image_id = job_data["imageId"]
    reading_direction = (job_data.get("readingDirection") or "rtl").strip().lower()
    print(
        f"[Panel Detection] Processing image: {image_id} (direction={reading_direction})",
        flush=True,
    )

    try:
        backend_url = CALLBACK_URL.replace("/jobs/callback", f"/images/{image_id}")
        res = requests.get(backend_url, headers=BACKEND_HEADERS)
        if res.status_code != 200:
            print(
                f"[Panel Detection] Failed to get image info: {res.status_code}",
                flush=True,
            )
            return
        image_info = res.json()
        storage_path = image_info["storagePath"]
    except Exception as e:
        print(f"[Panel Detection] Error fetching image details: {e}", flush=True)
        return

    try:
        response = minio_client.get_object("manga-library", storage_path)
        img_bytes = response.read()
    except Exception as e:
        print(f"[Panel Detection] Error downloading from MinIO: {e}", flush=True)
        return

    panels = detect_panels(img_bytes, reading_direction=reading_direction)
    print(
        f"[Panel Detection] Detected {len(panels)} panels for image {image_id}",
        flush=True,
    )

    callback_payload = {"imageId": image_id, "panels": panels}
    try:
        res = requests.post(
            f"{CALLBACK_URL}/panel", json=callback_payload, headers=BACKEND_HEADERS
        )
        print(f"[Panel Detection] Callback status code: {res.status_code}", flush=True)
    except Exception as e:
        print(f"[Panel Detection] Failed to post callback to backend: {e}", flush=True)


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
        storage_path = image_info["storagePath"]
        panels = image_info.get("panels", [])
    except Exception as e:
        print(f"[OCR] Error fetching image details: {e}", flush=True)
        return

    try:
        response = minio_client.get_object("manga-library", storage_path)
        img_bytes = response.read()
    except Exception as e:
        print(f"[OCR] Error downloading from MinIO: {e}", flush=True)
        return

    try:
        results = []
        ocr_upscale = 1.0  # multiplier to map OCR coords back to original image
        img_decoded = None  # decoded image reused by both PaddleOCR and MangaOCR
        img_original = None  # full-resolution image for MangaOCR crops
        # Try PaddleOCR (PP-OCRv5) first — reader is lazily created per language
        paddle_ocr_reader = get_paddle_ocr_reader(source_language)
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
        if lang in ("ja", "zh-TW") and manga_ocr_reader is not None and img is not None:
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
                        print(
                            f"[OCR] Overwriting EasyOCR text '{text}' with MangaOCR '{manga_text}'",
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


# --- LAYOUT ANALYSIS HELPER FUNCTIONS (Steps 10 + 11) ---


def classify_region_type(region, panel, image_width, image_height):
    """Classify an OCR region as speech/narration/sfx/caption/sign.

    Uses heuristic rules based on geometry, position, and text content.
    Returns one of: 'speech', 'narration', 'sfx', 'caption', 'sign'
    """
    text = region.get("text", "")
    confidence = region.get("confidence") or 1.0
    rx = region.get("bboxX") or region.get("x", 0)
    ry = region.get("bboxY") or region.get("y", 0)
    rw = region.get("bboxW") or region.get("width", 1)
    rh = region.get("bboxH") or region.get("height", 1)

    # Aspect ratios
    aspect = rw / max(rh, 1)
    tall_aspect = rh / max(rw, 1)

    # Check if text is kana-only (hiragana/katakana) — strong SFX signal
    cleaned = re.sub(r"[\s！？\?!\.\,\-\_\"]", "", text.strip())
    is_kana_only = False
    if cleaned:
        is_kana_only = bool(
            re.match(r"^[\u3040-\u309F\u30A0-\u30FF\u30FC\uFF66-\uFF9F]+$", cleaned)
        )

    # --- SFX detection ---
    # Kana-only text or very tall narrow region (vertical SFX)
    if is_kana_only and len(cleaned) <= 5:
        return "sfx"
    if tall_aspect > 3.0 and len(text.strip()) <= 6:
        return "sfx"

    # --- Check if region is inside any panel ---
    in_panel = panel is not None

    # --- Caption: outside all panels, at page top or bottom edges ---
    if not in_panel:
        # Top 8% or bottom 8% of the image
        if ry < image_height * 0.08 or (ry + rh) > image_height * 0.92:
            return "caption"
        # Outside panels but not at page edges — could be narration box overlay
        if aspect > 2.5:
            return "narration"
        return "caption"

    # --- Narration: very wide region or at panel edge ---
    if panel is not None:
        px = panel.get("bboxX", 0)
        py = panel.get("bboxY", 0)
        pw = panel.get("bboxW", 1)
        ph = panel.get("bboxH", 1)

        # Wide aspect ratio relative to panel width — narration box
        if aspect > 3.0 and rw > pw * 0.6:
            return "narration"

        # At very top or bottom edge of panel (within 8% of panel height)
        rel_top = (ry - py) / max(ph, 1)
        rel_bottom = ((py + ph) - (ry + rh)) / max(ph, 1)
        if (rel_top < 0.08 or rel_bottom < 0.08) and aspect > 2.0:
            return "narration"

    # --- Sign: inside panel but low confidence and small ---
    if in_panel and confidence < 0.50:
        region_area = rw * rh
        panel_area = panel.get("bboxW", 1) * panel.get("bboxH", 1) if panel else 1
        if panel_area > 0 and region_area / panel_area < 0.05:
            return "sign"

    # Default: speech bubble
    return "speech"


def group_conversations(regions, panels, reading_direction="rtl"):
    """Group OCR regions into conversation clusters.

    Algorithm:
    1. For each panel, collect its assigned regions sorted by bubble reading order.
    2. Within a panel, group regions into conversations using spatial proximity:
       - Two regions belong to the same conversation if their vertical gap is
         ≤ 1.5× the average bubble height in the panel.
       - Narration and SFX regions start their own group.
    3. Assign scene_type based on the region types within each group.

    Returns list of:
      {"regionIds": [region_id, ...], "sceneType": "dialogue"|..., "panelIds": [...]}
    """
    # Build panel → regions mapping
    panel_map = {}  # panel_reading_order → list of regions
    unmapped = []

    for r in regions:
        panel_order = r.get("panelReadingOrder") or 0
        if panel_order > 0:
            if panel_order not in panel_map:
                panel_map[panel_order] = []
            panel_map[panel_order].append(r)
        else:
            unmapped.append(r)

    conversations = []

    for panel_order in sorted(panel_map.keys()):
        panel_regions = panel_map[panel_order]
        # Sort by bubble reading order
        panel_regions.sort(key=lambda r: r.get("bubbleReadingOrder", 0))

        # Calculate average bubble height for proximity threshold
        heights = [r.get("bboxH") or r.get("height", 50) for r in panel_regions]
        avg_height = sum(heights) / len(heights) if heights else 50
        proximity_threshold = avg_height * 1.5

        current_group = []
        current_panel_ids = set()

        for r in panel_regions:
            region_type = r.get("regionType") or r.get("region_type") or "speech"
            rid = r.get("id", "")
            ry = r.get("bboxY") or r.get("y", 0)
            rh = r.get("bboxH") or r.get("height", 0)

            # Narration and SFX always start their own group
            if region_type in ("narration", "sfx", "caption", "sign"):
                # Flush current dialogue group
                if current_group:
                    conversations.append(
                        _finish_conversation_group(current_group, current_panel_ids)
                    )
                    current_group = []
                    current_panel_ids = set()

                # Single-region group for narration/sfx
                scene = (
                    "narration"
                    if region_type in ("narration", "caption")
                    else "sfx_cluster"
                )
                conversations.append(
                    {
                        "regionIds": [rid],
                        "sceneType": scene,
                        "panelIds": [str(panel_order)],
                    }
                )
                continue

            # Speech/thought — group by spatial proximity
            if current_group:
                last_r = current_group[-1]
                last_bottom = (last_r.get("bboxY") or last_r.get("y", 0)) + (
                    last_r.get("bboxH") or last_r.get("height", 0)
                )
                gap = ry - last_bottom
                if gap > proximity_threshold:
                    # Start new group
                    conversations.append(
                        _finish_conversation_group(current_group, current_panel_ids)
                    )
                    current_group = []
                    current_panel_ids = set()

            current_group.append(r)
            current_panel_ids.add(str(panel_order))

        # Flush remaining group
        if current_group:
            conversations.append(
                _finish_conversation_group(current_group, current_panel_ids)
            )

    # Handle unmapped regions (outside all panels)
    for r in unmapped:
        rid = r.get("id", "")
        region_type = r.get("regionType") or r.get("region_type") or "speech"
        scene = (
            "narration"
            if region_type in ("narration", "caption")
            else ("sfx_cluster" if region_type == "sfx" else "dialogue")
        )
        conversations.append(
            {
                "regionIds": [rid],
                "sceneType": scene,
                "panelIds": [],
            }
        )

    return conversations


def _finish_conversation_group(group, panel_ids):
    """Convert a group of regions into a conversation dict."""
    region_ids = [r.get("id", "") for r in group]
    scene_type = "monologue" if len(region_ids) == 1 else "dialogue"
    return {
        "regionIds": region_ids,
        "sceneType": scene_type,
        "panelIds": list(panel_ids),
    }


def process_layout(job_data):
    """Layout analysis: classify region types and group conversations.

    Replaces the previous stub that only slept for 0.5s.
    """
    image_id = job_data["imageId"]
    print(f"[Layout] Processing image: {image_id}", flush=True)

    # 1. Fetch OCR regions + panels from backend
    try:
        backend_url = CALLBACK_URL.replace("/jobs/callback", f"/images/{image_id}")
        res = requests.get(backend_url, headers=BACKEND_HEADERS)
        if res.status_code != 200:
            print(f"[Layout] Failed to get image info: {res.status_code}", flush=True)
            return
        image_info = res.json()
        ocr_regions = image_info.get("ocrRegions", [])
        panels = image_info.get("panels", [])
    except Exception as e:
        print(f"[Layout] Error fetching image details: {e}", flush=True)
        return

    if not ocr_regions:
        print("[Layout] No OCR regions found, skipping layout analysis.", flush=True)
        # Still send callback so pipeline continues
        callback_payload = {"imageId": image_id, "regionTypes": [], "conversations": []}
        try:
            res = requests.post(
                f"{CALLBACK_URL}/layout", json=callback_payload, headers=BACKEND_HEADERS
            )
            print(f"[Layout] Callback status code: {res.status_code}", flush=True)
        except Exception as e:
            print(f"[Layout] Failed to post callback: {e}", flush=True)
        return

    # Get image dimensions from the first panel or estimate from regions
    image_width = max(
        (p.get("bboxX", 0) + p.get("bboxW", 0) for p in panels),
        default=max(
            (r.get("bboxX", 0) + r.get("bboxW", 0) for r in ocr_regions), default=1000
        ),
    )
    image_height = max(
        (p.get("bboxY", 0) + p.get("bboxH", 0) for p in panels),
        default=max(
            (r.get("bboxY", 0) + r.get("bboxH", 0) for r in ocr_regions), default=1400
        ),
    )

    # Build panel lookup by ID
    panel_by_id = {}
    for p in panels:
        pid = p.get("id") or p.get("panelId")
        if pid:
            panel_by_id[str(pid)] = p

    # 2. Classify each region type
    region_types = []
    for r in ocr_regions:
        # Find matching panel for this region
        panel_id = r.get("panelId") or r.get("panel_id")
        panel = panel_by_id.get(str(panel_id)) if panel_id else None

        rtype = classify_region_type(r, panel, image_width, image_height)
        r["regionType"] = rtype  # Annotate in-memory for conversation grouping
        region_types.append(
            {
                "regionId": str(r.get("id", "")),
                "regionType": rtype,
            }
        )
        print(
            f"[Layout] Region {str(r.get('id', ''))[:8]}... "
            f"type={rtype} text='{(r.get('text', '') or '')[:30]}'",
            flush=True,
        )

    print(
        f"[Layout] Region types: "
        + ", ".join(
            f"{t}: {sum(1 for rt in region_types if rt['regionType'] == t)}"
            for t in set(rt["regionType"] for rt in region_types)
        ),
        flush=True,
    )

    # 3. Group conversations
    reading_direction = "rtl"  # Default; could be passed in job_data if needed
    conversations = group_conversations(ocr_regions, panels, reading_direction)
    print(
        f"[Layout] Grouped {len(ocr_regions)} regions into {len(conversations)} conversations",
        flush=True,
    )

    # Detailed logging for the grouped conversations
    print("[Layout] --- Conversation Grouping Details ---", flush=True)
    for idx, conv in enumerate(conversations):
        region_details = []
        for rid in conv["regionIds"]:
            reg = next((r for r in ocr_regions if str(r.get("id")) == rid), None)
            if reg:
                text = reg.get("text", "").strip().replace('\n', ' ')
                rtype = reg.get("regionType") or reg.get("region_type") or "speech"
                region_details.append(f"[{rtype}] '{text}'")
        panel_info = f"panels={conv['panelIds']}" if conv.get('panelIds') else "unmapped"
        print(f"[Layout] Conversation #{idx+1} ({conv['sceneType']}, {panel_info}): " + " -> ".join(region_details), flush=True)
    print("[Layout] -------------------------------------", flush=True)

    # 4. Send enriched layout callback
    callback_payload = {
        "imageId": image_id,
        "regionTypes": region_types,
        "conversations": [
            {
                "regionIds": conv["regionIds"],
                "sceneType": conv["sceneType"],
            }
            for conv in conversations
        ],
    }
    try:
        res = requests.post(
            f"{CALLBACK_URL}/layout", json=callback_payload, headers=BACKEND_HEADERS
        )
        print(f"[Layout] Callback status code: {res.status_code}", flush=True)
    except Exception as e:
        print(f"[Layout] Failed to post callback to backend: {e}", flush=True)


def process_stub(job_data, job_type):
    image_id = job_data["imageId"]
    print(f"[Stub - {job_type}] Processing image: {image_id}", flush=True)

    # Mimic work
    time.sleep(0.5)

    callback_payload = {"imageId": image_id}
    try:
        res = requests.post(
            f"{CALLBACK_URL}/{job_type}", json=callback_payload, headers=BACKEND_HEADERS
        )
        print(
            f"[Stub - {job_type}] Callback status code: {res.status_code}", flush=True
        )
    except Exception as e:
        print(f"[Stub - {job_type}] Failed to post callback: {e}", flush=True)


def process_translation(job_data):
    image_id = job_data["imageId"]
    request_id = str(uuid.uuid4())[:8]
    req_prefix = f"[{request_id}] "

    logger.info(f"{req_prefix}Processing translation for image: {image_id}")

    try:
        backend_url = CALLBACK_URL.replace("/jobs/callback", f"/images/{image_id}")
        res = requests.get(backend_url, headers=BACKEND_HEADERS)
        if res.status_code != 200:
            logger.error(f"{req_prefix}Failed to get image info: {res.status_code}")
            return
        image_info = res.json()
        ocr_regions = image_info.get("ocrRegions", [])
    except Exception as e:
        logger.error(f"{req_prefix}Error fetching image details: {e}")
        return

    # OCR Quality Filter & Separation
    resolved_translations = {}
    unmatched_regions = []

    for r in ocr_regions:
        if not should_translate_region(r):
            # Bypass translation for garbage, keep original text
            resolved_translations[r["id"]] = r["text"]
        else:
            unmatched_regions.append(r)

    # Translate unmatched regions
    if unmatched_regions:
        use_vlm_translation = os.environ.get(
            "USE_VLM_TRANSLATION", "false"
        ).lower() in ("true", "1", "t")
        batch_mapping = {}

        provider = os.environ.get("MODEL_PROVIDER", "").lower().strip()
        local_only = provider in ("ollama", "lmstudio")
        max_batch_size = 5 if local_only else 15

        logger.info(
            f"{req_prefix}Batch size set to {max_batch_size} (local_only={local_only})"
        )

        unmatched_chunks = [
            unmatched_regions[i : i + max_batch_size]
            for i in range(0, len(unmatched_regions), max_batch_size)
        ]

        # Download image once if VLM vision translation is enabled
        img_bytes = None
        if use_vlm_translation:
            storage_path = image_info.get("storagePath")
            if storage_path:
                try:
                    response = minio_client.get_object("manga-library", storage_path)
                    img_bytes = response.read()
                except Exception as e:
                    logger.error(
                        f"{req_prefix}Error downloading image from MinIO for VLM pass: {e}"
                    )

        for idx, chunk in enumerate(unmatched_chunks):
            logger.info(
                f"{req_prefix}Processing batch chunk {idx+1}/{len(unmatched_chunks)} ({len(chunk)} regions)..."
            )
            chunk_mapping = None

            # 1. (Optional) VLM vision translation pass
            if use_vlm_translation and img_bytes:
                logger.info(
                    f"{req_prefix}VLM vision translation pass starting for chunk {idx+1}..."
                )
                try:
                    vlm_res = translate_vlm_vision(
                        img_bytes, chunk, TRANSLATION_JSON_SCHEMA, request_id=request_id
                    )
                    chunk_mapping = parse_and_validate_batch(vlm_res, chunk)
                except Exception as e:
                    logger.error(
                        f"{req_prefix}VLM vision translation pass failed for chunk {idx+1}: {e}"
                    )

            # 2. Standard LLM batch translation
            if not chunk_mapping:
                logger.info(
                    f"{req_prefix}Running standard batch translation for chunk {idx+1}..."
                )
                try:
                    batch_res = translate_batch_llm(
                        chunk, TRANSLATION_JSON_SCHEMA, request_id=request_id
                    )
                    chunk_mapping = parse_and_validate_batch(batch_res, chunk)
                except Exception as e:
                    logger.error(
                        f"{req_prefix}Standard batch translation failed for chunk {idx+1}: {e}"
                    )

            if chunk_mapping:
                for rid, trans in chunk_mapping.items():
                    batch_mapping[rid] = trans

        failed_batch_regions = []
        # Validate output for each unmatched region
        for r in unmatched_regions:
            rid = r["id"]
            translated = batch_mapping.get(rid)

            # Run sanity check
            if translated and is_valid_translation(
                r["text"], translated, request_id=request_id
            ):
                resolved_translations[rid] = translated
            else:
                failed_batch_regions.append(r)

        # 3. Retry failed items (hard limit: 1 retry pass = 3 total attempts incl. initial + individual fallback)
        LOCAL_AI_MAX_BATCH_RETRIES = 1  # keep total attempts to 3
        if failed_batch_regions:
            logger.info(f"{req_prefix}Retry pass 1")
            logger.info(
                f"{req_prefix}Retrying {len(failed_batch_regions)} failed items in batch (max {LOCAL_AI_MAX_BATCH_RETRIES} retry pass)..."
            )
            retry_chunks = [
                failed_batch_regions[i : i + max_batch_size]
                for i in range(0, len(failed_batch_regions), max_batch_size)
            ]

            retry_mapping = {}
            for idx, r_chunk in enumerate(retry_chunks):
                logger.info(
                    f"{req_prefix}Processing retry batch chunk {idx+1}/{len(retry_chunks)} ({len(r_chunk)} regions)..."
                )
                r_chunk_mapping = None
                try:
                    retry_res = translate_batch_llm(
                        r_chunk, TRANSLATION_JSON_SCHEMA, request_id=request_id
                    )
                    r_chunk_mapping = parse_and_validate_batch(retry_res, r_chunk)
                except Exception as e:
                    logger.error(
                        f"{req_prefix}Retry batch chunk {idx+1} translation failed: {e}"
                    )
                if r_chunk_mapping:
                    for rid, trans in r_chunk_mapping.items():
                        retry_mapping[rid] = trans

            still_failed_regions = []
            for r in failed_batch_regions:
                rid = r["id"]
                translated = retry_mapping.get(rid)
                if translated and is_valid_translation(
                    r["text"], translated, request_id=request_id
                ):
                    resolved_translations[rid] = translated
                else:
                    still_failed_regions.append(r)

            # 4. Individual fallback (attempt 3/3) for still-failed regions
            if still_failed_regions:
                logger.info(f"{req_prefix}Individual fallback")
                logger.info(
                    f"{req_prefix}Falling back to individual translation for {len(still_failed_regions)} regions (attempt 3/3)..."
                )
                for r in still_failed_regions:
                    rid = r["id"]
                    text = r["text"]
                    lang = r["detectedLanguage"]

                    translated = translate_text(
                        text, source_lang=lang, request_id=request_id
                    )
                    if translated and is_valid_translation(
                        text, translated, request_id=request_id
                    ):
                        resolved_translations[rid] = translated
                    else:
                        logger.warning(
                            f"{req_prefix}Giving up on '{text}' after 3 attempts."
                        )
                        resolved_translations[rid] = None  # failed after 3 attempts

    # Format the final callback response
    translations = []
    for r in ocr_regions:
        rid = r["id"]
        text = r["text"]
        lang = r["detectedLanguage"]

        translated = resolved_translations.get(rid)

        translations.append(
            {
                "regionId": rid,
                "translatedText": translated,
                "translationFailed": (translated is None),
            }
        )
        logger.info(
            f"{req_prefix}Final: '{text}' ({lang}) -> '{translated}' (failed={translated is None})"
        )

    callback_payload = {"imageId": image_id, "translations": translations}
    try:
        res = requests.post(
            f"{CALLBACK_URL}/translation",
            json=callback_payload,
            headers=BACKEND_HEADERS,
        )
        logger.info(f"{req_prefix}Callback status code: {res.status_code}")
    except Exception as e:
        logger.error(f"{req_prefix}Failed to post callback to backend: {e}")


def try_cloud_ocr(img_crop_bytes, provider, api_key, model):
    import base64

    base64_image = base64.b64encode(img_crop_bytes).decode("utf-8")
    prompt = "Respond ONLY with the text shown in this image. Do not add any explanations, notes, or markdown. If there is no text, respond with empty string."

    url = ""
    headers = {}
    payload = {}

    if provider == "openai":
        url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
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
                            },
                        },
                    ],
                }
            ],
        }
    elif provider == "openrouter":
        url = "https://openrouter.ai/api/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
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
                            },
                        },
                    ],
                }
            ],
        }
    elif provider == "gemini":
        gemini_model = model or "gemini-1.5-flash"
        if "/" not in gemini_model:
            gemini_model = f"models/{gemini_model}"
        url = f"https://generativelanguage.googleapis.com/v1beta/{gemini_model}:generateContent?key={api_key}"
        headers = {"Content-Type": "application/json"}
        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {
                            "inlineData": {
                                "mimeType": "image/jpeg",
                                "data": base64_image,
                            }
                        },
                    ]
                }
            ]
        }
    elif provider == "anthropic":
        url = "https://api.anthropic.com/v1/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
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
                                "data": base64_image,
                            },
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
        }
    else:
        return None

    try:
        res = requests.post(url, json=payload, headers=headers, timeout=12)
        if res.status_code == 200:
            res_json = res.json()
            if provider == "gemini":
                return res_json["candidates"][0]["content"]["parts"][0]["text"]
            elif provider == "anthropic":
                return res_json["content"][0]["text"]
            else:
                return res_json["choices"][0]["message"]["content"]
        else:
            print(
                f"[OCR Redo] Cloud OCR error {res.status_code}: {res.text}", flush=True
            )
    except Exception as e:
        print(f"[OCR Redo] Cloud OCR HTTP post failed: {e}", flush=True)
    return None


def perform_redo_ocr(img_crop_bytes, lang):
    provider = (
        os.environ.get("MODEL_PROVIDER", os.environ.get("LLM_PROVIDER", "none"))
        .lower()
        .strip()
    )
    api_key = os.environ.get("API_KEY", os.environ.get("LLM_API_KEY", ""))
    model = os.environ.get("PREFERRED_MODEL", os.environ.get("LLM_MODEL", ""))

    if api_key and provider in ("openai", "openrouter", "gemini", "anthropic"):
        try:
            print(
                f"[OCR Redo] Trying Cloud AI OCR with provider '{provider}'...",
                flush=True,
            )
            text = try_cloud_ocr(img_crop_bytes, provider, api_key, model)
            if text and len(text.strip()) > 0:
                print(f"[OCR Redo] Cloud AI OCR Success: '{text}'", flush=True)
                return text.strip(), 1.0
        except Exception as e:
            print(f"[OCR Redo] Cloud AI OCR failed: {e}", flush=True)

    # Try PP-OCRv5 first — use the lazy-init reader for the region's language
    _redo_paddle_reader = get_paddle_ocr_reader(lang)
    if _redo_paddle_reader is not None:
        try:
            print("[OCR Redo] Trying local PP-OCRv5...", flush=True)
            nparr = np.frombuffer(img_crop_bytes, np.uint8)
            img_crop = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            del nparr
            if img_crop is not None:
                img_crop, _ = downscale_for_ocr(img_crop, max_dim=1024)
                crop_results = _redo_paddle_reader.predict(img_crop)
                del img_crop
                gc.collect()
                parsed_crop_results = parse_paddle_ocr_results(crop_results)
                if parsed_crop_results:
                    text = " ".join([line[1] for line in parsed_crop_results])
                    confidence = float(
                        np.mean([line[2] for line in parsed_crop_results])
                    )
                    print(
                        f"[OCR Redo] PP-OCRv5 Success: '{text}' (conf={confidence})",
                        flush=True,
                    )
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
                print(
                    f"[OCR Redo] Local EasyOCR Success: '{text}' (conf={confidence})",
                    flush=True,
                )
                return text, confidence
        except Exception as e:
            print(f"[OCR Redo] Local EasyOCR failed: {e}", flush=True)

    return "", 0.0


def process_region_redo(job_data):
    image_id = job_data["imageId"]
    region_id = job_data["regionId"]
    redo_type = job_data["redoType"]  # 'ocr' or 'translation'

    # Generate request_id specifically for translation redo tracking
    request_id = str(uuid.uuid4())[:8] if redo_type == "translation" else None
    req_prefix = f"[{request_id}] " if request_id else ""

    if redo_type == "translation":
        logger.info(
            f"{req_prefix}Processing region redo: {region_id} on image {image_id} with type {redo_type}"
        )
    else:
        print(
            f"[Region Redo] Processing region: {region_id} on image {image_id} with type {redo_type}",
            flush=True,
        )

    try:
        backend_url = CALLBACK_URL.replace("/jobs/callback", f"/images/{image_id}")
        res = requests.get(backend_url, headers=BACKEND_HEADERS)
        if res.status_code != 200:
            if redo_type == "translation":
                logger.error(f"{req_prefix}Failed to get image info: {res.status_code}")
            else:
                print(
                    f"[Region Redo] Failed to get image info: {res.status_code}",
                    flush=True,
                )
            return
        image_info = res.json()
        storage_path = image_info["storagePath"]
        ocr_regions = image_info.get("ocrRegions", [])
    except Exception as e:
        if redo_type == "translation":
            logger.error(f"{req_prefix}Error fetching image details: {e}")
        else:
            print(f"[Region Redo] Error fetching image details: {e}", flush=True)
        return

    region = None
    for r in ocr_regions:
        if r["id"] == region_id:
            region = r
            break

    if region is None:
        if redo_type == "translation":
            logger.error(f"{req_prefix}Region {region_id} not found in image details")
        else:
            print(
                f"[Region Redo] Region {region_id} not found in image details",
                flush=True,
            )
        return

    try:
        response = minio_client.get_object("manga-library", storage_path)
        img_bytes = response.read()
    except Exception as e:
        if redo_type == "translation":
            logger.error(f"{req_prefix}Error downloading from MinIO: {e}")
        else:
            print(f"[Region Redo] Error downloading from MinIO: {e}", flush=True)
        return

    callback_payload = {}

    if redo_type == "ocr":
        try:
            nparr = np.frombuffer(img_bytes, np.uint8)
            img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            img_h, img_w = img.shape[:2]

            x, y, width, height = (
                region["bboxX"],
                region["bboxY"],
                region["bboxW"],
                region["bboxH"],
            )
            x1, y1 = max(0, x), max(0, y)
            x2, y2 = min(img_w, x + width), min(img_h, y + height)

            if (x2 - x1) > 0 and (y2 - y1) > 0:
                crop = img[y1:y2, x1:x2]
                is_success, buffer = cv2.imencode(".jpg", crop)
                crop_bytes = buffer.tobytes()

                text, confidence = perform_redo_ocr(
                    crop_bytes, region["detectedLanguage"]
                )
                detected_lang = detect_language(text)
                callback_payload["text"] = text
                callback_payload["confidence"] = confidence
                callback_payload["detectedLanguage"] = detected_lang
                print(
                    f"[Region Redo] Redo OCR success: '{text}' (conf={confidence}, lang={detected_lang})",
                    flush=True,
                )
        except Exception as e:
            print(f"[Region Redo] Redo OCR failed: {e}", flush=True)
            return

    elif redo_type == "translation":
        try:
            text = region["text"]
            lang = region["detectedLanguage"]
            translated = translate_text(text, source_lang=lang, request_id=request_id)
            callback_payload["translatedText"] = translated
            callback_payload["translationFailed"] = translated is None
            logger.info(
                f"{req_prefix}Redo Translation result: '{translated}' (failed={translated is None})"
            )
        except Exception as e:
            logger.error(f"{req_prefix}Redo Translation failed: {e}")
            return

    try:
        callback_url = CALLBACK_URL.replace(
            "/jobs/callback", f"/ocr-regions/{region_id}/callback"
        )
        res = requests.post(
            callback_url, json=callback_payload, headers=BACKEND_HEADERS
        )
        if redo_type == "translation":
            logger.info(f"{req_prefix}Callback status code: {res.status_code}")
        else:
            print(f"[Region Redo] Callback status code: {res.status_code}", flush=True)
    except Exception as e:
        if redo_type == "translation":
            logger.error(f"{req_prefix}Failed to post callback: {e}")
        else:
            print(f"[Region Redo] Failed to post callback: {e}", flush=True)


# --- MAIN RUNNER ---
def main():
    queues = [
        "queue:panel-detection",
        "queue:ocr",
        "queue:layout",
        "queue:translation",
        "queue:render",
        "queue:region-redo",
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
                queue_name = queue_bytes.decode("utf-8")
                job_data = json.loads(job_json)

                if queue_name == "queue:panel-detection":
                    process_panel_detection(job_data)
                elif queue_name == "queue:ocr":
                    process_ocr(job_data)
                elif queue_name == "queue:layout":
                    process_layout(job_data)
                elif queue_name == "queue:translation":
                    process_translation(job_data)
                elif queue_name == "queue:region-redo":
                    process_region_redo(job_data)
                elif queue_name == "queue:render":
                    process_stub(job_data, "render")
        except Exception as e:
            print(f"[Unified Worker] Error in main loop: {e}", flush=True)
            time.sleep(1)


if __name__ == "__main__":
    main()
