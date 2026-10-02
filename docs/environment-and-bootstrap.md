# Environment assessment and setup checkpoint

Date: 2026-09-09. Working branches: `feat/output-quality` in parent, worker and corpus. The output-quality implementation tracker remains pending; this change prepares isolated development and commits the existing investigation.

## What the code actually consumes

| Configuration | Current behavior | Action |
| --- | --- | --- |
| `config/providers.json` | Defines provider endpoints, credentials' env names, task catalogs, per-provider/global defaults and rate limits. Worker publishes its available catalog to Redis on service startup. | Keep as shared catalog; setup derives fresh deployment defaults from it. |
| DB/chapter/series model fields | `settings.rs` reads DB globals over env; `resolve.rs` and coordinator resolve chapter → series → global. | Preserve; setup does not reset user choices. |
| OCR/TL/QA singleton env fields | Still read by `PipelineDefaults::from_env`, worker `ModelConfig` and QA auto selection. Empty models can resolve automatic QA to `none`. | Do not blindly delete. Existing local overrides retained; fresh setup generates defaults from the catalog. |
| `OCR_VLM_MODEL_LIST`, `TL_LLM_MODEL_LIST`, `QA_LLM_MODEL_LIST`, `QA_VLM_MODEL_LIST` | Still loaded. Backend uses list index zero when singleton is empty; worker uses fallbacks, including OCR redo and pricing setup. | Preserve explicit lists. The benchmark scripts' catalog selection does not make runtime lists unused. Fresh setup generates no frozen list. |
| `PADDLEOCR_DET_MODEL` / `PADDLEOCR_REC_MODEL` | Active global pair overrides in worker/catalog resolution and some probes. | Existing pins retained. Fresh template leaves them absent for language-aware selection. |
| Local LLM endpoints/models and disable flags | Runtime fallback controls, independent of the cloud catalog. | Keep configured values. Fresh setup disables unprovisioned local LLM/DeepL/Google fallbacks. |
| `REGISTRY_OWNER`, `USE_REMOTE_ML`, `REMOTE_ML_URL` | No runtime readers found in this checkout. The last two are still forwarded by production Compose but ignored by the Rust backend/worker. | Removed from the local `.env` and fresh template. |
| API keys | Worker `DOCKER_SECRETS_JSON` loads values into its environment, then individual `*_FILE` secrets apply to keys not supplied by JSON. | Keep keys in private JSON; fresh runtime copy omits empty strings. Do not claim existing worker code ignores empty JSON values—it currently overwrites with them. |

Source seams: `backend-rust/src/settings.rs`, `resolve.rs`, `jobs/coordinator.rs`; `worker/src/worker/config.py`, `provider_config.py`, `handlers/qa.py`, `services/ocr.py`; `scripts/provider_config.py`; `corpus/scripts/benchmark_support.py` and `benchmark_free_suite.py`.

The catalog is not currently a universal replacement for environment defaults. In particular `resolve_model_with_check` can leave an empty global model empty; its catalog check validates an override, it does not always select a replacement default. The new setup explicitly resolves catalog defaults to the generated environment file for both dev services. Explicit singleton overrides take precedence, followed by an explicit list's first entry, then a valid global catalog default for the preferred provider, then that provider's task default. Unavailable providers/invalid singleton overrides fail preparation with the field name, not credential values.

The production Compose file uses `.env` for interpolation; it does **not** forward arbitrary `.env` API keys into the worker. Existing root benchmarks load root `.env`, while the standalone corpus suite loads `corpus/.env` and/or its process environment. The new `dev_setup.py exec` bridge supplies the same private keys to host commands without duplicating them into either file.

## Local change and reproducible result

The local `.env` was compacted from **88 to 35 lines**. All 34 remaining assignments were preserved byte-for-byte; only comments/blank lines and the three inert keys above were removed. The original is retained at ignored `secrets/.env.before-output-quality` with mode `0600`; the compact `.env` is also `0600`. Neither is committed. `.env.example` now focuses on runtime/hardware settings, documents optional overrides and points to setup rather than shipping stale model lists or plaintext-key placeholders.

The original secret script was reproduced in a temporary directory: it overwrote an existing DB password and left the test file at mode `0664`. The replacement creates only missing credentials, uses restricted modes, refuses malformed/symlink inputs, merges keys under a lock and supports noninteractive private-file import. No actual user credentials were regenerated during validation.

See [dev-box-setup.md](dev-box-setup.md) for the executable fresh-clone process. `docker-compose.dev.yml` is a standalone five-service stack with isolated named volumes, explicit model path, generated secret mounts and catalog defaults. The worker's new `python -m worker.seed_models` verifies YOLO and warms requested language readers without starting the API server or publishing a keyless Redis catalog.

## Validation and resume

Setup unit/CLI checks cover credential preservation/concurrent merges, secret modes, generated QA defaults, catalog refresh, explicit overrides, private child-process key injection, model checksum/unchanged-good-artifact behavior and actual Docker Compose configuration resolution. Worker checks cover missing/mismatched YOLO, language readers, failed initialization and dependency-free help. Full worker gates and final delivery details are recorded in `quality-evidence/dev-setup-validation.json` when complete.

Fresh cloud image downloads, paid inference and a complete new app deployment are separate execution steps. Do not count mocked OCR readers as downloaded weights or a Compose configuration check as a healthy stack. Resume quality implementation at tracker A01 after setup; do not skip current-image reproduction based on the historical corpus.
