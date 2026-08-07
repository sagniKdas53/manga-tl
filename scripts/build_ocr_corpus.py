#!/usr/bin/env python3
"""
build_ocr_corpus.py — Build a committable, ground-truthed OCR benchmark corpus from
examples/sampleN/ pages.

Unlike scripts/corpus/ (translation, text-only, images deliberately excluded), this corpus
*does* commit its images: a downscaled WebP of each page, so scripts/benchmark_vlm_ocr.py has a
stable, reproducible input that survives the examples/ history purge. ~40 pages at long-edge
1600 / WebP q80 is roughly 8-14 MB.

Output layout:

    scripts/ocr_corpus/
      _manifest.json
      sampleN/
        page.webp       long edge 1600 (matches the pipeline's downscale_for_ocr max_dim)
        regions.json    [{id, bbox, polygon, type, text, lang, direction, tier, candidates}]
        meta.json       per-tier counts, engines used, provenance
      _review/sampleN.html   self-contained gold-review page (only for --gold samples)

Ground truth is built in two tiers, because the maintainer does not read Japanese:

  * consensus — every region transcribed by local PaddleOCR plus 2-3 cloud vision models from
    config/providers.json models.ocr. The medoid candidate (the one minimising total CER to the
    others) wins when at least --min-agree engines land within --tol CER of it. Regions that
    fail that bar are tier "unresolved" and are excluded from scoring by
    benchmark_vlm_ocr.py's score_page(), so they never silently become noise targets.
  * gold — for the samples passed to --gold, `_review/sampleN.html` renders each region's crop
    next to every engine's candidate with the consensus pre-selected, so review is
    choose-and-correct rather than transcribe-from-scratch. Feed the edited JSON back with
    --apply-review to promote those regions to tier "gold".

Usage:
    # One sample end to end (region proposal + PaddleOCR + cloud VLMs)
    python scripts/build_ocr_corpus.py --sample sample36 --provider openrouter

    # Local PaddleOCR only, no API calls (fast; every region will be "unresolved")
    python scripts/build_ocr_corpus.py --sample sample36 --local-only

    # Emit the gold review page for the chosen samples
    python scripts/build_ocr_corpus.py --gold sample36 --review-only

    # Fold reviewed text back in
    python scripts/build_ocr_corpus.py --apply-review scripts/ocr_corpus/_review/sample36.json
"""

import os
import re
import sys
import json
import html
import base64
import argparse

import cv2
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
sys.path.insert(0, SCRIPT_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "worker", "src"))

os.environ.setdefault("PADDLEX_OFFLINE_MODE", "1")
os.environ.setdefault("PADDLE_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")

from provider_config import (  # noqa: E402
    load_env,
    load_providers_config,
    list_candidate_models,
)
from bench_common import cer, normalize_text  # noqa: E402

load_env(os.path.join(REPO_ROOT, ".env"))

DEFAULT_EXAMPLES = os.path.join(REPO_ROOT, "examples")
DEFAULT_OUT = os.path.join(SCRIPT_DIR, "ocr_corpus")
DEFAULT_PROVIDERS_CONFIG = os.path.join(REPO_ROOT, "config", "providers.json")

MAX_DIM = 1600
WEBP_QUALITY = 80

# Prompt language name per meta.json source lang, for the VLM OCR prompt.
LANG_NAME = {"ja": "Japanese", "zh": "Chinese", "ko": "Korean", "en": "English"}


# ---------------------------------------------------------------------------
# Page preparation
# ---------------------------------------------------------------------------

def load_sample_meta(sample_dir):
    meta_path = os.path.join(sample_dir, "meta.json")
    if not os.path.exists(meta_path):
        return None
    with open(meta_path, "r", encoding="utf-8") as f:
        return json.load(f)


def imread_unicode(path):
    return cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)


def downscale(img, max_dim=MAX_DIM):
    h, w = img.shape[:2]
    largest = max(h, w)
    if largest <= max_dim:
        return img
    scale = max_dim / largest
    return cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)


# ---------------------------------------------------------------------------
# Transcription engines
# ---------------------------------------------------------------------------

# Local PaddleOCR variants usable as consensus engines. Both PP-OCR generations are already
# present in the project's model cache, and running more than one is the cheapest way to get a
# workable engine pool: with only two *free* cloud vision models available, a paddle-plus-two-VLM
# pool makes the default --min-agree 3 equivalent to unanimity. Adding v5 alongside v6 gives four
# independent engines, so a single disagreeing engine no longer sinks the region.
PADDLE_VARIANTS = {
    "paddleocr_v6_medium": ("PP-OCRv6_medium_det", "PP-OCRv6_medium_rec"),
    "paddleocr_v6_small": ("PP-OCRv6_small_det", "PP-OCRv6_small_rec"),
    "paddleocr_v5_server": ("PP-OCRv5_server_det", "PP-OCRv5_server_rec"),
    "paddleocr_v5_mobile": ("PP-OCRv5_mobile_det", "PP-OCRv5_mobile_rec"),
}
DEFAULT_PADDLE_VARIANTS = ["paddleocr_v6_medium", "paddleocr_v5_server"]


def paddle_transcribe_regions(img, regions, lang, variant):
    """Per-region PaddleOCR transcription with one explicit model pair, so it is directly
    comparable with the VLM crops and so each variant votes independently."""
    from build_translation_corpus import parse_paddle_ocr_results, SOURCE_LANG_TO_PADDLE
    from benchmark_local_ocr import init_paddleocr

    paddle_lang = SOURCE_LANG_TO_PADDLE.get(lang, "japan")
    det_model, rec_model = PADDLE_VARIANTS[variant]
    reader = init_paddleocr(paddle_lang, det_model, rec_model)
    if reader is None:
        print(f"    [warn] could not initialise {variant}; skipping this engine")
        return None

    out = {}
    for r in regions:
        x, y, w, h = r["bbox"]
        crop = img[y:y + h, x:x + w]
        if crop.size == 0:
            out[r["id"]] = ""
            continue
        try:
            parsed = parse_paddle_ocr_results(reader.predict(crop))
        except Exception as e:  # noqa: BLE001
            print(f"    [warn] {variant} failed on {r['id']}: {e}")
            out[r["id"]] = ""
            continue
        out[r["id"]] = "".join(text for _bbox, text, _conf in parsed).strip()
    return out


def vlm_transcribe_regions(img, regions, provider_name, provider_cfg, model_id, lang_name, sleep=0.0):
    from benchmark_vlm_ocr import call_vlm_ocr, crop_for_region
    import time as _time

    out, meta = {}, {}
    for r in regions:
        crop, _ = crop_for_region(img, r["bbox"])
        if crop.size == 0:
            out[r["id"]] = ""
            continue
        res = call_vlm_ocr(crop, provider_name, provider_cfg, model_id, lang_name)
        if "error" in res:
            print(f"    [warn] {model_id} failed on {r['id']}: {res['error'][:120]}")
            out[r["id"]] = ""
        else:
            payload = res["result"]
            out[r["id"]] = (payload.get("text") or "").strip()
            meta[r["id"]] = {"language": payload.get("language", ""),
                             "writing_direction": payload.get("writing_direction", "")}
        if sleep:
            _time.sleep(sleep)
    return out, meta


# ---------------------------------------------------------------------------
# Consensus
# ---------------------------------------------------------------------------

def pick_consensus(candidates, min_agree=3, tol=0.10):
    """Medoid vote over {engine: text}.

    Returns (text, tier, agreement_count). The medoid — the candidate with the most peers within
    `tol` CER, tie-broken by lowest total distance — is more robust than exact-match voting,
    which would reject a unanimous reading over a single full-width/half-width difference.
    """
    items = [(engine, text) for engine, text in candidates.items() if normalize_text(text)]
    if not items:
        return "", "unresolved", 0
    if len(items) == 1:
        return items[0][1], "unresolved", 1

    best = ((0, 0.0), 0, 0)
    for i, (_engine_i, text_i) in enumerate(items):
        agree, distance = 0, 0.0
        for j, (_engine_j, text_j) in enumerate(items):
            if i == j:
                continue
            d = cer(text_j, text_i)
            if d is None:
                continue
            distance += d
            if d <= tol:
                agree += 1
        score = (-agree, distance)
        if i == 0 or score < best[0]:
            best = (score, i, agree)

    _score, idx, agree = best
    total_agree = agree + 1
    tier = "consensus" if total_agree >= min_agree else "unresolved"
    return items[idx][1], tier, total_agree


# ---------------------------------------------------------------------------
# Gold review page
# ---------------------------------------------------------------------------

REVIEW_CSS = """
:root{color-scheme:light dark}
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px;max-width:1100px}
h1{font-size:20px;margin:0 0 4px}
p.lead{margin:0 0 24px;opacity:.75}
.region{display:grid;grid-template-columns:320px 1fr;gap:20px;padding:20px 0;border-top:1px solid #8883}
.crop{max-width:100%;border:1px solid #8886;border-radius:6px;background:#fff}
.cand{display:flex;gap:8px;align-items:baseline;margin:3px 0}
.cand b{flex:0 0 150px;font-weight:600;opacity:.7;font-size:12px}
.cand code{font-size:15px;word-break:break-all}
.pick{cursor:pointer;background:#8882;border:0;border-radius:4px;padding:1px 7px;font-size:11px}
textarea{width:100%;font-size:16px;padding:8px;box-sizing:border-box;min-height:56px;
  border-radius:6px;border:1px solid #8886;background:transparent;color:inherit}
.tier{font-size:11px;padding:2px 8px;border-radius:99px;margin-left:8px}
.consensus{background:#2a7a2a33;color:#2a7a2a}
.unresolved{background:#a8341433;color:#c2410c}
#save{position:sticky;bottom:20px;padding:12px 20px;font-size:15px;border-radius:8px;
  border:0;background:#2563eb;color:#fff;cursor:pointer;margin-top:24px}
"""

REVIEW_JS = """
function pick(id,text){document.getElementById('t-'+id).value=text}
function save(){
  const out=REGIONS.map(r=>({id:r.id,text:document.getElementById('t-'+r.id).value}));
  const blob=new Blob([JSON.stringify({sample_id:SAMPLE,regions:out},null,2)],
                      {type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=SAMPLE+'.json';a.click();
}
"""


def write_review_html(out_dir, sample_id, img, regions):
    review_dir = os.path.join(out_dir, "_review")
    os.makedirs(review_dir, exist_ok=True)

    blocks = []
    for r in regions:
        x, y, w, h = r["bbox"]
        crop = img[y:y + h, x:x + w]
        ok, buf = cv2.imencode(".png", crop)
        b64 = base64.b64encode(buf).decode() if ok else ""
        cands = "".join(
            f'<div class="cand"><b>{html.escape(engine)}</b>'
            f'<button class="pick" onclick="pick(\'{r["id"]}\',{json.dumps(text)})">use</button>'
            f'<code>{html.escape(text) or "<i>(empty)</i>"}</code></div>'
            for engine, text in (r.get("candidates") or {}).items()
        )
        blocks.append(
            f'<div class="region"><div><img class="crop" src="data:image/png;base64,{b64}">'
            f'<div style="font-size:12px;opacity:.6;margin-top:6px">{r["id"]} · {w}x{h}'
            f'<span class="tier {r["tier"]}">{r["tier"]}</span></div></div>'
            f'<div>{cands}<textarea id="t-{r["id"]}">{html.escape(r["text"])}</textarea></div></div>'
        )

    doc = (f'<!doctype html><meta charset="utf-8"><title>OCR gold review — {sample_id}</title>'
           f"<style>{REVIEW_CSS}</style>"
           f"<h1>OCR gold review — {sample_id}</h1>"
           f'<p class="lead">Compare each crop against the engine candidates. Click <b>use</b> to '
           f'take one, or edit freely. Then <b>Save</b> and run:<br>'
           f'<code>python scripts/build_ocr_corpus.py --apply-review '
           f'scripts/ocr_corpus/_review/{sample_id}.json</code></p>'
           + "".join(blocks) +
           f'<button id="save" onclick="save()">Save {sample_id}.json</button>'
           f"<script>const SAMPLE={json.dumps(sample_id)};"
           f"const REGIONS={json.dumps([{'id': r['id']} for r in regions])};{REVIEW_JS}</script>")

    path = os.path.join(review_dir, f"{sample_id}.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(doc)
    return path


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def build_sample(sample_id, examples_dir, out_dir, engines_cfg, args):
    sample_dir = os.path.join(examples_dir, sample_id)
    meta = load_sample_meta(sample_dir)
    if meta is None:
        return None, "no meta.json — run scripts/organize_examples.py first"

    lang = meta["source"].get("lang", "ja")
    src_path = os.path.join(sample_dir, meta["source"]["file"])
    raw = imread_unicode(src_path)
    if raw is None:
        return None, f"could not read {src_path}"
    img = downscale(raw)

    from benchmark_vlm_ocr import get_all_text_regions
    proposals = get_all_text_regions(img, LANG_NAME.get(lang, "Japanese"))
    if not proposals:
        return None, "no text regions detected"

    regions = [{"id": f"r{i + 1}", "bbox": p["bbox"], "type": p.get("type", "bubble"),
                "polygon": p.get("mask_polygon")} for i, p in enumerate(proposals)]

    candidates = {}
    for variant in args.paddle_variants:
        print(f"  [{variant}] transcribing {len(regions)} regions...")
        texts = paddle_transcribe_regions(img, regions, lang, variant)
        if texts is not None:
            candidates[variant] = texts

    lang_name = LANG_NAME.get(lang, "Japanese")
    for provider_name, provider_cfg, model_id, _model_name, _free in engines_cfg:
        print(f"  [{provider_name}/{model_id}] transcribing {len(regions)} regions...")
        texts, _extra = vlm_transcribe_regions(img, regions, provider_name, provider_cfg,
                                               model_id, lang_name, sleep=args.sleep)
        candidates[f"{provider_name}/{model_id}"] = texts

    tier_counts = {}
    for r in regions:
        per_engine = {engine: texts.get(r["id"], "") for engine, texts in candidates.items()}
        text, tier, agree = pick_consensus(per_engine, min_agree=args.min_agree, tol=args.tol)
        r.update({"text": text, "lang": lang, "direction": "vertical" if lang in ("ja", "zh") else "horizontal",
                  "tier": tier, "agreement": agree, "candidates": per_engine})
        tier_counts[tier] = tier_counts.get(tier, 0) + 1

    dest = os.path.join(out_dir, sample_id)
    os.makedirs(dest, exist_ok=True)
    cv2.imwrite(os.path.join(dest, "page.webp"), img,
                [int(cv2.IMWRITE_WEBP_QUALITY), WEBP_QUALITY])
    with open(os.path.join(dest, "regions.json"), "w", encoding="utf-8") as f:
        json.dump(regions, f, ensure_ascii=False, indent=2)
    with open(os.path.join(dest, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({
            "sample_id": sample_id,
            "source_image": f"examples/{sample_id}/{meta['source']['file']}",
            "source_lang": lang,
            "page_size": [img.shape[1], img.shape[0]],
            "region_count": len(regions),
            "tier_counts": tier_counts,
            "engines": sorted(candidates.keys()),
            "min_agree": args.min_agree,
            "tol": args.tol,
            "notes": "Region proposals come from the production path (YOLO bubble detection + "
                     "PaddleOCR background text merged by worker.services.merge_regions), so "
                     "detection is held constant across chat-VLM models and only transcription "
                     "is being scored. 'unresolved' regions are excluded from scoring.",
        }, f, ensure_ascii=False, indent=2)

    if sample_id in args.gold:
        path = write_review_html(out_dir, sample_id, img, regions)
        print(f"  review page: {path}")

    return dest, (f"{len(regions)} regions, " +
                  ", ".join(f"{n} {t}" for t, n in sorted(tier_counts.items())))


def apply_review(review_path, out_dir):
    with open(review_path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    sample_id = payload["sample_id"]
    edits = {r["id"]: r["text"] for r in payload["regions"]}

    regions_path = os.path.join(out_dir, sample_id, "regions.json")
    with open(regions_path, "r", encoding="utf-8") as f:
        regions = json.load(f)

    changed = 0
    for r in regions:
        if r["id"] in edits:
            if r["text"] != edits[r["id"]]:
                changed += 1
            r["text"] = edits[r["id"]]
            r["tier"] = "gold"
    with open(regions_path, "w", encoding="utf-8") as f:
        json.dump(regions, f, ensure_ascii=False, indent=2)

    meta_path = os.path.join(out_dir, sample_id, "meta.json")
    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
    meta["tier_counts"] = {"gold": len(regions)}
    meta["reviewed"] = True
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"{sample_id}: promoted {len(regions)} regions to gold ({changed} text corrections)")


def main():
    parser = argparse.ArgumentParser(description="Build a ground-truthed OCR corpus from examples/")
    parser.add_argument("--examples-dir", default=DEFAULT_EXAMPLES)
    parser.add_argument("--out-dir", default=DEFAULT_OUT)
    parser.add_argument("--sample", help="Only build this sample id")
    parser.add_argument("--providers-config", default=DEFAULT_PROVIDERS_CONFIG)
    parser.add_argument("--provider", help="Only use this provider's vision models as engines")
    parser.add_argument("--model", help="Only use this model as an engine")
    parser.add_argument("--max-engines", type=int, default=3,
                        help="Cap on cloud vision models used for consensus (default 3)")
    parser.add_argument("--include-paid", action="store_true",
                        help="Allow paid models as engines (default: free models only)")
    parser.add_argument("--local-only", action="store_true",
                        help="PaddleOCR variants only, no API calls")
    parser.add_argument("--paddle-variants", default=",".join(DEFAULT_PADDLE_VARIANTS),
                        help="Comma-separated local PaddleOCR engines to vote with. "
                             f"Available: {', '.join(PADDLE_VARIANTS)}. "
                             f"Default: {','.join(DEFAULT_PADDLE_VARIANTS)} (two generations, so "
                             "the pool reaches --min-agree without needing unanimity). "
                             "Pass an empty string to skip local engines.")
    parser.add_argument("--min-agree", type=int, default=3,
                        help="Engines that must agree within --tol for tier 'consensus'")
    parser.add_argument("--tol", type=float, default=0.10, help="CER tolerance for agreement")
    parser.add_argument("--gold", default="", help="Comma-separated sample ids to emit review pages for")
    parser.add_argument("--review-only", action="store_true",
                        help="Regenerate review pages from existing regions.json, no transcription")
    parser.add_argument("--apply-review", help="Fold a reviewed JSON back in and promote to gold")
    parser.add_argument("--sleep", type=float, default=0.0, help="Seconds between region requests")
    args = parser.parse_args()
    args.gold = {s for s in args.gold.split(",") if s}
    args.paddle_variants = [v for v in args.paddle_variants.split(",") if v]
    unknown = [v for v in args.paddle_variants if v not in PADDLE_VARIANTS]
    if unknown:
        sys.exit(f"[ERROR] unknown --paddle-variants {unknown}; available: {list(PADDLE_VARIANTS)}")

    if args.apply_review:
        apply_review(args.apply_review, args.out_dir)
        return

    if args.review_only:
        for sample_id in sorted(args.gold, key=lambda s: int(re.sub(r"\D", "", s) or 0)):
            dest = os.path.join(args.out_dir, sample_id)
            img = imread_unicode(os.path.join(dest, "page.webp"))
            with open(os.path.join(dest, "regions.json"), "r", encoding="utf-8") as f:
                regions = json.load(f)
            print(write_review_html(args.out_dir, sample_id, img, regions))
        return

    engines_cfg = []
    if not args.local_only:
        providers_cfg = load_providers_config(args.providers_config)
        engines_cfg = list(list_candidate_models(providers_cfg, "ocr", args.provider,
                                                 args.include_paid, args.model))[:args.max_engines]
        if not engines_cfg:
            print("[WARN] No cloud vision models matched — falling back to PaddleOCR only. "
                  "Every region will be tier 'unresolved'.")

    sample_dirs = sorted(
        (d for d in os.listdir(args.examples_dir)
         if re.fullmatch(r"sample\d+", d) and os.path.isdir(os.path.join(args.examples_dir, d))),
        key=lambda d: int(re.sub(r"\D", "", d)),
    )
    if args.sample:
        sample_dirs = [d for d in sample_dirs if d == args.sample]
        if not sample_dirs:
            sys.exit(f"[ERROR] {args.sample} not found under {args.examples_dir}")

    os.makedirs(args.out_dir, exist_ok=True)
    results = []
    for sample_id in sample_dirs:
        print(f"\n=== {sample_id} ===")
        dest, msg = build_sample(sample_id, args.examples_dir, args.out_dir, engines_cfg, args)
        status = "OK" if dest else "SKIPPED"
        print(f"  {status}: {msg}")
        results.append({"sample_id": sample_id, "status": status, "detail": msg})

    manifest_path = os.path.join(args.out_dir, "_manifest.json")
    by_id = {}
    if os.path.exists(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            try:
                by_id = {m["sample_id"]: m for m in json.load(f)}
            except json.JSONDecodeError:
                by_id = {}
    for r in results:
        by_id[r["sample_id"]] = r
    for sid in [s for s in by_id if not os.path.exists(os.path.join(args.out_dir, s, "regions.json"))]:
        del by_id[sid]
    entries = sorted(by_id.values(), key=lambda m: int(re.sub(r"\D", "", m["sample_id"]) or 0))
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)
    print(f"\nManifest written to {manifest_path} ({len(entries)} entries)")


if __name__ == "__main__":
    main()
