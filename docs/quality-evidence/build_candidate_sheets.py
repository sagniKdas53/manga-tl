"""Re-render A09 candidate review sheets from their pinned sheet index.

Run with the root .venv; read-only against every source collection.
"""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

LABEL_FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
CELL = (600, 800)
THUMB = (580, 700)


def wrap(text, font, width, draw, limit_lines):
    lines, current = [], ""
    for word in text.split():
        trial = f"{current} {word}".strip()
        if draw.textlength(trial, font=font) <= width:
            current = trial
            continue
        lines.append(current)
        current = word
        if len(lines) == limit_lines:
            break
    if current and len(lines) < limit_lines:
        lines.append(current)
    return "\n".join(lines[:limit_lines])


def render_sheet(tiles, out_path, label_font, small_font):
    sheet = Image.new("RGB", (2 * CELL[0], 2 * CELL[1]), "white")
    draw = ImageDraw.Draw(sheet)
    for index, tile in enumerate(tiles):
        x, y = (index % 2) * CELL[0], (index // 2) * CELL[1]
        with Image.open(tile["source"]) as opened:
            preview = ImageOps.contain(opened.convert("RGB"), THUMB)
        sheet.paste(preview, (x + (CELL[0] - preview.width) // 2, y + 66))
        draw.text((x + 10, y + 8), tile["tag"], fill="black", font=label_font)
        draw.multiline_text(
            (x + 10, y + 34),
            wrap(tile["caption"], small_font, CELL[0] - 20, draw, 2),
            fill="#333333",
            font=small_font,
            spacing=2,
        )
        draw.rectangle(
            [x + 1, y + 1, x + CELL[0] - 2, y + CELL[1] - 2], outline="#bbbbbb"
        )
    sheet.save(out_path, quality=95)


def build_candidate_sheets():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    index = json.loads(args.index.read_text())
    output = args.output or args.index.parent
    output.mkdir(parents=True, exist_ok=True)
    root = Path(__file__).resolve().parents[2]
    label_font = ImageFont.truetype(LABEL_FONT, 20)
    small_font = ImageFont.truetype(LABEL_FONT, 16)
    missing = []
    for entry in index["sheets"]:
        tiles = []
        for tile in entry["tiles"]:
            source = Path(tile["source"])
            if not source.is_absolute():
                source = root / source
            if not source.is_file():
                missing.append(str(source))
                continue
            tiles.append({**tile, "source": source})
        if tiles:
            render_sheet(tiles, output / entry["sheet"], label_font, small_font)
    print(
        json.dumps(
            {"sheets": len(index["sheets"]), "missing_sources": missing}, indent=2
        )
    )
    if missing:
        raise SystemExit(
            "Missing source images; the referenced collections moved or changed"
        )


if __name__ == "__main__":
    build_candidate_sheets()
