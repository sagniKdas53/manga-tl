"""Draft A09 holdout ownership and region-action labels from fresh stage snapshots.

Reads each page's `page-snapshot.json` captured by `scripts/playwright/export_pending.cjs`
and emits one conservative draft label per final OCR region. Detector bubble IDs, panels and
proximity never establish a shared owner: a bubble that holds several regions is recorded as
unresolved and left for review.

Drafts are not a review. `scripts/review_a09_labels.py` records the reviewed conclusion.
"""

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
LOW_OCR_SCORE = 0.6


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def classify(region, shared_bubble):
    """Return (classification, action, basis) for one final OCR region."""
    region_type = (region.get("regionType") or "").lower()
    qa_status = str(region.get("qaStatus") or "")
    score = region.get("ocrScore") or 0.0
    bubble_id = str(region.get("bubbleId") or "")
    free_standing = bubble_id.startswith("direct_text")

    if qa_status.startswith("reject_sfx") or region_type == "sfx":
        return (
            "draft-non-dialogue-sfx",
            "preserve",
            f"QA {qa_status or 'n/a'}, regionType {region_type or 'n/a'}: drawn effect retains source pixels.",
        )
    if qa_status.startswith("reject"):
        return (
            "draft-non-dialogue",
            "preserve",
            f"QA {qa_status}: pipeline declined replacement; source pixels retained.",
        )
    if score < LOW_OCR_SCORE or qa_status == "failed":
        return (
            "draft-uncertain",
            "review",
            f"OCR score {score:.2f}, QA {qa_status or 'n/a'}: recognition confidence too low to authorize replacement.",
        )
    if region_type in {"sign", "caption"} or free_standing:
        return (
            "draft-free-standing-text",
            "explain",
            f"regionType {region_type or 'n/a'}, container {bubble_id or 'n/a'}: unenclosed or signage text is explained, not silently replaced.",
        )
    if shared_bubble:
        return (
            "draft-shared-container-unresolved",
            "review",
            f"Detector container {bubble_id} holds several regions; shared containment is not ownership evidence.",
        )
    return (
        "draft-independent-dialogue",
        "replace_candidate",
        f"regionType {region_type}, QA {qa_status}, OCR score {score:.2f}: locally bounded dialogue owner.",
    )


def build_page_labels(sample_id, language, snapshot, source_path):
    regions = snapshot.get("ocrRegions", [])
    bubble_counts = Counter(str(r.get("bubbleId") or "") for r in regions)
    labels = []
    for index, region in enumerate(regions, start=1):
        bubble_id = str(region.get("bubbleId") or "")
        shared = (
            bool(bubble_id)
            and not bubble_id.startswith("direct_text")
            and bubble_counts[bubble_id] > 1
        )
        classification, action, basis = classify(region, shared)
        labels.append(
            {
                "id": f"{sample_id}-r{index:03d}",
                "region_id": region.get("id"),
                "owner_id": f"{sample_id}-owner-r{index:03d}",
                "container_id": "unresolved-shared-detector-bubble"
                if shared
                else f"source-local:{sample_id}-r{index:03d}",
                "classification": classification,
                "action": action,
                "geometry": {
                    "coordinate_space": "source-pixels",
                    "role": "final OCR bbox",
                    "bbox": [
                        region.get("bboxX"),
                        region.get("bboxY"),
                        region.get("bboxW"),
                        region.get("bboxH"),
                    ],
                },
                "source_text": region.get("text"),
                "qa_status": region.get("qaStatus"),
                "ocr_score": region.get("ocrScore"),
                "evidence_basis": basis,
                "review_state": "draft",
            }
        )
    return {
        "sample": sample_id,
        "language": language,
        "source_path": str(source_path.resolve().relative_to(REPO)),
        "source_digest": sha256(source_path),
        "final_ocr_region_count": len(labels),
        "raw_a02_fragment_capture": "absent",
        "labels": labels,
    }


def build_a09_labels():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--run",
        type=Path,
        required=True,
        help="stage run directory containing pages/<lang>/<sample>",
    )
    parser.add_argument("--roster", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    roster = json.loads(args.roster.read_text())
    roster_ids = {row["label"] for rows in roster["languages"].values() for row in rows}

    pages, missing = [], []
    for language_dir in sorted((args.run / "pages").iterdir()):
        if not language_dir.is_dir():
            continue
        for sample_dir in sorted(language_dir.iterdir()):
            snapshot_path = sample_dir / "page-snapshot.json"
            meta_path = sample_dir / "meta.json"
            if not snapshot_path.exists() or not meta_path.exists():
                missing.append(sample_dir.name)
                continue
            meta = json.loads(meta_path.read_text())
            source_path = sample_dir / meta["source"]["file"]
            page = build_page_labels(
                sample_dir.name,
                language_dir.name,
                json.loads(snapshot_path.read_text()),
                source_path,
            )
            page["roster_role"] = (
                "roster" if sample_dir.name in roster_ids else "reserve"
            )
            pages.append(page)

    actions = Counter(label["action"] for page in pages for label in page["labels"])
    classifications = Counter(
        label["classification"] for page in pages for label in page["labels"]
    )
    document = {
        "schema_version": "a09-holdout-labels/v1",
        "task": "A09",
        "status": "draft",
        "label_policy": (
            "One conservative draft per final OCR region. Detector bubble IDs, panels, conversation order and "
            "proximity never establish a shared owner or container. Shared detector containers and low-confidence "
            "recognition are recorded as review, not merged or replaced."
        ),
        "counts": {
            "pages": len(pages),
            "roster_pages": sum(1 for page in pages if page["roster_role"] == "roster"),
            "reserve_pages": sum(
                1 for page in pages if page["roster_role"] == "reserve"
            ),
            "labels": sum(page["final_ocr_region_count"] for page in pages),
            "actions": dict(actions),
            "classifications": dict(classifications),
            "pages_without_snapshot": missing,
        },
        "sources": pages,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(document["counts"], indent=2))


if __name__ == "__main__":
    build_a09_labels()
