# Plan: Fix Constant 500s on `/api/pages/{pageId}/details`

> **Audience:** execution agents. Every task below is self-contained with exact file paths,
> line numbers, and before/after code. Line numbers are accurate as of commit `97b4951`.
> If a line number has drifted, search for the quoted "before" snippet instead.
>
> **Do not improvise beyond these instructions.** The "DO NOT TOUCH" section at the bottom
> lists things that look suspicious but are intentionally left alone.

---

## 1. Problem Summary

The backend log is flooded with 500s from `GET /api/pages/{pageId}/details`:

```
IllegalArgumentException: Page not found: 0ec84284-7592-405a-8acd-7dfb106e965b
    at com.manga.library.controller.PageController.lambda$getPageDetails$0(PageController.java:736)
```

- `logs/run-13.log` (latest): **36 error events, 100% this exception, zero other causes.**
- Verified against the live DB: every "missing" UUID in the logs **exists in the `images`
  table but not in `pages`** — the frontend is sending **image UUIDs to a page-UUID endpoint**.

## 2. Root Cause (proven — do not re-investigate)

Commit `db9b4dd` ("replace image-based references with pages") changed the signature of
`fetchPageDetails` in `frontend/src/components/Reader.tsx` from:

```ts
async (imageId: string) => { ... }
```

to:

```ts
async (pageId: string, imageId: string) => { ... }
```

It updated the **main** call site but **missed the prefetch call site** (`Reader.tsx:666`):

```ts
fetchPageDetails(p.imageId)   // image UUID binds to the `pageId` parameter!
```

So the prefetch loop requests `/api/pages/{IMAGE_UUID}/details` → page lookup misses →
`IllegalArgumentException` → no exception mapping → 500. It is *constant* because the
prefetch loop (pages N+1, N+2) runs on every page turn and the prefetch-queue eviction
re-arms failed entries, so it retries forever while the user reads.

There is also a **secondary cache-key mismatch** in the same `useEffect`: the main fetch
caches under `pageId`, but the prefetch check, prefetch queue, and eviction window all key
by `imageId`. Result: the currently displayed page's cache entry is evicted immediately,
and prefetch re-fetches pages that are already cached.

## 3. Fix Overview

| Task | Scope | What it fixes | Risk |
|------|-------|---------------|------|
| **1** | `frontend/src/components/Reader.tsx` | Root cause: wrong UUID passed + cache-key mismatch | Low |
| **2** | Backend (new files + 3 controllers) | Correct HTTP semantics: 404 with message instead of opaque 500 | Low |
| **3** | Tests (frontend + backend) | Regression coverage for both fixes | Low |

Tasks 1 and 2 are **independent** and can be done in any order, by different agents.
Task 3 depends on the task it tests. Deploy order: Task 1 first (stops the 500 flood),
Task 2 second (makes any future stale-ID a clean 404).

---

## Task 1 — Frontend: fix prefetch + cache keys in `Reader.tsx`

**File:** `frontend/src/components/Reader.tsx`
**Run tests after:** `cd frontend && npm run test -- Reader` (vitest).

### 1a. Replace `fetchPageDetails` with a single-ID signature

The dual-UUID positional signature is what allowed this bug to compile. Collapse it to
pageId-only (both remaining call sites have a real page object).

**Before** (lines 556–591):

```ts
  // Helper to fetch and cache a page
  const fetchPageDetails = useCallback(
    async (pageId: string, imageId: string) => {
      const cacheKey = pageId || imageId;
      if (pageDetailsCache.current[cacheKey]) {
        return pageDetailsCache.current[cacheKey];
      }

      const detailsUrl = pageId ? `/api/pages/${pageId}/details` : `/api/images/${imageId}`;
      const layersUrl = pageId ? `/api/pages/${pageId}/layers` : `/api/images/${imageId}/layers`;
```

**After:**

```ts
  // Helper to fetch and cache a page
  const fetchPageDetails = useCallback(
    async (pageId: string) => {
      const cacheKey = pageId;
      if (pageDetailsCache.current[cacheKey]) {
        return pageDetailsCache.current[cacheKey];
      }

      const detailsUrl = `/api/pages/${pageId}/details`;
      const layersUrl = `/api/pages/${pageId}/layers`;
```

The rest of the function body is unchanged.

### 1b. Fix the main call site (line ~621)

**Before:**

```ts
        fetchPageDetails(currentPageId, currentImageId)
```

**After:**

```ts
        fetchPageDetails(currentPageId)
```

### 1c. Fix the prefetch loop — the actual 500 generator (lines ~650–669)

**Before:**

```ts
        pagesToPrefetch.forEach((p) => {
          if (
            !pageDetailsCache.current[p.imageId] &&
            !prefetchQueue.current.has(p.imageId)
          ) {
            prefetchQueue.current.add(p.imageId);

            // Prefetch image itself (lightweight progressive loading)
            const img = new Image();
            img.src = `${p.url}?token=${user.token}`;

            // Prefetch details
            fetchPageDetails(p.imageId).catch((e) =>
              console.error("Prefetch error", e),
            );
          }
        });
```

**After:**

```ts
        pagesToPrefetch.forEach((p) => {
          if (
            !pageDetailsCache.current[p.id] &&
            !prefetchQueue.current.has(p.id)
          ) {
            prefetchQueue.current.add(p.id);

            // Prefetch image itself (lightweight progressive loading)
            const img = new Image();
            img.src = `${p.url}?token=${user.token}`;

            // Prefetch details (must use the PAGE id, not the image id)
            fetchPageDetails(p.id).catch((e) => {
              // Allow retry on next navigation instead of staying queued forever
              prefetchQueue.current.delete(p.id);
              console.error("Prefetch error", e);
            });
          }
        });
```

### 1d. Fix the eviction window (lines ~671–675)

**Before:**

```ts
        const activeWindowIds = new Set([
          currentImageId,
          ...pagesToPrefetch.map((p) => p.imageId),
        ]);
```

**After:**

```ts
        const activeWindowIds = new Set([
          currentPageId,
          ...pagesToPrefetch.map((p) => p.id),
        ]);
```

### 1e. Cleanup note

After 1b–1d, the local `const currentImageId = selectedPage.imageId;` (line ~599) may
become unused inside this `useEffect` except in the cache-hit fallback
`pageDetailsCache.current[currentPageId] || pageDetailsCache.current[currentImageId]`
(line ~603). **Keep that fallback line as-is** (harmless, defensive) so `currentImageId`
stays referenced and no lint error appears. Do not remove the variable.

The SSE cache-bust at lines ~323–324 already deletes **both** keys
(`selectedPage.id` and `selectedPage.imageId`) — leave it unchanged.

### 1f. Acceptance criteria for Task 1

- `npm run test -- Reader` passes (existing tests + the new one from Task 3).
- `npm run build` (tsc) shows no unused-variable or type errors in `Reader.tsx`.
- Manual: open a chapter with ≥3 pages, turn pages — `docker logs manga-backend` shows
  **zero** `Page not found` errors and prefetch requests return 200.

---

## Task 2 — Backend: proper 404/400/413/500 error responses

Currently every exception becomes the Spring default 500 blob with no `message` field.
This task adds a global exception handler and a dedicated not-found exception.

### 2a. NEW file: `backend/src/main/java/com/manga/library/exception/ResourceNotFoundException.java`

The `exception` package does not exist yet — create it.

```java
package com.manga.library.exception;

/**
 * Thrown when a requested entity does not exist. Mapped to HTTP 404 by
 * GlobalExceptionHandler.
 *
 * <p>IMPORTANT: must extend RuntimeException directly, NOT IllegalArgumentException —
 * some controllers catch IllegalArgumentException locally and convert it to 400
 * (e.g. PageController upload flow), and not-found must not be swallowed by those.
 */
public class ResourceNotFoundException extends RuntimeException {
  public ResourceNotFoundException(String message) {
    super(message);
  }
}
```

### 2b. NEW file: `backend/src/main/java/com/manga/library/config/GlobalExceptionHandler.java`

```java
package com.manga.library.config;

import com.manga.library.exception.ResourceNotFoundException;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.multipart.MaxUploadSizeExceededException;

/**
 * Maps exceptions to proper HTTP status codes with human-readable messages.
 * Response shape: {timestamp, status, error, message, path}.
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

  private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

  private ResponseEntity<Map<String, Object>> buildBody(
      HttpStatus status, String message, HttpServletRequest request) {
    Map<String, Object> body = new LinkedHashMap<>();
    body.put("timestamp", Instant.now().toString());
    body.put("status", status.value());
    body.put("error", status.getReasonPhrase());
    body.put("message", message == null ? status.getReasonPhrase() : message);
    body.put("path", request.getRequestURI());
    return ResponseEntity.status(status).body(body);
  }

  /** Entity not found → 404. */
  @ExceptionHandler(ResourceNotFoundException.class)
  public ResponseEntity<Map<String, Object>> handleNotFound(
      ResourceNotFoundException ex, HttpServletRequest request) {
    return buildBody(HttpStatus.NOT_FOUND, ex.getMessage(), request);
  }

  /** Validation failures (incl. Objects.requireNonNull NPEs) → 400. */
  @ExceptionHandler({IllegalArgumentException.class, NullPointerException.class})
  public ResponseEntity<Map<String, Object>> handleBadRequest(
      RuntimeException ex, HttpServletRequest request) {
    return buildBody(HttpStatus.BAD_REQUEST, ex.getMessage(), request);
  }

  /** Upload too large → 413. */
  @ExceptionHandler(MaxUploadSizeExceededException.class)
  public ResponseEntity<Map<String, Object>> handleUploadTooLarge(
      MaxUploadSizeExceededException ex, HttpServletRequest request) {
    return buildBody(HttpStatus.PAYLOAD_TOO_LARGE, "File exceeds maximum upload size", request);
  }

  /** Everything else → 500, but with the actual message attached. */
  @ExceptionHandler(Exception.class)
  public ResponseEntity<Map<String, Object>> handleInternalError(
      Exception ex, HttpServletRequest request) {
    log.error("Unhandled exception on {} {}", request.getMethod(), request.getRequestURI(), ex);
    return buildBody(
        HttpStatus.INTERNAL_SERVER_ERROR, "Something went wrong: " + ex.getMessage(), request);
  }
}
```

### 2c. Swap not-found throws `IllegalArgumentException` → `ResourceNotFoundException`

For each site below: change **only** the exception class name and keep the message string
identical. Add `import com.manga.library.exception.ResourceNotFoundException;` to each
modified file.

| File | Line | Current throw |
|------|------|---------------|
| `controller/PageController.java` | 150 | `new IllegalArgumentException("Chapter not found: " + chapterId)` |
| `controller/PageController.java` | 736 | `new IllegalArgumentException("Page not found: " + pageId)` |
| `controller/PageController.java` | 789 | `new IllegalArgumentException("Image not found: " + imageId)` |
| `controller/PageController.java` | 865 | `new IllegalArgumentException("Image not found: " + imageId)` |
| `controller/PageController.java` | 893 | `new IllegalArgumentException("Image not found: " + imageId)` |
| `controller/PageController.java` | 1103 | `new IllegalArgumentException("Chapter not found: " + chapterId)` |
| `controller/SeriesController.java` | 241 | `new IllegalArgumentException("Series not found: " + seriesId)` |
| `controller/SeriesController.java` | 452 | `new IllegalArgumentException("Series not found: " + seriesId)` |
| `controller/SeriesController.java` | 624 | `new IllegalArgumentException("Chapter not found: " + chapterId)` |
| `controller/LayerController.java` | 205 | `new IllegalArgumentException("No page found for image: " + imageId)` |

**Intended behavior changes (not mistakes):**

- `PageController.java:150` — currently this throw is caught by the local
  `catch (IllegalArgumentException e)` at line 664 and returned as **400**. After the swap
  it escapes to the advice → **404**. That is the desired semantics (missing chapter is not
  a client-syntax error).
- Lines 865/893 (`getImageFile`/`getImageThumbnail`) — these throws sit inside
  `try { ... } catch (Exception e) { return ResponseEntity.notFound().build(); }`, so they
  already return 404 and will continue to (the local catch swallows the new exception too).
  Swap anyway for consistency.

**DO NOT swap these — they are validation errors and must stay `IllegalArgumentException`
(→ 400 via the advice, and some are intentionally caught at `PageController.java:664`):**

- `PageController.java:61, 74, 98, 107, 126` — all `"Invalid file type. Accepted formats: ..."` throws.
- All `Objects.requireNonNull(...)` calls — they throw NPE, now mapped to 400 by the advice.

### 2d. Build & existing-test safety

- Build: `cd backend && ./mvnw -q compile` (or `mvn -q compile`).
- Existing tests were audited against this change: every test asserting
  `isInternalServerError()` throws a `RuntimeException` (still → 500 via the catch-all
  handler), and every `isNotFound()` test hits a path that already returns 404 locally.
  **No existing test should change status.** Run `cd backend && ./mvnw test` to confirm;
  if a test flips, re-check that you did not swap a validation throw by mistake.

---

## Task 3 — Regression tests

### 3a. Frontend: prefetch must use page IDs (depends on Task 1)

**File:** `frontend/src/components/Reader.test.tsx` — add inside the existing
`describe("Reader Component", ...)` block. The existing `mockSafeFetch` mock and `mockPage`
fixture are already in scope; `pages` is passed as a prop.

```tsx
  it("prefetches next pages by page id, never by image id", async () => {
    const mockPages = [
      mockPage,
      { ...mockPage, id: "p2", pageNumber: 2, imageId: "img2" },
      { ...mockPage, id: "p3", pageNumber: 3, imageId: "img3" },
    ];
    render(
      <Reader
        user={mockUser}
        selectedSeries={mockSeries}
        selectedChapter={mockChapter}
        chapters={[mockChapter]}
        pages={mockPages}
        theme="dark"
      />,
    );

    await screen.findByText(/Test Series/);

    await waitFor(() => {
      const urls = mockSafeFetch.mock.calls.map((c) => c[0] as string);
      // Prefetch of N+1 and N+2 must hit the pages endpoints with PAGE ids
      expect(urls).toContain("/api/pages/p2/details");
      expect(urls).toContain("/api/pages/p3/details");
      expect(urls).toContain("/api/pages/p2/layers");
      expect(urls).toContain("/api/pages/p3/layers");
      // Image ids must never appear in /api/pages/* URLs
      expect(
        urls.some(
          (u) => u.includes("/api/pages/img2") || u.includes("/api/pages/img3"),
        ),
      ).toBe(false);
    });
  });
```

Note: `mockPage` has `id: "p1"`, `imageId: "img1"`. The prefetch loop only fires when the
selected page (page 1) has successors, hence three pages. `new Image()` is safe under
jsdom (it never actually loads).

### 3b. Backend: unknown page id returns 404 with message (depends on Task 2)

**File:** `backend/src/test/java/com/manga/library/controller/PageControllerTest.java` —
add a method to the existing class. `@WebMvcTest` auto-registers `@RestControllerAdvice`
beans, so no extra setup is needed. The page lookup is the first repository call in
`getPageDetails`, so mocking `findById` → empty is sufficient.

```java
  @Test
  public void testGetPageDetails_NotFound_Returns404WithMessage() throws Exception {
    UUID pageId = UUID.randomUUID();
    when(pageRepository.findById(pageId)).thenReturn(Optional.empty());

    mockMvc
        .perform(get("/api/pages/" + pageId + "/details"))
        .andExpect(status().isNotFound())
        .andExpect(jsonPath("$.status").value(404))
        .andExpect(jsonPath("$.message").value("Page not found: " + pageId))
        .andExpect(jsonPath("$.path").value("/api/pages/" + pageId + "/details"));
  }
```

Run: `cd backend && ./mvnw test -Dtest=PageControllerTest`.

---

## 4. End-to-end verification (after all tasks)

1. `docker compose up -d --build backend frontend` (or the project's usual rebuild flow).
2. Open the reader on a chapter with ≥3 pages; turn several pages forward and back.
3. `docker logs manga-backend --since 10m 2>&1 | grep -c "Page not found"` → **must be 0**.
4. `curl -H "Authorization: Bearer <token>" http://localhost:8080/tlhub/api/pages/$(uuidgen)/details`
   → expect HTTP **404** with body containing `"message":"Page not found: <uuid>"`.
5. `cd frontend && npm run test` and `cd backend && ./mvnw test` → all green.

## 5. DO NOT TOUCH (verified safe — changing these wastes time or breaks things)

- **`InternalJobController` / worker callbacks** — workers intentionally still send
  `imageId`; backend shims resolve image→page. Working as designed.
- **Backend shim endpoints** `GET /api/images/{imageId}` (details) and
  `GET /api/images/{imageId}/layers` — keep them; they redirect to page-based logic and
  are still used by the redo-polling code (`Reader.tsx:2680`) and redo triggers
  (`Reader.tsx:2724, 2760`).
- **Panels staying image-based** (`panelRepository.findByImageId` in `getPageDetails`) —
  panels were deliberately not migrated; `getPageDetails` resolves them via
  `page.getImage().getId()`.
- **SSE cache-bust in `Reader.tsx` (~lines 323–324)** — already deletes both cache keys.
- **Hibernate/Jackson config** (`open-in-view`, `fail-on-empty-beans`) — the old
  serialization 500s are fixed; `run-13.log` contains zero such errors.
- **The database migration** (`001_image_id_to_page_id.sql`) — data verified consistent;
  all layer/conversation/ocr_region rows joined correctly through `pages.image_id`.

## 6. Appendix: evidence trail

| Evidence | Where |
|----------|-------|
| 36 × `IllegalArgumentException: Page not found` at `PageController:736` | `logs/run-13.log` |
| Same pattern, earlier run | `logs/run-12.log` (6 occurrences) |
| All 6 logged UUIDs exist in `images`, none in `pages` | live query on `manga-db` (psql) |
| Signature change that introduced the bug | `git show db9b4dd -- frontend/src/components/Reader.tsx` |
| Migration commit | `git show 3e7b7ff` |
| Related plan items (1b, 2) | `plan-more-improvements.md` |
