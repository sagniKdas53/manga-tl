#!/usr/bin/env python3
"""Apply R1 and R2 to an already-exported page, so the change can be looked at before a full run.

R1 (reject a balloon that does not cover its text) and R2 (cover a region we cannot sample a flat
colour from, instead of drawing nothing) both live in `process_ocr`, which needs YOLO, PaddleOCR,
MinIO and an LLM to reach. Both decisions are pure functions of `(image, polygon, text box)`
though, so they can be replayed over an exported `project.json` -- this calls the real
`bubble_covers_text`, `cover_fill_for_region` and `dominant_color`, not copies of them.

    .venv/bin/python scripts/cover_fill_probe.py corpus/sample10/page-10-layers.zip --out /tmp/after.png

What it cannot replay: R3's junk gate keys on the recogniser's per-region confidence, which the
export does not carry. R3 is covered by unit tests instead.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "worker" / "src"))
os.environ.setdefault("REDIS_HOST", "localhost")

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

import worker.handlers.render as R  # noqa: E402
from worker.handlers.ocr import bubble_covers_text, cover_fill_for_region  # noqa: E402
from worker.handlers.render import readable_text_color  # noqa: E402


def load_export(path: Path):
    """(project dict, BGR image). Accepts a layers .zip or a directory holding project.json."""
    if path.suffix == ".zip":
        tmp = Path(tempfile.mkdtemp())
        with zipfile.ZipFile(path) as z:
            z.extractall(tmp)
        path = tmp
    project = json.loads((path / "project.json").read_text())
    img = cv2.imread(str(path / "original.png"))
    if img is None:
        raise SystemExit(f"no original.png beside {path / 'project.json'}")
    return project, img


def ocr_box_for(element, ocr_elements):
    """The OCR text box this translation element came from, by best overlap."""
    ex, ey = float(element.get("x") or 0), float(element.get("y") or 0)
    ew, eh = float(element.get("maxWidth") or 0), float(element.get("maxHeight") or 0)
    best, best_area = None, 0.0
    for o in ocr_elements:
        ox, oy = float(o.get("x") or 0), float(o.get("y") or 0)
        ow, oh = float(o.get("maxWidth") or 0), float(o.get("maxHeight") or 0)
        iw = max(0.0, min(ex + ew, ox + ow) - max(ex, ox))
        ih = max(0.0, min(ey + eh, oy + oh) - max(ey, oy))
        if iw * ih > best_area:
            best_area, best = iw * ih, (ox, oy, ow, oh)
    return best


def parse_poly(mask_polygon):
    if not mask_polygon:
        return None
    pts = json.loads(mask_polygon) if isinstance(mask_polygon, str) else mask_polygon
    return pts if isinstance(pts, list) and len(pts) >= 3 else None


def apply_r1_r2(project, img):
    """Rewrite each translation element's polygon and fill the way the fixed pipeline would.

    Returns the per-element decisions so the run can be counted, not just looked at.
    """
    img_h, img_w = img.shape[:2]
    ocr_layers = [layer for layer in project.get("layers", []) if layer.get("type") == "ocr"]
    ocr_elements = ocr_layers[-1].get("elements", []) if ocr_layers else []
    decisions = []

    for layer in project.get("layers", []):
        if layer.get("type") != "translation":
            continue
        for el in layer.get("elements", []):
            text = (el.get("text") or "").strip()
            if not text:
                continue
            poly = parse_poly(el.get("maskPolygon"))
            box = ocr_box_for(el, ocr_elements)
            rejected = False

            # R1: the polygon we shipped is only this text's balloon if it covers this text.
            if poly and box:
                mask = np.zeros((img_h, img_w), dtype=np.uint8)
                cv2.fillPoly(mask, [np.array(poly, dtype=np.int32)], 255)
                x1 = max(0, min(img_w - 1, int(box[0])))
                y1 = max(0, min(img_h - 1, int(box[1])))
                x2 = max(0, min(img_w, int(box[0] + box[2])))
                y2 = max(0, min(img_h, int(box[1] + box[3])))
                if x2 > x1 and y2 > y1 and not bubble_covers_text(mask, x1, y1, x2, y2):
                    rejected = True
                    poly = None  # falls through to the unenclosed path, exactly as the handler does

            bx, by, bw, bh = box if box else (el.get("x"), el.get("y"), el.get("maxWidth"), el.get("maxHeight"))
            before = el.get("backgroundColor")
            color, new_poly = cover_fill_for_region(img, poly, bx, by, bw, bh)

            el["backgroundColor"] = color
            el["maskPolygon"] = json.dumps(new_poly) if new_poly else None
            if new_poly:
                xs = [p[0] for p in new_poly]
                ys = [p[1] for p in new_poly]
                el["x"], el["y"] = min(xs), min(ys)
                el["maxWidth"], el["maxHeight"] = max(xs) - min(xs), max(ys) - min(ys)
                el["boxShape"] = "rectangular"

            decisions.append(
                {
                    "text": text[:34],
                    "r1_rejected": rejected,
                    "before": before,
                    "after": color,
                    "covered": bool(before is None and color),
                }
            )
    return decisions


def render(project, img):
    page = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(page)
    for layer in project.get("layers", []):
        if layer.get("type") != "translation" or not layer.get("visible", True):
            continue
        for el in layer.get("elements", []):
            text = el.get("text") or ""
            if not text.strip():
                continue
            ex, ey = int(el.get("x") or 0), int(el.get("y") or 0)
            ew, eh = int(el.get("maxWidth") or 50), int(el.get("maxHeight") or 50)
            box_shape = el.get("boxShape") or "rectangular"
            region_type = el.get("regionType")
            if region_type == "speech" or (region_type is None and box_shape == "elliptical"):
                text = text.upper()
            bg = el.get("backgroundColor")
            fg = readable_text_color(el.get("backgroundColor"), el.get("textColor") or "#000000")
            bold = "bold" in (el.get("fontWeight") or "").lower()
            italic = "italic" in (el.get("fontStyle") or "").lower()
            mask_polygon = el.get("maskPolygon")
            font_name = el.get("font") or "Comic Neue"

            if bg and bg.startswith("#"):
                pts = parse_poly(mask_polygon)
                if pts:
                    draw.polygon([(float(p[0]), float(p[1])) for p in pts], fill=bg)
                elif box_shape == "elliptical":
                    draw.ellipse([ex, ey, ex + ew, ey + eh], fill=bg)
                else:
                    draw.rectangle([ex, ey, ex + ew, ey + eh], fill=bg)

            tx, ty = ex + 4, ey + 4
            tw, th = int((ew - 8) * 0.95), int((eh - 8) * 0.95)
            if tw <= 0 or th <= 0:
                continue
            fit = R.fit_text_in_box_py(
                text,
                tw,
                th,
                font_name=font_name,
                default_font_size=int(el.get("size") or 12),
                shape="elliptical" if box_shape == "elliptical" else "rectangular",
                box_x=tx,
                box_y=ty,
                mask_polygon=mask_polygon,
                bold=bold,
                italic=italic,
            )
            font = R.load_font(fit["fontSize"], font_name=font_name, bold=bold, italic=italic)
            if not font:
                continue
            lh = fit["fontSize"] * 1.2
            start_y = ty + (th - len(fit["lines"]) * lh) / 2
            for i, line in enumerate(fit["lines"]):
                centers = fit.get("lineCenters") or []
                center = centers[i] if i < len(centers) else tx + tw / 2
                width = font.getlength(line)
                lx = center - width / 2
                if width <= tw:
                    lx = min(max(lx, tx), tx + tw - width)
                draw.text((lx, start_y + i * lh), line, fill=fg, font=font)
    return page


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("export", type=Path, help="layers .zip or a directory holding project.json")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--before", type=Path, help="also render the page as exported, unchanged")
    args = ap.parse_args()

    project, img = load_export(args.export)
    if args.before:
        render(json.loads(json.dumps(project)), img).save(args.before)
        print(f"wrote {args.before}")

    decisions = apply_r1_r2(project, img)
    render(project, img).save(args.out)
    print(f"wrote {args.out}")

    rejected = [d for d in decisions if d["r1_rejected"]]
    covered = [d for d in decisions if d["covered"]]
    still_bare = [d for d in decisions if not d["after"]]
    print(f"\n{len(decisions)} elements")
    print(f"  R1 rejected a non-containing balloon : {len(rejected)}")
    print(f"  R2 covered a region we used to skip  : {len(covered)}")
    print(f"  still drawn with no fill at all      : {len(still_bare)}")
    for d in rejected:
        print(f"    [R1] {d['text']!r}: {d['before']} -> {d['after']}")
    for d in covered:
        print(f"    [R2] {d['text']!r}: none -> {d['after']}")


if __name__ == "__main__":
    main()
