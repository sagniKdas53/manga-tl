#!/usr/bin/env python3
"""
test_translation.py — Interactive translation test script for manga-library.

Tests the translation pipeline using the exact prompts and JSON schema from
the worker's translate_batch_llm() function. Supports multiple providers
and can consume OCR JSON output from benchmark_local_ocr.py as input.

Usage:
    python test_translation.py --provider openrouter
    python test_translation.py --provider nvidia --model nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
    python test_translation.py --provider openrouter --input ocr_results_paddleocr_v6_server.json
    python test_translation.py --provider cloudflare --source-lang ja --target-lang en
"""

import os
import sys
import json
import time
import uuid
import argparse
import requests

# ---------------------------------------------------------------------------
# Env loader — reads ../../.env relative to this script
# ---------------------------------------------------------------------------
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

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
load_env(os.path.join(SCRIPT_DIR, '..', '.env'))

# ---------------------------------------------------------------------------
# EXACT prompts and schema copied from worker/src/worker/services/translation.py
# ---------------------------------------------------------------------------

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
                    "translationNotes": {"type": "string"},
                    "emotion": {"type": "string"},
                    "tone": {"type": "string"},
                    "translationScore": {
                        "type": "number",
                        "minimum": 0.0,
                        "maximum": 1.0,
                    },
                },
                "required": ["id", "translation"],
            },
        }
    },
    "required": ["translations"],
}

MANGA_TRANSLATION_JSON_SYSTEM_PROMPT = """You are an expert manga translator.
Translate the list of manga text regions into natural English.
These regions appear in reading order. Maintain context, tone, emotion, and relationships between speakers.
Ensure consistent character names across the chapter. Maintain a consistent tone and emotion, matching the context of previous dialogue.
Inject necessary context naturally into the translation when handling ambiguous Japanese pronouns or subjects.

Region type handling:
- "speech": Translate as natural dialogue.
- "narration": Translate as third-person narrative prose.
- "sfx": Transliterate the sound effect AND provide an English equivalent in parentheses (e.g. "DOKAA (WHAM)").
- "caption": Translate as editorial/scene-setting text.
- "sign": Translate literally, noting it's environmental text.

If multiple regions share the same conversationGroup, treat them as a continuous dialogue exchange and ensure coherent flow.

NEVER include romanized text, pinyin, romaji, or pronunciation guides. Return ONLY the target-language translation.
BAD: "Yào chūfā le o (About to depart!)"
GOOD: "About to depart!"
BAD: "ERUFU (ELF!)"
GOOD: "ELF!"

Return ONLY valid JSON format conforming to the requested schema. No conversational prefix, suffix, or markdown formatting."""

LANG_MAP = {
    "ja": "Japanese",
    "en": "English",
    "ko": "Korean",
    "zh-tw": "Traditional Chinese",
    "zh-cn": "Simplified Chinese",
    "zh": "Chinese",
    "auto": "Auto-Detect",
}

def build_batch_prompt(regions, context_str="", source_lang="ja", target_lang="en"):
    """Build the exact user prompt used by translate_batch_llm()."""
    bubbles_input = []
    for r in regions:
        entry = {
            "id": r.get("id", str(uuid.uuid4())[:8]),
            "panel": r.get("panelReadingOrder") or r.get("panel") or 0,
            "bubble": r.get("bubbleReadingOrder") or r.get("bubble") or 0,
            "speaker": r.get("speakerLabel") or r.get("speaker") or None,
            "regionType": r.get("regionType") or "speech",
            "conversationGroup": r.get("conversationId") or r.get("conversationGroup") or None,
            "text": r.get("text", ""),
        }
        if r.get("qaStatus") == "failed" and r.get("qaFeedback"):
            entry["previousTranslation"] = r.get("translatedText")
            entry["qaFeedback"] = r.get("qaFeedback")
        bubbles_input.append(entry)

    bubbles_json = json.dumps(bubbles_input, ensure_ascii=False, indent=2)

    src_name = LANG_MAP.get(source_lang.lower(), source_lang)
    tgt_name = LANG_MAP.get(target_lang.lower(), target_lang)

    prompt = f"""{context_str}These text regions appear in reading order.
Each region has a "regionType" field indicating its category (speech/narration/sfx/caption/sign).
Regions with the same "conversationGroup" are part of the same dialogue exchange.
Translate each region from {src_name} to natural {tgt_name} according to its type and maintain conversational coherence within groups.

Preserve:
- tone
- emotional state
- relationships
- ongoing conversation

Region type handling:
- "speech": Translate as natural dialogue.
- "narration": Translate as third-person narrative prose.
- "sfx": Transliterate the sound effect AND provide a {tgt_name} equivalent in parentheses (e.g. "DOKAA (WHAM)").
- "caption": Translate as editorial/scene-setting text.
- "sign": Translate literally, noting it's environmental text.

If multiple regions share the same conversationGroup, treat them as a continuous dialogue exchange and ensure coherent flow.

NEVER include romanized text, pinyin, romaji, or pronunciation guides. Return ONLY the target-language translation.
BAD: "Yào chūfā le o (About to depart!)"
GOOD: "About to depart!"
BAD: "ERUFU (ELF!)"
GOOD: "ELF!"

If a region has "previousTranslation" and "qaFeedback" fields, it means the previous translation attempt failed QA (e.g. text overflow, poor phrasing, or formatting issues). Adjust your translation accordingly based on the feedback (for example, shortening the text to fit if it overflowed).

You MUST return a JSON object containing a "translations" key with an array of objects.
Each object in the array MUST have the following keys:
- "id" (the original string ID)
- "translation" (your {tgt_name} translation)
- "translationNotes" (brief explanation of translation decisions or register choices)
- "emotion" (detected speaker emotion, e.g. "earnest", "angry", "playful")
- "tone" (detected tone, e.g. "formal", "sarcastic", "casual")
- "translationScore" (a self-evaluation score from 0.0 to 1.0 representing translation quality/confidence)

Example structure:
{{
  "translations": [
    {{
      "id": "some-id-1",
      "translation": "Translated text here",
      "translationNotes": "Preserved informal/teasing tone",
      "emotion": "playful",
      "tone": "casual",
      "translationScore": 0.95
    }}
  ]
}}

Return ONLY valid JSON format conforming to the requested schema. No conversational prefix, suffix, or markdown formatting.

Input:
{bubbles_json}
"""
    return prompt

# ---------------------------------------------------------------------------
# Provider configurations
# ---------------------------------------------------------------------------
PROVIDER_CONFIGS = {
    "openrouter": {
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "key_env": "OPENROUTER_API_KEY",
        "default_model": "deepseek/deepseek-v4-pro",
        "extra_headers": {"HTTP-Referer": "https://manga-library"},
        "free": False,
    },
    "cloudflare": {
        # URL is dynamically built using CLOUDFLARE_ACCOUNT_ID
        "url_template": "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions",
        "key_env": "CLOUDFLARE_API_TOKEN",
        "account_env": "CLOUDFLARE_ACCOUNT_ID",
        "default_model": "@cf/openai/gpt-oss-120b",
        "extra_headers": {},
        "free": True,
    },
    "neurometric": {
        "url": "https://api.neurometric.ai/v1/chat/completions",
        "key_env": "NEUROMETRIC_API_KEY",
        "default_model": "neurometric/clawpack",
        "extra_headers": {},
        "free": True,
    },
    "nvidia": {
        "url": "https://integrate.api.nvidia.com/v1/chat/completions",
        "key_env": "NVIDIA_API_KEY",
        "default_model": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
        "extra_headers": {},
        "free": True,
    },
}

# ---------------------------------------------------------------------------
# Default test regions (used when no --input file is provided)
# ---------------------------------------------------------------------------
DEFAULT_TEST_REGIONS = [
    {
        "id": "93b46505-541e-47c9-b44d-f7e2563a477e",
        "panel": 1,
        "bubble": 2,
        "speaker": None,
        "regionType": "sfx",
        "conversationGroup": None,
        "text": "さす",
    },
    {
        "id": "1fc84410-d20a-4453-b5a0-1ee061a914fb",
        "panel": 1,
        "bubble": 3,
        "speaker": None,
        "regionType": "sign",
        "conversationGroup": None,
        "text": "さ苏",
    },
    {
        "id": "c24cd5a8-112a-4a8e-a7a1-4334c32a5b8e",
        "panel": 1,
        "bubble": 1,
        "speaker": None,
        "regionType": "speech",
        "conversationGroup": None,
        "text": "一緒に浴びましょうよー洗ってあげますからぁ",
    },
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def build_request(provider_name, cfg, model, regions, source_lang, target_lang):
    """Build the full HTTP request payload."""
    prompt = build_batch_prompt(regions, source_lang=source_lang, target_lang=target_lang)

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": MANGA_TRANSLATION_JSON_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "structured_output",
                "schema": TRANSLATION_JSON_SCHEMA,
                "strict": True,
            },
        },
    }

    # Cloudflare doesn't support json_schema, downgrade to json_object
    if provider_name == "cloudflare":
        payload["response_format"] = {"type": "json_object"}

    return payload

def get_provider_url(provider_name, cfg):
    if provider_name == "cloudflare":
        account_id = os.environ.get(cfg.get("account_env", "CLOUDFLARE_ACCOUNT_ID"), "")
        if not account_id:
            print(f"[ERROR] {cfg['account_env']} not set.")
            sys.exit(1)
        return cfg["url_template"].format(account_id=account_id)
    return cfg["url"]

def validate_response(data):
    """Validate the JSON response matches TRANSLATION_JSON_SCHEMA basics."""
    if not isinstance(data, dict):
        return False, "Response is not a JSON object"
    translations = data.get("translations")
    if not isinstance(translations, list):
        return False, f"Missing 'translations' array, got: {type(translations)}"
    for i, item in enumerate(translations):
        if not isinstance(item, dict):
            return False, f"translations[{i}] is not an object"
        if "id" not in item:
            return False, f"translations[{i}] missing 'id'"
        if "translation" not in item:
            return False, f"translations[{i}] missing 'translation'"
    return True, f"OK ({len(translations)} translations)"

def load_ocr_json(path):
    """Load OCR results JSON (output from benchmark_local_ocr.py) and convert to regions."""
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    regions = []
    raw_regions = data.get("regions", [])
    for i, r in enumerate(raw_regions):
        text = r.get("text", "").strip()
        if not text:
            continue
        regions.append({
            "id": f"ocr_{i:04d}",
            "panel": 1,
            "bubble": i + 1,
            "speaker": None,
            "regionType": "speech",
            "conversationGroup": None,
            "text": text,
        })
    return regions, data.get("engine", "unknown"), data.get("image", "unknown")

def print_result(result, elapsed):
    """Pretty-print the translation result."""
    print(f"\n{'─' * 60}")
    print(f"  Response received in {elapsed:.2f}s")
    print(f"{'─' * 60}")
    translations = result.get("translations", [])
    for item in translations:
        print(f"\n  [{item.get('id', '?')}]")
        print(f"    Translation : {item.get('translation', '')}")
        if item.get('translationNotes'):
            print(f"    Notes       : {item.get('translationNotes')}")
        if item.get('emotion'):
            print(f"    Emotion     : {item.get('emotion')}")
        if item.get('tone'):
            print(f"    Tone        : {item.get('tone')}")
        score = item.get('translationScore')
        if score is not None:
            print(f"    Score       : {score:.2f}")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Test translation pipeline using exact worker prompts",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Test with hardcoded sample data
  python test_translation.py --provider openrouter
  python test_translation.py --provider nvidia

  # Test with OCR output from benchmark_local_ocr.py (pipeline test)
  python test_translation.py --provider openrouter --input ocr_results_paddleocr_v6_server.json

  # Override model
  python test_translation.py --provider cloudflare --model @cf/openai/gpt-oss-120b

  # Specify language pair
  python test_translation.py --provider neurometric --source-lang ja --target-lang en
        """
    )
    parser.add_argument(
        "--provider",
        choices=list(PROVIDER_CONFIGS.keys()),
        required=True,
        help="API provider to use"
    )
    parser.add_argument("--model", help="Override the default model for the provider")
    parser.add_argument("--input", help="Path to OCR results JSON (output from benchmark_local_ocr.py)")
    parser.add_argument("--source-lang", default="ja", help="Source language code (default: ja)")
    parser.add_argument("--target-lang", default="en", help="Target language code (default: en)")
    parser.add_argument("--verbose", action="store_true", help="Print raw request payload and response")
    args = parser.parse_args()

    cfg = PROVIDER_CONFIGS[args.provider]
    model = args.model or cfg["default_model"]

    # Resolve API key
    api_key = os.environ.get(cfg["key_env"], "")
    if not api_key:
        print(f"[ERROR] {cfg['key_env']} not set in environment or .env file.")
        sys.exit(1)

    # Load regions
    if args.input:
        print(f"[INFO] Loading OCR results from: {args.input}")
        regions, engine_name, image_name = load_ocr_json(args.input)
        if not regions:
            print("[ERROR] No non-empty text regions found in OCR JSON.")
            sys.exit(1)
        print(f"[INFO] Loaded {len(regions)} regions from engine={engine_name}, image={image_name}")
    else:
        print("[INFO] Using hardcoded sample test regions")
        regions = DEFAULT_TEST_REGIONS

    # Build request
    url = get_provider_url(args.provider, cfg)
    payload = build_request(args.provider, cfg, model, regions, args.source_lang, args.target_lang)

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    for k, v in cfg.get("extra_headers", {}).items():
        headers[k] = v

    free_label = "[FREE]" if cfg.get("free") else "[PAID]"
    print(f"\n{'=' * 60}")
    print(f"  Provider  : {args.provider.upper()} {free_label}")
    print(f"  Model     : {model}")
    print(f"  URL       : {url}")
    print(f"  Regions   : {len(regions)}")
    print(f"  Lang      : {args.source_lang} → {args.target_lang}")
    print(f"{'=' * 60}")

    if args.verbose:
        print("\n[VERBOSE] Request payload:")
        print(json.dumps(payload, ensure_ascii=False, indent=2))

    # Send request
    t0 = time.time()
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=60)
        resp.raise_for_status()
        data = resp.json()
    except requests.HTTPError as e:
        print(f"\n[ERROR] HTTP {resp.status_code}: {resp.text}")
        sys.exit(1)
    except Exception as e:
        print(f"\n[ERROR] Request failed: {e}")
        sys.exit(1)
    elapsed = time.time() - t0

    # Extract content
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    usage = data.get("usage", {})
    prompt_tokens = usage.get("prompt_tokens", 0)
    completion_tokens = usage.get("completion_tokens", 0)

    if args.verbose:
        print("\n[VERBOSE] Raw response:")
        print(json.dumps(data, ensure_ascii=False, indent=2))

    # Parse JSON content
    content = content.strip()
    if content.startswith("```"):
        lines = content.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        content = "\n".join(lines).strip()

    try:
        result = json.loads(content)
    except json.JSONDecodeError as e:
        print(f"\n[ERROR] Failed to parse JSON response: {e}")
        print(f"Raw content: {content}")
        sys.exit(1)

    # Validate schema
    valid, reason = validate_response(result)
    status = "✓ VALID" if valid else "✗ INVALID"
    print(f"\n  Schema validation: {status} — {reason}")

    # Print tokens
    print(f"  Tokens: {prompt_tokens} in, {completion_tokens} out")

    # Print results
    print_result(result, elapsed)

    # Save output JSON
    out_filename = f"tl_output_{args.provider}_{model.replace('/', '_').replace(':', '_')}.json"
    with open(out_filename, "w", encoding="utf-8") as f:
        json.dump({
            "provider": args.provider,
            "model": model,
            "source_lang": args.source_lang,
            "target_lang": args.target_lang,
            "elapsed_s": round(elapsed, 3),
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "input_regions": regions,
            "result": result,
        }, f, ensure_ascii=False, indent=2)
    print(f"\n  Saved output to: {out_filename}")


if __name__ == "__main__":
    main()
