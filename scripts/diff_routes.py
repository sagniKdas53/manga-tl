#!/usr/bin/env python3
"""Route-table drift check: ported Rust routes must be a subset of the frozen contract.

golden-routes.txt is exported from the running Java backend (spec/). PORTED lists what the
Rust backend serves today. The gate fails if anything ported is NOT in the golden file
(contract drift). It also reports migration progress. At cutover, PORTED must equal ALL.
"""

import sys
from pathlib import Path

GOLDEN = Path(__file__).parent.parent / "backend-rust" / "spec" / "golden-routes.txt"

# "METHOD path" entries the Rust backend serves today (keep in sync with src/routes/).
PORTED = {
    # health (actuator paths are not part of the OpenAPI spec)
    "GET /actuator/health",
    "GET /actuator/health/liveness",
    "GET /actuator/health/readiness",
    # auth (Phase 2)
    "GET /api/auth/setup-required",
    "POST /api/auth/register",
    "POST /api/auth/login",
    "GET /api/auth/me",
    "PUT /api/auth/me",
    "DELETE /api/auth/me",
    "POST /api/auth/refresh",
    "POST /api/auth/change-password",
}


def main() -> int:
    golden = set()
    for line in GOLDEN.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        method, rest = line.split(maxsplit=1)
        path = rest.split()[0] if " " in rest else rest
        golden.add(f"{method} {path}")

    drift = sorted(
        PORTED
        - golden
        - {
            "GET /actuator/health",
            "GET /actuator/health/liveness",
            "GET /actuator/health/readiness",
        }
    )
    if drift:
        print("CONTRACT DRIFT — ported routes missing from golden spec:")
        for route in drift:
            print(f"  {route}")
        return 1

    total = len(golden)
    done = sum(1 for g in golden if g in PORTED)
    print(f"route parity: {done}/{total} operations ported ({100 * done / total:.0f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
