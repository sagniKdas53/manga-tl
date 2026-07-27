# Implementation Plan: Provider-Aware Model Mapping, Key Verification & Inheritance System

## Goal

Implement a robust provider-model mapping architecture that:

1. Verifies API key availability per provider before listing active providers.
2. Dynamically maps compatible models to each AI provider (e.g., Gemini gets `gemini-1.5-flash`, Nvidia gets `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`, Neurometric gets `clawpack`, OpenRouter gets `:free` tagged models).
3. Updates the frontend `SettingsModal` to dynamically filter model options based on selected provider and remove redundant `-- Default / Inherit Env --` options.
4. Adds worker-level model name normalization so cross-provider overrides or inherited settings (e.g., sending `google/gemini-2.5-flash:free` to direct Gemini API) cleanly strip prefixes/suffixes to prevent API 404/400 errors.

---

## Proposed Changes

### Backend

#### [MODIFY] [SystemSettingsDto.java](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/dto/SystemSettingsDto.java)

- Add `providerModelsMap` (a `Map<String, List<String>>`) to convey provider-to-model options to the frontend.

#### [MODIFY] [SystemSettingsService.java](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/service/SystemSettingsService.java)

- Update `getSettings()` to:
  1. Inspect API keys dynamically (`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `NEUROMETRIC_API_KEY`, fallback `API_KEY`) and build `activeProviders` / `activeOcrProviders` containing only available providers.
  2. Build `providerModelsMap` mapping each provider (`openrouter`, `gemini`, `nvidia`, `neurometric`, `openai`, `anthropic`, `ollama`, `lmstudio`) to its list of valid model IDs.

---

### Frontend

#### [MODIFY] [SettingsModal.tsx](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/SettingsModal.tsx)

- Dynamically filter model options based on the currently selected `tlProvider`, `ocrProvider`, and `qaProvider` using `providerModelsMap`.
- Remove `-- Default / Inherit Env --` menu items from model dropdowns.
- Automatically update the selected model to a valid default when the user changes the provider.

#### [MODIFY] [types.ts](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/types.ts)

- Update `SystemSettingsDto` TypeScript interface to include optional `providerModelsMap?: Record<string, string[]>`.

---

### Worker Service (Python)

#### [MODIFY] [config.py](file:///home/sagnik/Projects/docker-composes/manga-library/worker/src/worker/config.py)

- Register `neurometric` in `ModelConfig.resolve_key()` mapping `NEUROMETRIC_API_KEY`.

#### [MODIFY] [llm_client.py](file:///home/sagnik/Projects/docker-composes/manga-library/worker/src/worker/services/llm_client.py)

- Add `neurometric` to `PROVIDER_REGISTRY`.
- Add `normalize_model_name(provider, model)` helper in `LLMClient`:
  - `gemini`: Strips `google/` or `models/` prefix and `:free` suffix.
  - `nvidia`: Strips `:free` suffix.
  - `neurometric`: Strips `neurometric/` prefix.
  - `openai` / `anthropic`: Strips `:free` suffix.

---

## Verification Plan

### Automated Tests

1. **Backend Tests**:
   - Run `mvn test` in `./backend` to verify `SettingsControllerTest`, `SystemSettingsServiceTest`, and `JobCoordinatorServiceTest`.
2. **Worker Tests**:
   - Run pytest in `./worker`: `pytest` to test `llm_client.py` model normalization and provider key resolution.
3. **Frontend Build & Lint**:
   - Run `npm run build` in `./frontend` to ensure TypeScript types and component props compile cleanly.

### Manual Verification

1. Open the System Settings modal in the web app:
   - Change Translation Provider to `gemini` → confirm model dropdown dynamically switches to Gemini models (`gemini-2.5-flash`, `gemini-1.5-flash`, etc.) and no `-- Default / Inherit Env --` is present.
   - Change Translation Provider to `nvidia` → confirm model dropdown switches to Nvidia models (`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`, etc.).
   - Change Translation Provider to `openrouter` → confirm OpenRouter model list is displayed.
