#!/usr/bin/env python3
"""Measure development layout proxies with reviewed-policy and candidate validation.

Rectangle metrics are proxies: they do not measure glyph pixels, source-container
boundaries, or final fitted font size. Candidate evaluation is deliberately
fail-closed: every selected page needs matching source, revision, snapshot and
export evidence before metrics are emitted.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def png_dimensions(path: Path) -> tuple[int, int]:
    header = path.read_bytes()[:24]
    if header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError(f"{path}: required export is not a PNG with an IHDR header")
    return int.from_bytes(header[16:20], "big"), int.from_bytes(header[20:24], "big")


def safe_rect(region: dict[str, Any]) -> tuple[float, float, float, float]:
    rect = (region.get("safeTextX"), region.get("safeTextY"), region.get("safeTextW"), region.get("safeTextH"))
    if None in rect or not rect[2] or not rect[3]:
        return (region.get("bboxX") or 0, region.get("bboxY") or 0, region.get("bboxW") or 0, region.get("bboxH") or 0)
    return rect


def element_box(element: dict[str, Any]) -> tuple[float, float, float, float]:
    x, y = element.get("x") or 0, element.get("y") or 0
    return x, y, x + (element.get("maxWidth") or 0), y + (element.get("maxHeight") or 0)


def translated_elements(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        element
        for layer in snapshot.get("layers", [])
        if (layer.get("layer") or {}).get("type") == "translation"
        for element in layer.get("elements", [])
    ]


def load_reconciliation(path: Path | None) -> dict[str, dict[str, Any]]:
    if path is None:
        return {}
    document = json.loads(path.read_text())
    result: dict[str, dict[str, Any]] = {}
    for page in document.get("pages", []):
        page_id = page.get("id") or page.get("sample")
        if not page_id:
            raise ValueError("reconciliation page is missing id")
        associations = page.get("associations", [])
        seen_owners: set[str] = set()
        for association in associations:
            owner_id = association.get("reviewed_owner_id")
            if not owner_id or owner_id in seen_owners:
                raise ValueError(f"{page_id}: missing or duplicate reviewed owner association")
            seen_owners.add(owner_id)
            if association.get("action") not in {"replace", "preserve", "explain", "review"}:
                raise ValueError(f"{page_id}: association {owner_id} has unsupported action")
        result[page_id] = {"source_sha256": page.get("source_sha256"), "associations": associations}
    return result


def measure_page(snapshot: dict[str, Any], reconciliation: dict[str, Any] | None = None) -> dict[str, Any]:
    regions = {region["id"]: region for region in snapshot.get("ocrRegions", []) if region.get("id")}
    elements = translated_elements(snapshot)
    visible = [element for element in elements if element.get("visible") and (element.get("text") or "").strip()]
    overflows, orphan_elements, sizes = [], 0, []
    for element in visible:
        region = regions.get(element.get("regionId"))
        if region is None:
            orphan_elements += 1
            continue
        sx, sy, sw, sh = safe_rect(region)
        x0, y0, x1, y1 = element_box(element)
        overflows.append(max(0, sx - x0, x1 - (sx + sw), sy - y0, y1 - (sy + sh)))
        if element.get("size") is not None:
            sizes.append(element["size"])

    overlaps = []
    pages_with_overlap = False
    for index, first in enumerate(visible):
        ax0, ay0, ax1, ay1 = element_box(first)
        for second in visible[index + 1 :]:
            bx0, by0, bx1, by1 = element_box(second)
            width, height = min(ax1, bx1) - max(ax0, bx0), min(ay1, by1) - max(ay0, by0)
            if width > 0 and height > 0:
                pages_with_overlap = True
                smaller = min(max(1, (ax1 - ax0) * (ay1 - ay0)), max(1, (bx1 - bx0) * (by1 - by0)))
                overlaps.append(width * height / smaller)

    policy: dict[str, Any] = {
        "coverage": "unresolved",
        "reviewed_owners": 0,
        "unresolved_associations": 0,
        "missing_expected_replacement_text": None,
        "rendered_policy_preserved_or_review_text": None,
        "multiple_reviewed_owners_mapped_to_one_element": None,
    }
    if reconciliation is not None:
        associations = reconciliation.get("associations", [])
        policy["reviewed_owners"] = len(associations)
        unresolved = [a for a in associations if a.get("mapping_state") != "resolved" or not a.get("candidate_region_id")]
        policy["unresolved_associations"] = len(unresolved)
        if not unresolved:
            missing_regions = [association["candidate_region_id"] for association in associations if association["candidate_region_id"] not in regions]
            if missing_regions:
                raise ValueError(f"resolved associations reference regions absent from snapshot: {', '.join(missing_regions)}")
            owner_to_element: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for association in associations:
                owner_to_element[association["reviewed_owner_id"]] = [e for e in visible if e.get("regionId") == association["candidate_region_id"]]
            replacement = [a for a in associations if a["action"] == "replace"]
            preserved = [a for a in associations if a["action"] in {"preserve", "review", "explain"}]
            policy.update({
                "coverage": "reviewed-associations-resolved",
                "missing_expected_replacement_text": sum(not owner_to_element[a["reviewed_owner_id"]] for a in replacement),
                "rendered_policy_preserved_or_review_text": sum(bool(owner_to_element[a["reviewed_owner_id"]]) for a in preserved),
                "multiple_reviewed_owners_mapped_to_one_element": sum(
                    len([a for a in associations if a.get("candidate_region_id") == region_id]) - 1
                    for region_id in {a.get("candidate_region_id") for a in associations}
                    if region_id
                ),
            })

    return {
        "regions": len(regions),
        "translation_elements": len(elements),
        "visible_text_elements": len(visible),
        "orphan_translation_elements": orphan_elements,
        "visible_empty_text_elements": sum(1 for element in elements if element.get("visible") and not (element.get("text") or "").strip()),
        "max_safe_rect_overflow_px": max(overflows, default=0),
        "elements_overflowing_safe_rect": sum(value > 0 for value in overflows),
        "safe_rect_overflow_rate": round(sum(value > 0 for value in overflows) / len(overflows), 4) if overflows else 0.0,
        "max_pairwise_element_rect_overlap_ratio": round(max(overlaps, default=0.0), 4),
        "overlapping_element_pairs": len(overlaps),
        "page_has_overlapping_element_rects": pages_with_overlap,
        "stored_translation_element_size_min_px": min(sizes, default=None),
        "final_fitted_font_size_px": "unknown: current snapshot stores configured element size, not measured final glyph size",
        "policy": policy,
    }

def aggregate_pages(pages: list[dict[str, Any]]) -> dict[str, Any]:
    metrics = [page["metrics"] for page in pages]
    visible = sum(metric["visible_text_elements"] for metric in metrics)
    sizes = [metric["stored_translation_element_size_min_px"] for metric in metrics if metric["stored_translation_element_size_min_px"] is not None]
    policy_values = [metric["policy"] for metric in metrics]
    resolved_policy = [policy for policy in policy_values if policy["coverage"] == "reviewed-associations-resolved"]
    policy_complete = len(resolved_policy) == len(policy_values)
    return {
        "pages": len(pages),
        "regions": sum(metric["regions"] for metric in metrics),
        "visible_text_elements": visible,
        "orphan_translation_elements": sum(metric["orphan_translation_elements"] for metric in metrics),
        "visible_empty_text_elements": sum(metric["visible_empty_text_elements"] for metric in metrics),
        "max_safe_rect_overflow_px": max((metric["max_safe_rect_overflow_px"] for metric in metrics), default=0),
        "safe_rect_overflow_rate": round(sum(metric["elements_overflowing_safe_rect"] for metric in metrics) / visible, 4) if visible else 0.0,
        "max_pairwise_element_rect_overlap_ratio": max((metric["max_pairwise_element_rect_overlap_ratio"] for metric in metrics), default=0.0),
        "pages_with_overlapping_element_rects": sum(metric["page_has_overlapping_element_rects"] for metric in metrics),
        "stored_translation_element_size_min_px": min(sizes, default=None),
        "final_fitted_font_size_px": "unknown: not exposed by current capture surface",
        "reviewed_policy_pages_resolved": len(resolved_policy),
        "reviewed_policy_pages_unresolved": len(policy_values) - len(resolved_policy),
        "missing_expected_replacement_text": sum(policy["missing_expected_replacement_text"] for policy in resolved_policy) if policy_complete else "unknown: reviewed associations unresolved",
        "rendered_policy_preserved_or_review_text": sum(policy["rendered_policy_preserved_or_review_text"] for policy in resolved_policy) if policy_complete else "unknown: reviewed associations unresolved",
        "multiple_reviewed_owners_mapped_to_one_element": sum(policy["multiple_reviewed_owners_mapped_to_one_element"] for policy in resolved_policy) if policy_complete else "unknown: reviewed associations unresolved",
    }



def aggregate_slices(pages: list[dict[str, Any]], key: str) -> dict[str, dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for page in pages:
        groups[str(page.get(key, "unknown"))].append(page)
    return {name: aggregate_pages(group) for name, group in sorted(groups.items())}

def compare(totals: dict[str, Any], thresholds: dict[str, Any]) -> list[dict[str, Any]]:
    metric_keys = {
        "rendered_preserved_or_review_regions": "rendered_policy_preserved_or_review_text",
        "orphan_translation_elements": "orphan_translation_elements",
        "visible_empty_text_elements": "visible_empty_text_elements",
        "canvas_dimensions": "canvas_dimensions",
        "merged_owner_elements": "multiple_reviewed_owners_mapped_to_one_element",
        "max_overflow_px_beyond_safe_text_rect": "max_safe_rect_overflow_px",
        "element_overflow_rate": "safe_rect_overflow_rate",
        "max_pairwise_element_overlap_ratio": "max_pairwise_element_rect_overlap_ratio",
        "min_rendered_font_size_px": "final_fitted_font_size_px",
        "pages_with_any_overlapping_pair": "pages_with_overlapping_element_rects",
    }
    checks = []
    for rule in [*thresholds.get("hard_invariants", []), *thresholds.get("bounded_metrics", [])]:
        name = rule.get("metric")
        key = metric_keys.get(name, name)
        observed = totals.get(key, "not executed")
        if name == "pages_with_any_overlapping_pair" and isinstance(observed, int) and totals.get("pages"):
            observed = observed / totals["pages"]
        expression = rule.get("rule") or rule.get("threshold") or ""
        literal_match = re.match(r"^\s*==\s+(exact|complete)\s*$", expression)
        if literal_match:
            expected = literal_match.group(1)
            passed = observed == expected
            checks.append({"id": rule.get("id"), "metric": name, "observed": observed, "rule": expression, "status": "passed" if passed else "failed", "pass": passed})
            continue
        match = re.match(r"^\s*(==|<=|>=)\s*(-?(?:\d+(?:\.\d*)?|\.\d+))", expression)
        if not isinstance(observed, (int, float)) or not match:
            checks.append({"id": rule.get("id"), "metric": name, "observed": observed, "rule": expression, "status": "not-executed", "pass": False})
            continue
        operator, limit = match.group(1), float(match.group(2))
        passed = {"==": observed == limit, "<=": observed <= limit, ">=": observed >= limit}[operator]
        checks.append({"id": rule.get("id"), "metric": name, "observed": observed, "rule": expression, "status": "passed" if passed else "failed", "pass": passed})
    return checks


def normalize_selected_manifest(selected: dict[str, Any]) -> dict[str, Any]:
    if "pages" in selected:
        return selected
    if selected.get("schema_version") != "a09-holdout-manifest/v1":
        raise ValueError("manifest must be a G0 pages manifest or frozen A09 holdout manifest")
    pages = []
    for language, entries in selected["languages"].items():
        for entry in entries:
            width, height = (int(value) for value in entry["dimensions"].split("x"))
            pages.append({
                "id": entry["sample_id"],
                "source_sha256": entry["source_sha256"],
                "source_dimensions": [width, height],
                "language": language,
                "style": entry["style"],
                "population": "frozen_holdout",
                "required_artifacts": [
                    "page-snapshot.json",
                    "editor.png",
                    "export.png",
                    "rendered.png",
                    "project.zip",
                ],
            })
    return {
        "pages": pages,
        "input_revisions": selected["heads"],
        "source_manifest": selected["schema_version"],
    }


def candidate_paths(candidates: dict[str, Any], selected: dict[str, Any]) -> list[tuple[dict[str, Any], Path]]:
    expected = {page["id"]: page for page in selected["pages"]}
    supplied = candidates.get("candidates", [])
    ids = [candidate.get("id") for candidate in supplied]
    duplicate = sorted({identifier for identifier in ids if ids.count(identifier) > 1})
    missing = sorted(set(expected) - set(ids))
    extraneous = sorted(set(ids) - set(expected))
    if duplicate or missing or extraneous:
        raise ValueError(f"candidate selection failed: duplicate={duplicate}, missing={missing}, extraneous={extraneous}")
    output = []
    expected_revisions = selected.get("input_revisions")
    for candidate in supplied:
        required = expected[candidate["id"]]
        if candidate.get("source_sha256") != required.get("source_sha256"):
            raise ValueError(f"{candidate['id']}: source hash mismatch")
        if expected_revisions and candidate.get("input_revisions") != expected_revisions:
            raise ValueError(f"{candidate['id']}: stale or mismatched input revisions")
        snapshot = Path(candidate.get("snapshot", ""))
        if not snapshot.is_file():
            raise ValueError(f"{candidate['id']}: missing snapshot")
        document = json.loads(snapshot.read_text())
        image = document.get("image") or {}
        if image.get("hash") != required.get("source_sha256"):
            raise ValueError(f"{candidate['id']}: snapshot source hash mismatch")
        expected_dimensions = required.get("source_dimensions")
        if expected_dimensions and (image.get("width"), image.get("height")) != tuple(expected_dimensions):
            raise ValueError(f"{candidate['id']}: snapshot source dimensions mismatch")
        artifacts = candidate.get("artifacts", {})
        for name in required.get("required_artifacts", []):
            artifact = artifacts.get(name)
            if not artifact:
                raise ValueError(f"{candidate['id']}: missing required artifact {name}")
            artifact_path = Path(artifact.get("path", ""))
            if not artifact_path.is_file() or sha256(artifact_path) != artifact.get("sha256"):
                raise ValueError(f"{candidate['id']}: invalid artifact {name}")
        export_artifact = artifacts.get("export.png")
        if export_artifact and expected_dimensions:
            if png_dimensions(Path(export_artifact["path"])) != tuple(expected_dimensions):
                raise ValueError(f"{candidate['id']}: export dimensions do not match source dimensions")
        candidate["language"] = required.get("language", "unknown")
        candidate["style"] = required.get("style", "unknown")
        candidate["population"] = required.get("population", "unknown")
        output.append((candidate, snapshot))
    return output


def score_pages() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshots", nargs="+", type=Path, help="development snapshot files/directories; not candidate evaluation")
    parser.add_argument("--manifest", type=Path, help="selected development/candidate manifest")
    parser.add_argument("--candidates", type=Path, help="candidate list; required with --manifest")
    parser.add_argument("--reconciliation", type=Path, help="reviewed owner/action mapping to current region IDs")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--label", default="unlabelled development measurement")
    parser.add_argument("--thresholds", type=Path)
    args = parser.parse_args()
    if bool(args.manifest) != bool(args.candidates):
        parser.error("--manifest and --candidates must be used together")
    if not args.manifest and not args.snapshots:
        parser.error("supply --snapshots for a development measurement or --manifest with --candidates")
    reconciliation = load_reconciliation(args.reconciliation)
    if args.manifest:
        selected = normalize_selected_manifest(json.loads(args.manifest.read_text()))
        candidates = json.loads(args.candidates.read_text())
        inputs = candidate_paths(candidates, selected)
        candidate_mode = True
    else:
        paths = []
        for target in args.snapshots:
            paths.extend(sorted(target.rglob("page-snapshot.json")) if target.is_dir() else [target])
        inputs, candidate_mode = [(None, path) for path in paths], False
    pages = []
    for candidate, snapshot_path in inputs:
        page_id = candidate["id"] if candidate else snapshot_path.parent.name
        snapshot = json.loads(snapshot_path.read_text())
        page = {"page": page_id, "snapshot": str(snapshot_path), "metrics": measure_page(snapshot, reconciliation.get(page_id))}
        if candidate:
            page.update({key: candidate[key] for key in ("source_sha256", "language", "style", "population")})
        pages.append(page)
    totals = aggregate_pages(pages)
    if candidate_mode:
        totals["source_export_dimensions"] = "exact"
        totals["candidate_identity"] = "exact"
        totals["reviewed_owner_action_mapping"] = (
            "complete"
            if totals["reviewed_policy_pages_unresolved"] == 0
            else "unresolved"
        )
    document = {
        "schema_version": "page-quality-measurement/v2",
        "measurement_set": args.label,
        "candidate_mode": candidate_mode,
        "metric_limitations": ["safe-rectangle overflow and element-rectangle overlap are geometry proxies", "final fitted font size is unknown until the rendering surface exposes measured glyph data", "unresolved reviewed associations are reported, never inferred from OCR IDs/order/proximity"],
        "totals": totals,
        "slices": {key: aggregate_slices(pages, key) for key in ("language", "style", "population")} if candidate_mode else {},
        "pages": pages,
    }
    if args.thresholds:
        thresholds = json.loads(args.thresholds.read_text())
        document["threshold_checks"] = compare(totals, thresholds)
        document["thresholds_source"] = str(args.thresholds)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(totals, indent=2))
    if args.thresholds and any(not check["pass"] for check in document["threshold_checks"]):
        raise SystemExit("threshold evaluation failed or was not executed; inspect threshold_checks")


if __name__ == "__main__":
    score_pages()
