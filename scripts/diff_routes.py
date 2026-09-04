#!/usr/bin/env python3
"""Route-table drift check: the Rust route table must equal the frozen contract exactly.

golden-routes.txt was exported from the Java backend while it was still running, and is now
the frozen record of the contract the Rust backend inherited — the Java tree it came from is
gone, so this file is the only surviving statement of what the API promised. PORTED lists
what the Rust backend serves today.

Post-cutover this is an equality gate, not a subset gate. It fails in both directions:

  * ported but not golden  — the public contract grew. That is a deliberate act; add the
    route to golden-routes.txt in the same commit, and regenerate the frontend types.
  * golden but not ported  — a route was LOST. Callers 404 against a contract that still
    advertises the endpoint. This is the direction the old subset check could not see: it
    would have let parity slide from 71/71 to 70/71 and still exited 0.
"""

import sys
from pathlib import Path

GOLDEN = Path(__file__).parent.parent / "backend-rust" / "spec" / "golden-routes.txt"

# "METHOD path" entries the Rust backend serves today (keep in sync with src/routes/).
# Served too but NOT part of the OpenAPI contract (springdoc never documented the
# actuator, so none of these belong in the golden file):
# GET  /actuator/health[/liveness|/readiness] — byte-compatible {"status":"UP"}.
# GET  /actuator/loggers, GET/POST /actuator/loggers/{name} — ADMIN-only live log levels,
#      the port of the `loggers` endpoint application.yml exposed on purpose.
# GET  /v3/api-docs — static bytes of spec/golden-openapi.json (Phase 4 step 1).
PORTED = {
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
    # AUDIT-F26: the render's own thumbnail, so the page grid can show pipeline output.
    "GET /api/images/{imageId}/thumbnail/rendered",
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
    # import/export (Phase 3 completion)
    "POST /api/series/{seriesId}/chapters/import",
    "POST /api/chapters/{chapterId}/import-project",
    "GET /api/series/chapters/{chapterId}/export",
    "DELETE /api/series/chapters/{chapterId}/exports",
    "GET /api/series/chapters/exports/{exportId}/download",
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

    # Post-cutover: the ported surface must EQUAL the golden contract, both directions.
    added = sorted(PORTED - golden)
    lost = sorted(golden - PORTED)

    if added:
        print("CONTRACT DRIFT — served but absent from golden spec:")
        for route in added:
            print(f"  + {route}")
    if lost:
        print("CONTRACT REGRESSION — in golden spec but no longer served:")
        for route in lost:
            print(f"  - {route}")
    if added or lost:
        print(
            f"\nroute parity: {len(PORTED)} served vs {len(golden)} in contract, "
            f"{len(golden & PORTED)} in common — must be exact"
        )
        return 1

    print(f"route parity: {len(golden)}/{len(golden)} operations ported (100%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
