#!/usr/bin/env python3
"""Render the OCR region pipeline for one page as a step-by-step HTML walkthrough.

Every stage the production path runs between "here is a page" and "here are the regions we send
to translation" is drawn as an overlay on the page itself, one step at a time:

    0  page          the raw corpus page, nothing drawn
    1  bubbles       YOLO11n-seg balloon masks -- the regions of interest
    2  fragments     PP-OCRv6 det text lines, before anything knows what a balloon is
    3  assignment    each fragment claimed by the balloon mask it most overlaps, or by nobody
    4  grouping      fragments joined into balloons by the proximity rule, edge by edge
    5  regions       the merged regions, the shape the rest of the pipeline sees

The detection stage is *not* re-run: this reads `region_proposal_probe`'s on-disk cache, so it
costs no model time and cannot drift from what the probe and the benchmarks measure. Pass
`--no-cache` to force the models (slow, and it will contend with a running benchmark).

Stages 4 and 5 are shown for *every configuration the newest recorded run scored*, switchable in
the header, each carrying that run's own numbers for this page. The regions are recomputed here
rather than read back, and then checked against the run's per-sample output: a page that says
"reproduces the run exactly" is showing you the thing that was measured, not a lookalike. That
check is why the walkthrough is worth trusting as an explanation of a benchmark result.

Stage 4 is the one worth looking at. It draws the adjacency *edges* -- which pair of fragments the
distance rule actually joined -- not just the resulting boxes, because a wrong group is always one
specific edge that should not exist, and a union box hides which one.

Usage:
    scripts/ocr_walkthrough.py --sample sample30
    scripts/ocr_walkthrough.py --sample sample30 --config proposed
    scripts/ocr_walkthrough.py --sample sample30 --in-threshold 0.35 --orientation vote
"""

import argparse
import base64
import html
import json
import mimetypes
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import region_proposal_probe as probe
from worker.services.fragment_grouping import (
    GroupingConfig,
    _should_merge,
    _waist_veto,
    group_fragments,
    resolve_vertical,
)

# What handlers/ocr.py actually deploys: 2.0 is hardcoded at the in-bubble call site (:605), and
# the unmatched call (:663) takes OCR_MERGE_THRESHOLD, which docker-compose.yml:220 sets to 1.0.
# Defaulting to these means the walkthrough shows production unless you ask it not to.
PRODUCTION_IN_THRESHOLD = 2.0
PRODUCTION_UNMATCHED_THRESHOLD = 1.0

# Distinguishable at 2px stroke on both dark art and white balloons. Index 0 is reserved for the
# unmatched path so "orange means nobody claimed it" stays true across every page.
UNMATCHED_COLOR = "#f2762e"
BUBBLE_COLORS = ["#4da3ff", "#3ddc97", "#c792ea", "#ffd166", "#ff6b9d", "#5eead4", "#f4a261", "#a3e635"]


def bubble_color(i):
    return BUBBLE_COLORS[i % len(BUBBLE_COLORS)]


def analyse(img, bubbles, frags, args, cfgs):
    """Re-run the grouping stage, keeping the intermediates the production call throws away.

    `group_fragments` returns only the partition, so the edges and the gap budgets behind it are
    recomputed here from the same module-level helpers the partition used -- not reimplemented.
    Calling the real `_should_merge` is the point: if the rule changes, this picture changes with
    it instead of quietly describing last month's behaviour.
    """
    h, w = img.shape[:2]
    masks = probe.bubble_masks(bubbles, h, w)
    steps = []

    def run(members, cfg, ctx, path, bubble_idx):
        """One merge_ocr_regions call, opened up."""
        if not members:
            return
        sub = [frags[i] for i in members]
        n = len(sub)
        avg_h = sum(f["height"] for f in sub) / n
        avg_w = sum(f["width"] for f in sub) / n
        vertical = resolve_vertical(sub, cfg)
        char_size = avg_w if vertical else avg_h
        max_v_gap = char_size * cfg.threshold_ratio
        max_h_gap = avg_w * cfg.threshold_ratio

        veto = _waist_veto(cfg, ctx)
        edges = []
        for a in range(n):
            for b in range(a + 1, n):
                if not _should_merge(sub[a], sub[b], max_h_gap, max_v_gap):
                    continue
                vetoed = bool(veto is not None and veto(sub[a], sub[b], vertical))
                edges.append({"a": members[a], "b": members[b], "vetoed": vetoed})

        parts = group_fragments(sub, cfg, ctx)
        groups = []
        for comp in parts:
            idx = [members[k] for k in comp]
            boxes = [frags[i] for i in idx]
            x0 = min(f["x"] for f in boxes)
            y0 = min(f["y"] for f in boxes)
            x1 = max(f["x"] + f["width"] for f in boxes)
            y1 = max(f["y"] + f["height"] for f in boxes)
            groups.append({"members": idx, "box": [x0, y0, x1 - x0, y1 - y0]})

        steps.append({
            "path": path,
            "bubble_idx": bubble_idx,
            "threshold": cfg.threshold_ratio,
            "vertical": vertical,
            "char_size": round(char_size, 1),
            "max_v_gap": round(max_v_gap, 1),
            "max_h_gap": round(max_h_gap, 1),
            "members": members,
            "edges": edges,
            "groups": groups,
        })

    for i, bub in enumerate(bubbles):
        inside = [k for k, f in enumerate(frags) if f["bubble_idx"] == i]
        if not inside:
            # build_regions emits the balloon itself as a text-less region, and the bench counts
            # it. Production only does this on the cloud-VLM path (handlers/ocr.py:586) -- with
            # local PaddleOCR an empty balloon is dropped. Kept, so counts reconcile with the run.
            steps.append({"path": "bubble", "bubble_idx": i, "empty": True, "members": [],
                          "edges": [], "groups": [{"members": [], "box": list(bub["bbox"])}]})
            continue
        cfg = GroupingConfig(threshold_ratio=cfgs.in_threshold, reading_direction=args.direction,
                             orientation=cfgs.orientation, waist_gate=cfgs.waist_gate,
                             waist_max_solidity=args.waist_max_solidity)
        ctx = probe.bubble_context(masks[i], bub) if cfgs.waist_gate is not None else None
        run(inside, cfg, ctx, "bubble", i)

    unmatched = [k for k, f in enumerate(frags) if f["bubble_idx"] == -1]
    # The unmatched path has no balloon mask, so no clearance to measure -- distance only, as in
    # production. Mirrors build_regions().
    cfg = GroupingConfig(threshold_ratio=cfgs.unmatched_threshold, reading_direction=args.direction,
                         orientation=cfgs.orientation)
    run(unmatched, cfg, None, "unmatched", -1)
    return steps


# merge_regions.py builds this per call, inside the function, so it cannot be imported. Kept
# character-for-character identical; the run cross-check is what keeps it that way.
CJK_PATTERN = re.compile(r"[぀-鿿豈-﫿]")


def final_regions(steps, frags, direction):
    """Assemble each group into the region dict the pipeline goes on to use.

    Text join follows merge_ocr_regions: reading order first (RTL = larger x first), then a
    spacer-less join if any fragment carries CJK and a space-separated one otherwise. The
    otherwise branch is not hypothetical -- a group of pure punctuation garbage takes it, and
    getting it wrong is what the run cross-check first caught.
    """
    out = []
    for step in steps:
        for g in step["groups"]:
            idx = sorted(g["members"], key=lambda i: (-frags[i]["x"], frags[i]["y"]))
            if direction != "rtl":
                idx = sorted(g["members"], key=lambda i: (frags[i]["x"], frags[i]["y"]))
            texts = [frags[i]["text"].strip() for i in idx if frags[i]["text"].strip()]
            out.append({
                "box": g["box"],
                "path": step["path"],
                "bubble_idx": step["bubble_idx"],
                "members": idx,
                "empty": bool(step.get("empty")),
                "text": ("".join(texts) if any(CJK_PATTERN.search(t) for t in texts)
                         else " ".join(texts)),
                "confidence": round(sum(frags[i]["confidence"] for i in idx) / max(1, len(idx)), 3)
                if idx else None,
            })
    return out


class Cfg:
    """One named grouping configuration, as the bench defines it."""

    def __init__(self, name, in_threshold, unmatched_threshold, waist_gate, orientation):
        self.name = name
        self.in_threshold = float(in_threshold)
        self.unmatched_threshold = float(unmatched_threshold)
        self.waist_gate = None if waist_gate is None else float(waist_gate)
        self.orientation = orientation

    def as_dict(self):
        return {"name": self.name, "in_threshold": self.in_threshold,
                "unmatched_threshold": self.unmatched_threshold,
                "waist_gate": self.waist_gate, "orientation": self.orientation,
                "is_production": (self.in_threshold == PRODUCTION_IN_THRESHOLD
                                  and self.unmatched_threshold == PRODUCTION_UNMATCHED_THRESHOLD
                                  and self.waist_gate is None
                                  and self.orientation == "reading_direction")}


def find_run(repo_root, explicit=None):
    """The newest recorded region-grouping run, or the one named on the command line.

    Runs are `corpus/runs/<date>/region-grouping/`, so newest-by-name is newest-by-date. A run
    without `_summary.json` is still being written and is skipped.
    """
    if explicit:
        return explicit if os.path.exists(os.path.join(explicit, "_summary.json")) else None
    base = os.path.join(repo_root, "corpus", "runs")
    if not os.path.isdir(base):
        return None
    for date in sorted(os.listdir(base), reverse=True):
        cand = os.path.join(base, date, "region-grouping")
        if os.path.exists(os.path.join(cand, "_summary.json")):
            return cand
    return None


def load_run(run_dir, sample):
    """The run's configurations, its aggregate table, and this page's row and regions per config."""
    with open(os.path.join(run_dir, "_summary.json"), encoding="utf-8") as fh:
        s = json.load(fh)

    configs = [Cfg(name, c["in_threshold"], c["unmatched_threshold"],
                   c.get("waist_gate"), c.get("orientation", "reading_direction"))
               for name, c in s["configs"].items()]

    per_page, recorded = {}, {}
    for name in s["configs"]:
        rows = {r["sample"]: r for r in s.get("pages", {}).get(name, [])}
        per_page[name] = rows.get(sample)
        path = os.path.join(run_dir, name, f"{sample}.json")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                recorded[name] = json.load(fh)

    meta = {"dir": os.path.relpath(run_dir, probe.REPO_ROOT),
            "generated": s.get("generated"), "duration_s": s.get("duration_s"),
            "commits": s.get("commits", {}), "iou_threshold": s.get("iou_threshold"),
            "merger_cost": s.get("merger_cost"), "scored_by": s.get("scored_by"),
            "summary": s.get("summary", [])}
    return meta, configs, per_page, recorded


def verify(regions, recorded):
    """Does this page reproduce the run's regions exactly?

    Guards against the walkthrough drifting from the numbers it claims to illustrate -- a config
    read wrong, or a code change since the run. Reports the first disagreement rather than a bare
    boolean, because "differs" without a location is not actionable.
    """
    if recorded is None:
        return {"status": "unscored"}
    if len(regions) != len(recorded):
        return {"status": "differs",
                "detail": f"{len(regions)} regions here, {len(recorded)} in the run"}
    for i, (mine, theirs) in enumerate(zip(regions, recorded)):
        if list(mine["box"]) != list(theirs["bbox"]):
            return {"status": "differs",
                    "detail": f"region {i} box {mine['box']} vs {theirs['bbox']}"}
        if mine["text"] != theirs.get("joined_text", ""):
            return {"status": "differs", "detail": f"region {i} text differs"}
    return {"status": "match"}


def data_uri(path):
    mime = mimetypes.guess_type(path)[0] or "image/webp"
    with open(path, "rb") as fh:
        return f"data:{mime};base64," + base64.b64encode(fh.read()).decode()


def build(args, sample=None, reader_cache=None):
    sample = sample or args.sample
    args = argparse.Namespace(**{**vars(args), "sample": sample})
    reader_cache = {} if reader_cache is None else reader_cache
    img, bubbles, frags = probe.proposals(sample, args.corpus, reader_cache,
                                          use_cache=not args.no_cache, cache_dir=args.cache_dir)
    h, w = img.shape[:2]

    for i, b in enumerate(bubbles):
        b["solidity"] = round(probe.mask_solidity(b), 3)
        b["color"] = bubble_color(i)
    for i, f in enumerate(frags):
        f["i"] = i

    run_dir = None if args.no_run else find_run(probe.REPO_ROOT, args.run)
    if run_dir:
        run_meta, configs, per_page, recorded = load_run(run_dir, args.sample)
    else:
        run_meta, per_page, recorded = None, {}, {}
        configs = [Cfg("production", PRODUCTION_IN_THRESHOLD, PRODUCTION_UNMATCHED_THRESHOLD,
                       None, "reading_direction")]

    # An explicit threshold flag means "show me this instead", so it becomes its own configuration
    # alongside the run's, and the one the page opens on.
    custom = None
    if any(v is not None for v in (args.in_threshold, args.unmatched_threshold, args.waist_gate,
                                   args.orientation)):
        base = next((c for c in configs if c.name == "production"), configs[0])
        custom = Cfg("custom",
                     args.in_threshold if args.in_threshold is not None else base.in_threshold,
                     args.unmatched_threshold if args.unmatched_threshold is not None
                     else base.unmatched_threshold,
                     args.waist_gate if args.waist_gate is not None else base.waist_gate,
                     args.orientation or base.orientation)
        configs.append(custom)

    built = []
    for cfg in configs:
        steps = analyse(img, bubbles, frags, args, cfg)
        regions = final_regions(steps, frags, args.direction)
        rec = recorded.get(cfg.name)
        for i, r in enumerate(regions):
            # What the bench actually scores: the merged crop sent back through PP-OCR rec. It is
            # not the fragment join -- re-reading a crop can recover or lose characters, and that
            # difference is the whole point of scoring on crops.
            r["transcribed"] = rec[i].get("text") if rec and i < len(rec) else None
        built.append({**cfg.as_dict(), "steps": steps, "regions": regions,
                      "page_metrics": per_page.get(cfg.name),
                      "verified": verify(regions, rec)})

    gold_boxes, gold_texts, gold_tiers = probe.load_gold(args.sample, args.corpus)
    active = args.config or (custom.name if custom else "production")
    if not any(c["name"] == active for c in built):
        raise SystemExit(f"no configuration {active!r} in this run; "
                         f"have {', '.join(c['name'] for c in built)}")

    payload = {
        "sample": args.sample,
        "page": {"w": w, "h": h, "src": data_uri(os.path.join(args.corpus, args.sample, "page.webp"))},
        "detector": {"det_model": probe.DET_MODEL, "rec_model": probe.REC_MODEL,
                     "ocr_max_dim": probe.OCR_MAX_DIM, "direction": args.direction},
        "run": run_meta,
        "configs": built,
        "active": active,
        "bubbles": bubbles,
        "frags": frags,
        "gold": [{"box": list(b), "text": t, "tier": tier}
                 for b, t, tier in zip(gold_boxes, gold_texts, gold_tiers)],
        "unmatched_color": UNMATCHED_COLOR,
    }

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, f"{args.sample}.html")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(render(payload))
    return path, payload


def render(p):
    blob = json.dumps(p, ensure_ascii=False).replace("</", "<\\/")
    title = html.escape(f"OCR walkthrough — {p['sample']}")
    return TEMPLATE.replace("{{TITLE}}", title).replace("{{DATA}}", blob)


def write_index(out, rows, run_meta):
    """A contents page for the directory: every sample, every configuration's region count.

    Sorted by disagreement with the corpus count, so the pages worth opening are at the top.
    """
    names = rows[0]["configs"] if rows else []
    head = "".join(f"<th>{html.escape(n)}</th>" for n in names)
    body = []
    for r in sorted(rows, key=lambda r: (-max((abs(d) for d in r["errs"].values()), default=0),
                                         len(r["sample"]), r["sample"])):
        cells = []
        for n in names:
            err = r["errs"].get(n)
            cls = "" if err in (0, None) else ' class="off"'
            cells.append(f"<td{cls}>{r['counts'][n]}"
                         + (f" <i>{err:+d}</i>" if err not in (0, None) else "") + "</td>")
        flag = "" if r["verified"] else '<span class="warn"> differs from run</span>'
        body.append(f'<tr><td><a href="{r["sample"]}.html">{r["sample"]}</a>{flag}</td>'
                    f'<td class="dim">{r["gold"] or "—"}</td>{"".join(cells)}</tr>')

    sub = (f"run {html.escape(run_meta['dir'])} · {html.escape(run_meta['generated'] or '')}"
           if run_meta else "no recorded run — production configuration only")
    page = INDEX_TEMPLATE.replace("{{SUB}}", sub).replace("{{HEAD}}", head)
    page = page.replace("{{BODY}}", "\n".join(body)).replace("{{N}}", str(len(rows)))
    path = os.path.join(out, "index.html")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(page)
    return path


INDEX_TEMPLATE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OCR walkthroughs</title>
<style>
body{margin:0;background:#0e1116;color:#e6edf3;
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:26px}
.wrap{max-width:900px;margin:0 auto}
h1{font-size:17px;margin:0 0 4px}
.sub{color:#8b949e;font-size:12.5px;font-family:ui-monospace,Menlo,monospace;margin-bottom:18px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:right;padding:6px 10px;border-bottom:1px solid #2a313c}
th:first-child,td:first-child{text-align:left}
th{color:#8b949e;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
a{color:#4da3ff;text-decoration:none}
a:hover{text-decoration:underline}
td.off{color:#f2762e}
td.off i{font-style:normal;opacity:.75;font-size:11px}
.dim{color:#8b949e}
.warn{color:#f2762e;font-size:11px}
p.note{color:#8b949e;font-size:12.5px;margin-top:18px}
</style></head><body><div class="wrap">
<h1>OCR region walkthroughs</h1>
<div class="sub">{{N}} pages · {{SUB}}</div>
<table><thead><tr><th>sample</th><th>corpus</th>{{HEAD}}</tr></thead>
<tbody>{{BODY}}</tbody></table>
<p class="note">Region count per configuration; orange marks a page where the count disagrees with
the corpus, with the difference. Sorted worst-first.</p>
</div></body></html>
"""


TEMPLATE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{TITLE}}</title>
<style>
:root{
  --bg:#0e1116; --panel:#161b22; --line:#2a313c; --ink:#e6edf3; --dim:#8b949e;
  --accent:#4da3ff; --final:#2f81f7;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{position:sticky;top:0;z-index:20;background:rgba(14,17,22,.92);
  backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:10px 18px}
.hrow{display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.01em}
.meta{color:var(--dim);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.badge{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
.badge.prod{border-color:#2ea04366;color:#3fb950}
.badge.warn{border-color:#f2762e66;color:#f2762e}
.cfgs{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px}
.cfgs .lbl{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.cfgs button{font:inherit;font-size:12px;padding:3px 10px;border-radius:99px;cursor:pointer;
  border:1px solid var(--line);background:transparent;color:var(--dim)}
.cfgs button:hover{color:var(--ink);border-color:#3d4551}
.cfgs button[aria-pressed="true"]{background:#1f6feb22;border-color:var(--accent);color:var(--accent);
  font-weight:600}
.cfgs button .c{opacity:.65;font-family:ui-monospace,monospace;margin-left:6px}
nav{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
nav button{font:inherit;font-size:12.5px;padding:5px 12px;border-radius:6px;cursor:pointer;
  border:1px solid var(--line);background:var(--panel);color:var(--dim);white-space:nowrap}
nav button:hover{border-color:#3d4551;color:var(--ink)}
nav button[aria-current="true"]{background:var(--accent);border-color:var(--accent);color:#08121f;font-weight:600}
nav .n{opacity:.6;margin-right:6px;font-family:ui-monospace,monospace}
main{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:18px;padding:18px;
  align-items:start;max-width:1600px;margin:0 auto}
@media(max-width:1000px){main{grid-template-columns:1fr}}
#stage{position:relative;background:#000;border:1px solid var(--line);border-radius:8px;overflow:hidden}
#stage img{width:100%;display:block}
#stage svg{position:absolute;inset:0;width:100%;height:100%}
aside{position:sticky;top:104px;display:flex;flex-direction:column;gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px}
.card h2{font-size:13px;margin:0 0 6px;letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
.card p{margin:0 0 8px}
.card p:last-child{margin-bottom:0}
.card code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
  background:#0d1117;border:1px solid var(--line);border-radius:4px;padding:1px 5px}
.list{max-height:44vh;overflow:auto;font-size:12.5px}
.item{display:flex;gap:9px;align-items:flex-start;padding:5px 0;border-top:1px solid var(--line);
  overflow-wrap:anywhere}
.item:first-child{border-top:0}
.chip{flex:none;width:22px;height:18px;border-radius:4px;font:600 10px/18px ui-monospace,monospace;
  text-align:center;color:#08121f}
.jp{font-size:13px;word-break:break-all}
.muted{color:var(--dim)}
.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--dim);margin-top:8px}
.legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:5px;
  vertical-align:-1px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:12.5px}
.kv dt{color:var(--dim)}
.kv dd{margin:0;font-family:ui-monospace,monospace}
footer{padding:6px 18px 30px;color:var(--dim);font-size:12px;max-width:1600px;margin:0 auto}
kbd{border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 5px;
  font:11px ui-monospace,monospace}
</style></head><body>
<header>
  <div class="hrow">
    <h1 id="ttl"></h1>
    <span class="meta" id="sub"></span>
    <span class="badge" id="cfg"></span>
    <span class="badge" id="ver"></span>
  </div>
  <div class="cfgs" id="cfgs"></div>
  <nav id="nav"></nav>
</header>
<main>
  <div id="stage"><img id="page" alt=""><svg id="ov" preserveAspectRatio="none"></svg></div>
  <aside>
    <div class="card"><h2 id="sttl"></h2><div id="sbody"></div><div class="legend" id="leg"></div></div>
    <div class="card" id="detail"></div>
  </aside>
</main>
<footer><kbd>&larr;</kbd> <kbd>&rarr;</kbd> to step &middot; hover a box to highlight its text</footer>
<script>
const D = {{DATA}};
const SVGNS = "http://www.w3.org/2000/svg";
const el = (n, a = {}) => { const e = document.createElementNS(SVGNS, n);
  for (const k in a) e.setAttribute(k, a[k]); return e; };
const esc = s => { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; };
const fmt = (b) => `${b[0]},${b[1]} ${b[2]}×${b[3]}`;

const ov = document.getElementById("ov");
ov.setAttribute("viewBox", `0 0 ${D.page.w} ${D.page.h}`);
document.getElementById("page").src = D.page.src;
document.getElementById("ttl").textContent = `OCR walkthrough — ${D.sample}`;

const nUn = D.frags.filter(f => f.bubble_idx === -1).length;

// The active configuration governs stages 4 and 5 only; detection and assignment precede it.
let active = D.configs.find(c => c.name === D.active) || D.configs[0];
const C = () => active;
const R = () => active.regions;
const S = () => active.steps;

function header() {
  document.getElementById("sub").textContent =
    `${D.page.w}×${D.page.h} · ${D.bubbles.length} bubbles · ${D.frags.length} fragments ` +
    `(${nUn} unmatched) · ${R().length} regions`;
  const cfg = document.getElementById("cfg");
  const c = C();
  cfg.textContent = `in ${c.in_threshold} / un ${c.unmatched_threshold} / ${c.orientation}` +
    (c.waist_gate !== null ? ` / waist ${c.waist_gate}` : "") + (c.is_production ? " · production" : "");
  cfg.className = "badge" + (c.is_production ? " prod" : "");

  const ver = document.getElementById("ver");
  const v = c.verified;
  ver.textContent = v.status === "match" ? "reproduces the run exactly"
    : v.status === "differs" ? "differs from the run: " + v.detail
    : "not scored in this run";
  ver.className = "badge" + (v.status === "match" ? " prod" : v.status === "differs" ? " warn" : "");
}

const cfgBar = document.getElementById("cfgs");
if (D.configs.length > 1 || D.run) {
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = D.run ? "run " + D.run.dir.replace(/^corpus\/runs\//, "") : "config";
  cfgBar.appendChild(lbl);
}
D.configs.forEach(c => {
  const b = document.createElement("button");
  const cost = c.page_metrics && c.page_metrics.mergers !== undefined
    ? `<span class="c">M${c.page_metrics.mergers} S${c.page_metrics.splits}</span>` : "";
  b.innerHTML = esc(c.name) + `<span class="c">${c.regions.length}</span>` + cost;
  b.onclick = () => { active = c; header(); paintCfgs(); show(cur); };
  cfgBar.appendChild(b);
});
function paintCfgs() {
  [...cfgBar.querySelectorAll("button")].forEach((b, i) =>
    b.setAttribute("aria-pressed", String(D.configs[i] === active)));
}

// Fragment colour follows its bubble, so a fragment keeps its identity from stage 3 onward.
const fragColor = f => f.bubble_idx < 0 ? D.unmatched_color : D.bubbles[f.bubble_idx].color;
const poly = b => (b.mask_polygon || []).map(p => p.join(",")).join(" ");
const centre = f => [f.x + f.width / 2, f.y + f.height / 2];

function box(f, o = {}) {
  return el("rect", { x: f.x, y: f.y, width: f.width, height: f.height,
    fill: o.fill || "none", stroke: o.stroke, "stroke-width": o.sw || 3,
    "stroke-dasharray": o.dash || "", rx: o.rx || 2, opacity: o.op ?? 1 });
}
function tag(x, y, text, color) {
  const g = el("g");
  const w = String(text).length * 11 + 12, h = 21;
  g.appendChild(el("rect", { x, y: y - h, width: w, height: h, fill: color, rx: 3 }));
  const t = el("text", { x: x + 6, y: y - 6, fill: "#08121f",
    "font-family": "ui-monospace,monospace", "font-size": 15, "font-weight": 700 });
  t.textContent = text;
  g.appendChild(t);
  return g;
}

/* ---- stages ------------------------------------------------------------ */

const STAGES = [
{
  key: "page", nav: "Page", title: "The page as it arrives",
  body: () => `<p>A corpus page at <code>${D.page.w}×${D.page.h}</code>. Nothing has looked at it
    yet. Everything that follows is derived from these pixels alone — no layout metadata, no
    panel information, no prior about where balloons live.</p>
    <p class="muted">Detection was read from <code>region_proposal_probe</code>'s cache, so these are
    byte-for-byte the proposals the sweeps and benchmarks score.</p>`,
  legend: () => [],
  draw: () => {},
  detail: () => `<h2>Models</h2><dl class="kv">
    <dt>bubbles</dt><dd>YOLO11n-seg (ONNX)</dd>
    <dt>detector</dt><dd>${esc(D.detector.det_model)}</dd>
    <dt>recogniser</dt><dd>${esc(D.detector.rec_model)}</dd>
    <dt>OCR max dim</dt><dd>${D.detector.ocr_max_dim}px</dd>
    <dt>direction</dt><dd>${esc(D.detector.direction)}</dd></dl>`
    + (D.run ? `<h2 style="margin-top:14px">Run</h2><dl class="kv">
    <dt>recorded</dt><dd>${esc(D.run.dir)}</dd>
    <dt>generated</dt><dd>${esc(D.run.generated || "?")}</dd>
    <dt>duration</dt><dd>${D.run.duration_s ? Math.round(D.run.duration_s / 60) + " min" : "?"}</dd>
    <dt>scored by</dt><dd>${esc(D.run.scored_by || "?")}</dd>
    <dt>IoU</dt><dd>${D.run.iou_threshold}</dd>
    ${Object.entries(D.run.commits || {}).map(([k, v]) =>
      `<dt>${esc(k)}</dt><dd>${esc(String(v).slice(0, 10))}</dd>`).join("")}
    </dl>` : "")
},
{
  key: "bubbles", nav: "Bubbles", title: "1 · Balloon segmentation",
  body: () => `<p>YOLO11n-seg runs once on the whole page and returns a <em>mask</em> per balloon,
    not just a box: the prototype masks are thresholded, closed with a 15px ellipse, and reduced to
    a simplified contour. ${D.bubbles.length} survived NMS here.</p>
    <p>Solidity (mask area ÷ convex hull area) is the number to watch — below
    <code>0.90</code> the mask is pinched, which usually means one detection swallowed two touching
    balloons.</p>`,
  legend: () => D.bubbles.map((b, i) => [b.color, `B${i} · conf ${b.confidence.toFixed(2)}`]),
  draw: g => {
    D.bubbles.forEach((b, i) => {
      if (b.mask_polygon) g.appendChild(el("polygon", { points: poly(b), fill: b.color,
        "fill-opacity": .17, stroke: b.color, "stroke-width": 3 }));
      const [x, y, w, h] = b.bbox;
      g.appendChild(el("rect", { x, y, width: w, height: h, fill: "none", stroke: b.color,
        "stroke-width": 2, "stroke-dasharray": "9 7", opacity: .65 }));
      g.appendChild(tag(x, Math.max(22, y), `B${i}`, b.color));
    });
  },
  detail: () => `<h2>Bubbles</h2><div class="list">` + D.bubbles.map((b, i) =>
    `<div class="item"><span class="chip" style="background:${b.color}">B${i}</span>
     <span><span class="muted">${fmt(b.bbox)}</span><br>
     conf ${b.confidence.toFixed(3)} · solidity ${b.solidity}
     ${b.solidity < 0.9 ? '<span style="color:#f2762e"> ← pinched</span>' : ""}</span></div>`
  ).join("") + `</div>`
},
{
  key: "frags", nav: "Fragments", title: "2 · Text-line detection",
  body: () => `<p>Separately, <code>${esc(D.detector.det_model)}</code> detects text on the page
    downscaled to ${D.detector.ocr_max_dim}px, and the polygons are mapped back up to page
    coordinates. ${D.frags.length} fragments.</p>
    <p>These are <em>lines</em>, not sentences. For vertically-set Japanese one fragment is one
    column, so a four-line balloon arrives as four tall, narrow boxes with no idea that they
    belong together.</p>`,
  legend: () => [["#22d3ee", "PP-OCR det text line"]],
  draw: g => {
    D.bubbles.forEach(b => { if (b.mask_polygon)
      g.appendChild(el("polygon", { points: poly(b), fill: "none", stroke: "#ffffff",
        "stroke-width": 2, opacity: .18 })); });
    D.frags.forEach(f => {
      g.appendChild(box(f, { stroke: "#22d3ee", fill: "#22d3ee", op: 1, sw: 3 }));
      g.lastChild.setAttribute("fill-opacity", ".1");
      g.appendChild(tag(f.x, Math.max(22, f.y), String(f.i), "#22d3ee"));
    });
  },
  detail: () => `<h2>Fragments</h2><div class="list">` + D.frags.map(f =>
    `<div class="item"><span class="chip" style="background:#22d3ee">${f.i}</span>
     <span><span class="jp">${esc(f.text) || '<span class="muted">(empty)</span>'}</span><br>
     <span class="muted">${fmt([f.x, f.y, f.width, f.height])} · ${f.confidence.toFixed(3)}</span>
     </span></div>`).join("") + `</div>`
},
{
  key: "assign", nav: "Assignment", title: "3 · Fragment → balloon",
  body: () => `<p>Each fragment is rasterised against every balloon mask and awarded to the one it
    overlaps by the most <em>pixels</em> — not the nearest centre, and not the first hit. A
    fragment that overlaps no mask is assigned <code>-1</code>.</p>
    <p>${nUn === 0
      ? "Every fragment landed inside a balloon here."
      : `<b>${nUn}</b> of ${D.frags.length} fragments matched nothing. Those take a separate path:
         no mask, no clearance to measure, and a different gap budget
         (<code>${C().unmatched_threshold}</code> against
         <code>${C().in_threshold}</code> inside a balloon).`}</p>`,
  legend: () => D.bubbles.map((b, i) => [b.color, `B${i}`])
    .concat(nUn ? [[D.unmatched_color, "unmatched (−1)"]] : []),
  draw: g => {
    D.bubbles.forEach(b => { if (b.mask_polygon)
      g.appendChild(el("polygon", { points: poly(b), fill: b.color, "fill-opacity": .1,
        stroke: b.color, "stroke-width": 2, opacity: .8 })); });
    D.frags.forEach(f => {
      const c = fragColor(f);
      g.appendChild(box(f, { stroke: c, sw: 3, dash: f.bubble_idx < 0 ? "8 6" : "" }));
      g.appendChild(tag(f.x, Math.max(22, f.y),
        f.bubble_idx < 0 ? `${f.i}·–` : `${f.i}·B${f.bubble_idx}`, c));
    });
  },
  detail: () => {
    const groups = D.bubbles.map((b, i) => [`B${i}`, b.color,
      D.frags.filter(f => f.bubble_idx === i)]);
    if (nUn) groups.push(["−", D.unmatched_color, D.frags.filter(f => f.bubble_idx === -1)]);
    return `<h2>Claimed by</h2><div class="list">` + groups.map(([lbl, c, fs]) =>
      `<div class="item"><span class="chip" style="background:${c}">${lbl}</span>
       <span>${fs.length ? fs.map(f => f.i).join(", ")
         : '<span class="muted">no fragments — empty balloon</span>'}</span></div>`).join("")
      + `</div>`;
  }
},
{
  key: "group", nav: "Grouping", title: "4 · Fragments → groups",
  body: () => {
    const s = S().filter(s => s.members.length);
    const edges = s.reduce((n, x) => n + x.edges.length, 0);
    const vetoed = s.reduce((n, x) => n + x.edges.filter(e => e.vetoed).length, 0);
    return `<p>Within each balloon, two fragments are joined when they overlap on one axis and sit
      within the gap budget on the other. The budget is <code>${C().in_threshold}×</code>
      the estimated character size — and for vertical text the character size is a line's
      <em>width</em>, since a line is one column.</p>
      <p>Joining is transitive: ${edges} edge${edges === 1 ? "" : "s"} were drawn, and connected
      components turn them into ${R().length} groups. A single wrong edge chains two balloons
      into one region, which is why the edges are drawn here and not just the result.
      ${C().waist_gate === null
        ? "The clearance veto is off in this configuration."
        : `The clearance veto is on at <code>${C().waist_gate}</code> characters, and withheld
           <b>${vetoed}</b> edge${vetoed === 1 ? "" : "s"} that distance alone would have joined.`}</p>`;
  },
  legend: () => [["#ffffff", "adjacency edge"], ["#f85149", "vetoed edge"], ["#8b949e", "group envelope"]],
  draw: g => {
    S().forEach(s => s.groups.forEach(gr => {
      const [x, y, w, h] = gr.box;
      g.appendChild(el("rect", { x: x - 6, y: y - 6, width: w + 12, height: h + 12, fill: "#fff",
        "fill-opacity": .05, stroke: "#8b949e", "stroke-width": 2, "stroke-dasharray": "5 5", rx: 6 }));
    }));
    D.frags.forEach(f => g.appendChild(box(f, { stroke: fragColor(f), sw: 2, op: .75 })));
    S().forEach(s => s.edges.forEach(e => {
      const [x1, y1] = centre(D.frags[e.a]), [x2, y2] = centre(D.frags[e.b]);
      g.appendChild(el("line", { x1, y1, x2, y2, stroke: e.vetoed ? "#f85149" : "#ffffff",
        "stroke-width": 3, "stroke-dasharray": e.vetoed ? "7 5" : "",
        opacity: e.vetoed ? .95 : .8 }));
    }));
    D.frags.forEach(f => {
      const [cx, cy] = centre(f);
      g.appendChild(el("circle", { cx, cy, r: 6, fill: fragColor(f), stroke: "#0e1116",
        "stroke-width": 2 }));
    });
  },
  detail: () => `<h2>Merge calls</h2><div class="list">` + S().filter(s => s.members.length)
    .map(s => `<div class="item">
      <span class="chip" style="background:${s.path === "bubble" ? D.bubbles[s.bubble_idx].color
        : D.unmatched_color}">${s.path === "bubble" ? "B" + s.bubble_idx : "−"}</span>
      <span>${s.members.length} frags → <b>${s.groups.length}</b> group${
        s.groups.length === 1 ? "" : "s"}<br>
      <span class="muted">${s.vertical ? "vertical" : "horizontal"} · char
      ${s.char_size}px · thr ${s.threshold} · gap v${s.max_v_gap}/h${s.max_h_gap}</span><br>
      <span class="muted">${s.groups.map(g => "{" + g.members.join(",") + "}").join(" ")}</span>
      </span></div>`).join("") + `</div>`
},
{
  key: "regions", nav: "Regions", title: "5 · The regions",
  body: () => {
    const gold = D.gold.length;
    const order = D.detector.direction === "rtl" ? "rightmost column first" : "leftmost column first";
    const m = C().page_metrics;
    const sc = m && (m.transcribed || m.joined);
    return `<p>Each group collapses to one region: a union bounding box, and the fragment texts
      joined in reading order (${order}, no spacer for CJK). This is what the rest of the pipeline
      sees — what gets cropped, translated, and typeset back.</p>
      <p>${R().length} region${R().length === 1 ? "" : "s"}${
        gold ? `, against <b>${gold}</b> hand-checked in the corpus` : ""}. A count above the
      corpus figure means a balloon was split; below it, two balloons were merged.</p>
      ${m ? `<p class="muted">This run scored the page at char F1
        <b>${sc.f1.toFixed(3)}</b> (P ${sc.precision.toFixed(3)} / R ${sc.recall.toFixed(3)}),
        covering ${m.gold_covered}/${m.gold_regions} corpus regions at IoU ${D.run.iou_threshold}${
        m.mergers !== undefined ? `, with ${m.mergers} merger${m.mergers === 1 ? "" : "s"} and
        ${m.splits} split${m.splits === 1 ? "" : "s"}` : ""}.</p>` : ""}`;
  },
  legend: () => [["#2f81f7", "region"]].concat(D.gold.length ? [["#3fb950", "corpus ground truth"]] : []),
  draw: g => {
    D.gold.forEach(gd => {
      const [x, y, w, h] = gd.box;
      g.appendChild(el("rect", { x, y, width: w, height: h, fill: "none", stroke: "#3fb950",
        "stroke-width": 2, "stroke-dasharray": "10 8", opacity: .8 }));
    });
    R().forEach((r, i) => {
      const [x, y, w, h] = r.box;
      const c = r.empty ? "#8b949e" : "#2f81f7";
      g.appendChild(el("rect", { x, y, width: w, height: h, fill: c, "fill-opacity": r.empty ? .05 : .12,
        stroke: c, "stroke-width": 3, "stroke-dasharray": r.empty ? "8 6" : "", rx: 2 }));
      g.appendChild(tag(x, Math.max(22, y), String(i), c));
    });
  },
  detail: () => `<h2>Regions</h2><div class="list">` + R().map((r, i) =>
    `<div class="item"><span class="chip" style="background:${r.empty ? "#8b949e" : "#2f81f7"}">${i}</span>
     <span><span class="jp">${r.empty ? '<span class="muted">(empty balloon — no fragments)</span>'
       : esc(r.text) || '<span class="muted">(no text)</span>'}</span><br>
     <span class="muted">${r.path === "bubble" ? "B" + r.bubble_idx : "unmatched"}${
       r.members.length ? " · frags " + r.members.join(",") : ""} · ${fmt(r.box)}</span>
     ${r.transcribed !== null && r.transcribed !== undefined && r.transcribed !== r.text
       ? `<br><span class="muted">re-OCR of crop:</span>
          <span class="jp">${esc(r.transcribed) || "(nothing)"}</span>` : ""}
     </span></div>`).join("")
    + `</div>` + (D.gold.length ? `<h2 style="margin-top:14px">Corpus ground truth</h2>
      <div class="list">` + D.gold.map((gd, i) =>
      `<div class="item"><span class="chip" style="background:#3fb950">${i}</span>
       <span><span class="jp">${esc(gd.text)}</span><br>
       <span class="muted">${gd.tier} · ${fmt(gd.box)}</span></span></div>`).join("")
      + `</div>` : "")
}];

/* ---- driver ------------------------------------------------------------ */

let cur = 0;
const nav = document.getElementById("nav");
STAGES.forEach((s, i) => {
  const b = document.createElement("button");
  b.innerHTML = `<span class="n">${i}</span>${s.nav}`;
  b.onclick = () => show(i);
  nav.appendChild(b);
});

function show(i) {
  cur = Math.max(0, Math.min(STAGES.length - 1, i));
  const s = STAGES[cur];
  [...nav.children].forEach((b, k) => b.setAttribute("aria-current", String(k === cur)));
  document.getElementById("sttl").textContent = s.title;
  document.getElementById("sbody").innerHTML = s.body();
  document.getElementById("detail").innerHTML = s.detail();
  document.getElementById("leg").innerHTML = s.legend()
    .map(([c, t]) => `<span><i style="background:${c}"></i>${esc(t)}</span>`).join("");
  const g = el("g");
  s.draw(g);
  ov.replaceChildren(g);
}

addEventListener("keydown", e => {
  if (e.key === "ArrowRight") show(cur + 1);
  else if (e.key === "ArrowLeft") show(cur - 1);
});
header();
paintCfgs();
show(0);
</script></body></html>
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sample", default="sample30")
    ap.add_argument("--all", action="store_true",
                    help="every sample in the corpus, in one process, plus an index page")
    ap.add_argument("--corpus", default=probe.DEFAULT_CORPUS)
    ap.add_argument("--out", default=os.path.join(probe.DEFAULT_CORPUS, "_walkthrough"))
    ap.add_argument("--run", default=None,
                    help="a corpus/runs/<date>/region-grouping directory (default: the newest)")
    ap.add_argument("--no-run", action="store_true",
                    help="ignore recorded runs and show the production configuration alone")
    ap.add_argument("--config", default=None,
                    help="which of the run's configurations the page opens on (default: production)")
    ap.add_argument("--in-threshold", type=float, default=None,
                    help="override, as a 'custom' configuration (production: 2.0)")
    ap.add_argument("--unmatched-threshold", type=float, default=None,
                    help="override, as a 'custom' configuration (production: 1.0)")
    ap.add_argument("--direction", default="rtl", choices=("rtl", "ltr"))
    ap.add_argument("--orientation", default=None, choices=("reading_direction", "vote"),
                    help="override, as a 'custom' configuration")
    ap.add_argument("--waist-gate", type=float, default=None,
                    help="override: clearance veto, in characters (in-bubble path only)")
    ap.add_argument("--waist-max-solidity", type=float, default=0.90)
    ap.add_argument("--cache-dir", default=None)
    ap.add_argument("--no-cache", action="store_true",
                    help="re-run YOLO + PaddleOCR instead of reading the probe cache")
    args = ap.parse_args()

    if args.all:
        samples = sorted((s for s in os.listdir(args.corpus)
                          if os.path.exists(os.path.join(args.corpus, s, "page.webp"))),
                         key=lambda s: (len(s), s))
    else:
        samples = [args.sample]

    # One reader cache across every page: the models load once, not forty times.
    reader_cache: dict = {}
    rows, differs, run_meta = [], 0, None
    for sample in samples:
        path, payload = build(args, sample, reader_cache)
        n_un = sum(1 for f in payload["frags"] if f["bubble_idx"] == -1)
        run = payload["run"]
        ok = all(c["verified"]["status"] != "differs" for c in payload["configs"])
        differs += 0 if ok else 1
        gold = len(payload["gold"])
        run_meta = payload["run"]
        rows.append({
            "sample": sample, "gold": gold, "verified": ok,
            "configs": [c["name"] for c in payload["configs"]],
            "counts": {c["name"]: len(c["regions"]) for c in payload["configs"]},
            "errs": {c["name"]: (len(c["regions"]) - gold) if gold else None
                     for c in payload["configs"]},
        })

        if len(samples) == 1:
            print(f"{sample}: {len(payload['bubbles'])} bubbles, {len(payload['frags'])} fragments "
                  f"({n_un} unmatched)" + (f", corpus has {gold} regions" if gold else ""))
            print(f"  run: {run['dir']} ({run['generated']})" if run
                  else "  run: none — production only")
            for c in payload["configs"]:
                v = c["verified"]
                mark = {"match": "= run", "differs": "DIFFERS: " + v.get("detail", ""),
                        "unscored": "not in run"}[v["status"]]
                star = " *" if c["name"] == payload["active"] else "  "
                print(f" {star}{c['name']:<11} in={c['in_threshold']:<5} "
                      f"un={c['unmatched_threshold']:<5} waist={c['waist_gate']!s:<5} "
                      f"{c['orientation']:<18} {len(c['regions']):3d} regions  {mark}")
            print(f"wrote {path}")
        else:
            counts = " ".join(f"{n}={len(c['regions'])}"
                              for n, c in zip(rows[-1]["configs"], payload["configs"]))
            print(f"  {sample:<10} gold={gold or '-':<3} {counts}" + ("" if ok else "   DIFFERS"))

    if len(samples) > 1:
        index = write_index(args.out, rows, run_meta)
        print(f"\n{len(samples)} pages -> {args.out}")
        print(f"verification: {len(samples) - differs}/{len(samples)} reproduce the run exactly")
        print(f"index: {index}")


if __name__ == "__main__":
    main()
