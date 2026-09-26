"""Apply source-pixel review verdicts to A09 draft labels.

Draft labels are machine-generated from pipeline metadata. This script records the reviewer's
per-region visual conclusion over them, so ownership and region action come from inspected
pixels rather than detector output. Pages without a verdict keep their draft state.
"""

import argparse
import json
from collections import Counter
from pathlib import Path

VERDICTS = {
    "a": (
        "reviewed-non-text-detection",
        "review",
        "Reviewed source pixels contain no text in this box; a detector false positive may not authorize replacement or cleanup.",
    ),
    "b": (
        "reviewed-merged-container",
        "review",
        "Reviewed source pixels show the box spanning several separate speech containers; ownership is unresolved and may not be replaced as one owner.",
    ),
    "c": (
        "reviewed-non-dialogue-sfx",
        "preserve",
        "Reviewed source pixels show a drawn sound effect; its source pixels and OCR metadata are retained.",
    ),
    "d": (
        "reviewed-free-standing-text",
        "explain",
        "Reviewed source pixels show text outside any speech container; it is explained rather than silently replaced.",
    ),
    "e": (
        "reviewed-independent-dialogue",
        "replace_candidate",
        "Reviewed source pixels show one locally bounded dialogue owner inside its own container.",
    ),
}


def review_labels():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--draft", type=Path, required=True)
    parser.add_argument("--verdicts", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    document = json.loads(args.draft.read_text())
    verdicts = json.loads(args.verdicts.read_text())["verdicts"]

    reviewed_pages = 0
    for page in document["sources"]:
        codes = verdicts.get(page["sample"])
        if not codes:
            continue
        if len(codes) != len(page["labels"]):
            raise SystemExit(
                f"{page['sample']}: {len(codes)} verdicts for {len(page['labels'])} labels"
            )
        reviewed_pages += 1
        for label, code in zip(page["labels"], codes, strict=True):
            classification, action, basis = VERDICTS[code]
            label["classification"] = classification
            label["action"] = action
            label["evidence_basis"] = basis
            label["review_state"] = "reviewed"
            if code == "b":
                label["container_id"] = "unresolved-merged-container"
            elif code == "a":
                label["container_id"] = "none-no-text"

    reviewed = [
        label
        for page in document["sources"]
        for label in page["labels"]
        if label["review_state"] == "reviewed"
    ]
    document["status"] = "reviewed"
    document["schema_version"] = "a09-holdout-labels/v2"
    document["review"] = {
        "method": "Per-region source-pixel review over retained final OCR boxes; detector containers, panels, conversation order and proximity were not treated as ownership evidence.",
        "reviewed_pages": reviewed_pages,
        "reviewed_labels": len(reviewed),
        "draft_labels": document["counts"]["labels"] - len(reviewed),
        "actions": dict(Counter(label["action"] for label in reviewed)),
        "classifications": dict(Counter(label["classification"] for label in reviewed)),
    }
    args.out.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(document["review"], indent=2))


if __name__ == "__main__":
    review_labels()
