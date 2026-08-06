#!/usr/bin/env python3
"""
benchmark_translation.py — Repeatable translation-stage benchmark across every provider
and model in config/providers.json, run against every page in scripts/corpus/. Supersedes
benchmark_free_translation.py (single-provider, single-page, hardcoded model list).

Reuses build_batch_prompt / MANGA_TRANSLATION_JSON_SYSTEM_PROMPT / TRANSLATION_JSON_SCHEMA
/ validate_response from test_translation.py, so results are measuring the exact prompt and
schema contract worker/services/translation.py's translate_batch_llm() uses in production.

For each (provider, model, corpus page) it tries, in order, until one succeeds:
  1. response_format: json_schema (strict)   -> "json_schema"
  2. response_format: json_object             -> "json_object"
  3. no response_format (prompt-only JSON)     -> "none"
This measures actual structured-output support empirically rather than trusting a
provider's self-reported capability metadata (see docs/translation_bench.md §"Structured
output: declared vs. actual").

Provider/model source: config/providers.json — the same file the backend reads to build
its fallback chain. New models "just work" here once added there; no code changes needed
to benchmark them.

Usage:
    # Free OpenRouter models against the hand-verified quick corpus (sample28 only)
    python scripts/benchmark_translation.py --provider openrouter

    # Everything free, across the full corpus
    python scripts/benchmark_translation.py --free-only --corpus-subset all

    # One NVIDIA model
    python scripts/benchmark_translation.py --provider nvidia --model nvidia/nemotron-3-nano-omni-30b-a3b-reasoning

    # Cloudflare Workers AI free models
    python scripts/benchmark_translation.py --provider cloudflare

    # Once OpenRouter has paid credits again: include paid models too
    python scripts/benchmark_translation.py --provider openrouter --include-paid

See docs/translation_bench.md for the full methodology, corpus format, and how to read
the output.
"""

import os
import re
import sys
import json
import time
import difflib
import argparse
import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
sys.path.insert(0, SCRIPT_DIR)

from test_translation import (  # noqa: E402
    load_env,
    build_batch_prompt,
    MANGA_TRANSLATION_JSON_SYSTEM_PROMPT,
    TRANSLATION_JSON_SCHEMA,
    validate_response,
)

load_env(os.path.join(REPO_ROOT, ".env"))

DEFAULT_PROVIDERS_CONFIG = os.path.join(REPO_ROOT, "config", "providers.json")
DEFAULT_CORPUS_DIR = os.path.join(SCRIPT_DIR, "corpus")

# scripts/corpus/sample28 is the hand-verified entry (extraction_method: "manual") and is the
# default "quick" smoke-test page. Everything else in scripts/corpus/ is auto-extracted via OCR
# (scripts/build_translation_corpus.py) and carries an over_merge_risk / match-rate signal
# in its meta.json — see docs/translation_bench.md for how "clean" is chosen.
QUICK_SUBSET = ["sample28"]


# ---------------------------------------------------------------------------
# Provider config loading (config/providers.json)
# ---------------------------------------------------------------------------

def load_providers_config(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def resolve_base_url(url_template):
    """Substitute ${VAR} placeholders (e.g. Cloudflare's ${CLOUDFLARE_ACCOUNT_ID}) from env."""
    def repl(m):
        var = m.group(1)
        val = os.environ.get(var, "")
        if not val:
            raise ValueError(f"{var} not set in environment/.env (required for this provider's baseUrl)")
        return val
    return re.sub(r"\$\{([A-Z0-9_]+)\}", repl, url_template)


def build_headers(provider_cfg):
    api_key = os.environ.get(provider_cfg["keyEnvVar"], "")
    if not api_key:
        raise ValueError(f"{provider_cfg['keyEnvVar']} not set in environment/.env")
    headers = {
        "Content-Type": "application/json",
        provider_cfg["authHeader"]: f"{provider_cfg.get('authPrefix', '')}{api_key}",
    }
    headers.update(provider_cfg.get("extraHeaders", {}))
    return headers


def list_candidate_models(providers_cfg, provider_filter, include_paid, model_filter):
    """Yields (provider_name, provider_cfg, model_id, model_name, free) for every model to test."""
    for provider_name, provider_cfg in providers_cfg["providers"].items():
        if provider_filter and provider_name != provider_filter:
            continue
        tl_models = (provider_cfg.get("models") or {}).get("tl") or []
        for m in tl_models:
            if model_filter and m["id"] != model_filter:
                continue
            if not m.get("free", False) and not include_paid:
                continue
            yield provider_name, provider_cfg, m["id"], m.get("name", m["id"]), m.get("free", False)


# ---------------------------------------------------------------------------
# Corpus loading (scripts/corpus/<sampleId>/{regions.json,reference.json,meta.json})
# ---------------------------------------------------------------------------

def load_corpus_page(corpus_dir, sample_id):
    base = os.path.join(corpus_dir, sample_id)
    with open(os.path.join(base, "regions.json"), "r", encoding="utf-8") as f:
        regions = json.load(f)
    reference = {}
    ref_path = os.path.join(base, "reference.json")
    if os.path.exists(ref_path):
        with open(ref_path, "r", encoding="utf-8") as f:
            reference = json.load(f).get("reference_translations", {})
    meta = {}
    meta_path = os.path.join(base, "meta.json")
    if os.path.exists(meta_path):
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    return regions, reference, meta


def resolve_corpus_pages(corpus_dir, subset, explicit_pages, min_reference_match_rate=0.5):
    if explicit_pages:
        return explicit_pages
    all_pages = sorted(
        d for d in os.listdir(corpus_dir)
        if os.path.isdir(os.path.join(corpus_dir, d)) and
        os.path.exists(os.path.join(corpus_dir, d, "regions.json"))
    )
    if subset == "quick":
        return [p for p in QUICK_SUBSET if p in all_pages] or all_pages[:1]
    if subset == "all":
        return all_pages
    if subset == "clean":
        clean = []
        for p in all_pages:
            _, _, meta = load_corpus_page(corpus_dir, p)
            if meta.get("extraction_method") == "manual":
                clean.append(p)
                continue
            if meta.get("over_merge_risk"):
                continue
            if meta.get("reference_match_rate", 0) < min_reference_match_rate:
                continue
            clean.append(p)
        return clean
    raise ValueError(f"Unknown --corpus-subset {subset!r}")


# ---------------------------------------------------------------------------
# Quality proxy: lexical similarity to reference (NOT semantic quality — see docs)
# ---------------------------------------------------------------------------

def normalize_for_similarity(text):
    text = text.lower()
    text = re.sub(r"[^\w\s]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def lexical_similarity(a, b):
    if not a or not b:
        return None
    return difflib.SequenceMatcher(None, normalize_for_similarity(a), normalize_for_similarity(b)).ratio()


def score_against_reference(result, reference_translations):
    translations = result.get("translations", []) if isinstance(result, dict) else []
    per_region = {}
    scored = []
    for t in translations:
        if not isinstance(t, dict):
            continue
        rid = t.get("id")
        ref = reference_translations.get(rid)
        sim = lexical_similarity(t.get("translation", ""), ref) if ref else None
        per_region[rid] = sim
        if sim is not None:
            scored.append(sim)
    return {
        "per_region": per_region,
        "mean_lexical_similarity": round(sum(scored) / len(scored), 4) if scored else None,
        "scored_region_count": len(scored),
    }


# ---------------------------------------------------------------------------
# Structured-input fidelity (id-keyed batch echoed correctly)
# ---------------------------------------------------------------------------

def check_id_fidelity(result, expected_ids):
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


# ---------------------------------------------------------------------------
# Request building + the empirical structured-output ladder
# ---------------------------------------------------------------------------

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
            "json_schema": {"name": "structured_output", "schema": TRANSLATION_JSON_SCHEMA, "strict": True},
        }
    elif mode == "json_object":
        payload["response_format"] = {"type": "json_object"}
    return payload


def call_provider(url, headers, payload, timeout=90):
    t0 = time.time()
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=timeout)
        return resp, time.time() - t0, None
    except Exception as e:
        return None, time.time() - t0, str(e)


def try_model_on_page(url, headers, model_id, regions, reference_translations, source_lang, target_lang, retries=2):
    expected_ids = [r["id"] for r in regions]
    attempts_log = []

    for mode in ("json_schema", "json_object", "none"):
        payload = build_payload(model_id, regions, mode, source_lang, target_lang)

        for attempt_num in range(retries + 1):
            resp, elapsed, net_err = call_provider(url, headers, payload)

            if net_err is not None:
                attempts_log.append({"mode": mode, "attempt": attempt_num, "error": f"network: {net_err}", "elapsed_s": elapsed})
                continue
            if resp.status_code == 429:
                attempts_log.append({"mode": mode, "attempt": attempt_num, "error": "rate_limited (429)", "elapsed_s": elapsed})
                time.sleep(5 * (attempt_num + 1))
                continue
            if resp.status_code != 200:
                attempts_log.append({"mode": mode, "attempt": attempt_num, "error": f"http_{resp.status_code}: {resp.text[:500]}", "elapsed_s": elapsed})
                break  # move to next response_format mode — likely unsupported

            data = resp.json()
            message = ((data.get("choices") or [{}])[0]).get("message", {}) or {}
            content = message.get("content", "") or ""
            usage = data.get("usage", {}) or {}

            if not content.strip():
                attempts_log.append({"mode": mode, "attempt": attempt_num, "error": "empty_content", "elapsed_s": elapsed})
                break

            cleaned = strip_fences(content)
            try:
                result = json.loads(cleaned)
            except json.JSONDecodeError as e:
                attempts_log.append({"mode": mode, "attempt": attempt_num, "error": f"json_decode_error: {e}", "elapsed_s": elapsed, "raw_content": content})
                break

            valid, reason = validate_response(result)
            fidelity = check_id_fidelity(result, expected_ids)
            quality = score_against_reference(result, reference_translations)

            return {
                "status": "ok",
                "mode_used": mode,
                "elapsed_s": round(elapsed, 3),
                "schema_valid": valid,
                "schema_reason": reason,
                "id_fidelity": fidelity,
                "quality": quality,
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
                "raw_content": content,
                "result": result,
                "attempts_log": attempts_log,
            }

    return {"status": "failed", "mode_used": None, "elapsed_s": None, "attempts_log": attempts_log}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Repeatable translation benchmark across config/providers.json models and scripts/corpus/ pages")
    parser.add_argument("--providers-config", default=DEFAULT_PROVIDERS_CONFIG)
    parser.add_argument("--corpus-dir", default=DEFAULT_CORPUS_DIR)
    parser.add_argument("--provider", help="Only this provider (openrouter/cloudflare/nvidia/neurometric). Default: all.")
    parser.add_argument("--model", help="Only this model id")
    parser.add_argument("--free-only", action="store_true", default=True, help="Default: free models only")
    parser.add_argument("--include-paid", dest="free_only", action="store_false", help="Also test paid models (needs credits)")
    parser.add_argument("--corpus-subset", choices=["quick", "clean", "all"], default="quick",
                         help="quick=sample28 only (default); clean=manual + auto pages that passed the over-merge/match-rate gate; all=every corpus page")
    parser.add_argument("--pages", help="Comma-separated explicit corpus sample ids, overrides --corpus-subset")
    parser.add_argument("--source-lang", default="ja")
    parser.add_argument("--target-lang", default="en")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--sleep", type=float, default=2.0, help="Seconds between requests (rate limits)")
    args = parser.parse_args()

    providers_cfg = load_providers_config(args.providers_config)
    explicit_pages = args.pages.split(",") if args.pages else None
    pages = resolve_corpus_pages(args.corpus_dir, args.corpus_subset, explicit_pages)
    if not pages:
        print(f"[ERROR] No corpus pages resolved for subset={args.corpus_subset!r}. Run scripts/build_translation_corpus.py first.")
        sys.exit(1)

    candidates = list(list_candidate_models(providers_cfg, args.provider, not args.free_only, args.model))
    if not candidates:
        print("[ERROR] No matching models found in providers config for the given filters.")
        sys.exit(1)

    os.makedirs(args.out_dir, exist_ok=True)
    print(f"[INFO] {len(candidates)} model(s) x {len(pages)} page(s) = {len(candidates) * len(pages)} runs")
    print(f"[INFO] pages: {pages}")

    summary = []
    run_index = 0
    total_runs = len(candidates) * len(pages)

    for provider_name, provider_cfg, model_id, model_name, free in candidates:
        try:
            url = resolve_base_url(provider_cfg["baseUrl"])
            headers = build_headers(provider_cfg)
        except ValueError as e:
            print(f"\n[SKIP] {provider_name}/{model_id}: {e}")
            continue

        model_dir = os.path.join(args.out_dir, provider_name, model_id.replace("/", "_").replace(":", "_"))
        os.makedirs(model_dir, exist_ok=True)

        page_results = []
        for sample_id in pages:
            run_index += 1
            regions, reference, meta = load_corpus_page(args.corpus_dir, sample_id)
            print(f"\n[{run_index}/{total_runs}] {provider_name}/{model_id}  page={sample_id}  "
                  f"({meta.get('extraction_method', 'unknown')})")

            result = try_model_on_page(url, headers, model_id, regions, reference, args.source_lang, args.target_lang)
            result["provider"] = provider_name
            result["model"] = model_id
            result["sample_id"] = sample_id

            if result["status"] == "ok":
                q = result["quality"]["mean_lexical_similarity"]
                q_str = f"{q:.3f}" if q is not None else "n/a"
                print(f"  OK  mode={result['mode_used']}  {result['elapsed_s']}s  "
                      f"schema_valid={result['schema_valid']}  id_fidelity={result['id_fidelity']['perfect']}  "
                      f"lexical_similarity={q_str}")
            else:
                last_err = result["attempts_log"][-1]["error"] if result["attempts_log"] else "unknown"
                print(f"  FAILED  last_error={last_err}")

            with open(os.path.join(model_dir, f"{sample_id}.json"), "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
            page_results.append(result)

            if run_index < total_runs:
                time.sleep(args.sleep)

        ok_results = [r for r in page_results if r["status"] == "ok"]
        similarities = [r["quality"]["mean_lexical_similarity"] for r in ok_results if r["quality"]["mean_lexical_similarity"] is not None]
        latencies = [r["elapsed_s"] for r in ok_results]
        summary.append({
            "provider": provider_name,
            "model": model_id,
            "model_name": model_name,
            "free": free,
            "pages_attempted": len(pages),
            "pages_ok": len(ok_results),
            "schema_valid_rate": round(sum(1 for r in ok_results if r["schema_valid"]) / len(ok_results), 3) if ok_results else None,
            "id_fidelity_perfect_rate": round(sum(1 for r in ok_results if r["id_fidelity"]["perfect"]) / len(ok_results), 3) if ok_results else None,
            "mean_latency_s": round(sum(latencies) / len(latencies), 2) if latencies else None,
            "max_latency_s": round(max(latencies), 2) if latencies else None,
            "mean_lexical_similarity": round(sum(similarities) / len(similarities), 4) if similarities else None,
            "modes_used": sorted({r["mode_used"] for r in ok_results if r["mode_used"]}),
        })

    summary.sort(key=lambda s: (-(s["mean_lexical_similarity"] or 0), s["mean_latency_s"] or float("inf")))
    summary_path = os.path.join(args.out_dir, "_summary.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print(f"\n\n{'=' * 70}\nSUMMARY (sorted by lexical similarity desc, then latency asc)\n{'=' * 70}")
    for s in summary:
        sim = f"{s['mean_lexical_similarity']:.3f}" if s["mean_lexical_similarity"] is not None else "n/a"
        lat = f"{s['mean_latency_s']:.1f}s" if s["mean_latency_s"] is not None else "n/a"
        print(f"  {s['provider']:12s} {s['model']:50s} sim={sim:>6s}  lat={lat:>8s}  "
              f"ok={s['pages_ok']}/{s['pages_attempted']}  modes={s['modes_used']}")
    print(f"\nSaved summary to {summary_path}")


if __name__ == "__main__":
    main()
