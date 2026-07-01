# Manga Translation Platform

An automated manga scanlation translation and typesetting dashboard. This platform leverages computer vision (OCR/Layout analysis) and Generative AI (LLMs and Vision-Language Models) to detect, translate, and typeset speech bubbles, providing a full-featured visual editor for manual refinements.

---

## 🏗️ Architecture & Stack

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
5. **ML Workers**: A unified Python runner executing a multi-tier OCR (PaddleOCR + EasyOCR + MangaOCR) and AI Translation pipeline.

---

## 🚀 Key Features

### 1. Spatial OCR Region Merging

* Groups separate text line-level OCR detections into logical speech bubbles before panel mapping.
* Uses a configurable vertical/horizontal proximity algorithm (`OCR_MERGE_THRESHOLD`) which groups text boxes vertically (or horizontally) relative to the average line size.

### 1.5. Cloud OCR & Local OCR Engines

* By default, the system utilizes local OCR engines (PaddleOCR + EasyOCR + MangaOCR) to detect and extract text.
* However, you can disable local OCR by setting `DISABLE_LOCAL_OCR=true` in the `.env` file.
* If local OCR is disabled, the system will use Cloud Vision-Language Models (VLMs) for the OCR path instead.
* *Note: The VLM translation path has been removed, as VLMs are not recommended for translation work due to their lower BLEU scores compared to text-only LLMs. VLMs are now strictly used for OCR and visual quality assurance.*

### 2. Multi-Tiered Translation Strategy & Fallback Control

The worker executes translation tasks sequentially through a tiered hierarchy, attempting higher-quality models first and falling back if errors occur:

$$\text{Cloud LLM} \longrightarrow \text{Local LLM (Ollama/LMStudio)} \longrightarrow \text{DeepL Fallback} \longrightarrow \text{Google Translate (Free API)}$$

#### 🔑 Model & Provider Selection

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

#### 🎛️ Pipeline Bypass Environment Controls

You can enable or disable different fallback layers in [.env](file:///home/sagnik/Projects/docker-composes/manga-library/.env) using the following environment variables:

| Environment Variable | Description |
| :--- | :--- |
| `DISABLE_LOCAL_OCR` | Set to `true` to disable local OCR engines and use Cloud VLMs for OCR instead. |
| `DISABLE_LOCAL_LLM` | Set to `true` to skip all Local LLM (Ollama/LMStudio) lookups. Useful if local models are unconfigured or slow. |
| `DISABLE_DEEPL_TRANSLATE` | Set to `true` to skip DeepL fallback translation. |
| `DISABLE_GOOGLE_TRANSLATE` | Set to `true` to skip the free web-scraping Google Translate fallback. |

*Note: If all enabled translation layers fail, the region is marked failed, but the queue job will continue processing.*

#### ⏳ Provider Rate Limiting & Cooldowns

To respect remote API limitations and avoid bombarding servers with request storms, the worker enforces two mechanisms:

1. **Rate Limiting Delay**: The `RATE_LIMIT` environment variable (e.g., `RATE_LIMIT=30` representing 30 requests per minute) calculates a minimum delay (e.g., 2.0 seconds) enforced between consecutive requests using `time.sleep()`.
2. **429 Provider Cooldown**: If a remote provider returns a `429 (Too Many Requests)` status code:
    * The worker initiates a **60-second cooldown** for that specific provider.
    * Subsequent requests within that 60-second window immediately bypass the provider and trigger fallback tiers.
    * This prevents a loop of 10–20 individual region requests from spamming a rate-limited endpoint.

#### 🔍 QA Mode Auto-Detection & Fallbacks

When `QA_MODE=auto` (default) is configured in your environment, the worker evaluates available capabilities at startup to determine the most suitable QA pipeline:

* **VLM Mode (`vlm`)**: Activated if `PREFERRED_VLM_MODEL` is set, or if `LOCAL_VLM_MODEL` is set (and `DISABLE_LOCAL_LLM` is false). Performs side-by-side visual comparison (original vs typeset image).
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

### 3. Typesetting & Layout Fitting

* Offscreen canvas engine computes typography wrappers to center text on white masks inside bubbles.
* **Character Wrapping**: Automatically falls back to character-level splits if a long translated word exceeds the speech bubble width.
* **Overflow Indicator**: Displays a warning red dashed outline around text boxes that overflow their boundary constraints in edit mode.

### 4. Interactive Editor & Canvas

* **Drag & Resize**: Move and resize dialogue layers interactively using mouse drag boundary overlays and 4 corner handles.
* **Fluid Sync**: Visual boundaries update smoothly during drags, pushing a single original frame to the undo stack upon drop, followed by an alerts-free silent save to the server.
* **History**: Full undo/redo operations bound to `Ctrl+Z` / `Ctrl+Y` shortcuts.

### 5. Advanced Exports & Inpainting

* **Export PNG**: Renders the cleaned page with typeset dialogue layers.
* **Export Layer Project (ZIP)**: Generates a project bundle with `original.png`, `mask.png` (transparent background containing white inpainted bubble regions ready for Stable Diffusion/ComfyUI pipelines), `translation.png` (text overlays), and `project.json` for full workspace state portability.

---

## 🛠️ Getting Started

### 1. Configure Environment Variables

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

### 2. Start Services

Launch the complete stack in detached mode:

```bash
docker compose up -d
```

### 3. Rebuild / Restart Workers

If you make changes to the ML worker or environment configurations:

```bash
docker compose up -d --force-recreate worker
```

---

## 🧪 Running Tests

Verify the backend ML worker services (OCR merging and translation validation validators):

```bash
# Activate virtual environment
source .venv/bin/activate

# Execute backend validation tests
python -c "import sys; sys.path.insert(0, 'unified-workers'); from tests.test_merge_regions import *; test_merge_no_regions(); test_merge_single_region(); test_merge_overlapping_regions(); test_merge_rtl_regions(); from tests.test_translation_validation import *; test_valid_translation(); test_cjk_leak_translation(); test_length_ratio_translation(); test_excessive_repetition_translation(); print('ALL TESTS PASSED!')"
```

---

## 📄 Documentation Index

* **Development Roadmap & Status**: [TODO.md](TODO.md)
