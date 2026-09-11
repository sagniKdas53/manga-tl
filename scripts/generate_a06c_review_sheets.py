#!/usr/bin/env python3
"""Build source-pixel review sheets for retained A06-C owner-label drafts.

The sheets are evidence-only: they draw retained final OCR boxes over the immutable
source and provide enlarged numbered crops. They do not change OCR, labels, or
rendering artifacts.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parents[1]
TILE_WIDTH = 360
TILE_HEIGHT = 300
GRID_COLUMNS = 4


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--labels", required=True, type=Path, help="A06-C draft-label JSON"
    )
    parser.add_argument(
        "--out", required=True, type=Path, help="empty output directory"
    )
    return parser.parse_args()


def fit(image: np.ndarray, width: int, height: int) -> np.ndarray:
    image_height, image_width = image.shape[:2]
    scale = min(width / image_width, height / image_height)
    return cv2.resize(
        image, (max(1, round(image_width * scale)), max(1, round(image_height * scale)))
    )


def label_tile(source: np.ndarray, label: dict, number: int) -> np.ndarray:
    x, y, width, height = label["geometry"]["bbox"]
    pad = max(24, round(max(width, height) * 0.35))
    source_height, source_width = source.shape[:2]
    left, top = max(0, x - pad), max(0, y - pad)
    right, bottom = (
        min(source_width, x + width + pad),
        min(source_height, y + height + pad),
    )
    crop = source[top:bottom, left:right].copy()
    cv2.rectangle(
        crop, (x - left, y - top), (x + width - left, y + height - top), (0, 0, 255), 3
    )
    resized = fit(crop, TILE_WIDTH - 20, TILE_HEIGHT - 54)
    tile = np.full((TILE_HEIGHT, TILE_WIDTH, 3), 245, dtype=np.uint8)
    offset_x = (TILE_WIDTH - resized.shape[1]) // 2
    tile[38 : 38 + resized.shape[0], offset_x : offset_x + resized.shape[1]] = resized
    review_state = label["review_state"]
    caption = f"{number:02d} {label['id']}  {review_state}"
    cv2.putText(
        tile,
        caption,
        (8, 24),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.48,
        (0, 0, 0),
        1,
        cv2.LINE_AA,
    )
    return tile


def write_review_sheet(source_record: dict, output_dir: Path) -> None:
    source = cv2.imread(str(ROOT / source_record["source_path"]), cv2.IMREAD_COLOR)
    if source is None:
        raise ValueError(f"cannot read source: {source_record['source_path']}")
    labels = source_record["labels"]
    overview = source.copy()
    for number, label in enumerate(labels, start=1):
        x, y, width, height = label["geometry"]["bbox"]
        cv2.rectangle(overview, (x, y), (x + width, y + height), (0, 0, 255), 3)
        cv2.putText(
            overview,
            str(number),
            (x + 3, max(20, y + 20)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (0, 0, 255),
            2,
        )
    overview = fit(overview, 1200, 1200)
    cv2.imwrite(str(output_dir / f"{source_record['sample']}-overview.png"), overview)

    rows = (len(labels) + GRID_COLUMNS - 1) // GRID_COLUMNS
    sheet = np.full(
        (rows * TILE_HEIGHT, GRID_COLUMNS * TILE_WIDTH, 3), 220, dtype=np.uint8
    )
    for index, label in enumerate(labels):
        row, column = divmod(index, GRID_COLUMNS)
        tile = label_tile(source, label, index + 1)
        top, left = row * TILE_HEIGHT, column * TILE_WIDTH
        sheet[top : top + TILE_HEIGHT, left : left + TILE_WIDTH] = tile
    cv2.imwrite(str(output_dir / f"{source_record['sample']}-regions.png"), sheet)


def main() -> None:
    args = parse_args()
    if args.out.exists() and any(args.out.iterdir()):
        raise ValueError(f"refusing non-empty output directory: {args.out}")
    payload = json.loads(args.labels.read_text())
    args.out.mkdir(parents=True, exist_ok=True)
    for source_record in payload["sources"]:
        write_review_sheet(source_record, args.out)
    (args.out / "manifest.json").write_text(
        json.dumps(
            {
                "labels": str(args.labels),
                "sources": [record["sample"] for record in payload["sources"]],
                "purpose": "source-pixel review sheets; final OCR boxes only; no OCR or rendering mutation",
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
