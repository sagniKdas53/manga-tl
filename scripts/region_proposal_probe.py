#!/usr/bin/env python3
"""
region_proposal_probe.py — the tooling behind docs/region_threshold_validation_2026-08-08.md.

Reproduces the region proposals a page would get under a given merge configuration, without
running any engine. Seven modes:

    sweep       vary the *in-bubble* split threshold (ocr.py:605) and count regions
    overlay     draw one configuration's regions on the page so a count can be checked
                against the art instead of against another number
    direction   merge the same fragments as vertical (rtl) and horizontal (ltr) text, to
                separate a threshold problem from an orientation one
    label       emit a click-to-group annotation page per sample, producing the balloon
                partition of the OCR fragments that everything below scores against
    waist       compare the mask-clearance signal against the text-gap signal at separating
                same-balloon from cross-balloon fragment pairs
    ablate      run the configuration matrix over every annotated page and report the metrics
    rdcl        mergers vs splits against the annotations -- the metric that carries the product
                cost, since a merger is unrecoverable downstream and a split usually is not
    bench       the deploy gate: named configurations scored on every corpus page for structure
                (counts, mergers/splits), content (order-invariant character P/R against the
                corpus text) and coverage, with the run recorded under corpus/runs/

The YOLO + PaddleOCR stage is cached to disk (~19s -> ~0.5s per page); the fragment-to-bubble
assignment is deliberately NOT cached, since that rule is itself a change candidate.

Production applies two different thresholds on two different paths, and conflating them is the
easy mistake here:

    ocr.py:605   split fragments *inside* a YOLO bubble     hardcoded threshold_ratio=2.0
    ocr.py:663   merge fragments matched to *no* bubble     OCR_MERGE_THRESHOLD from the env

`sweep` therefore moves only the in-bubble threshold and pins the unmatched path, which is what
makes sample23 a valid control: it has no bubbles, so its count must not move.

    python scripts/region_proposal_probe.py sweep sample30 --truth 7
    python scripts/region_proposal_probe.py overlay sample27 --in-threshold 0.35 --out /tmp
    python scripts/region_proposal_probe.py direction sample23 --truth 17
"""

import argparse
import hashlib
import json
import logging
import os
import sys
import tempfile
import time

import cv2
import numpy as np

# merge_ocr_regions logs one INFO line per call; a sweep makes hundreds and buries the table.
logging.getLogger("translation").setLevel(logging.WARNING)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
sys.path.insert(0, SCRIPT_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "worker", "src"))

os.environ.setdefault("PADDLEX_OFFLINE_MODE", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("FLAGS_use_mkldnn", "0")

DEFAULT_CORPUS = os.path.join(REPO_ROOT, "corpus", "ocr")
TRUTH_PATH = os.path.join(SCRIPT_DIR, "region_truth.json")
# Balloon-partition annotations. Versioned in the corpus submodule on purpose: unlike overlays,
# these are ground truth and are expensive to reproduce.
DEFAULT_LABELS = os.path.join(DEFAULT_CORPUS, "_region_probe")
SWEEP_VALUES = (0.15, 0.25, 0.35, 0.5, 0.75, 1.0, 1.5, 2.0)

# The value merge_ocr_regions falls back to when given no threshold. Note docker-compose.yml
# deploys OCR_MERGE_THRESHOLD=1.0, i.e. double this — see render_quality_gap_2026-08-05.md §D4.
CODE_DEFAULT_THRESHOLD = 0.50

DET_MODEL = "PP-OCRv6_medium_det"
REC_MODEL = "PP-OCRv6_medium_rec"
OCR_MAX_DIM = 1024

# Bump when the *detection* stage changes shape or semantics (model call, coordinate mapping,
# what gets stored). Deliberately not keyed on this file's hash: the merge/metric code below
# changes constantly and must not invalidate a cache of model output it never touched.
CACHE_SCHEMA_VERSION = 1


def load_truth(path=TRUTH_PATH):
    """Hand-counted text areas per sample. Keys starting with '_' are documentation."""
    with open(path) as fh:
        return {k: v for k, v in json.load(fh).items() if not k.startswith("_")}


def load_page(sample, corpus_dir):
    path = os.path.join(corpus_dir, sample, "page.webp")
    img = cv2.imread(path)
    if img is None:
        raise SystemExit(f"no page at {path}")
    return img


def default_cache_dir():
    env = os.environ.get("REGION_PROBE_CACHE")
    if env:
        return env
    xdg = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(xdg, "manga-library", "region_probe")


def _sha1_file(path):
    h = hashlib.sha1()
    with open(path, "rb") as fh:
        while chunk := fh.read(65536):
            h.update(chunk)
    return h.hexdigest()


_model_id_cache = {}


def _model_identity():
    """Everything about the models that could change their output, as a dict."""
    if "id" not in _model_id_cache:
        from worker.config import (
            YOLO_CONF_THRESHOLD,
            YOLO_INPUT_SIZE,
            YOLO_MASK_EROSION,
            YOLO_MODEL_PATH,
        )
        from worker.services.bubble_detector import get_sha256

        _model_id_cache["id"] = {
            "yolo_model_sha256": get_sha256(YOLO_MODEL_PATH),
            "yolo_conf": YOLO_CONF_THRESHOLD,
            "yolo_input_size": YOLO_INPUT_SIZE,
            "yolo_mask_erosion": YOLO_MASK_EROSION,
            "det_model": DET_MODEL,
            "rec_model": REC_MODEL,
            "ocr_max_dim": OCR_MAX_DIM,
        }
    return _model_id_cache["id"]


def _cache_key(sample, page_path):
    """Hash the page BYTES, not its path — corpus/ is a submodule whose pointer moves under us."""
    payload = {
        "schema": CACHE_SCHEMA_VERSION,
        "sample": sample,
        "page_sha1": _sha1_file(page_path),
        "models": _model_identity(),
    }
    blob = json.dumps(payload, sort_keys=True).encode()
    return hashlib.sha1(blob).hexdigest(), payload


def _detect(img, reader_cache):
    """Run YOLO + PaddleOCR. Returns (bubbles, frags) with no bubble assignment."""
    from benchmark_local_ocr import init_paddleocr
    from worker.services.bubble_detector import detect_bubbles_yolo
    from worker.services.ocr import parse_paddle_ocr_results
    from worker.utils.image import downscale_for_ocr

    raw_bubbles = detect_bubbles_yolo(img) or []
    bubbles = [
        {
            "bbox": [int(v) for v in b["bbox"]],
            "confidence": float(b.get("confidence", 0.0)),
            "mask_polygon": [[int(p[0]), int(p[1])] for p in (b.get("mask_polygon") or [])] or None,
            "safe_rect": [int(v) for v in b["safe_rect"]] if b.get("safe_rect") else None,
        }
        for b in raw_bubbles
    ]

    if "reader" not in reader_cache:
        reader_cache["reader"] = init_paddleocr("japan", DET_MODEL, REC_MODEL)
    scaled, upscale = downscale_for_ocr(img, max_dim=OCR_MAX_DIM)

    frags = []
    for bbox, text, conf in parse_paddle_ocr_results(reader_cache["reader"].predict(scaled)):
        xs = [p[0] * upscale for p in bbox]
        ys = [p[1] * upscale for p in bbox]
        x, y = int(min(xs)), int(min(ys))
        frags.append({"text": text, "detectedLanguage": "ja", "confidence": float(conf),
                      "x": x, "y": y, "width": int(max(xs) - x), "height": int(max(ys) - y)})

    return bubbles, frags


def bubble_masks(bubbles, h, w):
    """Rasterise each bubble's polygon (or its bbox, if it has none) to a full-page uint8 mask.

    Kept out of the cache: rasters are enormous and rebuild from the polygon in milliseconds.
    """
    masks = []
    for b in bubbles:
        m = np.zeros((h, w), dtype=np.uint8)
        poly = b.get("mask_polygon")
        if poly:
            cv2.fillPoly(m, [np.array(poly, dtype=np.int32)], (255,))
        else:
            bx, by, bw, bh = b["bbox"]
            m[by:by + bh, bx:bx + bw] = 255
        masks.append(m)
    return masks


def assign_fragments(frags, masks, h, w):
    """Best-mask-overlap wins; a fragment overlapping no mask is 'unmatched' (-1).

    Mirrors handlers/ocr.py:551-574. Deliberately recomputed on every run rather than cached —
    the assignment rule is itself a change candidate.
    """
    for f in frags:
        best, best_ov = -1, 0
        x1, y1 = max(0, f["x"]), max(0, f["y"])
        x2, y2 = min(w, f["x"] + f["width"]), min(h, f["y"] + f["height"])
        if x2 > x1 and y2 > y1:
            for i, m in enumerate(masks):
                ov = int(np.sum(m[y1:y2, x1:x2] > 0))
                if ov > best_ov:
                    best, best_ov = i, ov
        f["bubble_idx"] = best
    return frags


def proposals(sample, corpus_dir, reader_cache, use_cache=True, cache_dir=None, quiet=False):
    """YOLO bubbles plus PaddleOCR fragments, each fragment assigned to a bubble or to -1.

    The model stage is cached to disk; the assignment stage is not.
    """
    img = load_page(sample, corpus_dir)
    h, w = img.shape[:2]
    page_path = os.path.join(corpus_dir, sample, "page.webp")

    bubbles: list | None = None
    frags: list = []
    cache_file = key = provenance = None
    if use_cache:
        key, provenance = _cache_key(sample, page_path)
        cache_dir = cache_dir or default_cache_dir()
        cache_file = os.path.join(cache_dir, f"{sample}.{key[:16]}.json")
        if os.path.exists(cache_file):
            with open(cache_file) as fh:
                payload = json.load(fh)
            if payload.get("key") == key:
                bubbles, frags = payload["bubbles"], payload["frags"]
                if not quiet:
                    print(f"  [cache HIT ] {os.path.basename(cache_file)}")

    if bubbles is None:
        if use_cache and not quiet:
            print(f"  [cache MISS] {sample} — running YOLO + PaddleOCR")
        bubbles, frags = _detect(img, reader_cache)
        if use_cache and cache_file:
            os.makedirs(os.path.dirname(cache_file), exist_ok=True)
            tmp = cache_file + ".tmp"
            with open(tmp, "w") as fh:
                json.dump({"schema_version": CACHE_SCHEMA_VERSION, "key": key,
                           "provenance": provenance, "page_wh": [w, h],
                           "bubbles": bubbles, "frags": frags}, fh)
            os.replace(tmp, cache_file)

    assign_fragments(frags, bubble_masks(bubbles, h, w), h, w)
    return img, bubbles, frags


def mask_solidity(bubble):
    """Polygon area / convex hull area. 1.0 = convex; a pinched two-balloon blob scores lower."""
    poly = bubble.get("mask_polygon")
    if not poly or len(poly) < 3:
        return 1.0
    pts = np.array(poly, dtype=np.int32)
    hull = cv2.contourArea(cv2.convexHull(pts))
    return float(cv2.contourArea(pts) / hull) if hull > 0 else 1.0


def bubble_context(mask, bubble, samples=32):
    """A GroupingContext for one bubble: clearance-to-outline along a segment, plus solidity.

    The distance transform is computed once per bubble here and closed over, so the grouping code
    stays free of OpenCV and a sweep does not recompute it per configuration.
    """
    from worker.services.fragment_grouping import GroupingContext

    dt = cv2.distanceTransform(mask, cv2.DIST_L2, 3)

    def clearance(p, q):
        return _sample_min(dt, p, q, k=samples)

    return GroupingContext(clearance=clearance, solidity=mask_solidity(bubble))


def build_regions(bubbles, frags, in_thr, un_thr, direction="rtl",
                  waist_gate=None, waist_max_solidity=0.90, page_shape=None,
                  orientation="reading_direction"):
    """Region proposals for one configuration, tagged by which merge path produced them.

    `waist_gate` enables the clearance veto on the in-bubble path only: the unmatched path has no
    balloon mask to measure, so it stays on distance alone. `orientation` applies to both, and it
    is the *only* lever that reaches a page with no detected bubbles.
    """
    from worker.services.fragment_grouping import GroupingConfig
    from worker.services.merge_regions import merge_ocr_regions

    masks = bubble_masks(bubbles, *page_shape) if (waist_gate is not None and page_shape) else None

    regs = []
    for i, bub in enumerate(bubbles):
        inside = [f for f in frags if f["bubble_idx"] == i]
        if not inside:
            regs.append((tuple(bub["bbox"]), "bubble", ""))
            continue
        cfg = GroupingConfig(threshold_ratio=in_thr, reading_direction=direction,
                             orientation=orientation, waist_gate=waist_gate,
                             waist_max_solidity=waist_max_solidity)
        ctx = bubble_context(masks[i], bub) if masks is not None else None
        for s in merge_ocr_regions(inside, grouping=cfg, context=ctx):
            regs.append(((s["x"], s["y"], s["width"], s["height"]), "bubble", s.get("text", "")))

    unmatched = [f for f in frags if f["bubble_idx"] == -1]
    if unmatched:
        cfg = GroupingConfig(threshold_ratio=un_thr, reading_direction=direction,
                             orientation=orientation)
        for s in merge_ocr_regions(unmatched, grouping=cfg):
            regs.append(((s["x"], s["y"], s["width"], s["height"]), "direct", s.get("text", "")))
    return regs


def load_proposals(args, sample, reader_cache, quiet=False):
    """proposals() with the CLI's cache flags applied."""
    return proposals(sample, args.corpus, reader_cache,
                     use_cache=not args.no_cache, cache_dir=args.cache_dir, quiet=quiet)


def cmd_sweep(args, reader_cache):
    img, bubbles, frags = load_proposals(args, args.sample, reader_cache)
    h, w = img.shape[:2]
    unmatched = sum(1 for f in frags if f["bubble_idx"] == -1)

    print(f"{args.sample}: page {w}x{h}, {len(bubbles)} YOLO bubbles, {len(frags)} fragments, "
          f"{unmatched} unmatched (path pinned at {args.unmatched_threshold}).  truth={args.truth}\n")

    rows = []
    for thr in SWEEP_VALUES:
        regs = build_regions(bubbles, frags, thr, args.unmatched_threshold, args.direction)
        n_bubble = sum(1 for _, kind, _ in regs if kind == "bubble")
        n_direct = len(regs) - n_bubble
        giant = sum(1 for (_, _, rw, rh), _, _ in regs if rh > 0.5 * h or rw > 0.5 * w)
        rows.append({"thr": thr, "total": len(regs), "bubble": n_bubble,
                     "direct": n_direct, "giant": giant})
        mark = " <-- matches truth" if args.truth and len(regs) == args.truth else ""
        print(f"  in-bubble threshold={thr:<5} -> {len(regs):3d} regions "
              f"({n_bubble} bubble + {n_direct} direct_text)  giant={giant}{mark}")

    if len({r["total"] for r in rows}) == 1:
        print(f"\n  CONTROL: the in-bubble threshold does not govern this page "
              f"(constant at {rows[0]['total']} regions).")

    if args.json:
        with open(args.json, "w") as fh:
            json.dump({"sample": args.sample, "truth": args.truth, "page": [w, h],
                       "bubbles": len(bubbles), "fragments": len(frags),
                       "unmatched": unmatched, "rows": rows}, fh, indent=2)
        print(f"\nwrote {args.json}")


def cmd_overlay(args, reader_cache):
    img, bubbles, frags = load_proposals(args, args.sample, reader_cache)
    regs = build_regions(bubbles, frags, args.in_threshold, args.unmatched_threshold, args.direction)

    vis = img.copy()
    for j, ((x, y, w, h), kind, _) in enumerate(regs):
        col = (0, 180, 0) if kind == "bubble" else (220, 60, 0)
        cv2.rectangle(vis, (x, y), (x + w, y + h), col, 3)
        cv2.putText(vis, str(j), (x + 3, max(16, y - 5)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, col, 2)

    os.makedirs(args.out, exist_ok=True)
    name = os.path.join(args.out, f"{args.sample}_in{args.in_threshold}_un{args.unmatched_threshold}.png")
    cv2.imwrite(name, vis)
    print(f"{args.sample}: {len(regs)} regions "
          f"(green = split from a bubble, orange = unmatched/direct_text) -> {name}")
    for j, ((x, y, w, h), kind, text) in enumerate(regs):
        print(f"  {j:2d} {kind:7s} [{x},{y},{w},{h}]  {text[:44]!r}")


def cmd_direction(args, reader_cache):
    """Is a page's over-merging a threshold problem or an orientation one?

    merge_ocr_regions reads reading_direction == 'rtl' as 'the text is vertical' and sizes the
    vertical gap budget from avg_width. On horizontally-set text avg_width is a whole line, so
    the budget swallows the paragraph spacing and everything chains.
    """
    from worker.services.merge_regions import merge_ocr_regions

    _, bubbles, frags = load_proposals(args, args.sample, reader_cache)
    if not frags:
        raise SystemExit("no fragments on this page")

    avg_w = sum(f["width"] for f in frags) / len(frags)
    avg_h = sum(f["height"] for f in frags) / len(frags)
    wide = sum(1 for f in frags if f["width"] > f["height"])
    print(f"{args.sample}: {len(bubbles)} bubbles, {len(frags)} fragments, truth={args.truth}")
    print(f"  avg fragment {avg_w:.0f}x{avg_h:.0f} px; {wide}/{len(frags)} wider than tall "
          f"(=> {'horizontal' if wide * 2 > len(frags) else 'vertical'} lines)\n")

    print(f"{'thr':>6} | {'rtl (vertical assumption)':>27} | {'ltr (horizontal assumption)':>27}")
    print(f"{'-' * 6}-+-{'-' * 27}-+-{'-' * 27}")
    for thr in SWEEP_VALUES:
        n_rtl = len(merge_ocr_regions(frags, "rtl", threshold_ratio=thr))
        n_ltr = len(merge_ocr_regions(frags, "ltr", threshold_ratio=thr))
        m_rtl = " <-- truth" if args.truth and n_rtl == args.truth else ""
        m_ltr = " <-- truth" if args.truth and n_ltr == args.truth else ""
        print(f"{thr:>6} | {n_rtl:>10} regions{m_rtl:<13} | {n_ltr:>10} regions{m_ltr:<13}")


def _box(f):
    return f["x"], f["y"], f["x"] + f["width"], f["y"] + f["height"]


def _nearest_points(a, b):
    """The two closest points on the boundaries of two axis-aligned boxes."""
    ax1, ay1, ax2, ay2 = _box(a)
    bx1, by1, bx2, by2 = _box(b)
    if ax2 < bx1:
        px, qx = ax2, bx1
    elif bx2 < ax1:
        px, qx = ax1, bx2
    else:
        px = qx = (max(ax1, bx1) + min(ax2, bx2)) / 2.0
    if ay2 < by1:
        py, qy = ay2, by1
    elif by2 < ay1:
        py, qy = ay1, by2
    else:
        py = qy = (max(ay1, by1) + min(ay2, by2)) / 2.0
    return (px, py), (qx, qy)


def _sample_min(dt, p, q, k=32):
    """Minimum of the distance transform along the segment p->q. Zero means it left the mask."""
    h, w = dt.shape
    lo = None
    for i in range(k + 1):
        t = i / k
        x = round(p[0] + (q[0] - p[0]) * t)
        y = round(p[1] + (q[1] - p[1]) * t)
        if not (0 <= x < w and 0 <= y < h):
            return 0.0
        v = float(dt[y, x])
        lo = v if lo is None else min(lo, v)
    return lo if lo is not None else 0.0


def _is_vertical(frags):
    """Aspect-ratio majority vote, weighted by the longer side. Ties fall back to vertical."""
    vert = horiz = 0.0
    for f in frags:
        w, h = max(1, f["width"]), max(1, f["height"])
        weight = max(w, h)
        if h / w >= 1.2:
            vert += weight
        elif w / h >= 1.2:
            horiz += weight
    return vert >= horiz


def _best_separation(same, cross, same_is_low):
    """Best achievable error rate separating two 1-D samples with a single cut.

    Returns (error_rate, cut, n_same, n_cross). Chance level is min(n)/ (n_same+n_cross).
    """
    if not same or not cross:
        return None
    vals = sorted(set(same + cross))
    cuts = [(vals[i] + vals[i + 1]) / 2 for i in range(len(vals) - 1)] or [vals[0]]
    best = None
    for c in cuts:
        if same_is_low:
            err = sum(1 for v in same if v > c) + sum(1 for v in cross if v <= c)
        else:
            err = sum(1 for v in same if v <= c) + sum(1 for v in cross if v > c)
        if best is None or err < best[0]:
            best = (err, c)
    if best is None:
        return None
    total = len(same) + len(cross)
    return best[0] / total, best[1], len(same), len(cross)


LABEL_HTML = """<!doctype html><meta charset="utf-8"><title>balloon groups — {sample}</title>
<style>
 body{{font:13px system-ui,sans-serif;margin:0;background:#1a1a1a;color:#eee}}
 header{{position:sticky;top:0;background:#222;padding:10px 14px;z-index:10;
   box-shadow:0 2px 8px #0008;display:flex;gap:8px;align-items:center;flex-wrap:wrap}}
 button{{font:inherit;padding:5px 11px;border-radius:5px;border:1px solid #555;
   background:#333;color:#eee;cursor:pointer}}
 button:hover{{background:#444}}
 .swatch{{width:26px;height:26px;border-radius:5px;border:2px solid transparent;cursor:pointer}}
 .swatch.active{{border-color:#fff}}
 #wrap{{position:relative;margin:14px auto;width:min(96vw,900px)}}
 #wrap img{{width:100%;display:block}}
 .f{{position:absolute;border:2px solid #888;background:#8884;cursor:pointer;
   box-sizing:border-box;font:11px monospace;color:#fff;text-shadow:0 0 3px #000}}
 .f span{{position:absolute;top:-1px;left:1px}}
 .f.sfx{{border-style:dashed;border-color:#ff2bd1;background:#ff2bd133}}
 .f.sfx::after{{content:"SFX";position:absolute;right:1px;bottom:-1px;font:9px monospace;
   color:#ff2bd1;text-shadow:0 0 3px #000}}
 button.on{{background:#ff2bd1;border-color:#ff2bd1;color:#111;font-weight:600}}
 #status{{margin-left:auto;opacity:.8}}
</style>
<header>
 <b>{sample}</b>
 <span>click a fragment to put it in the active group; shift-click (or SFX mode) marks it a sound effect</span>
 <span id="pal"></span>
 <button onclick="newGroup()">+ new group (n)</button>
 <button id="sfxbtn" onclick="toggleSfxMode()">SFX mode (s)</button>
 <button onclick="clearAll()">reset</button>
 <button onclick="save()">save JSON</button>
 <span id="status"></span>
</header>
<div id="wrap"><img src="data:image/webp;base64,{img_b64}"><div id="boxes"></div></div>
<script>
const SAMPLE={sample_json}, FRAGS={frags_json}, PW={pw}, PH={ph};
const COLORS=["#e6194b","#3cb44b","#ffe119","#4363d8","#f58231","#911eb4","#46f0f0","#f032e6",
              "#bcf60c","#fabebe","#008080","#e6beff","#9a6324","#800000","#aaffc3","#808000"];
let groups=FRAGS.map(()=>-1), active=0, nGroups=1;
// Sound effects are a separate axis from grouping, not a group: the policy is that they are never
// typeset at all, so what is wanted is a flag on the fragment, not a partition it belongs to. Kept
// independent of `groups` so a fragment can be both grouped and marked, and so older
// `.groups.json` files that predate this still load.
let sfx=FRAGS.map(()=>false), sfxMode=false;

function render(){{
  const box=document.getElementById("boxes"); box.innerHTML="";
  FRAGS.forEach((f,i)=>{{
    const d=document.createElement("div"); d.className="f";
    d.style.left=(100*f.x/PW)+"%"; d.style.top=(100*f.y/PH)+"%";
    d.style.width=(100*f.width/PW)+"%"; d.style.height=(100*f.height/PH)+"%";
    const g=groups[i];
    if(g>=0){{ const c=COLORS[g%COLORS.length]; d.style.borderColor=c; d.style.background=c+"55"; }}
    if(sfx[i]) d.classList.add("sfx");
    d.innerHTML="<span>"+i+(g>=0?":"+g:"")+"</span>";
    d.onclick=(e)=>{{
      if(sfxMode || e.shiftKey) sfx[i]=!sfx[i];
      else groups[i]= groups[i]===active ? -1 : active;
      render();
    }};
    box.appendChild(d);
  }});
  let pal=""; for(let g=0;g<nGroups;g++)
    pal+='<span class="swatch'+(g===active?' active':'')+'" style="display:inline-block;'+
         'background:'+COLORS[g%COLORS.length]+'" onclick="active='+g+';render()"></span>';
  document.getElementById("pal").innerHTML=pal;
  document.getElementById("sfxbtn").className = sfxMode ? "on" : "";
  const done=groups.filter(g=>g>=0).length, nsfx=sfx.filter(Boolean).length;
  document.getElementById("status").textContent=done+"/"+FRAGS.length+" assigned, "+
    nGroups+" group(s), "+nsfx+" SFX"+
    (done<FRAGS.length?"  — unassigned fragments are EXCLUDED, not a group":"");
}}
function newGroup(){{ active=nGroups++; render(); }}
function toggleSfxMode(){{ sfxMode=!sfxMode; render(); }}
function clearAll(){{ groups=FRAGS.map(()=>-1); sfx=FRAGS.map(()=>false);
                    active=0; nGroups=1; sfxMode=false; render(); }}
document.addEventListener("keydown",e=>{{
  if(e.key==="n") newGroup();
  else if(e.key==="s") toggleSfxMode();
  else if(/^[0-9]$/.test(e.key) && +e.key<nGroups){{ active=+e.key; render(); }}
}});
function save(){{
  const blob=new Blob([JSON.stringify({{sample_id:SAMPLE,groups:groups,sfx:sfx}},null,1)],
                      {{type:"application/json"}});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob); a.download=SAMPLE+".groups.json"; a.click();
}}
render();
</script>
"""


def cmd_label(args, reader_cache):
    """Emit a page where fragments are clicked into balloon groups.

    Deliberately NOT a box-drawing tool, and deliberately not built from corpus/ocr/*/regions.json
    -- those regions are the output of the algorithm under test, so annotating them would be
    circular. What the experiment needs is a partition of the OCR fragments, which is independent
    of any region proposal and far quicker to produce by hand.

    Unassigned fragments are excluded from scoring rather than treated as one group, so junk
    detections and SFX can simply be left grey.
    """
    import base64

    truth_all = load_truth()
    samples = [args.sample] if args.sample else sorted(truth_all, key=lambda s: int(s[6:]))
    os.makedirs(args.out, exist_ok=True)

    for sample in samples:
        img, _, frags = load_proposals(args, sample, reader_cache)
        h, w = img.shape[:2]
        with open(os.path.join(args.corpus, sample, "page.webp"), "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode()
        slim = [{"x": f["x"], "y": f["y"], "width": f["width"], "height": f["height"]} for f in frags]
        html = LABEL_HTML.format(sample=sample, sample_json=json.dumps(sample),
                                 frags_json=json.dumps(slim), pw=w, ph=h, img_b64=b64)
        path = os.path.join(args.out, f"{sample}.label.html")
        with open(path, "w") as fh:
            fh.write(html)
        print(f"{sample}: {len(frags)} fragments, truth={truth_all.get(sample, {}).get('count', '?')} "
              f"balloons -> {path}")

    print("\nOpen each file, click fragments into groups, save the JSON next to them, then:")
    print(f"  .venv/bin/python scripts/region_proposal_probe.py waist --labels {args.out}")


def _same_partition(a, b):
    """Do two label vectors induce the same grouping? Group IDs need not match."""
    if len(a) != len(b):
        return False
    n = len(a)
    return all(((a[i] == a[j] and a[i] >= 0) == (b[i] == b[j] and b[i] >= 0))
               for i in range(n) for j in range(i + 1, n))


def _partition_agreement(a, b):
    """(agreeing pairs, total pairs) treating each vector as a partition. Group IDs need not match."""
    n = len(a)
    agree = total = 0
    for i in range(n):
        for j in range(i + 1, n):
            total += 1
            if (a[i] == a[j] and a[i] >= 0) == (b[i] == b[j] and b[i] >= 0):
                agree += 1
    return agree, total


def load_hand_labels(labels_dir, quiet=False):
    """{sample: [group_id per fragment]} from saved annotation files. -1 = excluded.

    Keyed on the `sample_id` INSIDE each file, not on its filename, because annotation tools save
    under whatever name they like.

    Precedence when a sample is annotated more than once: a file named exactly
    `<sample_id>.groups.json` is authoritative and any other file for that sample is treated as a
    second opinion. Second opinions are never silently merged -- they are reported as an agreement
    figure, which is the only inter-annotator signal available here. Two *authoritative* files that
    disagree is unresolvable, so the sample is dropped rather than arbitrated.
    """
    primary, secondary = {}, {}
    if not labels_dir or not os.path.isdir(labels_dir):
        return {}
    for name in sorted(os.listdir(labels_dir)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(labels_dir, name)) as fh:
            payload = json.load(fh)
        sid, groups = payload.get("sample_id"), payload.get("groups")
        if not sid or groups is None:
            continue
        bucket = primary if name == f"{sid}.groups.json" else secondary
        if sid in bucket and bucket is primary and not _same_partition(bucket[sid][1], groups):
            print(f"!!! {sid}: two authoritative annotations disagree. Dropping the sample.")
            bucket[sid] = (name, None)
            continue
        bucket.setdefault(sid, (name, groups))

    out = {}
    for sid in sorted(set(primary) | set(secondary), key=lambda s: (len(s), s)):
        pname, pgroups = primary.get(sid, (None, None))
        sname, sgroups = secondary.get(sid, (None, None))
        chosen = pgroups if pgroups is not None else sgroups
        if chosen is None:
            continue
        out[sid] = chosen
        if quiet or pgroups is None or sgroups is None:
            continue
        if len(pgroups) != len(sgroups):
            print(f"  {sid}: second opinion ({sname}) covers {len(sgroups)} fragments, not "
                  f"{len(pgroups)} — ignored as stale.")
        else:
            ag, tot = _partition_agreement(pgroups, sgroups)
            if ag < tot:
                print(f"  {sid}: annotators agree on {ag}/{tot} pairs ({100 * ag / tot:.1f}%). "
                      f"Using {pname}.")
    return out


def load_sfx_labels(labels_dir):
    """{sample: [is_sfx per fragment]} from saved annotation files.

    Separate from :func:`load_hand_labels` rather than folded into it, because that one's return
    shape is `{sample: groups}` and several callers unpack it directly. Files saved before the SFX
    selector existed simply have no `sfx` key and are skipped, so old annotations stay valid for
    the grouping experiment they were made for.

    These labels are ground truth for measuring a classifier, not the classifier. The policy is
    that sound effects are never typeset (Sagnik, 2026-08-13), and the intended mechanism is the
    QA VLM reading the crop -- sfx are too varied for a geometric rule, and R4 established that
    neither the text-shape rules nor recogniser confidence can see them at all.
    """
    out = {}
    if not labels_dir or not os.path.isdir(labels_dir):
        return out
    for name in sorted(os.listdir(labels_dir)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(labels_dir, name)) as fh:
            payload = json.load(fh)
        sid, flags = payload.get("sample_id"), payload.get("sfx")
        if not sid or flags is None:
            continue
        # A file named exactly <sid>.groups.json is authoritative; see load_hand_labels.
        if sid not in out or name == f"{sid}.groups.json":
            out[sid] = [bool(f) for f in flags]
    return out


def cmd_waist(args, reader_cache):
    """Does the bubble mask's geometric waist separate touching balloons better than distance?

    Inside one balloon every point between two fragments clears the outline by a good fraction of
    a character (balloons have margins). Where two balloons touch, that clearance collapses to the
    outline stroke width. If the waist ratio separates same-balloon from cross-balloon pairs more
    cleanly than the gap ratio does, the mask is the non-distance signal the merge has been missing.

    Pairs are labelled automatically from the merge grouping at --label-threshold, but ONLY on
    pages where that grouping's region count equals the hand count -- i.e. where it is corroborated.
    Elsewhere pairs are printed unlabelled and excluded from the scoring.
    """
    from worker.services.merge_regions import merge_ocr_regions

    truth_all = load_truth()
    samples = [args.sample] if args.sample else sorted(truth_all, key=lambda s: int(s[6:]))

    def empty():
        return {"gap": {"same": [], "cross": []}, "waist": {"same": [], "cross": []},
                "waist_c": {"same": [], "cross": []}}

    pooled = empty()
    per_page = {}
    hand = load_hand_labels(args.labels)

    for sample in samples:
        truth = truth_all.get(sample, {}).get("count", 0)
        img, bubbles, frags = load_proposals(args, sample, reader_cache)
        h, w = img.shape[:2]
        masks = bubble_masks(bubbles, h, w)
        for gi, f in enumerate(frags):
            f["_idx"] = gi

        # Hand labels beat derived ones: they are independent of the algorithm under test, and
        # they work on the pages where it is WRONG -- which the derived labelling cannot reach.
        hand_groups = hand.get(sample)
        if hand_groups is not None and len(hand_groups) != len(frags):
            print(f"\n!!! {sample}: hand labels cover {len(hand_groups)} fragments but the page has "
                  f"{len(frags)}. Stale annotation — re-run 'label' for this sample. Skipping it.")
            hand_groups = None

        regs = build_regions(bubbles, frags, args.label_threshold, args.unmatched_threshold, args.direction)
        labelled = hand_groups is not None or (bool(truth) and len(regs) == truth)

        print(f"\n=== {sample}: page {w}x{h}, {len(bubbles)} bubbles, {len(frags)} fragments, truth={truth}")
        if hand_groups is not None:
            n_excl = sum(1 for g in hand_groups if g < 0)
            print(f"    HAND labels: {len({g for g in hand_groups if g >= 0})} balloon groups, "
                  f"{n_excl} fragment(s) excluded")
        elif labelled:
            print(f"    labels derived from the grouping at {args.label_threshold} "
                  f"({len(regs)} regions == truth, so it is corroborated)")
        else:
            print(f"    NOT labelled: grouping at {args.label_threshold} gives {len(regs)} regions "
                  f"vs truth {truth}. Pairs shown for inspection only, excluded from scoring. "
                  f"Run 'label {sample}' to annotate it.")

        any_pairs = False
        for b_idx in range(len(bubbles)):
            inside = [f for f in frags if f["bubble_idx"] == b_idx]
            if len(inside) < 2:
                continue
            any_pairs = True
            vertical = _is_vertical(inside)
            dt = cv2.distanceTransform(masks[b_idx], cv2.DIST_L2, 3)

            # Balloon partition within this bubble, at the labelling threshold.
            groups = merge_ocr_regions([dict(f) for f in inside], args.direction,
                                       threshold_ratio=args.label_threshold)

            def group_of(f, groups=groups):
                """Smallest group whose union bbox contains the fragment.

                A merged group's bbox is the union of its members, so every member is contained.
                Non-members can be contained too (that IS the containment-violation signal), so
                take the smallest container rather than the first.
                """
                best, best_area = -1, None
                for gi, g in enumerate(groups):
                    if (g["x"] <= f["x"] and g["y"] <= f["y"]
                            and g["x"] + g["width"] >= f["x"] + f["width"]
                            and g["y"] + g["height"] >= f["y"] + f["height"]):
                        area = g["width"] * g["height"]
                        if best_area is None or area < best_area:
                            best, best_area = gi, area
                return best

            print(f"  bubble {b_idx} bbox={bubbles[b_idx]['bbox']} "
                  f"{len(inside)} frags, {'vertical' if vertical else 'horizontal'}, "
                  f"{len(groups)} balloon group(s) @ {args.label_threshold}")
            print(f"    {'pair':>9} {'fs':>5} {'gap':>6} {'gap/fs':>7} "
                  f"{'waist':>6} {'waist/fs':>9} {'waistC/fs':>10}  label")

            for i in range(len(inside)):
                for j in range(i + 1, len(inside)):
                    a, b = inside[i], inside[j]
                    fs = max(a["width"], b["width"]) if vertical else max(a["height"], b["height"])
                    fs = max(1, fs)
                    p, q = _nearest_points(a, b)
                    gap = ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2) ** 0.5
                    waist = _sample_min(dt, p, q)
                    ca = (a["x"] + a["width"] / 2, a["y"] + a["height"] / 2)
                    cb = (b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
                    waist_c = _sample_min(dt, ca, cb)

                    if hand_groups is not None:
                        ga, gb = hand_groups[a["_idx"]], hand_groups[b["_idx"]]
                        usable = ga >= 0 and gb >= 0          # excluded fragments score nothing
                        same = usable and ga == gb
                    else:
                        usable = labelled
                        same = group_of(a) == group_of(b) and group_of(a) != -1
                    label = ("same " if same else "cross") if usable else "  -  "
                    print(f"    {i:>4}-{j:<4} {fs:>5} {gap:>6.1f} {gap / fs:>7.3f} "
                          f"{waist:>6.1f} {waist / fs:>9.3f} {waist_c / fs:>10.3f}  {label}")

                    if usable:
                        k = "same" if same else "cross"
                        page_pool = per_page.setdefault(sample, empty())
                        for store in (pooled, page_pool):
                            store["gap"][k].append(gap / fs)
                            store["waist"][k].append(waist / fs)
                            store["waist_c"][k].append(waist_c / fs)

        if not any_pairs:
            print("    no bubble holds 2+ fragments — nothing to compare on this page")

    # Per page first. Pooling across pages averages away the only thing worth knowing here --
    # WHICH pages the mask signal works on -- and an imbalanced page can dominate the pool.
    print("\n" + "=" * 78)
    print("PER-PAGE SEPARATION")
    print("=" * 78)
    print(f"  {'sample':<10} {'same':>5} {'cross':>6} {'chance':>7} {'gap err':>8} "
          f"{'waist err':>10} {'waist cut':>10}  verdict")
    for sample in sorted(per_page, key=lambda s: int(s[6:])):
        p = per_page[sample]
        ns, nc = len(p["gap"]["same"]), len(p["gap"]["cross"])
        if not ns or not nc:
            print(f"  {sample:<10} {ns:>5} {nc:>6}   — only one class present, cannot score")
            continue
        g = _best_separation(p["gap"]["same"], p["gap"]["cross"], same_is_low=True)
        wv = _best_separation(p["waist"]["same"], p["waist"]["cross"], same_is_low=False)
        if g is None or wv is None:
            continue
        verdict = "waist WINS" if wv[0] < g[0] - 0.02 else (
            "waist LOSES" if wv[0] > g[0] + 0.02 else "tie")
        print(f"  {sample:<10} {ns:>5} {nc:>6} {min(ns, nc) / (ns + nc):>7.3f} {g[0]:>8.3f} "
              f"{wv[0]:>10.3f} {wv[1]:>10.3f}  {verdict}")

    print("\n" + "=" * 78)
    print("POOLED SEPARATION (labelled pages only)")
    print("=" * 78)
    n_same, n_cross = len(pooled["gap"]["same"]), len(pooled["gap"]["cross"])
    if not n_same or not n_cross:
        print(f"  insufficient labelled data: {n_same} same-balloon, {n_cross} cross-balloon pairs.")
        print("  Nothing can be concluded. Label more pages, or check --label-threshold.")
        return
    chance = min(n_same, n_cross) / (n_same + n_cross)
    print(f"  {n_same} same-balloon pairs, {n_cross} cross-balloon pairs. "
          f"Chance error rate = {chance:.3f}\n")
    print(f"  {'signal':<12} {'best err':>9} {'best cut':>9}   same range          cross range")
    for name, low in (("gap/fs", True), ("waist/fs", False), ("waistC/fs", False)):
        key = {"gap/fs": "gap", "waist/fs": "waist", "waistC/fs": "waist_c"}[name]
        s, c = pooled[key]["same"], pooled[key]["cross"]
        res = _best_separation(s, c, same_is_low=low)
        if res is None:
            continue
        print(f"  {name:<12} {res[0]:>9.3f} {res[1]:>9.3f}   "
              f"[{min(s):.2f}, {max(s):.2f}]{'':<8} [{min(c):.2f}, {max(c):.2f}]")
    print("\n  VERDICT: the waist is worth pursuing only if its best error rate is clearly below")
    print("           gap/fs's. If it is not, the non-distance track (including geometric mask")
    print("           splitting before assignment) is closed and P1-P5 carry the plan alone.")


def _frag_inside(box, f):
    """Is a fragment's centre inside a proposed region's bbox?"""
    x, y, w, h = box
    return (x <= f["x"] + f["width"] / 2 <= x + w) and (y <= f["y"] + f["height"] / 2 <= y + h)


def rdcl_counts(regs, frags, groups):
    """(mergers, splits) for one page's proposals against its hand-annotated partition.

    `groups` is the per-fragment group id from `load_hand_labels`, -1 meaning excluded, and
    `frags` must carry the `_idx` written by `tag_fragments`. Shared by `rdcl` and `bench` so the
    two modes can never drift into reporting different numbers for the same configuration.
    """
    mergers = 0
    spans = []
    for box, _, _ in regs:
        spanned = {groups[f["_idx"]] for f in frags if groups[f["_idx"]] >= 0 and _frag_inside(box, f)}
        spans.append(spanned)
        if len(spanned) > 1:
            mergers += 1
    splits = sum(1 for g in {x for x in groups if x >= 0} if sum(1 for s in spans if g in s) > 1)
    return mergers, splits


def tag_fragments(frags):
    """Stamp each fragment with its index, so annotations (which are positional) can be joined."""
    for i, f in enumerate(frags):
        f["_idx"] = i
    return frags


def cmd_rdcl(args, reader_cache):
    """Mergers and splits against the hand-annotated balloon partitions.

    The metric that actually encodes the product cost. A *merger* -- one proposed region spanning
    two annotated balloons -- fuses two speakers into one translation request and one flat fill,
    and is unrecoverable downstream. A *split* sends two strings that usually typeset back into the
    same balloon acceptably. They are not worth the same, so they are never summed into one number
    here; the weighted cost is printed separately and its lambda is a product decision, not a
    tunable.
    """
    hand = load_hand_labels(args.labels, quiet=True)
    if not hand:
        raise SystemExit(f"no annotations in {args.labels} — run 'label' first")

    configs = [("today (thr 2.0)", 2.0, None, "reading_direction"),
               ("thr 0.35", 0.35, None, "reading_direction"),
               ("waist+orient (2.0)", 2.0, args.waist_gate or 1.0, "vote"),
               ("waist+orient (0.35)", 0.35, args.waist_gate or 1.0, "vote")]

    cached = {}
    for sample in sorted(hand, key=lambda s: int(s[6:])):
        img, bubbles, frags = load_proposals(args, sample, reader_cache, quiet=True)
        if len(hand[sample]) != len(frags):
            print(f"!!! {sample}: annotation is stale, skipping")
            continue
        cached[sample] = (img.shape[:2], bubbles, tag_fragments(frags))

    print(f"{'configuration':<22}{'mergers':>9}{'splits':>8}{'regions':>9}{f'cost (M*{args.merger_cost}+S)':>18}")
    for label, thr, gate, orient in configs:
        mergers = splits = total = 0
        for sample, ((h, w), bubbles, frags) in cached.items():
            regs = build_regions(bubbles, frags, thr, args.unmatched_threshold, args.direction,
                                 waist_gate=gate, waist_max_solidity=args.waist_max_solidity,
                                 page_shape=(h, w), orientation=orient)
            total += len(regs)
            m, s = rdcl_counts(regs, frags, hand[sample])
            mergers += m
            splits += s
        cost = mergers * args.merger_cost + splits
        print(f"{label:<22}{mergers:>9}{splits:>8}{total:>9}{cost:>18}")
    print("\n  A merger is one region spanning two annotated balloons; a split is one balloon")
    print(f"  spread over two regions. Mergers are weighted {args.merger_cost}x because they are")
    print("  unrecoverable downstream, splits usually typeset back together.")


def _metrics(regs, frags, truth, page_w, page_h):
    """Ground-truth-free health signals, plus the count error where truth is known."""
    n = len(regs)
    n_bubble = sum(1 for _, kind, _ in regs if kind == "bubble")
    giant = sum(1 for (_, _, rw, rh), _, _ in regs if rh > 0.5 * page_h or rw > 0.5 * page_w)

    max_frags = 0
    for (x, y, w, h), _, _ in regs:
        c = sum(1 for f in frags
                if x <= f["x"] and y <= f["y"]
                and x + w >= f["x"] + f["width"] and y + h >= f["y"] + f["height"])
        max_frags = max(max_frags, c)

    # A region whose bbox swallows another region's centre: the fused-region failure a raw
    # count is blind to, and it needs no ground truth.
    violations = 0
    for i, ((x, y, w, h), _, _) in enumerate(regs):
        for j, ((x2, y2, w2, h2), _, _) in enumerate(regs):
            if i != j and x <= x2 + w2 / 2 <= x + w and y <= y2 + h2 / 2 <= y + h:
                violations += 1

    return {"total": n, "bubble": n_bubble, "direct": n - n_bubble, "giant": giant,
            "max_frags": max_frags, "contained": violations,
            "err": (n - truth) if truth else None}


def _plateaus(counts):
    """Longest run of a constant count over the sweep grid: (length, start_idx, value)."""
    best = (0, 0, None)
    i = 0
    while i < len(counts):
        j = i
        while j + 1 < len(counts) and counts[j + 1] == counts[i]:
            j += 1
        if j - i + 1 > best[0]:
            best = (j - i + 1, i, counts[i])
        i = j + 1
    return best


def cmd_ablate(args, reader_cache):
    """Every configuration x every page x the threshold grid, off the cache.

    In this cut the only configuration is the current algorithm, so what this really produces is
    the *metric* baseline that later phases get compared against — including the two signals a
    raw region count cannot see (max fragments per region, containment violations).
    """
    truth_all = load_truth()
    samples = [args.sample] if args.sample else sorted(truth_all, key=lambda s: int(s[6:]))
    out = {}

    configs = [("baseline", None, "reading_direction")]
    if args.waist_gate is not None:
        configs.append((f"waist@{args.waist_gate}", args.waist_gate, "reading_direction"))
    if args.orientation_vote:
        configs.append(("orient", None, "vote"))
        if args.waist_gate is not None:
            configs.append((f"waist@{args.waist_gate}+orient", args.waist_gate, "vote"))

    for sample in samples:
        truth = truth_all.get(sample, {}).get("count", 0)
        img, bubbles, frags = load_proposals(args, sample, reader_cache, quiet=True)
        h, w = img.shape[:2]
        print(f"\n{sample}  truth={truth or '?'}  {len(bubbles)} bubbles, {len(frags)} frags")
        out[sample] = {"truth": truth, "bubbles": len(bubbles), "frags": len(frags), "configs": {}}

        for label, gate, orient in configs:
            rows = []
            for thr in SWEEP_VALUES:
                regs = build_regions(bubbles, frags, thr, args.unmatched_threshold, args.direction,
                                     waist_gate=gate, waist_max_solidity=args.waist_max_solidity,
                                     page_shape=(h, w), orientation=orient)
                m = _metrics(regs, frags, truth, w, h)
                m["thr"] = thr
                rows.append(m)

            plen, pstart, pval = _plateaus([r["total"] for r in rows])
            exact = [r["thr"] for r in rows if truth and r["total"] == truth]
            pad = " " * (len(label) + 4)
            print(f"  [{label}] {'thr':>5} {'n':>4} {'bub':>4} {'dir':>4} {'err':>5} "
                  f"{'giant':>6} {'maxfrag':>8}")
            for r in rows:
                err = f"{r['err']:+d}" if r["err"] is not None else "  ?"
                star = " *" if truth and r["total"] == truth else ""
                print(f"  {pad}{r['thr']:>5} {r['total']:>4} {r['bubble']:>4} {r['direct']:>4} "
                      f"{err:>5} {r['giant']:>6} {r['max_frags']:>8}{star}")
            print(f"  {pad}plateau {plen} steps at n={pval} from {SWEEP_VALUES[pstart]}"
                  f"{' (contains truth)' if pval == truth else ''};  "
                  f"exact band {exact if exact else 'never reaches truth'}")
            out[sample]["configs"][label] = {
                "rows": rows, "exact_band": exact,
                "plateau": {"len": plen, "start": SWEEP_VALUES[pstart], "value": pval},
            }

        if len(configs) > 1:
            base = out[sample]["configs"]["baseline"]["rows"]
            gated = out[sample]["configs"][configs[1][0]]["rows"]
            deltas = [g["total"] - b["total"] for b, g in zip(base, gated, strict=True)]
            better = sum(1 for b, g in zip(base, gated, strict=True)
                         if truth and abs(g["err"]) < abs(b["err"]))
            worse = sum(1 for b, g in zip(base, gated, strict=True)
                        if truth and abs(g["err"]) > abs(b["err"]))
            print(f"  --> gate moved the count at {sum(1 for d in deltas if d)}/{len(deltas)} "
                  f"thresholds {deltas}; closer to truth at {better}, further at {worse}")

        # The transfer summary below reads the last configuration run.
        out[sample]["exact_band"] = out[sample]["configs"][configs[-1][0]]["exact_band"]
        out[sample]["rows"] = out[sample]["configs"][configs[-1][0]]["rows"]

    # Does one value serve every page? This is the quantified transfer question.
    print("\n" + "=" * 78)
    print("CROSS-PAGE TRANSFER")
    print("=" * 78)
    bands = {s: d["exact_band"] for s, d in out.items() if d["exact_band"]}
    never = [s for s, d in out.items() if d["truth"] and not d["exact_band"]]
    if bands:
        common = set(bands[next(iter(bands))])
        for b in bands.values():
            common &= set(b)
        print(f"  pages that can match: {len(bands)}/{len(out)}  {sorted(bands)}")
        print(f"  intersection of their exact-match bands: {sorted(common) if common else 'EMPTY'}")
    if never:
        print(f"  pages that never reach truth at any threshold: {never}")
        print("    (these are detector misses, not merge failures — no threshold fixes them)")

    # Midpoint of the widest run of minimal |err|, NOT the first such threshold: with 8 grid
    # points and ties everywhere, a plain argmin reports the tie-break order, not the data.
    best = {}
    for s, d in out.items():
        if not d["truth"]:
            continue
        lo = min(abs(r["err"]) for r in d["rows"])
        run = [r["thr"] for r in d["rows"] if abs(r["err"]) == lo]
        best[s] = (run[0] + run[-1]) / 2
    if len(best) > 1:
        vals = list(best.values())
        mean = sum(vals) / len(vals)
        sd = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
        print(f"\n  per-page best threshold (midpoint of its best band): "
              f"{ {k: round(v, 3) for k, v in best.items()} }")
        print(f"  dispersion (stdev): {sd:.3f}  <- local normalisation must drive this DOWN")

    if args.json:
        with open(args.json, "w") as fh:
            json.dump(out, fh, indent=2)
        print(f"\nwrote {args.json}")


# ---------------------------------------------------------------------------
# bench — the deploy gate
# ---------------------------------------------------------------------------

# Named configurations, as (in-bubble threshold, unmatched threshold, waist gate, orientation).
# `production` is what is deployed today: the hardcoded 2.0 at handlers/ocr.py:605 and the
# OCR_MERGE_THRESHOLD=1.0 that docker-compose.yml:220 sets for the unmatched path. The two middle
# rows exist to attribute the result -- if `proposed` wins, this says which half earned it.
BENCH_CONFIGS = {
    "production": (2.0, 1.0, None, "reading_direction"),
    "threshold": (0.35, 0.35, None, "reading_direction"),
    "geometry": (2.0, 1.0, 1.0, "vote"),
    "proposed": (0.35, 0.35, 1.0, "vote"),
}
DEFAULT_BENCH_CONFIGS = ("production", "threshold", "geometry", "proposed")


def _bag(texts):
    """Multiset of normalised characters over a whole page.

    Order-invariant *by construction*, which is the entire point: the configurations under test
    produce different numbers of regions, so any metric that concatenates in some reading order is
    scoring the grouping's ordering as well as its content, and the two cannot be told apart. This
    one moves only when characters are actually lost, gained or misread.
    """
    from collections import Counter

    from bench_common import normalize_text

    return Counter(normalize_text("".join(texts)))


def _bag_prf(hyp, ref):
    overlap = sum((hyp & ref).values())
    n_hyp, n_ref = sum(hyp.values()), sum(ref.values())
    p = overlap / n_hyp if n_hyp else 0.0
    r = overlap / n_ref if n_ref else 0.0
    return {"precision": p, "recall": r,
            "f1": (2 * p * r / (p + r)) if (p + r) else 0.0,
            "chars_hyp": n_hyp, "chars_ref": n_ref}


def load_gold(sample, corpus_dir):
    """The corpus's per-region ground truth for one page.

    Returns (boxes, texts, tiers). `unresolved` regions are kept: their text is still the best
    estimate of what is on the page, and dropping them would make a configuration that finds
    *more* text look like it were hallucinating.
    """
    path = os.path.join(corpus_dir, sample, "regions.json")
    if not os.path.exists(path):
        return [], [], []
    with open(path, encoding="utf-8") as fh:
        gold = json.load(fh)
    return ([tuple(r["bbox"]) for r in gold],
            [r.get("text", "") or "" for r in gold],
            [r.get("tier", "?") for r in gold])


def _iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def transcribe_regions(img, boxes, reader, cache):
    """Re-OCR each proposed crop, exactly as the corpus builder does.

    This is the measurement that a region change is really about. `build_regions` reports the
    *joined fragment* text, which is what production sends downstream today; the corpus's gold and
    candidate strings instead come from re-running an engine on the padded crop. Both are reported,
    because they can disagree: a box can enclose the right fragments and still crop a glyph.

    `cache` is keyed on the bbox, so the configurations under test only pay for boxes that differ.
    """
    from benchmark_vlm_ocr import crop_for_region
    from worker.services.ocr import parse_paddle_ocr_results

    out = []
    for box in boxes:
        if box in cache:
            out.append(cache[box])
            continue
        crop, _ = crop_for_region(img, list(box))
        text = ""
        if crop.size:
            try:
                text = "".join(t for _b, t, _c in parse_paddle_ocr_results(reader.predict(crop))).strip()
            except Exception as exc:  # noqa: BLE001
                print(f"    [warn] transcription failed on {box}: {exc}")
        cache[box] = text
        out.append(text)
    return out


def _git_sha(path):
    import subprocess
    try:
        return subprocess.run(["git", "-C", path, "rev-parse", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
    except Exception:  # noqa: BLE001
        return None


def cmd_bench(args, reader_cache):
    """Score every configuration on every corpus page that has ground truth, and record the run.

    Three families of number, deliberately kept apart:

      structure   region count vs the hand count; mergers and splits vs the hand partition
      content     order-invariant character precision/recall against the corpus text
      coverage    how much of the corpus's own region set a configuration still finds (IoU>=0.5)

    Content is the one that answers "is this safe to deploy". A grouping change that improves
    structure while dropping characters is not an improvement, and nothing in the structural
    metrics can see that.
    """
    truth_all = load_truth()
    hand = load_hand_labels(args.labels, quiet=True)
    names = args.bench_configs or list(DEFAULT_BENCH_CONFIGS)
    for name in names:
        if name not in BENCH_CONFIGS:
            raise SystemExit(f"unknown configuration {name!r}; have {sorted(BENCH_CONFIGS)}")

    if args.sample:
        samples = [args.sample]
    else:
        samples = sorted((s for s in os.listdir(args.corpus)
                          if os.path.exists(os.path.join(args.corpus, s, "regions.json"))),
                         key=lambda s: (len(s), s))

    reader = None
    if args.transcribe:
        from benchmark_local_ocr import init_paddleocr
        if "reader" not in reader_cache:
            reader_cache["reader"] = init_paddleocr("japan", DET_MODEL, REC_MODEL)
        reader = reader_cache["reader"]
        if reader is None:
            raise SystemExit("--transcribe needs PaddleOCR, which failed to initialise")

    started = time.time()
    rows = {name: [] for name in names}
    per_sample_regions = {name: {} for name in names}

    for sample in samples:
        gold_boxes, gold_texts, gold_tiers = load_gold(sample, args.corpus)
        if not gold_boxes:
            continue
        truth = truth_all.get(sample, {}).get("count")
        img, bubbles, frags = load_proposals(args, sample, reader_cache, quiet=True)
        h, w = img.shape[:2]
        tag_fragments(frags)
        groups = hand.get(sample)
        if groups is not None and len(groups) != len(frags):
            print(f"  {sample}: annotation is stale ({len(groups)} labels, {len(frags)} fragments)"
                  " — structural scores against it are omitted")
            groups = None

        gold_bag = _bag(gold_texts)
        crop_cache: dict = {}
        print(f"\n{sample}  {len(gold_boxes)} gold regions, {len(frags)} fragments"
              f"{f', hand count {truth}' if truth else ''}")

        for name in names:
            in_thr, un_thr, gate, orient = BENCH_CONFIGS[name]
            regs = build_regions(bubbles, frags, in_thr, un_thr, args.direction,
                                 waist_gate=gate, waist_max_solidity=args.waist_max_solidity,
                                 page_shape=(h, w), orientation=orient)
            boxes = [tuple(int(v) for v in box) for box, _kind, _t in regs]
            joined = [t for _b, _k, t in regs]

            row = {"sample": sample, "regions": len(regs), "truth": truth,
                   "count_err": (len(regs) - truth) if truth else None,
                   "joined": _bag_prf(_bag(joined), gold_bag),
                   "gold_regions": len(gold_boxes),
                   "gold_covered": sum(1 for g in gold_boxes
                                       if any(_iou(g, b) >= args.iou for b in boxes)),
                   "unresolved_gold": sum(1 for t in gold_tiers if t == "unresolved")}
            if groups is not None:
                m, s = rdcl_counts(regs, frags, groups)
                row["mergers"], row["splits"] = m, s

            texts = joined
            if args.transcribe:
                texts = transcribe_regions(img, boxes, reader, crop_cache)
                row["transcribed"] = _bag_prf(_bag(texts), gold_bag)

            rows[name].append(row)
            per_sample_regions[name][sample] = [
                {"bbox": list(b), "path": k, "joined_text": jt, "text": t}
                for (b, (_bb, k, jt), t) in zip(boxes, regs, texts, strict=True)
            ]

            score = row.get("transcribed") or row["joined"]
            print(f"  {name:<11} n={len(regs):<4} err={row['count_err'] if truth else '?':>4}"
                  f"  cov={row['gold_covered']}/{len(gold_boxes)}"
                  f"  charP={score['precision']:.3f} charR={score['recall']:.3f}"
                  f" F1={score['f1']:.3f}"
                  + (f"  M={row['mergers']} S={row['splits']}" if groups is not None else ""))

    if not any(rows.values()):
        raise SystemExit("no corpus pages with regions.json were scored")

    summary = []
    for name in names:
        rs = rows[name]
        scored = [r for r in rs if (r.get("transcribed") or r["joined"])["chars_ref"]]
        with_truth = [r for r in rs if r["count_err"] is not None]
        with_hand = [r for r in rs if "mergers" in r]

        def _mean(key, sub, src=scored):
            return round(sum((r.get("transcribed") or r["joined"])[key] for r in src) / len(src), 4) \
                if src else None

        in_thr, un_thr, gate, orient = BENCH_CONFIGS[name]
        summary.append({
            "config": name,
            "in_threshold": in_thr, "unmatched_threshold": un_thr,
            "waist_gate": gate, "orientation": orient,
            "pages": len(rs),
            "regions": sum(r["regions"] for r in rs),
            "abs_count_err": sum(abs(r["count_err"]) for r in with_truth) or 0,
            "pages_with_truth": len(with_truth),
            "mergers": sum(r["mergers"] for r in with_hand) if with_hand else None,
            "splits": sum(r["splits"] for r in with_hand) if with_hand else None,
            "cost": (sum(r["mergers"] for r in with_hand) * args.merger_cost
                     + sum(r["splits"] for r in with_hand)) if with_hand else None,
            "gold_coverage": round(sum(r["gold_covered"] for r in rs)
                                   / max(1, sum(r["gold_regions"] for r in rs)), 4),
            "char_precision": _mean("precision", scored),
            "char_recall": _mean("recall", scored),
            "char_f1": _mean("f1", scored),
            "scored_by": "transcribed crops" if args.transcribe else "joined fragment text",
        })

    print("\n" + "=" * 96)
    print(f"BENCH — {len(rows[names[0]])} pages, scored on "
          f"{'re-OCR of each proposed crop' if args.transcribe else 'joined fragment text'}")
    print("=" * 96)
    head = f"{'config':<12}{'regions':>8}{'|err|':>7}{'M':>5}{'S':>5}{'cost':>6}{'cover':>8}{'charP':>8}{'charR':>8}{'charF1':>8}"
    print(head)
    for s in summary:
        print(f"{s['config']:<12}{s['regions']:>8}{s['abs_count_err']:>7}"
              f"{s['mergers'] if s['mergers'] is not None else '-':>5}"
              f"{s['splits'] if s['splits'] is not None else '-':>5}"
              f"{s['cost'] if s['cost'] is not None else '-':>6}"
              f"{s['gold_coverage']:>8.3f}{s['char_precision']:>8.3f}"
              f"{s['char_recall']:>8.3f}{s['char_f1']:>8.3f}")
    print("\n  charR is the deploy gate: the share of the corpus's characters a configuration still")
    print("  finds. It cannot be gamed by splitting, so it is the one number that says whether a")
    print("  regrouping is safe. charP falls when a configuration produces text the corpus lacks,")
    print("  which here is as often a real untranscribed SFX as a hallucination -- read it with the")
    print("  overlays, not on its own.")
    print(f"\n  `cover` is agreement with the corpus's EXISTING boxes at IoU>={args.iou}, and it is")
    print("  NOT a quality score: those boxes were produced by `production`, so any configuration")
    print("  that splits more must score lower on it by construction. It is here to quantify how")
    print("  much of the corpus a deploy would invalidate, which is a cost, not a defect.")

    if args.no_save:
        return

    run_dir = args.run_dir or os.path.join(
        REPO_ROOT, "corpus", "runs", time.strftime("%Y-%m-%d"), "region-grouping")
    os.makedirs(run_dir, exist_ok=True)
    manifest = {
        "kind": "region-grouping",
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "duration_s": round(time.time() - started, 1),
        "scored_by": "transcribed crops" if args.transcribe else "joined fragment text",
        "detector": {"det_model": DET_MODEL, "rec_model": REC_MODEL, "max_dim": OCR_MAX_DIM},
        "iou_threshold": args.iou,
        "merger_cost": args.merger_cost,
        "commits": {"manga-library": _git_sha(REPO_ROOT),
                    "manga-tl-worker": _git_sha(os.path.join(REPO_ROOT, "worker")),
                    "corpus": _git_sha(os.path.join(REPO_ROOT, "corpus"))},
        "configs": {n: dict(zip(("in_threshold", "unmatched_threshold", "waist_gate",
                                 "orientation"), BENCH_CONFIGS[n], strict=True)) for n in names},
        "summary": summary,
        "pages": {n: rows[n] for n in names},
    }
    with open(os.path.join(run_dir, "_summary.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    for name in names:
        cdir = os.path.join(run_dir, name)
        os.makedirs(cdir, exist_ok=True)
        for sample, regs in per_sample_regions[name].items():
            with open(os.path.join(cdir, f"{sample}.json"), "w", encoding="utf-8") as fh:
                json.dump(regs, fh, ensure_ascii=False, indent=2)
    print(f"\nwrote {os.path.relpath(run_dir, REPO_ROOT)}/  "
          f"(_summary.json + {len(names)} x {len(per_sample_regions[names[0]])} page files)")
    print("  corpus/ is a submodule — commit it there, not here.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=("sweep", "overlay", "direction", "waist", "ablate",
                                    "label", "rdcl", "bench"))
    ap.add_argument("sample", nargs="?", help="corpus/ocr sample id, e.g. sample30 (ablate: all)")
    ap.add_argument("--truth", type=int, default=0,
                    help="hand-counted text areas; defaults to scripts/region_truth.json")
    ap.add_argument("--corpus", default=DEFAULT_CORPUS)
    ap.add_argument("--no-cache", action="store_true",
                    help="bypass the on-disk (bubbles, fragments) cache and re-run the models")
    ap.add_argument("--cache-dir", default=None,
                    help=f"cache location (default $REGION_PROBE_CACHE or {default_cache_dir()})")
    ap.add_argument("--direction", default="rtl", choices=("rtl", "ltr"))
    ap.add_argument("--in-threshold", type=float, default=0.35,
                    help="in-bubble split threshold (overlay mode)")
    ap.add_argument("--labels", default=DEFAULT_LABELS,
                    help=f"directory of annotation JSON written by 'label' mode (default "
                         f"{os.path.relpath(DEFAULT_LABELS, REPO_ROOT)}). Hand labels override "
                         f"the derived ones, per sample")
    ap.add_argument("--merger-cost", type=int, default=5,
                    help="rdcl mode: how many splits one merger is worth. A product\n"
                         "decision, not a parameter to tune (default 5)")
    ap.add_argument("--orientation-vote", action="store_true",
                    help="ablate mode: also run configurations deriving text orientation from "
                         "fragment aspect ratios instead of the binding direction (BUG-6)")
    ap.add_argument("--waist-gate", type=float, default=None,
                    help="ablate mode: also run a configuration with the clearance veto at this "
                         "many characters (try 1.0). Off by default, matching production")
    ap.add_argument("--waist-max-solidity", type=float, default=0.90,
                    help="only veto inside masks below this solidity (default 0.90)")
    ap.add_argument("--label-threshold", type=float, default=0.35,
                    help="waist mode: threshold whose grouping labels pairs same/cross-balloon. "
                         "Only trusted on pages where it reproduces the hand count (default 0.35)")
    ap.add_argument("--unmatched-threshold", type=float, default=CODE_DEFAULT_THRESHOLD,
                    help=f"threshold for the unmatched/direct_text path (default {CODE_DEFAULT_THRESHOLD}, "
                         "the code default; production deploys 1.0)")
    # Deliberately outside the repo: overlays are throwaway, and corpus/ is a submodule whose
    # diff should stay meaningful.
    ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "region_probe"),
                    help="overlay output directory")
    ap.add_argument("--json", help="sweep mode: also write the table here")
    ap.add_argument("--bench-configs", nargs="+", metavar="NAME",
                    help=f"bench mode: which named configurations to run, from "
                         f"{sorted(BENCH_CONFIGS)} (default: all four)")
    ap.add_argument("--transcribe", action="store_true",
                    help="bench mode: re-OCR every proposed crop instead of scoring the joined "
                         "fragment text. Slower, and the measurement the corpus is built from")
    ap.add_argument("--iou", type=float, default=0.5,
                    help="bench mode: IoU at which a proposal counts as covering a corpus "
                         "region (default 0.5)")
    ap.add_argument("--run-dir", default=None,
                    help="bench mode: where to record the run (default "
                         "corpus/runs/<today>/region-grouping)")
    ap.add_argument("--no-save", action="store_true",
                    help="bench mode: print the tables but do not write the run into the corpus")
    args = ap.parse_args()

    if args.mode not in ("ablate", "waist", "label", "rdcl", "bench") and not args.sample:
        ap.error(f"{args.mode} needs a sample id")
    if not args.truth and args.sample:
        args.truth = load_truth().get(args.sample, {}).get("count", 0)

    reader_cache = {}
    {"sweep": cmd_sweep, "overlay": cmd_overlay, "direction": cmd_direction,
     "waist": cmd_waist, "ablate": cmd_ablate, "label": cmd_label,
     "rdcl": cmd_rdcl, "bench": cmd_bench}[args.mode](args, reader_cache)


if __name__ == "__main__":
    main()
