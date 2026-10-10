"""E0 (#180): page thumbnails with Torii's tilted boxes drawn in red, side by side, to judge by eye
whether the tilt is real text.

Usage: python3 -I scripts/e0/contact_sheet.py corpus/samples out.png ja/sample252 ja/sample165 ...
"""
import json, math, os, sys
from PIL import Image, ImageDraw, ImageFont
root, out, *samples = sys.argv[1:]
fold = lambda a: ((a + 90) % 180) - 90
tiles = []
for s in samples:
    d = os.path.join(root, s)
    src = [f for f in os.listdir(d) if f.startswith("source.")][0]
    im = Image.open(os.path.join(d, src)).convert("RGB")
    dr = ImageDraw.Draw(im)
    for b in json.load(open(os.path.join(d, "torii/metadata.json")))["text"]:
        a = fold(b["angle"])
        if abs(a) < 5 or abs(a) >= 45:
            continue
        cx, cy, w, h = b["x"], b["y"], b["width"], b["height"]
        r = math.radians(b["angle"])
        pts = []
        for dx, dy in ((-w/2, -h/2), (w/2, -h/2), (w/2, h/2), (-w/2, h/2)):
            pts.append((cx + dx*math.cos(r) - dy*math.sin(r), cy + dx*math.sin(r) + dy*math.cos(r)))
        lw = max(4, im.width // 150)
        dr.line(pts + [pts[0]], fill=(255, 0, 0), width=lw)
        dr.text((pts[0][0], pts[0][1] - 10 * lw), f"{a:+.0f}", fill=(255, 0, 0), font=ImageFont.load_default())
    im.thumbnail((700, 1000))
    tiles.append((s, im))
W = sum(t.width for _, t in tiles) + 10 * len(tiles)
H = max(t.height for _, t in tiles) + 30
sheet = Image.new("RGB", (W, H), "white")
x = 0
dr = ImageDraw.Draw(sheet)
for s, t in tiles:
    sheet.paste(t, (x, 30)); dr.text((x + 5, 8), s, fill=(0, 0, 0)); x += t.width + 10
sheet.save(out)
