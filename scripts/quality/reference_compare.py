#!/usr/bin/env python3
"""R4 — compare one run's pages against source, Torii and the August baseline, in numbers.

Tracker: docs/output-quality-implementation-tracker.md, "2026-09-17 realignment", task R4.

For every page it reports, side by side for ours and for Torii:

  regions / boxes      how many text units each side found. Torii's per-box metadata.json is the
                       machine reference (270 bundles, 2,880 boxes); it is a baseline, not truth.
  largest region %     the biggest single region's bbox as a share of the page. A dialogue balloon
                       is a few percent; 57 % is the whole page being wiped (sample83, 2026-09-17).
  matched / IoU        greedy bbox matching between our regions and Torii's boxes at IoU >= 0.3.
  regions (distinct)   region rows versus distinct bboxes. sample61 had 214 rows for 63 boxes: the
                       OCR stage inserted the same regions up to five times.
  elements per region  visible translation elements divided by region rows. 1.0 is right.
  altered / flattened  scripts/render_quality_metrics.py, unchanged: flattened is the share of page
                       pixels that carried detail in the source and carry none in the output. A flat
                       fill over art lands here; typeset glyphs do not. >5 % fails, >3 % regresses.
  vs inpainted         mean absolute gray difference between our output and Torii's inpainted.png,
                       measured inside our region bboxes only. Text pixels differ on both sides, so
                       this is a proxy for "did we keep the art under the text"; Torii's own
                       translated.png is scored the same way as the reference point.
  refusal              a translation that is a model refusal rather than a translation.
  outside altered      share of page pixels *outside* the union of our region bboxes that changed
                       by more than render_quality_metrics' CHANGE_THRESHOLD. Tracker R2 gate:
                       "pixels outside the union of region bboxes identical to source", so this
                       should be ~0; a plate padded past its bbox, or a widened free-text box
                       filled flat, shows up here and nowhere else.
  cost                 from the run manifest (provider_calls) or project.json totalCost.

Inputs. A run directory laid out like docs/quality-runs/<run>/a04-exports/<sample>/ with
page-snapshot.json and export.png (what the capture harness writes), or --baseline with sample ids,
which reads corpus/samples/<lang>/<sample>/project/project.json plus export.png and render.png.
Torii material comes from corpus/samples/<lang>/<sample>/torii/ and ref-torii*.png.

Nothing here calls a provider or touches the stack. Run with the repo-root .venv (needs cv2):

    .venv/bin/python scripts/quality/reference_compare.py --run docs/quality-runs/g5-20260917-final-six
    .venv/bin/python scripts/quality/reference_compare.py --baseline sample177 sample222 sample61 \
        sample99 sample93 sample83 --label august-baseline

Output: <out>/reference-compare.json and reference-compare.md. Default <out> is the run directory
(additive; historical files are never overwritten) or docs/quality-runs/r4-<label>/ for a baseline.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import cv2
import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
from render_quality_metrics import CHANGE_THRESHOLD  # noqa: E402
from render_quality_metrics import score as pixel_score  # noqa: E402

CORPUS = REPO / "corpus" / "samples"
# Pages that have not been promoted yet live under corpus/gaps/pending/<lang>/<sample>.
CORPUS_PENDING = REPO / "corpus" / "gaps" / "pending"
IOU_MATCH = 0.3
WIPE_REGION_PCT = 25.0  # tracker R2 gate: no patch larger than a quarter of the page
FLATTENED_FAIL = 5.0  # render_quality_metrics thresholds, measured 2026-08-05
FLATTENED_REGRESS = 3.0
DUP_RATIO = 1.5
# Tracker R2 gate: pixels outside the union of region bboxes identical to source. JPEG re-encode and
# anti-aliasing of the halo at a bbox edge account for a fraction of a percent; anything more is a
# plate or a box painted past its region.
OUTSIDE_ALTERED_MAX = 0.5
REFUSAL = re.compile(
    r"^\s*\[?\s*(explicit|exploitative|sexual content|i can(?:'|no)?t|i cannot|i am unable|unable to|"
    r"sorry,|as an ai|content (?:involving|policy))|redacted",
    re.IGNORECASE,
)


@dataclass
class Box:
    x: float
    y: float
    w: float
    h: float
    text: str = ""
    font_px: float | None = None

    @property
    def area(self) -> float:
        return max(self.w, 0.0) * max(self.h, 0.0)

    def iou(self, other: "Box") -> float:
        ix = max(0.0, min(self.x + self.w, other.x + other.w) - max(self.x, other.x))
        iy = max(0.0, min(self.y + self.h, other.y + other.h) - max(self.y, other.y))
        inter = ix * iy
        union = self.area + other.area - inter
        return inter / union if union > 0 else 0.0


@dataclass
class PageReport:
    sample: str
    lang: str
    page_w: int
    page_h: int
    regions_ours: int
    regions_distinct: int
    boxes_torii: int
    largest_region_pct: float
    regions_over_25pct: int
    matched: int
    mean_iou: float | None
    ours_unmatched: int
    torii_unmatched: int
    elements_translation: int
    elements_per_region: float | None
    hidden_translation_layers: int
    refusals: int
    outside_altered_pct: float | None
    torii_font_px_median: float | None
    ours_font_px_median: float | None
    pixels: dict[str, dict[str, float]] = field(default_factory=dict)
    vs_inpainted: dict[str, float] = field(default_factory=dict)
    cost: dict[str, Any] = field(default_factory=dict)
    flags: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


# ---------------------------------------------------------------- corpus lookups


def find_sample_dir(sample: str) -> Path:
    hits = [p for root in (CORPUS, CORPUS_PENDING) for p in root.glob(f"*/{sample}") if p.is_dir()]
    if len(hits) != 1:
        raise FileNotFoundError(f"{sample}: expected one corpus directory, found {hits}")
    return hits[0]


def source_image(sample_dir: Path) -> Path:
    hits = sorted(sample_dir.glob("source.*"))
    if not hits:
        raise FileNotFoundError(f"{sample_dir}: no source.* image")
    return hits[0]


def torii_boxes(sample_dir: Path) -> list[Box]:
    """Torii v1 metadata: x/y are box centres, width/height full extents, font like '72px WildWords'."""
    meta = sample_dir / "torii" / "metadata.json"
    if not meta.exists():
        return []
    data = json.loads(meta.read_text())
    boxes = []
    for item in data.get("text", []):
        font = item.get("font") or ""
        m = re.match(r"\s*([\d.]+)px", font)
        boxes.append(
            Box(
                x=float(item["x"]) - float(item["width"]) / 2,
                y=float(item["y"]) - float(item["height"]) / 2,
                w=float(item["width"]),
                h=float(item["height"]),
                text=item.get("text") or "",
                font_px=float(m.group(1)) if m else None,
            )
        )
    return boxes


# ---------------------------------------------------------------- our pages


def regions_from_snapshot(snapshot: dict[str, Any]) -> list[Box]:
    return [
        Box(float(r["bboxX"]), float(r["bboxY"]), float(r["bboxW"]), float(r["bboxH"]), r.get("text") or "")
        for r in snapshot.get("ocrRegions", [])
        if r.get("bboxW") and r.get("bboxH")
    ]


def regions_from_project(project: dict[str, Any]) -> list[Box]:
    """August-format project.json has no ocrRegions; the OCR layer's elements carry one box per region."""
    seen: dict[str, Box] = {}
    for layer in project.get("layers", []):
        if (layer.get("type") or layer.get("layerType")) != "ocr":
            continue
        for e in layer.get("elements", []):
            key = e.get("regionId") or e.get("id")
            if key in seen or not e.get("maxWidth") or not e.get("maxHeight"):
                continue
            seen[key] = Box(float(e["x"]), float(e["y"]), float(e["maxWidth"]), float(e["maxHeight"]), e.get("text") or "")
    return list(seen.values())


def translation_layers(container: dict[str, Any], snapshot_style: bool) -> list[tuple[bool, list[dict[str, Any]]]]:
    out = []
    for layer in container.get("layers", []):
        meta = layer.get("layer", layer) if snapshot_style else layer
        if (meta.get("type") or meta.get("layerType")) != "translation":
            continue
        out.append((bool(meta.get("visible", True)), layer.get("elements", [])))
    return out


def greedy_match(ours: list[Box], theirs: list[Box]) -> tuple[int, float | None]:
    pairs = sorted(
        ((a.iou(b), i, j) for i, a in enumerate(ours) for j, b in enumerate(theirs)),
        reverse=True,
    )
    used_i: set[int] = set()
    used_j: set[int] = set()
    ious = []
    for iou, i, j in pairs:
        if iou < IOU_MATCH:
            break
        if i in used_i or j in used_j:
            continue
        used_i.add(i)
        used_j.add(j)
        ious.append(iou)
    return len(ious), (statistics.fmean(ious) if ious else None)


# ---------------------------------------------------------------- pixels


def load_gray(path: Path, size: tuple[int, int] | None = None) -> np.ndarray:
    img = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError(f"could not decode {path}")
    if size and (img.shape[1], img.shape[0]) != size:
        img = cv2.resize(img, size, interpolation=cv2.INTER_AREA)
    return img


def region_diff(a: np.ndarray, b: np.ndarray, regions: list[Box]) -> float | None:
    """Mean |a-b| over the union of region bboxes. None when there are no regions."""
    mask = np.zeros(a.shape, dtype=bool)
    for r in regions:
        x0, y0 = max(int(r.x), 0), max(int(r.y), 0)
        x1, y1 = min(int(r.x + r.w), a.shape[1]), min(int(r.y + r.h), a.shape[0])
        if x1 > x0 and y1 > y0:
            mask[y0:y1, x0:x1] = True
    if not mask.any():
        return None
    return float(np.abs(a.astype(np.int16) - b.astype(np.int16))[mask].mean())


def outside_altered(a: np.ndarray, b: np.ndarray, regions: list[Box]) -> float | None:
    """Share (%) of pixels outside the union of region bboxes where |a-b| > CHANGE_THRESHOLD."""
    mask = np.ones(a.shape, dtype=bool)
    for r in regions:
        x0, y0 = max(int(r.x), 0), max(int(r.y), 0)
        x1, y1 = min(int(r.x + r.w), a.shape[1]), min(int(r.y + r.h), a.shape[0])
        if x1 > x0 and y1 > y0:
            mask[y0:y1, x0:x1] = False
    if not mask.any():
        return None
    diff = np.abs(a.astype(np.int16) - b.astype(np.int16))
    return float((diff[mask] > CHANGE_THRESHOLD).mean() * 100)


def safe_pixels(original: Path, render: Path, notes: list[str], label: str) -> dict[str, float] | None:
    try:
        return pixel_score(original, render)
    except Exception as err:  # size mismatch, undecodable — record, do not hide
        notes.append(f"{label}: pixel score skipped ({err})")
        return None


# ---------------------------------------------------------------- one page


def report_page(
    sample: str,
    regions: list[Box],
    layers: list[tuple[bool, list[dict[str, Any]]]],
    outputs: dict[str, Path],
    cost: dict[str, Any],
    page_size: tuple[int, int] | None,
) -> PageReport:
    sample_dir = find_sample_dir(sample)
    lang = sample_dir.parent.name
    src = source_image(sample_dir)
    notes: list[str] = []

    src_gray = load_gray(src)
    H, W = src_gray.shape
    if page_size and page_size != (W, H):
        notes.append(f"page dimensions {page_size} differ from source {W}x{H}; source wins")
    page_area = float(W * H)

    torii = torii_boxes(sample_dir)
    distinct = len({(round(r.x), round(r.y), round(r.w), round(r.h)) for r in regions})
    largest = max((r.area for r in regions), default=0.0) / page_area * 100
    over = sum(1 for r in regions if r.area / page_area * 100 > WIPE_REGION_PCT)
    matched, mean_iou = greedy_match(regions, torii)

    visible_elements: list[dict[str, Any]] = []
    hidden_layers = 0
    for visible, elements in layers:
        if visible:
            visible_elements.extend(elements)
        else:
            hidden_layers += 1
    refusals = sum(1 for e in visible_elements if REFUSAL.search(e.get("text") or ""))
    sizes = [float(e["size"]) for e in visible_elements if e.get("size")]

    pixels: dict[str, dict[str, float]] = {}
    for label, path in outputs.items():
        if path.exists():
            got = safe_pixels(src, path, notes, label)
            if got:
                pixels[label] = got
        else:
            notes.append(f"{label}: {path.name} missing")
    for ref in sorted(sample_dir.glob("ref-torii*.png")):
        got = safe_pixels(src, ref, notes, ref.stem)
        if got:
            pixels[ref.stem] = got

    outside: float | None = None
    primary_path = outputs.get("export") if outputs.get("export", Path("/nonexistent")).exists() else outputs.get("render")
    if primary_path is not None and primary_path.exists():
        try:
            outside = outside_altered(src_gray, load_gray(primary_path, (W, H)), regions)
        except Exception as err:
            notes.append(f"outside-altered skipped ({err})")

    vs_inpainted: dict[str, float] = {}
    inpainted = sample_dir / "torii" / "inpainted.png"
    if inpainted.exists() and regions:
        inp = load_gray(inpainted, (W, H))
        for label, path in list(outputs.items()) + [(p.stem, p) for p in sorted(sample_dir.glob("ref-torii*.png"))]:
            if path.exists():
                d = region_diff(load_gray(path, (W, H)), inp, regions)
                if d is not None:
                    vs_inpainted[label] = round(d, 2)
    elif not inpainted.exists():
        notes.append("no torii/inpainted.png")

    flags = []
    primary = pixels.get("export") or pixels.get("render")
    if largest > WIPE_REGION_PCT or over:
        flags.append("WIPE-REGION")
    if primary and primary["flattened"] > FLATTENED_FAIL:
        flags.append("WIPE-PIXELS")
    elif primary and primary["flattened"] > FLATTENED_REGRESS:
        flags.append("FLATTEN-REGRESS")
    ratio = (len(visible_elements) / len(regions)) if regions else None
    if ratio and ratio > DUP_RATIO:
        flags.append("DUP-ELEMENTS")
    if regions and len(regions) / distinct > DUP_RATIO:
        flags.append("DUP-REGIONS")
    if hidden_layers:
        flags.append("HIDDEN-LAYERS")
    if refusals:
        flags.append("REFUSAL")
    if outside is not None and outside > OUTSIDE_ALTERED_MAX:
        flags.append("OUTSIDE-BBOX")
    if torii and regions and (distinct < 0.7 * len(torii) or distinct > 1.3 * len(torii)):
        flags.append("REGION-COUNT")

    return PageReport(
        sample=sample,
        lang=lang,
        page_w=W,
        page_h=H,
        regions_ours=len(regions),
        regions_distinct=distinct,
        boxes_torii=len(torii),
        largest_region_pct=round(largest, 1),
        regions_over_25pct=over,
        matched=matched,
        mean_iou=round(mean_iou, 2) if mean_iou is not None else None,
        ours_unmatched=len(regions) - matched,
        torii_unmatched=len(torii) - matched,
        elements_translation=len(visible_elements),
        elements_per_region=round(ratio, 2) if ratio is not None else None,
        hidden_translation_layers=hidden_layers,
        refusals=refusals,
        outside_altered_pct=round(outside, 2) if outside is not None else None,
        torii_font_px_median=statistics.median([b.font_px for b in torii if b.font_px]) if any(b.font_px for b in torii) else None,
        ours_font_px_median=statistics.median(sizes) if sizes else None,
        pixels={k: {m: round(v, 2) for m, v in d.items()} for k, d in pixels.items()},
        vs_inpainted=vs_inpainted,
        cost=cost,
        flags=flags,
        notes=notes,
    )


# ---------------------------------------------------------------- inputs


def pages_from_run(run: Path) -> list[PageReport]:
    manifest_costs: dict[str, dict[str, Any]] = {}
    manifest = run / "manifest.json"
    if manifest.exists():
        for p in json.loads(manifest.read_text()).get("pages", []):
            manifest_costs[p["sample"]] = (p.get("pipeline") or {}).get("provider_calls") or {}
    reports = []
    for page_dir in sorted((run / "a04-exports").iterdir()):
        snap_path = page_dir / "page-snapshot.json"
        if not snap_path.exists():
            continue
        snap = json.loads(snap_path.read_text())
        img = snap.get("image") or {}
        size = (img["width"], img["height"]) if img.get("width") and img.get("height") else None
        reports.append(
            report_page(
                page_dir.name,
                regions_from_snapshot(snap),
                translation_layers(snap, snapshot_style=True),
                {"export": page_dir / "export.png"},
                manifest_costs.get(page_dir.name, {}),
                size,
            )
        )
    return reports


def pages_from_baseline(samples: list[str]) -> list[PageReport]:
    reports = []
    for sample in samples:
        sample_dir = find_sample_dir(sample)
        project = json.loads((sample_dir / "project" / "project.json").read_text())
        dims = project.get("dimensions") or {}
        size = (dims["width"], dims["height"]) if dims.get("width") and dims.get("height") else None
        reports.append(
            report_page(
                sample,
                regions_from_project(project),
                translation_layers(project, snapshot_style=False),
                {"export": sample_dir / "export.png", "render": sample_dir / "render.png"},
                {"total_cost_usd": project.get("totalCost")},
                size,
            )
        )
    return reports


# ---------------------------------------------------------------- output


def fmt(v: Any) -> str:
    if v is None:
        return "–"
    if isinstance(v, float):
        return f"{v:.2f}" if abs(v) < 10 else f"{v:.1f}"
    return str(v)


def markdown(label: str, reports: list[PageReport]) -> str:
    lines = [
        f"# Reference comparison — {label}",
        "",
        "Generated by `scripts/quality/reference_compare.py` (tracker R4). Torii is the machine baseline, not truth; "
        "human references win. `flattened` is from `scripts/render_quality_metrics.py` (>5 % fails, >3 % regresses). "
        "`vs inpainted` is the mean gray difference to Torii's `inpainted.png` inside our region bboxes; "
        "Torii's own translated page is scored the same way as the reference point.",
        "",
        "| page | regions ours (distinct) / torii | largest region % | matched (IoU) | elements / region | hidden layers | refusals | altered % ours / torii | flattened % ours / torii | outside bbox % | vs inpainted ours / torii | font px ours / torii | cost | flags |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in reports:
        ours = r.pixels.get("export") or r.pixels.get("render") or {}
        torii = r.pixels.get("ref-torii") or {}
        cost = r.cost.get("estimated_cost_usd", r.cost.get("total_cost_usd"))
        tokens = r.cost.get("prompt_tokens")
        cost_s = (f"${cost:.3f}" if isinstance(cost, (int, float)) else "–") + (f" / {tokens:,} tok" if tokens else "")
        lines.append(
            "| "
            + " | ".join(
                [
                    f"{r.sample} ({r.lang}, {r.page_w}×{r.page_h})",
                    f"{r.regions_ours} ({r.regions_distinct}) / {r.boxes_torii}",
                    f"{fmt(r.largest_region_pct)} ({r.regions_over_25pct} > 25 %)",
                    f"{r.matched} ({fmt(r.mean_iou)})",
                    f"{r.elements_translation} ({fmt(r.elements_per_region)})",
                    str(r.hidden_translation_layers),
                    str(r.refusals),
                    f"{fmt(ours.get('altered'))} / {fmt(torii.get('altered'))}",
                    f"{fmt(ours.get('flattened'))} / {fmt(torii.get('flattened'))}",
                    fmt(r.outside_altered_pct),
                    f"{fmt(r.vs_inpainted.get('export', r.vs_inpainted.get('render')))} / {fmt(r.vs_inpainted.get('ref-torii'))}",
                    f"{fmt(r.ours_font_px_median)} / {fmt(r.torii_font_px_median)}",
                    cost_s,
                    ", ".join(r.flags) or "ok",
                ]
            )
            + " |"
        )
    extra = [r for r in reports if r.notes or len(r.pixels) > 2 or "render" in r.pixels]
    if extra:
        lines += ["", "## Notes and extra references", ""]
        for r in extra:
            for k, v in r.pixels.items():
                if k not in ("export", "ref-torii"):
                    lines.append(f"- {r.sample} `{k}`: altered {fmt(v['altered'])} %, flattened {fmt(v['flattened'])} %"
                                 + (f", vs inpainted {fmt(r.vs_inpainted.get(k))}" if k in r.vs_inpainted else ""))
            for n in r.notes:
                lines.append(f"- {r.sample}: {n}")
    failing = [r.sample for r in reports if any(f.startswith("WIPE") for f in r.flags)]
    lines += ["", f"**{len(failing)}/{len(reports)} pages flagged as wipes:** {', '.join(failing) or 'none'}.", ""]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--run", type=Path, help="docs/quality-runs/<run> with a04-exports/<sample>/page-snapshot.json")
    src.add_argument("--baseline", nargs="+", metavar="SAMPLE", help="corpus sample ids; reads project/ + export.png + render.png")
    ap.add_argument("--label", help="name for the report (default: run directory name or 'baseline')")
    ap.add_argument("--out", type=Path, help="output directory (default: the run dir, or docs/quality-runs/r4-<label>)")
    args = ap.parse_args()

    if args.run:
        label = args.label or args.run.name
        reports = pages_from_run(args.run)
        out = args.out or args.run
    else:
        label = args.label or "baseline"
        reports = pages_from_baseline(args.baseline)
        out = args.out or (REPO / "docs" / "quality-runs" / f"r4-{label}")
    if not reports:
        print("no pages found", file=sys.stderr)
        return 2
    out.mkdir(parents=True, exist_ok=True)
    (out / "reference-compare.json").write_text(json.dumps({"label": label, "pages": [asdict(r) for r in reports]}, indent=2, ensure_ascii=False) + "\n")
    md = markdown(label, reports)
    (out / "reference-compare.md").write_text(md)
    print(md)
    print(f"\nwrote {out / 'reference-compare.md'}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
