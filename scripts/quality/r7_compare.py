#!/usr/bin/env python3
"""Tracker R7 gate: compare the editor content capture with the export, pixel for pixel.

`scripts/playwright/r7_parity.cjs` writes `<name>-<tag>-editor.png` and `<name>-<tag>-export.png`
plus `parity-<tag>.json`. PNG file bytes are not comparable (two encoders), so this decodes both
to RGBA and compares the pixels. Prints a Markdown table and writes `compare-<tag>.json`.

    .venv/bin/python scripts/quality/r7_compare.py docs/quality-runs/r7-.../parity content
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image


def rgba(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert("RGBA"))


def compare(editor: np.ndarray, export: np.ndarray) -> dict:
    if editor.shape != export.shape:
        return {
            "same_size": False,
            "editor_size": editor.shape[:2],
            "export_size": export.shape[:2],
        }
    delta = np.abs(editor.astype(np.int16) - export.astype(np.int16))
    differing = np.any(delta > 0, axis=2)
    return {
        "same_size": True,
        "identical": bool(not differing.any()),
        "differing_pixels": int(differing.sum()),
        "differing_share": float(differing.mean()),
        "max_channel_delta": int(delta.max()),
        "editor_rgba_sha256": hashlib.sha256(editor.tobytes()).hexdigest(),
        "export_rgba_sha256": hashlib.sha256(export.tobytes()).hexdigest(),
    }


def main(run_dir: str, tag: str) -> int:
    directory = Path(run_dir)
    results = json.loads((directory / f"parity-{tag}.json").read_text())
    rows = []
    for result in results:
        name = result["name"]
        outcome = compare(
            rgba(directory / f"{name}-{tag}-editor.png"),
            rgba(directory / f"{name}-{tag}-export.png"),
        )
        outcome["order_matches"] = [
            c
            for c in result["export_cleanup_order"]
            if c in set(result["editor_cleanup_order"])
        ] == result["editor_cleanup_order"]
        rows.append({**result, **outcome})
    (directory / f"compare-{tag}.json").write_text(json.dumps(rows, indent=2))
    print(
        "| page | size | revision | patches (editor / scene) | order | RGBA identical | differing px | max delta |"
    )
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for row in rows:
        size = f"{row['source']['width']}×{row['source']['height']}"
        print(
            f"| {row['name']} | {size} | {row['scene_revision']} | "
            f"{row['editor_patches']} / {row['logical_scene_cleanups']} | "
            f"{'same' if row['order_matches'] else 'DIFFERS'} | "
            f"{'yes' if row.get('identical') else 'NO'} | {row.get('differing_pixels', '—')} | "
            f"{row.get('max_channel_delta', '—')} |"
        )
    return 0 if all(row.get("identical") for row in rows) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "content"))
