"""Compare two layout snapshots and fail on anything a change did not declare.

A snapshot comes from layout_snapshot.cjs. Regions match by their OCR pieces, so they match across
a re-OCR that groups the pieces the same way. A change declares its footprint:

    python3 scripts/quality/compare_layout.py before.json after.json \\
        --allow-box resolved-local-split --accept accepted.json --out diff.json

These are violations, and make it exit 1:
- a box moved, or a region's pieces regrouped, outside the classes the change declares;
- anything moved on a hand-edited element;
- a new overlap between two text boxes;
- a new text collision: two regions' drawn lines sharing area (snapshots from 2026-11-08 on);
- the same text set smaller, by more than --px-drop;
- text that was drawn and no longer is;
- a page missing from either snapshot.

--accept lists the ones that were looked at, each with its reason:
    {"<page id>:<region key or overlap keys>": "why this is fine"}
An accepted item is still reported, so the reason stays with the run. A reworded translation is
counted but is not a violation, and its size change is not compared.

Classes are a region's container resolution (`resolved-bubble-container`, `resolved-local-split`,
`review-missing-container`) or `no-resolution`. --allow-grouping takes the same names.
"""

import argparse
import json
import sys

BOX_TOLERANCE_PX = 1.0


def region_class(region):
    return region.get("resolution") or "no-resolution"


def box_moved(a, b):
    return any(abs(x - y) > BOX_TOLERANCE_PX for x, y in zip(a, b, strict=True))


def tiny(region, page):
    return region.get("px") is not None and region["px"] < 0.015 * page["width"]


def compare(before, after, allow_box=(), allow_grouping=(), px_drop=0.1, accepted=None):
    accepted = accepted or {}
    report = {
        "before": before["meta"],
        "after": after["meta"],
        "allowed": {"box": sorted(allow_box), "grouping": sorted(allow_grouping)},
        "counts": {
            "pages": len(after["pages"]),
            "boxes_moved": 0,
            "bigger": 0,
            "smaller": 0,
            "same_size": 0,
            "reworded": 0,
            "regrouped": 0,
            "newly_drawn": 0,
            "overlaps_before": 0,
            "overlaps_after": 0,
            "text_collisions_before": 0,
            "text_collisions_after": 0,
            "tiny_before": 0,
            "tiny_after": 0,
        },
        "violations": [],
        "accepted": [],
        "moved": [],
    }
    counts = report["counts"]

    def flag(kind, page_id, key, detail):
        entry = {"kind": kind, "page": page_id, "key": key, "detail": detail}
        reason = accepted.get(f"{page_id}:{key}")
        if reason:
            report["accepted"].append(entry | {"reason": reason})
        else:
            report["violations"].append(entry)

    pages_after = {page["page"]: page for page in after["pages"]}
    pages_before = {page["page"]: page for page in before["pages"]}
    for page_id in pages_before.keys() ^ pages_after.keys():
        flag("page-missing", page_id, page_id, "in only one snapshot")

    for page_id in pages_before.keys() & pages_after.keys():
        old, new = pages_before[page_id], pages_after[page_id]
        old_regions = {region["key"]: region for region in old["regions"]}
        new_regions = {region["key"]: region for region in new["regions"]}
        counts["tiny_before"] += sum(tiny(r, old) for r in old["regions"])
        counts["tiny_after"] += sum(tiny(r, new) for r in new["regions"])

        for key in old_regions.keys() ^ new_regions.keys():
            region = old_regions.get(key) or new_regions[key]
            counts["regrouped"] += 1
            if region.get("hand"):
                flag("hand-edited-regrouped", page_id, key, region_class(region))
            elif region_class(region) not in allow_grouping:
                flag("regrouped-outside-footprint", page_id, key, region_class(region))

        for key in old_regions.keys() & new_regions.keys():
            a, b = old_regions[key], new_regions[key]
            if a.get("box") is None or b.get("box") is None:
                # Text appearing is a region gaining a translation. Text disappearing is a loss.
                if a.get("box") is None and b.get("box") is not None:
                    counts["newly_drawn"] += 1
                elif a.get("box") is not None:
                    flag("no-longer-drawn", page_id, key, region_class(a))
                continue
            moved = box_moved(a.get("box"), b.get("box"))
            reworded = a.get("text_sha") != b.get("text_sha")
            counts["reworded"] += reworded
            if moved:
                counts["boxes_moved"] += 1
                report["moved"].append(
                    {"page": page_id, "key": key, "box": [a.get("box"), b.get("box")], "px": [a.get("px"), b.get("px")]}
                )
                if a.get("hand"):
                    flag("hand-edited-moved", page_id, key, region_class(a))
                elif region_class(a) not in allow_box:
                    flag("box-moved-outside-footprint", page_id, key, region_class(a))
            if reworded or a.get("px") is None or b.get("px") is None:
                continue
            if b["px"] > a["px"]:
                counts["bigger"] += 1
            elif b["px"] < a["px"]:
                counts["smaller"] += 1
                if b["px"] < a["px"] * (1 - px_drop):
                    flag("smaller", page_id, key, f'{a["px"]} to {b["px"]} px')
            else:
                counts["same_size"] += 1

        old_pairs = {tuple(pair[:2]) for pair in old["overlaps"]}
        new_pairs = {tuple(pair[:2]) for pair in new["overlaps"]}
        counts["overlaps_before"] += len(old_pairs)
        counts["overlaps_after"] += len(new_pairs)
        for pair in sorted(new_pairs - old_pairs):
            # A pair containing a regrouped region can't be compared with the old pairs.
            if pair[0] in old_regions and pair[1] in old_regions:
                flag("new-overlap", page_id, "+".join(pair), "text boxes overlap")

        old_hits = {tuple(hit[:2]) for hit in old.get("text_collisions", [])}
        new_hits = {tuple(hit[:2]): hit for hit in new.get("text_collisions", [])}
        counts["text_collisions_before"] += len(old_hits)
        counts["text_collisions_after"] += len(new_hits)
        for pair in sorted(new_hits.keys() - old_hits):
            if pair[0] in old_regions and pair[1] in old_regions:
                flag("new-text-collision", page_id, "+".join(pair), f"drawn lines share {new_hits[pair][2]} px²")
    report["violations"].sort(key=lambda v: (v["kind"], v["page"], v["key"]))
    return report


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("before")
    ap.add_argument("after")
    ap.add_argument("--allow-box", action="append", default=[], help="a class whose boxes this change may move")
    ap.add_argument("--allow-grouping", action="append", default=[], help="a class this change may regroup")
    ap.add_argument("--px-drop", type=float, default=0.1, help="how much smaller the same text may get")
    ap.add_argument("--accept", help="JSON of items looked at, with their reasons")
    ap.add_argument("--out", help="write the full report here")
    args = ap.parse_args()

    with open(args.before) as handle:
        before = json.load(handle)
    with open(args.after) as handle:
        after = json.load(handle)
    accepted = {}
    if args.accept:
        with open(args.accept) as handle:
            accepted = json.load(handle)
    report = compare(before, after, args.allow_box, args.allow_grouping, args.px_drop, accepted)
    if args.out:
        with open(args.out, "w") as handle:
            json.dump(report, handle, indent=1)

    print(f"before {before['meta']['label']} ({before['meta']['repo_commit']}), after {after['meta']['label']} ({after['meta']['repo_commit']})")
    for name, value in report["counts"].items():
        print(f"  {name}: {value}")
    for entry in report["accepted"]:
        print(f"  accepted {entry['kind']} {entry['page']} {entry['key']}: {entry['reason']}")
    for entry in report["violations"]:
        print(f"  VIOLATION {entry['kind']} {entry['page']} {entry['key']}: {entry['detail']}")
    print(f"{len(report['violations'])} violations")
    return 1 if report["violations"] else 0


if __name__ == "__main__":
    sys.exit(main())
