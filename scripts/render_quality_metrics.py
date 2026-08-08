#!/usr/bin/env python3
"""Score a rendered page against its original for artwork damage.

Two numbers, both "lower is better", both computed without any reference output:

  altered      % of page pixels that differ from the original at all. Includes the text we
               *meant* to change, so a high value is only suspicious, not wrong on its own.

  flattened    % of page pixels where the original carried local detail (line art, screentone,
               gradients) and the render carries none. This is the one that matters: a flat
               fill painted over artwork lands here, and correctly typeset text does not,
               because glyphs have as much local variance as the ink they replaced.

Measured 2026-08-05 over the 31-page `examples/` set (see
docs/render_quality_gap_2026-08-05.md): ours averaged 6.85% flattened against 1.92% for
mangatranslator.ai / mangatranslate.com / human scanlation, and lost on every single page.
Treat >5% flattened as a failing page and >3% as a regression.

Usage:
    python scripts/render_quality_metrics.py ORIGINAL RENDER [RENDER ...]
    python scripts/render_quality_metrics.py --suite examples/
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

# A pixel counts as "changed" when any channel moves by more than this. Above JPEG ringing,
# below anything a human would call a difference.
CHANGE_THRESHOLD = 24

# Local standard deviation, over a 9x9 window, that counts as "carries detail" in the source
# and as "carries nothing" in the render. The gap between the two is deliberate: a pixel has
# to go from clearly textured to essentially flat before it is called destroyed.
DETAIL_SD = 10.0
FLAT_SD = 2.0


def _local_sd(gray: np.ndarray) -> np.ndarray:
    x = gray.astype(np.float32)
    mean = cv2.blur(x, (9, 9))
    mean_sq = cv2.blur(x * x, (9, 9))
    return np.sqrt(np.maximum(mean_sq - mean * mean, 0.0))


def _load(path: Path, flags: int) -> np.ndarray:
    img = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), flags)
    if img is None:
        raise ValueError(f"could not decode {path}")
    return img


def score(original: Path, render: Path) -> dict[str, float]:
    """Return {'altered': pct, 'flattened': pct} for one render against its source page."""
    src_color = _load(original, cv2.IMREAD_COLOR)
    out_color = _load(render, cv2.IMREAD_COLOR)
    if src_color.shape[:2] != out_color.shape[:2]:
        out_color = cv2.resize(out_color, (src_color.shape[1], src_color.shape[0]))

    diff = np.abs(src_color.astype(np.int16) - out_color.astype(np.int16)).max(axis=2)
    altered = float((diff > CHANGE_THRESHOLD).mean() * 100)

    src_sd = _local_sd(cv2.cvtColor(src_color, cv2.COLOR_BGR2GRAY))
    out_sd = _local_sd(cv2.cvtColor(out_color, cv2.COLOR_BGR2GRAY))
    flattened = float(((src_sd > DETAIL_SD) & (out_sd < FLAT_SD)).mean() * 100)

    return {"altered": altered, "flattened": flattened}


def _suite(root: Path) -> int:
    """Score every corpus/samples/sampleN that has a source page and one of our renders.

    Source and render come from the sample's meta.json (written by scripts/flatten_samples.py)
    rather than from filename guessing — the old "original"/"orginal" stem sniffing picked the
    English page as the source on several samples.
    """
    rows: list[tuple[str, str, float, float]] = []

    for sample in sorted(root.glob("sample*"), key=lambda p: (len(p.name), p.name)):
        meta_path = sample / "meta.json"
        if not meta_path.is_file():
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        source = sample / meta["source"]["file"]
        if not source.is_file():
            print(f"{sample.name}: source {source.name} missing", file=sys.stderr)
            continue
        renders = [sample / rel for key, rel in meta.get("output", {}).items()
                   if key in ("frontend_export", "worker_render") and (sample / rel).is_file()]
        originals = [source]
        for render in renders:
            try:
                s = score(originals[0], render)
            except Exception as exc:  # a mismatched pair is worth reporting, not fatal
                print(f"{sample.name}: {render.name}: {exc}", file=sys.stderr)
                continue
            rows.append((sample.name, render.name, s["altered"], s["flattened"]))

    if not rows:
        print(f"no scorable pages under {root}", file=sys.stderr)
        return 1

    print(f"{'sample':10} {'render':34} {'altered':>9} {'flattened':>10}")
    for name, render, altered, flattened in rows:
        flag = "  FAIL" if flattened > 5.0 else ""
        print(f"{name:10} {render:34} {altered:8.2f}% {flattened:9.2f}%{flag}")

    flat = [r[3] for r in rows]
    print(f"\n{len(rows)} pages   mean flattened {np.mean(flat):.2f}%   max {max(flat):.2f}%")
    print("reference: mangatranslator.ai / mangatranslate.com / human scanlation ~1.9% mean")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="*", type=Path, help="ORIGINAL RENDER [RENDER ...]")
    ap.add_argument("--suite", type=Path, help="score every sample dir under this directory")
    args = ap.parse_args()

    if args.suite:
        return _suite(args.suite)

    if len(args.paths) < 2:
        ap.error("need an original and at least one render, or --suite")

    original, *renders = args.paths
    worst = 0.0
    for render in renders:
        s = score(original, render)
        print(f"{render.name:40} altered {s['altered']:6.2f}%   flattened {s['flattened']:6.2f}%")
        worst = max(worst, s["flattened"])
    return 1 if worst > 5.0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
