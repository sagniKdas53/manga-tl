#!/usr/bin/env python3
"""
build_ocr_corpus.py — Build a committable, ground-truthed OCR benchmark corpus from
corpus/samples/sampleN/ pages.

This corpus keeps a downscaled WebP of each page, so benchmark_vlm_ocr.py has a stable input that
survives the examples/ history purge. ~40 pages at long-edge 1600 / WebP q80 is roughly 8-14 MB.

None of it lives in this repo. All three corpora and the run output are versioned in the
**manga-tl-corpus** submodule, mounted at `corpus/` — separately, because they are derived from
examples/ (gitignored and purged here) and so have no source this repo can track, while still
being worth diffing to catch ground-truth regressions. See corpus/README.md.

Output layout:

    corpus/ocr/
      _manifest.json
      sampleN/
        page.webp       long edge 1600 (matches the pipeline's downscale_for_ocr max_dim)
        regions.json    [{id, bbox, polygon, type, text, lang, direction, tier, candidates}]
        meta.json       per-tier counts, engines used, provenance
      _review/sampleN.html   self-contained gold-review page (only for --gold samples)

Ground truth is built in two tiers, because the maintainer does not read Japanese:

  * consensus — every region transcribed by local PaddleOCR plus 2-3 cloud vision models from
    config/providers.json models.ocr. The medoid candidate (the one minimising total CER to the
    others) wins when at least --min-agree engines land within --tol CER of it. Regions that
    fail that bar are tier "unresolved" and are excluded from scoring by
    benchmark_vlm_ocr.py's score_page(), so they never silently become noise targets.
  * gold — for the samples passed to --gold, `_review/sampleN.html` renders each region's crop
    next to every engine's candidate with the consensus pre-selected, so review is
    choose-and-correct rather than transcribe-from-scratch. Feed the edited JSON back with
    --apply-review to promote those regions to tier "gold".

Usage:
    # One sample end to end (region proposal + PaddleOCR + cloud VLMs)
    python scripts/build_ocr_corpus.py --sample sample36 --provider openrouter

    # Local PaddleOCR only, no API calls (fast; every region will be "unresolved")
    python scripts/build_ocr_corpus.py --sample sample36 --local-only

    # Emit the gold review page for the chosen samples
    python scripts/build_ocr_corpus.py --gold sample36 --review-only

    # Fold reviewed text back in
    python scripts/build_ocr_corpus.py --apply-review corpus/ocr/_review/sample36.json
"""

import os
import re
import sys
import json
import html
import base64
import argparse

import cv2
import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
sys.path.insert(0, SCRIPT_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "worker", "src"))

os.environ.setdefault("PADDLEX_OFFLINE_MODE", "1")
os.environ.setdefault("PADDLE_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "0")

from provider_config import (  # noqa: E402
    load_env,
    load_providers_config,
    list_candidate_models,
)
from bench_common import cer, normalize_text  # noqa: E402

load_env(os.path.join(REPO_ROOT, ".env"))

DEFAULT_EXAMPLES = os.path.join(REPO_ROOT, "corpus", "samples")
DEFAULT_OUT = os.path.join(REPO_ROOT, "corpus", "ocr")
DEFAULT_PROVIDERS_CONFIG = os.path.join(REPO_ROOT, "config", "providers.json")

MAX_DIM = 1600
WEBP_QUALITY = 80

# Prompt language name per meta.json source lang, for the VLM OCR prompt.
LANG_NAME = {"ja": "Japanese", "zh": "Chinese", "ko": "Korean", "en": "English"}


# ---------------------------------------------------------------------------
# Page preparation
# ---------------------------------------------------------------------------

def load_sample_meta(sample_dir):
    meta_path = os.path.join(sample_dir, "meta.json")
    if not os.path.exists(meta_path):
        return None
    with open(meta_path, "r", encoding="utf-8") as f:
        return json.load(f)


def imread_unicode(path):
    return cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)


def downscale(img, max_dim=MAX_DIM):
    h, w = img.shape[:2]
    largest = max(h, w)
    if largest <= max_dim:
        return img
    scale = max_dim / largest
    return cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)


# ---------------------------------------------------------------------------
# Transcription engines
# ---------------------------------------------------------------------------

# Local PaddleOCR variants usable as consensus engines. Both PP-OCR generations are already
# present in the project's model cache, and running more than one is the cheapest way to get a
# workable engine pool: with only two *free* cloud vision models available, a paddle-plus-two-VLM
# pool makes the default --min-agree 3 equivalent to unanimity. Adding v5 alongside v6 gives four
# independent engines, so a single disagreeing engine no longer sinks the region.
PADDLE_VARIANTS = {
    "paddleocr_v6_medium": ("PP-OCRv6_medium_det", "PP-OCRv6_medium_rec"),
    "paddleocr_v6_small": ("PP-OCRv6_small_det", "PP-OCRv6_small_rec"),
    "paddleocr_v5_server": ("PP-OCRv5_server_det", "PP-OCRv5_server_rec"),
    "paddleocr_v5_mobile": ("PP-OCRv5_mobile_det", "PP-OCRv5_mobile_rec"),
}
DEFAULT_PADDLE_VARIANTS = ["paddleocr_v6_medium", "paddleocr_v5_server"]


def paddle_transcribe_regions(img, regions, lang, variant):
    """Per-region PaddleOCR transcription with one explicit model pair, so it is directly
    comparable with the VLM crops and so each variant votes independently."""
    from build_translation_corpus import parse_paddle_ocr_results, SOURCE_LANG_TO_PADDLE
    from benchmark_local_ocr import init_paddleocr

    paddle_lang = SOURCE_LANG_TO_PADDLE.get(lang, "japan")
    det_model, rec_model = PADDLE_VARIANTS[variant]
    reader = init_paddleocr(paddle_lang, det_model, rec_model)
    if reader is None:
        print(f"    [warn] could not initialise {variant}; skipping this engine")
        return None

    # Same padded crop the cloud VLMs get (crop_for_region, pad=10). These engines used to be
    # fed the raw bbox while the VLMs got the padded one, so the two families were transcribing
    # different images — any box that clipped a glyph penalised paddle alone, and their
    # "disagreement" partly measured the crop rather than the engine.
    from benchmark_vlm_ocr import crop_for_region

    out = {}
    for r in regions:
        crop, _ = crop_for_region(img, r["bbox"])
        if crop.size == 0:
            out[r["id"]] = ""
            continue
        try:
            parsed = parse_paddle_ocr_results(reader.predict(crop))
        except Exception as e:  # noqa: BLE001
            print(f"    [warn] {variant} failed on {r['id']}: {e}")
            out[r["id"]] = ""
            continue
        out[r["id"]] = "".join(text for _bbox, text, _conf in parsed).strip()
    return out


def vlm_transcribe_regions(img, regions, provider_name, provider_cfg, model_id, lang_name, sleep=0.0):
    from benchmark_vlm_ocr import call_vlm_ocr, crop_for_region
    import time as _time

    out, meta = {}, {}
    for r in regions:
        crop, _ = crop_for_region(img, r["bbox"])
        if crop.size == 0:
            out[r["id"]] = ""
            continue
        res = call_vlm_ocr(crop, provider_name, provider_cfg, model_id, lang_name)
        if "error" in res:
            print(f"    [warn] {model_id} failed on {r['id']}: {res['error'][:120]}")
            out[r["id"]] = ""
        else:
            payload = res["result"]
            out[r["id"]] = (payload.get("text") or "").strip()
            meta[r["id"]] = {"language": payload.get("language", ""),
                             "writing_direction": payload.get("writing_direction", "")}
        if sleep:
            _time.sleep(sleep)
    return out, meta


# ---------------------------------------------------------------------------
# Consensus
# ---------------------------------------------------------------------------

def pick_consensus(candidates, min_agree=3, tol=0.10):
    """Medoid vote over {engine: text}.

    Returns (text, tier, agreement_count). The medoid — the candidate with the most peers within
    `tol` CER, tie-broken by lowest total distance — is more robust than exact-match voting,
    which would reject a unanimous reading over a single full-width/half-width difference.
    """
    items = [(engine, text) for engine, text in candidates.items() if normalize_text(text)]
    if not items:
        return "", "unresolved", 0
    if len(items) == 1:
        return items[0][1], "unresolved", 1

    best = ((0, 0.0), 0, 0)
    for i, (_engine_i, text_i) in enumerate(items):
        agree, distance = 0, 0.0
        for j, (_engine_j, text_j) in enumerate(items):
            if i == j:
                continue
            d = cer(text_j, text_i)
            if d is None:
                continue
            distance += d
            if d <= tol:
                agree += 1
        score = (-agree, distance)
        if i == 0 or score < best[0]:
            best = (score, i, agree)

    _score, idx, agree = best
    total_agree = agree + 1
    tier = "consensus" if total_agree >= min_agree else "unresolved"
    return items[idx][1], tier, total_agree


# ---------------------------------------------------------------------------
# Gold review page
# ---------------------------------------------------------------------------

REVIEW_CSS = """
:root{color-scheme:light dark}
body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px;max-width:1100px}
h1{font-size:20px;margin:0 0 4px}
p.lead{margin:0 0 24px;opacity:.75}
.region{display:grid;grid-template-columns:320px 1fr;gap:20px;padding:20px 0;border-top:1px solid #8883}
.crop{max-width:100%;border:1px solid #8886;border-radius:6px;background:#fff}
.cand{display:flex;gap:8px;align-items:baseline;margin:3px 0}
.cand b{flex:0 0 150px;font-weight:600;opacity:.7;font-size:12px}
.cand code{font-size:15px;word-break:break-all}
.pick{cursor:pointer;background:#8882;border:0;border-radius:4px;padding:1px 7px;font-size:11px}
.cand.sel{background:#2563eb26;border-radius:6px;padding:2px 4px;margin:1px -4px}
.cand.sel code{font-weight:600}
.cand.sel .pick{background:#2563eb;color:#fff}
.cand.rejected code{opacity:.35;text-decoration:line-through}
.acts{display:flex;gap:8px;margin:10px 0 6px}
.act{cursor:pointer;background:transparent;border:1px solid #8886;border-radius:4px;
  padding:2px 9px;font-size:11px;color:inherit;opacity:.8}
.act:hover{opacity:1;border-color:#888c}
textarea{width:100%;font-size:16px;padding:8px;box-sizing:border-box;min-height:56px;
  border-radius:6px;border:1px solid #8886;background:transparent;color:inherit}
.tier{font-size:11px;padding:2px 8px;border-radius:99px;margin-left:8px}
.consensus,.resolved{background:#2a7a2a33;color:#2a7a2a}
.unresolved{background:#a8341433;color:#c2410c}
.gold{background:#b4880033;color:#a16207}
#save{position:sticky;bottom:20px;padding:12px 20px;font-size:15px;border-radius:8px;
  border:0;background:#2563eb;color:#fff;cursor:pointer;margin-top:24px}
#save.warn{background:#c2410c}
"""

REVIEW_JS = """
// A region is 'resolved' once the reviewer has actually decided something about it: picked a
// candidate, declared it blank, or typed text. Regions that arrived as consensus/gold start
// resolved; 'unresolved' ones start pending. Export warns on anything still pending, because
// --apply-review marks every region on the page gold and would promote unreviewed text.
const state = {};
const ta = id => document.getElementById('t-' + id);
const badge = id => document.getElementById('b-' + id);
const block = id => document.getElementById('r-' + id);
const cands = id => block(id).querySelectorAll('.cand');

function setState(id, s, label){
  state[id] = s;
  const b = badge(id);
  b.className = 'tier ' + (s === 'resolved' ? 'resolved' : 'unresolved');
  b.textContent = label || s;
  updateCount();
}

function updateCount(){
  const pend = REGIONS.filter(r => state[r.id] !== 'resolved');
  const btn = document.getElementById('save');
  const done = REGIONS.length - pend.length;
  btn.textContent = 'Save ' + SAMPLE + '.json  ·  ' + done + '/' + REGIONS.length + ' resolved';
  btn.classList.toggle('warn', pend.length > 0);
}

document.addEventListener('click', function(e){
  const p = e.target.closest('.pick');
  if (p){
    const id = p.dataset.region;
    ta(id).value = p.dataset.text;
    cands(id).forEach(c => c.classList.remove('sel', 'rejected'));
    p.closest('.cand').classList.add('sel');
    setState(id, 'resolved');
    return;
  }
  const a = e.target.closest('.act');
  if (!a) return;
  const id = a.dataset.region;
  cands(id).forEach(c => c.classList.remove('sel'));
  if (a.dataset.action === 'blank'){
    // "no text here" — a detection false positive. cer() returns None against an empty
    // reference, so a blank region is excluded from scoring rather than scored as a total miss.
    ta(id).value = '';
    cands(id).forEach(c => c.classList.remove('rejected'));
    setState(id, 'resolved', 'resolved · blank');
  } else {
    // "none of these are right" — strike the candidates out and wait for a typed answer.
    ta(id).value = '';
    cands(id).forEach(c => c.classList.add('rejected'));
    setState(id, 'pending', 'needs typing');
    ta(id).focus();
  }
});

document.addEventListener('input', function(e){
  const t = e.target;
  if (!t.matches('textarea')) return;
  const id = t.dataset.region;
  cands(id).forEach(c => c.classList.remove('sel'));
  // Manually emptying the box is not the same as declaring it blank — use the button for that.
  setState(id, t.value.trim() ? 'resolved' : 'pending',
           t.value.trim() ? 'resolved · edited' : 'unresolved');
});

function save(){
  const pend = REGIONS.filter(r => state[r.id] !== 'resolved').map(r => r.id);
  if (pend.length){
    const ok = confirm(
      pend.length + ' of ' + REGIONS.length + ' regions are still unresolved:\\n\\n  ' +
      pend.join(', ') + '\\n\\n--apply-review marks EVERY region on this page as gold, ' +
      'including these — their current text would be promoted to hand-confirmed ground truth ' +
      'without review.\\n\\nExport anyway?');
    if (!ok){
      block(pend[0]).scrollIntoView({behavior: 'smooth', block: 'center'});
      return;
    }
  }
  const out = REGIONS.map(r => ({id: r.id, text: ta(r.id).value}));
  const blob = new Blob([JSON.stringify({sample_id: SAMPLE, regions: out}, null, 2)],
                        {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = SAMPLE + '.json'; a.click();
}

REGIONS.forEach(r => { state[r.id] = r.tier === 'unresolved' ? 'pending' : 'resolved'; });
updateCount();
"""


def write_review_html(out_dir, sample_id, img, regions):
    review_dir = os.path.join(out_dir, "_review")
    os.makedirs(review_dir, exist_ok=True)

    from benchmark_vlm_ocr import crop_for_region

    blocks = []
    for r in regions:
        _x, _y, w, h = r["bbox"]
        # Show the *same* padded crop the engines were given. Rendering the raw bbox made
        # regions look clipped in review when the engines had actually seen the surrounding 10px.
        crop, _ = crop_for_region(img, r["bbox"])
        ok, buf = cv2.imencode(".png", crop)
        b64 = base64.b64encode(buf).decode() if ok else ""
        # The candidate text rides in data-* attributes, not in an inline onclick. json.dumps
        # emits a leading `"`, which closed the onclick="..." attribute at the first character
        # and silently broke every `use` button on the page.
        rid = html.escape(r["id"])
        cands = "".join(
            f'<div class="cand"><b>{html.escape(engine)}</b>'
            f'<button class="pick" data-region="{rid}" '
            f'data-text="{html.escape(text, quote=True)}">use</button>'
            f'<code>{html.escape(text) or "<i>(empty)</i>"}</code></div>'
            for engine, text in (r.get("candidates") or {}).items()
        )
        acts = (
            f'<div class="acts">'
            f'<button class="act" data-region="{rid}" data-action="blank" '
            f'title="No text in this region — excluded from scoring">blank (no text)</button>'
            f'<button class="act" data-region="{rid}" data-action="reject" '
            f'title="No candidate is correct — clears the box so you can type it">'
            f'reject all</button></div>'
        )
        blocks.append(
            f'<div class="region" id="r-{rid}">'
            f'<div><img class="crop" src="data:image/png;base64,{b64}">'
            f'<div style="font-size:12px;opacity:.6;margin-top:6px">{rid} · {w}x{h}'
            f'<span class="tier {r["tier"]}" id="b-{rid}">{r["tier"]}</span></div></div>'
            f'<div>{cands}{acts}'
            f'<textarea id="t-{rid}" data-region="{rid}">{html.escape(r["text"])}</textarea>'
            f'</div></div>'
        )

    doc = (f'<!doctype html><meta charset="utf-8"><title>OCR gold review — {sample_id}</title>'
           f"<style>{REVIEW_CSS}</style>"
           f"<h1>OCR gold review — {sample_id}</h1>"
           f'<p class="lead">Compare each crop against the engine candidates. Click <b>use</b> to '
           f'take one (it highlights, and the region flips to <i>resolved</i>), '
           f'<b>blank</b> if the box holds no text, <b>reject all</b> if no candidate is right, '
           f'or just type. The Save button tracks how many regions are resolved and warns before '
           f'exporting an incomplete page. Then run:<br>'
           f'<code>python scripts/build_ocr_corpus.py --apply-review '
           f'corpus/ocr/_review/{sample_id}.json</code></p>'
           + "".join(blocks) +
           f'<button id="save" onclick="save()">Save {sample_id}.json</button>'
           f"<script>const SAMPLE={json.dumps(sample_id)};"
           f"const REGIONS={json.dumps([{'id': r['id'], 'tier': r['tier']} for r in regions])};"
           f"{REVIEW_JS}</script>")

    path = os.path.join(review_dir, f"{sample_id}.html")
    with open(path, "w", encoding="utf-8") as f:
        f.write(doc)
    return path


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def _iou(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def carry_over_ground_truth(regions, previous, min_iou):
    """Re-attach the old text to any new region whose box did not really move.

    A grouping change renumbers and reshapes regions, and `build_sample` rewrites regions.json
    whole, so a naive rebuild discards every consensus and gold string on the page -- including
    ones whose crop is pixel-identical to what those engines actually read. That is not a rebuild,
    it is a reset: the local-only pool cannot reach --min-agree, so all 199 consensus regions come
    back 'unresolved' and sample7's 20 hand-reviewed gold regions are simply gone.

    So a new region that matches an old one at >= min_iou inherits its text, tier, agreement and
    candidates. Matching is greedy from the best pair down and one-to-one: an old region cannot
    donate to two new ones, which is exactly the split case, and there the *pair* must be
    re-transcribed rather than both halves claiming the whole sentence.

    Returns the number of regions that inherited.
    """
    if not previous:
        return 0

    pairs = sorted(
        ((_iou(n["bbox"], o["bbox"]), ni, oi) for ni, n in enumerate(regions) for oi, o in enumerate(previous)),
        key=lambda t: -t[0],
    )
    taken_new, taken_old, carried = set(), set(), 0
    for score, ni, oi in pairs:
        if score < min_iou:
            break
        if ni in taken_new or oi in taken_old:
            continue
        old = previous[oi]
        if not (old.get("text") or "").strip():
            continue
        regions[ni].update(
            {
                "text": old["text"],
                "tier": old.get("tier", "unresolved"),
                "agreement": old.get("agreement", 0),
                "candidates": dict(old.get("candidates", {})),
                "carried_from": old.get("id"),
                "carried_iou": round(score, 4),
            }
        )
        taken_new.add(ni)
        taken_old.add(oi)
        carried += 1
    return carried


def build_sample(sample_id, examples_dir, out_dir, engines_cfg, args):
    sample_dir = os.path.join(examples_dir, sample_id)
    meta = load_sample_meta(sample_dir)
    if meta is None:
        return None, "no meta.json — run corpus/scripts/flatten_samples.py first"

    lang = meta["source"].get("lang", "ja")
    src_path = os.path.join(sample_dir, meta["source"]["file"])
    raw = imread_unicode(src_path)
    if raw is None:
        return None, f"could not read {src_path}"
    img = downscale(raw)

    from benchmark_vlm_ocr import get_all_text_regions
    proposals = get_all_text_regions(img, LANG_NAME.get(lang, "Japanese"))
    if not proposals:
        return None, "no text regions detected"

    regions = [{"id": f"r{i + 1}", "bbox": p["bbox"], "type": p.get("type", "bubble"),
                "polygon": p.get("mask_polygon")} for i, p in enumerate(proposals)]

    # Rescue the previous ground truth for boxes this rebuild did not really move, before any
    # engine runs. Regions that inherit are excluded from transcription below: re-running an
    # engine over an identical crop cannot improve on a consensus that already survived review,
    # and on gold it can only overwrite a human.
    previous = []
    prev_path = os.path.join(out_dir, sample_id, "regions.json")
    if args.carry_over and os.path.exists(prev_path):
        with open(prev_path, "r", encoding="utf-8") as f:
            previous = json.load(f)
    carried = carry_over_ground_truth(regions, previous, args.carry_over_iou)
    fresh = [r for r in regions if "carried_from" not in r]
    if previous:
        print(f"  carried {carried}/{len(regions)} regions from the previous build "
              f"(IoU >= {args.carry_over_iou}); {len(fresh)} need transcription")

    candidates = {}
    for variant in args.paddle_variants:
        if not fresh:
            break
        print(f"  [{variant}] transcribing {len(fresh)} regions...")
        texts = paddle_transcribe_regions(img, fresh, lang, variant)
        if texts is not None:
            candidates[variant] = texts

    lang_name = LANG_NAME.get(lang, "Japanese")
    for provider_name, provider_cfg, model_id, _model_name, _free in engines_cfg:
        if not fresh:
            break
        print(f"  [{provider_name}/{model_id}] transcribing {len(fresh)} regions...")
        texts, _extra = vlm_transcribe_regions(img, fresh, provider_name, provider_cfg,
                                               model_id, lang_name, sleep=args.sleep)
        candidates[f"{provider_name}/{model_id}"] = texts

    tier_counts = {}
    for r in regions:
        r.setdefault("lang", lang)
        r.setdefault("direction", "vertical" if lang in ("ja", "zh") else "horizontal")
        if "carried_from" in r:
            tier_counts[r["tier"]] = tier_counts.get(r["tier"], 0) + 1
            continue
        per_engine = {engine: texts.get(r["id"], "") for engine, texts in candidates.items()}
        text, tier, agree = pick_consensus(per_engine, min_agree=args.min_agree, tol=args.tol)
        r.update({"text": text, "tier": tier, "agreement": agree, "candidates": per_engine})
        tier_counts[tier] = tier_counts.get(tier, 0) + 1

    dest = os.path.join(out_dir, sample_id)
    os.makedirs(dest, exist_ok=True)
    cv2.imwrite(os.path.join(dest, "page.webp"), img,
                [int(cv2.IMWRITE_WEBP_QUALITY), WEBP_QUALITY])
    with open(os.path.join(dest, "regions.json"), "w", encoding="utf-8") as f:
        json.dump(regions, f, ensure_ascii=False, indent=2)
    with open(os.path.join(dest, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({
            "sample_id": sample_id,
            "source_image": f"corpus/samples/{sample_id}/{meta['source']['file']}",
            "source_lang": lang,
            "page_size": [img.shape[1], img.shape[0]],
            "region_count": len(regions),
            "tier_counts": tier_counts,
            "engines": sorted(candidates.keys()),
            "min_agree": args.min_agree,
            "tol": args.tol,
            "notes": "Region proposals come from the production path (YOLO bubble detection + "
                     "PaddleOCR background text merged by worker.services.merge_regions), so "
                     "detection is held constant across chat-VLM models and only transcription "
                     "is being scored. 'unresolved' regions are excluded from scoring.",
        }, f, ensure_ascii=False, indent=2)

    if sample_id in args.gold:
        path = write_review_html(out_dir, sample_id, img, regions)
        print(f"  review page: {path}")

    return dest, (f"{len(regions)} regions, " +
                  ", ".join(f"{n} {t}" for t, n in sorted(tier_counts.items())))


def apply_review(review_path, out_dir):
    with open(review_path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    sample_id = payload["sample_id"]
    edits = {r["id"]: r["text"] for r in payload["regions"]}

    regions_path = os.path.join(out_dir, sample_id, "regions.json")
    with open(regions_path, "r", encoding="utf-8") as f:
        regions = json.load(f)

    changed = 0
    for r in regions:
        if r["id"] in edits:
            if r["text"] != edits[r["id"]]:
                changed += 1
            r["text"] = edits[r["id"]]
            r["tier"] = "gold"
    with open(regions_path, "w", encoding="utf-8") as f:
        json.dump(regions, f, ensure_ascii=False, indent=2)

    meta_path = os.path.join(out_dir, sample_id, "meta.json")
    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
    meta["tier_counts"] = {"gold": len(regions)}
    meta["reviewed"] = True
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"{sample_id}: promoted {len(regions)} regions to gold ({changed} text corrections)")


def main():
    parser = argparse.ArgumentParser(description="Build a ground-truthed OCR corpus from examples/")
    parser.add_argument("--examples-dir", default=DEFAULT_EXAMPLES)
    parser.add_argument("--out-dir", default=DEFAULT_OUT)
    parser.add_argument("--sample", help="Only build this sample id")
    parser.add_argument("--providers-config", default=DEFAULT_PROVIDERS_CONFIG)
    parser.add_argument("--provider", help="Only use this provider's vision models as engines")
    parser.add_argument("--model", help="Only use this model as an engine")
    parser.add_argument("--max-engines", type=int, default=3,
                        help="Cap on cloud vision models used for consensus (default 3)")
    parser.add_argument("--include-paid", action="store_true",
                        help="Allow paid models as engines (default: free models only)")
    parser.add_argument("--local-only", action="store_true",
                        help="PaddleOCR variants only, no API calls")
    parser.add_argument("--paddle-variants", default=",".join(DEFAULT_PADDLE_VARIANTS),
                        help="Comma-separated local PaddleOCR engines to vote with. "
                             f"Available: {', '.join(PADDLE_VARIANTS)}. "
                             f"Default: {','.join(DEFAULT_PADDLE_VARIANTS)} (two generations, so "
                             "the pool reaches --min-agree without needing unanimity). "
                             "Pass an empty string to skip local engines.")
    parser.add_argument("--min-agree", type=int, default=3,
                        help="Engines that must agree within --tol for tier 'consensus'")
    parser.add_argument("--tol", type=float, default=0.10, help="CER tolerance for agreement")
    parser.add_argument("--gold", default="", help="Comma-separated sample ids to emit review pages for")
    parser.add_argument("--review-only", action="store_true",
                        help="Regenerate review pages from existing regions.json, no transcription")
    parser.add_argument("--apply-review", help="Fold a reviewed JSON back in and promote to gold")
    parser.add_argument("--sleep", type=float, default=0.0, help="Seconds between region requests")
    parser.add_argument("--no-carry-over", dest="carry_over", action="store_false",
                        help="Re-transcribe every region from scratch instead of inheriting the "
                             "previous build's text where a box did not move. Discards gold.")
    parser.add_argument("--carry-over-iou", type=float, default=0.9,
                        help="How closely a new box must match an old one to inherit its text "
                             "(default 0.9 — near-identical crop, not merely the same balloon)")
    args = parser.parse_args()
    args.gold = {s for s in args.gold.split(",") if s}
    args.paddle_variants = [v for v in args.paddle_variants.split(",") if v]
    unknown = [v for v in args.paddle_variants if v not in PADDLE_VARIANTS]
    if unknown:
        sys.exit(f"[ERROR] unknown --paddle-variants {unknown}; available: {list(PADDLE_VARIANTS)}")

    if args.apply_review:
        apply_review(args.apply_review, args.out_dir)
        return

    if args.review_only:
        for sample_id in sorted(args.gold, key=lambda s: int(re.sub(r"\D", "", s) or 0)):
            dest = os.path.join(args.out_dir, sample_id)
            img = imread_unicode(os.path.join(dest, "page.webp"))
            with open(os.path.join(dest, "regions.json"), "r", encoding="utf-8") as f:
                regions = json.load(f)
            print(write_review_html(args.out_dir, sample_id, img, regions))
        return

    engines_cfg = []
    if not args.local_only:
        providers_cfg = load_providers_config(args.providers_config)
        engines_cfg = list(list_candidate_models(providers_cfg, "ocr", args.provider,
                                                 args.include_paid, args.model))[:args.max_engines]
        if not engines_cfg:
            print("[WARN] No cloud vision models matched — falling back to PaddleOCR only. "
                  "Every region will be tier 'unresolved'.")

    sample_dirs = sorted(
        (d for d in os.listdir(args.examples_dir)
         if re.fullmatch(r"sample\d+", d) and os.path.isdir(os.path.join(args.examples_dir, d))),
        key=lambda d: int(re.sub(r"\D", "", d)),
    )
    if args.sample:
        sample_dirs = [d for d in sample_dirs if d == args.sample]
        if not sample_dirs:
            sys.exit(f"[ERROR] {args.sample} not found under {args.examples_dir}")

    os.makedirs(args.out_dir, exist_ok=True)
    results = []
    for sample_id in sample_dirs:
        print(f"\n=== {sample_id} ===")
        dest, msg = build_sample(sample_id, args.examples_dir, args.out_dir, engines_cfg, args)
        status = "OK" if dest else "SKIPPED"
        print(f"  {status}: {msg}")
        results.append({"sample_id": sample_id, "status": status, "detail": msg})

    manifest_path = os.path.join(args.out_dir, "_manifest.json")
    by_id = {}
    if os.path.exists(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            try:
                by_id = {m["sample_id"]: m for m in json.load(f)}
            except json.JSONDecodeError:
                by_id = {}
    for r in results:
        by_id[r["sample_id"]] = r
    for sid in [s for s in by_id if not os.path.exists(os.path.join(args.out_dir, s, "regions.json"))]:
        del by_id[sid]
    entries = sorted(by_id.values(), key=lambda m: int(re.sub(r"\D", "", m["sample_id"]) or 0))
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)
    print(f"\nManifest written to {manifest_path} ({len(entries)} entries)")


if __name__ == "__main__":
    main()
