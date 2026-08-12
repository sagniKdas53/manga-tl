#!/usr/bin/env python3
"""Re-render an exported page locally, so a typesetting change can be looked at.

`render_image_core` pulls its image from MinIO and pushes the result back, which makes it a poor
way to check what a change to `fit_text_in_box_py` did. This mirrors its element loop -- the same
fills, the same 4px + 5% inset, the same fit call, the same centring and clamping -- against a
`corpus/samples/sampleN/source.*` and the `page-N-project.json` beside it.

    ../.venv/bin/python scripts/render_preview.py 1 --out /tmp/p1.png
    ../.venv/bin/python scripts/render_preview.py 1 --centre-only --out /tmp/p1-before.png

`--centre-only` restores the pre-D6 span sampling, so before/after is one flag rather than a
stash. Keep this in step with `render_image_core`: it is a mirror, and a mirror that drifts is
worse than no mirror.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "worker" / "src"))
os.environ.setdefault("REDIS_HOST", "localhost")

from PIL import Image, ImageDraw  # noqa: E402

import worker.handlers.render as R  # noqa: E402


def render_page(page, branch="main", centre_only=False):
    if centre_only:
        R.BAND_SAMPLE_FRACTIONS = (0.5,)

    project = json.loads((REPO / "corpus" / "exports" / branch / f"page-{page}-project.json").read_text())
    sources = glob.glob(str(REPO / "corpus" / "samples" / f"sample{page}" / "source.*"))
    if not sources:
        raise SystemExit(f"no source image for sample{page}")

    img = Image.open(sources[0]).convert("RGB")
    draw = ImageDraw.Draw(img)

    for layer in project.get("layers", []):
        if layer.get("type") != "translation" or not layer.get("visible", True):
            continue
        for el in layer.get("elements", []):
            if not el.get("visible", True):
                continue
            text = el.get("text") or ""
            if not text.strip():
                continue

            ex, ey = int(el.get("x") or 0), int(el.get("y") or 0)
            ew, eh = int(el.get("maxWidth") or 50), int(el.get("maxHeight") or 50)
            box_shape = el.get("boxShape") or "rectangular"
            bg = el.get("backgroundColor")
            fg = el.get("textColor") or "#000000"
            bold = "bold" in (el.get("fontWeight") or "").lower()
            italic = "italic" in (el.get("fontStyle") or "").lower()
            mask_polygon = el.get("maskPolygon")
            font_name = el.get("font") or "Comic Neue"

            if bg and bg.startswith("#"):
                if mask_polygon:
                    pts = json.loads(mask_polygon) if isinstance(mask_polygon, str) else mask_polygon
                    draw.polygon([(float(p[0]), float(p[1])) for p in pts], fill=bg)
                elif box_shape == "elliptical":
                    draw.ellipse([ex, ey, ex + ew, ey + eh], fill=bg)
                else:
                    draw.rectangle([ex, ey, ex + ew, ey + eh], fill=bg)

            text_box_x, text_box_y = ex + 4, ey + 4
            text_box_w, text_box_h = int((ew - 8) * 0.95), int((eh - 8) * 0.95)
            if text_box_w <= 0 or text_box_h <= 0:
                continue

            fit = R.fit_text_in_box_py(
                text,
                text_box_w,
                text_box_h,
                font_name=font_name,
                default_font_size=int(el.get("size") or 12),
                shape="elliptical" if box_shape == "elliptical" else "rectangular",
                box_x=text_box_x,
                box_y=text_box_y,
                mask_polygon=mask_polygon,
                bold=bold,
                italic=italic,
            )
            font = R.load_font(fit["fontSize"], font_name=font_name, bold=bold, italic=italic)
            if not font:
                continue

            line_height = fit["fontSize"] * 1.2
            start_y = text_box_y + (text_box_h - len(fit["lines"]) * line_height) / 2
            for i, line in enumerate(fit["lines"]):
                centers = fit.get("lineCenters") or []
                center = centers[i] if i < len(centers) else text_box_x + text_box_w / 2
                width = font.getlength(line)
                line_x = center - width / 2
                if width <= text_box_w:
                    line_x = min(max(line_x, text_box_x), text_box_x + text_box_w - width)
                draw.text((line_x, start_y + i * line_height), line, fill=fg, font=font)

    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("page", type=int)
    ap.add_argument("--branch", default="main")
    ap.add_argument("--centre-only", action="store_true", help="pre-D6 span sampling")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    render_page(args.page, args.branch, args.centre_only).save(args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
