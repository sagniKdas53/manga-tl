# Fresh dev box setup

Use a separate Linux amd64 clone for this workstream. ARM64 remains a POC. The dev stack has its own Compose project, network, named data/model volumes and loopback ports; it does not use the production Traefik network, fixed container names or Watchtower. It builds the checked-out app and worker sources.

## Clone the coordinated branches

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone --branch feat/output-quality --recurse-submodules https://github.com/sagniKdas53/manga-tl.git manga-quality
cd manga-quality
git -C worker switch feat/output-quality
git -C corpus switch feat/output-quality
git submodule status
```

The parent pins tested submodule commits. Use the tracking branches when editing, then commit/push each submodule before recording its new pointer in the parent. The authoritative quality work starts at [tracker A01](output-quality-implementation-tracker.md); setup alone does not pass G0 or produce a new corpus baseline.

This existing checkout uses a **local Git LFS endpoint override** for corpus images; Git does not copy that setting into a fresh clone. Install Git LFS and configure a reachable copy of that endpoint before materializing the images, or transfer the source assets through your private artifact store. Keep the endpoint in local Git config, not tracked files:

```bash
git -C corpus config --local lfs.url "$CORPUS_LFS_URL"
git -C corpus lfs pull
```

Set `CORPUS_LFS_URL` in the dev box's private environment first and establish any network/authentication access it requires. The clone command deliberately leaves LFS pointers until this is ready. Model warmup can run before corpus images arrive; evaluation cannot.

## Seed credentials and deployment defaults

Prerequisites: Git, Python 3 for these stdlib-only setup scripts, Docker Engine and Docker Compose with `up --wait`. Worker development/tests require the separate root Python 3.13.12 venv below. Run from the new clone; do not point it at another deployment's state directories.

Interactive, hidden key entry:

```bash
python3 scripts/dev_setup.py init
```

Or import a provider-key JSON file supplied through the dev box's private secret mount:

```bash
python3 scripts/dev_setup.py init --non-interactive --api-keys-file /secure/manga-api-keys.json
```

The JSON is an object keyed by names such as `OPENROUTER_API_KEY` or `NVIDIA_API_KEY`, with string values. Do not put credentials in command arguments, tracked files or shell history. The importer fills missing/empty entries and preserves nonempty existing keys. To rotate a key deliberately, edit the private file and rerun `init`; changing the import file does not overwrite a saved nonempty key.

`init` creates only missing infrastructure credentials and merges API keys. It never rotates an existing DB/MinIO/JWT/internal/worker credential. Canonical files are `0600` beneath `secrets/` (`0700`). Container runtime copies are `0444` beneath `secrets/runtime/` (`0700`), allowing different container UIDs to read their individually mounted files while keeping the host directory private. The new dev Compose file mounts those runtime copies. Existing production Compose still uses its original secret paths; this dev setup does not redeploy it.

It also reads `config/providers.json`, uses configured provider credentials to determine availability, and writes single-model defaults into ignored `secrets/runtime/models.env`. Explicit model overrides in `.env` still win. No static fallback lists are generated. **Rerun `init` after changing catalog defaults or credentials, then recreate the dev services.** This prevents a fresh empty settings DB from silently selecting no QA model. Existing DB/chapter/series overrides remain intentional overrides, not something setup resets.

No cloud key is required to prepare the files or warm local OCR. Setup reports whether cloud translation is configured; a keyless setup is not a working cloud translation configuration. It does not make paid inference calls or validate provider account balance/access.

## Supply the pinned bubble detector and warm OCR

The current worker requires a pre-exported `yolo11n_bubble.onnx`; it cannot fetch that artifact at startup. The existing development copy is `data/worker/huggingface/models/yolo11n_bubble.onnx` (12,131,307 bytes at this checkpoint). Transfer that file to the cloud box through your usual private artifact transfer, or supply another exact copy. Its SHA-256 must match `YOLO_PINNED_CHECKSUM` in `worker/src/worker/config.py`.

```bash
python3 scripts/dev_setup.py init --non-interactive --yolo-file /mnt/artifacts/yolo11n_bubble.onnx
docker compose -f docker-compose.dev.yml build worker
python3 scripts/dev_setup.py models --languages ja ko zh
```

`init` can also discover the existing local copy automatically. It verifies the checksum before copying to ignored `data/bootstrap/`; a mismatch never replaces a good artifact. The dev stack mounts this file read-only at an explicit `YOLO_MODEL_PATH`, avoiding the worker's machine-specific host fallback path. The weights are not added to Git or fetched from an unpinned export job.

The warmup CLI validates the ONNX session and initializes language-specific OCR readers. PaddleOCR may download its selected detection/recognition weights on the first run; Korean follows the worker's language-aware catalog route. The CLI fails if any reader returns `None`. Model caches persist in named volumes across container rebuilds/restarts. Do not use `docker compose down -v` if you want to keep the database or caches. Large optional local LLM/VLM servers and their weights are not provisioned; they remain disabled by default.

## Start and access the stack

```bash
python3 scripts/dev_setup.py up
docker compose -f docker-compose.dev.yml ps
```

The app is at `http://127.0.0.1:18080/tlhub/`; MinIO API/console use loopback ports 19000/19001. Use SSH forwarding from your workstation, for example `ssh -L 18080:127.0.0.1:18080 devbox`, then open the local app address. Set `DEV_HTTP_PORT`, `DEV_MINIO_PORT`, `DEV_MINIO_CONSOLE_PORT` or `DEV_PROJECT_NAME` in `.env` before startup if needed. Dev DB and storage accounts are internally consistent (`tladmin` and `minioadmin`); the dev DB role matches ownership declarations in `database/init.sql`.

After editing code, rerun `up` to rebuild the checked-out sources. After changing catalog/keys, rerun `init` first. To stop while retaining state: `docker compose -f docker-compose.dev.yml down`. A failure from `up --wait` is a failed startup; inspect `docker compose -f docker-compose.dev.yml logs` before processing pages.

## Run host benchmarks with the same private keys

```bash
uv venv --python 3.13.12 .venv
uv pip install -r worker/requirements.txt --python .venv/bin/python
python3 scripts/dev_setup.py exec -- .venv/bin/python corpus/scripts/benchmark_free_suite.py --help
```

`exec` injects nonempty API keys into the child environment and points it at the shared provider catalog/secret JSON. It does not copy keys into `corpus/.env` or print them. Actual benchmark commands remain explicit: `--help` performs no benchmark. Scripts that load their own `.env` may override child environment values, so keep those separate files free of stale credential assignments. Host OCR probes additionally need host-appropriate cache/YOLO paths; the named container caches are not automatically host venv caches.

Setup records readiness in ignored `data/bootstrap/setup.json`. Save quality-run provenance and results separately using the [implementation tracker](output-quality-implementation-tracker.md). A model-cache warmup is not an OCR quality, translation quality or full-stack acceptance test.
