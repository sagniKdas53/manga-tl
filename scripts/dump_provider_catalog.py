#!/usr/bin/env python3
"""Write the worker's refreshed provider catalog back to config/providers.json.

The worker refreshes prices and free-model lists on a timer and keeps the result in Redis
(``worker/src/worker/services/catalog_refresh.py``); nothing commits it. When a refreshed
catalog should become the checked-in default, run this, read the diff, and commit by hand::

    python scripts/dump_provider_catalog.py            # preview the diff
    python scripts/dump_provider_catalog.py --apply    # write config/providers.json

Redis is read through ``docker compose exec redis redis-cli`` so no Python package is needed;
pass ``--redis-url`` to use redis-py against another host instead.
"""

from __future__ import annotations

import argparse
import difflib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config" / "providers.json"
DOCUMENT_KEY = "system:providers:document"
REPORT_KEY = "system:providers:catalog-refresh"


def read_key(key: str, redis_url: str | None) -> str | None:
    if redis_url:
        import redis  # optional; only for --redis-url

        value = redis.Redis.from_url(redis_url).get(key)
        return value.decode("utf-8") if isinstance(value, bytes) else value
    result = subprocess.run(
        ["docker", "compose", "exec", "-T", "redis", "redis-cli", "--raw", "GET", key],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    value = result.stdout.rstrip("\n")
    return value or None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="write the refreshed catalog to --config")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--redis-url", help="e.g. redis://127.0.0.1:6379/0; default reads through docker compose")
    args = parser.parse_args()

    try:
        raw = read_key(DOCUMENT_KEY, args.redis_url)
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"could not read Redis: {error}", file=sys.stderr)
        return 1
    if not raw:
        print(f"{DOCUMENT_KEY} is empty: the worker has not completed a catalog refresh yet.", file=sys.stderr)
        report = read_key(REPORT_KEY, args.redis_url)
        if report:
            print(f"last refresh report: {report}", file=sys.stderr)
        return 1

    stored = json.loads(raw)
    document = stored.get("document")
    if not isinstance(document, dict):
        print(f"{DOCUMENT_KEY} does not hold a providers.json object", file=sys.stderr)
        return 1

    new_text = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
    old_text = args.config.read_text(encoding="utf-8") if args.config.exists() else ""
    if old_text == new_text:
        print(f"{args.config} already matches the refresh from {stored.get('refreshedAt')}.")
        return 0

    sys.stdout.writelines(
        difflib.unified_diff(
            old_text.splitlines(keepends=True),
            new_text.splitlines(keepends=True),
            fromfile=str(args.config),
            tofile=f"refresh {stored.get('refreshedAt')}",
        )
    )
    if not args.apply:
        print("\nDry run; re-run with --apply to write the file, then review and commit it.")
        return 0
    args.config.write_text(new_text, encoding="utf-8")
    print(f"\nWrote {args.config}. Review the diff and commit it by hand.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
