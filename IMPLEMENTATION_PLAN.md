# Implementation Plan

Based on the requested features and priorities, this plan breaks down the tasks into structured phases. The most impactful changes—those removing bottlenecks, saving immediate costs, and improving foundational reliability—are placed in Phase 1.

## Phase 1: High Impact, Quick Wins & Core Reliability

*These tasks resolve major bottlenecks, provide immediate token savings, and improve foundational security and configuration.*

- [x] **1.1. Parallelize Cloud Processing**
  - **Goal**: Refactor worker processing loops to use async task groups / parallel execution when using Cloud OCR, TL, and QA.
  - **File(s) to Modify**: `worker/handlers/ocr.py`, `worker/handlers/translation.py`, `worker/handlers/qa.py`
  - **Task**:
    - Add `CLOUD_CONCURRENCY` env var (default 1).
    - Implement concurrency in the handlers.
    - Ensure thread safety and implement `tenacity` exponential backoff / 429 handling.
- [x] **1.2. Chapter-Level Memory Toggle**
  - **Why**: "I don't want the full memory thing right away but a way to disable or enable it at chapter level now." Prevents wasting tokens on stand-alone pages.
  - **Tasks**:
    - [x] Add a toggle (UI and backend) to enable/disable the injection of previous page context at the chapter level.
- [x] **1.3. Eliminate Redundant Keys**
  - **Why**: Simple cleanup to reduce confusion.
  - **Tasks**:
    - [x] Remove `NVIDIA_OCR_API_KEY` requirement and fall back entirely to `NVIDIA_API_KEY`.
- [x] **1.4. Docker Secrets File Support**
  - **Why**: Best practice for secure deployments (Swarm/Compose).
  - **Tasks**:
    - [x] Add support for the `_FILE` suffix convention in both backend and worker config loaders.
    - [x] Enable reading secrets for Database, MinIO, JWT, and API Keys from mounted files (e.g., `/run/secrets/db_password`).
    - [x] *Optional enhancement*: Support loading a single JSON file containing multiple secrets to avoid mounting many individual files.

## Phase 2: Model Picker & Configuration Polish

*Improves the user experience and robustness of model selection.*

- [x] **2.1. Model Fallbacks Configuration**
  - **Tasks**:
    - [x] Parse the comma-separated fallback lists (`OCR_VLM_MODEL_LIST`, `TL_LLM_MODEL_LIST`, etc.).
    - [x] Implement fallback logic in the inference clients: if the primary model fails (timeout, 500 error, etc.), retry automatically with the next model in the list.
- [x] **2.2. Dynamic Provider Visibility**
  - **Tasks**:
    - [x] Backend: Evaluate available providers based on configured API keys and environment variables (hide OpenAI/Anthropic if no keys; hide Ollama/LM-Studio if `DISABLE_LOCAL_LLM=true`).
    - [x] UI: Update the Model Picker to only show active providers.
    - [x] UI: If "Local" is selected for OCR Provider, automatically disable the "OCR VLM Model" selector (since the UI should be aware local doesn't require a cloud VLM selection).

## Phase 3: Reliability & Queue Management

*Focuses on state persistence and frontend control of the job queue.*

- [x] **3.1. Persist Job Queue Across Restarts**
  - **Why**: If Redis or the host crashes, queued jobs are currently lost.
  - **Tasks**:
    - [x] Transition Postgres to be the "source of truth" for all job states (pending, processing, failed, completed).
    - [x] Keep Redis for fast enqueuing/dequeuing and locking.
    - [x] Implement recovery on worker startup: query Postgres for pending/processing jobs and re-sync them to Redis to resume work.
- [x] **3.2. Frontend Queue Management UI**
  - **Tasks**:
    - [x] Build a Queue Manager component in the frontend (similar to the notification manager).
    - [x] Display jobs currently in queue and processing.
    - [x] Automatically convert passed jobs into notifications and remove them from the queue view.
    - [x] Move failed jobs to the bottom of the list, featuring a explicit "Retry" button.
    - [x] Implement Pause and Resume functionality for the queue (both global and per-job).

## Phase 4: Advanced Context & Inference Features

*More complex AI features requiring prompt engineering and testing.*

- [ ] **4.1. Hybrid QA Mode (LLM + VLM)**
  - **Tasks**:
  - [ ] The LLM checks the translation and gives feedback on fixes, check if the correct layers are set ot be visible and generates the render
  - [ ] The VLM does the final pass on the rendered image

## Low Hanging Fruits (Testing & QA)

*These are extremely easy tasks picked from the TODO list that provide immediate value with minimal effort and can be tackled in parallel with any Phase.*

- [ ] **Test intentional bad translations**: Use a weak model to verify QA detection capabilities.
- [ ] **Test with very low quality images**: Observe OCR failure handling and error reporting.
- [ ] **Test language mismatch**: Upload a KR image to a JP series to observe behavior.
