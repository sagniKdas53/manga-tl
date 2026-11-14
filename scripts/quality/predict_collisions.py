"""Predict #182: where two regions' text collides, the smaller one gives way. For layout_snapshot.cjs --what-if.

The owner's rules (2026-11-08):
- A hand-edited box keeps its shape: a person already chose it. Two hand-edited boxes are left for review.
  A page edited by hand isn't touched at all, as machine QA leaves it alone.
- Otherwise the bigger one keeps its shape, by a ladder: first the source text's footprint (its OCR box),
  and when those are about the same, the one with more translated text.
- The other is shrunk back from it, on whichever side keeps the most of it. Never moved (LOCK-1).
- A shrink that would leave too little goes to review instead, as does a pair with rotated text on either
  side: line boxes are before rotation, so they don't say where rotated text really is.
- So does a shrink whose text would come out tiny, judged before any render by scaling the drawn px by the
  share of box area kept. On 2026-11-08's stack that flagged the 5 shrinks a re-render found tiny, and one
  more (a 72 px line on a 4093 px wide page), so it errs toward not trimming.

backend-rust/src/overlap_shrink.rs applies the same rules after each pipeline render; keep them in step.

--trigger text shrinks only where drawn lines collide (the snapshot's text_collisions). --trigger box shrinks
wherever boxes overlap by more than 10% of the smaller, which is all the backend can see before text is
fitted. Comparing the two says what the box trigger costs.

    python3 scripts/quality/predict_collisions.py --snapshot base.json --trigger text --out whatif.json
"""

import argparse
import json
import sys

GAP_PX = 4
# About the same footprint: within this share of the smaller.
SAME_FOOTPRINT = 0.15
# A shrink must keep this share of the box and this many px on each side, or it goes to review.
KEEP_AT_LEAST = 0.4
MIN_SIDE_PX = 24
OVERLAP_SHARE = 0.1
# Under this share of the page width, text counts as tiny (as compare_layout.py and the ledger count it).
TINY_SHARE = 0.015


def area(box):
    return max(box[2], 0) * max(box[3], 0)


def area_shared(a, b):
    w = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    h = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    return max(w, 0) * max(h, 0)


def keeps_its_shape(a, b):
    """The key of the region that keeps its shape, or None when neither may give way."""
    if a["hand"] and b["hand"]:
        return None
    if a["hand"] or b["hand"]:
        return a["key"] if a["hand"] else b["key"]
    fa, fb = area(a["bbox"]), area(b["bbox"])
    if max(fa, fb) > (1 + SAME_FOOTPRINT) * min(fa, fb):
        return a["key"] if fa > fb else b["key"]
    if (a["text_len"] or 0) != (b["text_len"] or 0):
        return a["key"] if (a["text_len"] or 0) > (b["text_len"] or 0) else b["key"]
    return a["key"] if fa >= fb else b["key"]


def shrunk(loser, keeper):
    """The loser's box cut back from the keeper's on one side, or None if every cut leaves too little."""
    x, y, w, h = loser
    kx, ky, kw, kh = keeper
    options = []
    if kx > x:  # cut the right edge back
        options.append([x, y, kx - GAP_PX - x, h])
    if kx + kw < x + w:  # cut the left edge forward
        left = kx + kw + GAP_PX
        options.append([left, y, x + w - left, h])
    if ky > y:  # cut the bottom up
        options.append([x, y, w, ky - GAP_PX - y])
    if ky + kh < y + h:  # cut the top down
        top = ky + kh + GAP_PX
        options.append([x, top, w, y + h - top])
    good = [
        o
        for o in options
        if o[2] >= MIN_SIDE_PX and o[3] >= MIN_SIDE_PX and area(o) >= KEEP_AT_LEAST * area(loser) and not area_shared(o, keeper)
    ]
    return max(good, key=area) if good else None


def triggered_pairs(page, rows, boxes, trigger):
    if trigger == "text":
        return [tuple(hit[:2]) for hit in page.get("text_collisions", []) if hit[0] in rows and hit[1] in rows]
    keys = sorted(boxes)
    pairs = []
    for i, a in enumerate(keys):
        for b in keys[i + 1 :]:
            smaller = min(area(boxes[a]), area(boxes[b])) or 1
            if area_shared(boxes[a], boxes[b]) / smaller > OVERLAP_SHARE:
                pairs.append((a, b))
    return pairs


def would_be_tiny(region, cut, page_width):
    """Text that isn't tiny now but would be in `cut`, by the drawn px times the share of area kept."""
    px = region.get("px")
    if not px or not page_width:
        return False
    tiny = TINY_SHARE * page_width
    return px >= tiny and px * area(cut) / (area(region["box"]) or 1) < tiny


def predict_page(page, trigger):
    """({region id: new box}, [review entries])."""
    if page.get("hand_edited"):
        return {}, []
    rows = {r["key"]: r for r in page["regions"] if r.get("box")}
    boxes = {key: list(r["box"]) for key, r in rows.items()}
    changed, review = {}, []
    # Biggest overlap first, so a box that gives way to two neighbours does so for the worst one first.
    pairs = sorted(
        triggered_pairs(page, rows, boxes, trigger), key=lambda p: -area_shared(boxes[p[0]], boxes[p[1]])
    )
    for a, b in pairs:
        if not area_shared(boxes[a], boxes[b]):
            continue  # an earlier shrink already parted them
        keeper = keeps_its_shape(rows[a], rows[b])
        if keeper is None:
            review.append({"pair": [a, b], "reason": "both hand-edited"})
            continue
        loser = b if keeper == a else a
        if rows[a].get("rotation") or rows[b].get("rotation"):
            review.append({"pair": [a, b], "loser": loser, "reason": "rotated"})
            continue
        cut = shrunk(boxes[loser], boxes[keeper])
        if cut is None:
            review.append({"pair": [a, b], "loser": loser, "reason": "too little would be left"})
            continue
        if would_be_tiny(rows[loser], cut, page.get("width")):
            review.append({"pair": [a, b], "loser": loser, "reason": "text would be tiny"})
            continue
        boxes[loser] = cut
        changed[loser] = cut
    return {rows[key]["region_id"]: [round(v, 1) for v in box] for key, box in changed.items()}, review


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--snapshot", required=True)
    ap.add_argument("--trigger", choices=["text", "box"], default="text")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    snapshot = json.load(open(args.snapshot))
    whatif, report = {}, {"trigger": args.trigger, "pages": []}
    for page in snapshot["pages"]:
        boxes, review = predict_page(page, args.trigger)
        whatif.update(boxes)
        if boxes or review:
            report["pages"].append({"page": page["page"], "shrunk": len(boxes), "review": review})
    json.dump(whatif, open(args.out, "w"))
    json.dump(report, open(args.out.replace(".json", "") + "-report.json", "w"), indent=1)
    reasons = {}
    for page in report["pages"]:
        for entry in page["review"]:
            reasons[entry["reason"]] = reasons.get(entry["reason"], 0) + 1
    print(f"trigger {args.trigger}: {len(whatif)} boxes shrunk on {sum(1 for p in report['pages'] if p['shrunk'])} pages; review: {reasons or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
