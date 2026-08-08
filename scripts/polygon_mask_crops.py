#!/usr/bin/env python3
"""
polygon_mask_crops.py — Defect B from docs/region_proposal_defects_2026-08.md, as a standalone
experiment: crop a region to its *balloon polygon* instead of its axis-aligned bounding box, and
measure whether the local engines then agree where they previously did not.

The problem: YOLO emits irregular/diagonal balloons whose axis-aligned bbox is far bigger than the
balloon. On sample3 r2 and sample30 r4 the polygon fills only ~64% of the bbox, so **36% of the
cropped pixels are outside the balloon** — neighbouring art and neighbouring *text*, which the
engine transcribes. Those regions never reach consensus because the engines are disagreeing about
text that should not be in the crop.

This deliberately does NOT touch `crop_for_region`, so it cannot perturb a corpus build that is
already running. Nothing is written unless you pass --apply.

    python scripts/polygon_mask_crops.py --sample sample3            # compare, write nothing
    python scripts/polygon_mask_crops.py --sample sample3 --dump-crops out/
    python scripts/polygon_mask_crops.py --sample sample3 --apply    # overwrite candidates
"""

import os
import re
import sys
import json
import argparse

import cv2
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
sys.path.insert(0, SCRIPT_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "worker", "src"))

DEFAULT_CORPUS = os.path.join(REPO_ROOT, "corpus", "ocr")


def polygon_points(region):
    """The balloon outline as an (N,2) int array in page coordinates, or None."""
    poly = region.get("polygon") or region.get("mask_polygon")
    if not poly:
        return None
    pts = np.array(poly, dtype=np.float64).reshape(-1, 2)
    return pts.astype(np.int32) if len(pts) >= 3 else None


def polygon_fill_ratio(region):
    """polygon area / bbox area. Low values are the regions this fix targets."""
    pts = polygon_points(region)
    if pts is None:
        return None
    _x, _y, w, h = region["bbox"]
    if w <= 0 or h <= 0:
        return None
    return float(cv2.contourArea(pts)) / float(w * h)


def masked_crop_for_region(img, region, pad=10, fill=255):
    """Padded crop with everything outside the balloon polygon painted `fill`.

    Falls back to the plain padded crop when the region carries no usable polygon, so this is
    safe to apply corpus-wide: `direct_text` regions simply pass through unchanged.
    """
    x, y, w, h = region["bbox"]
    px, py = max(0, x - pad), max(0, y - pad)
    pw = min(img.shape[1] - px, w + 2 * pad)
    ph = min(img.shape[0] - py, h + 2 * pad)
    crop = img[py:py + ph, px:px + pw]

    pts = polygon_points(region)
    if pts is None or crop.size == 0:
        return crop, [px, py, pw, ph], False

    mask = np.zeros(crop.shape[:2], dtype=np.uint8)
    cv2.fillPoly(mask, [pts - np.array([px, py], dtype=np.int32)], (255,))
    if not mask.any():
        # Polygon lies outside the padded window — trust the bbox rather than blank the crop.
        return crop, [px, py, pw, ph], False

    out = np.full_like(crop, fill)
    np.copyto(out, crop, where=mask[:, :, None].astype(bool))
    return out, [px, py, pw, ph], True


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", default=DEFAULT_CORPUS)
    ap.add_argument("--sample", help="Only this sample id (default: every sample)")
    ap.add_argument("--variant", default="paddleocr_v6_medium",
                    help="Local engine used for the comparison")
    ap.add_argument("--lang", default="ja", help="Source language key, e.g. ja")
    ap.add_argument("--min-fill", type=float, default=0.95,
                    help="Only report regions whose polygon fills less than this of the bbox")
    ap.add_argument("--dump-crops", help="Write before/after PNGs to this directory")
    ap.add_argument("--apply", action="store_true",
                    help="Overwrite this engine's stored candidates with the masked reading")
    args = ap.parse_args()

    from build_ocr_corpus import PADDLE_VARIANTS
    from build_translation_corpus import parse_paddle_ocr_results, SOURCE_LANG_TO_PADDLE
    from benchmark_local_ocr import init_paddleocr
    from benchmark_vlm_ocr import crop_for_region
    from bench_common import cer

    samples = sorted((d for d in os.listdir(args.corpus) if re.fullmatch(r"sample\d+", d)),
                     key=lambda s: int(s[6:]))
    if args.sample:
        samples = [s for s in samples if s == args.sample]
        if not samples:
            sys.exit(f"[ERROR] {args.sample} not in {args.corpus}")

    det, rec = PADDLE_VARIANTS[args.variant]
    reader = init_paddleocr(SOURCE_LANG_TO_PADDLE.get(args.lang, "japan"), det, rec)
    if reader is None:
        sys.exit(f"[ERROR] could not initialise {args.variant}")

    if args.dump_crops:
        os.makedirs(args.dump_crops, exist_ok=True)

    n_masked = n_changed = 0
    for sample_id in samples:
        rpath = os.path.join(args.corpus, sample_id, "regions.json")
        if not os.path.exists(rpath):
            continue
        with open(rpath, encoding="utf-8") as f:
            regions = json.load(f)
        img = cv2.imread(os.path.join(args.corpus, sample_id, "page.webp"))
        if img is None:
            continue

        for r in regions:
            fill = polygon_fill_ratio(r)
            if fill is None or fill >= args.min_fill:
                continue
            masked, _, did = masked_crop_for_region(img, r)
            if not did:
                continue
            plain, _ = crop_for_region(img, r["bbox"])
            n_masked += 1

            def read(crop):
                if crop.size == 0:
                    return ""
                try:
                    return "".join(t for _b, t, _c in
                                   parse_paddle_ocr_results(reader.predict(crop))).strip()
                except Exception as e:  # noqa: BLE001
                    return f"<error {e}>"

            before, after = read(plain), read(masked)
            if before != after:
                n_changed += 1
            print(f"\n{sample_id} {r['id']}  {r['bbox'][2]}x{r['bbox'][3]}  "
                  f"polygon fills {fill:.0%}  tier={r.get('tier')}  cer={cer(before, after)}")
            print(f"    bbox   {before[:80]!r}")
            print(f"    masked {after[:80]!r}")

            if args.dump_crops:
                cv2.imwrite(os.path.join(args.dump_crops, f"{sample_id}_{r['id']}_bbox.png"), plain)
                cv2.imwrite(os.path.join(args.dump_crops, f"{sample_id}_{r['id']}_masked.png"), masked)
            if args.apply:
                r.setdefault("candidates", {})[args.variant] = after

        if args.apply:
            with open(rpath, "w", encoding="utf-8") as f:
                json.dump(regions, f, ensure_ascii=False, indent=2)

    print(f"\n{n_masked} region(s) had a polygon under {args.min_fill:.0%} fill; "
          f"{n_changed} read differently when masked."
          + ("" if args.apply else "  (nothing written — pass --apply)"))
    if args.apply:
        print("Now re-vote:  python scripts/retier_ocr_corpus.py --min-agree 2 --tol 0.10")


if __name__ == "__main__":
    main()
