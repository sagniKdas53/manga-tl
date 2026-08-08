#!/usr/bin/env python3
"""
refresh_local_candidates.py — Re-transcribe one sample's regions with the local PaddleOCR
engines and write the results back into `regions.json`'s `candidates`, leaving every cloud
engine's stored transcription untouched.

Why this exists: the corpus's expensive artifact is the per-engine `candidates`, and the cloud
ones cost money. When only the *local* half needs recomputing — a crop change, a new PaddleOCR
generation — re-running the whole build would re-pay for the cloud calls to get identical
answers back, because those engines already saw the padded crop.

Concretely it exists because `paddle_transcribe_regions` used to be fed the raw bbox while the
VLMs got `crop_for_region`'s 10px-padded one, so the two families transcribed different images
and paddle was clipped. Fixing that invalidates only paddle's stored candidates.

PaddleOCR retains ~2GB per page, so drive this one process per sample:

    for s in $(ls -d corpus/ocr/sample*/ | xargs -n1 basename); do
        python scripts/refresh_local_candidates.py --sample "$s"
    done
    python scripts/retier_ocr_corpus.py --min-agree 2 --tol 0.10

Tiers are NOT recomputed here — run retier_ocr_corpus.py afterwards. `gold` regions keep their
hand-confirmed text; only their candidate list is refreshed.
"""

import os
import sys
import json
import argparse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
sys.path.insert(0, SCRIPT_DIR)
sys.path.insert(0, os.path.join(REPO_ROOT, "worker", "src"))

DEFAULT_CORPUS = os.path.join(REPO_ROOT, "corpus", "ocr")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", default=DEFAULT_CORPUS)
    ap.add_argument("--sample", required=True)
    ap.add_argument("--paddle-variants", default="paddleocr_v6_medium,paddleocr_v5_server")
    ap.add_argument("--lang", default="japan")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    from build_ocr_corpus import paddle_transcribe_regions, imread_unicode

    sample_dir = os.path.join(args.corpus, args.sample)
    rpath = os.path.join(sample_dir, "regions.json")
    if not os.path.exists(rpath):
        sys.exit(f"[ERROR] no regions.json for {args.sample}")

    with open(rpath, encoding="utf-8") as f:
        regions = json.load(f)
    img = imread_unicode(os.path.join(sample_dir, "page.webp"))
    if img is None:
        sys.exit(f"[ERROR] could not read page.webp for {args.sample}")

    changed = 0
    for variant in [v for v in args.paddle_variants.split(",") if v]:
        got = paddle_transcribe_regions(img, regions, args.lang, variant)
        if not got:
            print(f"  [warn] {variant} unavailable — leaving its stored candidates alone")
            continue
        for r in regions:
            cands = r.setdefault("candidates", {})
            new = got.get(r["id"], "")
            if cands.get(variant) != new:
                changed += 1
            cands[variant] = new

    if not args.dry_run:
        with open(rpath, "w", encoding="utf-8") as f:
            json.dump(regions, f, ensure_ascii=False, indent=2)

    print(f"{args.sample}: {len(regions)} regions, {changed} candidate(s) changed"
          + ("  (dry run)" if args.dry_run else ""))


if __name__ == "__main__":
    main()
