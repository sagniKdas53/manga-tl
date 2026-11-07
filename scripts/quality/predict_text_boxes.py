"""Predict each region's text box under the backend's rules, for layout_snapshot.cjs --what-if.

This repeats `grow_into_safe_text` (backend-rust/src/jobs/coordinator.rs) so a change can be measured
before any page is re-run. A live re-run is then compared with this prediction, and any gap between
the two shows up as a difference in the ledger.

--room also applies the room beside text sharing a detector box, using the worker's own measurement
(`worker.services.text_room`). Run it in the worker image, as replay_grouping.py is.

    python scripts/quality/predict_text_boxes.py --snapshot baseline.json --pages <dir> --room --out boxes.json
"""

import argparse
import json
import os
import sys

NEIGHBOUR_OVERLAP_LIMIT = 0.1
OUTLINE_SLACK_PX = 2.0
INSET_OUTLINE_SLACK_PX = 6.0
OUTLINE_WORTH_LEAVING = 1.4


def area_shared(a, b):
    w = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    h = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    return max(w, 0) * max(h, 0)


def runs_into_neighbour(grown, box, others):
    for other in others:
        shared = area_shared(grown, other)
        if shared > area_shared(box, other) and shared > NEIGHBOUR_OVERLAP_LIMIT * min(
            grown[2] * grown[3], other[2] * other[3]
        ):
            return True
    return False


def safe_text_box(region, box, sharing):
    """Part 1: text alone in its balloon grows into `safe_text`."""
    bubble, safe = region["bubble"], region["safe"]
    if sharing or None in bubble or None in safe or safe == bubble:
        return None
    left = min(box[0], max(safe[0], bubble[0]))
    top = min(box[1], max(safe[1], bubble[1]))
    right = max(box[0] + box[2], min(safe[0] + safe[2], bubble[0] + bubble[2]))
    bottom = max(box[1] + box[3], min(safe[1] + safe[3], bubble[1] + bubble[3]))
    return [left, top, right - left, bottom - top]


def room_box(room, box):
    """Part 2: text sharing a detector box grows sideways into the measured room."""
    left = min(box[0], room["x"])
    right = max(box[0] + box[2], room["x"] + room["width"])
    return [left, box[1], right - left, box[3]]


def kept_on_outline(grown, box, outline_x):
    """A small widening stops at the outline; only one that pays for losing it goes past."""
    if not outline_x:
        return grown
    low, high = outline_x

    def on_outline(b, slack):
        return low <= b[0] + slack and high >= b[0] + b[2] - slack

    worth_leaving = grown[2] * grown[3] >= OUTLINE_WORTH_LEAVING * box[2] * box[3]
    if on_outline(grown, OUTLINE_SLACK_PX) or not on_outline(box, INSET_OUTLINE_SLACK_PX) or worth_leaving:
        return grown
    left = min(max(grown[0], low), box[0])
    right = max(min(grown[0] + grown[2], high), box[0] + box[2])
    return [left, grown[1], right - left, grown[3]]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--snapshot", required=True)
    ap.add_argument("--pages", help="directory of original pages, named by page id; needed with --room")
    ap.add_argument("--room", action="store_true")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if args.room:
        import cv2
        from worker.services.text_room import measure_text_room

    with open(args.snapshot) as handle:
        snapshot = json.load(handle)
    boxes = {}
    counts = {"safe_text": 0, "room": 0, "unmeasured": 0, "kept_by_neighbour": 0}
    for page in snapshot["pages"]:
        regions = page["regions"]
        by_bubble = {}
        for region in regions:
            by_bubble.setdefault(region["bubble_id"], []).append(region)
        gray = None
        drawn = [r for r in regions if r["box"]]
        for region in drawn:
            if region["hand"] or region["rotation"] or region["bubble"][2:] == region["bbox"][2:]:
                continue
            box = region["box"]
            siblings = [r for r in by_bubble[region["bubble_id"]] if r is not region]
            if region["resolution"] == "resolved-local-split" and siblings:
                if not args.room:
                    continue
                if gray is None:
                    gray = cv2.imread(os.path.join(args.pages, page["page"]), cv2.IMREAD_GRAYSCALE)
                room = measure_text_room(gray, tuple(region["bbox"]), [tuple(r["bbox"]) for r in siblings])
                if room is None:
                    counts["unmeasured"] += 1
                    continue
                grown = room_box(room, box)
                kind = "room"
            else:
                grown = safe_text_box(region, box, bool(siblings))
                kind = "safe_text"
            if grown is None:
                continue
            grown = kept_on_outline(grown, box, region.get("outline_x"))
            others = [r["box"] for r in drawn if r is not region]
            if runs_into_neighbour(grown, box, others):
                counts["kept_by_neighbour"] += 1
                continue
            boxes[region["region_id"]] = grown
            counts[kind] += 1
    with open(args.out, "w") as handle:
        json.dump(boxes, handle)
    print(counts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
