"""E0 first fit: our OCR pieces' angle rule against Torii's box angles, on the pages both have.

Usage: python3 -I e0_fit.py <corpus/samples> <matched.tsv> <f_regions.json>
"""
import itertools
import json
import math
import os
import sys
from collections import Counter, defaultdict

from PIL import Image

root, matched_tsv, regions_json = sys.argv[1:4]

# One page per sample hash.
sample_of = {}
for line in open(matched_tsv):
    t, pn, h, w, hh, d = line.rstrip("\n").split("\t")
    sample_of.setdefault(h, d)
regions = json.load(open(regions_json))
by_hash = defaultdict(list)
seen_page = {}
for r in regions:
    key = (r["title"], r["page_number"])
    seen_page.setdefault(r["hash"], key)
    if seen_page[r["hash"]] == key:
        by_hash[r["hash"]].append(r)


def fold90(a):
    return ((a + 90) % 180) - 90


def axis_dev(a):
    """Deviation of a line direction from the nearest axis (0 or 90), in (-45, 45]."""
    return ((a + 45) % 90) - 45


def pieces(prov):
    if not prov:
        return []
    if "fragments" in prov:
        return [f.get("provenance", f) for f in prov["fragments"]]
    return [prov]


def piece_lines(prov):
    out = []
    for f in pieces(prov):
        q = f.get("sourceQuad")
        if not q or len(q) != 4:
            continue
        e0 = (q[1][0] - q[0][0], q[1][1] - q[0][1])
        e1 = (q[2][0] - q[1][0], q[2][1] - q[1][1])
        l0, l1 = math.hypot(*e0), math.hypot(*e1)
        long_e, long_l, short_l = (e0, l0, l1) if l0 >= l1 else (e1, l1, l0)
        ang = math.degrees(math.atan2(long_e[1], long_e[0]))
        out.append({"dev": axis_dev(ang), "len": long_l, "thick": max(short_l, 1e-6)})
    return out


def rule(prov, dead=4.0, min_chars=2.0, agree=6.0, sign=1):
    lines = [p for p in piece_lines(prov) if p["len"] >= min_chars * p["thick"]]
    if not lines:
        return 0.0, "no-voting-piece"
    devs = [p["dev"] for p in lines]
    if max(devs) - min(devs) > agree:
        return 0.0, "pieces-disagree"
    a = sum(p["dev"] * p["len"] for p in lines) / sum(p["len"] for p in lines)
    if abs(a) < dead:
        return 0.0, "dead-band"
    return sign * a, "turned"


def torii_boxes(sample_dir):
    meta = json.load(open(os.path.join(root, sample_dir, "torii/metadata.json")))
    return meta.get("text") or []


def size(path):
    """Torii's working size: original.png, else its inpainted image (bundle or file)."""
    import io
    import zipfile
    d = os.path.dirname(path)
    for name in ("original.png", "inpainted.png", "inpainted"):
        if os.path.exists(os.path.join(d, name)):
            with Image.open(os.path.join(d, name)) as im:
                return im.size
    if os.path.exists(os.path.join(d, "bundle.torii")):
        with zipfile.ZipFile(os.path.join(d, "bundle.torii")) as z:
            with Image.open(io.BytesIO(z.read("images/0_inpainted"))) as im:
                return im.size
    src = [f for f in os.listdir(os.path.dirname(d)) if f.startswith("source.")]
    with Image.open(os.path.join(os.path.dirname(d), src[0])) as im:
        return im.size


# --- 1. image scale and box convention --------------------------------------------------------
scale_note = Counter()
pairs_by_conv = {}
for conv in ("centre", "corner"):
    pairs, unmatched_t, unmatched_r = [], 0, 0
    for h, regs in by_hash.items():
        d = sample_of[h]
        tw, th = size(os.path.join(root, d, "torii/original.png"))
        W, H = regs[0]["width"], regs[0]["height"]
        sx, sy = W / tw, H / th
        if conv == "centre":
            scale_note[(round(sx, 3), round(sy, 3))] += 1
        used = set()
        for b in torii_boxes(d):
            cx, cy = (b["x"], b["y"]) if conv == "centre" else (b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
            cx, cy = cx * sx, cy * sy
            hit = None
            for r in regs:
                if r["bbox_x"] <= cx <= r["bbox_x"] + r["bbox_w"] and r["bbox_y"] <= cy <= r["bbox_y"] + r["bbox_h"]:
                    if hit is None or r["bbox_w"] * r["bbox_h"] < hit["bbox_w"] * hit["bbox_h"]:
                        hit = r
            if hit is None:
                unmatched_t += 1
                continue
            used.add(hit["id"])
            pairs.append((d, b, hit))
        unmatched_r += sum(1 for r in regs if r["id"] not in used)
    pairs_by_conv[conv] = (pairs, unmatched_t, unmatched_r)
    print(f"convention {conv}: matched {len(pairs)}, Torii boxes unmatched {unmatched_t}, our regions unmatched {unmatched_r}")
print("image scale (ours / Torii's original.png):", dict(scale_note))

conv = max(pairs_by_conv, key=lambda c: len(pairs_by_conv[c][0]))
pairs, un_t, un_r = pairs_by_conv[conv]
print(f"using '{conv}'")
total_t = sum(len(torii_boxes(sample_of[h])) for h in by_hash)
total_r = sum(len(v) for v in by_hash.values())
print(f"pages {len(by_hash)}, Torii boxes {total_t}, our regions {total_r}")

# --- 2. sign -------------------------------------------------------------------------------------
raw = [(fold90(b["angle"]), rule(r["ownership_provenance"], dead=0, agree=999, min_chars=1)[0]) for _, b, r in pairs]
tilted = [(t, o) for t, o in raw if abs(t) >= 5 and abs(o) >= 2 and abs(t) < 45]
agree_sign = sum(1 for t, o in tilted if (t > 0) == (o > 0))
print(f"sign check on {len(tilted)} pairs both tilted: same sign {agree_sign}, opposite {len(tilted) - agree_sign}")
sign = 1 if agree_sign >= len(tilted) - agree_sign else -1
print("sign used:", sign)


# --- 3. fit -------------------------------------------------------------------------------------
def evaluate(dead, min_chars, agree, verbose=False):
    errs, conf = [], Counter()
    big = []
    reasons = Counter()
    for d, b, r in pairs:
        t = fold90(b["angle"])
        if abs(t) >= 45:  # near-vertical in Torii: a vertical column it set as horizontal text
            conf["torii-near-vertical"] += 1
            continue
        o, why = rule(r["ownership_provenance"], dead, min_chars, agree, sign)
        reasons[why] += 1
        errs.append(abs(o - t))
        t_turn, o_turn = abs(t) >= 5, o != 0
        conf[("torii>=5" if t_turn else "torii<5", "we turn" if o_turn else "we keep level")] += 1
        if abs(o) >= 20 or abs(t) >= 20:
            big.append((d, r["text"], round(t, 1), round(o, 1), why))
    errs.sort()
    n = len(errs)
    mae = sum(errs) / n
    med = errs[n // 2]
    p90 = errs[int(n * 0.9)]
    tp = conf[("torii>=5", "we turn")]
    fn = conf[("torii>=5", "we keep level")]
    fp = conf[("torii<5", "we turn")]
    return {"n": n, "mae": mae, "median": med, "p90": p90, "tp": tp, "fn": fn, "fp": fp, "conf": conf, "big": big, "reasons": reasons}


grid = []
for dead, mc, ag in itertools.product((2, 3, 4, 5, 6), (1.0, 1.5, 2.0, 3.0), (4, 6, 10, 999)):
    e = evaluate(dead, mc, ag)
    grid.append(((dead, mc, ag), e))
print("\nGrid (dead band, min line length in line-thicknesses, max piece disagreement): "
      "MAE, p90 error, Torii-tilted we turn (tp), we keep level (fn), Torii-level we turn (fp)")
for (dead, mc, ag), e in sorted(grid, key=lambda g: (g[1]["fp"] + g[1]["fn"], g[1]["mae"]))[:12]:
    print(f"  dead {dead:>2}  min {mc:>3}  agree {ag:>3}:  MAE {e['mae']:.2f}  p90 {e['p90']:.2f}  tp {e['tp']:>3}  fn {e['fn']:>3}  fp {e['fp']:>3}")
plan = evaluate(4, 2.0, 6)
print("\nPlan's starting rule (dead 4, min 2 chars, agree 6):",
      {k: (round(v, 2) if isinstance(v, float) else v) for k, v in plan.items() if k not in ("big", "conf", "reasons")})
print("  why level/turned:", dict(plan["reasons"]))
print("  confusion:", dict(plan["conf"]))
print("\nEvery pair at 20 degrees or more (sample, our text, Torii folded, ours, why):")
for row in sorted(plan["big"]):
    print("  ", row)


def disagreements(dead, mc, ag):
    fp, fn = [], []
    for d, b, r in pairs:
        t = fold90(b["angle"])
        if abs(t) >= 45:
            continue
        o, why = rule(r["ownership_provenance"], dead, mc, ag, sign)
        row = (d, (r["text"] or "")[:18], r["region_type"], round(t, 1), round(o, 1), why,
               len(piece_lines(r["ownership_provenance"])))
        if abs(t) < 5 and o != 0:
            fp.append(row)
        if abs(t) >= 5 and o == 0:
            fn.append(row)
    return fp, fn


for params in ((4, 2.0, 6), (5, 1.5, 6)):
    fp, fn = disagreements(*params)
    print(f"\n{params}: we turn, Torii level ({len(fp)}):")
    for row in sorted(fp):
        print("   ", row)
    print(f"{params}: Torii tilted, we keep level ({len(fn)}):")
    for row in sorted(fn, key=lambda r: -abs(r[3])):
        print("   ", row)

allregs = [r for regs in by_hash.values() for r in regs]
for params in ((4, 2.0, 6), (5, 1.5, 6), (5, 2.0, 6)):
    turned = [r for r in allregs if rule(r["ownership_provenance"], *params, sign)[0] != 0]
    pages = {r["hash"] for r in turned}
    print(f"{params}: turns {len(turned)} of {len(allregs)} regions ({100*len(turned)/len(allregs):.1f}%), on {len(pages)} of {len(by_hash)} pages")
