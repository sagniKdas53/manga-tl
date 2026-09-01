#!/usr/bin/env python3
"""Refresh the production provider shortlist from OpenRouter and NVIDIA.

The catalog is intentionally not copied wholesale into ``config/providers.json``. Paid
models are curated production choices. This script keeps those choices while they remain
available, refreshes their OpenRouter prices, and replaces free OpenRouter entries with a
small current set for each task. NVIDIA does not publish capability or price metadata from
``/v1/models``, so its existing benchmark-promoted shortlist is verified against the live
catalog and labelled as using NVIDIA's free credits.

Run without ``--apply`` to preview the diff. The scheduled workflow uses ``--apply``.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config" / "providers.json"

OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models"
NVIDIA_MODELS = "https://integrate.api.nvidia.com/v1/models"
MANAGED_BY = "provider-catalog-refresh"

TEXT_TASKS = ("tl", "qaLLM")
VISION_TASKS = ("qaVLM", "ocr")
FREE_LIMIT = {"tl": 8, "qaLLM": 8, "qaVLM": 6, "ocr": 6}

# Free catalogs contain classifiers, role-play models, and narrow domain models. They may be
# useful elsewhere, but putting them in a production translation fallback list is misleading.
FREE_EXCLUSIONS = (
    "content-safety",
    "guard",
    "moderation",
    "roleplay",
    "role-play",
    "finance",
    "-fin:",
    "-fin-",
    "medical",
    "-med-",
    "music",
    "audio",
    "code",
)


class RefreshError(RuntimeError):
    """Raised when a refresh would leave the production config invalid."""


def fetch(
    url: str,
    *,
    authorization: str | None = None,
    timeout: int = 45,
) -> dict[str, Any]:
    headers = {"User-Agent": "manga-library/provider-catalog-refresh"}
    if authorization:
        headers["Authorization"] = authorization
    request = urllib.request.Request(
        url,
        headers=headers,
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _number(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _per_million(value: Any) -> float | None:
    number = _number(value)
    return round(number * 1_000_000, 9) if number is not None else None


def openrouter_pricing(model: dict[str, Any]) -> dict[str, Any]:
    raw = model.get("pricing") or {}
    pricing: dict[str, Any] = {
        "currency": "USD",
        "source": "openrouter",
    }
    for source_key, output_key in (
        ("prompt", "promptPerMillion"),
        ("completion", "completionPerMillion"),
        ("input_cache_read", "cacheReadPerMillion"),
    ):
        value = _per_million(raw.get(source_key))
        if value is not None:
            pricing[output_key] = value
    for source_key, output_key in (("request", "request"), ("image", "image")):
        value = _number(raw.get(source_key))
        if value is not None:
            pricing[output_key] = value
    return pricing


def is_openrouter_free(model: dict[str, Any]) -> bool:
    pricing = model.get("pricing") or {}
    prompt = _number(pricing.get("prompt"))
    completion = _number(pricing.get("completion"))
    if prompt != 0 or completion != 0:
        return False
    optional_charges = (
        "request",
        "image",
        "web_search",
        "internal_reasoning",
        "input_cache_read",
        "input_cache_write",
    )
    return all((_number(pricing.get(key)) or 0) == 0 for key in optional_charges)


def supports_task(model: dict[str, Any], task: str) -> bool:
    architecture = model.get("architecture") or {}
    inputs = architecture.get("input_modalities") or []
    outputs = architecture.get("output_modalities") or []
    if "text" not in inputs or sorted(outputs) != ["text"]:
        return False
    if architecture.get("tokenizer") == "Router":
        return False
    return task in TEXT_TASKS or "image" in inputs


def free_candidate(model: dict[str, Any], task: str) -> bool:
    model_id = str(model.get("id") or "").lower()
    return (
        bool(model_id)
        and is_openrouter_free(model)
        and supports_task(model, task)
        and not any(fragment in model_id for fragment in FREE_EXCLUSIONS)
    )


def candidate_rank(model: dict[str, Any]) -> tuple[float, int, str]:
    benchmarks = model.get("benchmarks") or {}
    intelligence = (benchmarks.get("artificial_analysis") or {}).get("intelligence_index")
    score = _number(intelligence)
    return (score if score is not None else -1.0, int(model.get("created") or 0), str(model.get("id") or ""))


def openrouter_entry(model: dict[str, Any], *, managed: bool) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "id": model["id"],
        "name": model.get("name") or model["id"],
        "free": is_openrouter_free(model),
        "pricing": openrouter_pricing(model),
    }
    if managed:
        entry["managedBy"] = MANAGED_BY
    return entry


def _defaults(provider: dict[str, Any]) -> set[str]:
    return {
        value
        for key, value in provider.items()
        if key.startswith("default") and key.endswith("Model") and isinstance(value, str) and value
    }


def refresh_openrouter(provider: dict[str, Any], catalog: list[dict[str, Any]]) -> list[str]:
    live = {model.get("id"): model for model in catalog if model.get("id")}
    defaults = _defaults(provider)
    changes: list[str] = []

    missing_defaults = sorted(defaults - live.keys())
    if missing_defaults:
        raise RefreshError(f"OpenRouter defaults missing from the live catalog: {', '.join(missing_defaults)}")

    for task, entries in (provider.get("models") or {}).items():
        if task not in FREE_LIMIT or not isinstance(entries, list):
            continue

        # Paid entries are deliberate production choices. Free entries belong to discovery and
        # are replaced on every run, including legacy entries from before managedBy was added.
        curated: list[dict[str, Any]] = []
        previous_free = {
            entry.get("id")
            for entry in entries
            if entry.get("free") and not entry.get("pinned") and entry.get("id") not in defaults
        }
        for entry in entries:
            model_id = entry.get("id")
            model = live.get(model_id)
            if entry.get("pinned") or model_id in defaults:
                if model is None:
                    changes.append(f"openrouter/{task}: removed unavailable pinned model {model_id}")
                    continue
                refreshed = openrouter_entry(model, managed=False)
                refreshed["pinned"] = True
                if "tier" in entry:
                    refreshed["tier"] = entry["tier"]
                curated.append(refreshed)
                continue
            if entry.get("free") or entry.get("managedBy") == MANAGED_BY:
                continue
            if model is None:
                changes.append(f"openrouter/{task}: removed unavailable curated model {model_id}")
                continue
            refreshed = openrouter_entry(model, managed=False)
            for key in ("tier", "pinned"):
                if key in entry:
                    refreshed[key] = entry[key]
            curated.append(refreshed)

        candidates = [model for model in catalog if free_candidate(model, task)]
        candidates.sort(key=candidate_rank, reverse=True)
        selected = candidates[: FREE_LIMIT[task]]
        managed = [openrouter_entry(model, managed=True) for model in selected]

        # A manually curated entry wins if the same id appears in the free selection.
        curated_ids = {entry["id"] for entry in curated}
        managed = [entry for entry in managed if entry["id"] not in curated_ids]
        provider["models"][task] = curated + managed

        current_free = {entry["id"] for entry in managed}
        for model_id in sorted(previous_free - current_free):
            changes.append(f"openrouter/{task}: removed free model {model_id}")
        for model_id in sorted(current_free - previous_free):
            changes.append(f"openrouter/{task}: added free model {model_id}")

    return changes


def refresh_nvidia(provider: dict[str, Any], catalog: list[dict[str, Any]]) -> list[str]:
    live = {model.get("id"): model for model in catalog if model.get("id")}
    defaults = _defaults(provider)
    changes: list[str] = []

    missing_defaults = sorted(defaults - live.keys())
    if missing_defaults:
        raise RefreshError(f"NVIDIA defaults missing from the live catalog: {', '.join(missing_defaults)}")

    for task, entries in (provider.get("models") or {}).items():
        if not isinstance(entries, list):
            continue
        refreshed: list[dict[str, Any]] = []
        for entry in entries:
            model_id = entry.get("id")
            if model_id not in live:
                changes.append(f"nvidia/{task}: removed unavailable model {model_id}")
                continue
            updated = copy.deepcopy(entry)
            updated["free"] = True
            updated["pricing"] = {
                "currency": "USD",
                "source": "nvidia-catalog",
                "note": "Free credits",
            }
            refreshed.append(updated)
        provider["models"][task] = refreshed
    return changes


def refresh_document(
    document: dict[str, Any],
    openrouter_catalog: list[dict[str, Any]],
    nvidia_catalog: list[dict[str, Any]],
) -> tuple[dict[str, Any], list[str]]:
    updated = copy.deepcopy(document)
    providers = updated.get("providers") or {}
    try:
        openrouter_provider = providers["openrouter"]
        nvidia_provider = providers["nvidia"]
    except KeyError as error:
        raise RefreshError(f"providers.json is missing provider {error.args[0]}") from error

    changes = refresh_openrouter(openrouter_provider, openrouter_catalog)
    changes.extend(refresh_nvidia(nvidia_provider, nvidia_catalog))
    return updated, changes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write the refreshed providers.json")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    args = parser.parse_args()

    try:
        nvidia_api_key = os.environ.get("NVIDIA_API_KEY")
        if not nvidia_api_key:
            raise RefreshError("NVIDIA_API_KEY is required to read the NVIDIA model catalog")
        document = json.loads(args.config.read_text(encoding="utf-8"))
        openrouter_catalog = fetch(OPENROUTER_MODELS).get("data") or []
        nvidia_catalog = fetch(
            NVIDIA_MODELS,
            authorization=f"Bearer {nvidia_api_key}",
        ).get("data") or []
        if not openrouter_catalog or not nvidia_catalog:
            raise RefreshError("a provider returned an empty catalog; refusing a partial refresh")
        updated, changes = refresh_document(document, openrouter_catalog, nvidia_catalog)
    except (OSError, json.JSONDecodeError, urllib.error.URLError, TimeoutError, RefreshError) as error:
        print(f"provider refresh failed: {error}", file=sys.stderr)
        return 1

    old_text = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
    new_text = json.dumps(updated, ensure_ascii=False, indent=2) + "\n"
    if old_text == new_text:
        print("Provider catalog is already current.")
        return 0

    for change in changes:
        print(change)
    if not args.apply:
        print("Dry run; providers.json was not changed. Re-run with --apply.")
        return 0

    args.config.write_text(new_text, encoding="utf-8")
    print(f"Updated {args.config}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
