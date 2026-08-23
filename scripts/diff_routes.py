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
    # series + chapters CRUD (Phase 2; import/export quartet defers to Phase 3)
    "POST /api/series",
    "GET /api/series",
    "GET /api/series/{seriesId}",
    "PUT /api/series/{seriesId}",
    "DELETE /api/series/{seriesId}",
    "POST /api/series/{seriesId}/chapters",
    "GET /api/series/{seriesId}/chapters",
    "GET /api/series/chapters/{chapterId}",
    "PUT /api/series/chapters/{chapterId}",
    "DELETE /api/series/chapters/{chapterId}",
    # pages/images (Phase 2; zip branches + redo + import-project defer to Phase 3)
    "POST /api/images",
    "GET /api/chapters/{chapterId}/pages",
    "GET /api/pages/{pageId}",
    "DELETE /api/pages/{pageId}",
    "PATCH /api/pages/{pageId}/number",
    "PUT /api/chapters/{chapterId}/pages/reorder",
    "GET /api/images/{imageId}",
    "GET /api/images/{imageId}/file",
    "GET /api/images/{imageId}/reader",
    "GET /api/images/{imageId}/thumbnail",
    "GET /api/pages/{pageId}/rendered",
    "PATCH /api/ocr-regions/{id}",
    # layers + settings + jobs (Phase 2 completion)
    "PUT /api/layer-elements/{id}",
    "DELETE /api/layer-elements/{id}",
    "GET /api/layer-elements/{id}/history",
    "POST /api/pages/{pageId}/layers",
    "POST /api/images/{imageId}/layers",
    "PUT /api/layers/{id}",
    "DELETE /api/layers/{id}",
    "POST /api/layers/{layerId}/elements",
    "GET /api/settings",
    "PUT /api/settings",
    "GET /api/settings/validate",
    # notifications/realtime (Phase 3 begins)
    "GET /api/notifications/stream",
    "POST /api/notifications/ticket",
    # internal worker API + redo triggers (Phase 3 pipeline core)
    "GET /api/internal/images/{imageId}",
    "HEAD /api/internal/images/{imageId}",
    "POST /api/internal/images/{imageId}/qa-hybrid-prepare",
    "POST /api/internal/jobs/callback/layout",
    "POST /api/internal/jobs/callback/ocr",
    "POST /api/internal/jobs/callback/panel",
    "POST /api/internal/jobs/callback/qa",
    "POST /api/internal/jobs/callback/qa-re-ocr",
    "POST /api/internal/jobs/callback/render",
    "POST /api/internal/jobs/callback/translation",
    "GET /api/internal/jobs/{jobId}",
    "PATCH /api/internal/jobs/{jobId}/status",
    "POST /api/internal/ocr-regions/{id}/callback",
    "POST /api/images/{imageId}/redo",
    "POST /api/ocr-regions/{id}/redo",
    "GET /api/jobs",
    "POST /api/jobs/pause",
    "POST /api/jobs/resume",
    "DELETE /api/jobs/clear",
    "POST /api/jobs/{id}/retry",
    "POST /api/jobs/{id}/pause",
    "POST /api/jobs/{id}/resume",
    "DELETE /api/jobs/{id}",
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
