#!/usr/bin/env python3
"""Tracker R7 gate: after a patch is deleted, the export is the source plus the remaining patches.

Recomposes the page independently of the browser -- the source-only export (every patch hidden)
with each remaining patch alpha-composited over it in the scene's paint order -- and compares it
with the export after the delete, inside the deleted patch's rect. Where two patches overlapped,
the one that stays must show there: neither a hole (the source) nor the deleted patch.

    TLHUB_EMAIL=... TLHUB_PASSWORD=... .venv/bin/python scripts/quality/r7_recompose.py \\
        docs/quality-runs/r7-.../behaviour-sample93 --base http://127.0.0.1:18080/tlhub \\
        --rect x,y,w,h
"""

from __future__ import annotations

import argparse
import io
import json
import os
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image


def fetch(url: str, token: str | None = None, body: dict | None = None) -> bytes:
    request = urllib.request.Request(
        url, data=json.dumps(body).encode() if body else None
    )
    if body:
        request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request) as response:
        return response.read()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir")
    parser.add_argument("--base", default="http://127.0.0.1:18080/tlhub")
    parser.add_argument("--rect", required=True, help="deleted patch rect: x,y,w,h")
    args = parser.parse_args()
    run = Path(args.run_dir)
    token = json.loads(
        fetch(
            f"{args.base}/api/auth/login",
            body={
                "email": os.environ["TLHUB_EMAIL"],
                "password": os.environ["TLHUB_PASSWORD"],
            },
        )
    )["token"]

    scene = json.loads((run / "delete-overlap-1-scene.json").read_text())
    page_id = scene["page"]["page_id"]
    sha_by_asset = {asset["asset_id"]: asset["sha256"] for asset in scene["assets"]}
    composed = Image.open(run / "hide-inpainting-1-source-export.png").convert("RGBA")
    for cleanup in scene["cleanup_artifacts"]:
        sha = sha_by_asset[cleanup["patch_asset_id"]]
        patch = Image.open(
            io.BytesIO(
                fetch(f"{args.base}/api/pages/{page_id}/scene-assets/{sha}", token)
            )
        )
        patch = patch.convert("RGBA")
        bounds = cleanup["bounds"]
        size = (round(bounds["width"]), round(bounds["height"]))
        if patch.size != size:
            patch = patch.resize(size, Image.Resampling.BILINEAR)
        opacity = cleanup.get("opacity", 1)
        if opacity < 1:
            alpha = np.asarray(patch)[..., 3].astype(np.float64) * opacity
            patch.putalpha(Image.fromarray(np.round(alpha).astype(np.uint8)))
        layer = Image.new("RGBA", composed.size, (0, 0, 0, 0))
        layer.paste(patch, (round(bounds["x"]), round(bounds["y"])))
        composed = Image.alpha_composite(composed, layer)

    x, y, w, h = (int(v) for v in args.rect.split(","))
    export = np.asarray(
        Image.open(run / "delete-overlap-1-export.png").convert("RGBA")
    ).astype(int)
    expected = np.asarray(composed).astype(int)
    source = np.asarray(
        Image.open(run / "hide-inpainting-1-source-export.png").convert("RGBA")
    ).astype(int)
    window = (slice(y, y + h), slice(x, x + w))
    delta = np.abs(export[window] - expected[window])
    patched = np.any(expected[window] != source[window], axis=2)
    result = {
        "rect": [x, y, w, h],
        "max_channel_delta": int(delta.max()),
        "pixels_off_by_more_than_1": int((delta.max(axis=2) > 1).sum()),
        "pixels_where_a_remaining_patch_paints": int(patched.sum()),
        "export_equals_source_there": bool(
            (export[window][patched] == source[window][patched]).all()
        )
        if patched.any()
        else None,
    }
    (run / "recompose.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    return 0 if result["pixels_off_by_more_than_1"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
