"""The E0 rule on pages with no Torii reference (the owner's Rotate set, Free ch. 7), drawn on each page.

Usage: python3 -I check_rotate.py <regions.json> <img_dir> <out_dir>

regions.json: the chapter's OCR regions from the F stack's database (read-only), on chrome-box:
  SELECT json_agg(t) FROM (
    SELECT p.page_number, r.text, r.translated_text, r.region_type,
           r.bbox_x, r.bbox_y, r.bbox_w, r.bbox_h, r.ownership_provenance
    FROM ocr_regions r JOIN pages p ON p.id = r.page_id
    JOIN chapters c ON c.id = p.chapter_id JOIN series s ON s.id = c.series_id
    WHERE s.title = 'Free' AND c.chapter_number = 7) t
img_dir: the page images, each named with its 3-digit page number first (001_....png).

Green box = the settled rule turns it (angle beside it). Orange = kept level because its pieces
disagree. Thin blue = every OCR piece. Each region is numbered for reference; the report prints
the settled rule beside the first plan's (4°, 2 chars, 6°).
"""
import math
import json
import os
import sys
from collections import defaultdict

from PIL import Image, ImageDraw, ImageFont

# python3 -I leaves this directory off the path; the rule lives beside this script.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from angle_rule import lines, rule  # noqa: E402

regions_json, img_dir, out_dir = sys.argv[1:4]
os.makedirs(out_dir, exist_ok=True)
FIRST_PLAN = (4.0, 2.0, 6.0)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

regions = json.load(open(regions_json))
by_page = defaultdict(list)
for r in regions:
    by_page[int(r["page_number"])].append(r)
files = {int(f[:3]): f for f in os.listdir(img_dir) if f[:3].isdigit()}
fmt = lambda v: f"{v[0]:+5.1f}" if v[0] else f"level ({v[1]})"

for page in sorted(by_page):
    regs = sorted(by_page[page], key=lambda r: (r["bbox_y"], r["bbox_x"]))
    im = Image.open(os.path.join(img_dir, files[page])).convert("RGB")
    dr = ImageDraw.Draw(im)
    lw = max(2, im.width // 300)
    font = ImageFont.truetype(FONT, max(18, im.width // 45))
    print(f"\n## p{page}  ({im.width}x{im.height}, {len(regs)} regions)")
    for n, r in enumerate(regs, 1):
        prov = r["ownership_provenance"]
        ls = lines(prov)
        for *_, q in ls:
            dr.line([tuple(p) for p in q] + [tuple(q[0])], fill=(40, 110, 255), width=max(1, lw // 2))
        settled, first = rule(prov), rule(prov, *FIRST_PLAN)
        a, why = settled
        cx, cy = r["bbox_x"] + r["bbox_w"] / 2, r["bbox_y"] + r["bbox_h"] / 2
        w, h = r["bbox_w"], r["bbox_h"]
        colour = (0, 170, 0) if a else ((255, 140, 0) if why == "pieces disagree" else (150, 150, 150))
        rad = math.radians(a)
        pts = [(cx + dx * math.cos(rad) - dy * math.sin(rad), cy + dx * math.sin(rad) + dy * math.cos(rad))
               for dx, dy in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]
        dr.line(pts + [pts[0]], fill=colour, width=lw if a or why == "pieces disagree" else max(1, lw // 2))
        dr.text((r["bbox_x"], max(0, r["bbox_y"] - font.size - 2)), f"{n}" + (f" {a:+.0f}°" if a else ""),
                fill=colour, font=font, stroke_width=2, stroke_fill=(255, 255, 255))
        piece_angles = ",".join(f"{d:+.0f}" for d, *_ in ls)
        src = (r["text"] or "").replace("\n", " ")[:18]
        tl = (r.get("translated_text") or "").replace("\n", " ")[:28]
        print(f"  {n:>2} {r['region_type'] or '':6} settled {fmt(settled):>24}  first plan {fmt(first):>24}"
              f"  pieces[{piece_angles}]  {src!r} -> {tl!r}")
    im.thumbnail((1500, 1500))
    im.save(os.path.join(out_dir, f"p{page:02d}.png"))
