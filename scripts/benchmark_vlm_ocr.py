"""
benchmark_vlm_ocr.py — Repeatable OCR-stage benchmark across every vision model in
config/providers.json, run against every page in corpus/ocr/.

Mirrors benchmark_translation.py: corpus-driven rather than single-image, scored against
ground truth rather than eyeballed, and everything lands under --out-dir with a _summary.json
instead of scattering demo JPEGs into the working directory.

Two things it measures that the previous version could not:
  * Accuracy. Mean CER and exact-match rate per model against corpus/ocr/'s
    regions.json (gold or multi-engine-consensus text) — previously there was no ground truth
    at all, so a run only told you a model returned *something*.
  * Real structured-output support, via bench_common.run_ladder's json_schema -> json_object
    -> none ladder. The old code hardcoded response_format=json_object with no retry, so a
    model supporting only json_schema, or only plain prompting, looked like a hard failure.

Usage:
    # Quick smoke test on the corpus baseline page
    python scripts/benchmark_vlm_ocr.py --provider openrouter --out-dir /tmp/ocrbench

    # Every free vision model over the whole corpus
    python scripts/benchmark_vlm_ocr.py --corpus-subset all --out-dir runs/ocr-2026-08

    # One-off page outside the corpus (no accuracy scoring — no ground truth to score against)
    python scripts/benchmark_vlm_ocr.py --image corpus/samples/sample36/source.jpg \
        --out-dir /tmp/ocrbench

See docs/run_ocr_bench.md for methodology and how to read the output.
"""

import os
import re
import sys
import cv2
import json
import base64
import time
import argparse
import requests
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from provider_config import (  # noqa: E402
    load_env,
    load_providers_config,
    resolve_base_url,
    build_headers,
    list_candidate_models,
    list_specialized_models,
)
from bench_common import (  # noqa: E402
    apply_response_format,
    run_ladder,
    cer,
    normalize_text,
    iou,
    print_summary_table,
)

# worker/src is where worker.* actually lives (see scripts/build_translation_corpus.py's
# same fix) — this previously pointed at a nonexistent ../../unified-workers, which silently
# degraded detect_bubbles_yolo and the background-text merge path to no-ops.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'worker', 'src')))

try:
    from worker.services.bubble_detector import detect_bubbles_yolo
except ImportError:
    print("Warning: Could not import detect_bubbles_yolo. Make sure PYTHONPATH is set correctly.")
    detect_bubbles_yolo = None

load_env(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.env')))

DEFAULT_PROVIDERS_CONFIG = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "config", "providers.json"))
DEFAULT_CORPUS_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "corpus", "ocr"))

# The corpus baseline page — the smoke-test default, mirroring benchmark_translation.py's
# QUICK_SUBSET. sample36 is a clean 3-panel layout with well-separated bubbles and an
# attributed human reference.
QUICK_SUBSET = ["sample36"]

# nemotron-ocr-v2 (and any future entry under a provider's models.ocr_specialized_non_chat)
# is a dedicated computer-vision endpoint, not an OpenAI-style chat completion — it takes a
# flat {"input": [{"type": "image_url", ...}]} payload and returns text_detections, not
# choices[].message.content. It runs once per whole page, not per region crop, and reuses
# its parent provider's auth (keyEnvVar) rather than declaring its own baseUrl/headers, so we
# special-case it here instead of trying to force it through the generic chat call path.
NVIDIA_OCR_URL = "https://ai.api.nvidia.com/v1/cv/nvidia/nemotron-ocr-v2"

# The response contract the prompt below asks for. Passed to the json_schema rung of the
# structured-output ladder; the json_object and none rungs fall back to prompt-only compliance.
OCR_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "text": {"type": "string"},
        "language": {"type": "string"},
        "writing_direction": {"type": "string", "enum": ["horizontal", "vertical"]},
    },
    "required": ["text", "language", "writing_direction"],
    "additionalProperties": False,
}


def build_ocr_prompt(language):
    return f"""You are an OCR engine processing {language} manga.
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


def call_vlm_ocr(image_crop, provider_name, provider_cfg, model_id, language, retries=1):
    """Call a chat-completion-shaped VLM API with the bubble crop, walking the structured-output
    ladder. Models under a provider's models.ocr_specialized_non_chat (e.g. nemotron-ocr-v2)
    don't go through this — see call_nvidia_ocr_v2() and main()'s specialized-model loop."""
    try:
        url = resolve_base_url(provider_cfg["baseUrl"])
        headers = build_headers(provider_cfg)
    except ValueError as e:
        return {"error": str(e)}

    ok, buffer = cv2.imencode('.jpg', image_crop)
    if not ok:
        return {"error": "cv2.imencode failed on crop"}
    base64_image = base64.b64encode(buffer).decode('utf-8')
    prompt = build_ocr_prompt(language)

    def build_payload(mode):
        payload = {
            "model": model_id,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url",
                     "image_url": {"url": f"data:image/jpeg;base64,{base64_image}"}},
                ],
            }],
        }
        if provider_name == "openrouter":
            payload["plugins"] = [{"id": "response-healing"}]
        return apply_response_format(payload, mode, OCR_JSON_SCHEMA)

    outcome = run_ladder(url, headers, build_payload, retries=retries, timeout=60)
    if outcome["status"] != "ok":
        last = outcome["attempts_log"][-1]["error"] if outcome["attempts_log"] else "unknown"
        return {"error": last, "attempts_log": outcome["attempts_log"]}

    result = outcome["result"]
    if not isinstance(result, dict):
        return {"error": f"expected a JSON object, got {type(result).__name__}"}
    return {
        "result": result,
        "time": outcome["elapsed_s"],
        "mode_used": outcome["mode_used"],
        "prompt_tokens": outcome["prompt_tokens"],
        "completion_tokens": outcome["completion_tokens"],
    }


def call_nvidia_ocr_v2(img, regions_list, nvidia_provider_cfg):
    """Full-page OCR via nemotron-ocr-v2's dedicated CV endpoint, then intersect its
    detections against each already-detected region's bbox. Returns (results, total_time)
    in the same per-region shape the chat-model path produces, or (None, error_message)."""
    try:
        headers = build_headers(nvidia_provider_cfg)
    except ValueError as e:
        return None, str(e)
    headers["Accept"] = "application/json"

    start_time = time.time()
    scale = 1.0
    while True:
        resized = cv2.resize(img, (0, 0), fx=scale, fy=scale)
        _, buffer = cv2.imencode('.jpg', resized, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        b64 = base64.b64encode(buffer).decode('utf-8')
        if len(b64) < 175000:
            break
        scale -= 0.1

    payload = {'input': [{'type': 'image_url', 'url': f'data:image/jpeg;base64,{b64}'}]}

    try:
        resp = requests.post(NVIDIA_OCR_URL, headers=headers, json=payload, timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        return None, str(e)

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
                full_text_detections.append({"text": text, "nx1": min_x, "ny1": min_y, "nx2": max_x, "ny2": max_y})

    total_time = time.time() - start_time
    print(f"  -> Full image OCR took {total_time:.2f}s. Detected {len(full_text_detections)} text regions.")

    results = []
    for i, r_item in enumerate(regions_list):
        x, y, w, h = r_item['bbox']
        px, py = max(0, x - 10), max(0, y - 10)
        pw, ph = min(img.shape[1] - px, w + 20), min(img.shape[0] - py, h + 20)

        bnx1, bny1 = px / img.shape[1], py / img.shape[0]
        bnx2, bny2 = (px + pw) / img.shape[1], (py + ph) / img.shape[0]

        intersecting_texts = []
        for det in full_text_detections:
            ix1, iy1 = max(bnx1, det["nx1"]), max(bny1, det["ny1"])
            ix2, iy2 = min(bnx2, det["nx2"]), min(bny2, det["ny2"])
            if ix1 < ix2 and iy1 < iy2:
                intersecting_texts.append(det["text"])

        final_text = "\n".join(intersecting_texts).strip() or "[No Text Detected]"
        print(f"  -> Region {i+1}/{len(regions_list)} Text: {final_text}")
        results.append({"bbox": [px, py, pw, ph], "text": final_text, "language": "", "dir": ""})

    return results, total_time

def draw_results(image, results, output_path, model_name, stats=None):
    """Draw bounding boxes and OCR text on the image, similar to PP-OCRv5 demo."""
    img_draw = image.copy()

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

            draw.rectangle([x, y, x+w, y+h], outline=(255, 0, 0), width=3)

            text = res.get('text', '')
            if not text:
                text = "[No Text Detected]"

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

    # Ensure bounding boxes are integers and within image bounds
    for r in regions_list:
        x, y, w, h = r["bbox"]
        rx = max(0, min(img.shape[1]-1, int(x)))
        ry = max(0, min(img.shape[0]-1, int(y)))
        rw = max(1, min(img.shape[1]-rx, int(w)))
        rh = max(1, min(img.shape[0]-ry, int(h)))
        r["bbox"] = [rx, ry, rw, rh]

    return regions_list


# ---------------------------------------------------------------------------
# Corpus loading (corpus/ocr/<sampleId>/{page.webp,regions.json,meta.json})
# ---------------------------------------------------------------------------

def load_corpus_page(corpus_dir, sample_id):
    base = os.path.join(corpus_dir, sample_id)
    with open(os.path.join(base, "regions.json"), "r", encoding="utf-8") as f:
        regions = json.load(f)
    meta = {}
    meta_path = os.path.join(base, "meta.json")
    if os.path.exists(meta_path):
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
    page_path = os.path.join(base, "page.webp")
    img = cv2.imdecode(np.fromfile(page_path, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f"could not decode {page_path}")
    return img, regions, meta


def resolve_corpus_pages(corpus_dir, subset, explicit_pages, quick_subset):
    if explicit_pages:
        return explicit_pages
    if not os.path.isdir(corpus_dir):
        return []
    all_pages = sorted(
        (d for d in os.listdir(corpus_dir)
         if os.path.isdir(os.path.join(corpus_dir, d))
         and os.path.exists(os.path.join(corpus_dir, d, "regions.json"))),
        key=lambda d: int(re.sub(r"\D", "", d) or 0),
    )
    if subset == "all":
        return all_pages
    if subset == "quick":
        return [p for p in quick_subset if p in all_pages] or all_pages[:1]
    if subset == "clean":
        # Pages whose ground truth is entirely gold or consensus — no unresolved regions.
        clean = []
        for p in all_pages:
            _, regions, _ = load_corpus_page(corpus_dir, p)
            if regions and all(r.get("tier") in ("gold", "consensus") for r in regions):
                clean.append(p)
        return clean
    raise ValueError(f"Unknown --corpus-subset {subset!r}")


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score_page(results, ground_truth):
    """CER / exact-match of per-region OCR output against the corpus ground truth.

    Regions whose ground-truth tier is "unresolved" are excluded — the consensus pass could not
    agree on them, so scoring against that text would measure noise.
    """
    by_id = {g["id"]: g for g in ground_truth}
    per_region, cers, exact = {}, [], 0
    scored = 0
    for res in results:
        gt = by_id.get(res.get("id"))
        if gt is None or gt.get("tier") == "unresolved":
            per_region[res.get("id")] = None
            continue
        value = cer(res.get("text", ""), gt.get("text", ""))
        per_region[res.get("id")] = value
        if value is None:
            continue
        cers.append(value)
        scored += 1
        if normalize_text(res.get("text", "")) == normalize_text(gt.get("text", "")):
            exact += 1
    return {
        "per_region_cer": per_region,
        "mean_cer": round(sum(cers) / len(cers), 4) if cers else None,
        "exact_match_rate": round(exact / scored, 4) if scored else None,
        "scored_region_count": scored,
    }


def crop_for_region(img, bbox, pad=10):
    """The padded crop every engine transcribes. Returns (crop, [x, y, w, h] of the crop).

    The 10px margin is load-bearing, not a courtesy: PaddleOCR's detection boxes are tight enough
    to clip glyph edges, and the cloud VLMs see the crop with no page context. Production does not
    pad at all (handlers/ocr.py:686 uses pad=0) — this is a corpus/benchmark concern only.

    Do not add sibling-aware clipping here without re-reading this. Stopping the margin reaching
    into the next region is a real defect — on sample10's countdown, four ~25px lines whose boxes
    already overlap, the pad pulls each neighbour wholly into the crop and the same digits are
    transcribed two and three times (character precision 0.791 against 0.916 with it clipped).
    But five variants were measured on 2026-08-09 and **every one that clipped cost more recall
    than it bought precision**, on `production` boxes as well as split ones:

        A  pad 10, no clipping (this)          P 0.937  R 0.919
        B  clip at the midpoint to a sibling   P 0.953  R 0.845
        C  B + margin capped at 15% of the box P 0.948  R 0.842
        D  B but never clipping into the bbox  P 0.953  R 0.910
        E  D + neighbour must share >=50%      P 0.955  R 0.909

    D and E are the sound versions and still lose recall, because a region whose box genuinely
    overlaps its neighbour's cannot be padded without either duplicating text or dropping it —
    the two cases have the same geometry and no threshold separates them. Recall is the gate, so
    A wins. A fix has to work on the *text* (drop characters the neighbouring crop also produced)
    rather than on the box. See docs/region_waist_probe_2026-08-09.md.
    """
    x, y, w, h = bbox
    px, py = max(0, x - pad), max(0, y - pad)
    pw = min(img.shape[1] - px, w + 2 * pad)
    ph = min(img.shape[0] - py, h + 2 * pad)
    return img[py:py + ph, px:px + pw], [px, py, pw, ph]


def run_model_on_page(img, regions_list, provider_name, provider_cfg, model_id, lang, sleep=0.0):
    """OCR every region of one page with one chat-VLM model."""
    results = []
    total_time = 0.0
    tokens_in = tokens_out = 0
    modes = set()
    errors = []

    for i, item in enumerate(regions_list):
        crop, padded = crop_for_region(img, item["bbox"])
        if crop.size == 0:
            errors.append(f"region {item.get('id', i)}: empty crop")
            continue
        res = call_vlm_ocr(crop, provider_name, provider_cfg, model_id, lang)
        if "error" in res:
            errors.append(f"region {item.get('id', i)}: {res['error']}")
            results.append({"id": item.get("id"), "bbox": padded, "text": "",
                            "language": "", "dir": "", "error": res["error"]})
        else:
            payload = res["result"]
            total_time += res["time"]
            tokens_in += res["prompt_tokens"]
            tokens_out += res["completion_tokens"]
            modes.add(res["mode_used"])
            results.append({
                "id": item.get("id"),
                "bbox": padded,
                "text": payload.get("text", "") or "",
                "language": payload.get("language", "") or "",
                "dir": payload.get("writing_direction", "") or "",
                "mode_used": res["mode_used"],
            })
        if sleep:
            time.sleep(sleep)

    return {
        "regions": results,
        "total_time": round(total_time, 3),
        "prompt_tokens": tokens_in,
        "completion_tokens": tokens_out,
        "modes_used": sorted(modes),
        "errors": errors,
    }


def score_detection(results, ground_truth, threshold=0.5):
    """For whole-page engines that do their own detection: IoU coverage of the corpus regions."""
    matched = 0
    for gt in ground_truth:
        if any(iou(gt["bbox"], r["bbox"]) >= threshold for r in results):
            matched += 1
    return {
        "detection_recall": round(matched / len(ground_truth), 4) if ground_truth else None,
        "matched": matched,
        "total": len(ground_truth),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Repeatable OCR benchmark across config/providers.json vision models "
                    "and corpus/ocr/ pages")
    parser.add_argument("--corpus-dir", default=DEFAULT_CORPUS_DIR)
    parser.add_argument("--corpus-subset", choices=["quick", "clean", "all"], default="quick",
                        help="quick=the baseline page only (default); clean=pages with no "
                             "unresolved ground-truth regions; all=every corpus page")
    parser.add_argument("--pages", help="Comma-separated corpus sample ids, overrides --corpus-subset")
    parser.add_argument("--image", help="One-off page outside the corpus. Runs detection instead "
                                        "of using corpus regions, and reports no accuracy scores.")
    parser.add_argument("--lang", default="Japanese", help="Source language for the OCR prompt")
    parser.add_argument("--providers-config", default=DEFAULT_PROVIDERS_CONFIG,
                        help="Path to a providers.json-shaped file. config/providers.json is the "
                             "curated production list; scripts/test-providers.json is the wider, "
                             "unvetted candidate pool.")
    parser.add_argument("--provider", help="Only this provider (openrouter/cloudflare/nvidia)")
    parser.add_argument("--model", help="Only this model id")
    parser.add_argument("--free-only", action="store_true", default=True, help="Default: free models only")
    parser.add_argument("--include-paid", dest="free_only", action="store_false", help="Also test paid models")
    parser.add_argument("--skip-specialized", action="store_true",
                        help="Skip provider models.ocr_specialized_non_chat entries (e.g. nemotron-ocr-v2)")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--sleep", type=float, default=0.0, help="Seconds between region requests")
    parser.add_argument("--overlays", action="store_true", help="Also write annotated demo images")
    args = parser.parse_args()

    providers_cfg = load_providers_config(args.providers_config)
    # models.ocr is pre-filtered to vision-capable models by whoever built the providers config
    # (see docs/translation_bench.md and scripts/test-providers.json's generation notes) — this
    # script trusts that filtering rather than re-deriving modality itself.
    candidates = list(list_candidate_models(providers_cfg, "ocr", args.provider,
                                            not args.free_only, args.model))
    specialized = [] if args.skip_specialized else list(
        list_specialized_models(providers_cfg, "ocr_specialized_non_chat", args.provider, args.model)
    )
    if not candidates and not specialized:
        print("[ERROR] No matching OCR (VLM) models found in the providers config for the given filters.")
        print("        config/providers.json's 'ocr' lists are mostly paid — try --providers-config "
              "scripts/test-providers.json --include-paid, or narrow with --provider/--model.")
        sys.exit(1)

    # --- assemble the pages to run -------------------------------------------------
    if args.image:
        img = cv2.imdecode(np.fromfile(args.image, dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            sys.exit(f"[ERROR] Could not load image: {args.image}")
        print("Running text region detection (speech bubbles + background direct text)...")
        regions_list = get_all_text_regions(img, args.lang)
        print(f"Detected {len(regions_list)} text regions.")
        if not regions_list:
            sys.exit("[ERROR] No text regions detected.")
        pages = [("(one-off)", img, regions_list, None)]
    else:
        page_ids = args.pages.split(",") if args.pages else None
        page_ids = resolve_corpus_pages(args.corpus_dir, args.corpus_subset, page_ids, QUICK_SUBSET)
        if not page_ids:
            print(f"[ERROR] No corpus pages resolved for subset={args.corpus_subset!r} in "
                  f"{args.corpus_dir}. Run scripts/build_ocr_corpus.py first.")
            sys.exit(1)
        pages = []
        for sample_id in page_ids:
            img, regions, _meta = load_corpus_page(args.corpus_dir, sample_id)
            pages.append((sample_id, img, regions, regions))

    os.makedirs(args.out_dir, exist_ok=True)
    total_runs = (len(candidates) + len(specialized)) * len(pages)
    print(f"\n[INFO] {len(candidates)} chat-VLM + {len(specialized)} specialized model(s) "
          f"x {len(pages)} page(s) = {total_runs} run(s)")
    print(f"[INFO] pages: {[p[0] for p in pages]}")

    summary = []
    run_index = 0

    for provider_name, provider_cfg, model_id, model_name, free in candidates:
        model_dir = os.path.join(args.out_dir, provider_name,
                                 model_id.replace("/", "_").replace(":", "_"))
        os.makedirs(model_dir, exist_ok=True)
        page_scores = []

        for sample_id, img, regions_list, ground_truth in pages:
            run_index += 1
            print(f"\n[{run_index}/{total_runs}] {provider_name}/{model_id}  page={sample_id}  "
                  f"({len(regions_list)} regions)")
            run = run_model_on_page(img, regions_list, provider_name, provider_cfg,
                                    model_id, args.lang, sleep=args.sleep)
            record = {"provider": provider_name, "model": model_id, "sample_id": sample_id, **run}
            if ground_truth:
                record["quality"] = score_page(run["regions"], ground_truth)
                q = record["quality"]["mean_cer"]
                print(f"  CER={q if q is not None else 'n/a'}  "
                      f"exact={record['quality']['exact_match_rate']}  "
                      f"modes={run['modes_used']}  {run['total_time']}s  "
                      f"errors={len(run['errors'])}")
            else:
                print(f"  modes={run['modes_used']}  {run['total_time']}s  errors={len(run['errors'])}")

            with open(os.path.join(model_dir, f"{sample_id}.json"), "w", encoding="utf-8") as f:
                json.dump(record, f, ensure_ascii=False, indent=2)
            if args.overlays:
                draw_results(img, run["regions"], os.path.join(model_dir, f"{sample_id}-overlay.jpg"),
                             f"{provider_name}/{model_id}", {"Total Time": f"{run['total_time']}s"})
            page_scores.append(record)

        summary.append(_summarize(provider_name, model_id, model_name, free, page_scores, pages))

    for provider_name, provider_cfg, model_id, model_name, note in specialized:
        if model_id != "nvidia/nemotron-ocr-v2":
            print(f"\n[SKIP] No special-case handler wired up for {model_id} — add one alongside "
                  f"call_nvidia_ocr_v2() if this is a new non-chat CV endpoint.")
            continue
        nvidia_cfg = providers_cfg["providers"].get("nvidia", provider_cfg)
        model_dir = os.path.join(args.out_dir, provider_name,
                                 model_id.replace("/", "_").replace(":", "_"))
        os.makedirs(model_dir, exist_ok=True)
        page_scores = []

        for sample_id, img, regions_list, ground_truth in pages:
            run_index += 1
            print(f"\n[{run_index}/{total_runs}] {provider_name}/{model_id}  page={sample_id}")
            results, elapsed_or_err = call_nvidia_ocr_v2(img, regions_list, nvidia_cfg)
            if results is None:
                print(f"  FAILED: {elapsed_or_err}")
                page_scores.append({"provider": provider_name, "model": model_id,
                                    "sample_id": sample_id, "regions": [], "total_time": 0,
                                    "prompt_tokens": 0, "completion_tokens": 0,
                                    "modes_used": [], "errors": [str(elapsed_or_err)]})
                continue
            for res, item in zip(results, regions_list):
                res["id"] = item.get("id")
            record = {"provider": provider_name, "model": model_id, "sample_id": sample_id,
                      "regions": results, "total_time": round(elapsed_or_err, 3),
                      "prompt_tokens": 0, "completion_tokens": 0,
                      "modes_used": ["cv_endpoint"], "errors": []}
            if ground_truth:
                record["quality"] = score_page(results, ground_truth)
                record["detection"] = score_detection(results, ground_truth)
                print(f"  CER={record['quality']['mean_cer']}  "
                      f"detection_recall={record['detection']['detection_recall']}")
            with open(os.path.join(model_dir, f"{sample_id}.json"), "w", encoding="utf-8") as f:
                json.dump(record, f, ensure_ascii=False, indent=2)
            page_scores.append(record)

        summary.append(_summarize(provider_name, model_id, model_name, True, page_scores, pages))

    # Best CER first, then fastest. Models with no scored page sort last.
    summary.sort(key=lambda s: (s["mean_cer"] if s["mean_cer"] is not None else 9.0,
                                s["mean_latency_s"] or float("inf")))
    summary_path = os.path.join(args.out_dir, "_summary.json")
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print_summary_table(
        summary,
        [("cer", "mean_cer", lambda v: f"{v:.3f}"),
         ("exact", "exact_match_rate", lambda v: f"{v:.3f}"),
         ("lat", "mean_latency_s", lambda v: f"{v:.1f}s"),
         ("err", "error_count", lambda v: str(v))],
        "SUMMARY (sorted by CER asc, then latency asc)",
    )
    print(f"\nSaved summary to {summary_path}")


def _summarize(provider_name, model_id, model_name, free, page_scores, pages):
    cers = [p["quality"]["mean_cer"] for p in page_scores
            if p.get("quality") and p["quality"]["mean_cer"] is not None]
    exacts = [p["quality"]["exact_match_rate"] for p in page_scores
              if p.get("quality") and p["quality"]["exact_match_rate"] is not None]
    latencies = [p["total_time"] for p in page_scores if p.get("total_time")]
    modes = sorted({m for p in page_scores for m in p.get("modes_used", [])})
    return {
        "provider": provider_name,
        "model": model_id,
        "model_name": model_name,
        "free": free,
        "pages_attempted": len(pages),
        "pages_ok": sum(1 for p in page_scores if p.get("regions")),
        "mean_cer": round(sum(cers) / len(cers), 4) if cers else None,
        "exact_match_rate": round(sum(exacts) / len(exacts), 4) if exacts else None,
        "mean_latency_s": round(sum(latencies) / len(latencies), 2) if latencies else None,
        "total_prompt_tokens": sum(p.get("prompt_tokens", 0) for p in page_scores),
        "total_completion_tokens": sum(p.get("completion_tokens", 0) for p in page_scores),
        "error_count": sum(len(p.get("errors", [])) for p in page_scores),
        "modes_used": modes,
    }


if __name__ == "__main__":
    main()
