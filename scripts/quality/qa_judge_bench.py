"""Bench a cheap first-pass QA gate against the worker's vision QA, with seeded defects.

For each page it runs:
  gemini  the worker's real vision-QA prompt and side-by-side image, once per model in --gemini-models
  jev     typesafe/jev-1.14 through POST /api/alpha/decisions, asked per region "does it need a fix"
          (noul) and "what kind of problem" (choice), in three layouts:
            page        whole page side by side, the region's box given in the text, one call per region
            page_batch  the same image, every region's questions in one call
            crop        original crop + typeset crop of the region, claimed translation in the text

Each page is judged twice over: unmodified, and seeded with known defects. Seeds are picked
deterministically from the regions the render really changed (largest first, not sfx): the 2 largest get
the original pixels pasted back over their box ("untranslated"), the next 2 swap translations in the
metadata ("wrong translation"). Every configuration runs --runs times, to see whether answers are stable.

Everything is read only on the stack: Postgres through `docker exec ... psql`, SeaweedFS objects through a
short Python snippet run in the worker container. The worker's prompt, schema and region labelling are read
from its source with ast, not copied, so they cannot drift. The OpenRouter key is read from --key-file and
never printed or stored. Raw outputs hold page text and images, so keep --out outside the repo.

    uv run --with pillow python3 scripts/quality/qa_judge_bench.py \\
        --pages PAGE_ID [PAGE_ID ...] --out /tmp/qa-judge --worker-src path/to/worker \\
        --key-file path/to/api_keys.json

Finished calls are cached under --out/raw and skipped on a re-run; --force redoes them. Spend and call
counts are totalled from those files and the run stops at --budget dollars or at a call cap.
The summary (numbers only, no page text) goes to --out/summary.json and --out/summary.md.
"""

import argparse
import ast
import base64
import copy
import hashlib
import io
import json
import logging
import re
import statistics
import subprocess
import sys
import time
import types
import urllib.error
import urllib.request
from pathlib import Path

from PIL import Image, ImageChops, ImageStat

OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_DECISIONS = "https://openrouter.ai/api/alpha/decisions"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

# What worker/services/llm_client.py sends to OpenRouter by default (config.py defaults).
QUANTIZATIONS = ["fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"]
IGNORE_PROVIDERS = ["relace", "open-inference", "wafer"]

# Jev image limits (Multimodal Decisions page): each side 256..1568 px, total 78,400..2,458,624 px.
JEV_MIN_SIDE, JEV_MAX_SIDE, JEV_MIN_AREA, JEV_MAX_AREA = 256, 1568, 78_400, 2_458_624
JEV_MODEL = "typesafe/jev-1.14"
# A crop exactly 256 px on a side got 400 "Invalid image dimensions" on 2026-11-10 (300 was accepted),
# so crops are scaled up to at least this.
CROP_MIN_SIDE = 320

KINDS = {
    "none": "The region is fine: the English is typeset in place of the Japanese, accurate, and fits.",
    "translation_wrong": "The English wording does not match what the Japanese says, or reads badly.",
    "text_overflows_or_overlaps": "The English text runs outside its bubble or box, or overlaps other text or a panel border.",
    "ocr_wrong": "The Japanese transcription does not match the lettering on the original page.",
    "untranslated": "The Japanese source lettering is still visible on the English page for this region.",
}
EXPECTED_KIND = {
    "untranslated": "untranslated",
    "wrong_translation": "translation_wrong",
}
FIX_CRITERIA = {
    "true": (
        "The region needs a fix: the Japanese lettering is still visible on the English page, or the English "
        "does not match the Japanese, or it overflows its bubble, or it overlaps other text."
    ),
    "false": "The region is fine and needs no change.",
}
THRESHOLDS = [0.1, 0.3, 0.5, 0.7, 0.9]


# ---------------------------------------------------------------- stack access (read only)


def sh(cmd, input_bytes=None):
    res = subprocess.run(cmd, input=input_bytes, capture_output=True, check=False)
    if res.returncode:
        raise RuntimeError(
            f"{cmd[0]} {cmd[1]} failed: {res.stderr.decode(errors='replace')[:300]}"
        )
    return res.stdout


def psql_json(container, sql):
    out = sh(
        [
            "docker",
            "exec",
            "-i",
            container,
            "sh",
            "-c",
            'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At',
        ],
        sql.encode(),
    )
    return [json.loads(line) for line in out.decode().splitlines() if line.strip()]


FETCH_SNIPPET = (
    "import os,sys\n"
    "from minio import Minio\n"
    "sec=open(os.environ['MINIO_SECRET_KEY_FILE']).read().strip()\n"
    "c=Minio(os.environ['MINIO_ENDPOINT'],access_key=os.environ['MINIO_ACCESS_KEY'],secret_key=sec,secure=False)\n"
    "r=c.get_object('manga-library',sys.argv[1])\n"
    "sys.stdout.buffer.write(r.read())\n"
)


def fetch_object(container, path):
    return sh(["docker", "exec", container, "python3", "-c", FETCH_SNIPPET, path])


def load_page(args, page_id):
    if not UUID_RE.match(page_id):
        raise SystemExit(f"not a page id: {page_id}")
    page = psql_json(
        args.db_container,
        "select row_to_json(t) from (select p.id, p.page_number, s.title as series, i.storage_path as original, "
        "j.rendered_png_storage_path as render, j.rendered_png_sha256 as render_sha, "
        "p.hand_edited_at is not null as hand_edited from pages p "
        "join chapters c on c.id=p.chapter_id join series s on s.id=c.series_id "
        "join images i on i.id=p.image_id "
        f"left join page_render_jobs j on j.job_id=p.current_render_job_id where p.id='{page_id}') t",
    )
    if not page or not page[0]["render"]:
        raise SystemExit(f"page {page_id} not found or has no current render")
    page = page[0]
    regions = psql_json(
        args.db_container,
        'select row_to_json(t) from (select id, text, translated_text as "translatedText", '
        'region_type as "regionType", bubble_reading_order as "bubbleReadingOrder", '
        'bbox_x as "bboxX", bbox_y as "bboxY", bbox_w as "bboxW", bbox_h as "bboxH", '
        'ocr_score as "ocrScore", confidence, translation_score as "translationScore", '
        'translation_failed as "translationFailed", qa_status as "qaStatus", qa_score as "storedQaScore" '
        f"from ocr_regions where page_id='{page_id}' order by bbox_y, bbox_x, id) t",
    )
    original = fetch_object(args.worker_container, page["original"])
    render = fetch_object(args.worker_container, page["render"])
    page["render_sha_ok"] = hashlib.sha256(render).hexdigest() == page["render_sha"]
    return page, regions, original, render


# ---------------------------------------------------------------- the worker's own prompt, read with ast


def load_worker_helpers(worker_src):
    src = Path(worker_src) / "src/worker"
    tree = ast.parse((src / "handlers/qa.py").read_text())
    names_assigned = {
        "REJECT_SFX_RULE",
        "QA_JSON_SCHEMA",
        "UNCERTAIN_KINDS",
        "QA_VLM_JSON_SCHEMA",
    }
    names_defs = {
        "_vlm_qa_prompt",
        "_region_type",
        "_region_labels",
        "_translation_qa_regions",
    }
    keep = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names_defs:
            keep.append(node)
        elif isinstance(node, ast.Assign):
            target = node.targets[0]
            base = target
            while isinstance(base, ast.Subscript):
                base = base.value
            if isinstance(base, ast.Name) and base.id in names_assigned:
                keep.append(node)
    ns = {
        "json": json,
        "copy": copy,
        "logger": logging.getLogger("qa_judge_bench"),
        "log_payload": lambda value, indent=2: "",
        "select_region_action": lambda region_type, user_override=None: (
            types.SimpleNamespace(user_override=user_override)
        ),
    }
    exec(compile(ast.Module(body=keep, type_ignores=[]), "qa.py", "exec"), ns)  # noqa: S102 (the worker's own source)
    missing = (names_assigned | names_defs) - set(ns)
    if missing:
        raise SystemExit(f"could not load from qa.py: {sorted(missing)}")
    system_prompt = None
    for node in ast.parse((src / "services/translation.py").read_text()).body:
        if (
            isinstance(node, ast.Assign)
            and getattr(node.targets[0], "id", "")
            == "MANGA_TRANSLATION_JSON_SYSTEM_PROMPT"
        ):
            system_prompt = ast.literal_eval(node.value)
    if not system_prompt:
        raise SystemExit("system prompt not found in translation.py")
    ns["SYSTEM_PROMPT"] = system_prompt
    return ns


# ---------------------------------------------------------------- images


def to_rgb(data):
    return Image.open(io.BytesIO(data)).convert("RGB")


def jpeg_b64(img, quality=85):
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode()


def png_data_url(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def side_by_side(left, right):
    """The worker's combined image: original left, typeset right, white fill."""
    w1, h1 = left.size
    w2, h2 = right.size
    combined = Image.new("RGB", (w1 + w2, max(h1, h2)), (255, 255, 255))
    combined.paste(left, (0, 0))
    combined.paste(right, (w1, 0))
    return combined


def fit_for_jev(img):
    """Scale down so every side is at most 1568 and the area at most 2,458,624; pad up to the minimums."""
    w, h = img.size
    scale = min(1.0, JEV_MAX_SIDE / max(w, h), (JEV_MAX_AREA / (w * h)) ** 0.5)
    if scale < 1.0:
        img = img.resize(
            (max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS
        )
    return pad_to_minimums(img)


def pad_to_minimums(img, min_side=JEV_MIN_SIDE):
    w, h = img.size
    nw, nh = max(w, min_side), max(h, min_side)
    while nw * nh < JEV_MIN_AREA:
        nw, nh = int(nw * 1.1) + 1, int(nh * 1.1) + 1
    if (nw, nh) == (w, h):
        return img
    canvas = Image.new("RGB", (nw, nh), (255, 255, 255))
    canvas.paste(img, ((nw - w) // 2, (nh - h) // 2))
    return canvas


def crop_for_jev(img, box):
    """A padded crop around a region box, upscaled so small regions meet Jev's minimum side."""
    x, y, w, h = box
    pad_x, pad_y = max(int(w * 0.4), 30), max(int(h * 0.4), 30)
    left, top = max(0, x - pad_x), max(0, y - pad_y)
    right, bottom = min(img.width, x + w + pad_x), min(img.height, y + h + pad_y)
    crop = img.crop((left, top, right, bottom))
    cw, ch = crop.size
    scale = max(1.0, CROP_MIN_SIDE / min(cw, ch))
    scale = (
        min(scale, JEV_MAX_SIDE / max(cw, ch))
        if max(cw, ch) * scale > JEV_MAX_SIDE
        else scale
    )
    if scale != 1.0:
        crop = crop.resize(
            (max(1, int(cw * scale)), max(1, int(ch * scale))), Image.LANCZOS
        )
    return pad_to_minimums(crop, CROP_MIN_SIDE)


def box_changed(orig, render, box):
    """Mean absolute grey difference between the original and the render inside a box."""
    x, y, w, h = box
    a = orig.crop((x, y, x + w, y + h)).convert("L")
    b = render.crop((x, y, x + w, y + h)).convert("L")
    return ImageStat.Stat(ImageChops.difference(a, b)).mean[0]


# ---------------------------------------------------------------- page preparation


def prepare_page(args, helpers, page_id, out):
    page, ocr_regions, original, render = load_page(args, page_id)
    orig_img, render_img = to_rgb(original), to_rgb(render)
    page["render_resized"] = render_img.size != orig_img.size
    if page["render_resized"]:
        render_img = render_img.resize(orig_img.size, Image.LANCZOS)
    uuid_by_label = helpers["_region_labels"](ocr_regions)
    label_by_uuid = {u: l for l, u in uuid_by_label.items()}
    for region in ocr_regions:
        region["text"] = region["text"] or ""
    targets = helpers["_translation_qa_regions"](ocr_regions)
    for region in targets:
        region["label"] = label_by_uuid[str(region["id"])]
        box = (region["bboxX"], region["bboxY"], region["bboxW"], region["bboxH"])
        region["box"] = box
        region["drawn"] = box_changed(orig_img, render_img, box) > 3.0
    # Seeds: drawn, non-sfx regions, largest box first. Two "untranslated", then two "wrong translation".
    candidates = sorted(
        (r for r in targets if r["drawn"] and r["regionType"] != "sfx"),
        key=lambda r: (-r["bboxW"] * r["bboxH"], str(r["label"])),
    )
    seeds = {}
    for r in candidates[:2]:
        seeds[r["label"]] = "untranslated"
    wrong = candidates[2:4]
    for r in wrong:
        seeds[r["label"]] = "wrong_translation"
    claimed = {r["label"]: r["translatedText"] for r in targets}
    if len(wrong) == 2 and wrong[0]["translatedText"] != wrong[1]["translatedText"]:
        claimed[wrong[0]["label"]], claimed[wrong[1]["label"]] = (
            wrong[1]["translatedText"],
            wrong[0]["translatedText"],
        )
    elif wrong:
        for r in wrong:
            seeds.pop(r["label"])  # identical translations: swapping would seed nothing
        wrong = []
    seeded_render = render_img.copy()
    for label, kind in seeds.items():
        if kind == "untranslated":
            r = next(t for t in targets if t["label"] == label)
            x, y, w, h = r["box"]
            seeded_render.paste(orig_img.crop((x, y, x + w, y + h)), (x, y))
    meta = {
        "label": f"`{page['series']}` p{page['page_number']}",
        "page_id": page_id,
        "orig_size": orig_img.size,
        "render_resized": page["render_resized"],
        "render_sha_ok": page["render_sha_ok"],
        "hand_edited": page["hand_edited"],
        "regions_total": len(ocr_regions),
        "targets": len(targets),
        "drawn": sum(r["drawn"] for r in targets),
        "seeds": seeds,
        "stored_status": {r["label"]: r["qaStatus"] for r in targets},
    }
    pdir = out / "pages" / page_id
    pdir.mkdir(parents=True, exist_ok=True)
    (pdir / "regions.json").write_text(
        json.dumps({"meta": meta, "targets": targets, "claimed": claimed}, indent=1)
    )
    orig_img.save(pdir / "original.png")
    render_img.save(pdir / "render.png")
    seeded_render.save(pdir / "render_seeded.png")
    return {
        "meta": meta,
        "targets": targets,
        "claimed": claimed,
        "orig": orig_img,
        "variants": {"unmodified": render_img, "seeded": seeded_render},
        "ocr_regions": ocr_regions,
        "label_by_uuid": label_by_uuid,
    }


# ---------------------------------------------------------------- calls, caching and budget


class Ledger:
    """Totals spend and call counts from the cached raw files, so a re-run keeps counting."""

    def __init__(self, out, budget, caps):
        self.raw = out / "raw"
        self.raw.mkdir(parents=True, exist_ok=True)
        self.budget, self.caps = budget, caps

    def totals(self):
        spend, calls = 0.0, {"gemini": 0, "jev": 0}
        for path in self.raw.rglob("*.json"):
            rec = json.loads(path.read_text())
            spend += rec.get("cost") or 0.0
            calls[rec["family"]] += rec.get("attempts", 1)
        return spend, calls

    def allow(self, family):
        """Refuse another attempt past the budget or the cap."""
        spend, calls = self.totals()
        if spend >= self.budget:
            raise SystemExit(
                f"stopping: spend ${spend:.4f} reached the ${self.budget} budget"
            )
        if calls[family] >= self.caps[family]:
            raise SystemExit(f"stopping: {family} call cap {self.caps[family]} reached")


def post_json(url, key, body, timeout):
    req = urllib.request.Request(
        url,
        json.dumps(body).encode(),
        {"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read()), time.perf_counter() - start
    except urllib.error.HTTPError as err:
        text = err.read().decode(errors="replace")
        try:
            return err.code, json.loads(text), time.perf_counter() - start
        except ValueError:
            return err.code, {"raw_error": text[:1000]}, time.perf_counter() - start
    except (urllib.error.URLError, TimeoutError) as err:
        return (
            0,
            {"raw_error": f"{type(err).__name__}: {err}"[:300]},
            time.perf_counter() - start,
        )


def cached_call(ledger, args, key, family, path, url, body):
    """One call, cached. A failed cache entry is redone; transient failures are retried --retries times.

    Every attempt counts toward the call cap, so the record keeps a running attempt total.
    """
    attempts = 0
    if path.exists() and not args.force:
        cached = json.loads(path.read_text())
        if cached["http"] == 200:
            return cached
        attempts = cached.get("attempts", 1)
    for attempt in range(args.retries + 1):
        ledger.allow(family)
        status, resp, latency = post_json(url, key, body, args.timeout)
        attempts += 1
        usage = resp.get("usage") or {}
        rec = {
            "family": family,
            "http": status,
            "attempts": attempts,
            "latency_s": round(latency, 3),
            "cost": usage.get("cost"),
            "usage": {
                k: usage.get(k)
                for k in (
                    "input_tokens",
                    "output_tokens",
                    "prompt_tokens",
                    "completion_tokens",
                )
            },
            "response": resp,
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rec))
        if status == 200:
            break
        print(
            f"  {family} {path.name}: HTTP {status}: {json.dumps(resp)[:200]}",
            file=sys.stderr,
        )
        if status not in (0, 429, 502, 503, 504, 524, 529):
            break
        time.sleep(2)
    return rec


# ---------------------------------------------------------------- gemini


def gemini_body(helpers, model, page, variant):
    targets = copy.deepcopy(page["targets"])
    if variant == "seeded":
        for r in targets:
            r["translatedText"] = page["claimed"][r["label"]]
    label_by_uuid = page["label_by_uuid"]
    prompt = helpers["_vlm_qa_prompt"](targets, [], label_by_uuid)
    combined = side_by_side(page["orig"], page["variants"][variant])
    image_b64 = jpeg_b64(combined, 85)
    return {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": [
                    {
                        "type": "text",
                        "text": helpers["SYSTEM_PROMPT"],
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                    },
                ],
            },
        ],
        "max_tokens": 8192,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "structured_output",
                "schema": helpers["QA_VLM_JSON_SCHEMA"],
                "strict": True,
            },
        },
        "plugins": [{"id": "response-healing"}],
        "reasoning": {"max_tokens": 4096},
        "usage": {"include": True},
        "provider": {
            "allow_fallbacks": True,
            "sort": "price",
            "quantizations": QUANTIZATIONS,
            "ignore": IGNORE_PROVIDERS,
            "require_parameters": True,
        },
    }


def parse_gemini(rec):
    """label -> qaStatus, from one cached chat response; {} when the reply is unusable."""
    try:
        content = rec["response"]["choices"][0]["message"]["content"]
        data = json.loads(content)
        return {
            str(item["regionId"]).strip().lstrip("#"): item["qaStatus"]
            for item in data["results"]
        }
    except (KeyError, IndexError, TypeError, ValueError):
        return {}


# ---------------------------------------------------------------- jev


def region_line(page, r, variant):
    """The text for one region. Swapped translations apply to the seeded variant only."""
    claimed = (
        page["claimed"][r["label"]] if variant == "seeded" else r["translatedText"]
    )
    return (
        f"Region #{r['label']} (type {r['regionType']}). Japanese OCR transcription: {r['text']!r}. "
        f"English translation this region is meant to show: {claimed!r}."
    )


def fractions(page, r):
    w, h = page["orig"].size
    x, y, bw, bh = r["box"]
    return f"left={x / w:.3f}, top={y / h:.3f}, right={(x + bw) / w:.3f}, bottom={(y + bh) / h:.3f}"


def jev_questions(regions):
    questions = {}
    for r in regions:
        label = r["label"]
        questions[f"r{label}_fix"] = {
            "type": "noul",
            "instructions": (
                f"Region #{label}: does it need a fix? Check that the Japanese lettering of this region is gone "
                "from the English page, that the English matches the Japanese, and that it fits its bubble "
                "without overflowing or overlapping other text."
            ),
            "criteria": FIX_CRITERIA,
        }
        questions[f"r{label}_kind"] = {
            "type": "choice",
            "instructions": f"Region #{label}: which kind of problem, if any, does it have?",
            "criteria": KINDS,
        }
    return questions


def jev_body(page, variant, layout, regions):
    img = page["variants"][variant]
    if layout in ("page", "page_batch"):
        image = {
            "type": "image_url",
            "image_url": {
                "url": png_data_url(fit_for_jev(side_by_side(page["orig"], img)))
            },
        }
        head = (
            "A manga page translated from Japanese to English. The image has two halves of equal width: the "
            "ORIGINAL Japanese page on the left, the TYPESET English page on the right. Box coordinates are "
            "fractions of ONE page's width and height from its top-left corner, and apply to both halves."
        )
        lines = [
            f"{region_line(page, r, variant)} Box: {fractions(page, r)}."
            for r in regions
        ]
        state = [head, image, *lines]
    else:
        r = regions[0]
        head = (
            "One region of a translated manga page. First image: the ORIGINAL Japanese page, cropped around the "
            "region. Second image: the same crop of the TYPESET English page. The region is the text in the middle."
        )
        orig_url = png_data_url(crop_for_jev(page["orig"], r["box"]))
        typeset_url = png_data_url(crop_for_jev(img, r["box"]))
        state = [
            head,
            "Original crop:",
            {"type": "image_url", "image_url": {"url": orig_url}},
            "Typeset crop:",
            {"type": "image_url", "image_url": {"url": typeset_url}},
            region_line(page, r, variant),
        ]
    return {"model": JEV_MODEL, "state": state, "questions": jev_questions(regions)}


def jev_answers(rec):
    return (rec.get("response") or {}).get("answers") or {}


# ---------------------------------------------------------------- run


def run_all(args, helpers, pages, key, ledger):
    raw = ledger.raw
    for page_id, page in pages.items():
        label = page["meta"]["label"]
        for run in range(1, args.runs + 1):
            for variant in ("unmodified", "seeded"):
                for model in args.gemini_models:
                    path = (
                        raw
                        / "gemini"
                        / model.replace("/", "_")
                        / page_id
                        / f"{variant}_run{run}.json"
                    )
                    print(f"{label} {variant} run{run} {model}", flush=True)
                    cached_call(
                        ledger,
                        args,
                        key,
                        "gemini",
                        path,
                        OPENROUTER_CHAT,
                        gemini_body(helpers, model, page, variant),
                    )
                if args.skip_jev:
                    continue
                seeded_only = [
                    r for r in page["targets"] if r["label"] in page["meta"]["seeds"]
                ]
                for layout in args.layouts:
                    base = raw / "jev" / layout / page_id
                    if layout == "page_batch":
                        print(f"{label} {variant} run{run} jev {layout}", flush=True)
                        cached_call(
                            ledger,
                            args,
                            key,
                            "jev",
                            base / f"{variant}_run{run}.json",
                            OPENROUTER_DECISIONS,
                            jev_body(page, variant, layout, page["targets"]),
                        )
                        continue
                    # Per-region layouts: every region on the unmodified page; only the seeded ones on the
                    # seeded page (the rest are the same input as the unmodified call).
                    todo = page["targets"] if variant == "unmodified" else seeded_only
                    print(
                        f"{label} {variant} run{run} jev {layout}: {len(todo)} calls",
                        flush=True,
                    )
                    for r in todo:
                        cached_call(
                            ledger,
                            args,
                            key,
                            "jev",
                            base / f"{variant}_run{run}_r{r['label']}.json",
                            OPENROUTER_DECISIONS,
                            jev_body(page, variant, layout, [r]),
                        )


# ---------------------------------------------------------------- summary (numbers only)


def med(values):
    return round(statistics.median(values), 2) if values else None


def load_verdicts(args, pages, ledger):
    """verdicts[config][page_id][variant][run][label] = {"fix": bool|None, "p": float|None, "kind": str|None, "reject": bool}"""
    raw, v, calls = ledger.raw, {}, {}
    for page_id, page in pages.items():
        for run in range(1, args.runs + 1):
            for variant in ("unmodified", "seeded"):
                for model in args.gemini_models:
                    cfg = f"gemini:{model}"
                    path = (
                        raw
                        / "gemini"
                        / model.replace("/", "_")
                        / page_id
                        / f"{variant}_run{run}.json"
                    )
                    if not path.exists():
                        continue
                    rec = json.loads(path.read_text())
                    rec["variant"] = variant
                    calls.setdefault(cfg, {}).setdefault(page_id, []).append(rec)
                    out = (
                        v.setdefault(cfg, {})
                        .setdefault(page_id, {})
                        .setdefault(variant, {})
                        .setdefault(run, {})
                    )
                    for lab, status in parse_gemini(rec).items():
                        out[lab] = {
                            "fix": status in ("failed", "direct_fix"),
                            "p": None,
                            "kind": status,
                            "reject": status == "reject_sfx",
                        }
                for layout in [] if args.skip_jev else args.layouts:
                    cfg = f"jev:{layout}"
                    base = raw / "jev" / layout / page_id
                    paths = (
                        [base / f"{variant}_run{run}.json"]
                        if layout == "page_batch"
                        else [
                            base / f"{variant}_run{run}_r{r['label']}.json"
                            for r in page["targets"]
                        ]
                    )
                    out = (
                        v.setdefault(cfg, {})
                        .setdefault(page_id, {})
                        .setdefault(variant, {})
                        .setdefault(run, {})
                    )
                    for path in paths:
                        if not path.exists():
                            continue
                        rec = json.loads(path.read_text())
                        rec["variant"] = variant
                        calls.setdefault(cfg, {}).setdefault(page_id, []).append(rec)
                        answers = jev_answers(rec)
                        for r in page["targets"]:
                            fix, kind = (
                                answers.get(f"r{r['label']}_fix"),
                                answers.get(f"r{r['label']}_kind"),
                            )
                            if fix and fix.get("type") == "noul":
                                out[r["label"]] = {
                                    "fix": fix["noul"] >= 0.5,
                                    "p": fix["noul"],
                                    "kind": (kind or {}).get("choice"),
                                    "reject": False,
                                }
    if args.exclude_wrong_seeds_unmodified:
        # Before 2026-11-10's fix, the Jev text for the unmodified page carried the swapped translation of
        # the wrong-translation seeds. Drop those regions from every config's unmodified-page results so
        # all configs are compared on the same regions.
        for per_page in v.values():
            for page_id, byvar in per_page.items():
                seeds = pages[page_id]["meta"]["seeds"]
                for results in byvar.get("unmodified", {}).values():
                    for label in [
                        l for l in results if seeds.get(l) == "wrong_translation"
                    ]:
                        del results[label]
    return v, calls


def summarise(args, pages, ledger):
    verdicts, calls = load_verdicts(args, pages, ledger)
    spend, ncalls = ledger.totals()
    ref_cfg = f"gemini:{args.gemini_models[0]}"
    rows = []
    for cfg, per_page in verdicts.items():
        for page_id, byvar in per_page.items():
            page = pages[page_id]
            meta = page["meta"]
            seeds = meta["seeds"]
            labels = [r["label"] for r in page["targets"]]
            clean = [l for l in labels if l not in seeds]
            row = {
                "config": cfg,
                "page": meta["label"],
                "targets": len(labels),
                "drawn": meta["drawn"],
            }
            cs = calls.get(cfg, {}).get(page_id, [])
            lat = [c["latency_s"] for c in cs]
            row["calls"] = len(cs)
            row["calls_failed"] = sum(1 for c in cs if c["http"] != 200)
            row["latency_median_s"], row["latency_worst_s"] = (
                med(lat),
                (max(lat) if lat else None),
            )
            row["cost_total"] = round(sum(c["cost"] or 0 for c in cs), 6)
            for run in range(1, args.runs + 1):
                un = byvar.get("unmodified", {}).get(run, {})
                sd = byvar.get("seeded", {}).get(run, {})
                row[f"run{run}"] = {
                    "judged": len(un),
                    "flagged": sum(1 for l in un if un[l]["fix"]),
                    "reject_sfx": sum(1 for l in un if un[l]["reject"]),
                    "seeded_caught": {
                        kind: [
                            sum(
                                1
                                for l, k in seeds.items()
                                if k == kind and sd.get(l, {}).get("fix")
                            ),
                            sum(1 for k in seeds.values() if k == kind),
                        ]
                        for kind in ("untranslated", "wrong_translation")
                    },
                    "kind_match": sum(
                        1
                        for l, k in seeds.items()
                        if sd.get(l, {}).get("kind") == EXPECTED_KIND[k]
                    ),
                    "clean_flagged_seeded_page": sum(
                        1 for l in clean if l in sd and sd[l]["fix"]
                    ),
                    "clean_n": sum(1 for l in clean if l in sd),
                }
            r1, r2 = (byvar.get("unmodified", {}).get(n, {}) for n in (1, 2))
            row["stability"] = {
                "unmod_binary_changes": sum(
                    1
                    for l in labels
                    if l in r1 and l in r2 and r1[l]["fix"] != r2[l]["fix"]
                ),
                "max_abs_dp": max(
                    [
                        abs(r1[l]["p"] - r2[l]["p"])
                        for l in labels
                        if l in r1
                        and l in r2
                        and r1[l]["p"] is not None
                        and r2[l]["p"] is not None
                    ],
                    default=None,
                ),
            }
            ref = (
                verdicts.get(ref_cfg, {})
                .get(page_id, {})
                .get("unmodified", {})
                .get(1, {})
            )
            un1 = byvar.get("unmodified", {}).get(1, {})
            both = [l for l in labels if l in un1 and l in ref and not ref[l]["reject"]]
            row["vs_ref_run1"] = {
                "n": len(both),
                "both_flag": sum(1 for l in both if un1[l]["fix"] and ref[l]["fix"]),
                "model_only": sum(
                    1 for l in both if un1[l]["fix"] and not ref[l]["fix"]
                ),
                "ref_only": sum(1 for l in both if not un1[l]["fix"] and ref[l]["fix"]),
            }
            stored = {l: s for l, s in meta["stored_status"].items() if s}
            cmp_stored = [
                l
                for l in stored
                if l in un1 and stored[l] in ("passed", "failed", "direct_fix")
            ]
            row["vs_stored_run1"] = {
                "n": len(cmp_stored),
                "model_flags_stored_passed": sum(
                    1 for l in cmp_stored if stored[l] == "passed" and un1[l]["fix"]
                ),
                "stored_passed": sum(1 for l in cmp_stored if stored[l] == "passed"),
            }
            rows.append(row)
    probs = jev_probabilities(args, pages, verdicts)
    pooled = pool(args, rows, calls)
    wall = {}
    for cfg, per_page in calls.items():
        for page_id, recs in per_page.items():
            sums = [
                sum(
                    c["latency_s"]
                    for c in recs
                    if c["variant"] == "unmodified" and c["http"] == 200
                )
            ]
            wall.setdefault(cfg, {})[pages[page_id]["meta"]["label"]] = round(
                sums[0] / args.runs, 1
            )
    return {
        "wall_s_one_pass": wall,
        "pooled_pages": [p["meta"]["label"] for p in pages.values()],
        "date": "2026-11-10",
        "spend_usd": round(spend, 6),
        "calls": ncalls,
        "rows": rows,
        "pooled": pooled,
        "jev_probabilities": probs,
        "pages": {
            p["meta"]["label"]: {
                k: v for k, v in p["meta"].items() if k not in ("stored_status",)
            }
            for p in pages.values()
        },
    }


def per_run_total(mine, runs, key, kind=None):
    """A per-run figure summed over pages; seeded-caught figures are [caught, seeded] pairs."""
    if kind is None:
        return [sum(r[run][key] for r in mine) for run in runs]
    return [
        [sum(r[run]["seeded_caught"][kind][i] for r in mine) for i in (0, 1)]
        for run in runs
    ]


def pool(args, rows, calls):
    """One line per config, summed over pages: what the README tables report."""
    out = {}
    for cfg in dict.fromkeys(r["config"] for r in rows):
        mine = [r for r in rows if r["config"] == cfg]
        recs = [
            c
            for per_page in [calls.get(cfg, {})]
            for cs in per_page.values()
            for c in cs
        ]
        ok = [c["latency_s"] for c in recs if c["http"] == 200]
        runs = [f"run{n}" for n in range(1, args.runs + 1)]
        out[cfg] = {
            "judged_per_run": per_run_total(mine, runs, "judged"),
            "targets": sum(r["targets"] for r in mine),
            "flagged_unmodified_per_run": per_run_total(mine, runs, "flagged"),
            "reject_sfx_per_run": per_run_total(mine, runs, "reject_sfx"),
            "untranslated_caught_per_run": per_run_total(
                mine, runs, "x", "untranslated"
            ),
            "wrong_translation_caught_per_run": per_run_total(
                mine, runs, "x", "wrong_translation"
            ),
            "kind_match_per_run": per_run_total(mine, runs, "kind_match"),
            "binary_flips_between_runs": sum(
                r["stability"]["unmod_binary_changes"] for r in mine
            ),
            "max_abs_dp_between_runs": round(
                max(r["stability"]["max_abs_dp"] or 0 for r in mine), 2
            ),
            "latency_median_s": med(ok),
            "latency_worst_s": max(ok) if ok else None,
            "ok_calls": len(ok),
            "failed_final_calls": sum(1 for c in recs if c["http"] != 200),
            "attempts": sum(c.get("attempts", 1) for c in recs),
            "cost_total_usd": round(sum(c["cost"] or 0 for c in recs), 6),
            "cost_per_page_per_run_usd": round(
                sum(c["cost"] or 0 for c in recs) / (len(mine) * args.runs), 5
            ),
            "cost_unmodified_pass_per_page_usd": round(
                sum(c["cost"] or 0 for c in recs if c["variant"] == "unmodified")
                / (len(mine) * args.runs),
                5,
            ),
            "vs_ref_run1": {
                k: sum(r["vs_ref_run1"][k] for r in mine)
                for k in ("n", "both_flag", "model_only", "ref_only")
            },
            "vs_stored_run1": {
                k: sum(r["vs_stored_run1"][k] for r in mine)
                for k in ("n", "model_flags_stored_passed", "stored_passed")
            },
        }
    return out


def group_summary(groups):
    """Per group: n, min, median, max and counts at or above each threshold; plus the seeded-vs-clean AUC."""
    summary = {}
    for name, ps in groups.items():
        ps = sorted(ps)
        summary[name] = {
            "n": len(ps),
            "min": ps[0] if ps else None,
            "median": med(ps),
            "max": ps[-1] if ps else None,
            "at_or_above": {str(t): sum(1 for p in ps if p >= t) for t in THRESHOLDS},
        }
    seeded = groups["untranslated"] + groups["wrong_translation"]
    clean = groups["clean"]
    if seeded and clean:
        summary["auc_seeded_vs_clean"] = round(
            sum((a > b) + 0.5 * (a == b) for a in seeded for b in clean)
            / (len(seeded) * len(clean)),
            3,
        )
    return summary


def jev_probabilities(args, pages, verdicts):
    """Noul probabilities for seeded and clean regions per Jev layout, pooled and per page."""
    out = {}
    for cfg, per_page in verdicts.items():
        if not cfg.startswith("jev:"):
            continue
        pooled = {"untranslated": [], "wrong_translation": [], "clean": []}
        by_page = {}
        for page_id, byvar in per_page.items():
            seeds = pages[page_id]["meta"]["seeds"]
            groups = {"untranslated": [], "wrong_translation": [], "clean": []}
            for run in range(1, args.runs + 1):
                for label, rec in byvar.get("seeded", {}).get(run, {}).items():
                    if label in seeds and rec["p"] is not None:
                        groups[seeds[label]].append(rec["p"])
                for label, rec in byvar.get("unmodified", {}).get(run, {}).items():
                    if label not in seeds and rec["p"] is not None:
                        groups["clean"].append(rec["p"])
            by_page[pages[page_id]["meta"]["label"]] = group_summary(groups)
            for name, ps in groups.items():
                pooled[name] += ps
        out[cfg] = {**group_summary(pooled), "per_page": by_page}
    return out


def write_markdown(summary, path):
    lines = [f"Spend: ${summary['spend_usd']}. Calls: {summary['calls']}.", ""]
    lines += [
        "| Config | Page | Judged | Flagged (run 1 / 2) | Untransl. caught | Wrong tr. caught | Clean flagged (seeded pg) | Kind match | Calls | Median s | Worst s | Cost $ |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in summary["rows"]:
        a, b = r.get("run1", {}), r.get("run2", {})

        def caught(run, kind):
            c = run.get("seeded_caught", {}).get(kind)
            return f"{c[0]}/{c[1]}" if c else "-"

        lines.append(
            f"| {r['config']} | {r['page']} | {a.get('judged')}/{r['targets']} | {a.get('flagged')} / {b.get('flagged', '-')} "
            f"| {caught(a, 'untranslated')} / {caught(b, 'untranslated')} | {caught(a, 'wrong_translation')} / {caught(b, 'wrong_translation')} "
            f"| {a.get('clean_flagged_seeded_page')}/{a.get('clean_n')} | {a.get('kind_match')} | {r['calls']} "
            f"| {r['latency_median_s']} | {r['latency_worst_s']} | {r['cost_total']} |"
        )
    lines += [
        "",
        "Pooled over pages (per run: run 1, run 2):",
        "",
        "| Config | Judged | Flagged, unmodified | Untransl. caught | Wrong tr. caught | Flips | Max dp | Median s | Worst s | Attempts / ok | Cost per page-run $ | Cost, unmodified pass $ | Flags on stored-passed | Run 1 vs 3.5: both / model-only / ref-only |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for cfg, p in summary["pooled"].items():

        def pair(v):
            return " / ".join(
                f"{a[0]}/{a[1]}" if isinstance(a, list) else str(a) for a in v
            )

        ref, st = p["vs_ref_run1"], p["vs_stored_run1"]
        lines.append(
            f"| {cfg} | {pair(p['judged_per_run'])} of {p['targets']} | {pair(p['flagged_unmodified_per_run'])} "
            f"| {pair(p['untranslated_caught_per_run'])} | {pair(p['wrong_translation_caught_per_run'])} "
            f"| {p['binary_flips_between_runs']} | {p['max_abs_dp_between_runs']} | {p['latency_median_s']} | {p['latency_worst_s']} "
            f"| {p['attempts']} / {p['ok_calls']} | {p['cost_per_page_per_run_usd']} | {p['cost_unmodified_pass_per_page_usd']} "
            f"| {st['model_flags_stored_passed']}/{st['n']} | {ref['both_flag']} / {ref['model_only']} / {ref['ref_only']} (n={ref['n']}) |"
        )
    lines += [
        "",
        "Jev noul probabilities (clean = unseeded regions on the unmodified page):",
        "",
        "| Layout | Group | n | min | median | max | >=0.1 | >=0.3 | >=0.5 | >=0.7 | >=0.9 |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for cfg, groups in summary["jev_probabilities"].items():
        for name, g in groups.items():
            if name == "per_page" or not isinstance(g, dict):
                continue
            ab = g["at_or_above"]
            lines.append(
                f"| {cfg} | {name} | {g['n']} | {g['min']} | {g['median']} | {g['max']} | "
                + " | ".join(str(ab[str(t)]) for t in THRESHOLDS)
                + " |"
            )
    lines += [
        "",
        "Jev per page: unseeded region-runs at or above 0.5 / 0.7 / 0.9 (of n), seeded at or above 0.5 / 0.7 / 0.9 (of n):",
        "",
        "| Layout | Page | Unseeded >= .5 / .7 / .9 | n | Untransl. >= .5 / .7 / .9 | Wrong tr. >= .5 / .7 / .9 | n each | AUC |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for cfg, groups in summary["jev_probabilities"].items():
        for page, g in groups["per_page"].items():

            def trio(name, g=g):
                return " / ".join(
                    str(g[name]["at_or_above"][t]) for t in ("0.5", "0.7", "0.9")
                )

            lines.append(
                f"| {cfg} | {page} | {trio('clean')} | {g['clean']['n']} | {trio('untranslated')} | {trio('wrong_translation')} "
                f"| {g['untranslated']['n']} | {g.get('auc_seeded_vs_clean')} |"
            )
    lines += [
        "",
        "Wall time to judge one page once, sequential calls (s), mean over runs:",
        "",
        "| Config | " + " | ".join(summary["pooled_pages"]) + " |",
        "|---|" + "---|" * len(summary["pooled_pages"]),
    ]
    for cfg, per_page in summary["wall_s_one_pass"].items():
        lines.append(
            f"| {cfg} | "
            + " | ".join(str(per_page.get(p)) for p in summary["pooled_pages"])
            + " |"
        )
    path.write_text("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--pages", nargs="+", required=True, help="page ids (pages.id)")
    ap.add_argument(
        "--out",
        required=True,
        help="output directory (outside the repo: raw data holds page text)",
    )
    ap.add_argument(
        "--worker-src",
        required=True,
        help="a checked-out worker/ directory (the submodule)",
    )
    ap.add_argument(
        "--key-file",
        default="secrets/api_keys.json",
        help="JSON file with OPENROUTER_API_KEY",
    )
    ap.add_argument("--db-container", default="manga-tl-test-db-1")
    ap.add_argument("--worker-container", default="manga-tl-test-worker-1")
    ap.add_argument(
        "--gemini-models",
        nargs="*",
        default=["google/gemini-3.5-flash-lite", "google/gemini-3.1-flash-lite"],
    )
    ap.add_argument(
        "--layouts",
        nargs="*",
        default=["page", "page_batch", "crop"],
        choices=["page", "page_batch", "crop"],
    )
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument(
        "--budget", type=float, default=0.8, help="stop at this total spend in USD"
    )
    ap.add_argument("--gemini-cap", type=int, default=30)
    ap.add_argument("--jev-cap", type=int, default=300)
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument(
        "--retries",
        type=int,
        default=1,
        help="extra attempts after a 429/5xx (each counts as a call)",
    )
    ap.add_argument("--skip-jev", action="store_true")
    ap.add_argument(
        "--exclude-wrong-seeds-unmodified",
        action="store_true",
        help="leave the wrong-translation seeds out of unmodified-page results (for a cache written "
        "before the unmodified Jev text stopped carrying the swapped translation)",
    )
    ap.add_argument(
        "--force", action="store_true", help="redo calls that are already cached"
    )
    ap.add_argument(
        "--summary-only",
        action="store_true",
        help="rebuild the summary from cached calls, no API calls",
    )
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    helpers = load_worker_helpers(args.worker_src)
    pages = {pid: prepare_page(args, helpers, pid, out) for pid in args.pages}
    ledger = Ledger(out, args.budget, {"gemini": args.gemini_cap, "jev": args.jev_cap})
    if not args.summary_only:
        key = json.loads(Path(args.key_file).read_text())["OPENROUTER_API_KEY"]
        run_all(args, helpers, pages, key, ledger)
    summary = summarise(args, pages, ledger)
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    write_markdown(summary, out / "summary.md")
    print(
        f"done. spend ${summary['spend_usd']}, calls {summary['calls']}. Summary in {out}/summary.md"
    )


if __name__ == "__main__":
    main()
