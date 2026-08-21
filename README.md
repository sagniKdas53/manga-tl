# Manga Translation Platform

An automated manga scanlation translation and typesetting dashboard. It uses computer vision (OCR / layout analysis) and generative AI (LLMs and vision-language models) to detect, translate, and typeset speech bubbles. A full-featured visual editor is included for manual refinements.

---

## Architecture & stack

The platform is designed as a distributed service coordinated via a Valkey job queue:

```txt
                  ┌───────────────────────┐
                  │   React / Vite Web    │
                  │       Frontend        │
                  └───────────┬───────────┘
                              │ REST / WebSockets
                  ┌───────────▼───────────┐
                  │      Spring Boot      │
                  │     Backend API       │
                  └───────────┬───────────┘
                              │
          ┌────────────────────┼────────────────────┐
    ┌─────▼─────┐        ┌─────▼─────┐        ┌─────▼─────┐
    │PostgreSQL │        │ MinIO S3  │        │  Valkey   │
    │ Database  │        │  Storage  │        │   Queue   │
    └───────────┘        └───────────┘        └─────┬─────┘
                                                    │ Jobs
                                              ┌─────▼─────┐
                                              │  Unified  │
                                              │ Python ML │
                                              │  Worker   │
                                              └───────────┘
```

1. **Frontend**: React, TypeScript, Vite, Vanilla CSS.
2. **Backend**: Spring Boot, Java, PostgreSQL, Hibernate, MinIO SDK.
3. **Database & Storage**: PostgreSQL for metadata, layers, and edit history; MinIO S3 for raw/processed images and generated masks.
4. **Job Pipeline**: Valkey coordinates workers through specialized job queues (panel detection, OCR, layout analysis, translation, and rendering). An optional database-driven queue is supported for brokerless deployments.
5. **ML Workers**: A unified Python runner executing local OCR (PaddleOCR + YOLO bubble detector) and AI Translation pipelines.

### Job pipeline flow

The translation pipeline flows sequentially from panel detection to final quality checks:

1. **Panel Detection**: Segments panels on the page.
2. **OCR (PaddleOCR + YOLO)**:
   * **Text Detection**: Runs PaddleOCR on the entire page to detect raw text line fragments.
   * **Bubble Detection**: Runs the YOLO bubble segmentation model to identify bubble coordinates/polygons.
   * **Mapping**: Maps raw text line fragments to detected bubbles using coordinate overlap.
3. **Layout Analysis**: Groups text blocks into logical reading orders.
4. **Translation**: Sequences dialogue through cloud or local LLM fallback chains.
5. **Typesetting & Rendering**: Draws background masks (using bubble polygons) and lays out the translated text inside the bubbles.
6. **Visual QA**: AI checks visual and semantic quality, flagging any issues.

---

## Key features

### 1. Spatial OCR region merging

* Groups separate text line-level OCR detections into logical speech bubbles before panel mapping.
* Uses a configurable vertical/horizontal proximity algorithm (`OCR_MERGE_THRESHOLD`) which groups text boxes vertically (or horizontally) relative to the average line size.
  * **Tuning `OCR_MERGE_THRESHOLD`**:
    * **Increase the value (e.g., to `1.0` or `1.5`)**: If text fragments inside the same bubble are being split into separate bubbles incorrectly (under-grouping).
    * **Decrease the value (e.g., to `0.3` or `0.4`)**: If separate bubbles or adjacent columns of text are being merged together incorrectly (over-grouping).
    * **Default value**: Set to `1.0` in `docker-compose.yml`, falling back to `0.5` if unconfigured.

### 2. Cloud OCR & local OCR engines

* By default, the system uses local OCR engines (PaddleOCR + YOLO bubble detector) to detect and extract text.
* However, you can disable local OCR by setting `DISABLE_LOCAL_OCR=true` in the `.env` file.
* If local OCR is disabled, the system will use Cloud Vision-Language Models (VLMs) for the OCR path instead.
* *Note: The VLM translation path has been removed, as VLMs are not recommended for translation work due to their lower BLEU scores compared to text-only LLMs. VLMs are now strictly used for OCR and visual quality assurance.*

### 3. Multi-tiered translation strategy & fallback control

The worker executes translation tasks sequentially through a tiered hierarchy, attempting higher-quality models first and falling back if errors occur:

```
Cloud LLM → Local LLM (Ollama/LMStudio) → DeepL Fallback → Google Translate (Free API)
```

#### Model & provider selection

The worker supports multiple cloud and local model providers for both textual and visual (multimodal) translation tasks:

* **Gemini (Direct)**: Configured using `MODEL_PROVIDER=gemini` and `GEMINI_API_KEY`.
* **OpenRouter**: Configured using `MODEL_PROVIDER=openrouter` and `OPENROUTER_API_KEY`. Great for routing between high-end paid models and excellent free models.
  * *Translation (Paid)*: `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash`
  * *Translation (Free)*: `google/gemma-4-31b-it:free`
  * *OCR / QA (VLM)*: `google/gemini-3.1-flash-lite`, `google/gemma-4-26b-a4b-it:free`
* **Nvidia NIM**: Configured using `MODEL_PROVIDER=nvidia` and `NVIDIA_API_KEY`.
  * *Translation*: `deepseek-ai/deepseek-v4-flash`, `google/gemma-3n-e4b-it`
  * *OCR / QA (VLM)*: `nvidia/nemotron-nano-12b-v2-vl`
* **Anthropic**: Configured using `MODEL_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`.
* **OpenAI**: Configured using `MODEL_PROVIDER=openai` and `API_KEY`.

#### Pipeline bypass environment controls

You can enable or disable different fallback layers in [.env](.env) using the following environment variables:

| Environment Variable       | Description                                                                                                     |
|:--------------------------- |:---------------------------------------------------------------------------------------------------------------- |
| `DISABLE_LOCAL_OCR`        | Set to `true` to disable local OCR engines and use Cloud VLMs for OCR instead.                                  |
| `DISABLE_LOCAL_LLM`        | Set to `true` to skip all Local LLM (Ollama/LMStudio) lookups. Useful if local models are unconfigured or slow. |
| `DISABLE_DEEPL_TRANSLATE`  | Set to `true` to skip DeepL fallback translation.                                                               |
| `DISABLE_GOOGLE_TRANSLATE` | Set to `true` to skip the free web-scraping Google Translate fallback.                                          |

*Note: If all enabled translation layers fail, the region is marked failed, but the queue job will continue processing.*

#### Provider rate limiting & cooldowns

To respect remote API limitations and avoid bombarding servers with request storms, the worker enforces two mechanisms:

1. **Rate Limiting Delay**: Each provider's `rateLimits` in `config/providers.json` gives the requests per minute for that provider, from which a minimum delay between consecutive requests to it is enforced with `time.sleep()`. The `RATE_LIMIT` environment variable is only a fallback for a provider that does not declare one (e.g. `RATE_LIMIT=30` for 30 requests per minute, giving a 2.0 second delay); it is **unset by default, meaning unlimited**.
2. **429 Provider Cooldown**: If a remote provider returns a `429 (Too Many Requests)` status code:
    * The worker initiates a **60-second cooldown** for that specific provider.
    * Subsequent requests within that 60-second window immediately bypass the provider and trigger fallback tiers.
    * This prevents a loop of 10–20 individual region requests from spamming a rate-limited endpoint.

#### QA mode auto-detection & fallbacks

When `QA_MODE=auto` (default) is configured in your environment, the worker evaluates available capabilities at startup to determine the most suitable QA pipeline. `auto` mode will **never** select `hybrid` by default. If both VLM and LLM capabilities are present, `auto` defaults to `vlm` to save on API costs and processing time. You must explicitly select `hybrid` to use the two-step pipeline:

* **VLM Mode (`vlm`)**: Activated if `PREFERRED_VLM_MODEL` is set, or if `LOCAL_VLM_MODEL` is set (and `DISABLE_LOCAL_LLM` is false). Performs a single-pass side-by-side visual comparison (original vs typeset image). It does **not** use a text-only LLM.
* **Hybrid Mode (`hybrid`)**: A two-step pipeline. First, an LLM performs text-only semantic translation review. After applying text fixes, a VLM performs a final visual layout check.
* **LLM Mode (`llm`)**: Activated if VLM is unavailable, but a `MODEL_PROVIDER` is selected or a local LLM model is configured (and `DISABLE_LOCAL_LLM` is false). Performs text-only semantic translation review.
* **None Mode (`none`)**: Bypasses the QA check entirely, auto-passing all text regions.

> [!TIP]
> **Fail-Safe Behavior**
> If VLM or LLM evaluation runs but fails (due to API key errors, rate limits, or bad JSON formats), the QA worker will catch the error and fallback to **automatically passing all regions**:
>
> ```txt
> [QA] Falling back to default PASS for all regions.
> ```
>
> This prevents the backend typesetting pipeline from freezing or hanging when AI components fail.

### 4. Typesetting & layout fitting

* Offscreen canvas engine computes typography wrappers to center text on white masks inside bubbles.
* **Character wrapping**: falls back to character-level splits when a long translated word exceeds the speech bubble width.
* **Overflow indicator**: a red dashed outline marks text boxes that overflow their boundary constraints in edit mode.

### 5. Interactive editor & canvas

* **Drag & resize**: move and resize dialogue layers interactively using mouse drag boundary overlays and 4 corner handles.
* **Fluid sync**: visual boundaries update smoothly during drags. Dropping pushes a single original frame to the undo stack, then saves silently to the server.
* **History**: full undo/redo bound to `Ctrl+Z` / `Ctrl+Y`.

### 6. Advanced exports & inpainting

* **Export PNG**: Renders the cleaned page with typeset dialogue layers.
* **Export Layer Project (ZIP)**: Generates a project bundle with `original.png`, `mask.png` (transparent background containing white inpainted bubble regions ready for Stable Diffusion/ComfyUI pipelines), `translation.png` (text overlays), and `project.json` for full workspace state portability.

---

## Pre-built images

Both images are published to the GitHub Container Registry on every merge to `main`, and are
public — no `docker login` is needed to pull them.

```bash
docker pull ghcr.io/sagnikdas53/manga-tl:latest         # backend + bundled frontend
docker pull ghcr.io/sagnikdas53/manga-tl-worker:latest  # Python ML worker
```

`docker-compose.yml` already references both, so `docker compose up -d` pulls rather than builds.

| Tag | Points at | Use it for |
| --- | --- | --- |
| `latest` | current `main` | Deployments. This is the tag Watchtower follows. |
| `main`, `master` | current `main` | Aliases of `latest`. Both exist so that `:master` — this repo's default branch is `main`, but yt-diff's is `master` — does not fail. |
| `1.4.0` | that release | Pinning to an exact version. Note there is **no** leading `v`; the git tag is `v1.4.0` but `docker/metadata-action` strips it. |
| `1.4` / `1` | newest 1.4.x / 1.x | Auto-updating within a minor or major line. |
| `sha-a1b2c3d` | one commit | Rollback to a specific build. Kept for 7 days. |

Version tags are cut automatically from [Conventional Commits](https://www.conventionalcommits.org/):
a `feat:` on `main` bumps the minor, a `fix:` bumps the patch, and `BREAKING CHANGE:` bumps the
major. A merge with no conventional prefix does not cut a release.

### Platform support

| Image | linux/amd64 | linux/arm64 |
| --- | --- | --- |
| `manga-tl` | ✅ | ✅ |
| `manga-tl-worker` | ✅ | ❌ |

The worker is **amd64 only**. It pins `paddlepaddle==3.3.1`, which publishes no `linux_aarch64`
wheel to PyPI — only `manylinux1_x86_64`, `macosx_11_0_arm64` and `win_amd64` — so an arm64
build fails at `pip install`. Running the full stack therefore needs an amd64 host.

---

## Getting started

### 1. Configure environment variables

Create a `.env` file in the root directory (see `.env.example` for details):

```bash
# Set your model provider (nvidia, openrouter, gemini, etc.)
MODEL_PROVIDER=nvidia
API_KEY=nvapi-YOUR_NVIDIA_API_KEY

# Preferred Models
PREFERRED_MODEL=google/gemma-3n-e4b-it
VLM_MODEL=nvidia/nemotron-nano-12b-v2-vl

# OCR Merging vertical proximity multiplier
OCR_MERGE_THRESHOLD=0.50
```

### 2. Start services

Launch the complete stack in detached mode:

```bash
docker compose up -d
```

### 3. Rebuild / restart workers

If you make changes to the ML worker or environment configurations:

```bash
docker compose up -d --force-recreate worker
```

---

## Running tests

The worker's suite runs against the repo-root `.venv` (Python 3.13), not one inside `worker/`:

```bash
cd worker
../.venv/bin/python -m pytest -q     # 415 passing, ~7s, no real I/O
```

The full gate (backend, frontend and worker) is in
[docs/guides/quality_gate.md](docs/guides/quality_gate.md). Run its checks **sequentially**; this
host locks up if they are run in parallel.

---

## Documentation

**[`docs/README.md`](docs/README.md) is the index.** It groups every document by whether it
describes current behaviour, tells you how to do something, proposes something unbuilt, or
records finished work.

The three you most likely want:

| | |
| --- | --- |
| What's outstanding | [TODO.md](TODO.md): roadmap · [docs/issues.md](docs/issues.md): open bugs and audit findings |
| How the pipeline works | [docs/reference/translation_pipeline_phases.md](docs/reference/translation_pipeline_phases.md) |
| Checks to run before committing | [docs/guides/quality_gate.md](docs/guides/quality_gate.md) |
