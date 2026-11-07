"""Replay a page's OCR grouping offline from its OCR_CAPTURE_DIR capture, with no model calls.

It follows the steps of ``worker.handlers.ocr`` (assign pieces to balloons, group inside each
balloon, group what is left by panel and spread), importing the worker's own functions. The result
is compared with the groups the live OCR recorded in the capture (``final_owners``).

Use it to tell what a grouping change does before a paid re-run. It is only evidence if it first
reproduces the live groups on the same code, so the report lists every page where it doesn't.

Run it in the worker image, with this repo's worker on the path:

    docker run --rm --network none --entrypoint python -e PYTHONPATH=/repo/worker/src \\
        -v "$PWD":/repo:ro -v <evidence>:/evidence manga-tl-test-worker:latest \\
        /repo/scripts/quality/replay_grouping.py \\
        --captures /evidence/captures --pages /evidence/pages --panels /evidence/panels.json \\
        --out /evidence/replay.json
"""

import argparse
import dataclasses
import json
import os
import sys
from dataclasses import replace

import cv2
import numpy as np


def groups_for_page(capture, gray, img, panels, ocr):
    """The page's groups of fragment ids, by the worker's steps. `ocr` holds the worker's functions."""
    h, w = gray.shape
    page_area = float(w * h)
    fragments = []
    for index, region in enumerate(capture["regions"]):
        feature = capture["fragment_features"][index]
        fragments.append(dict(region, fragmentId=feature["id"], _index=index))

    masks = []
    outlines = [mask["points"] for mask in capture["detector_masks"]]
    for points in outlines:
        mask = np.zeros((h, w), dtype=np.uint8)
        cv2.fillPoly(mask, [np.array(points, dtype=np.int32)], 255)
        masks.append(mask)

    for frag in fragments:
        best, most = -1, 0
        x1, y1 = max(0, min(w - 1, frag["x"])), max(0, min(h - 1, frag["y"]))
        x2, y2 = max(0, min(w, frag["x"] + frag["width"])), max(0, min(h, frag["y"] + frag["height"]))
        if x2 > x1 and y2 > y1:
            for index, mask in enumerate(masks):
                overlap = np.sum(mask[y1:y2, x1:x2] > 0)
                if overlap > most:
                    best, most = index, overlap
            if best >= 0 and not ocr.bubble_covers_text(masks[best], x1, y1, x2, y2):
                best = -1
        frag["bubble_idx"] = best

    grouping = ocr.GroupingConfig(**capture["grouping"])
    groups = []
    for index, mask in enumerate(masks):
        assigned = [f for f in fragments if f["bubble_idx"] == index]
        if not assigned:
            continue
        context = ocr.bubble_grouping_context(mask, outlines[index])
        if context is not None:
            context = replace(context, page_area=page_area)
        context = ocr.owner_aware_grouping_context(
            context, [{"format": "polygon", "id": f"bubble-{index}", "points": outlines[index]}]
        )
        if ocr.OCR_BALLOON_JOIN_BUDGET > 0 and len(assigned) > 1:
            wall = ocr.gap_wall(gray, mask, ocr.OCR_BALLOON_WALL_STROKE)
            context = replace(
                context,
                group_join=ocr.balloon_join(
                    grouping, context, ocr.OCR_BALLOON_JOIN_BUDGET, wall, ocr.OCR_BALLOON_JOIN_MAX_LINES
                ),
            )
        groups.extend(
            [assigned[i]["fragmentId"] for i in group] for group in ocr.group_fragments(assigned, grouping, context)
        )

    unmatched = [f for f in fragments if f["bubble_idx"] == -1]
    page_context = ocr.GroupingContext(page_area=page_area)
    if ocr.OCR_NO_BALLOON_VETO:
        page_context = ocr.no_balloon_grouping_context(page_context)
    gutter = ocr.find_spread_gutter(img, unmatched)
    containers = [*panels, *ocr.detect_text_containers(img)]
    for partition in ocr.partition_unmatched_fragments_by_panel(unmatched, containers).values():
        for part in ocr.split_fragments_at_gutter(partition, gutter):
            groups.extend(
                [part[i]["fragmentId"] for i in group] for group in ocr.group_fragments(part, grouping, page_context)
            )
    return groups


def partition(groups):
    return {frozenset(group) for group in groups}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--captures", required=True)
    ap.add_argument("--pages", required=True, help="directory of original pages, named by page id")
    ap.add_argument("--panels", required=True, help="JSON: page id to a list of panels (bboxX, bboxY, bboxW, bboxH)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    import worker.handlers.ocr as handler
    from worker.services.balloon_join import balloon_join
    from worker.services.bubble_geometry import bubble_grouping_context, gap_wall
    from worker.services.fragment_grouping import GroupingConfig, GroupingContext, group_fragments

    class Ocr:
        pass

    ocr = Ocr()
    ocr.balloon_join = balloon_join
    ocr.bubble_grouping_context = bubble_grouping_context
    ocr.gap_wall = gap_wall
    ocr.GroupingConfig = GroupingConfig
    ocr.GroupingContext = GroupingContext
    ocr.group_fragments = group_fragments
    for name in (
        "bubble_covers_text",
        "owner_aware_grouping_context",
        "no_balloon_grouping_context",
        "find_spread_gutter",
        "detect_text_containers",
        "partition_unmatched_fragments_by_panel",
        "split_fragments_at_gutter",
        "OCR_BALLOON_JOIN_BUDGET",
        "OCR_BALLOON_WALL_STROKE",
        "OCR_BALLOON_JOIN_MAX_LINES",
        "OCR_NO_BALLOON_VETO",
    ):
        setattr(ocr, name, getattr(handler, name))

    panels = json.load(open(args.panels))
    report = {"pages": [], "fields": sorted(f.name for f in dataclasses.fields(GroupingConfig))}
    for page_id in sorted(os.listdir(args.pages)):
        path = os.path.join(args.captures, f"{page_id}.json")
        if not os.path.exists(path):
            report["pages"].append({"page": page_id, "status": "no-capture"})
            continue
        capture = json.load(open(path))
        img = cv2.imread(os.path.join(args.pages, page_id))
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        live = partition(owner["fragment_ids"] for owner in capture["final_owners"])
        replayed = partition(groups_for_page(capture, gray, img, panels.get(page_id, []), ocr))
        report["pages"].append(
            {
                "page": page_id,
                "status": "same" if live == replayed else "differs",
                "groups": sorted(sorted(group) for group in replayed),
                "only_live": sorted(sorted(group) for group in live - replayed),
                "only_replay": sorted(sorted(group) for group in replayed - live),
            }
        )
    with open(args.out, "w") as handle:
        json.dump(report, handle)
    pages = report["pages"]
    same = sum(page["status"] == "same" for page in pages)
    print(f"{same} of {len(pages)} pages reproduce the live groups")
    for page in pages:
        if page["status"] != "same":
            print(page["status"], page["page"], "live", len(page.get("only_live", [])), "replay", len(page.get("only_replay", [])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
