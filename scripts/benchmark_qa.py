#!/usr/bin/env python3
"""
benchmark_qa.py — Repeatable QA-stage benchmark over the injected-defect corpus, for both the
text-only LLM arm and the vision VLM arm.

Answers "which model catches the most mistakes" without rewarding a model that simply distrusts
everything. Every case built by scripts/build_qa_corpus.py names the region that was mutated, so
each model is scored on three things at once:

  * recall    — did it flag the planted defect?
  * precision — did it leave the untouched regions alone? (unmutated regions that get flagged
                are false positives)
  * class accuracy — did it flag the *right kind* of problem, e.g. escalation.orderBad for a
                reading-order swap rather than a generic "failed"?

Headline ranking is macro-F1 across the defect classes, with the control-case false-positive
rate printed beside it: a model that fails every region scores perfect recall and is useless,
and this table makes that visible instead of hiding it.

Both arms reuse the production contract:
  * LLM arm — build_qa_prompt and QA_JSON_SCHEMA imported from scripts/test_qa.py, which mirrors
    worker/src/worker/handlers/qa.py's _process_qa_llm().
  * VLM arm — the side-by-side original|rendered composite and prompt from _process_qa_vlm().

Usage:
    python scripts/benchmark_qa.py --arm llm --provider openrouter --out-dir /tmp/qabench
    python scripts/benchmark_qa.py --arm vlm --provider openrouter --out-dir /tmp/qabench
    python scripts/benchmark_qa.py --arm llm --samples sample36,sample13 --out-dir runs/qa
"""

import io
import os
import re
import sys
import json
import time
import base64
import argparse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
sys.path.insert(0, SCRIPT_DIR)

from test_qa import build_qa_prompt, QA_JSON_SCHEMA  # noqa: E402
from provider_config import (  # noqa: E402
    load_env,
    load_providers_config,
    resolve_base_url,
    build_headers,
    list_candidate_models,
)
from bench_common import apply_response_format, run_ladder, print_summary_table  # noqa: E402

load_env(os.path.join(REPO_ROOT, ".env"))

DEFAULT_QA_CORPUS = os.path.join(SCRIPT_DIR, "qa_corpus")
DEFAULT_PROVIDERS_CONFIG = os.path.join(REPO_ROOT, "config", "providers.json")

DEFECT_CLASSES = ["mistranslation", "untranslated", "ocr_garbage",
                  "ocr_unrecoverable", "order_swap", "sfx_translated"]

# Pages are pasted side by side and can reach ~6000px wide; cap the long edge so a run does not
# spend its whole token budget on pixels. The worker does not downscale, so this is a benchmark
# concession — noted in docs/qa_bench.md.
VLM_MAX_EDGE = 1400


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

def build_qa_vlm_prompt(regions_metadata):
    """Mirrors worker/src/worker/handlers/qa.py::_process_qa_vlm()'s prompt so the benchmark
    measures the contract production actually sends."""
    return f"""You are an expert Japanese-to-English manga translator and typesetting reviewer. Given the original Japanese manga page (left) and the English typeset page (right), verify: (1) OCR accuracy by comparing visible Japanese text against transcription, (2) Translation quality and natural English, (3) Typesetting quality — text fitting, overflow, readability.

We have seeded each text region with its OCR confidence (ocrScore) and translation confidence (translationScore). Keep these previous scores in mind when evaluating the overall results.

For each region in the provided metadata, evaluate and check if:
1. Text overflows the speech bubble/mask boundaries.
2. Text overlaps with panel borders or other text.
3. Translation flow is awkward, or the English translation does not match the original Japanese text.
4. The OCR transcription was bad/inaccurate:
   - If you can deduce the correct text from the image, flag with ocrBad=true and provide correctedSourceText.
   - If the OCR text is garbage and you CANNOT deduce it or read it, flag needsReOcr=true.
   - If the region is completely unfixable or obscured, flag needsManualIntervention=true.
5. The reading order/bubble sequence is incorrect (flag with orderBad=true and provide suggestedReadingOrderIndex).

Status categories:
- "passed": No correction needed. You MUST still provide a detailed explanation/reasoning in "qaFeedback".
- "direct_fix": If you have a better translation, output it directly in "directFix".correctedText.
- "reject_sfx": If the region is a sound effect (SFX) or gibberish that shouldn't be translated.
- "failed": Major translation error or layout issue requiring a re-run.

Region Metadata:
{json.dumps(regions_metadata, ensure_ascii=False, indent=2)}

You MUST return a JSON object containing a "results" key with an array of objects conforming to the requested schema. No other text."""


def build_side_by_side(source_path, render_path, max_edge=VLM_MAX_EDGE):
    """Original (left) | rendered (right), the composite _process_qa_vlm() sends."""
    from PIL import Image

    img1 = Image.open(source_path).convert("RGB")
    img2 = Image.open(render_path).convert("RGB")
    w1, h1 = img1.size
    w2, h2 = img2.size
    combined = Image.new("RGB", (w1 + w2, max(h1, h2)), (255, 255, 255))
    combined.paste(img1, (0, 0))
    combined.paste(img2, (w1, 0))

    longest = max(combined.size)
    if longest > max_edge:
        scale = max_edge / longest
        combined = combined.resize((int(combined.width * scale), int(combined.height * scale)),
                                   Image.Resampling.LANCZOS)

    buf = io.BytesIO()
    combined.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def is_flagged(entry):
    """Did the model raise anything at all about this region?"""
    if entry.get("qaStatus") not in (None, "passed"):
        return True
    esc = entry.get("escalation") or {}
    return any(bool(esc.get(k)) for k in
               ("ocrBad", "needsReOcr", "needsManualIntervention", "orderBad"))


def matches_expected(defect_class, entry):
    """Did the model identify the *right kind* of defect?"""
    status = entry.get("qaStatus")
    esc = entry.get("escalation") or {}
    if defect_class in ("mistranslation", "untranslated"):
        return status in ("failed", "direct_fix")
    if defect_class == "ocr_garbage":
        return bool(esc.get("ocrBad")) or bool((esc.get("correctedSourceText") or "").strip())
    if defect_class == "ocr_unrecoverable":
        return bool(esc.get("needsReOcr")) or bool(esc.get("needsManualIntervention"))
    if defect_class == "order_swap":
        return bool(esc.get("orderBad"))
    if defect_class == "sfx_translated":
        return status == "reject_sfx"
    return False


def score_case(case, result):
    """Per-case confusion counts against the planted defect."""
    entries = result.get("results", []) if isinstance(result, dict) else []
    by_id = {e.get("regionId"): e for e in entries if isinstance(e, dict)}
    mutated = set(case["mutated_region_ids"])
    defect_class = case["defect_class"]

    tp = fn = fp = correct_class = 0
    missing = 0
    for region in case["regions_metadata"]:
        rid = region["regionId"]
        entry = by_id.get(rid)
        if entry is None:
            missing += 1
            if rid in mutated:
                fn += 1
            continue
        flagged = is_flagged(entry)
        if rid in mutated:
            if flagged:
                tp += 1
            else:
                fn += 1
            if matches_expected(defect_class, entry):
                correct_class += 1
        elif flagged:
            fp += 1

    return {
        "defect_class": defect_class,
        "mutated_count": len(mutated),
        "detected": tp,
        "missed": fn,
        "false_positives": fp,
        "correct_class": correct_class,
        "unscored_regions": missing,
        "region_count": len(case["regions_metadata"]),
    }


def aggregate(per_case):
    """Per-class precision/recall/F1 plus the control false-positive rate."""
    by_class = {}
    for s in per_case:
        c = by_class.setdefault(s["defect_class"],
                                {"detected": 0, "missed": 0, "false_positives": 0,
                                 "correct_class": 0, "mutated": 0, "clean_regions": 0})
        c["detected"] += s["detected"]
        c["missed"] += s["missed"]
        c["false_positives"] += s["false_positives"]
        c["correct_class"] += s["correct_class"]
        c["mutated"] += s["mutated_count"]
        c["clean_regions"] += s["region_count"] - s["mutated_count"]

    classes = {}
    f1s = []
    for name, c in by_class.items():
        if name == "control":
            continue
        recall = c["detected"] / c["mutated"] if c["mutated"] else None
        precision = (c["detected"] / (c["detected"] + c["false_positives"])
                     if (c["detected"] + c["false_positives"]) else None)
        f1 = (2 * precision * recall / (precision + recall)
              if precision and recall and (precision + recall) else 0.0)
        classes[name] = {
            "recall": round(recall, 4) if recall is not None else None,
            "precision": round(precision, 4) if precision is not None else None,
            "f1": round(f1, 4),
            "class_accuracy": round(c["correct_class"] / c["mutated"], 4) if c["mutated"] else None,
            "false_positives": c["false_positives"],
            "clean_regions": c["clean_regions"],
        }
        f1s.append(f1)

    control = by_class.get("control")
    control_fp_rate = (round(control["false_positives"] / control["clean_regions"], 4)
                       if control and control["clean_regions"] else None)

    return {
        "per_class": classes,
        "macro_f1": round(sum(f1s) / len(f1s), 4) if f1s else None,
        "macro_recall": round(sum(v["recall"] for v in classes.values() if v["recall"] is not None)
                              / max(1, sum(1 for v in classes.values() if v["recall"] is not None)), 4)
        if classes else None,
        "macro_class_accuracy": round(
            sum(v["class_accuracy"] for v in classes.values() if v["class_accuracy"] is not None)
            / max(1, sum(1 for v in classes.values() if v["class_accuracy"] is not None)), 4)
        if classes else None,
        "control_fp_rate": control_fp_rate,
    }


# ---------------------------------------------------------------------------
# Running
# ---------------------------------------------------------------------------

def load_cases(corpus_dir, samples, arm):
    cases = []
    sample_dirs = sorted(
        (d for d in os.listdir(corpus_dir) if os.path.isdir(os.path.join(corpus_dir, d))),
        key=lambda d: int(re.sub(r"\D", "", d) or 0),
    )
    if samples:
        sample_dirs = [d for d in sample_dirs if d in samples]
    for sample_id in sample_dirs:
        for name in sorted(os.listdir(os.path.join(corpus_dir, sample_id))):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(corpus_dir, sample_id, name), "r", encoding="utf-8") as f:
                case = json.load(f)
            if arm == "vlm" and not case.get("vlm_ready"):
                continue
            cases.append(case)
    return cases


def run_case(url, headers, model_id, case, arm, retries=1):
    metadata = case["regions_metadata"]

    if arm == "llm":
        prompt = build_qa_prompt(metadata)
        content = prompt
    else:
        prompt = build_qa_vlm_prompt(metadata)
        b64 = build_side_by_side(os.path.join(REPO_ROOT, case["images"]["source"]),
                                 os.path.join(REPO_ROOT, case["images"]["render"]))
        content = [{"type": "text", "text": prompt},
                   {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}}]

    def build_payload(mode):
        payload = {"model": model_id, "messages": [{"role": "user", "content": content}]}
        return apply_response_format(payload, mode, QA_JSON_SCHEMA)

    return run_ladder(url, headers, build_payload, retries=retries, timeout=60)


def main():
    parser = argparse.ArgumentParser(
        description="QA-stage benchmark over injected-defect cases, LLM and VLM arms")
    parser.add_argument("--arm", choices=["llm", "vlm"], default="llm",
                        help="llm = text-only metadata review (models.qaLLM); "
                             "vlm = side-by-side page images (models.qaVLM)")
    parser.add_argument("--qa-corpus", default=DEFAULT_QA_CORPUS)
    parser.add_argument("--samples", help="Comma-separated corpus sample ids (default: all)")
    parser.add_argument("--providers-config", default=DEFAULT_PROVIDERS_CONFIG)
    parser.add_argument("--provider", help="Only this provider")
    parser.add_argument("--model", help="Only this model id")
    parser.add_argument("--free-only", action="store_true", default=True)
    parser.add_argument("--include-paid", dest="free_only", action="store_false")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--sleep", type=float, default=2.0, help="Seconds between requests")
    args = parser.parse_args()

    if not os.path.isdir(args.qa_corpus):
        sys.exit(f"[ERROR] {args.qa_corpus} not found. Run scripts/build_qa_corpus.py first.")

    samples = set(args.samples.split(",")) if args.samples else None
    cases = load_cases(args.qa_corpus, samples, args.arm)
    if not cases:
        sys.exit(f"[ERROR] No {args.arm} cases found in {args.qa_corpus}. "
                 f"{'The VLM arm needs cases with both OCR-corpus bboxes and a worker render.' if args.arm == 'vlm' else ''}")

    task_key = "qaLLM" if args.arm == "llm" else "qaVLM"
    providers_cfg = load_providers_config(args.providers_config)
    candidates = list(list_candidate_models(providers_cfg, task_key, args.provider,
                                            not args.free_only, args.model))
    if not candidates:
        sys.exit(f"[ERROR] No models under models.{task_key} matched the given filters.")

    os.makedirs(args.out_dir, exist_ok=True)
    total = len(candidates) * len(cases)
    print(f"[INFO] arm={args.arm}  {len(candidates)} model(s) x {len(cases)} case(s) = {total} run(s)")

    summary = []
    run_index = 0

    for provider_name, provider_cfg, model_id, model_name, free in candidates:
        try:
            url = resolve_base_url(provider_cfg["baseUrl"])
            headers = build_headers(provider_cfg)
        except ValueError as e:
            print(f"\n[SKIP] {provider_name}/{model_id}: {e}")
            continue

        model_dir = os.path.join(args.out_dir, args.arm, provider_name,
                                 model_id.replace("/", "_").replace(":", "_"))
        os.makedirs(model_dir, exist_ok=True)
        per_case, latencies = [], []

        for case in cases:
            run_index += 1
            print(f"\n[{run_index}/{total}] {provider_name}/{model_id}  {case['case_id']}")
            outcome = run_case(url, headers, model_id, case, args.arm)

            record = {"provider": provider_name, "model": model_id, "arm": args.arm,
                      "case_id": case["case_id"], "defect_class": case["defect_class"],
                      "mutated_region_ids": case["mutated_region_ids"], **outcome}
            if outcome["status"] == "ok":
                score = score_case(case, outcome["result"])
                record["score"] = score
                per_case.append(score)
                latencies.append(outcome["elapsed_s"])
                print(f"  detected={score['detected']}/{score['mutated_count']}  "
                      f"right_class={score['correct_class']}  fp={score['false_positives']}  "
                      f"mode={outcome['mode_used']}  {outcome['elapsed_s']}s")
            else:
                last = outcome["attempts_log"][-1]["error"] if outcome["attempts_log"] else "unknown"
                print(f"  FAILED  {last[:140]}")

            with open(os.path.join(model_dir, f"{case['case_id']}.json"), "w", encoding="utf-8") as f:
                json.dump(record, f, ensure_ascii=False, indent=2)
            if run_index < total:
                time.sleep(args.sleep)

        agg = aggregate(per_case)
        summary.append({
            "provider": provider_name, "model": model_id, "model_name": model_name,
            "free": free, "arm": args.arm,
            "cases_attempted": len(cases), "cases_ok": len(per_case),
            "mean_latency_s": round(sum(latencies) / len(latencies), 2) if latencies else None,
            **agg,
        })

    summary.sort(key=lambda s: -(s["macro_f1"] or 0))
    summary_path = os.path.join(args.out_dir, f"_summary_{args.arm}.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print_summary_table(
        summary,
        [("macroF1", "macro_f1", lambda v: f"{v:.3f}"),
         ("recall", "macro_recall", lambda v: f"{v:.3f}"),
         ("class", "macro_class_accuracy", lambda v: f"{v:.3f}"),
         ("ctrlFP", "control_fp_rate", lambda v: f"{v:.3f}"),
         ("lat", "mean_latency_s", lambda v: f"{v:.1f}s")],
        f"SUMMARY — {args.arm.upper()} arm (sorted by macro-F1 desc; ctrlFP is the "
        f"false-positive rate on undamaged control pages — lower is better)",
    )
    print(f"\nSaved summary to {summary_path}")


if __name__ == "__main__":
    main()
