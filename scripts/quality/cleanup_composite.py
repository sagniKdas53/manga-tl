#!/usr/bin/env python3
"""R3 Packet 4 §4 — the missing cleanup-only tool.

Read-only, offline-adjacent: no paid calls, no database writes, no retries. For each captured
page in a run's manifest, pulls its regions' cleanup columns through a caller-supplied `psql`
command prefix and its patch/mask PNGs from MinIO, then builds a composite with every patch
applied and no text drawn -- and measures the two things R3 Packet 4 §4 asks for.

Database and MinIO access are both taken as arguments rather than assumed to be local: on a
run whose stack has no host port for Postgres (e.g. chrome-box), pass a `psql` prefix that
execs into the container over SSH (`--psql-arg`, repeated). MinIO works the same way
(`--minio-exec-arg`, repeated) rather than through a tunneled endpoint + explicit keys: it execs
a tiny fetcher inside the *worker* container, which already holds a working MinIO credential
(`minio:9000` on the compose network, secret at `/run/secrets/minio_password`) -- reusing that
proven path turned out to be far more robust than re-deriving `access_key`/`secret_key` and a
tunneled endpoint for a from-scratch minio-py client, which hit persistent SignatureDoesNotMatch
errors through the SSH-forwarded port for reasons never fully isolated (the same credential
worked immediately from inside the container). No MinIO secret ever has to touch this script's
own arguments or environment.

The composite pastes each region's patch PNG at its own pixel dimensions, at its declared
bounds' (x, y) -- not resized to the declared width/height. That makes the outside-support
invariance check a real defect detector for a patch whose actual size does not match what it
claims (spills outside the declared-bounds union) rather than a tautology that is 0 by
construction of a resize-to-fit compositor. It cannot see the pipeline's own renderer diverge
from this script's own compositing, since no separately-rendered background artifact is part
of this packet's inputs -- see the run README's caveats.

Residual ink is measured under each patch's own alpha, so glyphs the cleanup mask never covered
score 0 % (AUDIT-R25), and damage to art inside a patch is not measured at all (AUDIT-R24). A clean
number here does not replace looking at `cleanup-only.png`.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

import cv2
import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "worker" / "src"))

from worker.config import CTD_CONF_THRESHOLD
from worker.services.cleanup_reconstruct import _residual_ink_pct


def run_psql(psql_argv: list[str], sql: str) -> list[dict]:
    """Run one statement through the given psql prefix, via stdin; each stdout line is one JSON row.

    SQL goes over stdin rather than as an argv element (`-c`) so a prefix that tunnels through
    `ssh host docker exec -i <container> psql ...` never has to shell-quote it -- ssh joins argv
    with plain spaces, so any `-c "<sql>"` embedded quoting breaks the moment the SQL contains its
    own quotes or parens. Expects the prefix to end in unaligned/tuples-only flags (`-At`, no
    `-c`) so each `row_to_json(t)` row lands on its own stdout line.
    """
    result = subprocess.run(psql_argv, input=sql, capture_output=True, text=True, check=True)
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


# Runs inside the *worker* container (`python3 -`, script on stdin, key as the one argv element
# a shell-joining `ssh ... docker exec` prefix can safely carry -- object keys are
# content-addressed hex/UUID paths with no shell metacharacters, so no quoting is needed for them
# the way it would be for a SQL statement). Constants match every dev/quality stack's compose file
# (docker-compose.dev.yml): internal DNS name, fixed bucket, and the docker-secrets-mounted
# password file -- none of it is this run's own secret material.
_MINIO_FETCH_SCRIPT = """
import sys
from minio import Minio

client = Minio(
    "minio:9000",
    access_key="minioadmin",
    secret_key=open("/run/secrets/minio_password").read().strip(),
    secure=False,
)
response = client.get_object("manga-library", sys.argv[1])
try:
    sys.stdout.buffer.write(response.read())
finally:
    response.close()
    response.release_conn()
"""


def fetch_minio_via_exec(exec_argv: list[str], key: str) -> bytes:
    """Fetch one object's bytes by running the fetch script inside the worker container.

    `exec_argv` must end in `... docker exec -i <worker-container> python3 -` so the script can
    ride stdin and `key` can be the sole trailing argv element.
    """
    result = subprocess.run(
        [*exec_argv, key], input=_MINIO_FETCH_SCRIPT.encode(), capture_output=True, check=True
    )
    return result.stdout


def decode_bgra(data: bytes) -> np.ndarray:
    arr = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if arr is None:
        raise ValueError("failed to decode PNG asset")
    if arr.ndim == 2:
        arr = cv2.cvtColor(arr, cv2.COLOR_GRAY2BGRA)
    elif arr.shape[2] == 3:
        arr = cv2.cvtColor(arr, cv2.COLOR_BGR2BGRA)
    return arr


def diagnostics_code(region: dict) -> str | None:
    """Coarse code only -- never the diagnostic text (R3 Packet 4 §4; may echo OCR'd dialogue)."""
    if region.get("cleanup_patch_asset_id"):
        return None
    diagnostics = region.get("cleanup_diagnostics") or []
    joined = " ".join(diagnostics) if isinstance(diagnostics, list) else str(diagnostics)
    if region.get("qa_status") == "cleanup_review":
        return "uncertain"
    if "excluded by immutable policy" in joined:
        return "excluded"
    if diagnostics:
        return "failed"
    return None


def composite_page(
    source_bgr: np.ndarray,
    regions: list[dict],
    fetch_patch: Callable[[str], bytes],
) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """Paste every region's own patch verbatim at its own bounds.

    Returns (composite BGR, union-of-supports boolean mask, per-region report rows). `fetch_patch`
    takes a `cleanup_patch_sha256` and returns the patch PNG's bytes (the caller owns the actual
    MinIO/bucket lookup so this stays testable without a live store).
    """
    h, w = source_bgr.shape[:2]
    composite = source_bgr.copy()
    support = np.zeros((h, w), dtype=bool)
    rows: list[dict] = []
    for region in regions:
        row: dict[str, Any] = {
            "id": region.get("id"),
            "status": region.get("qa_status"),
            "patched": bool(region.get("cleanup_patch_asset_id")),
            "diagnostics_code": diagnostics_code(region),
        }
        if row["patched"]:
            bounds = region.get("cleanup_bounds") or {}
            x, y = int(bounds.get("x", 0)), int(bounds.get("y", 0))
            declared_w, declared_h = int(bounds.get("width", 0)), int(bounds.get("height", 0))
            row["bounds"] = {"x": x, "y": y, "width": declared_w, "height": declared_h}
            patch = decode_bgra(fetch_patch(region["cleanup_patch_sha256"]))
            ph, pw = patch.shape[:2]
            row["patch_pixel_size"] = {"width": pw, "height": ph}
            row["bounds_mismatch"] = (pw, ph) != (declared_w, declared_h)
            y1, x1 = min(h, y + ph), min(w, x + pw)
            if y < 0 or x < 0 or y >= h or x >= w or y1 <= y or x1 <= x:
                row["defect"] = "patch bounds fall outside the page"
                rows.append(row)
                continue
            local_mask = patch[: y1 - y, : x1 - x, 3] > 0
            composite[y:y1, x:x1][local_mask] = patch[: y1 - y, : x1 - x, :3][local_mask]
            support[y:y1, x:x1] |= local_mask
        else:
            row["bounds"] = region.get("cleanup_bounds")
        rows.append(row)
    return composite, support, rows


def outside_support_invariance(composite: np.ndarray, source: np.ndarray, support: np.ndarray) -> int:
    diff_any = cv2.absdiff(composite, source).any(axis=2)
    return int((diff_any & ~support).sum())


def residual_ink_for_region(composite: np.ndarray, patch_bgra: np.ndarray, x: int, y: int) -> float:
    ph, pw = patch_bgra.shape[:2]
    h, w = composite.shape[:2]
    y1, x1 = min(h, y + ph), min(w, x + pw)
    local_mask = patch_bgra[: y1 - y, : x1 - x, 3] > 0
    crop = composite[y:y1, x:x1]
    return _residual_ink_pct(crop, local_mask, CTD_CONF_THRESHOLD)


def load_manifest(run_dir: Path) -> dict:
    for name in ("manifest.json", "a04-manifest.partial.json", "a03-manifest.partial.json"):
        candidate = run_dir / name
        if candidate.exists():
            return json.loads(candidate.read_text())
    raise FileNotFoundError(f"no manifest found in {run_dir}")


def process_run(run_dir: Path, psql_argv: list[str], minio_exec_argv: list[str]) -> None:
    manifest = load_manifest(run_dir)
    for record in manifest.get("pages", []):
        sample = record["sample"]
        page_id = record["page_id"]
        page_rows = run_psql(
            psql_argv,
            "SELECT row_to_json(t) FROM (SELECT p.id AS page_id, i.storage_path, i.hash "
            f"FROM pages p JOIN images i ON i.id = p.image_id WHERE p.id = '{page_id}') t;",
        )
        if not page_rows:
            print(f"{sample}: page {page_id} not found in database", file=sys.stderr)
            continue
        storage_path = page_rows[0]["storage_path"]
        source = decode_bgra(fetch_minio_via_exec(minio_exec_argv, storage_path))
        source_bgr = cv2.cvtColor(source, cv2.COLOR_BGRA2BGR) if source.shape[2] == 4 else source[:, :, :3]

        regions = run_psql(
            psql_argv,
            "SELECT row_to_json(t) FROM (SELECT id, bubble_reading_order, region_type, qa_status, "
            "cleanup_patch_asset_id, cleanup_patch_sha256, cleanup_mask_asset_id, cleanup_mask_sha256, "
            "cleanup_bounds, cleanup_diagnostics FROM ocr_regions "
            f"WHERE page_id = '{page_id}' ORDER BY bubble_reading_order) t;",
        )

        def fetch_patch(sha256: str) -> bytes:
            return fetch_minio_via_exec(minio_exec_argv, f"scene-assets/{page_id}/{sha256}.png")

        composite, support, rows = composite_page(source_bgr, regions, fetch_patch)
        outside = outside_support_invariance(composite, source_bgr, support)

        residuals = []
        for region, row in zip(regions, rows):
            if not row["patched"]:
                continue
            bounds = row["bounds"]
            patch_bytes = fetch_minio_via_exec(
                minio_exec_argv, f"scene-assets/{page_id}/{region['cleanup_patch_sha256']}.png"
            )
            patch_bgra = decode_bgra(patch_bytes)
            pct = residual_ink_for_region(composite, patch_bgra, bounds["x"], bounds["y"])
            residuals.append(pct)
            row["residual_ink_pct"] = pct

        sample_dir = run_dir / "a04-exports" / sample / "cleanup"
        sample_dir.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(sample_dir / "cleanup-only.png"), composite)
        mask_png = np.zeros((*support.shape, 4), dtype=np.uint8)
        mask_png[support] = (255, 255, 255, 255)
        cv2.imwrite(str(sample_dir / "mask-union.png"), mask_png)
        (sample_dir / "regions.json").write_text(json.dumps(rows, indent=2) + "\n")
        summary = {
            "sample": sample,
            "page_id": page_id,
            "outside_support_differing_pixels": outside,
            "residual_ink_pct": {
                "min": min(residuals) if residuals else None,
                "median": sorted(residuals)[len(residuals) // 2] if residuals else None,
                "max": max(residuals) if residuals else None,
                "n": len(residuals),
            },
            "regions_by_diagnostics_code": {
                code: sum(1 for row in rows if row["diagnostics_code"] == code)
                for code in ("uncertain", "excluded", "failed")
            },
            "regions_patched": sum(1 for row in rows if row["patched"]),
            "regions_total": len(rows),
        }
        (sample_dir / "cleanup.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(f"{sample}: {json.dumps(summary)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True, type=Path, help="run directory (e.g. docs/quality-runs/$RUN-six)")
    parser.add_argument(
        "--psql-arg",
        dest="psql_argv",
        action="append",
        required=True,
        help="one argv element of the psql command prefix (e.g. ssh HOST docker exec -i CONTAINER "
        "psql -U USER -d DB -At); repeat in order. SQL is sent over stdin, not as -c.",
    )
    parser.add_argument(
        "--minio-exec-arg",
        dest="minio_exec_argv",
        action="append",
        required=True,
        help="one argv element of the MinIO fetch prefix (e.g. ssh HOST docker exec -i "
        "WORKER-CONTAINER python3 -); repeat in order. The fetch script rides stdin, and the "
        "object key is appended as the sole trailing argv element per call.",
    )
    args = parser.parse_args()

    process_run(args.run, args.psql_argv, args.minio_exec_argv)


if __name__ == "__main__":
    main()
