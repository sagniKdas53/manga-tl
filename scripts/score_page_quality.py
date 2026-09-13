"""Measure frozen A09 layout-quality metrics from captured page snapshots.

Computes, per page, the metrics named in `A09-quality-thresholds.json`: owner mapping,
overflow beyond the region safe-text rect, pairwise overlap between visible translated
elements, rendered font floor, empty visible elements, and rendered preserve/review regions.

The script measures; it does not decide a gate. Threshold comparison is reported only when
`--thresholds` is given, so development baselines can be measured without implying a holdout
evaluation.
"""

import argparse
import json
from collections import Counter
from pathlib import Path


def safe_rect(region):
    rect = (
        region.get("safeTextX"),
        region.get("safeTextY"),
        region.get("safeTextW"),
        region.get("safeTextH"),
    )
    if None in rect or not rect[2] or not rect[3]:
        return (
            region.get("bboxX") or 0,
            region.get("bboxY") or 0,
            region.get("bboxW") or 0,
            region.get("bboxH") or 0,
        )
    return rect


def element_box(element):
    x = element.get("x") or 0
    y = element.get("y") or 0
    return x, y, x + (element.get("maxWidth") or 0), y + (element.get("maxHeight") or 0)


def measure_page(snapshot):
    regions = {region["id"]: region for region in snapshot.get("ocrRegions", [])}
    elements = [
        element
        for layer in snapshot.get("layers", [])
        if (layer.get("layer") or {}).get("type") == "translation"
        for element in layer.get("elements", [])
    ]
    visible = [
        element
        for element in elements
        if element.get("visible") and (element.get("text") or "").strip()
    ]

    overflows, orphans, sizes = [], 0, []
    for element in visible:
        region = regions.get(element.get("regionId"))
        if region is None:
            orphans += 1
            continue
        sx, sy, sw, sh = safe_rect(region)
        x0, y0, x1, y1 = element_box(element)
        overflows.append(max(0, sx - x0, x1 - (sx + sw), sy - y0, y1 - (sy + sh)))
        if element.get("size"):
            sizes.append(element["size"])

    overlaps = []
    for index, first in enumerate(visible):
        ax0, ay0, ax1, ay1 = element_box(first)
        for second in visible[index + 1 :]:
            bx0, by0, bx1, by1 = element_box(second)
            width = min(ax1, bx1) - max(ax0, bx0)
            height = min(ay1, by1) - max(ay0, by0)
            if width > 0 and height > 0:
                smaller = min(
                    max(1, (ax1 - ax0) * (ay1 - ay0)), max(1, (bx1 - bx0) * (by1 - by0))
                )
                overlaps.append(width * height / smaller)

    rendered_region_ids = {
        element.get("regionId")
        for element in visible
        if element.get("regionId") is not None
    }
    blocked = [
        region_id
        for region_id, region in regions.items()
        if str(region.get("qaStatus") or "").startswith("reject")
        and region_id in rendered_region_ids
    ]
    shared = [
        region_id
        for region_id, region in regions.items()
        if sum(1 for element in visible if element.get("regionId") == region_id) > 1
    ]

    return {
        "regions": len(regions),
        "translation_elements": len(elements),
        "visible_text_elements": len(visible),
        "orphan_translation_elements": orphans,
        "visible_empty_text_elements": sum(
            1
            for element in elements
            if element.get("visible") and not (element.get("text") or "").strip()
        ),
        "rendered_preserved_or_review_regions": len(blocked),
        "merged_owner_elements": len(shared),
        "max_overflow_px": max(overflows, default=0),
        "elements_overflowing": sum(1 for value in overflows if value > 0),
        "element_overflow_rate": round(
            sum(1 for value in overflows if value > 0) / len(overflows), 4
        )
        if overflows
        else 0.0,
        "max_pairwise_element_overlap_ratio": round(max(overlaps, default=0.0), 4),
        "overlapping_pairs": len(overlaps),
        "min_rendered_font_size_px": min(sizes, default=None),
        "qa_statuses": dict(
            Counter(
                str(region.get("qaStatus") or "none") for region in regions.values()
            )
        ),
    }


def aggregate_pages(pages):
    font_sizes = [
        page["metrics"]["min_rendered_font_size_px"]
        for page in pages
        if page["metrics"]["min_rendered_font_size_px"]
    ]
    overflow_elements = sum(page["metrics"]["elements_overflowing"] for page in pages)
    visible_elements = sum(page["metrics"]["visible_text_elements"] for page in pages)
    return {
        "pages": len(pages),
        "regions": sum(page["metrics"]["regions"] for page in pages),
        "visible_text_elements": visible_elements,
        "orphan_translation_elements": sum(
            page["metrics"]["orphan_translation_elements"] for page in pages
        ),
        "visible_empty_text_elements": sum(
            page["metrics"]["visible_empty_text_elements"] for page in pages
        ),
        "rendered_preserved_or_review_regions": sum(
            page["metrics"]["rendered_preserved_or_review_regions"] for page in pages
        ),
        "merged_owner_elements": sum(
            page["metrics"]["merged_owner_elements"] for page in pages
        ),
        "max_overflow_px": max(
            (page["metrics"]["max_overflow_px"] for page in pages), default=0
        ),
        "element_overflow_rate": round(overflow_elements / visible_elements, 4)
        if visible_elements
        else 0.0,
        "max_pairwise_element_overlap_ratio": max(
            (page["metrics"]["max_pairwise_element_overlap_ratio"] for page in pages),
            default=0.0,
        ),
        "pages_with_any_overlapping_pair": sum(
            1 for page in pages if page["metrics"]["overlapping_pairs"] > 0
        ),
        "min_rendered_font_size_px": min(font_sizes, default=None),
    }


def compare(totals, thresholds):
    checks = []
    for invariant in thresholds["hard_invariants"]:
        metric = invariant["metric"]
        if metric in totals:
            checks.append(
                {
                    "id": invariant["id"],
                    "metric": metric,
                    "observed": totals[metric],
                    "rule": invariant["rule"],
                    "pass": totals[metric] == 0,
                }
            )
    rules = {
        "max_overflow_px_beyond_safe_text_rect": ("max_overflow_px", lambda v: v <= 20),
        "element_overflow_rate": ("element_overflow_rate", lambda v: v <= 0.22),
        "max_pairwise_element_overlap_ratio": (
            "max_pairwise_element_overlap_ratio",
            lambda v: v <= 0.21,
        ),
        "min_rendered_font_size_px": (
            "min_rendered_font_size_px",
            lambda v: v is None or v >= 24,
        ),
    }
    for bounded in thresholds["bounded_metrics"]:
        rule = rules.get(bounded["metric"])
        if not rule:
            continue
        key, predicate = rule
        checks.append(
            {
                "id": bounded["id"],
                "metric": bounded["metric"],
                "observed": totals[key],
                "rule": bounded["threshold"],
                "pass": predicate(totals[key]),
            }
        )
    return checks


def score_pages():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--snapshots",
        nargs="+",
        type=Path,
        required=True,
        help="page-snapshot.json files or directories to search",
    )
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--label", default="unlabelled measurement set")
    parser.add_argument("--thresholds", type=Path)
    args = parser.parse_args()

    snapshot_paths = []
    for target in args.snapshots:
        if target.is_dir():
            snapshot_paths.extend(sorted(target.rglob("page-snapshot.json")))
        else:
            snapshot_paths.append(target)

    pages = [
        {
            "page": str(path.parent.name),
            "snapshot": str(path),
            "metrics": measure_page(json.loads(path.read_text())),
        }
        for path in snapshot_paths
    ]
    totals = aggregate_pages(pages)
    document = {
        "schema_version": "page-quality-measurement/v1",
        "measurement_set": args.label,
        "totals": totals,
        "pages": pages,
    }
    if args.thresholds:
        thresholds = json.loads(args.thresholds.read_text())
        document["threshold_checks"] = compare(totals, thresholds)
        document["thresholds_source"] = str(args.thresholds)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(totals, indent=2))


if __name__ == "__main__":
    score_pages()
