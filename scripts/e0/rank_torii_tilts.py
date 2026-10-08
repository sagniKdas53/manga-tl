"""E0 (#180): rank corpus pages by Torii's tilted text boxes (5-45 degrees, folded to a line's
direction, real text, not tiny).

Usage: python3 -I scripts/e0/rank_torii_tilts.py corpus/samples
"""
import glob, json, os, sys
root = sys.argv[1]
fold = lambda a: ((a + 90) % 180) - 90
rows = []
for f in sorted(glob.glob(os.path.join(root, "*/sample*/torii/metadata.json"))):
    sample = "/".join(f.split("/")[-4:-2])
    boxes = json.load(open(f)).get("text") or []
    tilted = []
    for b in boxes:
        a = fold(b["angle"])
        t = (b.get("originalText") or "").strip()
        if 5 <= abs(a) < 45 and len(t) >= 2 and b["width"] * b["height"] > 60 * 60:
            tilted.append((round(a, 1), t[:20], int(b["width"]), int(b["height"])))
    if tilted:
        rows.append((len(tilted), sample, len(boxes), tilted))
rows.sort(key=lambda r: (-r[0], r[1]))
print("pages with a real tilted box:", len(rows))
for n, s, total, t in rows[:45]:
    print(f"{s:16} {n:2}/{total:<3}", "; ".join(f"{a:+.0f}° {x}" for a, x, *_ in t[:5]))
