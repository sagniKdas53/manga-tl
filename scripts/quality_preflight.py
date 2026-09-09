#!/usr/bin/env python3
"""Fail-fast service and provenance preflight for a quality run.

The Compose project used here is isolated and disposable. This command never
reads or writes the production database, Redis instance, or object storage.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPOSE_FILE = ROOT / "scripts/quality-test-deps.yml"
PROJECT = "manga-quality-preflight"
PORTS = {"db": 55590, "redis": 56490, "minio": 19190}


def run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=check)


def compose(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(["docker", "compose", "-p", PROJECT, "-f", str(COMPOSE_FILE), *args], check=check)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_head(path: Path) -> str | None:
    result = subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"], text=True, capture_output=True)
    return result.stdout.strip() if result.returncode == 0 else None


def inventory() -> dict:
    hashes = []
    for root in (ROOT / "data", ROOT / "worker", ROOT / "frontend"):
        if not root.exists():
            continue
        for path in sorted(root.rglob("*")):
            if any(part.startswith("pytest-of-") for part in path.parts):
                continue
            if path.is_file() and path.suffix.lower() in {".onnx", ".ttf", ".otf", ".woff", ".woff2", ".safetensors"}:
                try:
                    hashes.append({"path": str(path.relative_to(ROOT)), "sha256": sha256(path), "bytes": path.stat().st_size})
                except OSError:
                    continue
    hardware = {"platform": platform.platform(), "machine": platform.machine(), "python": platform.python_version()}
    for command, key in ((["lscpu"], "lscpu"), (["free", "-h"], "memory"), (["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"], "gpu")):
        if shutil.which(command[0]):
            result = subprocess.run(command, text=True, capture_output=True, check=False)
            hardware[key] = result.stdout.strip() if result.returncode == 0 else f"unavailable: {result.stderr.strip()}"
        else:
            hardware[key] = "command unavailable"
    heads = {"app": git_head(ROOT), "worker": git_head(ROOT / "worker"), "corpus": git_head(ROOT / "corpus")}
    return {"heads": heads, "hardware": hardware, "model_font_hashes": hashes}


def check_services() -> dict:
    token = f"quality-preflight-{uuid.uuid4()}"
    result: dict[str, object] = {"sentinel": token, "services": {}}
    db = compose("exec", "-T", "db", "psql", "-U", "quality_test", "-d", "quality_test", "-v", "ON_ERROR_STOP=1", "-tAc", f"CREATE TABLE IF NOT EXISTS quality_preflight (token text primary key); INSERT INTO quality_preflight VALUES ('{token}'); SELECT token FROM quality_preflight WHERE token = '{token}';")
    db_value = db.stdout.strip().splitlines()[-1] if db.stdout.strip() else ""
    result["services"]["db"] = {"connected": db_value == token, "sentinel_readback": db_value == token}
    redis = compose("exec", "-T", "redis", "valkey-cli", "SET", token, "ok", "EX", "60")
    redis_get = compose("exec", "-T", "redis", "valkey-cli", "GET", token)
    result["services"]["redis"] = {"connected": redis.stdout.strip() == "OK" and redis_get.stdout.strip() == "ok"}
    curl = shutil.which("curl")
    storage = {"connected": False, "note": "curl unavailable"}
    if curl:
        health = subprocess.run([curl, "-fsS", f"http://127.0.0.1:{PORTS['minio']}/minio/health/live"], text=True, capture_output=True, check=False)
        storage = {"connected": health.returncode == 0, "health_endpoint": "/minio/health/live"}
        if health.returncode:
            storage["error"] = health.stderr.strip()
    result["services"]["storage"] = storage
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, help="write JSON provenance report to this path")
    parser.add_argument("--keep-up", action="store_true", help="leave isolated services running for integration tests")
    parser.add_argument("--down", action="store_true", help="stop the isolated project and exit")
    args = parser.parse_args()
    if args.down:
        return compose("down", "-v", "--remove-orphans", check=False).returncode
    if not shutil.which("docker"):
        print("quality preflight: docker is required", file=sys.stderr)
        return 2
    config = compose("config", check=False)
    if config.returncode:
        print("quality preflight: isolated Compose config is invalid\n" + config.stderr, file=sys.stderr)
        return 2
    report = {"started_at": datetime.now(timezone.utc).isoformat(), **inventory()}
    up = compose("up", "-d", "--wait", check=False)
    if up.returncode:
        print("quality preflight: DB/Redis/storage did not become healthy\n" + up.stderr, file=sys.stderr)
        report["preflight"] = {"passed": False, "startup_error": up.stderr.strip()}
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, indent=2) + "\n")
        return 1
    try:
        checks = check_services()
        report["preflight"] = {"passed": all(s.get("connected") for s in checks["services"].values()), **checks}
    finally:
        if not args.keep_up:
            compose("down", "-v", "--remove-orphans", check=False)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    if report["preflight"]["passed"]:
        print("quality preflight: PASS (isolated DB sentinel, Redis, and storage verified)")
        return 0
    print("quality preflight: FAIL (service connectivity or sentinel check failed)", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
