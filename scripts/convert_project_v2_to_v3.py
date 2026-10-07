#!/usr/bin/env python3
"""Convert a page-project ZIP from schemaVersion 2 to 3, so it imports again.

F3 (#178) added layer groups, and the importer refuses version 2 (owner, 2026-10-07). A version 2
file simply has no groups, so converting it only rewrites `project.json`'s version: every layer
stays at the top level with no `parentId`. Every other entry (the page image, `cleanup/*.png`) is
copied byte for byte.

Usage:
  python3 scripts/convert_project_v2_to_v3.py page-22-project.zip            # writes page-22-project.v3.zip
  python3 scripts/convert_project_v2_to_v3.py in.zip -o out.zip
  python3 scripts/convert_project_v2_to_v3.py archives/*.zip                 # one .v3.zip beside each

Exit status is 1 if any archive could not be converted. Nothing is overwritten.
"""

import argparse
import json
import os
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path


def publish(partial: Path, target: Path) -> None:
    """Put the finished file at `target`, failing if something is already there (even one made
    since the check in `convert`): a hard link is created atomically and never replaces a file. Where
    hard links are not supported, an exclusive create and a copy."""
    try:
        os.link(partial, target)
    except FileExistsError:
        raise ValueError(f"{target} already exists; not overwriting it") from None
    except OSError:
        with open(target, "xb") as out, open(partial, "rb") as source:
            shutil.copyfileobj(source, out)


def convert(source: Path, target: Path) -> str:
    """Write the version 3 copy of `source` to `target`; returns what was done."""
    if target.exists():
        raise ValueError(f"{target} already exists; not overwriting it")
    with zipfile.ZipFile(source) as archive:
        names = archive.namelist()
        project_names = [name for name in names if name == "project.json" or name.endswith("/project.json")]
        if len(project_names) != 1:
            raise ValueError(f"expected one project.json, found {len(project_names)}")
        project = json.loads(archive.read(project_names[0]))
        version = project.get("schemaVersion")
        if version == 3:
            return "already version 3, skipped"
        if version != 2:
            raise ValueError(f"schemaVersion {version!r} cannot be converted (only 2 is)")
        layers = project.get("layers") or []
        if not isinstance(layers, list) or not all(isinstance(layer, dict) for layer in layers):
            raise ValueError("project.json's layers must be a list of objects")
        project["schemaVersion"] = 3
        for layer in layers:
            layer.pop("parentId", None)
        # Written beside the target and moved into place only once every entry is copied, so a
        # failure (a bad CRC in a later entry) leaves no partial file to block the next attempt.
        handle, partial = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".part", dir=target.parent)
        os.close(handle)
        try:
            with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED) as out:
                for info in archive.infolist():
                    if info.filename == project_names[0]:
                        out.writestr(info.filename, json.dumps(project, indent=2, ensure_ascii=False))
                    else:
                        # By its ZipInfo, so two entries with one name keep their own bytes.
                        out.writestr(info, archive.read(info))
            os.chmod(partial, 0o644)  # mkstemp makes it owner-only
            publish(Path(partial), target)
        finally:
            Path(partial).unlink(missing_ok=True)
    return f"converted -> {target}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("archives", nargs="+", type=Path)
    parser.add_argument("-o", "--output", type=Path, help="output path (one input only)")
    args = parser.parse_args()
    if args.output and len(args.archives) != 1:
        parser.error("-o takes one input archive")
    failed = 0
    for source in args.archives:
        target = args.output or source.with_suffix(".v3.zip")
        try:
            print(f"{source}: {convert(source, target)}")
        except (ValueError, OSError, zipfile.BadZipFile, json.JSONDecodeError) as err:
            failed += 1
            print(f"{source}: not converted: {err}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
