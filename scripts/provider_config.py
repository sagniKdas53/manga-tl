#!/usr/bin/env python3
"""
provider_config.py — Shared config/providers.json (or scripts/test-providers.json) loader
for the benchmark scripts. One place to resolve a provider's base URL (including Cloudflare's
${CLOUDFLARE_ACCOUNT_ID} templating), build its auth headers, and list candidate models for a
given task ("tl" or "ocr") with the same free/paid and provider/model filters everywhere.

Used by benchmark_translation.py and benchmark_vlm_ocr.py so both scripts see a model the
moment it's added to a providers config, with no code changes.
"""

import os
import re
import json


def load_env(filepath):
    if not os.path.exists(filepath):
        return
    with open(filepath, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("=", 1)
            if len(parts) == 2:
                key = parts[0].strip()
                val = parts[1].strip().strip("'\"")
                os.environ[key] = val


def load_providers_config(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def resolve_base_url(url_template):
    """Substitute ${VAR} placeholders (e.g. Cloudflare's ${CLOUDFLARE_ACCOUNT_ID}) from env."""
    def repl(m):
        var = m.group(1)
        val = os.environ.get(var, "")
        if not val:
            raise ValueError(f"{var} not set in environment/.env (required for this provider's baseUrl)")
        return val
    return re.sub(r"\$\{([A-Z0-9_]+)\}", repl, url_template)


def build_headers(provider_cfg):
    api_key = os.environ.get(provider_cfg["keyEnvVar"], "")
    if not api_key:
        raise ValueError(f"{provider_cfg['keyEnvVar']} not set in environment/.env")
    headers = {
        "Content-Type": "application/json",
        provider_cfg["authHeader"]: f"{provider_cfg.get('authPrefix', '')}{api_key}",
    }
    headers.update(provider_cfg.get("extraHeaders", {}))
    return headers


def list_candidate_models(providers_cfg, task, provider_filter=None, include_paid=False, model_filter=None):
    """Yields (provider_name, provider_cfg, model_id, model_name, free) for every model
    listed under providers.<name>.models.<task> that passes the given filters."""
    for provider_name, provider_cfg in providers_cfg["providers"].items():
        if provider_filter and provider_name != provider_filter:
            continue
        task_models = (provider_cfg.get("models") or {}).get(task) or []
        for m in task_models:
            if model_filter and m["id"] != model_filter:
                continue
            if not m.get("free", False) and not include_paid:
                continue
            yield provider_name, provider_cfg, m["id"], m.get("name", m["id"]), m.get("free", False)


def list_specialized_models(providers_cfg, key, provider_filter=None, model_filter=None):
    """Yields (provider_name, provider_cfg, model_id, model_name, note) for entries under a
    provider's models.<key> that don't fit the generic openai-compatible chat shape — e.g.
    nvidia.models.ocr_specialized_non_chat (nemotron-ocr-v2's dedicated CV endpoint)."""
    for provider_name, provider_cfg in providers_cfg["providers"].items():
        if provider_filter and provider_name != provider_filter:
            continue
        entries = (provider_cfg.get("models") or {}).get(key) or []
        for m in entries:
            if model_filter and m["id"] != model_filter:
                continue
            yield provider_name, provider_cfg, m["id"], m.get("name", m["id"]), m.get("note", "")
