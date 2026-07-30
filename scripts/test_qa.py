#!/usr/bin/env python3
"""
test_qa.py — Interactive LLM QA test script for manga-library.

Tests the QA pipeline using the exact prompt and JSON schema from
the worker's _process_qa_llm() function. Supports multiple providers.

Usage:
    python test_qa.py --provider openrouter
    python test_qa.py --provider nvidia --model nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
    python test_qa.py --provider openrouter --input tl_output_openrouter_deepseek.json
"""

import os
import sys
import json
import time
import argparse
import requests

# ---------------------------------------------------------------------------
# Env loader
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
# EXACT QA schema and prompt from worker/src/worker/handlers/qa.py
# ---------------------------------------------------------------------------

QA_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "regionId": {"type": "string"},
                    "qaStatus": {
                        "type": "string",
                        "enum": ["passed", "failed", "direct_fix", "reject_sfx"],
                    },
                    "qaScore": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                    "qaFeedback": {"type": "string"},
                    "directFix": {
                        "type": "object",
                        "properties": {
                            "correctedText": {"type": "string"},
                            "suggestedFontSize": {"type": "number"},
                        },
                    },
                    "escalation": {
                        "type": "object",
                        "properties": {
                            "ocrBad": {"type": "boolean"},
                            "correctedSourceText": {"type": "string"},
                            "needsReOcr": {"type": "boolean"},
                            "needsManualIntervention": {"type": "boolean"},
                            "orderBad": {"type": "boolean"},
                            "suggestedReadingOrderIndex": {"type": "number"},
                        },
                    },
                },
                "required": ["regionId", "qaStatus", "qaScore", "qaFeedback"],
            },
        }
    },
    "required": ["results"],
}

def build_qa_prompt(regions_metadata):
    """Build the exact QA LLM prompt from _process_qa_llm()."""
    return f"""You are an expert bilingual Japanese-to-English manga translator and QA reviewer.
Your job is to evaluate translation quality and conversation flow based on text-only metadata.

For each region in the provided metadata, evaluate and check if:
1. The English translation is accurate, natural, and contextually appropriate compared to the original Japanese OCR text.
2. The conversation flow between dialogue regions feels coherent.
3. The original Japanese OCR transcription was bad/inaccurate:
   - If you can deduce the correct text, flag with ocrBad=true and provide correctedSourceText.
   - If the OCR text is garbage (like misread sound effects) and you CANNOT deduce it, flag needsReOcr=true.
   - If the region is completely unfixable or obscured, flag needsManualIntervention=true.
4. The reading order/bubble sequence is incorrect (flag with orderBad=true and provide suggestedReadingOrderIndex).

Status categories:
- "passed": No correction needed. You MUST still provide a detailed explanation/reasoning in "qaFeedback" explaining why the region passed.
- "direct_fix": If you have a better translation, output it directly. You must supply "directFix" object with correctedText. You MUST also provide detailed reasoning in "qaFeedback".
- "reject_sfx": If the region is a sound effect (SFX) or gibberish that shouldn't be translated, set this status (downstream will hide the element).
- "failed": Translation error requiring a translation re-run. Specify "qaFeedback" with detailed correction notes/feedback to guide the re-translation. Your output must be strictly better. Do not send back the exact same text if flagging an error.

IMPORTANT: For EVERY region (including "passed" regions), you MUST provide a detailed explanation/reasoning in "qaFeedback" explaining your evaluation.

Region Metadata:
{json.dumps(regions_metadata, ensure_ascii=False, indent=2)}

You MUST return a JSON object containing a "results" key with an array of objects conforming to the requested schema. No other text."""

# ---------------------------------------------------------------------------
# Provider configurations
# ---------------------------------------------------------------------------
PROVIDER_CONFIGS = {
    "openrouter": {
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "key_env": "OPENROUTER_API_KEY",
        "default_model": "deepseek/deepseek-v4-flash",
        "extra_headers": {"HTTP-Referer": "https://manga-library"},
        "free": False,
    },
    "cloudflare": {
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
# Default sample QA test data (OCR text + translations from previous runs)
# These match the test regions in test_translation.py
# ---------------------------------------------------------------------------
DEFAULT_QA_REGIONS = [
    {
        "regionId": "93b46505-541e-47c9-b44d-f7e2563a477e",
        "ocrText": "さす",
        "ocrScore": 0.82,
        "translatedText": "SASU (PIERCE)",
        "translationScore": 0.78,
        "readingOrder": 2,
    },
    {
        "regionId": "1fc84410-d20a-4453-b5a0-1ee061a914fb",
        "ocrText": "さ苏",
        "ocrScore": 0.61,
        "translatedText": "[Environmental text: uncertain reading]",
        "translationScore": 0.55,
        "readingOrder": 3,
    },
    {
        "regionId": "c24cd5a8-112a-4a8e-a7a1-4334c32a5b8e",
        "ocrText": "一緒に浴びましょうよー洗ってあげますからぁ",
        "ocrScore": 0.97,
        "translatedText": "Come on, let's take a bath together— I'll wash you!",
        "translationScore": 0.95,
        "readingOrder": 1,
    },
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_provider_url(provider_name, cfg):
    if provider_name == "cloudflare":
        account_id = os.environ.get(cfg.get("account_env", "CLOUDFLARE_ACCOUNT_ID"), "")
        if not account_id:
            print(f"[ERROR] {cfg['account_env']} not set.")
            sys.exit(1)
        return cfg["url_template"].format(account_id=account_id)
    return cfg["url"]

def validate_qa_response(data):
    """Validate QA JSON response against QA_JSON_SCHEMA basics."""
    if not isinstance(data, dict):
        return False, "Response is not a JSON object"
    results = data.get("results")
    if not isinstance(results, list):
        return False, f"Missing 'results' array, got: {type(results)}"
    valid_statuses = {"passed", "failed", "direct_fix", "reject_sfx"}
    for i, item in enumerate(results):
        if not isinstance(item, dict):
            return False, f"results[{i}] is not an object"
        for required in ["regionId", "qaStatus", "qaScore", "qaFeedback"]:
            if required not in item:
                return False, f"results[{i}] missing '{required}'"
        if item.get("qaStatus") not in valid_statuses:
            return False, f"results[{i}] invalid qaStatus='{item.get('qaStatus')}'"
    return True, f"OK ({len(results)} results)"

def load_translation_output(path):
    """Load test_translation.py output JSON and convert to QA metadata."""
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    regions_metadata = []
    input_regions = data.get("input_regions", [])
    result = data.get("result", {})
    translations = {t["id"]: t for t in result.get("translations", [])}

    for i, r in enumerate(input_regions):
        rid = r.get("id", f"region_{i}")
        tl = translations.get(rid, {})
        regions_metadata.append({
            "regionId": rid,
            "ocrText": r.get("text", ""),
            "ocrScore": r.get("confidence", 1.0),
            "translatedText": tl.get("translation", ""),
            "translationScore": tl.get("translationScore", 1.0),
            "readingOrder": r.get("bubble", i),
        })
    return regions_metadata

def print_qa_results(results, elapsed):
    """Pretty-print QA evaluation results."""
    STATUS_ICONS = {
        "passed": "✓",
        "failed": "✗",
        "direct_fix": "✎",
        "reject_sfx": "⊘",
    }
    print(f"\n{'─' * 60}")
    print(f"  QA Response received in {elapsed:.2f}s")
    print(f"{'─' * 60}")
    for item in results:
        status = item.get("qaStatus", "?")
        icon = STATUS_ICONS.get(status, "?")
        score = item.get("qaScore", 0.0)
        print(f"\n  {icon} [{item.get('regionId', '?')}]  status={status}  score={score:.2f}")
        feedback = item.get("qaFeedback", "")
        if feedback:
            # Wrap long feedback
            for line in feedback.split(". "):
                if line:
                    print(f"    {line.strip()}.")
        if status == "direct_fix" and item.get("directFix"):
            fix = item["directFix"]
            if fix.get("correctedText"):
                print(f"    → Corrected: {fix['correctedText']}")
            if fix.get("suggestedFontSize"):
                print(f"    → Font size: {fix['suggestedFontSize']}")
        if item.get("escalation"):
            esc = item["escalation"]
            if esc.get("ocrBad"):
                print(f"    ⚠ OCR BAD — corrected: {esc.get('correctedSourceText', '')}")
            if esc.get("needsReOcr"):
                print(f"    ⚠ NEEDS RE-OCR")
            if esc.get("orderBad"):
                print(f"    ⚠ ORDER BAD — suggested index: {esc.get('suggestedReadingOrderIndex')}")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Test QA pipeline using exact worker prompts",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Test with hardcoded sample OCR + translation data
  python test_qa.py --provider openrouter
  python test_qa.py --provider nvidia

  # Test with translation output from test_translation.py (pipeline test)
  python test_qa.py --provider openrouter --input tl_output_openrouter_deepseek_deepseek-v4-pro.json

  # Override model
  python test_qa.py --provider cloudflare --model @cf/openai/gpt-oss-120b
        """
    )
    parser.add_argument(
        "--provider",
        choices=list(PROVIDER_CONFIGS.keys()),
        required=True,
        help="API provider to use"
    )
    parser.add_argument("--model", help="Override the default model for the provider")
    parser.add_argument(
        "--input",
        help="Path to translation output JSON (from test_translation.py) or custom QA input JSON"
    )
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
        print(f"[INFO] Loading QA input from: {args.input}")
        try:
            # Try loading as test_translation.py output first
            regions_metadata = load_translation_output(args.input)
            if not regions_metadata:
                # Fall back to treating it as raw QA metadata JSON
                with open(args.input, 'r', encoding='utf-8') as f:
                    raw = json.load(f)
                regions_metadata = raw if isinstance(raw, list) else raw.get("regions", [])
        except Exception as e:
            print(f"[ERROR] Failed to load input file: {e}")
            sys.exit(1)
        print(f"[INFO] Loaded {len(regions_metadata)} regions for QA")
    else:
        print("[INFO] Using hardcoded sample QA test data")
        regions_metadata = DEFAULT_QA_REGIONS

    # Build prompt
    prompt = build_qa_prompt(regions_metadata)

    # Build payload
    payload = {
        "model": model,
        "messages": [
            {"role": "user", "content": prompt},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "structured_output",
                "schema": QA_JSON_SCHEMA,
                "strict": True,
            },
        },
    }

    # Cloudflare doesn't support json_schema
    if args.provider == "cloudflare":
        payload["response_format"] = {"type": "json_object"}

    url = get_provider_url(args.provider, cfg)
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
    print(f"  Regions   : {len(regions_metadata)}")
    print(f"{'=' * 60}")

    if args.verbose:
        print("\n[VERBOSE] Request payload:")
        print(json.dumps(payload, ensure_ascii=False, indent=2))

    # Send request
    t0 = time.time()
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=90)
        resp.raise_for_status()
        data = resp.json()
    except requests.HTTPError as e:
        print(f"\n[ERROR] HTTP {resp.status_code}: {resp.text}")
        sys.exit(1)
    except Exception as e:
        print(f"\n[ERROR] Request failed: {e}")
        sys.exit(1)
    elapsed = time.time() - t0

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
    valid, reason = validate_qa_response(result)
    status_str = "✓ VALID" if valid else "✗ INVALID"
    print(f"\n  Schema validation: {status_str} — {reason}")
    print(f"  Tokens: {prompt_tokens} in, {completion_tokens} out")

    # Print results
    qa_results = result.get("results", [])
    print_qa_results(qa_results, elapsed)

    # Summary stats
    passed = sum(1 for r in qa_results if r.get("qaStatus") == "passed")
    failed = sum(1 for r in qa_results if r.get("qaStatus") == "failed")
    direct_fix = sum(1 for r in qa_results if r.get("qaStatus") == "direct_fix")
    reject_sfx = sum(1 for r in qa_results if r.get("qaStatus") == "reject_sfx")

    print(f"\n{'─' * 60}")
    print(f"  Summary: {passed} passed | {failed} failed | {direct_fix} direct_fix | {reject_sfx} reject_sfx")
    if qa_results:
        avg_score = sum(r.get("qaScore", 0.0) for r in qa_results) / len(qa_results)
        print(f"  Avg QA Score: {avg_score:.2f}")

    # Save output JSON
    safe_model = model.replace('/', '_').replace(':', '_')
    out_filename = f"qa_output_{args.provider}_{safe_model}.json"
    with open(out_filename, "w", encoding="utf-8") as f:
        json.dump({
            "provider": args.provider,
            "model": model,
            "elapsed_s": round(elapsed, 3),
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "input_regions": regions_metadata,
            "result": result,
        }, f, ensure_ascii=False, indent=2)
    print(f"\n  Saved output to: {out_filename}")


if __name__ == "__main__":
    main()
