# Manga Translation Platform

An automated manga scanlation translation and typesetting dashboard. This platform leverages computer vision (OCR/Layout analysis) and Generative AI (LLMs and Vision-Language Models) to detect, translate, and typeset speech bubbles, providing a full-featured visual editor for manual refinements.

---

## 🏗️ Architecture & Stack

The platform is designed as a distributed service coordinated via a Valkey job queue:

```
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

1.  **Frontend**: React, TypeScript, Vite, Vanilla CSS.
2.  **Backend**: Spring Boot, Java, PostgreSQL, Hibernate, MinIO SDK.
3.  **Database & Storage**: PostgreSQL for metadata, layers, and edit history; MinIO S3 for raw/processed images and generated masks.
4.  **Job Pipeline**: Valkey coordinates workers through specialized job queues (panel detection, OCR, layout analysis, translation, and rendering). An optional database-driven queue is supported for brokerless deployments.
5.  **ML Workers**: A unified Python runner executing a multi-tier OCR (PaddleOCR + EasyOCR + MangaOCR) and AI Translation pipeline.

---

## 🚀 Key Features

### 1. Spatial OCR Region Merging
*   Groups separate text line-level OCR detections into logical speech bubbles before panel mapping.
*   Uses a configurable vertical/horizontal proximity algorithm (`OCR_MERGE_THRESHOLD`) which groups text boxes vertically (or horizontally) relative to the average line size.

### 2. Multi-Tiered Translation Pipeline
*   **VLM vision pass**: Contextual visual-dialogue mapping using image inputs (Gemini 1.5/2.5, OpenRouter, NVIDIA NIM).
*   **NVIDIA NIM VLM support**: Native support for free developer/evaluation endpoints at `integrate.api.nvidia.com`. Optimized for:
    *   **Translation**: `google/gemma-3n-e4b-it` & `google/gemma-3n-e2b-it`
    *   **Vision-Language (VLM)**: `nvidia/nemotron-nano-12b-v2-vl` & `microsoft/phi-4-multimodal-instruct`
*   **LLM batch & fallback**: Runs DeepSeek/Nemotron in batches, falling back to DeepL and Google Translate for resilient translations.
*   **Selective VLM Mode**: Auto-detects and triggers the visual translation tier dynamically if `VLM_MODEL` / `NVIDIA_VLM_MODEL` environment variables are populated.

### 3. Typesetting & Layout Fitting
*   Offscreen canvas engine computes typography wrappers to center text on white masks inside bubbles.
*   **Character Wrapping**: Automatically falls back to character-level splits if a long translated word exceeds the speech bubble width.
*   **Overflow Indicator**: Displays a warning red dashed outline around text boxes that overflow their boundary constraints in edit mode.

### 4. Interactive Editor & Canvas
*   **Drag & Resize**: Move and resize dialogue layers interactively using mouse drag boundary overlays and 4 corner handles.
*   **Fluid Sync**: Visual boundaries update smoothly during drags, pushing a single original frame to the undo stack upon drop, followed by an alerts-free silent save to the server.
*   **History**: Full undo/redo operations bound to `Ctrl+Z` / `Ctrl+Y` shortcuts.

### 5. Advanced Exports & Inpainting
*   **Export PNG**: Renders the cleaned page with typeset dialogue layers.
*   **Export Layer Project (ZIP)**: Generates a project bundle with `original.png`, `mask.png` (transparent background containing white inpainted bubble regions ready for Stable Diffusion/ComfyUI pipelines), `translation.png` (text overlays), and `project.json` for full workspace state portability.

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

- **Core Product Specification**: [Manga_Translation_Platform_Specification_v4.md](file:///home/sagnik/Projects/docker-composes/manga-library/Manga_Translation_Platform_Specification_v4.md)
- **Development Roadmap & Status**: [translation_platform_checklist.md](file:///home/sagnik/Projects/docker-composes/manga-library/translation_platform_checklist.md)
- **Dynamic OCR & Multi-Language Config**: [Manga_Translation_Platform_Specification_v3.md](file:///home/sagnik/Projects/docker-composes/manga-library/Manga_Translation_Platform_Specification_v3.md)
- **Base Architecture Specifications**: [Manga_Translation_Platform_Specification_v2.md](file:///home/sagnik/Projects/docker-composes/manga-library/Manga_Translation_Platform_Specification_v2.md)
