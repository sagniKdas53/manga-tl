"""Conservatively create local secret files and merge API keys."""

from __future__ import annotations

import argparse
import fcntl
import getpass
import json
import os
import secrets
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any

_SECRET_FILES = {
    "db_password.txt": lambda: secrets.token_urlsafe(16),
    "minio_password.txt": lambda: secrets.token_urlsafe(16),
    "jwt_secret.txt": lambda: secrets.token_hex(32),
    "internal_api_token.txt": lambda: secrets.token_urlsafe(32),
    "worker_api_secret.txt": lambda: secrets.token_urlsafe(32),
    "grafana_admin_password.txt": lambda: secrets.token_urlsafe(24),
    "grafana_db_password.txt": lambda: secrets.token_urlsafe(24),
}
_FALLBACK_PROVIDERS = {
    "OPENAI_API_KEY": ("OpenAI", "https://api.openai.com/v1"),
    "ANTHROPIC_API_KEY": ("Anthropic", "https://api.anthropic.com"),
    "GEMINI_API_KEY": ("Google Gemini", "https://generativelanguage.googleapis.com"),
    "DEEPL_API_KEY": ("DeepL", "https://api-free.deepl.com"),
    "DEEPL_KEY": ("DeepL (legacy key)", "https://api-free.deepl.com"),
    "CLOUDFLARE_API_TOKEN": ("Cloudflare API Token", "https://api.cloudflare.com"),
    "CLOUDFLARE_ACCOUNT_ID": ("Cloudflare Account ID", "https://api.cloudflare.com"),
}


def _regular(path: Path, label: str) -> None:
    if path.is_symlink():
        raise ValueError(f"refusing symlink {label}: {path}")
    if path.exists() and not path.is_file():
        raise ValueError(f"{label} is not a regular file: {path}")


def _providers(root: Path) -> dict[str, tuple[str, str]]:
    result = dict(_FALLBACK_PROVIDERS)
    catalog = root / "config" / "providers.json"
    if catalog.is_symlink():
        raise ValueError(f"refusing symlink provider catalog: {catalog}")
    if not catalog.exists():
        return result
    try:
        data = json.loads(catalog.read_text(encoding="utf-8"))
        entries = data.get("providers", {})
        if not isinstance(entries, dict):
            raise TypeError("providers must be an object")
        for entry in entries.values():
            if isinstance(entry, dict) and isinstance(entry.get("keyEnvVar"), str):
                env_name = entry["keyEnvVar"]
                result[env_name] = (
                    str(entry.get("displayName") or env_name),
                    str(entry.get("baseUrl") or "provider URL"),
                )
    except (
        OSError,
        json.JSONDecodeError,
        ValueError,
        TypeError,
        AttributeError,
    ) as exc:
        raise ValueError(f"invalid provider catalog: {catalog}") from exc
    return result


def _load_object(path: Path) -> dict[str, Any]:
    _regular(path, "API key file")
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid API key JSON: {path}") from exc
    if not isinstance(value, dict) or any(
        not isinstance(k, str) or not isinstance(v, str) for k, v in value.items()
    ):
        raise ValueError(f"API key JSON must be an object of string values: {path}")
    return value


@contextmanager
def _api_key_lock(path: Path):
    lock_path = path.with_name(f".{path.name}.lock")
    _regular(lock_path, "API key lock")
    with lock_path.open("a+", encoding="utf-8") as handle:
        os.chmod(lock_path, 0o600)
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=4)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def seed_secrets(
    root: Path, non_interactive: bool = False, import_path: Path | None = None
) -> dict[str, Any]:
    """Create missing credentials below ``root`` and merge non-empty API keys."""
    root = Path(root)
    if root.exists() and (root.is_symlink() or not root.is_dir()):
        raise ValueError(f"root is not a real directory: {root}")
    secret_dir = root / "secrets"
    if secret_dir.is_symlink():
        raise ValueError(f"refusing symlink secrets directory: {secret_dir}")
    key_path = secret_dir / "api_keys.json"
    existing = _load_object(key_path)
    if import_path is not None and not Path(import_path).exists():
        raise ValueError(f"API key import file does not exist: {import_path}")
    imported = _load_object(Path(import_path)) if import_path is not None else {}
    providers = _providers(root)

    existing_credentials: dict[str, str] = {}
    for filename in _SECRET_FILES:
        path = secret_dir / filename
        _regular(path, "secret file")
        if path.exists():
            content = path.read_text(encoding="utf-8")
            if not content.strip():
                raise ValueError(f"secret file is empty: {path}")
            existing_credentials[filename] = content

    root.mkdir(parents=True, exist_ok=True)
    secret_dir.mkdir(exist_ok=True)
    if not secret_dir.is_dir():
        raise ValueError(f"secrets is not a directory: {secret_dir}")
    os.chmod(secret_dir, 0o700)

    if not non_interactive:
        for env_name, (name, url) in providers.items():
            value = getpass.getpass(
                f"{name} API key ({env_name}, {url}; blank to skip): "
            ).strip()
            if value and not existing.get(env_name, "").strip():
                imported.setdefault(env_name, value)

    created: list[str] = []
    for filename, generator in _SECRET_FILES.items():
        path = secret_dir / filename
        if filename in existing_credentials:
            os.chmod(path, 0o600)
            continue
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            continue
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(generator())
        created.append(filename)

    with _api_key_lock(key_path):
        merged = _load_object(key_path)
        for key, value in imported.items():
            if (
                isinstance(value, str)
                and value.strip()
                and (key not in merged or not merged[key].strip())
            ):
                merged[key] = value
        if merged != existing or not key_path.exists():
            _regular(key_path, "API key file")
            _atomic_json(key_path, merged)
        else:
            os.chmod(key_path, 0o600)
    return {"created": created, "api_keys": len(merged), "root": root}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    parser.add_argument("--non-interactive", action="store_true")
    parser.add_argument("--api-keys-file", type=Path)
    args = parser.parse_args(argv)
    try:
        result = seed_secrets(args.root, args.non_interactive, args.api_keys_file)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    print(
        f"Seeded {len(result['created'])} missing secret files and preserved {result['api_keys']} API keys."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
