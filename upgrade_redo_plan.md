# Revised Design & Implementation Plan: Region Editor Upgrade, Queue Split & Concurrency Fix

This plan describes the steps to deprecate the popover tooltip, migrate single-region redos to the Element Inspector sidebar, split the `region-redo` queue, remove `CLOUD_CONCURRENCY`, rename `CONCURRENT_WORKERS` to `CONCURRENT_JOBS`, and implement the heavy/light job slot concurrency model in the worker.

---

## 1. Concurrency Fix: Heavy vs Light Job Slots

Currently, any worker slot can be filled by any job. This allows slow local OCR jobs to fill all 4 slots and block faster, resource-light cloud jobs (like Translation or QA) from executing.

### The New Model

We will limit total concurrent jobs on the worker to **2** (`CONCURRENT_JOBS=2`), consisting of:

* **1 Heavy Job Slot**: For local resource-heavy operations (`panel-detection`, `ocr`, `qa-re-ocr`, and `region-redo-ocr`).
* **1 Light Job Slot**: For quick/cloud-based operations (`layout`, `translation`, `render`, `qa`, and `region-redo-tl`).

This guarantees that an active OCR job will never block layout, translation, rendering, or QA checks from running in parallel.

### Changes in `worker/health_server.py`

We will track both heavy and light job status in `health_server.py`:

```python
ACTIVE_HEAVY_JOBS = 0
ACTIVE_LIGHT_JOBS = 0
ACTIVE_JOBS = 0  # Maintained for test compatibility

HEAVY_QUEUES = {
    "queue:panel-detection",
    "queue:ocr",
    "queue:qa-re-ocr",
    "queue:region-redo-ocr",
}

LIGHT_QUEUES = {
    "queue:layout",
    "queue:translation",
    "queue:render",
    "queue:qa",
    "queue:region-redo-tl",
}
```

In `do_POST` (endpoint `/api/v1/jobs/submit`), we will read the payload first, classify the queue, and enforce the slot limits:

```python
# Check legacy global limit first (mainly for patched tests)
if ACTIVE_JOBS >= MAX_CONCURRENT_JOBS:
    self.send_response(429)
    self.end_headers()
    self.wfile.write(b"Too Many Requests: Global concurrency limit reached")
    return

# Check slot-specific limits
is_heavy = queue_name in HEAVY_QUEUES
if is_heavy:
    if ACTIVE_HEAVY_JOBS >= 1:
        self.send_response(429)
        self.end_headers()
        self.wfile.write(b"Too Many Requests: Heavy job slot occupied")
        return
    ACTIVE_HEAVY_JOBS += 1
else:
    if ACTIVE_LIGHT_JOBS >= 1:
        self.send_response(429)
        self.end_headers()
        self.wfile.write(b"Too Many Requests: Light job slot occupied")
        return
    ACTIVE_LIGHT_JOBS += 1

ACTIVE_JOBS = ACTIVE_HEAVY_JOBS + ACTIVE_LIGHT_JOBS
```

---

## 2. Deprecating `CLOUD_CONCURRENCY` & Renaming Concurrency Variables

1. **Remove `CLOUD_CONCURRENCY`**:
    * Remove `CLOUD_CONCURRENCY` from `.env`, `.env.example`, and `docker-compose.yml`.
    * Delete its definition in [worker/config.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/config.py#L77).
    * Update [ocr.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/handlers/ocr.py#L831) and [translation.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/handlers/translation.py#L155) to use `max_workers=1` inside `ThreadPoolExecutor` blocks (processing image crops and text chunks sequentially).
2. **Rename `CONCURRENT_WORKERS` to `CONCURRENT_JOBS`**:
    * In `.env`, `.env.example`, and `docker-compose.yml`, rename `CONCURRENT_WORKERS` to `CONCURRENT_JOBS` and set the default value to `2`.
    * In `health_server.py`, change the loading line to:
        `MAX_CONCURRENT_JOBS = int(os.environ.get("CONCURRENT_JOBS", os.environ.get("CONCURRENT_WORKERS", "2")))`

---

## 3. Queue Splitting: `region-redo-ocr` and `region-redo-tl`

We will split the unified `queue:region-redo` into two separate queues:

### Backend Changes

* **[WorkerDispatcherService.java](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/service/WorkerDispatcherService.java)**:
    Update the `QUEUES` list to place the new queues in their prioritized locations:

    ```java
    private final List<String> QUEUES =
        List.of(
            "queue:region-redo-tl", // High Priority (interactive re-translations)
            "queue:qa-re-ocr",
            "queue:qa",
            "queue:render",
            "queue:translation",
            "queue:layout",
            "queue:region-redo-ocr",       // Lower Priority (interactive re-OCR)
            "queue:ocr",
            "queue:panel-detection"
        );
    ```

* **[JobCoordinatorService.java](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/service/JobCoordinatorService.java)**:
  * Update `requeuePendingJobs()` to clear and recover `"queue:region-redo-ocr"` and `"queue:region-redo-tl"` instead of `"queue:region-redo"`.
  * Update `triggerRedo(UUID regionId, String redoType)` to map `redoType == "ocr"` to `"region-redo-ocr"` and `redoType == "translation"` to `"region-redo-tl"`.

### Worker Changes

* **[health_server.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/health_server.py)** & **[rq_tasks.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/rq_tasks.py)**:
    Replace `"queue:region-redo"` with the two new queue names. In `rq_tasks.py`:

    ```python
    elif queue_name in ("queue:region-redo-ocr", "queue:region-redo-tl"):
        process_region_redo(job_data)
    ```

---

## 4. Frontend: Migrating Redo to Element Inspector Sidebar

1. **Deprecate Tooltip**: Remove the `bubble-popover` block from [Reader.tsx](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/Reader.tsx).
2. **Add Sidebar Buttons**:
    Inside the `selectedItem && selectedItem.isLayerElement` card layout (between the Text Content textarea and Positioning Coordinates grid around line 4756):

    ```tsx
    {/* Manual Region Redo Section */}
    {selectedItem.regionId && (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "8px",
          marginBottom: "4px",
        }}
      >
        <button
          type="button"
          className="btn btn-secondary"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px",
            fontSize: "12px",
            padding: "8px 6px",
            height: "36px",
          }}
          disabled={isRedoing}
          onClick={() => {
            const actualRegion = ocrRegions.find(r => r.id === selectedItem.regionId);
            if (actualRegion) handleRedoRegion(actualRegion, "ocr");
          }}
        >
          {isRedoing ? (
            <div className="spinner" style={{ width: "12px", height: "12px" }}></div>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
            </svg>
          )}
          Redo OCR
        </button>

        <button
          type="button"
          className="btn btn-secondary"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "6px",
            fontSize: "12px",
            padding: "8px 6px",
            height: "36px",
          }}
          disabled={isRedoing}
          onClick={() => {
            const actualRegion = ocrRegions.find(r => r.id === selectedItem.regionId);
            if (actualRegion) handleRedoRegion(actualRegion, "translation");
          }}
        >
          {isRedoing ? (
            <div className="spinner" style={{ width: "12px", height: "12px" }}></div>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
            </svg>
          )}
          Redo TL
        </button>
      </div>
    )}
    ```

---

## 5. Respecting Rate Limits & Fixing 429 Cooldown Bugs

We will address the rate limiting and 429 cooldown bugs in the worker to improve resilience when hitting API rate limits.

### Code Changes in `worker/services/translation.py`

1. **Invoke Cooldown Wait**: At the beginning of `try_cloud_ai`, we will call the existing `wait_for_cooldown(provider)` helper to block execution until any active cooldown expires, rather than immediately skipping the provider.
2. **Prevent Parallel 429s during Retry Backoff**: When a 429 response is first encountered, we will set a temporary/tentative cooldown on the provider equal to the retry sleep duration. This ensures that other concurrent threads or jobs immediately skip or wait for the provider instead of triggering additional parallel 429s.

```python
def try_cloud_ai(
    provider, api_key, model, prompt, response_schema=None, request_id=None
):
    req_prefix = f"[{request_id}] " if request_id else ""
    global PROVIDER_COOLDOWNS
    
    # 1. Wait for any active cooldown to clear before making the request
    wait_for_cooldown(provider)
    
    cooldown_until = PROVIDER_COOLDOWNS.get(provider, 0.0)
    if time.time() < cooldown_until:
        logger.warning(
            f"{req_prefix}Skipping provider '{provider}' because it is in cooldown for another {int(cooldown_until - time.time())} seconds."
        )
        return None

    enforce_rate_limit()
    
    # ... URL/headers setup ...
    
    for attempt in range(max_retries + 1):
        try:
            # ... request execution ...
            
            if response.status_code == 429:
                if attempt < max_retries:
                    sleep_time = base_backoff * (2**attempt)
                    # 2. Set tentative cooldown to protect provider during retry sleep
                    PROVIDER_COOLDOWNS[provider] = time.time() + sleep_time + 1.0
                    logger.warning(
                        f"{req_prefix}Provider '{provider}' returned 429. Retrying in {sleep_time:.2f}s..."
                    )
                    time.sleep(sleep_time)
                    continue
                else:
                    logger.warning(
                        f"{req_prefix}Provider '{provider}' returned 429. Initiating 60s cooldown."
                    )
                    PROVIDER_COOLDOWNS[provider] = time.time() + 60.0
                    return None
```

*Note: Remote workers and parallelizing local detection models across workers are officially cancelled, so no architecture or worker scaling changes are included in this plan.*
