"""Classify every candidate image in corpus/samples/ as English or not.

The point is to catch files that hold an English render but do not carry the `en-` prefix the
raw-drop convention uses (and the reverse: `en-`/`ref-` files that are actually Japanese).

Method. Run PaddleOCR's **English** reader over a downscaled copy and score the recognised text
against /usr/share/dict/american-english. This is deliberately not a CJK-character-ratio test:
build_translation_corpus.py:135 warns that running an English page through the CJK-tuned rec model
"garbles them into Chinese-flavored nonsense", which would make a character-ratio test call English
pages Japanese. The dictionary runs the other way round — a Japanese page read by an English rec
model produces short junk tokens that miss the dictionary, so the signal is clean in both
directions.

Writes one JSON line per image as it goes and skips what is already recorded, so the run resumes.
Processes at most --chunk images then exits, so a bash loop can bound PaddleOCR's per-page
retention (~2 GB) by starting a fresh process.
"""
import argparse
import json
import os
import re
import sys

CORPUS = "/home/sagnik/Projects/docker-composes/manga-library/corpus"
SCRIPTS = "/home/sagnik/Projects/docker-composes/manga-library/scripts"
sys.path.insert(0, SCRIPTS)
os.environ.setdefault("FLAGS_use_mkldnn", "0")

IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
WORD_RE = re.compile(r"[A-Za-z']{3,}")
CJK_RE = re.compile(r"[぀-ヿ㐀-䶿一-鿿]")


def load_dictionary():
    words = set()
    for path in ("/usr/share/dict/american-english", "/usr/share/dict/british-english"):
        if os.path.exists(path):
            with open(path, encoding="utf-8", errors="ignore") as fh:
                for line in fh:
                    words.add(line.strip().lower())
    # Lettering conventions the dictionary does not carry but that are unambiguously English.
    words.update({"ahh", "hmm", "huh", "ugh", "yeah", "hey", "wow", "ok", "okay", "gonna",
                  "wanna", "gotta", "yeah", "haa", "hah", "nngh", "mmm", "shh", "tch"})
    return words


def classify(role, name):
    if name.startswith(("en-", "en_")):
        return "en-prefixed"
    if name.startswith("source."):
        return "source-role"
    if name.startswith("ref-"):
        return "ref-role"
    if name.lower().startswith("screenshot"):
        return "screenshot"
    return "unprefixed"


def candidates():
    out = []
    for base in ("samples", "samples/NSFW", "samples/_parked", "samples/NSFW/_parked"):
        root = os.path.join(CORPUS, base)
        if not os.path.isdir(root):
            continue
        for entry in sorted(os.listdir(root)):
            d = os.path.join(root, entry)
            if not os.path.isdir(d) or entry.startswith("_"):
                continue
            for name in sorted(os.listdir(d)):
                p = os.path.join(d, name)
                if os.path.isdir(p) or os.path.splitext(name)[1].lower() not in IMG_EXT:
                    continue
                # page-N-* / export.png / render.png are our own pipeline output: English by
                # construction and role-named already, so the prefix rule does not apply.
                if name.startswith("page-") or name in ("export.png", "render.png"):
                    continue
                out.append((os.path.relpath(d, CORPUS), name, classify(base, name)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--chunk", type=int, default=20)
    ap.add_argument("--max-dim", type=int, default=1280)
    ap.add_argument("--kinds", default="", help="comma-separated kinds to check; empty = all")
    ap.add_argument("--shard", default="0/1", help="i/n — take every nth candidate starting at i")
    ap.add_argument("--done-from", default="", help="also treat paths in these files as done")
    args = ap.parse_args()

    done = set()
    for path in [args.out] + [p for p in args.done_from.split(",") if p]:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    try:
                        done.add(json.loads(line)["path"])
                    except Exception:
                        pass

    kinds = {k for k in args.kinds.split(",") if k}
    i, n = (int(x) for x in args.shard.split("/"))
    pool = [c for c in candidates() if not kinds or c[2] in kinds]
    pool = pool[i::n]
    todo = [c for c in pool if os.path.join(c[0], c[1]) not in done]
    if not todo:
        print("ALL DONE", flush=True)
        return 0
    todo = todo[: args.chunk]

    import cv2
    from build_translation_corpus import (
        downscale_for_ocr,
        init_paddle_reader,
        parse_paddle_ocr_results,
    )

    words = load_dictionary()
    reader = init_paddle_reader("en")

    with open(args.out, "a", encoding="utf-8") as sink:
        for rel_dir, name, kind in todo:
            rel = os.path.join(rel_dir, name)
            abs_path = os.path.join(CORPUS, rel_dir, name)
            row = {"path": rel, "dir": rel_dir, "name": name, "kind": kind}
            try:
                img = cv2.imread(abs_path)
                if img is None:
                    raise ValueError("unreadable")
                small, _ = downscale_for_ocr(img, max_dim=args.max_dim)
                results = parse_paddle_ocr_results(reader.predict(small))
                text = " ".join(t for _, t, _ in results)
                scores = [s for _, _, s in results]
                toks = WORD_RE.findall(text)
                hits = [t for t in toks if t.lower().strip("'") in words]
                row.update(
                    lines=len(results),
                    mean_score=round(sum(scores) / len(scores), 4) if scores else 0.0,
                    tokens=len(toks),
                    dict_hits=len(hits),
                    dict_rate=round(len(hits) / len(toks), 4) if toks else 0.0,
                    cjk_chars=len(CJK_RE.findall(text)),
                    sample_text=text[:180],
                )
            except Exception as exc:  # a bad file is worth recording, not fatal
                row["error"] = f"{type(exc).__name__}: {exc}"[:200]
            sink.write(json.dumps(row, ensure_ascii=False) + "\n")
            sink.flush()
            print(f"{rel}  {row.get('dict_rate', 'ERR')}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
