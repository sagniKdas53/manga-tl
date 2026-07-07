# Implementation Plan

Based on the requested features and priorities, this plan breaks down the tasks into structured phases. The most impactful changes—those removing bottlenecks, saving immediate costs, and improving foundational reliability—are placed in Phase 1.

## Phase 1: High Impact, Quick Wins & Core Reliability

*These tasks resolve major bottlenecks, provide immediate token savings, and improve foundational security and configuration.*

- [ ] **1.1. Parallelize Cloud Processing**
  - **Why**: Sequential local OCR is a massive bottleneck. Cloud APIs can handle parallel requests.
  - **Tasks**:
    - [ ] Add an environment variable (e.g., `CLOUD_CONCURRENCY`) to control the degree of parallelism, defaulting to `1` (sequential).
    - [ ] Refactor worker processing loops to use async task groups / parallel execution when using Cloud OCR, TL, and QA.
    - [ ] Ensure the parallel processing respects rate-limits (implement basic exponential backoff / 429 handling).
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

## Low Hanging Fruits (Testing & QA)

*These are extremely easy tasks picked from the TODO list that provide immediate value with minimal effort and can be tackled in parallel with any Phase.*

- [ ] **Test intentional bad translations**: Use a weak model to verify QA detection capabilities.
- [ ] **Test with very low quality images**: Observe OCR failure handling and error reporting.
- [ ] **Test language mismatch**: Upload a KR image to a JP series to observe behavior.

## Phase 2: Model Picker & Configuration Polish

*Improves the user experience and robustness of model selection.*

- [ ] **2.1. Model Fallbacks Configuration**
  - **Tasks**:
    - [ ] Parse the comma-separated fallback lists (`OCR_VLM_MODEL_LIST`, `TL_LLM_MODEL_LIST`, etc.).
    - [ ] Implement fallback logic in the inference clients: if the primary model fails (timeout, 500 error, etc.), retry automatically with the next model in the list.
- [ ] **2.2. Provider Model Name Mapping**
  - **Tasks**:
    - [ ] Create a mapping system to translate model formats between providers (e.g., translating OpenRouter's `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` to `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` when querying the NVIDIA API directly).
- [ ] **2.3. Dynamic Provider Visibility**
  - **Tasks**:
    - [ ] Backend: Evaluate available providers based on configured API keys and environment variables (hide OpenAI/Anthropic if no keys; hide Ollama/LM-Studio if `DISABLE_LOCAL_LLM=true`).
    - [ ] UI: Update the Model Picker to only show active providers.
    - [ ] UI: If "Local" is selected for OCR Provider, automatically disable the "OCR VLM Model" selector (since the UI should be aware local doesn't require a cloud VLM selection).

## Phase 3: Reliability & Queue Management

*Focuses on state persistence and frontend control of the job queue.*

- [ ] **3.1. Persist Job Queue Across Restarts**
  - **Why**: If Redis or the host crashes, queued jobs are currently lost.
  - **Tasks**:
    - [ ] Transition Postgres to be the "source of truth" for all job states (pending, processing, failed, completed).
    - [ ] Keep Redis for fast enqueuing/dequeuing and locking.
    - [ ] Implement recovery on worker startup: query Postgres for pending/processing jobs and re-sync them to Redis to resume work.
- [ ] **3.2. Frontend Queue Management UI**
  - **Tasks**:
    - [ ] Build a Queue Manager component in the frontend (similar to the notification manager).
    - [ ] Display jobs currently in queue and processing.
    - [ ] Automatically convert passed jobs into notifications and remove them from the queue view.
    - [ ] Move failed jobs to the bottom of the list, featuring a explicit "Retry" button.
    - [ ] Implement Pause and Resume functionality for the queue (both global and per-job).

## Phase 4: Advanced Context & Inference Features

*More complex AI features requiring prompt engineering and testing.*

- [ ] **4.1. Hybrid QA Mode (LLM + VLM)**
  - **Tasks**:
    - Introduce a QA mode that simultaneously utilizes an LLM (for textual translation accuracy) and a VLM (for visual context).
    - Implement logic to synthesize their evaluations into a final QA score/correction.
