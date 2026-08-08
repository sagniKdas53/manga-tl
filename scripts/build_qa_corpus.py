#!/usr/bin/env python3
"""
build_qa_corpus.py — Generate labelled QA test cases by injecting known defects into clean
corpus pages, so scripts/benchmark_qa.py can measure which models actually catch which mistakes.

The QA stage's job is to notice that something upstream went wrong. You cannot measure that
against real pipeline output without hand-labelling every defect, so instead we start from a
clean page (source text from corpus/translation/<sample>/regions.json, translations from its
reference.json) and inject exactly one labelled defect per case. Every case also names the
region that was mutated, which is what lets the runner separate "caught the planted bug" from
"flags everything indiscriminately" — a model that fails everything scores 100% recall and is
useless, so unmutated regions in every case are scored as false positives, and each class gets
a matching control case with no defect at all.

Defect classes and the verdict a competent reviewer should return:

    control            (nothing mutated)                  -> all regions "passed"
    mistranslation     fluent but wrong English           -> "failed" or "direct_fix"
    untranslated       English left identical to source   -> "failed" or "direct_fix"
    ocr_garbage        plausible OCR confusions in source -> escalation.ocrBad
    ocr_unrecoverable  source replaced with random kana   -> needsReOcr / needsManualIntervention
    order_swap         two regions' reading order swapped -> escalation.orderBad
    sfx_translated     an SFX given a literal translation -> "reject_sfx"

Not injected: typesetting defects (text overflowing its bubble). Those cannot be expressed as
metadata mutations — they need the page re-rendered with a broken layout — so the VLM arm here
measures semantic and OCR review only, not typesetting review.

Usage:
    python scripts/build_qa_corpus.py                      # all clean corpus pages
    python scripts/build_qa_corpus.py --sample sample36
    python scripts/build_qa_corpus.py --seed 7             # different mutation draw
"""

import os
import re
import sys
import json
import random
import shutil
import argparse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))

DEFAULT_TL_CORPUS = os.path.join(REPO_ROOT, "corpus", "translation")
DEFAULT_OCR_CORPUS = os.path.join(REPO_ROOT, "corpus", "ocr")
DEFAULT_EXAMPLES = os.path.join(REPO_ROOT, "corpus", "examples")
DEFAULT_OUT = os.path.join(REPO_ROOT, "corpus", "qa")

# Fluent, in-domain English that is simply not what the panel says. Swapping in unrelated-but-
# natural text is the hard case: a model keying on "does this read like English" passes it, only
# one actually comparing against the source text catches it.
WRONG_TRANSLATIONS = [
    "I'll be back before sunset, so don't wait up for me.",
    "The train doesn't stop at this station on weekends.",
    "She left her umbrella at the cafe again, didn't she?",
    "There's no way that old bicycle still runs.",
    "We should probably tell someone about the broken window.",
    "He's been practising that song since the summer festival.",
    "The library closes early during exam week.",
    "I didn't expect it to rain this hard in October.",
]

# Visually confusable Japanese characters — exactly the substitutions a weak OCR pass makes.
OCR_CONFUSIONS = {
    "ー": "一", "一": "ー", "ロ": "口", "口": "ロ", "ツ": "シ", "シ": "ツ",
    "ソ": "ン", "ン": "ソ", "カ": "力", "力": "カ", "タ": "夕", "夕": "タ",
    "ニ": "二", "二": "ニ", "ハ": "八", "八": "ハ", "ト": "卜", "エ": "工",
}

KANA = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん"

SFX_SAMPLES = [
    ("ドドドド", "DODODODO"),
    ("ゴゴゴゴ", "GOGOGOGO"),
    ("バキィ", "BAKII"),
    ("ザワザワ", "ZAWAZAWA"),
    ("ドキドキ", "DOKIDOKI"),
]

DEFECT_CLASSES = ["control", "mistranslation", "untranslated", "ocr_garbage",
                  "ocr_unrecoverable", "order_swap", "sfx_translated"]


def load_clean_page(tl_corpus_dir, sample_id):
    """Clean (source text, reference translation) pairs for one corpus page."""
    base = os.path.join(tl_corpus_dir, sample_id)
    with open(os.path.join(base, "regions.json"), "r", encoding="utf-8") as f:
        regions = json.load(f)
    ref_path = os.path.join(base, "reference.json")
    if not os.path.exists(ref_path):
        return None
    with open(ref_path, "r", encoding="utf-8") as f:
        reference = json.load(f)
    translations = reference.get("reference_translations", {})

    # Only regions with an aligned reference translation are usable: without one there is no
    # "correct" English to corrupt, and a null translation is itself a defect we did not plant.
    usable = [r for r in regions if translations.get(r["id"])]
    if len(usable) < 3:
        return None

    metadata = []
    for i, r in enumerate(usable):
        metadata.append({
            "regionId": r["id"],
            "ocrText": r["text"],
            "ocrScore": 0.95,
            "translatedText": translations[r["id"]],
            "translationScore": 0.93,
            "readingOrder": i + 1,
        })
    return metadata, reference


def attach_bboxes(metadata, ocr_corpus_dir, sample_id):
    """Add x/y/w/h from the OCR corpus when available — the VLM arm's prompt expects them."""
    regions_path = os.path.join(ocr_corpus_dir, sample_id, "regions.json")
    if not os.path.exists(regions_path):
        return False
    with open(regions_path, "r", encoding="utf-8") as f:
        ocr_regions = json.load(f)
    if len(ocr_regions) < len(metadata):
        return False
    for m, o in zip(metadata, ocr_regions):
        x, y, w, h = o["bbox"]
        m.update({"x": x, "y": y, "w": w, "h": h})
    return True


def clone(metadata):
    return [dict(m) for m in metadata]


def mutate(metadata, defect_class, rng):
    """Apply one defect. Returns (mutated_metadata, mutated_region_ids)."""
    out = clone(metadata)

    if defect_class == "control":
        return out, []

    if defect_class == "order_swap":
        i, j = rng.sample(range(len(out)), 2)
        out[i]["readingOrder"], out[j]["readingOrder"] = out[j]["readingOrder"], out[i]["readingOrder"]
        return out, [out[i]["regionId"], out[j]["regionId"]]

    idx = rng.randrange(len(out))
    target = out[idx]

    if defect_class == "mistranslation":
        wrong = rng.choice([w for w in WRONG_TRANSLATIONS if w != target["translatedText"]])
        target["translatedText"] = wrong

    elif defect_class == "untranslated":
        target["translatedText"] = target["ocrText"]

    elif defect_class == "ocr_garbage":
        chars = list(target["ocrText"])
        swappable = [k for k, c in enumerate(chars) if c in OCR_CONFUSIONS]
        if not swappable:
            # Nothing confusable in this region — corrupt a couple of characters instead so the
            # case still carries a real, findable defect.
            if len(chars) < 2:
                return None, []
            for k in rng.sample(range(len(chars)), min(2, len(chars))):
                chars[k] = rng.choice(KANA)
        else:
            for k in rng.sample(swappable, max(1, len(swappable) // 2)):
                chars[k] = OCR_CONFUSIONS[chars[k]]
        target["ocrText"] = "".join(chars)
        target["ocrScore"] = 0.55

    elif defect_class == "ocr_unrecoverable":
        target["ocrText"] = "".join(rng.choice(KANA) for _ in range(max(4, len(target["ocrText"]))))
        target["ocrScore"] = 0.21

    elif defect_class == "sfx_translated":
        sfx, romaji = rng.choice(SFX_SAMPLES)
        target["ocrText"] = sfx
        target["translatedText"] = romaji
        target["ocrScore"] = 0.88

    else:
        raise ValueError(f"unknown defect class {defect_class!r}")

    return out, [target["regionId"]]


def build_sample(sample_id, args, rng):
    loaded = load_clean_page(args.tl_corpus, sample_id)
    if loaded is None:
        return None, "fewer than 3 regions with an aligned reference translation"
    metadata, reference = loaded

    has_bboxes = attach_bboxes(metadata, args.ocr_corpus, sample_id)

    sample_dir = os.path.join(args.examples_dir, sample_id)
    meta_path = os.path.join(sample_dir, "meta.json")
    images = None
    if os.path.exists(meta_path):
        with open(meta_path, "r", encoding="utf-8") as f:
            sample_meta = json.load(f)
        source_rel = sample_meta["source"]["file"]
        render_rel = (sample_meta.get("output") or {}).get("worker_render")
        if render_rel and os.path.exists(os.path.join(sample_dir, render_rel)):
            images = {
                "source": os.path.join("corpus", "examples", sample_id, source_rel),
                "render": os.path.join("corpus", "examples", sample_id, render_rel),
            }

    dest = os.path.join(args.out_dir, sample_id)
    os.makedirs(dest, exist_ok=True)

    written = []
    for defect_class in DEFECT_CLASSES:
        mutated, ids = mutate(metadata, defect_class, rng)
        if mutated is None:
            continue
        case = {
            "case_id": f"{sample_id}__{defect_class}",
            "sample_id": sample_id,
            "defect_class": defect_class,
            "mutated_region_ids": ids,
            "region_count": len(mutated),
            "regions_metadata": mutated,
            "has_bboxes": has_bboxes,
            "images": images,
            "vlm_ready": bool(images) and has_bboxes,
            "reference_provenance": reference.get("reference_provenance"),
        }
        with open(os.path.join(dest, f"{defect_class}.json"), "w", encoding="utf-8") as f:
            json.dump(case, f, ensure_ascii=False, indent=2)
        written.append(defect_class)

    # A class that yielded no mutation this time may still have a file from an earlier build —
    # e.g. sample40's ocr_garbage survived a rebuild that skipped it. Left alone it would be
    # scored as a current case against page metadata that has since changed.
    for defect_class in set(DEFECT_CLASSES) - set(written):
        orphan = os.path.join(dest, f"{defect_class}.json")
        if os.path.exists(orphan):
            os.remove(orphan)
            print(f"{'':10s} dropped stale {defect_class} case for {sample_id}")

    return dest, (f"{len(written)} cases, {len(metadata)} regions"
                  f"{', bboxes' if has_bboxes else ', no bboxes (LLM arm only)'}"
                  f"{', images' if images else ''}")


def main():
    parser = argparse.ArgumentParser(description="Inject labelled QA defects into clean corpus pages")
    parser.add_argument("--tl-corpus", default=DEFAULT_TL_CORPUS)
    parser.add_argument("--ocr-corpus", default=DEFAULT_OCR_CORPUS)
    parser.add_argument("--examples-dir", default=DEFAULT_EXAMPLES)
    parser.add_argument("--out-dir", default=DEFAULT_OUT)
    parser.add_argument("--sample", help="Only this corpus sample id")
    parser.add_argument("--seed", type=int, default=1337,
                        help="Mutation RNG seed — fixed so cases are reproducible")
    args = parser.parse_args()

    if not os.path.isdir(args.tl_corpus):
        sys.exit(f"[ERROR] {args.tl_corpus} not found. Run scripts/build_translation_corpus.py first.")

    samples = sorted(
        (d for d in os.listdir(args.tl_corpus)
         if os.path.isdir(os.path.join(args.tl_corpus, d))
         and os.path.exists(os.path.join(args.tl_corpus, d, "regions.json"))),
        key=lambda d: int(re.sub(r"\D", "", d) or 0),
    )
    if args.sample:
        samples = [s for s in samples if s == args.sample]
        if not samples:
            sys.exit(f"[ERROR] {args.sample} not in {args.tl_corpus}")

    os.makedirs(args.out_dir, exist_ok=True)
    results, total_cases, vlm_ready = [], 0, 0

    for sample_id in samples:
        # Seed per sample, not once for the loop. A single shared RNG makes a page's mutations
        # depend on how many pages were drawn before it, so `--sample X` and a full run produce
        # different cases for X — which quietly breaks the incremental workflow the docs
        # recommend. Keying the seed on the sample id makes the two agree.
        rng = random.Random(f"{args.seed}:{sample_id}")
        dest, msg = build_sample(sample_id, args, rng)
        status = "OK" if dest else "SKIPPED"
        print(f"{sample_id:10s} {status}: {msg}")
        results.append({"sample_id": sample_id, "status": status, "detail": msg})
        if dest:
            total_cases += len(DEFECT_CLASSES)
            control = os.path.join(dest, "control.json")
            with open(control, "r", encoding="utf-8") as f:
                if json.load(f)["vlm_ready"]:
                    vlm_ready += 1
        else:
            # A page can stop being eligible — swapped out, or dropped below the 3-aligned-region
            # floor. Without this its cases from the previous build would linger and be scored:
            # sample21's Chinese cases outlived the page itself that way.
            stale = os.path.join(args.out_dir, sample_id)
            if os.path.isdir(stale):
                shutil.rmtree(stale)
                print(f"{'':10s} removed stale cases from a previous build")

    # Merge into the manifest rather than replacing it, so `--sample X` records X without
    # discarding every other page (it used to leave a one-entry manifest behind), and drop
    # entries whose directory is gone.
    manifest_path = os.path.join(args.out_dir, "_manifest.json")
    by_id = {}
    if os.path.exists(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            try:
                by_id = {m["sample_id"]: m for m in json.load(f).get("samples", [])}
            except (json.JSONDecodeError, AttributeError):
                by_id = {}
    for r in results:
        by_id[r["sample_id"]] = r
    for sid in [s for s in by_id
                if not os.path.isdir(os.path.join(args.out_dir, s))
                and by_id[s]["status"] == "OK"]:
        del by_id[sid]
    entries = sorted(by_id.values(), key=lambda m: int(re.sub(r"\D", "", m["sample_id"]) or 0))

    manifest = {
        "seed": args.seed,
        "defect_classes": DEFECT_CLASSES,
        "samples": entries,
        "note": "Typesetting/overflow defects are not injected — they require re-rendering the "
                "page, not mutating metadata. The VLM arm measures semantic and OCR review only.",
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    ok = sum(1 for r in results if r["status"] == "OK")
    print(f"\n{ok}/{len(results)} samples this run, ~{total_cases} cases; "
          f"{sum(1 for e in entries if e['status'] == 'OK')} pages in the corpus, "
          f"{vlm_ready} VLM-ready (need both OCR-corpus bboxes and a worker render)")
    print(f"Manifest written to {manifest_path}")


if __name__ == "__main__":
    main()
