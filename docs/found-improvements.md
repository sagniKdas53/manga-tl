# 1. Clarifying "Completed" Features

**Static Retries vs. Failover**
You are absolutely correct that retrying the same provider (e.g., 4/4 times) is the right approach for *transient* errors, like hitting a 429 Rate Limit or a temporary 503 Network Glitch.

However, a true **failover mechanism** addresses *provider-level outages* or persistent blocking. If OpenRouter returns a hard 400 error, or if you exhaust all 4 retries because their Gemini API is completely down, the system currently returns a failure and drops the job. To fully satisfy the "fallback models" requirement from your TODO list, the logic should be:

1. Try Primary Model (OpenRouter - Gemini) with standard transient retries (4/4).
2. If all 4 retries fail, **catch the failure and immediately failover** to the Fallback Model (e.g., Nvidia Nemotron) for the same job, rather than marking the job as failed.
Coupled with hardcoded HTTP timeouts (discussed below), this ensures stale or frozen jobs don't block the queue indefinitely.

**Server-Sent Events (SSE) for Job Polling**
It is a common misconception that because job state tracking requires the frontend to know the status, it must be a two-way polling street.

For job execution, you actually want a hybrid approach:

1. **Two-Way (REST API):** The frontend sends a `POST` request to start the job (e.g., `/api/jobs/start`). The backend replies instantly with an HTTP 200 and a `job_id`.
2. **One-Way (SSE):** The frontend opens an SSE connection listening to `/api/jobs/stream`. The frontend never needs to ask "is job X done?" again. As the worker updates the database (PENDING -> PROCESSING -> COMPLETED), the backend automatically pushes those state changes down the open SSE pipeline to the client.

This drastically reduces backend load because you aren't handling dozens of HTTP GET requests per second just to return "still processing."

**Thumbnail Generation (Blurry/Not Used)**
If the thumbnails are generating but looking heavily pixelated or blurry, it usually boils down to the resizing algorithm. If the backend is using a basic "nearest-neighbor" scaling, it will look terrible. Switching the image processing library's filter to **Bicubic** or **Lanczos** interpolation will preserve the sharpness of manga lines. You are also spot on about format: switching the output to `WebP` with a quality setting of ~80% will give you incredibly sharp thumbnails at a fraction of the JPEG file size.

---

### 2. Architectural & System Improvements (Detailed Breakdown)

Here is a deeper dive into the system improvements, focusing on API resilience and application stability.

#### A. Enforce Strict Cloud Timeouts

When communicating with third-party LLMs (like DeepSeek or Gemini via OpenRouter), the underlying HTTP client will often wait indefinitely for a response if the remote server accepts the connection but hangs while processing.

* **The Risk:** Because your worker now uses a strict Heavy/Light slot concurrency model, if the 1 available Light slot hangs while waiting for a frozen OpenRouter response, the entire translation queue is paralyzed.
* **The Fix:** Implement hard timeouts at the HTTP client level. For instance, set a `connect_timeout=10s` and a `read_timeout=45s`. If OpenRouter takes longer than 45 seconds to translate a batch chunk, the client forcefully severs the connection, throws a TimeoutException, triggers the retry/failover logic, and frees the worker slot.

#### B. Disable Open-In-View (OSIV)

The warning `spring.jpa.open-in-view is enabled by default` in your Spring Boot backend logs is a critical performance trap.

* **The Risk:** OSIV keeps a database connection open for the *entire lifecycle* of an HTTP request, including while the server is formatting the JSON response or waiting on slow network transmission to the client. Under high concurrent load, long-running HTTP requests will hold onto database connections, quickly exhausting the HikariCP connection pool. Once the pool is empty, the entire backend becomes unresponsive.
* **The Fix:** Explicitly set `spring.jpa.open-in-view=false` in your `application.properties` or `application.yml`. This enforces strict transactional boundaries, meaning database connections are acquired, used, and returned to the pool immediately within the service layer, keeping the backend highly scalable.

#### C. YOLO Model Segmentation Capabilities

Your `TODO.md` mentions wanting to filter out SFX (sound effects) from dialog bubbles. The current model, `yolo11n_bubble.onnx`, is trained strictly for one class: speech bubbles.

* **The Risk:** PaddleOCR will blindly attempt to read any text inside the regions the YOLO model flags. If you only detect bubbles, you miss floating text, and you have no way to programmatically differentiate between a character shouting (dialog) and a background explosion (SFX).
* **The Fix:** Transitioning from a single-class bubble detector to a **multi-class semantic segmentation model** (like a YOLOv8 or v11 trained on the complete Manga109 dataset) allows the AI to draw distinct bounding boxes for `frame` (panels), `text` (dialog), `face` (characters), and importantly, `body` (which often encapsulates SFX). This allows you to apply conditional logic in your pipeline: e.g., "Only send regions classed as `text` to the translation LLM, and ignore regions classed as `body`/SFX."

#### D. Clean Up JVM Warnings

The startup logs show multiple `sun.misc.Unsafe` warnings. This happens because newer Java versions (Java 17+) strictly encapsulate internal APIs, but underlying high-performance networking libraries (like Netty, which Spring WebFlux and many database drivers use) still rely on these legacy memory-access methods for speed.

* **The Fix:** While harmless in the short term, these warnings clutter application logs and can hide genuine startup errors. Passing the argument `--enable-native-access=ALL-UNNAMED` to the JVM allows these libraries to access memory efficiently without spamming the console, ensuring your container logs remain clean and actionable.
