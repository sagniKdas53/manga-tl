"""Prepare an isolated dev stack, catalog defaults and portable credentials.

Uses only the standard library. No model/provider requests occur during init.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

if __package__:
    from .seed_secrets import seed_secrets
else:
    from seed_secrets import seed_secrets

REPO = Path(__file__).resolve().parents[1]
SLOTS = {
    "ocr": ("OCR_MODEL_PROVIDER", "OCR_VLM_MODEL", "defaultOCRModel"),
    "tl": ("TL_MODEL_PROVIDER", "TL_LLM_MODEL", "defaultTLModel"),
    "qaLLM": ("QA_MODEL_PROVIDER", "QA_LLM_MODEL", "defaultQALLMModel"),
    "qaVLM": ("QA_MODEL_PROVIDER", "QA_VLM_MODEL", "defaultQAVLMModel"),
}
INFRA = (
    "db_password",
    "minio_password",
    "jwt_secret",
    "internal_api_token",
    "worker_api_secret",
)


def read_env(path: Path) -> dict[str, str]:
    """Read literal assignments; never source a shell file or execute substitutions."""
    result = {}
    if not path.exists():
        return result
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(
            r"(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)", line.strip()
        )
        if not match:
            raise ValueError(f"unsupported assignment in {path}; use literal KEY=value")
        value = match[2].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        result[match[1]] = value
    return result


def write_file(path: Path, content: bytes, mode: int = 0o600) -> None:
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError(f"refusing non-regular output: {path}")
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".setup-")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def resolve_models(catalog: dict, keys: dict, overrides: dict) -> dict[str, str]:
    """Resolve deploy defaults from available catalog providers; keep explicit overrides."""
    providers = catalog["providers"]
    preferred = catalog.get("defaults", {}).get("provider")
    active = [
        name
        for name, p in providers.items()
        if p.get("keyEnvVar") and keys.get(p["keyEnvVar"], "").strip()
    ]
    active.sort(
        key=lambda name: (name != preferred, providers[name].get("priority", 99), name)
    )
    result: dict[str, str] = {}
    for task, (provider_var, model_var, default_key) in SLOTS.items():
        candidates = [
            name for name in active if providers[name].get("models", {}).get(task)
        ]
        provider = (
            overrides.get(provider_var)
            or result.get(provider_var)
            or (candidates[0] if candidates else "")
        )
        if provider and provider not in providers:
            raise ValueError(f"{provider_var} names a provider absent from the catalog")
        if provider and provider != "local" and provider not in active:
            raise ValueError(
                f"{provider_var} requires its provider credential in secrets/api_keys.json"
            )
        entries = providers.get(provider, {}).get("models", {}).get(task) or []
        model = overrides.get(model_var, "")
        fallback = overrides.get(model_var + "_LIST", "")
        if not model and fallback:
            model = fallback.split(",")[0].strip()
        if not model and entries:
            default = providers[provider].get(default_key)
            global_default = (
                catalog.get("defaults", {}).get(task) if provider == preferred else None
            )
            ids = {entry["id"] for entry in entries}
            model = global_default if global_default in ids else default
            if not model or model not in ids:
                raise ValueError(f"catalog has no valid default for {provider}/{task}")
        if model and model not in {entry["id"] for entry in entries}:
            raise ValueError(
                f"{model_var} is not in the selected provider catalog; update the override"
            )
        result[provider_var] = provider
        result[model_var] = model or ""
        # Existing lists remain opt-in overrides; never generate a stale list from the catalog.
        if fallback:
            result[model_var + "_LIST"] = fallback
    result["QA_MODE"] = overrides.get("QA_MODE") or (
        "auto" if result.get("QA_LLM_MODEL") or result.get("QA_VLM_MODEL") else "none"
    )
    return result


def install_yolo(root: Path, source: Path | None) -> bool:
    target = root / "data/bootstrap/yolo11n_bubble.onnx"
    if source is None:
        source = (
            target
            if target.is_file()
            else root / "data/worker/huggingface/models/yolo11n_bubble.onnx"
        )
        if not source.is_file():
            return False
    code = (root / "worker/src/worker/config.py").read_text()
    match = re.search(r'^YOLO_PINNED_CHECKSUM = "([a-f0-9]{64})"', code, re.MULTILINE)
    if not match:
        raise ValueError(
            "cannot find worker YOLO checksum; initialize the worker submodule"
        )
    content = source.read_bytes()
    if hashlib.sha256(content).hexdigest() != match[1]:
        raise ValueError(
            "YOLO checksum mismatch; supply the exact pinned ONNX artifact"
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.read_bytes() != content:
        raise ValueError(
            "existing bootstrap YOLO differs; investigate before replacing it"
        )
    if not target.exists():
        write_file(target, content, 0o644)
    return True


def initialize(
    root: Path,
    non_interactive: bool,
    api_keys_file: Path | None,
    yolo_file: Path | None,
) -> dict:
    catalog = json.loads((root / "config/providers.json").read_text())
    seed_secrets(root, non_interactive, api_keys_file)
    env_path = root / ".env"
    if not env_path.exists():
        write_file(env_path, (REPO / ".env.example").read_bytes())
    overrides = read_env(env_path)
    keys = json.loads((root / "secrets/api_keys.json").read_text())
    defaults = resolve_models(catalog, keys, overrides)
    runtime = root / "secrets/runtime"
    if runtime.is_symlink():
        raise ValueError("refusing symlink runtime directory")
    runtime.mkdir(mode=0o700, exist_ok=True)
    runtime.chmod(0o700)
    # Bind-mounted Compose secrets must be readable by different container UIDs.
    # Their 0700 parent keeps these runtime copies private on the host.
    for name in INFRA:
        content = (root / "secrets" / f"{name}.txt").read_bytes()
        if not content.strip():
            raise ValueError(f"empty infrastructure credential: {name}")
        write_file(runtime / f"{name}.txt", content, 0o444)
    write_file(
        runtime / "api_keys.json",
        json.dumps({k: v for k, v in keys.items() if v.strip()}).encode(),
        0o444,
    )
    for value in defaults.values():
        if not re.fullmatch(r"[A-Za-z0-9_./:@,+\-]*", value):
            raise ValueError(
                "model defaults must be literal identifiers, not environment expressions"
            )
    write_file(
        runtime / "models.env",
        (
            "# Generated by dev_setup.py init; edit catalog or .env overrides instead.\n"
            + "".join(f"{k}={v}\n" for k, v in defaults.items())
        ).encode(),
    )
    yolo_ready = install_yolo(root, yolo_file)
    report = {
        "models": defaults,
        "yolo_ready": yolo_ready,
        "cloud_translation_configured": bool(defaults["TL_LLM_MODEL"]),
    }
    (root / "data/bootstrap").mkdir(parents=True, exist_ok=True)
    write_file(
        root / "data/bootstrap/setup.json", json.dumps(report, indent=2).encode()
    )
    return report


def compose(root: Path, arguments: list[str]) -> int:
    return subprocess.call(
        [
            "docker",
            "compose",
            "--env-file",
            str(root / ".env"),
            "-f",
            str(root / "docker-compose.dev.yml"),
            *arguments,
        ],
        cwd=root,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=REPO)
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser(
        "init", help="create missing secrets and derive catalog defaults"
    )
    init.add_argument("--non-interactive", action="store_true")
    init.add_argument("--api-keys-file", type=Path)
    init.add_argument("--yolo-file", type=Path)
    warm = commands.add_parser(
        "models", help="warm local caches in the built worker image"
    )
    warm.add_argument("--languages", nargs="+", default=["ja", "ko", "zh"])
    commands.add_parser("up", help="build and start the isolated dev stack")
    run = commands.add_parser(
        "exec", help="run a host benchmark with private API keys injected"
    )
    run.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    try:
        if args.command == "init":
            report = initialize(
                root, args.non_interactive, args.api_keys_file, args.yolo_file
            )
            print(
                "Prepared secrets/runtime/models.env and container secret mounts; existing credentials retained."
            )
            print("YOLO artifact ready:", report["yolo_ready"])
            print(
                "Cloud translation configured:", report["cloud_translation_configured"]
            )
            print(
                "Next: build the worker image, then run dev_setup.py models. See docs/dev-box-setup.md."
            )
            return 0
        if args.command == "models":
            if not install_yolo(root, None):
                raise ValueError(
                    "supply the pinned YOLO artifact with init --yolo-file before warming models"
                )
            return compose(
                root,
                [
                    "run",
                    "--rm",
                    "--no-deps",
                    "--entrypoint",
                    "python",
                    "worker",
                    "-m",
                    "worker.seed_models",
                    "--languages",
                    *args.languages,
                ],
            )
        if args.command == "up":
            return compose(root, ["up", "--build", "-d", "--wait"])
        command = args.arguments
        if command and command[0] == "--":
            command = command[1:]
        if not command:
            raise ValueError("exec requires a command after --")
        keys = json.loads((root / "secrets/api_keys.json").read_text())
        if not isinstance(keys, dict) or any(
            not isinstance(v, str) for v in keys.values()
        ):
            raise ValueError("API key JSON must contain string values")
        env = os.environ.copy()
        env.update({k: v for k, v in keys.items() if v.strip()})
        env["PROVIDERS_CONFIG"] = str(root / "config/providers.json")
        env["DOCKER_SECRETS_JSON"] = str(root / "secrets/api_keys.json")
        return subprocess.call(command, cwd=root, env=env)
    except (OSError, ValueError, KeyError) as exc:
        parser.error(str(exc))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
