#!/usr/bin/env python3
"""Extract embedded corpus stage timestamps without using filesystem mtimes."""

import argparse
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def collect(corpus: Path) -> list[dict]:
    rows = []
    for language in ("ja", "ko", "zh"):
        for sample in sorted((corpus / "samples" / language).glob("sample*")):
            project_path = sample / "project" / "project.json"
            if not project_path.is_file():
                continue
            project = json.loads(project_path.read_text(encoding="utf-8"))
            stages: list[dict] = []
            for layer in project.get("layers", []):
                metadata = layer.get("metadataJson") or {}
                layer_type = layer.get("type")
                for field in ("time", "last_modified"):
                    timestamp = parse_time(metadata.get(field))
                    if timestamp:
                        stages.append({"type": layer_type, "field": field, "at": timestamp.isoformat().replace("+00:00", "Z")})
                qa = metadata.get("qa") or {}
                timestamp = parse_time(qa.get("last_qa_at"))
                if timestamp:
                    stages.append({"type": layer_type, "field": "last_qa_at", "at": timestamp.isoformat().replace("+00:00", "Z")})
            rows.append({"sample": f"{language}/{sample.name}", "exportedAt": project.get("exportedAt"), "stages": stages})
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, default=Path(__file__).parents[2] / "corpus")
    args = parser.parse_args()
    rows = collect(args.corpus)
    by_type: dict[str, list[datetime]] = {}
    for row in rows:
        for stage in row["stages"]:
            by_type.setdefault(f"{stage['type']}.{stage['field']}", []).append(parse_time(stage["at"]))
    print(json.dumps({
        "active_projects": len(rows),
        "by_language": dict(Counter(row["sample"].split("/", 1)[0] for row in rows)),
        "missing_stage_timestamps": [row["sample"] for row in rows if not row["stages"]],
        "latest_by_type_and_field": {key: max(values).isoformat().replace("+00:00", "Z") for key, values in sorted(by_type.items())},
        "fixtures": {row["sample"]: row for row in rows if row["sample"] in {"ja/sample177", "ja/sample222", "ja/sample61", "ja/sample99", "ja/sample93", "ja/sample83"}},
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
