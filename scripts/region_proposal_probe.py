#!/usr/bin/env python3
"""
region_proposal_probe.py — the tooling behind docs/region_threshold_validation_2026-08-08.md.

Reproduces the region proposals a page would get under a given merge configuration, without
running any engine and without writing to the corpus. Three modes:

    sweep       vary the *in-bubble* split threshold (ocr.py:605) and count regions
    overlay     draw one configuration's regions on the page so a count can be checked
                against the art instead of against another number
    direction   merge the same fragments as vertical (rtl) and horizontal (ltr) text, to
                separate a threshold problem from an orientation one

Production applies two different thresholds on two different paths, and conflating them is the
easy mistake here:

    ocr.py:605   split fragments *inside* a YOLO bubble     hardcoded threshold_ratio=2.0
    ocr.py:663   merge fragments matched to *no* bubble     OCR_MERGE_THRESHOLD from the env

`sweep` therefore moves only the in-bubble threshold and pins the unmatched path, which is what
makes sample23 a valid control: it has no bubbles, so its count must not move.

    python scripts/region_proposal_probe.py sweep sample30 --truth 7
    python scripts/region_proposal_probe.py overlay sample27 --in-threshold 0.35 --out /tmp
    python scripts/region_proposal_probe.py direction sample23 --truth 17
"""

import argparse
import json
import os
import sys
import tempfile

import cv2
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
sys.path.insert(0, SCRIPT_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "worker", "src"))

os.environ.setdefault("PADDLEX_OFFLINE_MODE", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("FLAGS_use_mkldnn", "0")

DEFAULT_CORPUS = os.path.join(REPO_ROOT, "corpus", "ocr")
SWEEP_VALUES = (0.15, 0.25, 0.35, 0.5, 0.75, 1.0, 1.5, 2.0)

# The value merge_ocr_regions falls back to when given no threshold. Note docker-compose.yml
# deploys OCR_MERGE_THRESHOLD=1.0, i.e. double this — see render_quality_gap_2026-08-05.md §D4.
CODE_DEFAULT_THRESHOLD = 0.50


def load_page(sample, corpus_dir):
    path = os.path.join(corpus_dir, sample, "page.webp")
    img = cv2.imread(path)
    if img is None:
        raise SystemExit(f"no page at {path}")
    return img


def proposals(sample, corpus_dir, reader_cache):
    """YOLO bubbles plus PaddleOCR fragments, each fragment assigned to a bubble or to -1.

    Mirrors the assignment rule the benchmark and the handler both use: best mask overlap wins,
    and a fragment overlapping no mask is 'unmatched'.
    """
    from benchmark_local_ocr import init_paddleocr
    from worker.services.bubble_detector import detect_bubbles_yolo
    from worker.services.ocr import parse_paddle_ocr_results
    from worker.utils.image import downscale_for_ocr

    img = load_page(sample, corpus_dir)
    h, w = img.shape[:2]
    bubbles = detect_bubbles_yolo(img) or []

    if "reader" not in reader_cache:
        reader_cache["reader"] = init_paddleocr("japan", "PP-OCRv6_medium_det", "PP-OCRv6_medium_rec")
    scaled, upscale = downscale_for_ocr(img, max_dim=1024)

    frags = []
    for bbox, text, conf in parse_paddle_ocr_results(reader_cache["reader"].predict(scaled)):
        xs = [p[0] * upscale for p in bbox]
        ys = [p[1] * upscale for p in bbox]
        x, y = int(min(xs)), int(min(ys))
        frags.append({"text": text, "detectedLanguage": "ja", "confidence": float(conf),
                      "x": x, "y": y, "width": int(max(xs) - x), "height": int(max(ys) - y)})

    masks = []
    for b in bubbles:
        m = np.zeros((h, w), dtype=np.uint8)
        poly = b.get("mask_polygon")
        if poly:
            cv2.fillPoly(m, [np.array(poly, dtype=np.int32)], (255,))
        else:
            bx, by, bw, bh = b["bbox"]
            m[by:by + bh, bx:bx + bw] = 255
        masks.append(m)

    for f in frags:
        best, best_ov = -1, 0
        x1, y1 = max(0, f["x"]), max(0, f["y"])
        x2, y2 = min(w, f["x"] + f["width"]), min(h, f["y"] + f["height"])
        if x2 > x1 and y2 > y1:
            for i, m in enumerate(masks):
                ov = int(np.sum(m[y1:y2, x1:x2] > 0))
                if ov > best_ov:
                    best, best_ov = i, ov
        f["bubble_idx"] = best

    return img, bubbles, frags


def build_regions(bubbles, frags, in_thr, un_thr, direction="rtl"):
    """Region proposals for one configuration, tagged by which merge path produced them."""
    from worker.services.merge_regions import merge_ocr_regions

    regs = []
    for i, bub in enumerate(bubbles):
        inside = [f for f in frags if f["bubble_idx"] == i]
        if not inside:
            regs.append((tuple(bub["bbox"]), "bubble", ""))
            continue
        for s in merge_ocr_regions(inside, direction, threshold_ratio=in_thr):
            regs.append(((s["x"], s["y"], s["width"], s["height"]), "bubble", s.get("text", "")))

    unmatched = [f for f in frags if f["bubble_idx"] == -1]
    if unmatched:
        for s in merge_ocr_regions(unmatched, direction, threshold_ratio=un_thr):
            regs.append(((s["x"], s["y"], s["width"], s["height"]), "direct", s.get("text", "")))
    return regs


def cmd_sweep(args, reader_cache):
    img, bubbles, frags = proposals(args.sample, args.corpus, reader_cache)
    h, w = img.shape[:2]
    unmatched = sum(1 for f in frags if f["bubble_idx"] == -1)

    print(f"{args.sample}: page {w}x{h}, {len(bubbles)} YOLO bubbles, {len(frags)} fragments, "
          f"{unmatched} unmatched (path pinned at {args.unmatched_threshold}).  truth={args.truth}\n")

    rows = []
    for thr in SWEEP_VALUES:
        regs = build_regions(bubbles, frags, thr, args.unmatched_threshold, args.direction)
        n_bubble = sum(1 for _, kind, _ in regs if kind == "bubble")
        n_direct = len(regs) - n_bubble
        giant = sum(1 for (_, _, rw, rh), _, _ in regs if rh > 0.5 * h or rw > 0.5 * w)
        rows.append({"thr": thr, "total": len(regs), "bubble": n_bubble,
                     "direct": n_direct, "giant": giant})
        mark = " <-- matches truth" if args.truth and len(regs) == args.truth else ""
        print(f"  in-bubble threshold={thr:<5} -> {len(regs):3d} regions "
              f"({n_bubble} bubble + {n_direct} direct_text)  giant={giant}{mark}")

    if len({r["total"] for r in rows}) == 1:
        print(f"\n  CONTROL: the in-bubble threshold does not govern this page "
              f"(constant at {rows[0]['total']} regions).")

    if args.json:
        with open(args.json, "w") as fh:
            json.dump({"sample": args.sample, "truth": args.truth, "page": [w, h],
                       "bubbles": len(bubbles), "fragments": len(frags),
                       "unmatched": unmatched, "rows": rows}, fh, indent=2)
        print(f"\nwrote {args.json}")


def cmd_overlay(args, reader_cache):
    img, bubbles, frags = proposals(args.sample, args.corpus, reader_cache)
    regs = build_regions(bubbles, frags, args.in_threshold, args.unmatched_threshold, args.direction)

    vis = img.copy()
    for j, ((x, y, w, h), kind, _) in enumerate(regs):
        col = (0, 180, 0) if kind == "bubble" else (220, 60, 0)
        cv2.rectangle(vis, (x, y), (x + w, y + h), col, 3)
        cv2.putText(vis, str(j), (x + 3, max(16, y - 5)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, col, 2)

    os.makedirs(args.out, exist_ok=True)
    name = os.path.join(args.out, f"{args.sample}_in{args.in_threshold}_un{args.unmatched_threshold}.png")
    cv2.imwrite(name, vis)
    print(f"{args.sample}: {len(regs)} regions "
          f"(green = split from a bubble, orange = unmatched/direct_text) -> {name}")
    for j, ((x, y, w, h), kind, text) in enumerate(regs):
        print(f"  {j:2d} {kind:7s} [{x},{y},{w},{h}]  {text[:44]!r}")


def cmd_direction(args, reader_cache):
    """Is a page's over-merging a threshold problem or an orientation one?

    merge_ocr_regions reads reading_direction == 'rtl' as 'the text is vertical' and sizes the
    vertical gap budget from avg_width. On horizontally-set text avg_width is a whole line, so
    the budget swallows the paragraph spacing and everything chains.
    """
    from worker.services.merge_regions import merge_ocr_regions

    _, bubbles, frags = proposals(args.sample, args.corpus, reader_cache)
    if not frags:
        raise SystemExit("no fragments on this page")

    avg_w = sum(f["width"] for f in frags) / len(frags)
    avg_h = sum(f["height"] for f in frags) / len(frags)
    wide = sum(1 for f in frags if f["width"] > f["height"])
    print(f"{args.sample}: {len(bubbles)} bubbles, {len(frags)} fragments, truth={args.truth}")
    print(f"  avg fragment {avg_w:.0f}x{avg_h:.0f} px; {wide}/{len(frags)} wider than tall "
          f"(=> {'horizontal' if wide * 2 > len(frags) else 'vertical'} lines)\n")

    print(f"{'thr':>6} | {'rtl (vertical assumption)':>27} | {'ltr (horizontal assumption)':>27}")
    print(f"{'-' * 6}-+-{'-' * 27}-+-{'-' * 27}")
    for thr in SWEEP_VALUES:
        n_rtl = len(merge_ocr_regions(frags, "rtl", threshold_ratio=thr))
        n_ltr = len(merge_ocr_regions(frags, "ltr", threshold_ratio=thr))
        m_rtl = " <-- truth" if args.truth and n_rtl == args.truth else ""
        m_ltr = " <-- truth" if args.truth and n_ltr == args.truth else ""
        print(f"{thr:>6} | {n_rtl:>10} regions{m_rtl:<13} | {n_ltr:>10} regions{m_ltr:<13}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=("sweep", "overlay", "direction"))
    ap.add_argument("sample", help="corpus/ocr sample id, e.g. sample30")
    ap.add_argument("--truth", type=int, default=0, help="hand-counted text areas on the page")
    ap.add_argument("--corpus", default=DEFAULT_CORPUS)
    ap.add_argument("--direction", default="rtl", choices=("rtl", "ltr"))
    ap.add_argument("--in-threshold", type=float, default=0.35,
                    help="in-bubble split threshold (overlay mode)")
    ap.add_argument("--unmatched-threshold", type=float, default=CODE_DEFAULT_THRESHOLD,
                    help=f"threshold for the unmatched/direct_text path (default {CODE_DEFAULT_THRESHOLD}, "
                         "the code default; production deploys 1.0)")
    # Deliberately outside the repo: overlays are throwaway, and corpus/ is a submodule whose
    # diff should stay meaningful.
    ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "region_probe"),
                    help="overlay output directory")
    ap.add_argument("--json", help="sweep mode: also write the table here")
    args = ap.parse_args()

    reader_cache = {}
    {"sweep": cmd_sweep, "overlay": cmd_overlay, "direction": cmd_direction}[args.mode](args, reader_cache)


if __name__ == "__main__":
    main()
