# Issues and What I want for them

## Same image uploaded to different chapters getting processed differently doesn't work

Example:

`https://ideapad.tail9ece4.ts.net/tlhub/chapters/7dba8638-cc7b-45c9-a38f-58135a37fbe9/six/reader/14` (added earlier) is duplicate of  `https://ideapad.tail9ece4.ts.net/tlhub/chapters/0b19fe18-f5b9-4a3c-8bdc-bd7fe43fa831/examples/reader/1`.

`7dba8638-cc7b-45c9-a38f-58135a37fbe9/six/reader/14` is processed by deepseek v4 pro and I wanted to check the results with clawpack in `0b19fe18-f5b9-4a3c-8bdc-bd7fe43fa831/examples/reader/1` according to our current sdesign if the same image is added two chapters the backend image is hashed and remiains same for both, but a new image entity is created for the newer image, this newer image entity should be able to add it's own OCR and TL layers as disctaed by the chapter config.

Thats the idea, in practice, when the image was added to `0b19fe18-f5b9-4a3c-8bdc-bd7fe43fa831/examples/reader/1` it didn't trigger the pipeline, it didn't inherit the `7dba8638-cc7b-45c9-a38f-58135a37fbe9/six/reader/14`'s layers though (thats good right?), now manuuly triggering OCR and TL for `0b19fe18-f5b9-4a3c-8bdc-bd7fe43fa831/examples/reader/1` add layers to `7dba8638-cc7b-45c9-a38f-58135a37fbe9/six/reader/14`'s layers!

This is not expected behaviour.

## Cloudflare workers seems to have stopped working

![CFWC](./CPWC.png)

## The Backend doesn't respect the worker's rate limits and keeps on queuing jobs

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

## Need to validate that rate limits for providers are bing populated in `providers.json` and respected

These rate limits should translate to worker rate limits which would also be fixed

```logs
manga-worker     | 2026-07-27 12:27:41,878 [DEBUG] [88687a01] Batch Input:
manga-worker     | [
manga-worker     |   {
manga-worker     |     "id": "c303f207-8dff-49b7-9f80-fcaa2fa7ba52",
manga-worker     |     "panel": 1,
manga-worker     |     "bubble": 1,
manga-worker     |     "speaker": null,
manga-worker     |     "regionType": "speech",
manga-worker     |     "conversationGroup": null,
manga-worker     |     "text": "生まれた地球にいる"
manga-worker     |   },
manga-worker     |   {
manga-worker     |     "id": "b4715474-3930-4682-b650-8b2090fd180f",
manga-worker     |     "panel": 1,
manga-worker     |     "bubble": 2,
manga-worker     |     "speaker": null,
manga-worker     |     "regionType": "speech",
manga-worker     |     "conversationGroup": null,
manga-worker     |     "text": "はずなのに何故か本当は僕だけが違う星から来たみたいだった"
manga-worker     |   },
manga-worker     |   {
manga-worker     |     "id": "9fb8a2a4-9471-46cb-90f0-73e4984477eb",
manga-worker     |     "panel": 1,
manga-worker     |     "bubble": 3,
manga-worker     |     "speaker": null,
manga-worker     |     "regionType": "speech",
manga-worker     |     "conversationGroup": null,
manga-worker     |     "text": "兔猫锚ommision@免猫锚"
manga-worker     |   }
manga-worker     | ]
manga-worker     | 2026-07-27 12:27:41,878 [INFO] [88687a01] Prompt=batch-v3
manga-worker     | 2026-07-27 12:27:41,878 [INFO] [88687a01] Batch: Trying provider 'cloudflare' with model '@cf/zai-org/glm-4.7-flash'...
manga-worker     | 2026-07-27 12:27:41,884 [DEBUG] Starting new HTTPS connection (1): api.cloudflare.com:443
manga-worker     | 2026-07-27 12:27:41,971 [DEBUG] https://api.cloudflare.com:443 "POST /client/v4/accounts/a81b44d9f49a5a38a27b2cf059cf9866/ai/v1/chat/completions HTTP/1.1" 429 286
manga-worker     | 2026-07-27 12:27:43,982 [DEBUG] Starting new HTTPS connection (1): api.cloudflare.com:443
manga-worker     | 2026-07-27 12:27:44,066 [DEBUG] https://api.cloudflare.com:443 "POST /client/v4/accounts/a81b44d9f49a5a38a27b2cf059cf9866/ai/v1/chat/completions HTTP/1.1" 429 286
manga-worker     | 2026-07-27 12:27:48,073 [DEBUG] Starting new HTTPS connection (1): api.cloudflare.com:443
manga-worker     | 2026-07-27 12:27:48,145 [DEBUG] https://api.cloudflare.com:443 "POST /client/v4/accounts/a81b44d9f49a5a38a27b2cf059cf9866/ai/v1/chat/completions HTTP/1.1" 429 286
manga-worker     | 2026-07-27 12:27:56,152 [DEBUG] Starting new HTTPS connection (1): api.cloudflare.com:443
manga-worker     | 2026-07-27 12:27:56,220 [DEBUG] https://api.cloudflare.com:443 "POST /client/v4/accounts/a81b44d9f49a5a38a27b2cf059cf9866/ai/v1/chat/completions HTTP/1.1" 429 286
manga-worker     | 2026-07-27 12:27:56,221 [ERROR] [88687a01] LLM call failed for provider 'cloudflare': Rate limited (429)
manga-worker     | 2026-07-27 12:27:56,221 [INFO] [88687a01] Batch: No fallback applied (global provider different or model identical).
manga-worker     | 2026-07-27 12:27:56,221 [DEBUG] [88687a01] Retry translate_batch_llm output: None
manga-worker     | 2026-07-27 12:27:56,222 [INFO] Provider 'cloudflare' is on cooldown. Sleeping for 5.0s...
manga-worker     | INFO:     127.0.0.1:40448 - "GET /health HTTP/1.1" 200 OK
manga-worker     | 2026-07-27 12:28:01,222 [INFO] [88687a01] Individual fallback
manga-worker     | 2026-07-27 12:28:01,222 [INFO] [88687a01] Falling back to individual translation for 3 regions (attempt 3/3)...
manga-worker     | 2026-07-27 12:28:01,223 [INFO] [88687a01] Translation Strategy:
manga-worker     | 2026-07-27 12:28:01,223 [INFO] [88687a01] Cache key: tl:cloudflare:@cf/zai-org/glm-4.7-flash:-1541902200056289052 (hit=False)
manga-worker     | 2026-07-27 12:28:01,223 [INFO] [88687a01] Trying provider 'cloudflare' with model '@cf/zai-org/glm-4.7-flash'...
manga-worker     | 2026-07-27 12:28:01,227 [DEBUG] Starting new HTTPS connection (1): api.cloudflare.com:443
manga-worker     | 2026-07-27 12:28:01,325 [DEBUG] https://api.cloudflare.com:443 "POST /client/v4/accounts/a81b44d9f49a5a38a27b2cf059cf9866/ai/v1/chat/completions HTTP/1.1" 429 286
manga-worker     | 2026-07-27 12:28:03,334 [DEBUG] Starting new HTTPS connection (1): api.cloudflare.com:443
manga-worker     | 2026-07-27 12:28:03,406 [DEBUG] https://api.cloudflare.com:443 "POST /client/v4/accounts/a81b44d9f49a5a38a27b2cf059cf9866/ai/v1/chat/completions HTTP/1.1" 429 286
manga-worker     | 2026-07-27 12:28:07,413 [DEBUG] Starting new HTTPS connection (1): api.cloudflare.com:443
manga-worker     | 2026-07-27 12:28:07,481 [DEBUG] https://api.cloudflare.com:443 "POST /client/v4/accounts/a81b44d9f49a5a38a27b2cf059cf9866/ai/v1/chat/completions HTTP/1.1" 429 286
manga-worker     | 2026-07-27 12:28:15,488 [DEBUG] Starting new HTTPS connection (1): api.cloudflare.com:443
manga-worker     | 2026-07-27 12:28:15,577 [DEBUG] https://api.cloudflare.com:443 "POST /client/v4/accounts/a81b44d9f49a5a38a27b2cf059cf9866/ai/v1/chat/completions HTTP/1.1" 429 286
manga-worker     | 2026-07-27 12:28:15,577 [ERROR] [88687a01] LLM call failed for provider 'cloudflare': Rate limited (429)
manga-worker     | 2026-07-27 12:28:15,577 [INFO] [88687a01] No fallback applied (global provider different, model identical, or fallback disabled).
manga-worker     | 2026-07-27 12:28:15,578 [ERROR] [88687a01] All translation tiers failed for text: '生まれた地球にいる'
manga-worker     | 2026-07-27 12:28:15,578 [WARNING] [88687a01] Giving up on '生まれた地球にいる' after 3 attempts.
manga-worker     | 2026-07-27 12:28:15,578 [INFO] [88687a01] Translation Strategy:
manga-worker     | 2026-07-27 12:28:15,578 [INFO] [88687a01] Cache key: tl:cloudflare:@cf/zai-org/glm-4.7-flash:2952206482891072884 (hit=False)
manga-worker     | 2026-07-27 12:28:15,578 [INFO] [88687a01] Trying provider 'cloudflare' with model '@cf/zai-org/glm-4.7-flash'...
manga-worker     | 2026-07-27 12:28:15,578 [INFO] Provider 'cloudflare' is on cooldown. Sleeping for 5.0s...
manga-worker     | 2026-07-27 12:28:20,580 [DEBUG] Starting new HTTPS connection (1): api.cloudflare.com:443
manga-worker     | 2026-07-27 12:28:20,720 [DEBUG] https://api.cloudflare.com:443 "POST /client/v4/accounts/a81b44d9f49a5a38a27b2cf059cf9866/ai/v1/chat/completions HTTP/1.1" 429 286
manga-worker     | 2026-07-27 12:28:22,726 [DEBUG] Starting new HTTPS connection (1): api.cloudflare.com:443
manga-worker     | 2026-07-27 12:28:22,863 [DEBUG] https://api.cloudflare.com:443 "POST /client/v4/accounts/a81b44d9f49a5a38a27b2cf059cf9866/ai/v1/chat/completions HTTP/1.1" 429 286
manga-worker     | 2026-07-27 12:28:26,870 [DEBUG] Starting new HTTPS connection (1): api.cloudflare.com:443
manga-worker     | 2026-07-27 12:28:27,018 [DEBUG] https://api.cloudflare.com:443 "POST /client/v4/accounts/a81b44d9f49a5a38a27b2cf059cf9866/ai/v1/chat/completions HTTP/1.1" 429 286
manga-worker     | INFO:     127.0.0.1:59732 - "GET /health HTTP/1.1" 200 OK
manga-worker     | 2026-07-27 12:28:35,024 [DEBUG] Starting new HTTPS connection (1): api.cloudflare.com:443
manga-worker     | 2026-07-27 12:28:35,168 [DEBUG] https://api.cloudflare.com:443 "POST /client/v4/accounts/a81b44d9f49a5a38a27b2cf059cf9866/ai/v1/chat/completions HTTP/1.1" 429 286
manga-worker     | 2026-07-27 12:28:35,168 [ERROR] [88687a01] LLM call failed for provider 'cloudflare': Rate limited (429)
manga-worker     | 2026-07-27 12:28:35,168 [INFO] [88687a01] No fallback applied (global provider different, model identical, or fallback disabled).
manga-worker     | 2026-07-27 12:28:35,169 [ERROR] [88687a01] All translation tiers failed for text: 'はずなのに何故か本当は僕だけが違う星から来たみたいだった'
manga-worker     | 2026-07-27 12:28:35,169 [WARNING] [88687a01] Giving up on 'はずなのに何故か本当は僕だけが違う星から来たみたいだった' after 3 attempts.
manga-worker     | 2026-07-27 12:28:35,169 [INFO] [88687a01] Translation Strategy:
manga-worker     | 2026-07-27 12:28:35,169 [INFO] [88687a01] Cache key: tl:cloudflare:@cf/zai-org/glm-4.7-flash:7351498085844629575 (hit=False)
manga-worker     | 2026-07-27 12:28:35,169 [INFO] [88687a01] Trying provider 'cloudflare' with model '@cf/zai-org/glm-4.7-flash'...
manga-worker     | 2026-07-27 12:28:35,169 [INFO] Provider 'cloudflare' is on cooldown. Sleeping for 5.0s...
manga-worker     | 2026-07-27 12:28:40,172 [DEBUG] Starting new HTTPS connection (1): api.cloudflare.com:443
manga-worker     | 2026-07-27 12:28:40,303 [DEBUG] https://api.cloudflare.com:443 "POST /client/v4/accounts/a81b44d9f49a5a38a27b2cf059cf9866/ai/v1/chat/completions HTTP/1.1" 429 286
manga-worker     | 2026-07-27 12:28:42,311 [DEBUG] Starting new HTTPS connection (1): api.cloudflare.com:443
manga-worker     | 2026-07-27 12:28:42,393 [DEBUG] https://api.cloudflare.com:443 "POST /client/v4/accounts/a81b44d9f49a5a38a27b2cf059cf9866/ai/v1/chat/completions HTTP/1.1" 429 286
```

## We are missing the default QA mode in `providers.json`

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

## Make sure that `openRouterRouterStrategy` exits in the settings views but is only usable if openrouter is one of the providers

Like we can have it there but make sure it doesn't do anything.

## Make sure on first load all the defaults are properly poulated in the `System Settings`

Like i expect all the fields to be have been processed by the worker and sent to the backend (to save in DB) and then be available for the frontend to use.

## Make sure if a provider is selected their

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

## Providers which I don't have configured like ollama and lmstudio in the `api_keys.json` are showing up as provider choices

Now the `providers.json` has them populated but we don't work without keys so they shouldn't show up, until propelry configured.

## Some providers have their models auto populated like Cloudflare but some don't

In settings views when a

### Preferred settings

![preferred settings](./preferred-global-settings.png) or
alternative settings ![alternative settings](./alternative-global-settings.png)

#### But when creating a series or chapter

The setting modal behaves strangely

![series settings](./everything-but-the-use-Fallback-models-is-properly-inherited.png) although it's supposed to be something like ![more settings](./even-it-knows-internanlly-i-keep-asking-to-remove-the-defaults-and-use-global-defaults.png) and this is a problem ![as seen here](./the-settings-not-getting-propagated-is-an-issue.png)

## Series and Chapter card re-design

Re design it something like this ![chapter card](./chapter-card-redesign-do-the-same-for-series.png)

## In dark mode the reader background is still white

![issues](./in-dark-mode-the-reder-background-is-still-white.png)

## The material UI paper was design was silently dropped

We are not using the material UI paper anywhere see ![yt-diff](./Screenshot%202026-07-25%20at%2023-19-36%20yt-diff.png) for how it's supposed to look with proper paper designs.
