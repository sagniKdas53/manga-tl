"""Replay B3b (the balloon join) offline and list every balloon it changes, with a crop of each.

Use it to check the B3b thresholds on pages they were not fitted on, and to try other values
before changing a deployment (docs/output-quality-implementation-tracker.md, "Thresholds B tuned").

Two sources of pages:

- ``--probe DIR``: cached detections, one ``sampleN.<key>.json`` per page with ``page_wh``,
  ``bubbles`` (``mask_polygon``) and ``frags`` (the 2026-08 region-probe cache,
  ``~/.cache/manga-library/region_probe``). Page images come from ``--corpus``, resized to
  ``page_wh``.
- ``--captures DIR --run RUN.json``: ``OCR_CAPTURE_DIR`` captures from a live stack, with the
  corpus batch harness's run.json to map page ids to images.

Pieces are assigned to a balloon by mask cover (> half the box), which can differ from the live
assignment; confirm anything surprising on a live capture.

    .venv/bin/python scripts/replay_balloon_join.py --worker worker \\
        --probe ~/.cache/manga-library/region_probe --corpus corpus/samples/ja --out /tmp/b3b
"""

import argparse
import glob
import json
import os
import sys
from dataclasses import replace

import cv2
import numpy as np
from PIL import Image


def _load(path):
    with open(path) as handle:
        return json.load(handle)


def _pages_from_probe(probe, corpus):
    for path in sorted(glob.glob(os.path.join(probe, "*.json"))):
        det = _load(path)
        sid = os.path.basename(path).split(".")[0]
        width, height = det["page_wh"]
        sources = glob.glob(os.path.join(corpus, sid, "source.*"))
        if not sources:
            print(f"{sid}: no source image, skipped")
            continue
        image = Image.open(sources[0]).convert("L")
        if abs(image.size[0] / image.size[1] - width / height) > 0.01:
            print(
                f"{sid}: the image is not the page the probe saw (aspect differs), skipped"
            )
            continue
        frags = [
            dict(
                f,
                fragmentId=f"f{i}",
                sourceQuad=[
                    [f["x"], f["y"]],
                    [f["x"] + f["width"], f["y"]],
                    [f["x"] + f["width"], f["y"] + f["height"]],
                    [f["x"], f["y"] + f["height"]],
                ],
            )
            for i, f in enumerate(det["frags"])
        ]
        yield (
            sid,
            np.array(image.resize((width, height), Image.LANCZOS)),
            frags,
            [b["mask_polygon"] for b in det["bubbles"]],
        )


def _pages_from_captures(captures, run_path):
    run = _load(run_path)
    for page in run["pages"]:
        path = os.path.join(captures, f"{page['pageId']}.json")
        if not os.path.exists(path):
            continue
        capture = _load(path)
        gray = cv2.imread(page["sample"]["imagePath"], cv2.IMREAD_GRAYSCALE)
        frags = [
            dict(r, fragmentId=f"cap-{i}") for i, r in enumerate(capture["regions"])
        ]
        yield (
            page["sample"]["sampleId"],
            gray,
            frags,
            [m["points"] for m in capture["detector_masks"]],
        )


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument(
        "--worker",
        required=True,
        help="worker checkout to import (its src/ goes on sys.path)",
    )
    ap.add_argument("--probe")
    ap.add_argument("--corpus", default="corpus/samples/ja")
    ap.add_argument("--captures")
    ap.add_argument("--run")
    ap.add_argument(
        "--out", required=True, help="where to write one crop per changed balloon"
    )
    ap.add_argument(
        "--budget", type=float, help="OCR_BALLOON_JOIN_BUDGET (default: the worker's)"
    )
    ap.add_argument(
        "--wall", type=float, help="OCR_BALLOON_WALL_STROKE (default: the worker's)"
    )
    ap.add_argument(
        "--max-lines",
        type=int,
        help="OCR_BALLOON_JOIN_MAX_LINES (default: the worker's)",
    )
    args = ap.parse_args()

    sys.path.insert(0, os.path.join(args.worker, "src"))
    from worker.handlers.ocr import grouping_config, owner_aware_grouping_context
    from worker.services.balloon_join import balloon_join
    from worker.services.bubble_geometry import bubble_grouping_context, gap_wall
    from worker.services.fragment_grouping import group_fragments

    from worker import config

    budget = config.OCR_BALLOON_JOIN_BUDGET if args.budget is None else args.budget
    wall_stroke = config.OCR_BALLOON_WALL_STROKE if args.wall is None else args.wall
    max_lines = (
        config.OCR_BALLOON_JOIN_MAX_LINES if args.max_lines is None else args.max_lines
    )
    if args.probe:
        pages = _pages_from_probe(args.probe, args.corpus)
    elif args.captures and args.run:
        pages = _pages_from_captures(args.captures, args.run)
    else:
        ap.error("give --probe, or --captures with --run")
    os.makedirs(args.out, exist_ok=True)

    changed = 0
    for sid, gray, frags, outlines in pages:
        height, width = gray.shape
        masks = []
        for outline in outlines:
            mask = np.zeros((height, width), np.uint8)
            cv2.fillPoly(mask, [np.array(outline, np.int32)], 255)
            masks.append(mask)
        for index, (outline, mask) in enumerate(zip(outlines, masks, strict=True)):
            inside = []
            for i, f in enumerate(frags):
                x0, y0 = max(0, f["x"]), max(0, f["y"])
                x1, y1 = (
                    min(width, f["x"] + f["width"]),
                    min(height, f["y"] + f["height"]),
                )
                if x1 > x0 and y1 > y0 and mask[y0:y1, x0:x1].mean() > 127:
                    inside.append(i)
            if len(inside) < 2:
                continue
            members = [frags[i] for i in inside]
            base = bubble_grouping_context(mask, outline)
            if base is not None:
                base = replace(base, page_area=float(width * height))
            grouping = grouping_config("rtl")
            context = owner_aware_grouping_context(
                base, [{"format": "polygon", "id": "balloon", "points": outline}]
            )
            before = group_fragments([dict(m) for m in members], grouping, context)
            joined = replace(
                context,
                group_join=balloon_join(
                    grouping,
                    context,
                    budget,
                    gap_wall(gray, mask, wall_stroke),
                    max_lines,
                ),
            )
            after = group_fragments([dict(m) for m in members], grouping, joined)
            if len(after) == len(before):
                continue
            changed += 1

            def text(groups, members=members):
                return " | ".join(
                    "+".join(members[i]["text"][:8] for i in group) for group in groups
                )

            print(
                f"{sid} balloon {index}: {len(before)} -> {len(after)}\n  before: {text(before)}\n  after:  {text(after)}"
            )
            points = np.array(outline, np.int32)
            x0, y0 = points.min(0) - 25
            x1, y1 = points.max(0) + 25
            view = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
            cv2.polylines(view, [points], True, (0, 180, 0), 2)
            colours = [(0, 0, 255), (255, 0, 0), (0, 160, 255), (200, 0, 200)]
            for k, group in enumerate(before):
                for i in group:
                    m = members[i]
                    cv2.rectangle(
                        view,
                        (m["x"], m["y"]),
                        (m["x"] + m["width"], m["y"] + m["height"]),
                        colours[k % 4],
                        2,
                    )
            cv2.imwrite(
                os.path.join(args.out, f"{sid}_b{index}.png"),
                view[max(0, y0) : y1, max(0, x0) : x1],
            )
    print(
        f"budget={budget} wall={wall_stroke} max_lines={max_lines}: {changed} balloons change (crops in {args.out})"
    )


if __name__ == "__main__":
    main()
