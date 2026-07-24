# Plan: More Improvements

## 1. [CRITICAL] `/api/pages/{pageId}/details` returns 500 (✅ COMPLETED)

### Root Cause (3 compounding issues)

1. **`open-in-view: false`** → Hibernate session closes before Jackson serializes
2. **Jackson `FAIL_ON_EMPTY_BEANS`** → `ByteBuddyInterceptor` on Hibernate proxies has no serializer
3. **Missing PKs on `images`/`chapters`** → `ddl-auto: update` silently skipped PK creation

### Fixes Applied

| # | Fix | File |
|---|-----|------|
| 1 | `open-in-view: false` → `true` | `application.yml:16` |
| 2 | `fail-on-empty-beans: false` | `application.yml:31-33` |
| 3 | Raw `Page` entity → plain `Map` | `PageController.java:762-766` |
| 4 | Removed `@Transactional` from controller endpoints | `PageController.java:730-731, 779-780` |
| 5 | Manual PKs on `images` and `chapters` | SQL |
| 6 | `halt_on_error: true` for DDL | `application.yml:19-20` |

### Remaining Issue: `IllegalArgumentException: Page not found` → 500 instead of 404

When a page doesn't exist (e.g., after DB wipe or deleted page), the controller throws:

```java
.orElseThrow(() -> new IllegalArgumentException("Page not found: " + pageId));
```

`IllegalArgumentException` is **not** mapped to 404 — it becomes a 500 with:

```json
{"timestamp":"...","status":500,"error":"Internal Server Error","path":"..."}
```

**No message, no hint it's actually a 404.** The frontend has no idea what went wrong.

### Also: `IllegalArgumentException` becoming 500 instead of 400/404

Same pattern used throughout the controller:

```java
Objects.requireNonNull(pageId, "pageId cannot be null"); // → NullPointerException → 500
.orElseThrow(() -> new IllegalArgumentException("Chapter not found: ...")); // → 500
```

All of these should return proper HTTP status codes with messages.

### Fix (see Issue #2 — Global error handler)

---

## 2. API error responses are useless (no message, wrong status codes)

### Problem

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

### Fix

Add `@ControllerAdvice` / `@ExceptionHandler` that maps specific exceptions to proper HTTP status codes **with human-readable messages**:

```java
@ExceptionHandler(IllegalArgumentException.class) → 400/404 (depending on message)
@ExceptionHandler(NullPointerException.class) → 400
@ExceptionHandler(EntityNotFoundException.class) → 404
@ExceptionHandler(MaxUploadSizeExceededException.class) → 413
@ExceptionHandler(Exception.class) → 500 (include message in dev, generic in prod)
```

### Frontend required change

Display these error messages in toast/alert. Currently errors are swallowed — user sees infinite spinner.

---

## 3. If reader navigates to page 2 when chapter has 1 page → infinite spinner

### Problem

URL `/chapters/{id}/default/reader/2` when chapter has only 1 page. No error, just spins forever.

### Fix

In `Reader.tsx`: validate `currentPageNumber ≤ pages.length`, redirect to last valid page, show toast.

---

## 4. No JWT expiry handling → user gets stuck silently

### Problem

Token expires after 24h. All API calls return 401. Frontend shows blank/spinner. No logout redirect, no message.

### Fix

In `safeFetch()`: on 401 → clear token, toast "Session expired", redirect to `/login`. Add `POST /api/auth/refresh` for auto-extend.

---

## 5. No auto-extension of active sessions

### Problem

Active user for >24h gets booted. No refresh mechanism.

### Fix

Add `/api/auth/refresh` endpoint. Frontend calls it every 60 mins while user is active. Issues new JWT if user was active ≤15 mins ago.

---

## 6. [CRITICAL] Translation layer has empty text — OpenRouter API returns 404

### Symptom

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

### Root Cause

Worker log from `run-12.log`:

```
[ERROR] Cloud LLM Translation failed: 404 Client Error: Not Found for url: https://openrouter.ai/api/v1/chat/completions
```

OpenRouter returned **404** when the worker tried to call the translation API. The worker handled the error and sent back `translationFailed: true` with empty text, but the backend still created the translation layer with no content.

### Possible Causes

1. **API key is invalid or expired** — OpenRouter returns 404 (not 401) for unknown/invalid API keys
2. **Model name is wrong** — `deepseek/deepseek-v4-pro` might not exist or might be renamed
3. **Worker silently swallows translation failures** — the layer is created even when all translations failed

### Fix

1. **Verify OpenRouter API key** — check `OPENROUTER_API_KEY` env var in docker-compose
2. **Verify model name** — check OpenRouter docs for the correct model path
3. **Worker should NOT create translation layer if ALL translations failed** — it should either retry or mark the job as failed so the user knows something is wrong, not silently create an empty layer

---

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

## 8. Frontend UX & Button Clutter

### Problem

The chapter card has too many buttons. "Force export" should be moved out of the primary view.

### Fix

Move the "Force export" button to an overflow (triple dots) menu.

---

## 9. Custom Fonts Missing in Dev

### Problem

The custom fonts (like Comic Neue) have stopped working in the frontend dev environment, only default system ones work.

### Fix

Ensure font assets are properly served or imported in the Vite dev server configuration or global CSS.

---

## 10. Costs Database Validation

### Problem

We need to ensure that the costs DB is being updated properly and costs are actually being tracked after processing jobs.

### Fix

Validate and add tests to ensure the cost records are correctly inserted when jobs finish.

---

## 11. Fallback Models Still Failing

### Problem

Even when "Fallback Models" is enabled, jobs can fail (e.g., `openrouter/tencent/hy3:free` returns 500). The fallback mechanism might not be working correctly or the fallback models themselves are failing without gracefully retrying another one.

### Fix

Improve the fallback logic in the worker to ensure it tries the next available model in the fallback list if the primary one returns a 500.

---

## 12. API Endpoint Redundancy & OpenAPI Spec

### Problem

We currently have two different API endpoints for loading a single page in the reader: `/api/pages/{pageId}/details` and `/api/pages/{pageId}/layers`. They return largely similar or overlapping data, which is inefficient.
Furthermore, there is no formal contract or schema for the API.

### Fix

1. Create a proper **OpenAPI Spec** for the REST API to address the design and serve as a contract.
2. Unify the page loading endpoints or clearly separate their concerns based on the spec.
3. Enforce REST validation.

---

## Action Items Summary

| # | Issue | Status |
|---|-------|--------|
| 1 | `/api/pages/{id}/details` — proxy/lazy init issues | ✅ Fixed |
| 1b | `/api/pages/{id}/details` — `IllegalArgumentException` → 404, not 500 | ✅ Fixed |
| 2 | Proper 4XX/5XX error responses with messages | ✅ Fixed |
| 3 | Reader page-out-of-bounds infinite spinner | ✅ Fixed |
| 4 | JWT expiry detection & redirect to login | 🔲 TODO |
| 5 | Auto-extend active sessions via `/auth/refresh` | 🔲 TODO |
| 6 | Translation layer empty text — OpenRouter 404 | ✅ Fixed (Short-circuited at backend) |
| 7 | Unit tests are useless (mock everything, catch nothing) | 🔲 TODO |
| 8 | Move "Force export" button to overflow menu | 🔲 TODO |
| 9 | Fix custom fonts not loading in dev frontend | 🔲 TODO |
| 10 | Validate cost DB tracking is accurate | 🔲 TODO |
| 11 | Fallback models failing / improve fallback logic | 🔲 TODO |
| 12 | Create OpenAPI spec & fix API redundancy | 🔲 TODO (High Priority) |
