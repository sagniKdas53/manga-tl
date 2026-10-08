"""The E rotation test pages: Torii's tilted boxes beside what the E0 rule would set on our regions.

Usage: python3 -I test_pages.py <corpus/samples> <regions.json> <pages.tsv> <out_dir>
pages.tsv: sample_dir <TAB> series title <TAB> page number
"""
import json
import math
import os
import sys
from collections import defaultdict

from PIL import Image, ImageDraw

root, regions_json, pages_tsv, out_dir = sys.argv[1:5]
os.makedirs(out_dir, exist_ok=True)
fold = lambda a: ((a + 90) % 180) - 90
axis_dev = lambda a: ((a + 45) % 90) - 45
RULES = {"plan (4°, 2 chars, 6°)": (4.0, 2.0, 6.0), "tight (5°, 1.5, 6°)": (5.0, 1.5, 6.0)}


def pieces(prov):
    if not prov:
        return []
    if "fragments" in prov:
        return [f.get("provenance", f) for f in prov["fragments"]]
    return [prov]


def lines(prov):
    out = []
    for f in pieces(prov):
        q = f.get("sourceQuad")
        if not q or len(q) != 4:
            continue
        e0 = (q[1][0] - q[0][0], q[1][1] - q[0][1])
        e1 = (q[2][0] - q[1][0], q[2][1] - q[1][1])
        l0, l1 = math.hypot(*e0), math.hypot(*e1)
        e, long_l, short_l = (e0, l0, l1) if l0 >= l1 else (e1, l1, l0)
        out.append((axis_dev(math.degrees(math.atan2(e[1], e[0]))), long_l, max(short_l, 1e-6)))
    return out


def rule(prov, dead, min_chars, agree):
    ls = [l for l in lines(prov) if l[1] >= min_chars * l[2]]
    if not ls:
        return 0.0, "no long piece"
    devs = [d for d, _, _ in ls]
    if max(devs) - min(devs) > agree:
        return 0.0, "pieces disagree"
    a = sum(d * l for d, l, _ in ls) / sum(l for _, l, _ in ls)
    return (0.0, "dead band") if abs(a) < dead else (a, "turned")


regions = json.load(open(regions_json))
by_page = defaultdict(list)
for r in regions:
    by_page[(r["title"], int(r["page_number"]))].append(r)

report = []
for line in open(pages_tsv):
    sample, title, page = line.rstrip("\n").split("\t")
    regs = by_page[(title, int(page))]
    torii = json.load(open(os.path.join(root, sample, "torii/metadata.json")))["text"]
    tilted = [b for b in torii if 5 <= abs(fold(b["angle"])) < 45]
    rows = []
    for b in tilted:
        hit = None
        for r in regs:
            if r["bbox_x"] <= b["x"] <= r["bbox_x"] + r["bbox_w"] and r["bbox_y"] <= b["y"] <= r["bbox_y"] + r["bbox_h"]:
                if hit is None or r["bbox_w"] * r["bbox_h"] < hit["bbox_w"] * hit["bbox_h"]:
                    hit = r
        ours = {name: rule(hit["ownership_provenance"], *p) if hit else (None, "no region of ours") for name, p in RULES.items()}
        rows.append((fold(b["angle"]), (b.get("originalText") or "")[:16], hit, ours))
    turned = {name: [r for r in regs if rule(r["ownership_provenance"], *p)[0] != 0] for name, p in RULES.items()}
    report.append((sample, title, page, len(regs), len(torii), rows, turned))

    # Picture: Torii's tilted boxes in red, our regions the plan rule turns in green (drawn at its angle).
    src = [f for f in os.listdir(os.path.join(root, sample)) if f.startswith("source.")][0]
    im = Image.open(os.path.join(root, sample, src)).convert("RGB")
    dr = ImageDraw.Draw(im)
    lw = max(3, im.width // 250)

    def box(cx, cy, w, h, deg, colour):
        r = math.radians(deg)
        pts = [(cx + dx * math.cos(r) - dy * math.sin(r), cy + dx * math.sin(r) + dy * math.cos(r))
               for dx, dy in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]
        dr.line(pts + [pts[0]], fill=colour, width=lw)

    for b in tilted:
        box(b["x"], b["y"], b["width"], b["height"], b["angle"], (230, 0, 0))
    for r in turned["plan (4°, 2 chars, 6°)"]:
        a, _ = rule(r["ownership_provenance"], *RULES["plan (4°, 2 chars, 6°)"])
        box(r["bbox_x"] + r["bbox_w"] / 2, r["bbox_y"] + r["bbox_h"] / 2, r["bbox_w"], r["bbox_h"], a, (0, 170, 0))
    im.thumbnail((1400, 1400))
    im.save(os.path.join(out_dir, f"{sample.replace('/', '_')}.png"))

for sample, title, page, nregs, ntorii, rows, turned in report:
    print(f"\n## {sample}  ({title} p{page}): our regions {nregs}, Torii boxes {ntorii}, Torii tilted {len(rows)}")
    for name, rs in turned.items():
        print(f"   {name}: turns {len(rs)} region(s)")
    for t, text, hit, ours in rows:
        o = ours["plan (4°, 2 chars, 6°)"]
        o2 = ours["tight (5°, 1.5, 6°)"]
        fmt = lambda v: "-" if v[0] is None else f"{v[0]:+.1f}"
        print(f"   Torii {t:+6.1f}  {text:16}  plan {fmt(o):>6} ({o[1]})   tight {fmt(o2):>6} ({o2[1]})")

print("\n## Totals over the test pages (controls ja/sample92 and ja/sample145 left out)")
for name, p in list(RULES.items()) + [("agree 10° (4°, 2 chars, 10°)", (4.0, 2.0, 10.0))]:
    from collections import Counter
    c = Counter()
    errs = []
    for sample, title, page, nregs, ntorii, rows, turned in report:
        if sample in ("ja/sample92", "ja/sample145"):
            continue
        for t, text, hit, ours in rows:
            if not hit:
                c["no region of ours"] += 1
                continue
            a, why = rule(hit["ownership_provenance"], *p)
            if a == 0:
                c[f"kept level: {why}"] += 1
            else:
                errs.append(abs(a - t))
                c["turned, within 5° of Torii" if abs(a - t) <= 5 else "turned, off by more than 5°"] += 1
    total = sum(c.values())
    mean = sum(errs) / len(errs) if errs else 0
    print(f"  {name}: {total} Torii-tilted boxes; " + ", ".join(f"{k} {v}" for k, v in c.most_common()) + f"; mean error when turned {mean:.1f}°")
