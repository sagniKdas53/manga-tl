#!/usr/bin/env python3
"""Measure how the renderer sets type, over a whole exported corpus.

D6 and D7 (docs/render_quality_gap_2026-08-05.md) are both claims about geometry -- the type is
too small for the balloon, and it is fitted to a box that is not the shape it gets drawn into --
and neither can be settled by looking at pages. This runs the worker's own `fit_text_in_box_py`
over every translation element in `corpus/samples/<id>/project/project.json` and reports:

  fill      total laid-out text height / box height, per element. The references sit around
            0.70-0.85; anything under ~0.45 reads as a lonely sentence in a big balloon.
  escape    lines whose drawn extent leaves the mask polygon. The renderer measures a line's
            available span at the line's *centre* y, but glyphs occupy the whole line band, and
            an oval is narrower at the band's edges than at its middle. Counted per line.
  starved   elements whose longest word cannot fit the box width at 12px, so the search is
            forced below legibility no matter how much vertical room there is.

Usage:
    ../.venv/bin/python scripts/text_fit_probe.py [--samples corpus/samples] [--json out.json] [--verbose]

Run it from the repo root; it imports the worker in place, so it measures the code as deployed
rather than a copy of it.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "worker" / "src"))

os.environ.setdefault("REDIS_HOST", "localhost")

from worker.handlers.render import (  # noqa: E402
    BAND_SAMPLE_FRACTIONS as BAND_SAMPLES,
)
from worker.handlers.render import (  # noqa: E402
    fit_text_in_box_py,
    load_font,
)

LINE_HEIGHT_MULTIPLIER = 1.2


def parse_polygon(raw):
    if not raw:
        return None
    try:
        pts = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return None
    if isinstance(pts, list) and all(isinstance(p, (list, tuple)) and len(p) == 2 for p in pts):
        return pts
    return None


def span_at(polygon, y):
    """The widest horizontal run of `polygon` at height `y`, or None if it does not reach."""
    crossings = []
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        if (y1 <= y < y2) or (y2 <= y < y1):
            crossings.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
    if len(crossings) < 2:
        return None
    crossings.sort()
    best = None
    for i in range(0, len(crossings) - 1, 2):
        left, right = crossings[i], crossings[i + 1]
        if best is None or (right - left) > (best[1] - best[0]):
            best = (left, right)
    return best


def band_span(polygon, y_top, y_bottom):
    """The span available across a whole line band -- the narrowest of its sampled rows."""
    left = None
    right = None
    for t in BAND_SAMPLES:
        s = span_at(polygon, y_top + t * (y_bottom - y_top))
        if s is None:
            continue
        left = s[0] if left is None else max(left, s[0])
        right = s[1] if right is None else min(right, s[1])
    if left is None or right is None or right <= left:
        return None
    return (left, right)


def measure_element(el, font_name="Comic Neue"):
    text = el.get("text") or ""
    if not text.strip():
        return None
    box_w = el.get("maxWidth") or 0
    box_h = el.get("maxHeight") or 0
    if box_w <= 0 or box_h <= 0:
        return None
    # The same inset render_image_core applies before it calls the fitter. Measuring against the
    # raw element box would measure a box the renderer never uses.
    box_x = (el.get("x") or 0) + 4
    box_y = (el.get("y") or 0) + 4
    box_w = int((box_w - 8) * 0.95)
    box_h = int((box_h - 8) * 0.95)
    if box_w <= 0 or box_h <= 0:
        return None
    polygon = parse_polygon(el.get("maskPolygon"))
    font_name = el.get("font") or font_name
    bold = "bold" in (el.get("fontWeight") or "").lower()
    italic = "italic" in (el.get("fontStyle") or "").lower()

    fit = fit_text_in_box_py(
        text,
        box_w,
        box_h,
        font_name,
        shape="elliptical" if el.get("boxShape") == "elliptical" else "rectangular",
        box_x=box_x,
        box_y=box_y,
        mask_polygon=el.get("maskPolygon"),
        bold=bold,
        italic=italic,
    )
    size = fit["fontSize"]
    lines = fit["lines"]
    centers = fit.get("lineCenters") or []
    font = load_font(size, font_name=font_name, bold=bold, italic=italic)

    def width_of(s):
        if not font:
            return len(s) * size * 0.5
        try:
            return float(font.getlength(s))
        except Exception:
            return len(s) * size * 0.5

    line_height = size * LINE_HEIGHT_MULTIPLIER
    total_height = len(lines) * line_height
    widest = max((width_of(line) for line in lines), default=0.0)

    # Mirrors render.py's own test: the mask only constrains typesetting when it spans the box.
    # When it does not, the box is a deliberate reshape of a column-shaped free-text region and
    # the mask keeps only its erasing job -- so ink outside it is not a fit failure, it is text
    # drawn over art the fill never covered. Different defect, counted separately.
    mask_constrains = bool(polygon) and (
        min(p[0] for p in polygon) <= box_x + 2 and max(p[0] for p in polygon) >= box_x + box_w - 2
    )

    escapes = 0
    if polygon:
        y_start = box_y + (box_h - total_height) / 2
        for idx, line in enumerate(lines):
            if not line.strip():
                continue
            w = width_of(line)
            center_x = centers[idx] if idx < len(centers) else box_x + box_w / 2
            left, right = center_x - w / 2, center_x + w / 2
            top = y_start + idx * line_height
            span = band_span(polygon, top, top + line_height)
            if span is None or left < span[0] - 0.5 or right > span[1] + 0.5:
                escapes += 1

    longest_word = max((width_of(w) for w in text.split()), default=0.0)
    starved = (longest_word / max(size, 1) * 12) > box_w if size else False

    return {
        "size": size,
        "lines": len(lines),
        "fill": total_height / box_h,
        "width_fill": widest / box_w,
        "escapes": escapes if mask_constrains else 0,
        "outside_mask": 0 if mask_constrains else escapes,
        "mask_constrains": mask_constrains,
        "starved": bool(starved),
        "overflow": bool(fit.get("overflow")),
        "text": text,
        "box": [box_x, box_y, box_w, box_h],
    }


def sample_projects(samples_root):
    """Every flattened sample's project.json, as (sample_id, path), in sample-number order.

    This used to read `corpus/exports/<branch>/page-N-project.json`, a per-branch A/B capture that
    was deleted on 2026-08-16 (its findings live in corpus/docs/ab_region_grouping_2026-08-12.md).
    The per-sample layout is the durable one: it is what the app writes, what flatten_samples.py
    unpacks, and what render_quality_metrics.py and cover_fill_probe.py already read.
    """
    out = []
    for path in samples_root.glob("*/project/project.json"):
        out.append((path.parent.parent.name, path))
    for path in samples_root.glob("NSFW/*/project/project.json"):
        out.append(("NSFW/" + path.parent.parent.name, path))

    def key(item):
        stem = item[0].rsplit("/", 1)[-1]
        return (item[0].startswith("NSFW/"), int(stem.removeprefix("sample") or 0))

    return sorted(out, key=key)


def run(samples_root, verbose=False):
    rows = []
    for sample_id, page in sample_projects(samples_root):
        data = json.loads(page.read_text())
        for layer in data.get("layers", []):
            if layer.get("type") != "translation":
                continue
            for el in layer.get("elements", []):
                m = measure_element(el)
                if m is None:
                    continue
                m["sample"] = sample_id
                rows.append(m)
                if verbose and (m["fill"] < 0.45 or m["escapes"] or m["starved"]):
                    flags = []
                    if m["fill"] < 0.45:
                        flags.append(f"fill={m['fill']:.2f}")
                    if m["escapes"]:
                        flags.append(f"escapes={m['escapes']}")
                    if m["starved"]:
                        flags.append("starved")
                    print(
                        f"  {sample_id:<16} {m['size']:3d}px {'/'.join(flags):28s} {m['text'][:44]!r}",
                        flush=True,
                    )
    return rows


def summarise(rows, label):
    fills = [r["fill"] for r in rows]
    print(f"\n=== {label}  ({len(rows)} elements)")
    print(f"  median fill        {statistics.median(fills):.3f}")
    print(f"  mean fill          {statistics.mean(fills):.3f}")
    print(f"  under 0.45 fill    {sum(1 for f in fills if f < 0.45)}")
    print(f"  median font size   {statistics.median(r['size'] for r in rows):.0f}px")
    print(f"  lines escaping     {sum(r['escapes'] for r in rows)}"
          f"  (in {sum(1 for r in rows if r['escapes'])} elements, of "
          f"{sum(1 for r in rows if r['mask_constrains'])} mask-constrained)")
    print(f"  ink outside mask   {sum(r['outside_mask'] for r in rows)}"
          f"  (in {sum(1 for r in rows if r['outside_mask'])} reshaped free boxes)")
    print(f"  width-starved      {sum(1 for r in rows if r['starved'])}")
    print(f"  height overflow    {sum(1 for r in rows if r['overflow'])}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=Path, default=REPO / "corpus" / "samples",
                    help="corpus sample root (default: corpus/samples)")
    ap.add_argument("--json", type=Path, help="write the per-element rows here")
    ap.add_argument("--verbose", action="store_true", help="print every flagged element")
    args = ap.parse_args()

    rows = run(args.samples, verbose=args.verbose)
    summarise(rows, str(args.samples))
    if args.json:
        args.json.write_text(json.dumps(rows, indent=1))
        print(f"\nwrote {args.json}")


if __name__ == "__main__":
    main()
