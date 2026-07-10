# Concurrency and Parallel Processing Analysis Report

This report presents the validation results of the parallel processing checklist items based on the logs in [run-2.log](file:///home/sagnik/Projects/docker-composes/manga-library/logs/run-2.log) and [run-1.log](file:///home/sagnik/Projects/docker-composes/manga-library/logs/run-1.log).

---

## Executive Summary

1. **OCR Bottleneck is Real**: Page processing is strictly sequential at the local level. Even though `CONCURRENT_WORKERS=4` allows the worker to accept multiple page jobs in parallel, local detection models (YOLO bubble detection and PaddleOCR text detection) are serialized using a global Valkey/Redis lock: `"ocr"`.
2. **Sequential cloud requests**: Because local detection takes ~15 seconds per page under the lock, and cloud VLM OCR requests take only ~7–9 seconds, the cloud requests from different pages are naturally serialized and never run concurrently.
3. **`CLOUD_CONCURRENCY` Behavior**: The setting is configured and parsed correctly. However, inside a single page OCR job, detected regions are grouped into chunks of 10. Since pages in the logs had 10 or fewer regions, they were processed as a single chunk, which results in sending only 1 request to OpenRouter per page.
4. **Rate Limit Interaction**: The rate limiter (`enforce_rate_limit()`) enforces a strict minimum delay between requests (e.g., 6 seconds sleep for a 10 RPM limit). When multiple threads within the same job attempt to send requests, the rate limiter spacing forces them to execute sequentially, rendering `CLOUD_CONCURRENCY` ineffective under tight limits.
5. **429 Handling**: Exponential backoff (2s, 4s, 8s retries) and 60-second provider cooldowns are implemented correctly. Dict-based cooldowns are shared across threads, causing subsequent requests to immediately skip a failing provider. However, concurrent threads already in flight or starting before retry exhaustion can still trigger parallel 429s.

---

## Detailed Findings per Checklist Item

### 1. Parallelize Processing (Bottleneck Analysis)

- **Status**: **Sequential (Pending Parallelization)**
- **Mechanics**:
  - The worker main loop pushes tasks to parallel execution threads (up to `CONCURRENT_WORKERS=4`).
  - However, [worker/handlers/ocr.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/handlers/ocr.py#L328-L333) wraps the local models in a lock block:

    ```python
    with acquire_lock("ocr"):
        # Local YOLO bubble detection & PaddleOCR region detection
    ```

  - While Job 1 is running local detection (holding the `"ocr"` lock), Job 2 and Job 3 block.
  - Once Job 1 finishes local detection (releasing `"ocr"` lock), it starts its cloud VLM request. Job 2 then acquires the `"ocr"` lock and starts local detection.
  - Since local detection takes ~15 seconds, and the cloud vision transcription step takes only ~7–9 seconds, Job 1's cloud request finishes *before* Job 2 releases the lock. Thus, cloud requests never overlap across jobs, making the process sequential.

| Page Job | Local Detection (Held Lock) | Cloud Vision Request |
| :--- | :--- | :--- |
| **Page 1** | 04:59:41 - 04:59:56 (~15s) | 04:59:56 - 05:00:03 (~7s) |
| **Page 2** | 04:59:56 - 05:00:10 (~14s) | 05:00:10 - 05:00:19 (~9s) |
| **Page 3** | 05:00:10 - 05:00:26 (~16s) | 05:00:26 - 05:00:34 (~8s) |

---

### 2. Cloud OCR Task Parallelization

- **Status**: **Confirmed (Not currently parallelized due to local detection)**
- **Mechanics**:
  - As noted in the codebase, even when `disable_local_ocr` is configured to offload OCR transcription to a cloud VLM, the worker still must run `PP-OCR-v6` for text region detection and `YOLO` for bubble detection locally.
  - Offloading these tasks to external detection APIs or running dedicated workers on remote machines is required to eliminate this lock-contention bottleneck.

---

### 3. Environment Variable Configuration (`CLOUD_CONCURRENCY`)

- **Status**: **Working Correctly**
- **Mechanics**:
  - The variable `CLOUD_CONCURRENCY` is defined in `.env` (set to `2`) and correctly loaded in [worker/config.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/config.py#L77):

    ```python
    CLOUD_CONCURRENCY = int(os.environ.get("CLOUD_CONCURRENCY", "1"))
    ```

  - It is utilized inside [worker/handlers/ocr.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/handlers/ocr.py#L831) and [worker/handlers/translation.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/handlers/translation.py#L155) to configure the thread pool:

    ```python
    with concurrent.futures.ThreadPoolExecutor(max_workers=CLOUD_CONCURRENCY) as executor:
    ```

---

### 4. `CLOUD_CONCURRENCY=2` Not Sending Parallel Requests

- **Status**: **Expected Behavior given Chunking & Rate Limiting**
- **Mechanics**:
  1. **Chunking**: In `ocr.py`, region list crops are chunked in batches of 10. All pages in the log had 10 or fewer regions, resulting in only 1 chunk (and 1 worker thread) per page.
  2. **Rate Limiting**: In `translation.py`, translation chunks are processed in parallel using the `ThreadPoolExecutor`. However, inside the thread, the function calls `enforce_rate_limit()` which acquires `RATE_LIMIT_LOCK` and spaces request start times:

     ```python
     if elapsed < min_delay:
         sleep_time = min_delay - elapsed
         LAST_REQUEST_TIME = now + sleep_time
     ```

     With a `RATE_LIMIT=10` RPM setting, the threads are forced to sleep sequentially to maintain a 6-second delay between requests. This serialized the requests in practice despite the `ThreadPoolExecutor`.

---

### 5. Parallelizing Bubble and Text Detection Across Workers

- **Status**: **Pending Implementation**
- **Mechanics**:
  - Currently, we only have one worker container. Parallelizing detection would require deploying multiple workers or routing detection tasks to a cloud-based server.

---

### 6. Respecting Rate Limits & 429 Cooldowns

- **Status**: **Mostly Working (with minor overlap during retry sleeps)**
- **Mechanics**:
  - **Retries & Backoff**: Exponential backoff (`base_backoff * (2**attempt)`) sleeps correctly for 2s, 4s, 8s on 429 responses.
  - **Cooldown**: Upon retry exhaustion, a 60-second cooldown is set in a global dictionary: `PROVIDER_COOLDOWNS[provider] = time.time() + 60.0`.
  - **Threading Behavior**: Because the dictionary is global, subsequent threads instantly skip the provider. However, *during* the retry backoff sleep of the first thread, other parallel threads that are already in-flight or starting will still send requests to the provider and hit 429s before the cooldown is officially recorded.
  - **Code Issue**: [worker/services/translation.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/translation.py#L320) defines a helper `wait_for_cooldown` but it is **never called** anywhere in the code. Cooldown skips are instead done inline in `try_cloud_ai` (lines 371-376).
