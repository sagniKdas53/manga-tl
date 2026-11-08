"""CI rule: a PR that can move text or regroup it must add a row to the layout ledger.

The ledger is how a regression gets traced to its source, and it only works if every such change is
in it. The worker pin counts, so a dependency bump gets a row too. A PR that touches these paths with
no effect on layout takes the `no-layout-effect` label, which keeps that claim visible on the PR.

    python3 scripts/quality/check_ledger_row.py --base <sha> --labels "$LABELS" [--github-output <file>]
"""

import argparse
import json
import re
import subprocess
import sys

LEDGER = "docs/quality-runs/layout-regression/README.md"
LABEL = "no-layout-effect"
AFFECTING_PREFIXES = (
    "packages/page-scene/",
    "services/page-renderer/src/",
    "scripts/quality/fixtures/layout-fixture.json",
)
AFFECTING_FILES = {
    "worker",
    "services/page-renderer/fonts.json",
    "services/page-renderer/Dockerfile",
    "services/page-renderer/package-lock.json",
    "backend-rust/src/page_scene_builder.rs",
}
# The layout check's own tooling: a change here runs the check, so a broken check can't merge, but
# needs no ledger row, since it can't move text on a page.
CHECK_TOOLING = {"scripts/quality/layout_ci.cjs", ".github/workflows/ci-layout.yml"}
COORDINATOR = "backend-rust/src/jobs/coordinator.rs"
# coordinator.rs is large, so only changes to its text-box code count.
COORDINATOR_WORDS = re.compile(
    r"text_box|safe_text|region_for_layout|grow_into|grown_into|kept_on_outline|outline_x_extent|free_text"
    r"|textRoom|OUTLINE_|NEIGHBOUR_OVERLAP|glued_|cut_at_gaps|own_balloon|source_text_box"
)


def affecting(paths, coordinator_patch):
    """The changed paths that can move text or regroup it."""
    found = [path for path in paths if path in AFFECTING_FILES or path.startswith(AFFECTING_PREFIXES)]
    changed_lines = [
        line
        for line in coordinator_patch.splitlines()
        if line[:1] in "+-" and line[:3] not in ("+++", "---")
    ]
    if any(COORDINATOR_WORDS.search(line) for line in changed_lines):
        found.append(COORDINATOR)
    return found


def runs_layout_check(paths, found):
    """True when the layout check must run: layout can change, or the check itself did."""
    return bool(found) or any(path in CHECK_TOOLING for path in paths)


def added_a_row(ledger_patch):
    """True when the patch adds a table row to the ledger, not only prose."""
    return any(re.match(r"^\+\| *\d+ *\|", line) for line in ledger_patch.splitlines())


def verdict(paths, coordinator_patch, ledger_patch, labels):
    """(affecting paths, failure message or None)."""
    found = affecting(paths, coordinator_patch)
    if not found or LABEL in labels or added_a_row(ledger_patch):
        return found, None
    return found, (
        f"These can move text or regroup it: {', '.join(found)}. Add a row to the table in {LEDGER}, "
        f"with what it was checked on. If it truly has no effect on layout, add the `{LABEL}` label."
    )


def git(*args):
    return subprocess.check_output(["git", *args], text=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--base", required=True)
    ap.add_argument("--labels", default="[]", help="the PR's label names, as a JSON list")
    ap.add_argument("--github-output")
    args = ap.parse_args()

    paths = git("diff", "--name-only", f"{args.base}...HEAD").split()
    found, failure = verdict(
        paths,
        git("diff", f"{args.base}...HEAD", "--", COORDINATOR),
        git("diff", f"{args.base}...HEAD", "--", LEDGER),
        json.loads(args.labels),
    )
    if args.github_output:
        with open(args.github_output, "a") as handle:
            handle.write(f"run_layout_check={'true' if runs_layout_check(paths, found) else 'false'}\n")
    print(f"Layout-affecting paths: {found or 'none'}")
    if failure:
        print(f"::error::{failure}")
        return 1
    print("Ledger rule passes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
