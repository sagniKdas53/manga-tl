#!/usr/bin/env python3
"""
benchmark_free_translation.py — Test manga-translation quality/latency/structured-I-O
support across every free chat-capable model on OpenRouter, using the exact prompt,
system message, and JSON schema the worker's translate_batch_llm() uses.

Reuses build_batch_prompt / MANGA_TRANSLATION_JSON_SYSTEM_PROMPT / TRANSLATION_JSON_SCHEMA
/ validate_response from test_translation.py so results are directly comparable to the
paid-provider path already exercised by that script.

For each model we try, in order, until one succeeds:
  1. response_format: json_schema (strict)   -> "json_schema"
  2. response_format: json_object             -> "json_object"
  3. no response_format (prompt-only JSON)     -> "none"
This measures actual structured-output support empirically rather than trusting
OpenRouter's self-reported `supported_parameters` list.

Usage:
    python scripts/benchmark_free_translation.py --regions <regions.json> --out-dir <dir>
"""

import os
import sys
import json
import time
import argparse
import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from test_translation import (  # noqa: E402
    load_env,
    build_batch_prompt,
    MANGA_TRANSLATION_JSON_SYSTEM_PROMPT,
    TRANSLATION_JSON_SCHEMA,
    validate_response,
)

load_env(os.path.join(SCRIPT_DIR, "..", ".env"))

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# All 14 free chat-capable models on OpenRouter as of 2026-08-05 (queried live from
# GET /api/v1/models, filtered to id.endswith(':free')). declared_structured_output
# reflects whether OpenRouter lists 'response_format'/'structured_outputs' in
# supported_parameters for that model.
FREE_MODELS = [
    {"id": "google/gemma-4-26b-a4b-it:free", "declared_structured_output": True, "declared_vision": True},
    {"id": "google/gemma-4-31b-it:free", "declared_structured_output": True, "declared_vision": True},
    {"id": "nvidia/nemotron-3-super-120b-a12b:free", "declared_structured_output": True, "declared_vision": False},
    {"id": "nvidia/nemotron-nano-9b-v2:free", "declared_structured_output": True, "declared_vision": False},
    {"id": "openai/gpt-oss-20b:free", "declared_structured_output": True, "declared_vision": False},
    {"id": "nvidia/nemotron-3-ultra-550b-a55b:free", "declared_structured_output": False, "declared_vision": False},
    {"id": "nvidia/nemotron-3-nano-30b-a3b:free", "declared_structured_output": False, "declared_vision": False},
    {"id": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "declared_structured_output": False, "declared_vision": True},
    {"id": "nvidia/nemotron-nano-12b-v2-vl:free", "declared_structured_output": False, "declared_vision": True},
    {"id": "nvidia/nemotron-3.5-content-safety:free", "declared_structured_output": False, "declared_vision": True},
    {"id": "inclusionai/ling-3.0-flash:free", "declared_structured_output": False, "declared_vision": False},
    {"id": "poolside/laguna-s-2.1:free", "declared_structured_output": False, "declared_vision": False},
    {"id": "poolside/laguna-xs-2.1:free", "declared_structured_output": False, "declared_vision": False},
    {"id": "cohere/north-mini-code:free", "declared_structured_output": False, "declared_vision": False},
]


def strip_fences(content):
    content = content.strip()
    if content.startswith("```"):
        lines = content.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        content = "\n".join(lines).strip()
    return content


def check_id_fidelity(result, expected_ids):
    """Structured-INPUT fidelity: did the model correctly echo every input id, no
    drops, no duplicates, no hallucinated extras?"""
    translations = result.get("translations", []) if isinstance(result, dict) else []
    got_ids = [t.get("id") for t in translations if isinstance(t, dict)]
    got_set = set(got_ids)
    expected_set = set(expected_ids)
    missing = sorted(expected_set - got_set)
    extra = sorted(got_set - expected_set)
    duplicates = sorted({i for i in got_ids if got_ids.count(i) > 1})
    return {
        "missing": missing,
        "extra": extra,
        "duplicates": duplicates,
        "perfect": not missing and not extra and not duplicates,
    }


def build_payload(model_id, regions, mode, source_lang, target_lang):
    prompt = build_batch_prompt(regions, source_lang=source_lang, target_lang=target_lang)
    payload = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": MANGA_TRANSLATION_JSON_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
    }
    if mode == "json_schema":
        payload["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": "structured_output",
                "schema": TRANSLATION_JSON_SCHEMA,
                "strict": True,
            },
        }
    elif mode == "json_object":
        payload["response_format"] = {"type": "json_object"}
    return payload


def call_openrouter(api_key, payload, timeout=90):
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "HTTP-Referer": "https://manga-library",
    }
    t0 = time.time()
    try:
        resp = requests.post(OPENROUTER_URL, headers=headers, json=payload, timeout=timeout)
        elapsed = time.time() - t0
        return resp, elapsed, None
    except Exception as e:
        elapsed = time.time() - t0
        return None, elapsed, str(e)


def try_model(api_key, model_id, regions, source_lang, target_lang, retries=2):
    expected_ids = [r["id"] for r in regions]
    attempts_log = []

    for mode in ("json_schema", "json_object", "none"):
        payload = build_payload(model_id, regions, mode, source_lang, target_lang)

        for attempt_num in range(retries + 1):
            resp, elapsed, net_err = call_openrouter(api_key, payload)

            if net_err is not None:
                attempts_log.append({"mode": mode, "attempt": attempt_num, "error": f"network: {net_err}", "elapsed_s": elapsed})
                continue

            if resp.status_code == 429:
                attempts_log.append({"mode": mode, "attempt": attempt_num, "error": "rate_limited (429)", "elapsed_s": elapsed})
                time.sleep(5 * (attempt_num + 1))
                continue

            if resp.status_code != 200:
                body = resp.text[:500]
                attempts_log.append({"mode": mode, "attempt": attempt_num, "error": f"http_{resp.status_code}: {body}", "elapsed_s": elapsed})
                # A 400 for an unsupported response_format is expected -> move to next mode.
                break

            data = resp.json()
            choice = (data.get("choices") or [{}])[0]
            message = choice.get("message", {}) or {}
            content = message.get("content", "") or ""
            usage = data.get("usage", {}) or {}

            if not content.strip():
                attempts_log.append({"mode": mode, "attempt": attempt_num, "error": "empty_content", "elapsed_s": elapsed, "raw_message": message})
                break

            cleaned = strip_fences(content)
            try:
                result = json.loads(cleaned)
            except json.JSONDecodeError as e:
                attempts_log.append({
                    "mode": mode, "attempt": attempt_num,
                    "error": f"json_decode_error: {e}",
                    "elapsed_s": elapsed, "raw_content": content,
                })
                break

            valid, reason = validate_response(result)
            fidelity = check_id_fidelity(result, expected_ids)

            return {
                "model": model_id,
                "status": "ok",
                "mode_used": mode,
                "elapsed_s": round(elapsed, 3),
                "schema_valid": valid,
                "schema_reason": reason,
                "id_fidelity": fidelity,
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
                "raw_content": content,
                "result": result,
                "attempts_log": attempts_log,
            }

    return {
        "model": model_id,
        "status": "failed",
        "mode_used": None,
        "elapsed_s": None,
        "attempts_log": attempts_log,
    }


def main():
    parser = argparse.ArgumentParser(description="Benchmark free OpenRouter models on manga translation")
    parser.add_argument("--regions", required=True, help="Path to regions.json")
    parser.add_argument("--out-dir", required=True, help="Directory to write per-model result JSON + summary")
    parser.add_argument("--source-lang", default="ja")
    parser.add_argument("--target-lang", default="en")
    parser.add_argument("--model", help="Only run this specific model id")
    parser.add_argument("--sleep", type=float, default=2.0, help="Seconds to sleep between models (free-tier rate limits)")
    args = parser.parse_args()

    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        print("[ERROR] OPENROUTER_API_KEY not set.")
        sys.exit(1)

    with open(args.regions, "r", encoding="utf-8") as f:
        regions = json.load(f)

    os.makedirs(args.out_dir, exist_ok=True)

    models = FREE_MODELS
    if args.model:
        models = [m for m in FREE_MODELS if m["id"] == args.model]
        if not models:
            print(f"[ERROR] Unknown model {args.model}")
            sys.exit(1)

    summary = []
    for i, m in enumerate(models):
        model_id = m["id"]
        print(f"\n{'=' * 70}")
        print(f"[{i+1}/{len(models)}] {model_id}")
        print(f"{'=' * 70}")

        result = try_model(api_key, model_id, regions, args.source_lang, args.target_lang)
        result["declared_structured_output"] = m["declared_structured_output"]
        result["declared_vision"] = m["declared_vision"]

        if result["status"] == "ok":
            print(f"  OK  mode={result['mode_used']}  {result['elapsed_s']}s  "
                  f"schema_valid={result['schema_valid']}  id_fidelity_perfect={result['id_fidelity']['perfect']}  "
                  f"tokens_in={result['prompt_tokens']} tokens_out={result['completion_tokens']}")
        else:
            last_err = result["attempts_log"][-1]["error"] if result["attempts_log"] else "unknown"
            print(f"  FAILED  last_error={last_err}")

        safe_name = model_id.replace("/", "_").replace(":", "_")
        out_path = os.path.join(args.out_dir, f"{safe_name}.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        summary.append({
            "model": model_id,
            "status": result["status"],
            "mode_used": result.get("mode_used"),
            "elapsed_s": result.get("elapsed_s"),
            "schema_valid": result.get("schema_valid"),
            "id_fidelity_perfect": result.get("id_fidelity", {}).get("perfect") if result["status"] == "ok" else None,
            "declared_structured_output": m["declared_structured_output"],
            "declared_vision": m["declared_vision"],
        })

        if i < len(models) - 1:
            time.sleep(args.sleep)

    summary_path = os.path.join(args.out_dir, "_summary.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f"\n\nSaved summary to {summary_path}")


if __name__ == "__main__":
    main()
