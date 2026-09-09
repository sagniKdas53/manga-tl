#!/usr/bin/env python3
"""Run the production render loop locally against archived layers.

The harness calls ``render_image_core`` unchanged. It substitutes only its backend response,
image download, and MinIO upload with in-process archive adapters; no callback, model, network, or
object-storage request is made.
"""

import hashlib
import io
import json
import os
import platform
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from PIL import Image, ImageChops, __version__ as pillow_version

from worker.handlers import render
from worker.config import TYPESET_SFX


ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ("sample222", "sample177", "sample83", "sample61", "sample99", "sample93")
resolved_font = render.load_font(16, font_name="Comic Neue", bold=True)
resolved_font_path = getattr(resolved_font, "path", None)
ENVIRONMENT = {
    "python": platform.python_version(),
    "pillow": pillow_version,
    "requested_font": "Comic Neue bold",
    "resolved_font": str(resolved_font_path),
    "font_sha256": hashlib.sha256(Path(resolved_font_path).read_bytes()).hexdigest() if resolved_font_path else None,
    "typeset_sfx": TYPESET_SFX,
    "use_uppercase_speech": os.environ.get("USE_UPPERCASE_SPEECH", "true"),
    "default_text_box_padding_px": render.DEFAULT_TEXT_BOX_PADDING_PX,
    "default_text_box_safety_percent": render.DEFAULT_TEXT_BOX_SAFETY_PERCENT,
}


class ArchiveMinio:
    def __init__(self):
        self.object = None
        self.args = None

    def put_object(self, *args, **kwargs):
        self.args = args, kwargs
        self.object = args[2].read()


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def archive_payload(project):
    """Map archive layer nesting to the worker's serialized backend payload.

    ``layerType`` and ``layerVisible`` are restored from the archived parent layer. The archive has
    no persisted OCR-region/bubble fields, so a bbox echo is supplied only to exercise the real
    no-detected-bubble branch; this is not evidence of the original production bubble state.
    """
    elements = []
    regions = []
    for layer in project["layers"]:
        for archived in layer["elements"]:
            element = dict(archived)
            element["layerType"] = layer["type"]
            element["layerVisible"] = layer.get("visible", True)
            elements.append(element)
            if layer["type"] == "ocr" and archived.get("regionId"):
                width = archived.get("maxWidth") or 1
                height = archived.get("maxHeight") or 1
                regions.append(
                    {
                        "id": archived["regionId"], "bboxW": width, "bboxH": height,
                        "bubbleW": width, "bubbleH": height,
                    }
                )
    return {"layerElements": elements, "ocrRegions": regions}


def replay(sample):
    base = ROOT / "corpus" / "samples" / "ja" / sample
    project = json.loads((base / "project" / "project.json").read_text())
    source_path = next(base.glob("source.*"))
    source_bytes = source_path.read_bytes()
    payload = archive_payload(project)
    sink = ArchiveMinio()
    response = SimpleNamespace(status_code=200, json=lambda: payload)

    with (
        patch.object(render.requests, "get", return_value=response),
        patch.object(render, "download_image", return_value=source_bytes),
        patch.object(render, "minio_client", sink),
    ):
        assert render.render_image_core(f"archive-{sample}") is True
    assert sink.object is not None

    target = ROOT / "docs" / "quality-evidence" / f"current-render-{sample}.png"
    target.write_bytes(sink.object)
    source = Image.open(io.BytesIO(source_bytes)).convert("RGB")
    output = Image.open(io.BytesIO(sink.object)).convert("RGB")
    diff = np.asarray(ImageChops.difference(source, output))
    rendered = [
        element for element in payload["layerElements"]
        if element.get("visible", True) and element.get("layerVisible", True)
        and element.get("layerType") in {"translation", "sfx"} and element.get("text")
    ]
    return {
        "sample": sample,
        "source": {"name": source_path.name, "sha256": sha256(source_bytes), "dimensions": source.size},
        "result": {"file": target.name, "sha256": sha256(sink.object), "dimensions": output.size},
        "archive_adapter": {
            "restored_fields": ["layerType", "layerVisible"],
            "synthetic_ocr_region_fields": ["bboxW", "bboxH", "bubbleW", "bubbleH"],
            "synthetic_bubble_meaning": "bbox echo, therefore current renderer takes no-detected-bubble path",
        },
        "elements": {"archived_total": len(payload["layerElements"]), "rendered": len(rendered)},
        "pixel_delta": {
            "different_channel_values": int(np.count_nonzero(diff)),
            "max_channel_delta": int(diff.max()),
            "changed_pixels": int(np.count_nonzero(np.any(diff, axis=2))),
        },
    }


def probe(name, element):
    """Run one synthetic serialized element through the same render entry point."""
    source = Image.new("RGB", (100, 100), "#000000")
    source_buffer = io.BytesIO()
    source.save(source_buffer, format="PNG")
    source_bytes = source_buffer.getvalue()
    payload = {"layerElements": [element], "ocrRegions": []}
    sink = ArchiveMinio()
    response = SimpleNamespace(status_code=200, json=lambda: payload)
    with (
        patch.object(render.requests, "get", return_value=response),
        patch.object(render, "download_image", return_value=source_bytes),
        patch.object(render, "minio_client", sink),
    ):
        assert render.render_image_core(f"synthetic-{name}") is True
    output = Image.open(io.BytesIO(sink.object)).convert("RGB")
    diff = np.asarray(ImageChops.difference(source, output))
    return {
        "probe": name,
        "input_text_repr": repr(element["text"]),
        "is_manually_edited": element.get("isManuallyEdited", False),
        "region_type": element.get("regionType"),
        "layer_type": element.get("layerType"),
        "typeset_sfx_config": TYPESET_SFX,
        "changed_pixels": int(np.count_nonzero(np.any(diff, axis=2))),
        "max_channel_delta": int(diff.max()),
    }


def synthetic_probes():
    base = {
        "visible": True, "layerVisible": True, "layerType": "translation", "x": 20, "y": 20,
        "maxWidth": 60, "maxHeight": 60, "backgroundColor": "#ff0000", "textColor": "#ffffff",
        "font": "Comic Neue", "boxShape": "rectangular",
    }
    return [
        probe("whitespace-text", {**base, "text": "   "}),
        probe("empty-manual-plate", {**base, "text": "", "isManuallyEdited": True}),
        probe(
            "sfx-bypasses-translation-filter",
            {**base, "text": "SFX", "layerType": "sfx", "regionType": "sfx", "backgroundColor": "#0000ff"},
        ),
    ]


def main():
    if sys.argv[1:] == ["--combine"]:
        results = [
            json.loads((ROOT / "docs" / "quality-evidence" / f"worker-render-replay-{sample}.json").read_text())
            for sample in SAMPLES
        ]
        previous = json.loads((ROOT / "docs" / "quality-evidence" / "worker-render-replay-results.json").read_text())
        report = {"environment": ENVIRONMENT, "archive_replays": results, "synthetic_render_probes": previous["synthetic_render_probes"]}
        (ROOT / "docs" / "quality-evidence" / "worker-render-replay-results.json").write_text(
            json.dumps(report, indent=2) + "\n"
        )
        return
    samples = tuple(sys.argv[1:]) or SAMPLES
    results = []
    for sample in samples:
        result = replay(sample)
        results.append(result)
        (ROOT / "docs" / "quality-evidence" / f"worker-render-replay-{sample}.json").write_text(
            json.dumps(result, indent=2) + "\n"
        )
    report = {"environment": ENVIRONMENT, "archive_replays": results, "synthetic_render_probes": synthetic_probes()}
    (ROOT / "docs" / "quality-evidence" / "worker-render-replay-results.json").write_text(
        json.dumps(report, indent=2) + "\n"
    )
    for result in results:
        print(result["sample"], result["elements"], result["pixel_delta"])


if __name__ == "__main__":
    main()
