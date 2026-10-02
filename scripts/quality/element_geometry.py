#!/usr/bin/env python3
"""R2 — one line per visible translation element: region, box, plate, shape, size.

The named acceptance case in tracker row R2 (the *19th Sept ch.1 p5* left caption) is judged on
geometry the reference harness does not print: how far the plate extends past the glyph extent,
what `box_shape` says, how many vertices the polygon has, and whether the resolved font px came
back. This reads a capture directory's `page-snapshot.json` and prints exactly that.

    .venv/bin/python scripts/quality/element_geometry.py docs/quality-runs/<run>/a04-exports/<sample>

Columns: region bbox (x,y,w,h) · container (bubble bbox if the worker found one, else "free") ·
text box (x,y,w,h) · plate: vertex count and the bounds' overhang past the region bbox on each
side (left/top/right/bottom, px; "none" when there is no polygon) · box_shape · size (px) · text.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def parse_polygon(raw):
    if not raw:
        return None
    try:
        pts = json.loads(raw) if isinstance(raw, str) else raw
    except json.JSONDecodeError:
        return None
    if not isinstance(pts, list) or len(pts) < 3:
        return None
    return [(float(p[0]), float(p[1])) for p in pts if isinstance(p, list) and len(p) == 2]


def overhang(pts, region):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    rx, ry, rw, rh = region["bboxX"], region["bboxY"], region["bboxW"], region["bboxH"]
    return (
        round(rx - min(xs)),
        round(ry - min(ys)),
        round(max(xs) - (rx + rw)),
        round(max(ys) - (ry + rh)),
    )


def main(capture_dir: Path) -> int:
    snapshot = json.loads((capture_dir / "page-snapshot.json").read_text())
    regions = {r["id"]: r for r in snapshot.get("ocrRegions", [])}
    rows = []
    for entry in snapshot.get("layers", []):
        layer = entry["layer"]
        if str(layer.get("type", "")).lower() != "translation" or not layer.get("visible", True):
            continue
        for element in entry.get("elements", []):
            if not element.get("visible", True) or not (element.get("text") or "").strip():
                continue
            region = regions.get(element.get("regionId"))
            if region is None:
                continue
            free = region.get("bubbleW") == region["bboxW"] and region.get("bubbleH") == region["bboxH"]
            container = (
                "free"
                if free
                else f"{region.get('bubbleX')},{region.get('bubbleY')} {region.get('bubbleW')}x{region.get('bubbleH')}"
            )
            pts = parse_polygon(element.get("maskPolygon"))
            plate = "none" if pts is None else f"{len(pts)} pts, overhang l/t/r/b {overhang(pts, region)}"
            rows.append(
                " · ".join(
                    [
                        f"region {region['bboxX']},{region['bboxY']} {region['bboxW']}x{region['bboxH']}",
                        f"container {container}",
                        f"box {round(element['x'])},{round(element['y'])} {element.get('maxWidth')}x{element.get('maxHeight')}",
                        f"plate {plate}",
                        f"shape {element.get('boxShape')}",
                        f"size {element.get('size')}",
                        f"bg {element.get('backgroundColor')}",
                        repr((element.get("text") or "")[:40]),
                    ]
                )
            )
    print(f"{capture_dir.name}: {len(rows)} visible translation element(s)")
    for row in rows:
        print("  " + row)
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1])))
