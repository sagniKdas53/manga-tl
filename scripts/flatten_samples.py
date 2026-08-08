#!/usr/bin/env python3
"""
flatten_samples.py — One-time migration of corpus/samples/ from the role-subfolder layout
into a flat one, driven by scripts/examples_manifest.json.

Before (what organize_examples.py produced), and the reason this exists — reaching a page cost
three or four levels and a filename you could not guess:

    corpus/samples/sample34/source/GsdYUt8b0AUpzsE.jpg
    corpus/samples/sample34/reference/HPAP_YkakAAYNwp.jpg
    corpus/samples/sample20/do-not-use-poor-quailty/source/HN5-X5UaoAAOOhE.jpeg

After — one directory per sample, every name derivable from the role:

    corpus/samples/sampleN/
      meta.json
      source.<ext>                  the source-language page
      ref-<provenance>.<ext>        0..n human / competitor renders
      ref-unknown-<n>.<ext>         ...where the provenance was never recorded
      export.<ext>                  was output/frontend-export.png
      render.<ext>                  was output/worker-render.png
      project.zip                   was output/project.zip
      project/                      NEW — project.zip unpacked, so the layers are greppable
      legacy-bench/                 sample5 and sample18 only, moved up from output/

    corpus/samples/NSFW/sampleN/    same shape, one level deeper (kept separate so the whole
                                    NSFW half can be excluded wholesale)
    corpus/samples/_parked/         superseded pages, moved out of the sample dirs so nothing
                                    sits four levels down. Contents left as they were.

Extensions are preserved — source.jpeg and source.png both occur. Normalising them would mean
re-encoding, which changes bytes and silently invalidates every OCR result derived from them.

project.zip is kept alongside project/: it is the artifact the frontend emits, and re-zipping
the unpacked tree would not reproduce it byte-for-byte.

Moves go through `git mv`, so history follows each file. Refuses to run on a dirty tree — a
half-applied migration mixed with unrelated edits is not something you can unpick afterwards.

Dry run by default; nothing moves until you pass --apply.

Usage:
    python scripts/flatten_samples.py                    # show the plan
    python scripts/flatten_samples.py --apply
    python scripts/flatten_samples.py --apply --sample sample34
    python scripts/flatten_samples.py --verify           # check an already-flattened tree
    python scripts/flatten_samples.py --hash-manifest before.txt   # for the lossless gate
"""

import os
import re
import sys
import json
import shutil
import hashlib
import zipfile
import argparse
import subprocess
import collections

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
DEFAULT_MANIFEST = os.path.join(SCRIPT_DIR, "examples_manifest.json")
DEFAULT_SAMPLES = os.path.join(REPO_ROOT, "corpus", "samples")

OUTPUT_TARGETS = {"frontend_export": "export", "worker_render": "render", "project": "project"}

# The names organize_examples.py canonicalised outputs to. The SFW half went through it, so on
# disk those files are output/frontend-export.png — while the manifest still records the raw
# download name (page-1-export(3).png) the NSFW half still has. Both are accepted.
OLD_CANON = {"frontend_export": "frontend-export.png",
             "worker_render": "worker-render.png",
             "project": "project.zip"}

# Where a file might be found before migration: role subdirs (the SFW half, already migrated
# once by organize_examples.py) or flat at the top (the NSFW half, never migrated).
SEARCH_DIRS = ("", "source", "reference", "output", os.path.join("output", "legacy-bench"))

PARKED = {
    "sample20/do-not-use-poor-quailty": "_parked/sample20-do-not-use-poor-quailty",
    "sample21/do-not-use-wrong-language": "_parked/sample21-do-not-use-wrong-language",
}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ext_of(name):
    return os.path.splitext(name)[1].lower()


def sample_sort_key(sid):
    """sample7 < sample30 < NSFW/sample7 — numeric within each half, SFW first."""
    return (1 if sid.startswith("NSFW/") else 0, int(re.sub(r"\D", "", sid.split("/")[-1])))


def locate(sample_dir, names, claimed=()):
    """Find a file that may still be in a role subdir, or already flat, under any of the given
    names. Returns a path relative to sample_dir, or None.

    `claimed` holds paths already taken by an earlier role. sample21 carries the same filename
    in both source/ and reference/ — without this the source would be matched twice and the
    reference never found.
    """
    for name in names:
        for d in SEARCH_DIRS:
            rel = os.path.join(d, name) if d else name
            if rel in claimed:
                continue
            if os.path.isfile(os.path.join(sample_dir, rel)):
                return rel
    return None


def resolve(sample_dir, spec):
    """Work out, for one sample, where each role's file currently is and what it should be called.

    Returns ([(current_relpath, target_name)], {role_key: target_name}, [problems]). The role
    map is what meta.json is written from, keyed by the manifest's own name for the file so the
    caller can line the two up.
    """
    found, targets, problems = [], {}, []
    claimed = set()

    def take(key, target_stem, *candidates):
        # The already-flattened name is always a candidate, so re-running is a no-op rather than
        # an error. This is what makes the script double as the meta.json refresher: drop a
        # replacement page in as source.png, update the manifest, re-run.
        already = sorted(f for f in os.listdir(sample_dir)
                         if f.startswith(target_stem + ".")
                         and os.path.isfile(os.path.join(sample_dir, f)))
        rel = locate(sample_dir, list(candidates) + already, claimed)
        if rel is None:
            problems.append(f"{candidates[0]!r} not found in any known location")
            return
        claimed.add(rel)
        target = target_stem + ext_of(rel)
        found.append((rel, target))
        targets[key] = target

    take("__source__", "source", spec["source"]["file"])

    unknown_n = 0
    for i, ref in enumerate(spec["references"]):
        prov = ref.get("provenance") or "unknown"
        if prov == "unknown":
            unknown_n += 1
            stem = f"ref-unknown-{unknown_n}"
        else:
            stem = f"ref-{prov}"
        take(f"__ref__{i}", stem, ref["file"])

    for role, name in spec["output"].items():
        take(role, OUTPUT_TARGETS[role], name, OLD_CANON[role])

    counts = collections.Counter(t for _, t in found)
    dupes = [t for t, c in counts.items() if c > 1]
    if dupes:
        problems.append(f"target name collision: {dupes}")

    return found, targets, problems


def plan_sample(sample_id, spec, samples_dir):
    sample_dir = os.path.join(samples_dir, sample_id)
    if not os.path.isdir(sample_dir):
        return None, [f"{sample_id}: directory not found"]

    found, targets, errs = resolve(sample_dir, spec)
    problems = [f"{sample_id}: {e}" for e in errs]
    if problems:
        return None, problems

    moves = [(rel, target) for rel, target in found if rel != target]

    # legacy-bench moves up a level, keeping its own filenames.
    legacy_old = os.path.join(sample_dir, "output", "legacy-bench")
    if os.path.isdir(legacy_old):
        for name in sorted(os.listdir(legacy_old)):
            moves.append((os.path.join("output", "legacy-bench", name),
                          os.path.join("legacy-bench", name)))

    return {
        "sample_id": sample_id,
        "dir": sample_dir,
        "moves": moves,
        "targets": targets,
        "extract": targets.get("project"),
    }, problems


def git(repo_root, *args):
    r = subprocess.run(["git", "-C", repo_root, *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"[ABORT] git {' '.join(args)}\n{r.stderr.strip()}")
    return r.stdout


def build_meta(sample_id, spec, targets):
    return {
        "sample_id": sample_id,
        "sfw": spec.get("sfw", True),
        "source": {"file": targets["__source__"], "lang": spec["source"]["lang"]},
        "references": [{**ref, "file": targets[f"__ref__{i}"]}
                       for i, ref in enumerate(spec["references"])],
        "output": {role: targets[role] for role in spec["output"] if role in targets},
        "notes": spec.get("notes", ""),
    }


def write_meta(sample_dir, sample_id, spec, targets):
    with open(os.path.join(sample_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(build_meta(sample_id, spec, targets), f, ensure_ascii=False, indent=2)
        f.write("\n")


def apply_plan(plan, spec, repo_root):
    sample_dir = plan["dir"]
    rel_sample = os.path.relpath(sample_dir, repo_root)

    for src_rel, dest_rel in plan["moves"]:
        dest_abs = os.path.join(sample_dir, dest_rel)
        if os.path.exists(dest_abs):
            raise SystemExit(f"[ABORT] {dest_abs} already exists — refusing to overwrite")
        os.makedirs(os.path.dirname(dest_abs), exist_ok=True)
        git(repo_root, "mv", os.path.join(rel_sample, src_rel), os.path.join(rel_sample, dest_rel))

    # Role dirs are empty now; git mv leaves the directories behind.
    for d in ("source", "reference", os.path.join("output", "legacy-bench"), "output"):
        p = os.path.join(sample_dir, d)
        if os.path.isdir(p) and not os.listdir(p):
            os.rmdir(p)

    write_meta(sample_dir, plan["sample_id"], spec, plan["targets"])


def extract_zip(sample_dir, zip_name):
    """Unpack project.zip into project/. Skips silently if already unpacked."""
    zip_path = os.path.join(sample_dir, zip_name)
    dest = os.path.join(sample_dir, "project")
    if not os.path.isfile(zip_path):
        return 0
    os.makedirs(dest, exist_ok=True)
    n = 0
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            # Flatten any directory structure and refuse absolute/traversing names.
            name = os.path.basename(info.filename)
            if not name:
                continue
            out = os.path.join(dest, name)
            if os.path.exists(out):
                continue
            with z.open(info) as src, open(out, "wb") as dst:
                shutil.copyfileobj(src, dst)
            n += 1
    return n


def park(samples_dir, repo_root, apply):
    """Move the superseded page dirs out of the sample dirs. Contents left untouched."""
    done = []
    for old, new in PARKED.items():
        src = os.path.join(samples_dir, old)
        dst = os.path.join(samples_dir, new)
        if not os.path.isdir(src):
            continue
        done.append((old, new))
        if apply:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            git(repo_root, "mv",
                os.path.relpath(src, repo_root), os.path.relpath(dst, repo_root))
    return done


def verify(manifest, samples_dir):
    """Every meta.json path resolves, and nothing unexpected is left in a sample dir."""
    ok = True
    parked_names = set()
    for spec in PARKED.values():
        parked_names.add(spec.split("/")[-1])

    for sample_id, spec in sorted(manifest["samples"].items(), key=lambda kv: sample_sort_key(kv[0])):
        sample_dir = os.path.join(samples_dir, sample_id)
        meta_path = os.path.join(sample_dir, "meta.json")
        if not os.path.isfile(meta_path):
            print(f"  MISSING meta.json  {sample_id}")
            ok = False
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)

        expected = {"meta.json"}
        paths = [meta["source"]["file"]] + [r["file"] for r in meta["references"]] \
            + list(meta["output"].values())
        for rel in paths:
            expected.add(rel)
            if not os.path.exists(os.path.join(sample_dir, rel)):
                print(f"  BROKEN   {sample_id}/{rel}")
                ok = False

        if os.path.isdir(os.path.join(sample_dir, "project")):
            expected.add("project")
        if os.path.isdir(os.path.join(sample_dir, "legacy-bench")):
            expected.add("legacy-bench")

        stray = [f for f in os.listdir(sample_dir) if f not in expected]
        if stray:
            print(f"  STRAY    {sample_id}: {stray}")
            ok = False

        depth_bad = [rel for rel in paths if os.sep in rel]
        if depth_bad:
            print(f"  NESTED   {sample_id}: {depth_bad}")
            ok = False

    # NSFW/ and _parked/ are directories, not samples — everything else at the top of samples/
    # must be a sample dir named in the manifest.
    top_expected = {sid.split("/")[0] for sid in manifest["samples"]} | {"_parked"}
    stray_top = [f for f in os.listdir(samples_dir) if f not in top_expected]
    if stray_top:
        print(f"  STRAY    samples/: {stray_top}")
        ok = False
    return ok


def hash_manifest(samples_dir, out_path):
    """Every file hash except meta.json (rewritten by design) and project/ (created by
    extraction). Diffing before/after proves the migration moved bytes and changed none."""
    lines = []
    for root, dirs, files in os.walk(samples_dir):
        dirs[:] = [d for d in dirs if d != "project"]
        for f in files:
            if f == "meta.json":
                continue
            lines.append(sha256(os.path.join(root, f)))
    lines.sort()
    with open(out_path, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    return len(lines)


def main():
    parser = argparse.ArgumentParser(description="Flatten corpus/samples/ into one dir per sample")
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST)
    parser.add_argument("--samples-dir", default=DEFAULT_SAMPLES)
    parser.add_argument("--sample", help="Only this sample id (e.g. sample34 or NSFW/sample3)")
    parser.add_argument("--apply", action="store_true", help="Actually move files (default: dry run)")
    parser.add_argument("--verify", action="store_true", help="Verify an already-flattened tree")
    parser.add_argument("--hash-manifest", metavar="PATH",
                        help="Write a sorted hash list of every sample file and exit")
    parser.add_argument("--no-extract", action="store_true", help="Skip unpacking project.zip")
    args = parser.parse_args()

    samples_dir = os.path.abspath(args.samples_dir)
    repo_root = os.path.dirname(samples_dir)

    if args.hash_manifest:
        n = hash_manifest(samples_dir, args.hash_manifest)
        print(f"{n} file hashes -> {args.hash_manifest}")
        return

    with open(args.manifest, encoding="utf-8") as f:
        manifest = json.load(f)

    if args.verify:
        print(f"Verifying {samples_dir} against {os.path.basename(args.manifest)}...")
        sys.exit(0 if verify(manifest, samples_dir) else 1)

    specs = manifest["samples"]
    if args.sample:
        if args.sample not in specs:
            sys.exit(f"[ERROR] {args.sample} not in manifest")
        specs = {args.sample: specs[args.sample]}

    if args.apply and git(repo_root, "status", "--porcelain", "--", "samples").strip():
        sys.exit("[ABORT] samples/ has uncommitted changes — commit or stash them first, so a "
                 "half-applied migration can be told apart from unrelated edits.")

    plans, problems = [], []
    for sample_id in sorted(specs, key=sample_sort_key):
        plan, errs = plan_sample(sample_id, specs[sample_id], samples_dir)
        problems.extend(errs)
        if plan:
            plans.append((plan, specs[sample_id]))

    if problems:
        print("[ERROR] manifest does not match the tree:")
        for p in problems:
            print(f"  {p}")
        sys.exit(1)

    parked = park(samples_dir, repo_root, apply=False)
    n_moves = sum(len(p["moves"]) for p, _ in plans)

    if not args.apply:
        for plan, _ in plans:
            if not plan["moves"]:
                continue
            print(f"\n=== {plan['sample_id']}")
            for src_rel, dest_rel in plan["moves"]:
                print(f"    mv  {src_rel}  ->  {dest_rel}")
        for old, new in parked:
            print(f"\n=== parked\n    mv  {old}  ->  {new}")
        print(f"\n{len(plans)} sample(s): {n_moves} move(s), {len(parked)} parked dir(s)")
        print("Dry run. Re-run with --apply to perform it.")
        return

    for plan, spec in plans:
        apply_plan(plan, spec, repo_root)
    park(samples_dir, repo_root, apply=True)

    extracted = 0
    if not args.no_extract:
        for plan, _ in plans:
            if plan["extract"]:
                extracted += extract_zip(plan["dir"], plan["extract"])

    print(f"Applied: {n_moves} move(s), {len(parked)} parked dir(s), "
          f"{extracted} file(s) unpacked from project zips.")
    print("\nVerifying...")
    sys.exit(0 if verify(manifest, samples_dir) else 1)


if __name__ == "__main__":
    main()
