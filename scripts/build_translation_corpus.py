#!/usr/bin/env python3
"""
build_translation_corpus.py — Build a text-only translation benchmark corpus from
examples/sampleN/ pages, using local PaddleOCR. Extracts the source-language regions and,
where a reference (paid/competitor/human) render exists, an aligned reference translation —
without ever saving the source images themselves into the corpus.

For each eligible examples/sampleN/:
  1. Full-page PaddleOCR (source language, default "japan") on the "original" image.
  2. Full-page PaddleOCR ("en") on the best available reference render, if one exists.
  3. Merge OCR line fragments into bubble-level regions with worker's merge_ocr_regions
     (the same function the production OCR pipeline uses).
  4. Order regions in manga reading order (row-banded, right-to-left) — this is a page-level
     heuristic, not the YOLO-panel-aware reading order the real pipeline computes, so treat
     ordering as approximate for pages with complex panel layouts.
  5. Greedy nearest-centroid match source regions to reference regions in normalized
     coordinate space (works because the reference render keeps text in the same bubble
     positions as the source — see docs/render_quality_gap_2026-08-05.md §3). Unmatched
     regions get a null reference.

Every entry is tagged with extraction_method: "auto-ocr" in meta.json. This is a heuristic
corpus, not ground truth — regionType defaults to "speech" for every auto region (OCR alone
can't reliably tell sign/sfx/caption apart), and alignment can be wrong on pages where the
reference render reflows text into different bubble positions. Spot-check before trusting a
page for a high-stakes comparison; sample28 in this corpus is hand-verified instead (see
extraction_method: "manual") and should be treated as the reliability baseline.

Usage:
    python scripts/build_translation_corpus.py --examples-dir examples --out-dir scripts/corpus
    python scripts/build_translation_corpus.py --sample sample4
    python scripts/build_translation_corpus.py --list-eligible
"""

import os
import sys
import re
import json
import glob
import argparse

import cv2
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(SCRIPT_DIR, "..", "worker", "src")))
sys.path.append(os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", "unified-workers")))

os.environ.setdefault("PADDLEX_OFFLINE_MODE", "1")
os.environ.setdefault("PADDLE_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")

try:
    from worker.services.merge_regions import merge_ocr_regions
except ImportError:
    print("[ERROR] Could not import worker.services.merge_regions. Run from the repo root "
          "with the .venv active (`source .venv/bin/activate`).")
    sys.exit(1)

ORIGINAL_STEMS = ("original", "orginal")  # both spellings appear in examples/
REFERENCE_PREFERENCE = (
    "en-mangatranslator.ai",
    "en-mangatranslate.com",
    "en-mangatranslate.online",
    "en-google-lens",
    "en-manga-tl-ai",
    "en-",       # any other en-* file
    "human-tl",
    "manga-tl",
)

MANUAL_SAMPLES = {"sample28"}   # hand-verified corpus entries; never overwritten by this script
EXCLUDED_SAMPLES = {"sample22"}  # dated leftover export, see render_quality_gap_2026-08-05.md
IMAGE_EXTS = (".jpg", ".jpeg", ".png")


def find_source_and_reference(sample_dir):
    files = [f for f in os.listdir(sample_dir) if f.lower().endswith(IMAGE_EXTS)]
    source = None
    for f in files:
        stem = f.rsplit(".", 1)[0].lower()
        if stem in ORIGINAL_STEMS or re.match(r"^(original|orginal)\.\d+$", stem):
            source = f
            break
    if source is None:
        # fallback: a file whose "en-<name>" sibling exists (render_quality_gap.md convention)
        names = set(files)
        for f in files:
            if f"en-{f}" in names:
                source = f
                break
    if source is None:
        return None, None

    reference = None
    for pref in REFERENCE_PREFERENCE:
        for f in files:
            if f == source:
                continue
            if f.lower().startswith(pref):
                reference = f
                break
        if reference:
            break
    return source, reference


def load_image(path):
    img = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    return img


def downscale_for_ocr(img, max_dim=1600):
    h, w = img.shape[:2]
    largest = max(h, w)
    if largest <= max_dim:
        return img, 1.0
    scale = max_dim / largest
    resized = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return resized, 1.0 / scale


def init_paddle_reader(lang):
    """lang="japan" uses the project's configured (PP-OCRv6 medium, tuned for manga JA/CJK)
    detection+recognition models via PADDLEOCR_*_MODEL env vars. Any other lang (e.g. "en")
    must NOT pass explicit model names — PaddleOCR ignores `lang` entirely when model names
    are given (see the "will be ignored when model names ... are not None" warning), which
    would silently run English reference renders through the CJK-tuned rec model and garble
    them into Chinese-flavored nonsense."""
    from paddleocr import PaddleOCR
    device = os.environ.get("PADDLEOCR_DEVICE", "cpu").strip().lower()
    if lang == "japan":
        det_model = os.environ.get("PADDLEOCR_DET_MODEL", "PP-OCRv5_mobile_det").strip()
        rec_model = os.environ.get("PADDLEOCR_REC_MODEL", "PP-OCRv5_mobile_rec").strip()
        return PaddleOCR(
            lang=lang,
            device=device,
            text_detection_model_name=det_model,
            text_recognition_model_name=rec_model,
            use_textline_orientation=False,
            use_doc_unwarping=False,
            use_doc_orientation_classify=False,
            enable_mkldnn=False,
        )
    return PaddleOCR(
        lang=lang,
        device=device,
        use_textline_orientation=False,
        use_doc_unwarping=False,
        use_doc_orientation_classify=False,
        enable_mkldnn=False,
    )


def parse_paddle_ocr_results(raw_results):
    results = []
    if raw_results is None:
        return results
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
    return results


def ocr_fragments(reader, img, lang_for_cjk_check):
    scaled, upscale = downscale_for_ocr(img, max_dim=1600)
    raw = reader.predict(scaled)
    parsed = parse_paddle_ocr_results(raw)
    fragments = []
    for bbox, text, conf in parsed:
        text = text.strip()
        if not text:
            continue
        xs = [pt[0] * upscale for pt in bbox]
        ys = [pt[1] * upscale for pt in bbox]
        x, y = min(xs), min(ys)
        w, h = max(xs) - x, max(ys) - y
        fragments.append({
            "x": x, "y": y, "width": w, "height": h,
            "text": text, "confidence": conf,
            "detectedLanguage": lang_for_cjk_check,
        })
    return fragments


def order_regions_page(regions, reading_direction="rtl", band_overlap_ratio=0.3):
    """Row-band the page top-to-bottom, then order each band right-to-left (or left-to-right).
    A page-level approximation of manga reading order — no panel/YOLO awareness."""
    if not regions:
        return []
    regions_sorted = sorted(regions, key=lambda r: r["y"])
    bands = []
    for r in regions_sorted:
        placed = False
        for band in bands:
            band_y0 = min(m["y"] for m in band)
            band_y1 = max(m["y"] + m["height"] for m in band)
            r_y0, r_y1 = r["y"], r["y"] + r["height"]
            overlap = max(0, min(band_y1, r_y1) - max(band_y0, r_y0))
            min_h = min(r["height"], band_y1 - band_y0) or 1
            if overlap / min_h > band_overlap_ratio:
                band.append(r)
                placed = True
                break
        if not placed:
            bands.append([r])
    bands.sort(key=lambda b: min(m["y"] for m in b))
    ordered = []
    for band in bands:
        key = (lambda r: -r["x"]) if reading_direction == "rtl" else (lambda r: r["x"])
        ordered.extend(sorted(band, key=key))
    return ordered


def align_regions(src_regions, src_dims, ref_regions, ref_dims, max_norm_dist=0.15):
    """Greedy nearest-centroid match in normalized (0..1) coordinate space. Relies on
    reference renders keeping text in the same bubble positions as the source page."""
    def center(r, w, h):
        return ((r["x"] + r["width"] / 2) / w, (r["y"] + r["height"] / 2) / h)

    src_c = [center(r, *src_dims) for r in src_regions]
    ref_c = [center(r, *ref_dims) for r in ref_regions]

    pairs = []
    for i, sc in enumerate(src_c):
        for j, rc in enumerate(ref_c):
            d = ((sc[0] - rc[0]) ** 2 + (sc[1] - rc[1]) ** 2) ** 0.5
            if d <= max_norm_dist:
                pairs.append((d, i, j))
    pairs.sort(key=lambda p: p[0])

    matched = {}
    used_ref = set()
    for d, i, j in pairs:
        if i in matched or j in used_ref:
            continue
        matched[i] = j
        used_ref.add(j)
    return matched


def build_regions_for_image(reader, image_path, lang_tag):
    """reading_direction feeds merge_ocr_regions's internal char-size heuristic and the
    sort order *within* a merged region. Japanese manga text is conventionally vertical
    columns (rtl); redrawn English reference text is horizontal (ltr). Full-page merging is
    outside this utility's original per-bubble-crop use case — on info-dense pages (many
    small scattered labels) it over-merges unrelated text into one blob, same failure mode
    as render_quality_gap_2026-08-05.md §D4. A tighter threshold_ratio than the production
    default (0.5) reduces that risk for full-page corpus extraction; fragment_count vs.
    region_count in meta.json flags pages where it still happened."""
    img = load_image(image_path)
    if img is None:
        return [], (0, 0), 0
    h, w = img.shape[:2]
    fragments = ocr_fragments(reader, img, lang_tag)
    if not fragments:
        return [], (w, h), 0
    direction = "rtl" if lang_tag == "ja" else "ltr"
    merged = merge_ocr_regions(fragments, reading_direction=direction, threshold_ratio=0.3)
    ordered = order_regions_page(merged, reading_direction=direction)
    return ordered, (w, h), len(fragments)


def build_sample(sample_dir, sample_id, ja_reader, en_reader, out_dir, min_confidence):
    source_file, reference_file = find_source_and_reference(sample_dir)
    if source_file is None:
        return None, "no source (original/orginal) image found"

    src_path = os.path.join(sample_dir, source_file)
    src_ordered, src_dims, src_fragment_count = build_regions_for_image(ja_reader, src_path, "ja")
    src_ordered = [r for r in src_ordered if r["confidence"] >= min_confidence]

    if not src_ordered:
        return None, "no confident text regions detected in source"

    regions = []
    for i, r in enumerate(src_ordered):
        regions.append({
            "id": f"r{i+1}",
            "panel": 1,
            "bubble": i + 1,
            "speaker": None,
            "regionType": "speech",
            "conversationGroup": None,
            "text": r["text"],
        })

    reference_translations = {r["id"]: None for r in regions}
    reference_provenance = None
    if reference_file:
        ref_path = os.path.join(sample_dir, reference_file)
        ref_ordered, ref_dims, _ref_fragment_count = build_regions_for_image(en_reader, ref_path, "en")
        ref_ordered = [r for r in ref_ordered if r["confidence"] >= min_confidence]
        if ref_ordered:
            matches = align_regions(src_ordered, src_dims, ref_ordered, ref_dims)
            for i, region in enumerate(regions):
                j = matches.get(i)
                if j is not None:
                    reference_translations[region["id"]] = ref_ordered[j]["text"]
            reference_provenance = reference_file

    dest = os.path.join(out_dir, sample_id)
    os.makedirs(dest, exist_ok=True)

    with open(os.path.join(dest, "regions.json"), "w", encoding="utf-8") as f:
        json.dump(regions, f, ensure_ascii=False, indent=2)

    matched_count = sum(1 for v in reference_translations.values() if v is not None)
    with open(os.path.join(dest, "reference.json"), "w", encoding="utf-8") as f:
        json.dump({
            "source_image": f"examples/{sample_id}/{source_file}",
            "reference_image": f"examples/{sample_id}/{reference_file}" if reference_file else None,
            "reference_provenance": reference_provenance,
            "reference_translations": reference_translations,
        }, f, ensure_ascii=False, indent=2)

    merge_ratio = round(len(regions) / src_fragment_count, 3) if src_fragment_count else None
    over_merge_risk = merge_ratio is not None and merge_ratio < 0.35 and src_fragment_count >= 6
    with open(os.path.join(dest, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({
            "sample_id": sample_id,
            "extraction_method": "auto-ocr",
            "region_count": len(regions),
            "source_fragment_count": src_fragment_count,
            "merge_ratio": merge_ratio,
            "over_merge_risk": over_merge_risk,
            "reference_matched_count": matched_count,
            "reference_match_rate": round(matched_count / len(regions), 3) if regions else 0,
            "notes": "regionType defaults to 'speech' (OCR alone can't classify sign/sfx/caption); "
                     "reading order is a row-banded page-level heuristic, not panel-aware. "
                     "over_merge_risk=true means region_count collapsed a lot relative to raw "
                     "OCR fragments — likely several unrelated text blocks were merged into one "
                     "region (see render_quality_gap_2026-08-05.md §D4); spot-check before use.",
        }, f, ensure_ascii=False, indent=2)

    return dest, f"{len(regions)} regions, {matched_count} matched to reference"


def main():
    parser = argparse.ArgumentParser(description="Build a text-only translation corpus from examples/")
    parser.add_argument("--examples-dir", default=os.path.join(SCRIPT_DIR, "..", "examples"))
    parser.add_argument("--out-dir", default=os.path.join(SCRIPT_DIR, "corpus"))
    parser.add_argument("--sample", help="Only build this one sample (e.g. sample4)")
    parser.add_argument("--min-confidence", type=float, default=0.5)
    parser.add_argument("--list-eligible", action="store_true", help="List eligible samples and exit, no OCR run")
    args = parser.parse_args()

    examples_dir = os.path.abspath(args.examples_dir)
    out_dir = os.path.abspath(args.out_dir)

    sample_dirs = sorted(
        d for d in glob.glob(os.path.join(examples_dir, "sample*"))
        if os.path.isdir(d)
    )

    eligible = []
    for d in sample_dirs:
        sample_id = os.path.basename(d)
        if sample_id in EXCLUDED_SAMPLES or sample_id in MANUAL_SAMPLES:
            continue
        if args.sample and sample_id != args.sample:
            continue
        source_file, reference_file = find_source_and_reference(d)
        if source_file is None:
            continue
        eligible.append((d, sample_id, source_file, reference_file))

    if args.list_eligible:
        for d, sample_id, source_file, reference_file in eligible:
            print(f"{sample_id}: source={source_file}  reference={reference_file or '(none)'}")
        print(f"\n{len(eligible)} eligible, {len(MANUAL_SAMPLES)} manual (skipped), "
              f"{len(EXCLUDED_SAMPLES)} excluded")
        return

    if not eligible:
        print("No eligible samples found.")
        return

    print("[INFO] Initializing PaddleOCR readers (japan, en)...")
    ja_reader = init_paddle_reader("japan")
    en_reader = init_paddle_reader("en")

    os.makedirs(out_dir, exist_ok=True)
    results = []
    for d, sample_id, source_file, reference_file in eligible:
        print(f"\n=== {sample_id} (source={source_file}, reference={reference_file or 'none'}) ===")
        dest, msg = build_sample(d, sample_id, ja_reader, en_reader, out_dir, args.min_confidence)
        status = "OK" if dest else "SKIPPED"
        print(f"  {status}: {msg}")
        results.append({"sample_id": sample_id, "status": status, "detail": msg})

    manifest_path = os.path.join(out_dir, "_manifest.json")
    manifest = []
    if os.path.exists(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            try:
                manifest = json.load(f)
            except json.JSONDecodeError:
                manifest = []
    by_id = {m["sample_id"]: m for m in manifest}
    for r in results:
        by_id[r["sample_id"]] = r
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(list(by_id.values()), f, ensure_ascii=False, indent=2)
    print(f"\nManifest written to {manifest_path}")


if __name__ == "__main__":
    main()
