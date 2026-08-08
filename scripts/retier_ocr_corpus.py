#!/usr/bin/env python3
"""
retier_ocr_corpus.py — Recompute the OCR corpus's ground-truth tiers from the candidates already
on disk, without re-calling a single engine.

Why this exists: `tier` is a pure function of `candidates` + the voting rule, so the expensive
artifact from a corpus build is the per-engine transcriptions, not the tier labels. That makes
the agreement threshold a cheap thing to revisit and an expensive thing to get wrong up front.

What it fixes: `build_ocr_corpus.pick_consensus()` treats every engine as independent. The
PaddleOCR variants are not — they share a vertical-column ordering bug on Japanese text, so they
all reverse the reading order of the same region and vote as a bloc. Observed on sample1 r1:

    paddleocr_v6_medium   本当にやるの？お兄ちゃん…          <- reversed
    paddleocr_v5_server   本当にやるの？お兄ちゃん…          <- reversed, same bug
    qwen3-vl-32b          お兄ちゃん…\n本当にやるの？         <- correct
    gemini-3.1-flash-lite お兄ちゃん…\n本当にやるの？         <- correct

Two engines "agree" on each reading. With `--min-agree 3` nothing resolves; with `--min-agree 2`
the tie is broken arbitrarily and the reversed text can win. Neither is a threshold problem —
it's that 4 engines are really 3 opinions.

So: collapse each *family* to one vote first (the family's own medoid), then vote across
families. Paddle keeps its real strength — it beats the VLMs on short SFX crops they garble —
without being able to outvote them on reading order.

Usage:
    python scripts/retier_ocr_corpus.py --dry-run      # report what would change
    python scripts/retier_ocr_corpus.py               # rewrite regions.json + meta.json
"""

import os
import re
import sys
import json
import argparse
import collections

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from bench_common import cer, normalize_text  # noqa: E402

DEFAULT_CORPUS = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "corpus", "ocr"))


def family_of(engine):
    """Engines that fail together belong to one family and get one vote between them.

    Every PaddleOCR variant is one family: they are the same detector/recogniser lineage and
    reproduce each other's ordering errors. Each cloud model is its own family — different
    vendor, different training, genuinely independent failure modes.
    """
    return "paddleocr" if engine.startswith("paddleocr") else engine


def medoid(texts, tol):
    """The candidate with the most peers within `tol` CER, tie-broken by lowest total distance.
    Returns (text, peers_within_tol). Empty transcriptions never vote."""
    items = [t for t in texts if normalize_text(t)]
    if not items:
        return "", 0
    if len(items) == 1:
        return items[0], 1

    best_text, best_score, best_agree = items[0], (0, 0.0), 0
    for i, ti in enumerate(items):
        agree, distance = 0, 0.0
        for j, tj in enumerate(items):
            if i == j:
                continue
            d = cer(tj, ti)
            if d is None:
                continue
            distance += d
            if d <= tol:
                agree += 1
        score = (-agree, distance)
        if i == 0 or score < best_score:
            best_text, best_score, best_agree = ti, score, agree
    return best_text, best_agree + 1


def pick_consensus_by_family(candidates, min_agree, tol):
    """Collapse to one vote per family, then vote across families.

    Returns (text, tier, agreeing_families, family_votes).
    """
    families = collections.OrderedDict()
    for engine, text in candidates.items():
        families.setdefault(family_of(engine), []).append(text)

    votes = collections.OrderedDict()
    for fam, texts in families.items():
        text, _ = medoid(texts, tol)
        if normalize_text(text):
            votes[fam] = text

    if not votes:
        return "", "unresolved", 0, votes
    winner, agree = medoid(list(votes.values()), tol)
    tier = "consensus" if agree >= min_agree else "unresolved"
    return winner, tier, agree, votes


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", default=DEFAULT_CORPUS)
    ap.add_argument("--sample", help="Only this sample id")
    ap.add_argument("--min-agree", type=int, default=2,
                    help="Families that must agree for tier 'consensus' (default 2)")
    ap.add_argument("--tol", type=float, default=0.10, help="CER tolerance for agreement")
    ap.add_argument("--dry-run", action="store_true", help="Report only, write nothing")
    args = ap.parse_args()

    samples = sorted((d for d in os.listdir(args.corpus) if re.fullmatch(r"sample\d+", d)),
                     key=lambda s: int(s[6:]))
    if args.sample:
        samples = [s for s in samples if s == args.sample]
        if not samples:
            sys.exit(f"[ERROR] {args.sample} not in {args.corpus}")

    before = collections.Counter()
    after = collections.Counter()
    changed_text = 0
    total = 0
    # sample_id -> the "N regions, N consensus, N unresolved" line the manifest advertises.
    # Retiering makes the manifest written by build_ocr_corpus.py stale, and a stale manifest
    # is worse than none: it is the file anything downstream reads to size the corpus.
    new_detail = {}

    for sample_id in samples:
        rpath = os.path.join(args.corpus, sample_id, "regions.json")
        if not os.path.exists(rpath):
            continue
        with open(rpath, encoding="utf-8") as f:
            regions = json.load(f)

        tier_counts = collections.Counter()
        for r in regions:
            cands = r.get("candidates") or {}
            # gold is hand-confirmed; a vote must never overwrite it.
            if r.get("tier") == "gold":
                tier_counts["gold"] += 1
                before["gold"] += 1
                after["gold"] += 1
                total += 1
                continue
            text, tier, agree = pick_consensus_by_family(cands, args.min_agree, args.tol)[:3]
            before[r.get("tier", "unresolved")] += 1
            after[tier] += 1
            total += 1
            if text != r.get("text"):
                changed_text += 1
            r.update({"text": text, "tier": tier, "agreement": agree})
            tier_counts[tier] += 1

        new_detail[sample_id] = ", ".join(
            [f"{len(regions)} regions"]
            + [f"{tier_counts[t]} {t}" for t in ("gold", "consensus", "unresolved") if tier_counts[t]]
        )

        if not args.dry_run:
            with open(rpath, "w", encoding="utf-8") as f:
                json.dump(regions, f, ensure_ascii=False, indent=2)
            mpath = os.path.join(args.corpus, sample_id, "meta.json")
            if os.path.exists(mpath):
                with open(mpath, encoding="utf-8") as f:
                    meta = json.load(f)
                meta["tier_counts"] = dict(tier_counts)
                meta["min_agree"] = args.min_agree
                meta["tol"] = args.tol
                meta["voting"] = ("one vote per engine family (all paddleocr variants collapse to "
                                  "one), then medoid across families — see retier_ocr_corpus.py")
                with open(mpath, "w", encoding="utf-8") as f:
                    json.dump(meta, f, ensure_ascii=False, indent=2)

    manifest_path = os.path.join(args.corpus, "_manifest.json")
    if not args.dry_run and os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
        for entry in manifest:
            detail = new_detail.get(entry.get("sample_id"))
            if detail:
                entry["detail"] = detail
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)

    def line(label, counter):
        parts = ", ".join(f"{counter[t]} {t}" for t in ("gold", "consensus", "unresolved") if counter[t])
        res = counter["gold"] + counter["consensus"]
        return f"  {label:8s} {parts}   scoreable {res}/{total} = {res/total:.1%}" if total else ""

    print(f"{len(samples)} sample(s), {total} regions, min_agree={args.min_agree} across families")
    print(line("before", before))
    print(line("after", after))
    print(f"  {changed_text} region(s) got different ground-truth text")
    if args.dry_run:
        print("\nDry run — nothing written.")


if __name__ == "__main__":
    main()
