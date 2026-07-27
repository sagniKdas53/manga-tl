# Issues and What I want for them

## Backend

### The Backend doesn't respect the worker's rate limits and keeps on queuing jobs

```logs
manga-worker     | [OCR] Processing image: 389be4a0-f134-4d47-a0f1-1b86f3b9df6f (lang=ja, direction=rtl) | Page 27 of Chapter 2.0 (Queue: 0 remaining)
manga-worker     | 2026-07-26 16:42:20,030 [DEBUG] Starting new HTTP connection (1): backend:8080
manga-backend    | 2026-07-26T16:42:20.035Z  INFO 1 --- [manga-library-backend] [io-8080-exec-74] c.m.l.controller.InternalJobController   : Worker requested metadata for image: 389be4a0-f134-4d47-a0f1-1b86f3b9df6f
manga-worker     | 2026-07-26 16:42:20,048 [DEBUG] http://backend:8080 "GET /tlhub/api/internal/images/389be4a0-f134-4d47-a0f1-1b86f3b9df6f HTTP/1.1" 200 None
manga-worker     | 2026-07-26 16:42:20,049 [INFO] Downloading image via presigned GET URL
manga-worker     | 2026-07-26 16:42:20,051 [DEBUG] Starting new HTTP connection (1): minio:9000
manga-worker     | 2026-07-26 16:42:20,054 [DEBUG] http://minio:9000 "GET /manga-library/originals/029f19d8-a13f-43b9-aa7a-600b49a54fe9.jpeg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=tladmin%2F20260726%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260726T164220Z&X-Amz-Expires=600&X-Amz-SignedHeaders=host&X-Amz-Signature=74aa5d34c2bc468ee4ec454ba3a5fd0fb1e39926dcffbc8b5e89a1096cfd8692 HTTP/1.1" 200 63400
manga-worker     | 2026-07-26 16:42:20,056 [INFO] Attempting to acquire Valkey lock: ocr
manga-worker     | 2026-07-26 16:42:20,056 [INFO] Acquired Valkey lock: ocr
manga-worker     | [OCR] Running PaddleOCR (PP-OCRv6_medium_det/PP-OCRv6_medium_rec, lang=ja).
manga-worker     | [OCR] Memory before OCR: 2023.9 MB
manga-worker     | [OCR] Calling PaddleOCR...
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-db         | 2026-07-26 16:42:29.202 UTC [27] LOG:  checkpoint starting: time
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-worker     | [OCR] PaddleOCR returned.
manga-worker     | INFO:     127.0.0.1:51502 - "GET /health HTTP/1.1" 200 OK
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-worker     | INFO:     172.18.0.6:59164 - "POST /api/v1/jobs/submit HTTP/1.1" 429 Too Many Requests
manga-worker     | 2026-07-26 16:42:48,274 [INFO] [YOLO] Bubble detection completed. Found 13 bubbles in 1.749s
manga-worker     | 2026-07-26 16:42:48,277 [INFO] Released Valkey lock: ocr
manga-worker     | 2026-07-26 16:42:48,301 [INFO] [OCR] Merged 3 regions into 1 regions (threshold=2.0)
manga-worker     | 2026-07-26 16:42:48,302 [INFO] [OCR] Merged 4 regions into 1 regions (threshold=2.0)
manga-worker     | 2026-07-26 16:42:48,302 [INFO] [OCR] Merged 3 regions into 1 regions (threshold=2.0)
manga-worker     | 2026-07-26 16:42:48,302 [INFO] [OCR] Merged 2 regions into 1 regions (threshold=2.0)
manga-worker     | 2026-07-26 16:42:48,302 [INFO] [OCR] Merged 2 regions into 1 regions (threshold=2.0)
manga-worker     | 2026-07-26 16:42:48,302 [INFO] [OCR] Merged 3 regions into 1 regions (threshold=2.0)
manga-worker     | 2026-07-26 16:42:48,302 [INFO] [OCR] Merged 2 regions into 1 regions (threshold=2.0)
manga-worker     | 2026-07-26 16:42:48,303 [INFO] [OCR] Merged 2 regions into 1 regions (threshold=2.0)
manga-worker     | 2026-07-26 16:42:48,303 [INFO] [OCR] Merged 1 regions into 1 regions (threshold=2.0)
manga-worker     | 2026-07-26 16:42:48,303 [INFO] [OCR] Merged 1 regions into 1 regions (threshold=2.0)
manga-worker     | 2026-07-26 16:42:48,303 [INFO] [OCR] Merged 1 regions into 1 regions (threshold=2.0)
manga-worker     | 2026-07-26 16:42:48,303 [INFO] [OCR] Merged 1 regions into 1 regions (threshold=2.0)
manga-worker     | 2026-07-26 16:42:48,303 [INFO] [OCR] Merged 7 regions into 1 regions (threshold=2.0)
manga-worker     | 2026-07-26 16:42:48,308 [INFO] [OCR] Merged 3 regions into 3 regions (threshold=1.0)
manga-worker     | [OCR] Completed OCR. Found 15 text regions (lang=ja, direction=rtl)
```

Need to make it so that the backend knows when a batch is being processed. So when a batch is picked up by the worker, no new jobs are added to the queue for that batch until the batch is completed. Also, the worker should tell the backend how many slots it has free so that it doesn't push too many when pushinh

## Worker

### Need to validate that rate limits for providers are bing populated in `providers.json` and respected

These rate limits should translate to worker rate limits which would also be fixed

### We are missing the default QA mode in `providers.json`

```json
"defaults": {
    "provider": "openrouter",
    "tl": "deepseek/deepseek-v4-pro",
    + "qaMode": "auto",
    "qaLLM": "deepseek/deepseek-v4-flash",
    "qaVLM": "google/gemini-3.1-flash-lite",
    "ocr": "qwen/qwen3-vl-32b-instruct"
    + "openRouterRouterStrategy"
    + "useFallbackModels" (reminder this is only for seletcing another models from the same provider for the given task, if only one is configured fail the job)
  }
```

Also every provider should list their capabilities like state that it has what and can support what.

### Make sure that `openRouterRouterStrategy` exits in the settings views but is only usable if openrouter is one of the providers

Like we can have it there but make sure it doesn't do anything.

## Frontend

### Make sure on first load all the defaults are properly poulated in the `System Settings`

Like i expect all the fields to be have been processed by the worker and sent to the backend (to save in DB) and then be available for the frontend to use.

### Make sure if a provider is selected their

If I select `neurometric` as the QA provide the QA VLM models should be grayed out in the UI and show something like "N/A" in the text field.

```json
"neurometric": {
      "displayName": "Neurometric",
      "type": "openai-compatible",
      "baseUrl": "https://api.neurometric.ai/v1/chat/completions",
      "authHeader": "Authorization",
      "authPrefix": "Bearer ",
      "keyEnvVar": "NEUROMETRIC_API_KEY",
      "freeTier": true,
      "rateLimits": null,
      "priority": 4,
      "models": {
        "tl": [
          { "id": "neurometric/clawpack", "name": "ClawPack (task router, free)" }
        ],
        "qaLLM": [
          { "id": "neurometric/clawpack", "name": "ClawPack (task router, free)" }
        ],
        "qaVLM": null,
        "ocr": null
      },
      "defaultTLModel": "neurometric/clawpack",
      "defaultQALLMModel": "neurometric/clawpack",
      "defaultQAVLMModel": null,
      "defaultOCRModel": null
    }
```

### Providers which I don't have configured like ollama and lmstudio in the `api_keys.json` are showing up as provider choices

Now the `providers.json` has them populated but we don't work without keys so they shouldn't show up, until propelry configured.

### Some providers have their models auto populated like Cloudflare but some don't

In settings views when a

### Preferred settings

![preferred settings](./preferred-global-settings.png) or
alternative settings ![alternative settings](./alternative-global-settings.png)

#### But when creating a series or chapter

The setting modal behaves strangely

![series settings](./everything-but-the-use-Fallback-models-is-properly-inherited.png) although it's supposed to be something like ![more settings](./even-it-knows-internanlly-i-keep-asking-to-remove-the-defaults-and-use-global-defaults.png) and this is a problem ![as seen here](./the-settings-not-getting-propagated-is-an-issue.png)

### Series and Chapter card re-design

Re design it something like this ![chapter card](./chapter-card-redesign-do-the-same-for-series.png)

### In dark mode the reader background is still white

![issues](./in-dark-mode-the-reder-background-is-still-white.png)

### The material UI paper was design was silently dropped

We are not using the material UI paper anywhere see ![yt-diff](./Screenshot%202026-07-25%20at%2023-19-36%20yt-diff.png) for how it's supposed to look with proper paper designs.
