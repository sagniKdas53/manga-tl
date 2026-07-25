# Plan: More Improvements

## 7. Unit tests are useless — never catch real issues

### Problem

The tests in `PageControllerTest.java` and `PageServiceTest.java` mock **everything**. Every repository, every service is a `@MockBean`. That means:

- They never touch a real database
- They never catch SQL schema issues (like missing PKs on `images`/`chapters`)
- They never catch lazy proxy serialization failures
- They never catch Hibernate DDL problems
- They never catch real HTTP serialization behavior

A test like this:

```java
when(pageRepository.findById(pageId)).thenReturn(Optional.of(page));
mockMvc.perform(get("/api/pages/" + pageId)).andExpect(status().isOk());
```

...passes even when:

- The actual table has no PK
- Jackson can't serialize the entity
- The entity has lazy proxies that would fail
- The DB schema is completely wrong

**The tests are tautologies** — they test that the mock returns what you told it to return.

### What should exist instead

1. **Integration tests with Testcontainers** — spin up a real Postgres, run Alembic/Flyway migrations, hit real endpoints
2. **Contract tests** — verify the JSON response shape matches what the frontend expects
3. **At minimum**: one test that boots the full Spring context against an H2/Postgres container and calls `/health` and a few real endpoints

## 10. Costs Database Validation

### Problem

We need to ensure that the costs DB is being updated properly and costs are actually being tracked after processing jobs.

### Fix

Validate and add tests to ensure the cost records are correctly inserted when jobs finish.

---

## 11. Fallback Models Validation

### Problem

We need to ensure that the fallback models is being updated properly and costs are actually being tracked after processing jobs.

Also make sure if the over-rides set disable fall back's they aren't being used and fail the jobs properly on the main model being unavailable.

### Fix

Validate and add tests to ensure the cost records are correctly inserted when jobs finish. And also validate the fact that the fallback models are used when they are supposed and not when they are not supposed to be, ensuring no rouge spending happens.

---

## 13. [Critical] Manual edits cause renders to fail and continuously retry

### Problem

When a user manually adds or edits a layer on the frontend (e.g. changing translation text or bounding box), the `lastEditedAt` timestamp on the Page/Layer is updated. The backend's `DebouncedRenderService` polls for pages where `lastEditedAt > lastRenderedAt` and automatically enqueues a `render` job.

If this render job crashes in the Python worker (often because manually added layers might lack required fields like `font`, `boxShape`, or `maskPolygon`), the job is marked `FAILED`. However, because the render failed, `lastRenderedAt` is never updated.

If the user dismisses the failed job from the frontend UI, it deletes the job from the DB. Because the job is deleted, the `DebouncedRenderService` no longer sees the recent failure (which would normally trigger a 5-minute cooldown), notices `lastEditedAt > lastRenderedAt` is still true, and **immediately requeues the failed render job**. This creates an inescapable loop unless the manual changes are reverted.

### Fix

1. **Worker Validation:** Update the Python render worker to provide fallbacks for missing fields in manually added layers instead of crashing.
2. **State Management:** When a render job fails, the backend should track the failure on the `Page` or `Image` entity itself (e.g., `renderFailedAt`) rather than relying entirely on the ephemeral `Job` table to prevent infinite polling loops when jobs are deleted by the user.
3. **Frontend Resilience:** Ensure the frontend sends all necessary default fields when a user manually creates a layer.

---

## 14. High Reader Latency (600ms-1s to fully load a page)

### Problem

Navigating between pages in the reader feels sluggish. Loading a new page can take 600ms to 1s. This is likely caused by the image and its associated layers taking a long time to fetch and construct.

### Fix

1. **N+1 Queries:** The `/api/pages/{pageId}/details` endpoint likely suffers from N+1 query issues when fetching layers and regions. We should use `JOIN FETCH` or `@EntityGraph` to eagerly load `layers` and `layer_elements` in a single query.
2. **Asset Loading:** Ensure we aren't blocking the UI render on the full-resolution image download if a thumbnail/preview can be shown first.
3. **Response Caching:** Add appropriate `Cache-Control` headers for static assets like rendered images, which are immutable until explicitly re-rendered.

---

## 15. Aggressive Reader Page Dropping (No Previous Page Caching)

### Problem

The reader currently only caches the *next* page. If a user navigates forward and then immediately backward, the previous page is instantly dropped from memory and has to be re-fetched entirely from the network. This results in poor UX and unnecessary network strain.

### Fix

In `Reader.tsx`, implement a sliding window cache (e.g., `[currentPage - 2, currentPage, currentPage + 2]`). Keep the DOM/state for the previous page in memory so backward navigation is instantaneous.

---

## 16. Enforce Quality Gates

### Problem

There are currently quality-gate flags and fallback models mentioned, but they are not strictly enforced across the pipeline. Jobs might proceed even if quality thresholds aren't met, or the system doesn't properly halt and require manual intervention when it should.

### Fix

Add strict quality-gate checks between pipeline stages (e.g. after OCR and after Translation). If the confidence score drops below a configured threshold, the pipeline should pause and escalate for manual review before proceeding to rendering.

---

## Action Items Summary

| # | Issue | Status |
|---|-------|--------|
| 1 | `/api/pages/{id}/details` — proxy/lazy init issues | ✅ Fixed |
| 1b | `/api/pages/{id}/details` — `IllegalArgumentException` → 404, not 500 | ✅ Fixed |
| 2 | Proper 4XX/5XX error responses with messages | ✅ Fixed |
| 3 | Reader page-out-of-bounds infinite spinner | ✅ Fixed |
| 4 | JWT expiry detection & redirect to login | ✅ Fixed |
| 5 | Auto-extend active sessions via `/auth/refresh` | ✅ Fixed |
| 6 | Translation layer empty text — OpenRouter 404 | ✅ Fixed (Short-circuited at backend) |
| 7 | Unit tests are useless (mock everything, catch nothing) | ✅ Fixed (Testcontainers + Real Postgres + API & Worker Contracts) |
| 8 | Move "Force export" button to overflow menu | ✅ Fixed |
| 9 | Fix custom fonts not loading in dev frontend | ✅ Fixed |
| 10 | Validate cost DB tracking is accurate | ✅ DONE |
| 11 | Fallback Models Validation logic | ✅ DONE |
| 12 | Create OpenAPI spec & fix API redundancy | ✅ Fixed |
| 13 | Manual edits cause renders to fail and continuously retry | ✅ Fixed |
| 14 | High Reader Latency | ✅ Fixed |
| 15 | Aggressive Reader Page Dropping | ✅ Fixed |
| 16 | Code Quality Assurance Gates & Pipeline Verification | ✅ Fixed |

## Archived Issues

### 1. [CRITICAL] `/api/pages/{pageId}/details` returns 500 (✅ COMPLETED)

#### Root Cause (3 compounding issues)

1. **`open-in-view: false`** → Hibernate session closes before Jackson serializes
2. **Jackson `FAIL_ON_EMPTY_BEANS`** → `ByteBuddyInterceptor` on Hibernate proxies has no serializer
3. **Missing PKs on `images`/`chapters`** → `ddl-auto: update` silently skipped PK creation

#### Fixes Applied

| # | Fix | File |
|---|-----|------|
| 1 | `open-in-view: false` → `true` | `application.yml:16` |
| 2 | `fail-on-empty-beans: false` | `application.yml:31-33` |
| 3 | Raw `Page` entity → plain `Map` | `PageController.java:762-766` |
| 4 | Removed `@Transactional` from controller endpoints | `PageController.java:730-731, 779-780` |
| 5 | Manual PKs on `images` and `chapters` | SQL |
| 6 | `halt_on_error: true` for DDL | `application.yml:19-20` |

#### Remaining Issue: `IllegalArgumentException: Page not found` → 500 instead of 404

When a page doesn't exist (e.g., after DB wipe or deleted page), the controller throws:

```java
.orElseThrow(() -> new IllegalArgumentException("Page not found: " + pageId));
```

`IllegalArgumentException` is **not** mapped to 404 — it becomes a 500 with:

```json
{"timestamp":"...","status":500,"error":"Internal Server Error","path":"..."}
```

**No message, no hint it's actually a 404.** The frontend has no idea what went wrong.

#### Also: `IllegalArgumentException` becoming 500 instead of 400/404

Same pattern used throughout the controller:

```java
Objects.requireNonNull(pageId, "pageId cannot be null"); // → NullPointerException → 500
.orElseThrow(() -> new IllegalArgumentException("Chapter not found: ...")); // → 500
```

All of these should return proper HTTP status codes with messages.

### Fix (see Issue #2 — Global error handler)

---

### 2. API error responses are useless (no message, wrong status codes)

#### Problem 2.1

Every error returns the same useless blob:

```json
{"timestamp":"...","status":500,"error":"Internal Server Error","path":"..."}
```

Actual failures observed that should be different:

| What happens | Current HTTP | Should be | Error message |
|-------------|-------------|-----------|---------------|
| Page not found | 500 | **404** | `"Page 0a82cf1a not found"` |
| Page ID is null | 500 | **400** | `"pageId is required"` |
| Chapter not found | 500 | **404** | `"Chapter X not found"` |
| Image not found | 500 | **404** | `"Image X not found"` |
| File upload too large | 500 | **413** | `"File exceeds 50MB limit"` |
| Invalid file format | 500 | **400** | `"Only PNG/JPG files accepted"` |
| Token expired | 401 (handled) | 401 | `"Session expired. Please log in."` |
| Internal server error | 500 | 500 | `"Something went wrong: {actual message}"` |

#### Fix 2.1

Add `@ControllerAdvice` / `@ExceptionHandler` that maps specific exceptions to proper HTTP status codes **with human-readable messages**:

```java
@ExceptionHandler(IllegalArgumentException.class) → 400/404 (depending on message)
@ExceptionHandler(NullPointerException.class) → 400
@ExceptionHandler(EntityNotFoundException.class) → 404
@ExceptionHandler(MaxUploadSizeExceededException.class) → 413
@ExceptionHandler(Exception.class) → 500 (include message in dev, generic in prod)
```

#### Frontend required change

Display these error messages in toast/alert. Currently errors are swallowed — user sees infinite spinner.

---

### 3. If reader navigates to page 2 when chapter has 1 page → infinite spinner

#### Problem 3.1

URL `/chapters/{id}/default/reader/2` when chapter has only 1 page. No error, just spins forever.

#### Fix 3.1

In `Reader.tsx`: validate `currentPageNumber ≤ pages.length`, redirect to last valid page, show toast.

---

### 4. No JWT expiry handling → user gets stuck silently (✅ COMPLETED)

#### Problem 4.1

Token expires after 24h. All API calls return 401. Frontend shows blank/spinner. No logout redirect, no message.

#### Fix 4.1

In `safeFetch()`: on 401 → clear token, toast "Session expired", redirect to `/login`. Add `POST /api/auth/refresh` for auto-extend.

---

### 5. No auto-extension of active sessions (✅ COMPLETED)

#### Problem 5.1

Active user for >24h gets booted. No refresh mechanism.

#### Fix 5.1

Add `/api/auth/refresh` endpoint. Frontend calls it every 60 mins while user is active. Issues new JWT if user was active ≤15 mins ago.

---

### 6. [CRITICAL] Translation layer has empty text — OpenRouter API returns 404

#### Symptom

Translation layer created with empty `translatedText`:

```json
{
  "type": "translation",
  "metadataJson": {
    "model": "deepseek/deepseek-v4-pro",
    "provider": "openrouter",
    ...
  }
}
```

But **no `translatedText` field on the elements** — only the OCR layer has text.

#### Root Cause

Worker log from `run-12.log`:

```
[ERROR] Cloud LLM Translation failed: 404 Client Error: Not Found for url: https://openrouter.ai/api/v1/chat/completions
```

OpenRouter returned **404** when the worker tried to call the translation API. The worker handled the error and sent back `translationFailed: true` with empty text, but the backend still created the translation layer with no content.

#### Possible Causes

1. **API key is invalid or expired** — OpenRouter returns 404 (not 401) for unknown/invalid API keys
2. **Model name is wrong** — `deepseek/deepseek-v4-pro` might not exist or might be renamed
3. **Worker silently swallows translation failures** — the layer is created even when all translations failed

#### Fix 6

1. **Verify OpenRouter API key** — check `OPENROUTER_API_KEY` env var in docker-compose
2. **Verify model name** — check OpenRouter docs for the correct model path
3. **Worker should NOT create translation layer if ALL translations failed** — it should either retry or mark the job as failed so the user knows something is wrong, not silently create an empty layer

---

### 8. Frontend UX & Button Clutter (✅ COMPLETED)

#### Problem

The chapter card has too many buttons. "Force export" should be moved out of the primary view.

#### Fix

Moved the "Force export" button to an overflow (triple dots) menu, streamlining the actions row.

---

### 9. Custom Fonts Missing in Dev (✅ COMPLETED)

#### Problem

The custom fonts (like Comic Neue) stopped working in the frontend dev environment.

#### Fix

Moved the Google Fonts `@import` rule from `index.css` to standard `<link>` tags in `index.html`. This ensures Vite consistently injects and resolves external fonts across both development and production environments.

---

### 12. API Endpoint Redundancy & OpenAPI Spec (✅ COMPLETED)

#### Problem

We currently have two different API endpoints for loading a single page in the reader: `/api/pages/{pageId}/details` and `/api/pages/{pageId}/layers`. They return largely similar or overlapping data, which is inefficient.
Furthermore, there is no formal contract or schema for the API.

#### Fix

1. Created a proper **OpenAPI Spec** for the REST API to address the design and serve as a contract.
2. Unified the page loading endpoints or clearly separated their concerns based on the spec.
3. Enforced REST validation.

---

### 13. [Critical] Manual edits cause renders to fail and continuously retry (✅ COMPLETED)

#### Problem

When a user manually added or edited a layer on the frontend, the `lastEditedAt` timestamp updated, triggering `DebouncedRenderService` to enqueue a `render` job. Missing fields in manual edits caused the python worker to crash. This meant `lastRenderedAt` never updated. Dismissing the failed job from the frontend deleted the job record, causing the backend to immediately requeue the render job in an infinite loop.

#### Fix

Unified the python worker endpoints to use `/images/{imageId}` to properly fetch layer elements, and added null-safety to coordinate parsing (`x`, `y`) in `render.py`.

---

### 14. High Reader Latency (✅ COMPLETED)

#### Problem

Navigating between pages in the reader was sluggish, taking 600ms to 1s to fully load a page due to N+1 queries when fetching regions.

#### Fix

Updated `ConversationRegionRepository` with a batch query `findByConversationIdIn` and refactored `PageController` to batch-fetch regions and group them in memory, significantly reducing latency.

---

### 15. Aggressive Reader Page Dropping (No Previous Page Caching) (✅ COMPLETED)

#### Problem

The reader currently only cached the next page. Backward navigation resulted in the previous page being dropped from memory and requiring a full network refetch.

#### Fix

Implemented a sliding window cache `[N-1, N, N+1, N+2]` in `Reader.tsx` by including `prevPageId` in the `activeWindowIds` Set, keeping the previous page in memory for instantaneous backward navigation.

### Archive

## The chapter card still has too many buttons

Move the Force export to the overflow (triple dots) menu

## Clearing a failed job from the queue manager doesn't actually delete it

It comes back soon after clearing

## Failures show up in queue manager when

1. There are no detected OCR regions -> so no translation fails -> this is okay but the error doesn't tell it anywhere
2. When we manually add an empty layer -> The render fails -> This shouldn't happen

See: `https://ideapad.tail9ece4.ts.net/tlhub/chapters/3b0b8ea7-02df-49c0-b16f-9f98e9d19be2/no-overrides/reader/1`

## If TL LLM returns errors, the TL pipeline doesn't fail it just creates empty TL bubbles

Credit was exahsuyed earlier instead of raising an error it just did that <--> [## 6](./plan-more-improvements.md)

## If I navigate to a wrong or deleted chapter or series

eg: `https://ideapad.tail9ece4.ts.net/tlhub/chapters/3b0b8ea7-02df-49c0-b16ff98e9d19be2/no-overrides` , `https://ideapad.tail9ece4.ts.net/tlhub/series/ee485a36-b54b-40f7-b1c4-d2733adfcf79/no-overrides`

Then also we get the infinite spinner

## Can't delete any layers (in dev front-end)

`API request failed: /api/layers/8fd90c20-ee11-4fe1-9100-485c4de90ab6`
`Failed to delete layer`

## Logging was only supposed to be disabled for PROD build but it's not available in dev front-end as well

## Same image getting processed differtnly in different chapters with different over rides doesn't work either

`https://ideapad.tail9ece4.ts.net/tlhub/chapters/3b0b8ea7-02df-49c0-b16f-9f98e9d19be2/no-overrides/reader/3` --> Local OCR (After the other one was deleted OCR worked and TL worked too)
`https://ideapad.tail9ece4.ts.net/tlhub/chapters/8e3df496-e17e-42a6-8cf3-9861c38b2d84/cloudocr/reader/1` --> Cloud OCR (this page was deleted to check if dleting in one chapter delete the image in another, it doesn't) [Also this shadred nature could be one of the reasons the error notification for this page is not getting cleared even after the page is deleted]

Cloud OCR failed so added image to chapter that does local OCR

`https://ideapad.tail9ece4.ts.net/tlhub/chapters/3b0b8ea7-02df-49c0-b16f-9f98e9d19be2/no-overrides/reader/3` --> Doesn't share the layers, but doesn't start it's own processing either
`https://ideapad.tail9ece4.ts.net/tlhub/chapters/3b0b8ea7-02df-49c0-b16f-9f98e9d19be2/no-overrides/reader/3` --> Manually triggering OCR uses the cloudOCR model instead of the local one

## Also if the there are no OCR regions detected the pipeline should throw and error not keep processing

It tries TL on nothing and does multiple QA rounds on nothing as well?

See: `https://ideapad.tail9ece4.ts.net/tlhub/chapters/8e3df496-e17e-42a6-8cf3-9861c38b2d84/cloudocr/reader/1`

## The custom fonts have stopped working in the frontend, only default system ones work (in dev front-end)

Comic Neue doesn't work anymore

## All post edit renders fail apparently

Ching the font or adding layers, editing objects, causes a delayed render after 1 min (BTW this should be like 10sec after the last changes were made), all of these failed.

## If the global settings are updated then series and chapteres with inherited settings don't get updated

Like say I have a global config, I made a series and chapter with no overrides, now If I change the global config then the series and chapter with no overrides should get updated , but currently they snapshot

## Also how to handle model churn

We had gpt-oss-120b before but open router removed it, so I changed it to gpt-oss-20b, now all the previous entities inililized with 120b still look for it. and since the model is unavailable they fail.

## Validate that the costs DB is getting updated propelry and costs are being tracked

This

## Jobs are failing even with Fallback Models enabled

```txt
Fallback Models
Enabled
```

```txt
Translation · Page 1
 
openrouter / tencent/hy3:free
FAILED
Attempt 3/309:10 pm
Failed to get page/image info: 500
```

## Why do we need 2 different API endpoints for loading a single page in the reader

`https://ideapad.tail9ece4.ts.net/tlhub/api/pages/db459079-c811-4144-a205-f27b5d54b664/details` and `https://ideapad.tail9ece4.ts.net/tlhub/api/pages/db459079-c811-4144-a205-f27b5d54b664/layers`

Which give

```json
{"image":{"id":"fc966a13-55b0-4582-a166-7440f5a324a6","filename":"136179317-0.png","width":null,"height":null,"hash":"6d2655bca9b71eda47885db3797cf076cac9c0136e2f063671c2368a55ff2b92","storagePath":"originals/0abdcdf5-813b-4d62-9e1f-85db3a43886f.png","thumbnailStoragePath":"thumbnails/0abdcdf5-813b-4d62-9e1f-85db3a43886f.webp","createdAt":"2026-07-23T15:47:25.875479Z","lastEditedAt":null,"lastRenderedAt":null,"hibernateLazyInitializer":{}},"panels":[{"id":"1590b225-1453-4fcb-83fa-89e32634f293","bboxX":0,"bboxY":0,"bboxW":2844,"bboxH":4018,"gridRow":0,"gridCol":0,"readingOrder":1}],"page":{"pageNumber":14,"imageId":"fc966a13-55b0-4582-a166-7440f5a324a6","chapterId":"3b0b8ea7-02df-49c0-b16f-9f98e9d19be2","id":"db459079-c811-4144-a205-f27b5d54b664"},"ocrRegions":[{"id":"3fb5ba0d-8192-47b7-a596-50c4591927ad","text":"セクシーュニで申し訳ないだがどうだね？このぼくの魅惑の爆弾ボディは？何だね、ぼくの身体にそんなに如魅了されてしまったのかね？♡じゃあちょっとだけ過激な所も見せてあげようじゃないか、ほれ♡ひっ","translatedText":null,"approved":false,"translationFailed":false,"detectedLanguage":"ja","confidence":0.8740336729420556,"rotation":0.0,"bboxX":1079,"bboxY":7,"bboxW":820,"bboxH":1472,"panelReadingOrder":1,"bubbleReadingOrder":1,"regionType":"speech","backgroundColor":"#bbbbbb","bubbleX":1079,"bubbleY":7,"bubbleW":820,"bubbleH":1472,"ocrScore":0.8740336729420556,"translationScore":null,"qaScore":null,"qaFeedback":null,"qaStatus":"pending","bubbleId":"direct_text_1","detectionConfidence":0.0,"maskPolygon":"[[1079, 7], [1899, 7], [1899, 1479], [1079, 1479]]","safeTextX":1079,"safeTextY":7,"safeTextW":820,"safeTextH":1472,"panelId":"1590b225-1453-4fcb-83fa-89e32634f293"},{"id":"34396327-40b2-49e8-b23d-0509d4159187","text":"え～、なに君ら？♡勅起しちゃったの～？♡しょうがないにゃ～♡（ニヤニヤ）","translatedText":null,"approved":false,"translationFailed":false,"detectedLanguage":"ja","confidence":0.8984588086605072,"rotation":0.0,"bboxX":70,"bboxY":23,"bboxW":165,"bboxH":1169,"panelReadingOrder":1,"bubbleReadingOrder":2,"regionType":"speech","backgroundColor":"#808080","bubbleX":70,"bubbleY":23,"bubbleW":165,"bubbleH":1169,"ocrScore":0.8984588086605072,"translationScore":null,"qaScore":null,"qaFeedback":null,"qaStatus":"pending","bubbleId":"direct_text_0","detectionConfidence":0.0,"maskPolygon":"[[70, 23], [235, 23], [235, 1192], [70, 1192]]","safeTextX":70,"safeTextY":23,"safeTextW":165,"safeTextH":1169,"panelId":"1590b225-1453-4fcb-83fa-89e32634f293"},{"id":"92200d92-0769-4a99-a55f-38a844a8e643","text":"は","translatedText":null,"approved":false,"translationFailed":false,"detectedLanguage":"ja","confidence":0.8524696826934814,"rotation":0.0,"bboxX":980,"bboxY":482,"bboxW":95,"bboxH":134,"panelReadingOrder":1,"bubbleReadingOrder":3,"regionType":"speech","backgroundColor":"#d9d9d9","bubbleX":972,"bubbleY":482,"bubbleW":119,"bubbleH":274,"ocrScore":0.8524696826934814,"translationScore":null,"qaScore":null,"qaFeedback":null,"qaStatus":"pending","bubbleId":"bubble_2","detectionConfidence":0.6077573895454407,"maskPolygon":"[[1059, 478], [1046, 481], [1037, 495], [1014, 519], [1013, 534], [1009, 543], [980, 578], [977, 590], [978, 634], [990, 647], [991, 661], [1001, 680], [1003, 700], [1014, 721], [1016, 736], [1025, 747], [1032, 752], [1061, 752], [1072, 749], [1077, 736], [1078, 721], [1089, 697], [1089, 543], [1086, 531], [1079, 523], [1073, 509], [1067, 501], [1064, 482]]","safeTextX":980,"safeTextY":481,"safeTextW":107,"safeTextH":269,"panelId":"1590b225-1453-4fcb-83fa-89e32634f293"},{"id":"f15c8c65-0bbb-47df-aef8-5d5572a8ff88","text":"はー","translatedText":null,"approved":false,"translationFailed":false,"detectedLanguage":"ja","confidence":0.5642799735069275,"rotation":0.0,"bboxX":258,"bboxY":423,"bboxW":126,"bboxH":240,"panelReadingOrder":1,"bubbleReadingOrder":4,"regionType":"speech","backgroundColor":"#f4f4f4","bubbleX":257,"bubbleY":401,"bubbleW":125,"bubbleH":250,"ocrScore":0.5642799735069275,"translationScore":null,"qaScore":null,"qaFeedback":null,"qaStatus":"pending","bubbleId":"bubble_1","detectionConfidence":0.7028671503067017,"maskPolygon":"[[345, 400], [329, 405], [325, 412], [317, 419], [311, 434], [302, 442], [297, 458], [290, 466], [284, 482], [279, 487], [275, 495], [273, 517], [266, 529], [264, 537], [263, 583], [287, 607], [289, 613], [297, 623], [301, 635], [306, 639], [370, 639], [387, 622], [387, 595], [378, 585], [375, 571], [377, 519], [374, 466], [371, 457], [364, 447], [361, 418]]","safeTextX":266,"safeTextY":403,"safeTextW":119,"safeTextH":234,"panelId":"1590b225-1453-4fcb-83fa-89e32634f293"},{"id":"75a97e71-0d3e-4555-8c24-ead297b0877d","text":"中にーん","translatedText":null,"approved":false,"translationFailed":false,"detectedLanguage":"ja","confidence":0.8655929565429688,"rotation":0.0,"bboxX":2303,"bboxY":835,"bboxW":537,"bboxH":538,"panelReadingOrder":1,"bubbleReadingOrder":5,"regionType":"speech","backgroundColor":"#c6c6c6","bubbleX":2303,"bubbleY":835,"bubbleW":537,"bubbleH":538,"ocrScore":0.8655929565429688,"translationScore":null,"qaScore":null,"qaFeedback":null,"qaStatus":"pending","bubbleId":"direct_text_2","detectionConfidence":0.0,"maskPolygon":"[[2303, 835], [2840, 835], [2840, 1373], [2303, 1373]]","safeTextX":2303,"safeTextY":835,"safeTextW":537,"safeTextH":538,"panelId":"1590b225-1453-4fcb-83fa-89e32634f293"},{"id":"afdfaf01-2e95-4a13-a5d8-c201d7e14c19","text":"どMぉー","translatedText":null,"approved":false,"translationFailed":false,"detectedLanguage":"ja","confidence":0.5208718180656433,"rotation":0.0,"bboxX":612,"bboxY":1310,"bboxW":129,"bboxH":330,"panelReadingOrder":1,"bubbleReadingOrder":6,"regionType":"speech","backgroundColor":"#d9d9d9","bubbleX":612,"bubbleY":1310,"bubbleW":129,"bubbleH":330,"ocrScore":0.5208718180656433,"translationScore":null,"qaScore":null,"qaFeedback":null,"qaStatus":"pending","bubbleId":"direct_text_3","detectionConfidence":0.0,"maskPolygon":"[[612, 1310], [741, 1310], [741, 1640], [612, 1640]]","safeTextX":612,"safeTextY":1310,"safeTextW":129,"safeTextH":330,"panelId":"1590b225-1453-4fcb-83fa-89e32634f293"},{"id":"69a412fe-2910-4778-a39e-f1a70786b75b","text":"きゃうッっ","translatedText":null,"approved":false,"translationFailed":false,"detectedLanguage":"ja","confidence":0.2315245121717453,"rotation":0.0,"bboxX":2169,"bboxY":1859,"bboxW":169,"bboxH":428,"panelReadingOrder":1,"bubbleReadingOrder":7,"regionType":"speech","backgroundColor":"#d4d4d4","bubbleX":2169,"bubbleY":1859,"bubbleW":169,"bubbleH":428,"ocrScore":0.2315245121717453,"translationScore":null,"qaScore":null,"qaFeedback":null,"qaStatus":"pending","bubbleId":"direct_text_4","detectionConfidence":0.0,"maskPolygon":"[[2169, 1859], [2338, 1859], [2338, 2287], [2169, 2287]]","safeTextX":2169,"safeTextY":1859,"safeTextW":169,"safeTextH":428,"panelId":"1590b225-1453-4fcb-83fa-89e32634f293"},{"id":"b731d120-6d92-4a64-aa1c-1d49c5b89e92","text":"じゃあぼくが相手して…って、デッッッカぁー♡♡♡はお～～～?♡♡♡","translatedText":null,"approved":false,"translationFailed":false,"detectedLanguage":"ja","confidence":0.8405542373657227,"rotation":0.0,"bboxX":1463,"bboxY":1950,"bboxW":232,"bboxH":808,"panelReadingOrder":1,"bubbleReadingOrder":8,"regionType":"speech","backgroundColor":"#bbbbbb","bubbleX":1463,"bubbleY":1950,"bubbleW":232,"bubbleH":808,"ocrScore":0.8405542373657227,"translationScore":null,"qaScore":null,"qaFeedback":null,"qaStatus":"pending","bubbleId":"direct_text_6","detectionConfidence":0.0,"maskPolygon":"[[1463, 1950], [1695, 1950], [1695, 2758], [1463, 2758]]","safeTextX":1463,"safeTextY":1950,"safeTextW":232,"safeTextH":808,"panelId":"1590b225-1453-4fcb-83fa-89e32634f293"},{"id":"430c825a-620a-4808-b648-dd1ba0bbe79e","text":"ほわぁ～～き、君い♡ま、待ちたまえっ♡","translatedText":null,"approved":false,"translationFailed":false,"detectedLanguage":"ja","confidence":0.7838053107261658,"rotation":0.0,"bboxX":1067,"bboxY":1938,"bboxW":184,"bboxH":789,"panelReadingOrder":1,"bubbleReadingOrder":9,"regionType":"speech","backgroundColor":"#d9d9d9","bubbleX":1067,"bubbleY":1938,"bubbleW":184,"bubbleH":789,"ocrScore":0.7838053107261658,"translationScore":null,"qaScore":null,"qaFeedback":null,"qaStatus":"pending","bubbleId":"direct_text_5","detectionConfidence":0.0,"maskPolygon":"[[1067, 1938], [1251, 1938], [1251, 2727], [1067, 2727]]","safeTextX":1067,"safeTextY":1938,"safeTextW":184,"safeTextH":789,"panelId":"1590b225-1453-4fcb-83fa-89e32634f293"},{"id":"c96c6982-a891-4045-bc45-f2aec0be753c","text":"IDA","translatedText":null,"approved":false,"translationFailed":false,"detectedLanguage":"en","confidence":0.7598968148231506,"rotation":0.0,"bboxX":447,"bboxY":2020,"bboxW":47,"bboxH":75,"panelReadingOrder":1,"bubbleReadingOrder":10,"regionType":"speech","backgroundColor":"#bbbbbb","bubbleX":447,"bubbleY":2020,"bubbleW":47,"bubbleH":75,"ocrScore":0.7598968148231506,"translationScore":null,"qaScore":null,"qaFeedback":null,"qaStatus":"pending","bubbleId":"direct_text_7","detectionConfidence":0.0,"maskPolygon":"[[447, 2020], [494, 2020], [494, 2095], [447, 2095]]","safeTextX":447,"safeTextY":2020,"safeTextW":47,"safeTextH":75,"panelId":"1590b225-1453-4fcb-83fa-89e32634f293"},{"id":"6b5eff1f-1099-4cba-b3c2-6a2a6272dc6c","text":"まさにランドソル全土が大歓喜！ユニちゃん超エロい！ユニちゃん天才！ユニちゃん大勝利！と言ったところだろう？まあ胸の大きさ「だけ」ならチェル君にほんの少し劣るかもしれないが…","translatedText":null,"approved":false,"translationFailed":false,"detectedLanguage":"ja","confidence":0.9629311561584473,"rotation":0.0,"bboxX":2424,"bboxY":2248,"bboxW":373,"bboxH":1734,"panelReadingOrder":1,"bubbleReadingOrder":11,"regionType":"speech","backgroundColor":"#b8b8b8","bubbleX":2424,"bubbleY":2248,"bubbleW":373,"bubbleH":1734,"ocrScore":0.9629311561584473,"translationScore":null,"qaScore":null,"qaFeedback":null,"qaStatus":"pending","bubbleId":"direct_text_8","detectionConfidence":0.0,"maskPolygon":"[[2424, 2248], [2797, 2248], [2797, 3982], [2424, 3982]]","safeTextX":2424,"safeTextY":2248,"safeTextW":373,"safeTextH":1734,"panelId":"1590b225-1453-4fcb-83fa-89e32634f293"},{"id":"428fa8c3-94de-4c6b-896a-852a137cd3e0","text":"キゃっ","translatedText":null,"approved":false,"translationFailed":false,"detectedLanguage":"ja","confidence":0.2764075696468353,"rotation":0.0,"bboxX":1887,"bboxY":2640,"bboxW":173,"bboxH":373,"panelReadingOrder":1,"bubbleReadingOrder":12,"regionType":"speech","backgroundColor":"#c9c9c9","bubbleX":1887,"bubbleY":2640,"bubbleW":173,"bubbleH":373,"ocrScore":0.2764075696468353,"translationScore":null,"qaScore":null,"qaFeedback":null,"qaStatus":"pending","bubbleId":"direct_text_10","detectionConfidence":0.0,"maskPolygon":"[[1887, 2640], [2060, 2640], [2060, 3013], [1887, 3013]]","safeTextX":1887,"safeTextY":2640,"safeTextW":173,"safeTextH":373,"panelId":"1590b225-1453-4fcb-83fa-89e32634f293"},{"id":"90e32fdd-2459-4d6b-b1ab-af025545b08b","text":"76","translatedText":null,"approved":false,"translationFailed":false,"detectedLanguage":"en","confidence":0.9815851449966431,"rotation":0.0,"bboxX":11,"bboxY":2648,"bboxW":200,"bboxH":302,"panelReadingOrder":1,"bubbleReadingOrder":13,"regionType":"speech","backgroundColor":"#919191","bubbleX":11,"bubbleY":2648,"bubbleW":200,"bubbleH":302,"ocrScore":0.9815851449966431,"translationScore":null,"qaScore":null,"qaFeedback":null,"qaStatus":"pending","bubbleId":"direct_text_9","detectionConfidence":0.0,"maskPolygon":"[[11, 2648], [211, 2648], [211, 2950], [11, 2950]]","safeTextX":11,"safeTextY":2648,"safeTextW":200,"safeTextH":302,"panelId":"1590b225-1453-4fcb-83fa-89e32634f293"},{"id":"26c06b51-e4de-432d-8674-4f8ade1e8a9d","text":"おおっ♡おっ♡♡♡♡♡いやちょっ♡本当にまって♡デカスギィー♡♡♡","translatedText":null,"approved":false,"translationFailed":false,"detectedLanguage":"ja","confidence":0.8791074156761169,"rotation":0.0,"bboxX":54,"bboxY":3095,"bboxW":224,"bboxH":781,"panelReadingOrder":1,"bubbleReadingOrder":14,"regionType":"speech","backgroundColor":"#8e8e8e","bubbleX":54,"bubbleY":3095,"bubbleW":224,"bubbleH":781,"ocrScore":0.8791074156761169,"translationScore":null,"qaScore":null,"qaFeedback":null,"qaStatus":"pending","bubbleId":"direct_text_11","detectionConfidence":0.0,"maskPolygon":"[[54, 3095], [278, 3095], [278, 3876], [54, 3876]]","safeTextX":54,"safeTextY":3095,"safeTextW":224,"safeTextH":781,"panelId":"1590b225-1453-4fcb-83fa-89e32634f293"},{"id":"cfbd721a-3525-478d-84cf-348cf7131b47","text":"私い","translatedText":null,"approved":false,"translationFailed":false,"detectedLanguage":"ja","confidence":0.26188406348228455,"rotation":0.0,"bboxX":1318,"bboxY":3390,"bboxW":251,"bboxH":486,"panelReadingOrder":1,"bubbleReadingOrder":15,"regionType":"speech","backgroundColor":"#bebebe","bubbleX":1318,"bubbleY":3390,"bubbleW":251,"bubbleH":486,"ocrScore":0.26188406348228455,"translationScore":null,"qaScore":null,"qaFeedback":null,"qaStatus":"pending","bubbleId":"direct_text_12","detectionConfidence":0.0,"maskPolygon":"[[1318, 3390], [1569, 3390], [1569, 3876], [1318, 3876]]","safeTextX":1318,"safeTextY":3390,"safeTextW":251,"safeTextH":486,"panelId":"1590b225-1453-4fcb-83fa-89e32634f293"}],"conversations":[],"url":"/tlhub/api/images/fc966a13-55b0-4582-a166-7440f5a324a6/file"}
```

and

```json
[{"elements":[{"id":"68ecd7de-d3ef-49fe-982a-49a55c54e5fa","text":"きゃうッっ","font":null,"size":null,"autoSize":true,"maxWidth":169,"maxHeight":428,"wordWrap":true,"rotation":0.0,"x":2169.0,"y":1859.0,"visible":true,"overflow":false,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","isManuallyEdited":false,"editedAt":null,"boxShape":"rectangular","maskPolygon":null,"layerId":"b0bb7fde-8cea-406e-87ec-49eed28d216c","regionId":"69a412fe-2910-4778-a39e-f1a70786b75b","qaStatus":"pending","qaScore":null,"qaFeedback":null},{"id":"5294f27e-cdd8-4e2e-92cc-2a54656b5847","text":"セクシーュニで申し訳ないだがどうだね？このぼくの魅惑の爆弾ボディは？何だね、ぼくの身体にそんなに如魅了されてしまったのかね？♡じゃあちょっとだけ過激な所も見せてあげようじゃないか、ほれ♡ひっ","font":null,"size":null,"autoSize":true,"maxWidth":820,"maxHeight":1472,"wordWrap":true,"rotation":0.0,"x":1079.0,"y":7.0,"visible":true,"overflow":false,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","isManuallyEdited":false,"editedAt":null,"boxShape":"rectangular","maskPolygon":null,"layerId":"b0bb7fde-8cea-406e-87ec-49eed28d216c","regionId":"3fb5ba0d-8192-47b7-a596-50c4591927ad","qaStatus":"pending","qaScore":null,"qaFeedback":null},{"id":"08f94d25-ddd8-40e4-bf53-7ff39adbe7d8","text":"え～、なに君ら？♡勅起しちゃったの～？♡しょうがないにゃ～♡（ニヤニヤ）","font":null,"size":null,"autoSize":true,"maxWidth":165,"maxHeight":1169,"wordWrap":true,"rotation":0.0,"x":70.0,"y":23.0,"visible":true,"overflow":false,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","isManuallyEdited":false,"editedAt":null,"boxShape":"rectangular","maskPolygon":null,"layerId":"b0bb7fde-8cea-406e-87ec-49eed28d216c","regionId":"34396327-40b2-49e8-b23d-0509d4159187","qaStatus":"pending","qaScore":null,"qaFeedback":null},{"id":"3f80f513-cd7f-4879-a29e-23dabe82b580","text":"は","font":null,"size":null,"autoSize":true,"maxWidth":95,"maxHeight":134,"wordWrap":true,"rotation":0.0,"x":980.0,"y":482.0,"visible":true,"overflow":false,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","isManuallyEdited":false,"editedAt":null,"boxShape":"rectangular","maskPolygon":null,"layerId":"b0bb7fde-8cea-406e-87ec-49eed28d216c","regionId":"92200d92-0769-4a99-a55f-38a844a8e643","qaStatus":"pending","qaScore":null,"qaFeedback":null},{"id":"ef60bcf3-e2b4-4401-8bd7-220f5d4bfa8e","text":"はー","font":null,"size":null,"autoSize":true,"maxWidth":126,"maxHeight":240,"wordWrap":true,"rotation":0.0,"x":258.0,"y":423.0,"visible":true,"overflow":false,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","isManuallyEdited":false,"editedAt":null,"boxShape":"rectangular","maskPolygon":null,"layerId":"b0bb7fde-8cea-406e-87ec-49eed28d216c","regionId":"f15c8c65-0bbb-47df-aef8-5d5572a8ff88","qaStatus":"pending","qaScore":null,"qaFeedback":null},{"id":"ca0b956d-74a6-4c0a-a516-3e390e1ad4eb","text":"中にーん","font":null,"size":null,"autoSize":true,"maxWidth":537,"maxHeight":538,"wordWrap":true,"rotation":0.0,"x":2303.0,"y":835.0,"visible":true,"overflow":false,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","isManuallyEdited":false,"editedAt":null,"boxShape":"rectangular","maskPolygon":null,"layerId":"b0bb7fde-8cea-406e-87ec-49eed28d216c","regionId":"75a97e71-0d3e-4555-8c24-ead297b0877d","qaStatus":"pending","qaScore":null,"qaFeedback":null},{"id":"7aaa12a2-e242-4376-8017-109e28dfbd77","text":"どMぉー","font":null,"size":null,"autoSize":true,"maxWidth":129,"maxHeight":330,"wordWrap":true,"rotation":0.0,"x":612.0,"y":1310.0,"visible":true,"overflow":false,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","isManuallyEdited":false,"editedAt":null,"boxShape":"rectangular","maskPolygon":null,"layerId":"b0bb7fde-8cea-406e-87ec-49eed28d216c","regionId":"afdfaf01-2e95-4a13-a5d8-c201d7e14c19","qaStatus":"pending","qaScore":null,"qaFeedback":null},{"id":"ae530174-f236-4b2b-b93f-4c2c3c7966e9","text":"じゃあぼくが相手して…って、デッッッカぁー♡♡♡はお～～～?♡♡♡","font":null,"size":null,"autoSize":true,"maxWidth":232,"maxHeight":808,"wordWrap":true,"rotation":0.0,"x":1463.0,"y":1950.0,"visible":true,"overflow":false,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","isManuallyEdited":false,"editedAt":null,"boxShape":"rectangular","maskPolygon":null,"layerId":"b0bb7fde-8cea-406e-87ec-49eed28d216c","regionId":"b731d120-6d92-4a64-aa1c-1d49c5b89e92","qaStatus":"pending","qaScore":null,"qaFeedback":null},{"id":"c3f53e2a-bb27-4b39-bc7d-28e07491499a","text":"ほわぁ～～き、君い♡ま、待ちたまえっ♡","font":null,"size":null,"autoSize":true,"maxWidth":184,"maxHeight":789,"wordWrap":true,"rotation":0.0,"x":1067.0,"y":1938.0,"visible":true,"overflow":false,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","isManuallyEdited":false,"editedAt":null,"boxShape":"rectangular","maskPolygon":null,"layerId":"b0bb7fde-8cea-406e-87ec-49eed28d216c","regionId":"430c825a-620a-4808-b648-dd1ba0bbe79e","qaStatus":"pending","qaScore":null,"qaFeedback":null},{"id":"db1a7b6f-356c-46bf-8e7a-65a64da60f5b","text":"IDA","font":null,"size":null,"autoSize":true,"maxWidth":47,"maxHeight":75,"wordWrap":true,"rotation":0.0,"x":447.0,"y":2020.0,"visible":true,"overflow":false,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","isManuallyEdited":false,"editedAt":null,"boxShape":"rectangular","maskPolygon":null,"layerId":"b0bb7fde-8cea-406e-87ec-49eed28d216c","regionId":"c96c6982-a891-4045-bc45-f2aec0be753c","qaStatus":"pending","qaScore":null,"qaFeedback":null},{"id":"e3a8d8f6-2be5-40c8-b5e6-113e46786a65","text":"まさにランドソル全土が大歓喜！ユニちゃん超エロい！ユニちゃん天才！ユニちゃん大勝利！と言ったところだろう？まあ胸の大きさ「だけ」ならチェル君にほんの少し劣るかもしれないが…","font":null,"size":null,"autoSize":true,"maxWidth":373,"maxHeight":1734,"wordWrap":true,"rotation":0.0,"x":2424.0,"y":2248.0,"visible":true,"overflow":false,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","isManuallyEdited":false,"editedAt":null,"boxShape":"rectangular","maskPolygon":null,"layerId":"b0bb7fde-8cea-406e-87ec-49eed28d216c","regionId":"6b5eff1f-1099-4cba-b3c2-6a2a6272dc6c","qaStatus":"pending","qaScore":null,"qaFeedback":null},{"id":"12732930-9d1a-491b-9522-e316258e7be1","text":"キゃっ","font":null,"size":null,"autoSize":true,"maxWidth":173,"maxHeight":373,"wordWrap":true,"rotation":0.0,"x":1887.0,"y":2640.0,"visible":true,"overflow":false,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","isManuallyEdited":false,"editedAt":null,"boxShape":"rectangular","maskPolygon":null,"layerId":"b0bb7fde-8cea-406e-87ec-49eed28d216c","regionId":"428fa8c3-94de-4c6b-896a-852a137cd3e0","qaStatus":"pending","qaScore":null,"qaFeedback":null},{"id":"ca351b1d-f39c-4d27-87a1-9a33d2b37455","text":"76","font":null,"size":null,"autoSize":true,"maxWidth":200,"maxHeight":302,"wordWrap":true,"rotation":0.0,"x":11.0,"y":2648.0,"visible":true,"overflow":false,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","isManuallyEdited":false,"editedAt":null,"boxShape":"rectangular","maskPolygon":null,"layerId":"b0bb7fde-8cea-406e-87ec-49eed28d216c","regionId":"90e32fdd-2459-4d6b-b1ab-af025545b08b","qaStatus":"pending","qaScore":null,"qaFeedback":null},{"id":"83cc798e-55b3-4469-82fc-a5a786a034bd","text":"おおっ♡おっ♡♡♡♡♡いやちょっ♡本当にまって♡デカスギィー♡♡♡","font":null,"size":null,"autoSize":true,"maxWidth":224,"maxHeight":781,"wordWrap":true,"rotation":0.0,"x":54.0,"y":3095.0,"visible":true,"overflow":false,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","isManuallyEdited":false,"editedAt":null,"boxShape":"rectangular","maskPolygon":null,"layerId":"b0bb7fde-8cea-406e-87ec-49eed28d216c","regionId":"26c06b51-e4de-432d-8674-4f8ade1e8a9d","qaStatus":"pending","qaScore":null,"qaFeedback":null},{"id":"ca44a827-1c99-456a-8eea-f0506f62d864","text":"私い","font":null,"size":null,"autoSize":true,"maxWidth":251,"maxHeight":486,"wordWrap":true,"rotation":0.0,"x":1318.0,"y":3390.0,"visible":true,"overflow":false,"backgroundColor":null,"textColor":null,"fontWeight":"normal","fontStyle":"normal","isManuallyEdited":false,"editedAt":null,"boxShape":"rectangular","maskPolygon":null,"layerId":"b0bb7fde-8cea-406e-87ec-49eed28d216c","regionId":"cfbd721a-3525-478d-84cf-348cf7131b47","qaStatus":"pending","qaScore":null,"qaFeedback":null}],"layer":{"id":"b0bb7fde-8cea-406e-87ec-49eed28d216c","type":"ocr","targetLanguage":null,"visible":true,"createdAt":"2026-07-23T15:48:44.42497Z","metadataJson":{"cost":{"currency":"USD","breakdown":[{"model":"deepseek/deepseek-v4-pro","currency":"USD","provider":"openrouter","prompt_tokens":1709,"estimated_cost":0.001545555,"completion_tokens":922}],"prompt_tokens":1709,"estimated_cost":0.001545555,"completion_tokens":922},"time":"2026-07-23T15:48:44.424406522Z","model":"PaddleOCR(PP-OCRv6_medium_rec)","provider":"OCR Worker","confidence":0.7035602091639129,"layer_name":"OCR","layer_order":1,"last_modified":"2026-07-23T15:48:44.424911488Z"},"zorder":1}}]
```

Isn't this like doing the same thing twice

## Need a proper API schema and REST Validation

THIS
