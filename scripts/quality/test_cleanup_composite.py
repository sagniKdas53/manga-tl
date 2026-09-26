"""Synthetic 3-region check for cleanup_composite.py's compositor (R3 Packet 4 §4).

No database, no MinIO, no network: builds a fake page and three fake patches in memory and
checks the two measurements the run README reports (outside-support invariance, residual-ink
proxy input) plus the diagnostics-code classifier, none of which should ever need live infra
to verify.
"""

import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cleanup_composite import (
    composite_page,
    diagnostics_code,
    outside_support_invariance,
)


def _encode_patch(color_bgr: tuple[int, int, int], width: int, height: int) -> bytes:
    bgra = np.zeros((height, width, 4), dtype=np.uint8)
    bgra[:, :, :3] = color_bgr
    bgra[:, :, 3] = 255
    ok, buf = cv2.imencode(".png", bgra)
    assert ok
    return buf.tobytes()


def _source_page() -> np.ndarray:
    page = np.full((200, 300, 3), (10, 20, 30), dtype=np.uint8)
    return page


def test_two_patched_regions_and_one_unpatched_are_composited_correctly():
    source = _source_page()
    patches = {
        "sha-a": _encode_patch((255, 0, 0), 40, 20),  # region A: patch matches its declared bounds
        "sha-b": _encode_patch((0, 255, 0), 30, 30),  # region B: patch is LARGER than its declared bounds
    }
    regions = [
        {
            "id": "region-a",
            "qa_status": None,
            "cleanup_patch_asset_id": "patch-sha-a",
            "cleanup_patch_sha256": "sha-a",
            "cleanup_bounds": {"x": 10, "y": 10, "width": 40, "height": 20},
            "cleanup_diagnostics": ["reconstruction method: telea (mode=auto, pixel_spread=3.0)"],
        },
        {
            "id": "region-b",
            "qa_status": None,
            "cleanup_patch_asset_id": "patch-sha-b",
            "cleanup_patch_sha256": "sha-b",
            # Declared bounds are 20x20 but the patch asset is actually 30x30 -- a real defect.
            "cleanup_bounds": {"x": 100, "y": 100, "width": 20, "height": 20},
            "cleanup_diagnostics": ["reconstruction method: aot (mode=auto, pixel_spread=12.0)"],
        },
        {
            "id": "region-c",
            "qa_status": "cleanup_review",
            "cleanup_patch_asset_id": None,
            "cleanup_bounds": None,
            "cleanup_diagnostics": ["CTD found no glyphs inside the region; source preserved."],
        },
    ]

    def fetch_patch(sha256: str) -> bytes:
        return patches[sha256]

    composite, support, rows = composite_page(source, regions, fetch_patch)

    # Region A: fully supported, patch color visible exactly inside its declared bounds.
    assert tuple(composite[15, 15]) == (255, 0, 0)
    assert support[15, 15]
    assert not rows[0]["bounds_mismatch"]

    # Region B: the compositor pastes the patch's OWN 30x30 pixels at (100, 100), so it spills
    # past the declared 20x20 bounds -- that spill is exactly what outside-support invariance
    # must catch as a defect, not silently resize away.
    assert rows[1]["bounds_mismatch"] is True
    assert tuple(composite[125, 125]) == (0, 255, 0)  # inside the actual (larger) patch
    assert support[125, 125]

    # Region C: unpatched, classified "uncertain" (qa_status == cleanup_review, no patch).
    assert rows[2]["patched"] is False
    assert diagnostics_code(regions[2]) == "uncertain"

    # Nothing outside any support mask was touched: composite equals source everywhere unsupported.
    outside = outside_support_invariance(composite, source, support)
    assert outside == 0, "compositor must never write outside the union of pasted-patch pixels"


def test_diagnostics_code_distinguishes_excluded_and_failed():
    excluded = {
        "cleanup_patch_asset_id": None,
        "qa_status": None,
        "cleanup_diagnostics": ["cleanup excluded by immutable policy"],
    }
    failed = {
        "cleanup_patch_asset_id": None,
        "qa_status": None,
        "cleanup_diagnostics": ["CTD/reconstruction produced no cleanup artifact"],
    }
    patched = {"cleanup_patch_asset_id": "patch-x", "qa_status": None, "cleanup_diagnostics": []}

    assert diagnostics_code(excluded) == "excluded"
    assert diagnostics_code(failed) == "failed"
    assert diagnostics_code(patched) is None


def test_outside_support_invariance_flags_a_compositor_bug():
    """If the compositor were buggy and painted outside its own support mask, this must be > 0."""
    source = _source_page()
    composite = source.copy()
    support = np.zeros(source.shape[:2], dtype=bool)
    composite[0, 0] = (1, 2, 3)  # simulate a bug: pixel changed with no recorded support
    assert outside_support_invariance(composite, source, support) == 1


if __name__ == "__main__":
    test_two_patched_regions_and_one_unpatched_are_composited_correctly()
    test_diagnostics_code_distinguishes_excluded_and_failed()
    test_outside_support_invariance_flags_a_compositor_bug()
    print("all cleanup_composite tests passed")
