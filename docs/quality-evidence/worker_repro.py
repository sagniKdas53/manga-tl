#!/usr/bin/env python3
"""Local, deterministic worker helper reproduction for selected corpus fixtures.

Run from the repository root:
PYTHONPATH=worker/src .venv/bin/python docs/quality-evidence/worker_repro.py

It never changes a corpus fixture and makes no backend, model, or paid-provider request.
"""

import hashlib
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageChops

from worker.handlers.ocr import cover_fill_for_region
from worker.handlers.render import fit_text_in_box_py
from worker.services.merge_regions import merge_ocr_regions
from worker.services.layout import classify_region_type


ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ("sample177", "sample222", "sample61", "sample99", "sample93", "sample83")


def bbox(element):
    return [int(element.get(key) or fallback) for key, fallback in (
        ("x", 0), ("y", 0), ("maxWidth", element.get("width") or 1), ("maxHeight", element.get("height") or 1)
    )]


def polygon_bbox(polygon):
    if not polygon:
        return None
    points = json.loads(polygon) if isinstance(polygon, str) else polygon
    if not isinstance(points, list) or not points:
        return None
    xs, ys = zip(*points, strict=True)
    return [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def analyze_sample(sample):
    base = ROOT / "corpus" / "samples" / "ja" / sample
    project = json.loads((base / "project" / "project.json").read_text())
    source = next(base.glob("source.*"))
    original = base / "project" / "original.png"
    source_image = Image.open(source).convert("RGB")
    original_image = Image.open(original).convert("RGB")
    ocr = next(layer["elements"] for layer in project["layers"] if layer["type"] == "ocr")
    output = [
        element
        for layer in project["layers"]
        if layer["type"] in {"translation", "sfx"}
        for element in layer["elements"]
    ]
    rendered = []
    for element in output:
        text = element.get("text", "")
        ex, ey, ew, eh = bbox(element)
        fit = fit_text_in_box_py(
            text, ew, eh, font_name=element.get("font") or "Comic Neue",
            default_font_size=int(element.get("size") or 12),
            shape="elliptical" if element.get("boxShape") == "elliptical" else "rectangular",
            box_x=ex, box_y=ey, mask_polygon=element.get("maskPolygon"),
        )
        rendered.append({
            "region_id": element.get("regionId"), "box": [ex, ey, ew, eh],
            "mask_box": polygon_bbox(element.get("maskPolygon")),
            "text_length": len(text), "font_size": fit["fontSize"], "line_count": len(fit["lines"]),
        })

    image_bgr = cv2.cvtColor(np.asarray(source_image), cv2.COLOR_RGB2BGR)
    saved_masks_by_region = {}
    for element in output:
        saved_masks_by_region.setdefault(element.get("regionId"), []).append(polygon_bbox(element.get("maskPolygon")))
    ocr_results = []
    for element in ocr:
        x, y, width, height = bbox(element)
        text = element.get("text", "")
        current_region_type = classify_region_type(
            {"text": text, "x": x, "y": y, "width": width, "height": height},
            panel=None, image_width=source_image.width, image_height=source_image.height,
        )
        color, polygon = cover_fill_for_region(image_bgr, None, x, y, width, height)
        ocr_results.append({
            "region_id": element.get("regionId"), "box": [x, y, width, height],
            "text_length": len(text), "current_type_without_bubble": current_region_type,
            "cover_color": color, "current_cover_mask_box": polygon_bbox(polygon),
            "historical_saved_mask_boxes": saved_masks_by_region.get(element.get("regionId"), []),
        })

    diff = ImageChops.difference(source_image, original_image)
    diff_array = np.asarray(diff)
    return {
        "sample": sample,
        "declared_dimensions": project["dimensions"],
        "source": {"name": source.name, "sha256": sha256(source), "dimensions": source_image.size},
        "project_original": {"sha256": sha256(original), "dimensions": original_image.size,
                             "pixel_identical_to_source": diff.getbbox() is None,
                             "different_channel_values": int(np.count_nonzero(diff_array)),
                             "max_channel_delta": int(diff_array.max())},
        "counts": {"ocr": len(ocr), "output": len(output)},
        "ocr_current_helpers": ocr_results,
        "saved_output_current_fit": rendered,
    }


def main():
    results = [analyze_sample(sample) for sample in SAMPLES]
    target = ROOT / "docs" / "quality-evidence" / "worker-repro-results.json"
    target.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n")
    chained = [
        {"text": text, "detectedLanguage": "ja", "confidence": 1.0, "x": x, "y": 0, "width": 10, "height": 10}
        for text, x in (("A", 0), ("B", 14), ("C", 28))
    ]
    merged = merge_ocr_regions(chained, threshold_ratio=0.5)
    panel = {"bboxX": 0, "bboxY": 0, "bboxW": 1000, "bboxH": 1000}
    low_confidence = {"text": "abc", "x": 100, "y": 100, "width": 10, "height": 10}
    synthetic = {
        "grouping_chain": {"input_boxes": [[item["x"], 0, 10, 10] for item in chained], "merged": merged},
        "confidence_zero": {
            "zero": classify_region_type({**low_confidence, "confidence": 0}, panel, 1000, 1000),
            "point_one": classify_region_type({**low_confidence, "confidence": 0.1}, panel, 1000, 1000),
        },
    }
    (ROOT / "docs" / "quality-evidence" / "worker-synthetic-results.json").write_text(
        json.dumps(synthetic, indent=2, ensure_ascii=False) + "\n"
    )
    for result in results:
        print(
            result["sample"], result["counts"],
            "source/project pixels equal=", result["project_original"]["pixel_identical_to_source"],
        )


if __name__ == "__main__":
    main()
