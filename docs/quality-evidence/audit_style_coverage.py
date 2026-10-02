"""Inventory source bytes and build private, source-only curation contact sheets.

Run with the root .venv; never invokes OCR, translation, or corpus mutation.
"""

import argparse
import hashlib
import json
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


def audit_style_coverage():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--selection", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    args.output.mkdir(parents=True, exist_ok=True)
    rows = []
    errors = []
    sheets = defaultdict(list)
    for lane, base in (("active", "samples"), ("pending", "gaps/pending")):
        for language in ("ja", "ko", "zh"):
            paths = sorted(
                (root / "corpus" / base / language).glob("sample*/meta.json"),
                key=lambda p: int(p.parent.name.removeprefix("sample")),
            )
            for path in paths:
                meta = json.loads(path.read_text())
                source = path.parent / meta["source"]["file"]
                try:
                    with Image.open(source) as image:
                        image.load()
                        width, height = image.size
                        thumb = ImageOps.contain(image.convert("RGB"), (230, 270))
                    if (
                        meta["language"] != language
                        or meta["source"]["lang"] != language
                    ):
                        raise ValueError("Conflicting metadata language")
                    if meta["sample_id"] != path.parent.name:
                        raise ValueError("Conflicting sample ID")
                    row = {
                        "id": meta["sample_id"],
                        "language": language,
                        "lane": lane,
                        "source": source.relative_to(root).as_posix(),
                        "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                        "width": width,
                        "height": height,
                        "origin": meta.get("origin", {}),
                        "gap_category": meta.get("gap_category"),
                        "provenance_metadata": meta.get("provenance_metadata", {}),
                    }
                    rows.append(row)
                    sheets[f"{lane}-{language}"].append((row, thumb))
                except (OSError, ValueError) as exc:
                    errors.append(
                        {"meta": str(path.relative_to(root)), "error": str(exc)}
                    )
    for group, items in sheets.items():
        for start in range(0, len(items), 48):
            sheet = Image.new("RGB", (1440, 2400), "#dddddd")
            draw = ImageDraw.Draw(sheet)
            for index, (row, thumb) in enumerate(items[start : start + 48]):
                x, y = (index % 6) * 240, (index // 6) * 300
                sheet.paste(thumb, (x + (240 - thumb.width) // 2, y + 25))
                draw.text(
                    (x + 5, y + 5),
                    f"{row['id']} {row['width']}x{row['height']}",
                    fill="black",
                )
                row["contact_sheet"] = f"{group}-{start // 48 + 1:02}.jpg"
            sheet.save(args.output / f"{group}-{start // 48 + 1:02}.jpg", quality=90)
    digests = defaultdict(list)
    for row in rows:
        digests[row["sha256"]].append(row["id"])
    report = {
        "app_head": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root, text=True
        ).strip(),
        "corpus_head": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root / "corpus", text=True
        ).strip(),
        "worker_head": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root / "worker", text=True
        ).strip(),
        "language_count_basis": "Declared metadata, not a corpus-wide linguistic verification",
        "counts": dict(
            sorted(Counter(f"{r['lane']}/{r['language']}" for r in rows).items())
        ),
        "duplicate_source_bytes": [ids for ids in digests.values() if len(ids) > 1],
        "errors": errors,
        "sources": rows,
    }
    if args.selection:
        selection = json.loads(args.selection.read_text())
        by_id = {row["id"]: row for row in rows}
        if len(by_id) != len(rows):
            raise ValueError("Duplicate sample IDs")
        selected = selection["samples"]
        if len({r["id"] for r in selected}) != len(selected):
            raise ValueError("Repeated selection ID")
        excluded = {r["id"] for r in selection.get("excluded_sources", [])}
        regressions = set(selection.get("retained_regression_ids", []))
        if {r["id"] for r in selected} & (excluded | regressions):
            raise ValueError(
                "Control selection includes an excluded or retained regression ID"
            )
        resolved = []
        for row in selected:
            source = by_id[row["id"]]
            for field in ("language", "source", "sha256"):
                if field in row and row[field] != source[field]:
                    raise ValueError(f"{row['id']}: {field} changed")
            resolved.append({**source, **row})
        if len({row["sha256"] for row in resolved}) != len(resolved):
            raise ValueError("Duplicate selected source bytes")
        if {r["sha256"] for r in resolved} & {
            by_id[key]["sha256"] for key in regressions
        }:
            raise ValueError("Control selection duplicates regression source bytes")
        report["selection_counts"] = dict(
            sorted(Counter(f"{r['split']}/{r['language']}" for r in selected).items())
        )
        report["selection_styles"] = dict(
            sorted(Counter(r["style"] for r in selected).items())
        )
        report["selection_tags"] = dict(
            sorted(Counter(tag for r in selected for tag in r["tags"]).items())
        )
        report["selection_lanes"] = dict(
            sorted(Counter(r["lane"] for r in resolved).items())
        )
        for start in range(0, len(resolved), 4):
            sheet = Image.new("RGB", (1200, 1600), "#dddddd")
            draw = ImageDraw.Draw(sheet)
            for index, row in enumerate(resolved[start : start + 4]):
                x, y = (index % 2) * 600, (index // 2) * 800
                with Image.open(root / row["source"]) as image:
                    thumb = ImageOps.contain(image.convert("RGB"), (580, 755))
                sheet.paste(thumb, (x + (600 - thumb.width) // 2, y + 35))
                draw.text(
                    (x + 10, y + 10),
                    f"{row['id']} {row['language']} {row['style']}",
                    fill="black",
                )
            sheet.save(args.output / f"selected-{start // 4 + 1:02}.jpg", quality=95)
        (args.output / "resolved-selection.json").write_text(
            json.dumps({**selection, "samples": resolved}, indent=2) + "\n"
        )
    (args.output / "inventory.json").write_text(json.dumps(report, indent=2) + "\n")
    summary = {key: value for key, value in report.items() if key != "sources"}
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    if errors:
        raise SystemExit("Unreadable or inconsistent sources; inspect inventory errors")


if __name__ == "__main__":
    audit_style_coverage()
