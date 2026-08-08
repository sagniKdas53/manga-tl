#!/usr/bin/env python3
"""
organize_examples.py — Migrate examples/sampleN/ into role subfolders driven by
scripts/examples_manifest.json, and generate each sample's meta.json.

Target layout (original filenames preserved inside each role folder):

    examples/sampleN/
      source/<original filename>          exactly one, the source-language page
      reference/<original filename>       0..n human / competitor renders
      output/frontend-export.png          was page-N-export*.png
      output/worker-render.png            was page-N-rendered*.png
      output/project.zip                  was page-N-layers*.zip
      output/legacy-bench/                stale demo_output_* / ocr_results_* / tl_output_* /
                                          qa_output_* / paddleocr_* / final_rendered_page.*
      meta.json                           generated from the manifest

Why a manifest instead of filename heuristics: the old
build_translation_corpus.find_source_and_reference() guessed from "original"/"orginal" stems
and an "en-" prefix. That misses the 11 samples whose human translation is saved under its own
Twitter id (sample3's HNH3MvUXoAAQko3.jpeg, sample34's HPAP_YkakAAYNwp.jpg, ...) and on sample31
it picks the *English* page as the source. Roles were established by eye; the manifest is the
committed record, since examples/ itself is gitignored.

Dry run by default — nothing moves until you pass --apply.

Usage:
    python scripts/organize_examples.py                  # show the plan
    python scripts/organize_examples.py --apply
    python scripts/organize_examples.py --apply --sample sample34
    python scripts/organize_examples.py --verify         # check an already-migrated tree
    python scripts/organize_examples.py --refresh-meta --sample sample20   # after a hand swap
"""

import os
import re
import sys
import json
import shutil
import hashlib
import zipfile
import argparse

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
DEFAULT_MANIFEST = os.path.join(SCRIPT_DIR, "examples_manifest.json")
DEFAULT_EXAMPLES = os.path.join(REPO_ROOT, "corpus", "examples")

OUTPUT_TARGETS = {
    "frontend_export": "frontend-export.png",
    "worker_render": "worker-render.png",
    "project": "project.zip",
}

# Stale per-sample benchmark artifacts from earlier ad-hoc runs (sample5, sample18). Kept rather
# than deleted — they are the only surviving record of those runs — but moved out of the way.
LEGACY_PREFIXES = ("demo_output_", "ocr_results_", "tl_output_", "qa_output_",
                   "paddleocr_", "final_rendered_page")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def classify_removals(sample_dir, keep):
    """Split the files we intend to delete into (duplicates, task_zips, refused).

    Refuses anything it cannot positively justify: a "(copy 1)" whose bytes differ from the
    original, or a task-*.zip holding more than the single source image. Those come back as
    `refused` and are left on disk for a human to look at.
    """
    duplicates, task_zips, refused = [], [], []
    for name in sorted(os.listdir(sample_dir)):
        path = os.path.join(sample_dir, name)
        if not os.path.isfile(path) or name in keep:
            continue

        if "(copy" in name:
            twin = re.sub(r" \(copy \d+\)", "", name)
            twin_path = os.path.join(sample_dir, twin)
            if os.path.isfile(twin_path) and sha256(path) == sha256(twin_path):
                duplicates.append(name)
            else:
                refused.append((name, f"no byte-identical twin {twin!r}"))
            continue

        if name.startswith("task-") and name.endswith(".zip"):
            try:
                with zipfile.ZipFile(path) as z:
                    entries = [i.filename for i in z.infolist() if not i.is_dir()]
            except zipfile.BadZipFile:
                refused.append((name, "not a readable zip"))
                continue
            # These are mangatranslate.com job uploads: a single re-download of the source page,
            # no project data. Anything else is not ours to assume.
            if len(entries) == 1 and os.path.basename(entries[0]) in keep:
                task_zips.append(name)
            else:
                refused.append((name, f"holds {len(entries)} entry/entries: {entries[:4]}"))
    return duplicates, task_zips, refused


def plan_sample(sample_id, spec, examples_dir):
    sample_dir = os.path.join(examples_dir, sample_id)
    if not os.path.isdir(sample_dir):
        return None, [f"{sample_id}: directory not found"]

    present = set(os.listdir(sample_dir))
    problems = []
    moves = []  # (src_name, dest_relpath)

    src = spec["source"]["file"]
    if src not in present:
        problems.append(f"{sample_id}: source {src!r} missing")
    else:
        moves.append((src, os.path.join("source", src)))

    for ref in spec["references"]:
        if ref["file"] not in present:
            problems.append(f"{sample_id}: reference {ref['file']!r} missing")
        else:
            moves.append((ref["file"], os.path.join("reference", ref["file"])))

    for role, name in spec["output"].items():
        if name not in present:
            problems.append(f"{sample_id}: {role} {name!r} missing")
        else:
            moves.append((name, os.path.join("output", OUTPUT_TARGETS[role])))

    legacy = sorted(f for f in present
                    if f.startswith(LEGACY_PREFIXES) and os.path.isfile(os.path.join(sample_dir, f)))
    for name in legacy:
        moves.append((name, os.path.join("output", "legacy-bench", name)))

    keep = {m[0] for m in moves}
    duplicates, task_zips, refused = classify_removals(sample_dir, keep)
    # note.txt is folded into meta.json's notes by the manifest, so it is safe to drop.
    removals = duplicates + task_zips + (["note.txt"] if "note.txt" in present else [])

    return {
        "sample_id": sample_id,
        "dir": sample_dir,
        "moves": moves,
        "removals": removals,
        "refused": refused,
    }, problems


def build_meta(sample_id, spec):
    return {
        "sample_id": sample_id,
        "sfw": spec["sfw"],
        "source": {"file": os.path.join("source", spec["source"]["file"]),
                   "lang": spec["source"]["lang"]},
        "references": [{**ref, "file": os.path.join("reference", ref["file"])}
                       for ref in spec["references"]],
        "output": {role: os.path.join("output", target)
                   for role, target in OUTPUT_TARGETS.items() if role in spec["output"]},
        "notes": spec.get("notes", ""),
    }


def apply_plan(plan, spec):
    sample_dir = plan["dir"]
    for role_dir in ("source", "reference", "output"):
        os.makedirs(os.path.join(sample_dir, role_dir), exist_ok=True)
    if any(dest.startswith(os.path.join("output", "legacy-bench")) for _, dest in plan["moves"]):
        os.makedirs(os.path.join(sample_dir, "output", "legacy-bench"), exist_ok=True)

    for src_name, dest_rel in plan["moves"]:
        src_path = os.path.join(sample_dir, src_name)
        dest_path = os.path.join(sample_dir, dest_rel)
        if os.path.exists(dest_path):
            raise SystemExit(f"[ABORT] {dest_path} already exists — refusing to overwrite")
        shutil.move(src_path, dest_path)

    for name in plan["removals"]:
        os.remove(os.path.join(sample_dir, name))

    with open(os.path.join(sample_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(build_meta(plan["sample_id"], spec), f, ensure_ascii=False, indent=2)


def refresh_meta(specs, examples_dir):
    """Rewrite meta.json for a tree that is already in the role-subfolder layout.

    --apply reads the *pre*-migration layout, where everything sits flat at the top of
    examples/sampleN/, so it cannot be re-run once the files live in source/ reference/ output/.
    When a page is swapped by hand the replacement usually lands in the role folders already —
    all that is left is to canonicalise the output filenames and regenerate meta.json from the
    manifest. That is what this does.
    """
    ok = True
    for sample_id in sorted(specs, key=lambda s: int(s[6:])):
        spec = specs[sample_id]
        sample_dir = os.path.join(examples_dir, sample_id)
        problems, renames = [], []

        for rel in [os.path.join("source", spec["source"]["file"])] + \
                   [os.path.join("reference", r["file"]) for r in spec["references"]]:
            if not os.path.exists(os.path.join(sample_dir, rel)):
                problems.append(f"missing {rel}")

        for role, name in spec["output"].items():
            target = os.path.join("output", OUTPUT_TARGETS[role])
            if os.path.exists(os.path.join(sample_dir, target)):
                continue
            current = os.path.join("output", name)
            if os.path.exists(os.path.join(sample_dir, current)):
                renames.append((current, target))
            else:
                problems.append(f"missing {role}: neither {target} nor {current}")

        if problems:
            print(f"  SKIPPED  {sample_id}: {'; '.join(problems)}")
            ok = False
            continue

        for current, target in renames:
            shutil.move(os.path.join(sample_dir, current), os.path.join(sample_dir, target))
        with open(os.path.join(sample_dir, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(build_meta(sample_id, spec), f, ensure_ascii=False, indent=2)
        renamed = f", {len(renames)} output file(s) renamed" if renames else ""
        print(f"  OK       {sample_id}: meta.json written{renamed}")
    return ok


def verify(manifest, examples_dir):
    """Check an already-migrated tree: every meta.json path resolves, nothing stray at top level."""
    ok = True
    for sample_id, spec in manifest["samples"].items():
        sample_dir = os.path.join(examples_dir, sample_id)
        meta_path = os.path.join(sample_dir, "meta.json")
        if not os.path.isfile(meta_path):
            print(f"  MISSING meta.json  {sample_id}")
            ok = False
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        paths = [meta["source"]["file"]] + [r["file"] for r in meta["references"]] \
            + list(meta["output"].values())
        for rel in paths:
            if not os.path.exists(os.path.join(sample_dir, rel)):
                print(f"  BROKEN   {sample_id}/{rel}")
                ok = False
        # "parked" names sibling dirs holding a superseded version of the page — kept on purpose
        # when a sample is swapped out, so they are expected rather than stray.
        allowed = {"source", "reference", "output", "meta.json"} | set(spec.get("parked", []))
        stray = [f for f in os.listdir(sample_dir) if f not in allowed]
        if stray:
            print(f"  STRAY    {sample_id}: {stray}")
            ok = False
    return ok


def main():
    parser = argparse.ArgumentParser(description="Migrate examples/ into role subfolders")
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST)
    parser.add_argument("--examples-dir", default=DEFAULT_EXAMPLES)
    parser.add_argument("--sample", help="Only this sample id")
    parser.add_argument("--apply", action="store_true", help="Actually move files (default: dry run)")
    parser.add_argument("--verify", action="store_true", help="Verify an already-migrated tree and exit")
    parser.add_argument("--refresh-meta", action="store_true",
                        help="Regenerate meta.json for an already-migrated tree (use after "
                             "hand-swapping a page, where --apply cannot run)")
    args = parser.parse_args()

    with open(args.manifest, encoding="utf-8") as f:
        manifest = json.load(f)

    if args.verify:
        print(f"Verifying {args.examples_dir} against {os.path.basename(args.manifest)}...")
        sys.exit(0 if verify(manifest, args.examples_dir) else 1)

    specs = manifest["samples"]
    if args.sample:
        if args.sample not in specs:
            sys.exit(f"[ERROR] {args.sample} not in manifest")
        specs = {args.sample: specs[args.sample]}

    if args.refresh_meta:
        print(f"Refreshing meta.json in {args.examples_dir} "
              f"from {os.path.basename(args.manifest)}...")
        sys.exit(0 if refresh_meta(specs, args.examples_dir) else 1)

    plans, problems = [], []
    for sample_id in sorted(specs, key=lambda s: int(s[6:])):
        plan, errs = plan_sample(sample_id, specs[sample_id], args.examples_dir)
        problems.extend(errs)
        if plan:
            plans.append((plan, specs[sample_id]))

    if problems:
        print("[ERROR] manifest does not match the tree:")
        for p in problems:
            print(f"  {p}")
        sys.exit(1)

    n_moves = sum(len(p["moves"]) for p, _ in plans)
    n_rm = sum(len(p["removals"]) for p, _ in plans)
    refused = [(p["sample_id"], r) for p, _ in plans for r in p["refused"]]

    if not args.apply:
        for plan, _ in plans:
            print(f"\n=== {plan['sample_id']}")
            for src_name, dest_rel in plan["moves"]:
                print(f"    mv  {src_name}  ->  {dest_rel}")
            for name in plan["removals"]:
                print(f"    rm  {name}")
            for name, why in plan["refused"]:
                print(f"    ??  {name}  (kept: {why})")

    print(f"\n{len(plans)} sample(s): {n_moves} move(s), {n_rm} removal(s)")
    if refused:
        print(f"{len(refused)} file(s) left in place because they could not be justified:")
        for sid, (name, why) in refused:
            print(f"  {sid}/{name} — {why}")

    if not args.apply:
        print("\nDry run. Re-run with --apply to perform it.")
        return

    for plan, spec in plans:
        apply_plan(plan, spec)
    print("\nApplied. Verifying...")
    sys.exit(0 if verify(manifest, args.examples_dir) else 1)


if __name__ == "__main__":
    main()
