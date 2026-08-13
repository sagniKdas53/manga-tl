#!/usr/bin/env python3
"""Measure glyph size per OCR fragment across the corpus, to decide whether it separates sfx.

R4 (docs/issues.md) established that neither of R3's signals works: stylised sound effects are
exactly what the recogniser mangles, so a mangled read matches none of `classify_region_type`'s
sfx rules, and the recogniser reports >=0.9 confidence while being wrong. Glyph size looked like it
separated them on `sample10` -- 12.2% of page width for the sfx against 5.6% for dialogue set large
in a burst -- but `BUBBLE_CONTOUR_FALLBACK`'s "48%" that was really 0.3% is what happens when a
threshold is set from one page, so this measures all forty.

    FLAGS_use_mkldnn=0 .venv/bin/python scripts/glyph_size_probe.py --out /tmp/glyphs.json
    .venv/bin/python scripts/glyph_size_probe.py --report /tmp/glyphs.json

Two phases on purpose: recognition is the slow part and its output is worth keeping, so the report
can be re-cut against different thresholds without paying for OCR again.

oneDNN segfaults PaddleOCR on this host (`ConvertPirAttribute2RuntimeAttribute not support`), hence
`FLAGS_use_mkldnn=0` and `enable_mkldnn=False`. The worker's container is unaffected.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import statistics
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def glyph_size(width, height, text):
    """Rough side of one character's cell: sqrt(box area / character count).

    Robust to orientation, which matters because Japanese fragments are set in vertical columns and
    English is not, so neither `width` nor `height` alone estimates a glyph. Punctuation and spaces
    are dropped from the count -- a fragment of four kana and three exclamation marks has four
    glyphs' worth of area, and counting seven shrinks the estimate by a third.
    """
    glyphs = [c for c in (text or "") if not c.isspace() and c not in "！？!?。、.,~ー…「」『』"]
    n = max(1, len(glyphs))
    return math.sqrt(max(0.0, width * height) / n)


def recognise(pages, out_path):
    import warnings

    warnings.filterwarnings("ignore")
    from paddleocr import PaddleOCR

    engine = PaddleOCR(
        lang="japan",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=True,
        enable_mkldnn=False,
    )

    records = []
    for i, path in enumerate(pages, 1):
        started = time.perf_counter()
        try:
            result = engine.predict(str(path))[0]
        except Exception as e:
            print(f"[{i}/{len(pages)}] {path.parent.name}: FAILED ({e})", flush=True)
            continue
        elapsed = time.perf_counter() - started

        import cv2

        img = cv2.imread(str(path))
        page_h, page_w = img.shape[:2]

        for text, score, poly in zip(result["rec_texts"], result["rec_scores"], result["rec_polys"]):
            xs = [float(p[0]) for p in poly]
            ys = [float(p[1]) for p in poly]
            w, h = max(xs) - min(xs), max(ys) - min(ys)
            records.append(
                {
                    "sample": path.parent.name,
                    "page_w": page_w,
                    "page_h": page_h,
                    "text": text,
                    "confidence": float(score),
                    "x": min(xs),
                    "y": min(ys),
                    "w": w,
                    "h": h,
                    "glyph": glyph_size(w, h, text),
                    "glyph_frac": glyph_size(w, h, text) / page_w,
                }
            )
        print(
            f"[{i}/{len(pages)}] {path.parent.name}: {len(result['rec_texts'])} fragments in {elapsed:.1f}s",
            flush=True,
        )

    out_path.write_text(json.dumps(records, ensure_ascii=False, indent=1))
    print(f"\nwrote {len(records)} fragments to {out_path}")


def report(records_path, thresholds):
    records = json.loads(Path(records_path).read_text())
    fracs = sorted(r["glyph_frac"] for r in records)
    print(f"{len(records)} fragments over {len({r['sample'] for r in records})} pages\n")

    print("glyph size as a fraction of page width:")
    for q in (0.5, 0.75, 0.9, 0.95, 0.98, 0.99):
        print(f"  p{int(q * 100):<3} {fracs[int(q * (len(fracs) - 1))]:.4f}")
    print(f"  max  {fracs[-1]:.4f}")
    print(f"  mean {statistics.mean(fracs):.4f}   median {statistics.median(fracs):.4f}\n")

    print("confidence, for comparison -- R4 found this cannot separate anything:")
    confs = sorted(r["confidence"] for r in records)
    for q in (0.01, 0.05, 0.1, 0.25, 0.5):
        print(f"  p{int(q * 100):<3} {confs[int(q * (len(confs) - 1))]:.4f}")
    print()

    for t in thresholds:
        flagged = [r for r in records if r["glyph_frac"] >= t]
        pages = len({r["sample"] for r in flagged})
        print(f"threshold {t:.3f}: {len(flagged)} fragments flagged ({100 * len(flagged) / len(records):.1f}%) on {pages} pages")

    print("\nthe 25 largest, which any workable threshold must flag:")
    for r in sorted(records, key=lambda r: -r["glyph_frac"])[:25]:
        print(f"  {r['glyph_frac']:.4f} conf={r['confidence']:.3f} {r['sample']:>9} {r['text'][:24]!r}")

    print("\nthe boundary: 25 fragments nearest 0.08, where a threshold would sit:")
    near = sorted(records, key=lambda r: abs(r["glyph_frac"] - 0.08))[:25]
    for r in sorted(near, key=lambda r: -r["glyph_frac"]):
        print(f"  {r['glyph_frac']:.4f} conf={r['confidence']:.3f} {r['sample']:>9} {r['text'][:24]!r}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, help="run recognition and write fragments here")
    ap.add_argument("--report", type=Path, help="report over a fragments file from --out")
    ap.add_argument("--thresholds", default="0.05,0.06,0.07,0.08,0.09,0.10,0.12")
    args = ap.parse_args()

    if args.out:
        pages = [Path(p) for p in sorted(glob.glob(str(REPO / "corpus" / "samples" / "sample*" / "source.*")))]
        print(f"{len(pages)} pages\n")
        recognise(pages, args.out)
    if args.report:
        report(args.report, [float(t) for t in args.thresholds.split(",")])


if __name__ == "__main__":
    main()
