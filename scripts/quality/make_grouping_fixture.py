"""Write the worker's grouping fixture: piece positions from OCR captures, with no text and no images.

Two runs, in the worker image with this repo's worker/src and worker on the path, as
replay_grouping.py is. The first finds the pages whose grouping needs their image (the balloon join's
wall check), with the column step off because the captures predate it. The second writes the fixture
without them, with the code as it stands:

    OCR_NO_BALLOON_COLUMN_STEP=0 python scripts/quality/make_grouping_fixture.py <inputs> --differs-out differs.json
    python scripts/quality/make_grouping_fixture.py <inputs> --exclude-from differs.json \\
        --out worker/tests/fixtures/grouping_golden.json

<inputs> is --captures <dir> --pages <dir> --panels panels.json. The expected groups are what this code
produces: rerun the second when a change to grouping is meant, and add a row to the layout ledger.
"""

import argparse
import hashlib
import json
import os
import sys

import cv2


def opaque(value):
    return hashlib.sha256(value.encode()).hexdigest()[:12]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--captures", required=True)
    ap.add_argument("--pages", required=True)
    ap.add_argument("--panels", required=True)
    ap.add_argument("--out", help="write the fixture here")
    ap.add_argument("--differs-out", help="write the pages that don't reproduce the captures here")
    ap.add_argument("--exclude-from", help="leave out the pages listed in this file")
    args = ap.parse_args()

    from tests.grouping_replay import group_page

    import worker.handlers.ocr as handler

    panels = json.load(open(args.panels))
    excluded = set(json.load(open(args.exclude_from))) if args.exclude_from else set()
    pages, differs = [], []
    for page_id in sorted(os.listdir(args.pages)):
        if opaque(page_id) in excluded:
            continue
        capture = json.load(open(os.path.join(args.captures, f"{page_id}.json")))
        image = cv2.imread(os.path.join(args.pages, page_id))
        height, width = image.shape[:2]
        pieces = [
            {
                "x": region["x"],
                "y": region["y"],
                "width": region["width"],
                "height": region["height"],
                "sourceQuad": region.get("sourceQuad"),
                "fragmentId": opaque(capture["fragment_features"][index]["id"]),
            }
            for index, region in enumerate(capture["regions"])
        ]
        page = {
            "page": opaque(page_id),
            "width": width,
            "height": height,
            "grouping": capture["grouping"],
            "balloons": [mask["points"] for mask in capture["detector_masks"]],
            "containers": [*panels.get(page_id, []), *handler.detect_text_containers(image)],
            "gutter": handler.find_spread_gutter(image, [dict(region) for region in capture["regions"]]),
            "pieces": pieces,
        }
        page["groups"] = group_page(page)
        live = {frozenset(opaque(i) for i in owner["fragment_ids"]) for owner in capture["final_owners"]}
        if {frozenset(group) for group in page["groups"]} != live:
            differs.append(page["page"])
        pages.append(page)

    print(f"{len(pages)} pages, left out {len(excluded)}, {len(differs)} differ from the captures")
    if args.differs_out:
        with open(args.differs_out, "w") as handle:
            json.dump(differs, handle)
    if args.out:
        with open(args.out, "w") as handle:
            handle.write('{"pages":[\n')
            handle.write(",\n".join(json.dumps(page, separators=(",", ":")) for page in pages))
            handle.write("\n]}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
