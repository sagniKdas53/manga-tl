#!/usr/bin/env python3
"""Focused synthetic regression checks for G0 candidate selection and policy metrics."""

from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCORER = ROOT / "scripts/score_page_quality.py"
REVISIONS = {"app": "a", "worker": "w", "corpus": "c"}
REQUIRED = ["page-snapshot.json", "editor.png", "export.png", "rendered.png", "project.zip"]
PNG_100 = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00d\x00\x00\x00d"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def candidate(directory: Path, sample: str, source_hash: str, *, revision=REVISIONS) -> dict:
    snapshot = directory / f"{sample}-snapshot.json"
    snapshot.write_text(json.dumps({
        "image": {"hash": source_hash, "width": 100, "height": 100},
        "ocrRegions": [
            {"id": "r-replace", "safeTextX": 0, "safeTextY": 0, "safeTextW": 50, "safeTextH": 50},
            {"id": "r-preserve", "safeTextX": 50, "safeTextY": 0, "safeTextW": 50, "safeTextH": 50},
        ],
        "layers": [{"layer": {"type": "translation"}, "elements": [{"regionId": "r-replace", "visible": True, "text": "translated", "x": 1, "y": 1, "maxWidth": 20, "maxHeight": 20}]}],
    }))
    artifacts = {}
    for name in REQUIRED:
        path = snapshot if name == "page-snapshot.json" else directory / f"{sample}-{name}"
        if path != snapshot:
            path.write_bytes(PNG_100 if name == "export.png" else f"{sample}:{name}".encode())
        artifacts[name] = {"path": str(path), "sha256": digest(path)}
    return {"id": sample, "source_sha256": source_hash, "input_revisions": revision, "snapshot": str(snapshot), "artifacts": artifacts}


def invoke(manifest: Path, candidates: Path, reconciliation: Path, output: Path, thresholds: Path | None = None) -> subprocess.CompletedProcess[str]:
    command = [str(ROOT / ".venv/bin/python"), str(SCORER), "--manifest", str(manifest), "--candidates", str(candidates), "--reconciliation", str(reconciliation), "--out", str(output)]
    if thresholds:
        command.extend(["--thresholds", str(thresholds)])
    return subprocess.run(command, text=True, capture_output=True)


def expect_failure(manifest: Path, candidates: Path, reconciliation: Path, needle: str) -> None:
    result = invoke(manifest, candidates, reconciliation, manifest.with_name("failed.json"))
    assert result.returncode != 0 and needle in result.stderr, result.stderr


def main() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        first, second = candidate(root, "sample-a", "a" * 64), candidate(root, "sample-b", "b" * 64)
        manifest = root / "manifest.json"
        manifest.write_text(json.dumps({"input_revisions": REVISIONS, "pages": [
            {"id": "sample-a", "source_sha256": first["source_sha256"], "source_dimensions": [100, 100], "required_artifacts": REQUIRED},
            {"id": "sample-b", "source_sha256": second["source_sha256"], "source_dimensions": [100, 100], "required_artifacts": REQUIRED},
        ]}))
        reconciliation = root / "reconciliation.json"
        reconciliation.write_text(json.dumps({"pages": [
            {"id": "sample-a", "source_sha256": first["source_sha256"], "associations": [
                {"reviewed_owner_id": "owner-replace", "action": "replace", "candidate_region_id": "r-replace", "mapping_state": "resolved"},
                {"reviewed_owner_id": "owner-preserve", "action": "preserve", "candidate_region_id": "r-preserve", "mapping_state": "resolved"},
            ]},
            {"id": "sample-b", "source_sha256": second["source_sha256"], "associations": []},
        ]}))
        candidates = root / "candidates.json"
        candidates.write_text(json.dumps({"candidates": [first, second]}))
        output = root / "measurement.json"
        result = invoke(manifest, candidates, reconciliation, output)
        assert result.returncode == 0, result.stderr
        measurement = json.loads(output.read_text())
        assert measurement["candidate_mode"] is True
        assert measurement["pages"][0]["metrics"]["policy"]["missing_expected_replacement_text"] == 0
        assert measurement["pages"][0]["metrics"]["policy"]["rendered_policy_preserved_or_review_text"] == 0
        frozen_manifest = ROOT / "docs/quality-runs/a09-20260913-holdout/A09-holdout-manifest.json"
        frozen_empty_candidates = root / "frozen-empty-candidates.json"
        frozen_empty_candidates.write_text(json.dumps({"candidates": []}))
        frozen_result = invoke(frozen_manifest, frozen_empty_candidates, reconciliation, root / "frozen-empty.json")
        assert frozen_result.returncode != 0
        assert "candidate selection failed" in frozen_result.stderr
        candidates.write_text(json.dumps({"candidates": [first, first]}))
        candidates.write_text(json.dumps({"candidates": [first, second]}))
        bad_reconciliation = root / "bad-reconciliation.json"
        bad_reconciliation.write_text(json.dumps({"pages": [{"id": "sample-a", "source_sha256": first["source_sha256"], "associations": [{"reviewed_owner_id": "owner-replace", "action": "replace", "candidate_region_id": "missing-region", "mapping_state": "resolved"}]}, {"id": "sample-b", "source_sha256": second["source_sha256"], "associations": []}]}))
        assert invoke(manifest, candidates, bad_reconciliation, root / "bad-association.json").returncode != 0
        thresholds = root / "thresholds.json"
        thresholds.write_text(json.dumps({"hard_invariants": [], "bounded_metrics": [{"id": "must-fail", "metric": "orphan_translation_elements", "rule": None, "threshold": "== 1"}]}))
        failed_threshold = invoke(manifest, candidates, reconciliation, root / "threshold-failure.json", thresholds)
        assert failed_threshold.returncode != 0
        assert json.loads((root / "threshold-failure.json").read_text())["threshold_checks"][0]["status"] == "failed"
        candidates.write_text(json.dumps({"candidates": [first, first]}))
        expect_failure(manifest, candidates, reconciliation, "duplicate=")
        candidates.write_text(json.dumps({"candidates": [first]}))
        expect_failure(manifest, candidates, reconciliation, "missing=")
        wrong_source = {**second, "source_sha256": "0" * 64}
        candidates.write_text(json.dumps({"candidates": [first, wrong_source]}))
        expect_failure(manifest, candidates, reconciliation, "source hash mismatch")
        wrong_dimensions = candidate(root, "sample-b", second["source_sha256"])
        export_path = Path(wrong_dimensions["artifacts"]["export.png"]["path"])
        export_path.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00c\x00\x00\x00d")
        wrong_dimensions["artifacts"]["export.png"]["sha256"] = digest(export_path)
        candidates.write_text(json.dumps({"candidates": [first, wrong_dimensions]}))
        expect_failure(manifest, candidates, reconciliation, "export dimensions do not match")
        stale = {**second, "input_revisions": {"app": "old"}}
        candidates.write_text(json.dumps({"candidates": [first, stale]}))
        expect_failure(manifest, candidates, reconciliation, "stale or mismatched")
    print("score_page_quality candidate and policy regressions: PASS")


if __name__ == "__main__":
    main()
