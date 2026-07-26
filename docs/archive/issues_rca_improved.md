# Improved Fix Plan — manga-library Issues

> All file paths are relative to repo root. Each task includes exact action, file, and validation method.
> Tasks marked [PARALLEL] can run in any order alongside other [PARALLEL] tasks.
> Tasks marked [SEQUENTIAL] depend on the previous task.

---

## Phase 0: Foundation Fixes (do these first — they affect everything)

### 0.1 Fix empty environment defaults on first load [SEQUENTIAL from 0.2]

**File:** `docker-compose.yml`

**Action:** For every `${VAR}` reference under `backend.environment` that has a Spring Boot default, add bash fallback using `${VAR:-defaultValue}`.

Find all lines like:

```yaml
- OCR_MODEL_PROVIDER=${OCR_MODEL_PROVIDER}
- TL_MODEL_PROVIDER=${TL_MODEL_PROVIDER}
```

Replace them with:

```yaml
- OCR_MODEL_PROVIDER=${OCR_MODEL_PROVIDER:-openrouter}
- TL_MODEL_PROVIDER=${TL_MODEL_PROVIDER:-openrouter}
```

**Find the full list by:** running `grep '\${.*}' docker-compose.yml` and checking which ones map to Spring `@Value("${...:default}")` in the backend. Add `:-defaultValue` for every one that has a Spring default.

**Validate:** `docker compose config` shows the fallback values when `.env` is missing.

### 0.2 Add PATCH to CORS allowed methods [PARALLEL]

**File:** `backend/src/main/java/com/manga/library/config/SecurityConfig.java`

**Action:** On the line that sets allowed methods (roughly line 73), add `"PATCH"`:

```java
// BEFORE:
configuration.setAllowedMethods(Arrays.asList("GET", "POST", "PUT", "DELETE", "OPTIONS"));

// AFTER:
configuration.setAllowedMethods(Arrays.asList("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"));
```

**Validate:** After deploy, run `curl -X OPTIONS -H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: PATCH" http://localhost:8080/tlhub/api/pages/any-id/number` — it must return 200.

---

## Phase 1: Provider & Model Visibility

### 1.1 Remove hardcoded provider fallback (both TL and OCR) [PARALLEL]

**File:** `backend/src/main/java/com/manga/library/service/SystemSettingsService.java`

**Action:** Remove both fallback blocks. Find these two code blocks:

**Block 1 (TL providers, ~lines 92-96):**

```java
List<String> activeProviders = providerConfigCache.getProvidersForTask("tl");
if (activeProviders.isEmpty()) {
    activeProviders =
        List.of("openrouter", "gemini", "nvidia", "openai", "anthropic", "ollama", "lmstudio");
}
```

Replace with:

```java
List<String> activeProviders = providerConfigCache.getProvidersForTask("tl");
```

**Block 2 (OCR providers, ~lines 98-107):**

```java
List<String> activeOcrProviders = new java.util.ArrayList<>();
if (!disableLocalOcr) {
    activeOcrProviders.add("local");
}
List<String> cachedOcr = providerConfigCache.getProvidersForTask("ocr");
if (!cachedOcr.isEmpty()) {
    activeOcrProviders.addAll(cachedOcr);
} else {
    activeOcrProviders.addAll(List.of("openrouter", "gemini", "nvidia", "ollama", "lmstudio"));
}
```

Replace with:

```java
List<String> activeOcrProviders = new java.util.ArrayList<>();
if (!disableLocalOcr) {
    activeOcrProviders.add("local");
}
List<String> cachedOcr = providerConfigCache.getProvidersForTask("ocr");
activeOcrProviders.addAll(cachedOcr);
```

**Validate:** Start backend with no API keys configured. The frontend settings page should show no cloud providers (only "local" if OCR is enabled). Start with API keys configured — all normal providers appear.

### 1.2 Fix `(free)` duplication — fix the source data [PARALLEL]

**File:** `config/providers.json`

**Action:** For every model entry that has `"free": true`, check if its `name` field ends with `" (Free)"` or `" (free)"`. If it does, strip that suffix from the name.

Expected entries to fix (search for `"free": true`):

- `"Llama 3 8B (Free)"` → `"Llama 3 8B"`
- `"Gemini 2.5 Flash (Free)"` → `"Gemini 2.5 Flash"`
- `"GPT-OSS 20B (Free)"` → `"GPT-OSS 20B"`

**Validate:** After worker republishes to Redis, check the model list in frontend settings — free models show `"ModelName (Free)"` exactly once per entry.

### 1.3 Fix model dropdowns in series/chapter dialogs to filter by selected provider [PARALLEL]

**Files:**

- `frontend/src/components/EditSeriesDialog.tsx`
- `frontend/src/components/CreateSeriesDialog.tsx`

**Action:** Find every location where a model dropdown maps over a flat list like `settings?.tlLlmModelList`, `settings?.ocrVlmModelList`, `settings?.qaLlmModelList`, `settings?.qaVlmModelList`. Replace with a dynamic map that reads from `settings?.providerModelsMap?.[selectedProvider]?.[taskType]`.

Example for TL models:

```tsx
// BEFORE (CreateSeriesDialog.tsx ~line 473):
{(settings?.tlLlmModelList || []).map((m) => (...))}

// AFTER:
{(settings?.providerModelsMap?.[selectedTlProvider]?.tl || []).map((m) => (...))}
```

Where `selectedTlProvider` is the current value of the TL provider dropdown.

Do the same for OCR VLM, QA LLM, and QA VLM model dropdowns in both files.

The key mapping is:

| Task | Provider field | Task type key in `providerModelsMap` |
| ------ | --------------- | -------------------------------------- |
| TL | `tlProvider` | `tl` |
| OCR | `ocrProvider` | `ocr` |
| QA LLM | `qaProvider` | `qaLLM` |
| QA VLM | `qaProvider` | `qaVLM` |

**Validate:** Open Create Series dialog. Select "openrouter" as TL provider — only openrouter TL models appear. Switch to "gemini" — only gemini models appear. Repeat for Edit Series, Create Chapter, Edit Chapter dialogs.

### 1.4 Add clear/remove button for "Use Fallback Models" override [PARALLEL]

**Files:**

- `frontend/src/components/EditSeriesDialog.tsx`
- `frontend/src/components/CreateSeriesDialog.tsx`

**Action:** In every dialog that has a "Use Fallback Models" dropdown (`useFallbackModels` field), find the `FormControl` for it and add an `IconButton` with a clear/X icon next to it, visible only when the field has a non-null value (i.e., the user has overridden it).

Use the same pattern as the other override fields that already have clear buttons. Look for existing `<IconButton onClick={() => setValue("fieldName", null)}>` patterns in the same file and copy them.

The clear action should set `useFallbackModels` to `null` (which means "inherit from parent").

**Validate:** Set an override for "Use Fallback Models" in a series edit dialog. The X button appears. Click it — value resets to "inherit" and X disappears.

---

## Phase 2: Translation Free-Tier & Worker Override Correctness

### 2.1 Fix `translate_text` to accept provider/model overrides [SEQUENTIAL from this task — combined with 2.1b below]

**File:** `worker/src/worker/services/translation.py`

**Action:**

1. Add `provider` and `model` parameters to the `translate_text` function signature.
2. Use them instead of `TL_CONFIG.provider` and `TL_CONFIG.llm_model` when they are provided.
3. Propagate them from the caller in `worker/src/worker/handlers/translation.py`.

**Step A — Update function signature (~line 602):**

```python
def translate_text(
    text,
    source_lang,
    target_lang,
    request_id=None,
    use_fallback_models=False,
    provider=None,           # NEW
    model=None,              # NEW
):
```

**Step B — Replace hardcoded references (~lines 615-617, 687):**

```python
# BEFORE:
provider = TL_CONFIG.provider
api_key = TL_CONFIG.resolve_key()
# ...
user_model = TL_CONFIG.llm_model

# AFTER:
provider = provider or TL_CONFIG.provider
api_key = TL_CONFIG.resolve_key()
# ...
user_model = model or TL_CONFIG.llm_model
```

**Step C — Update the caller in `worker/src/worker/handlers/translation.py`:**
Find the call site where `translate_text` is invoked for individual fallback (the final retry loop for still-failed regions). Pass `job_data.get("tlProvider")` and `job_data.get("tlModel")`:

```python
translated = translate_text(
    text=text,
    source_lang=source_lang,
    target_lang=target_lang,
    request_id=request_id,
    use_fallback_models=use_fallback,
    provider=job_data.get("tlProvider"),    # NEW
    model=job_data.get("tlModel"),          # NEW
)
```

**Validate:** Set chapter TL provider to "openrouter" free model. Ensure `use_fallback_models` is false. Verify in logs that the free model is used for all translations including individual fallbacks, and no paid model is called.

### 2.1b Check QA worker for same bypass bug [SEQUENTIAL from completing 2.1]

**File:** `worker/src/worker/handlers/qa.py`

**Action:** Read the QA handler and check if any QA API calls use the global config (`QA_CONFIG.provider`, `QA_CONFIG.llm_model`, `QA_CONFIG.vlm_model`) instead of `job_data` overrides. If found, fix them following the same pattern as 2.1.

Also check `worker/src/worker/services/*.py` for any other service functions called by QA that might bypass overrides.

**Validate:** Set chapter-level QA provider/model overrides to free models. Confirm QA logs show the free models.

---

## Phase 3: S3 Key Consistency (Render ↔ QA)

### 3.1 Unify rendered image storage key [PARALLEL]

**File:** `worker/src/worker/handlers/render.py`

**Action:** In `render_image_core` (~line 580), always use `image_id` instead of preferring `page_id`:

```python
# BEFORE:
def render_image_core(image_id, page_id=None):
    try:
        render_target_id = page_id or image_id

# AFTER:
def render_image_core(image_id, page_id=None):
    try:
        render_target_id = image_id
```

Or alternatively, since QA always reads by `image_id`, just remove the `page_id` preference and always use `image_id`. Keep `page_id` parameter in the signature but don't use it for the storage path — remove it as a breaking change later.

**Validate:**

1. Trigger a render on a page.
2. Check MinIO/S3 — the rendered file is at `rendered/{image_id}.png`.
3. Trigger QA on the same page — no `NoSuchKey` error.

### 3.1b Cleanup: remove `page_id` path dependency from render [OPTIONAL] [PARALLEL]

**File:** `worker/src/worker/handlers/render.py`

**Action:** After 3.1 is verified, simplify `render_image_core` signature to remove `page_id` parameter entirely. Update the call site in `process_render` to stop passing `page_id`.

**Validate:** Same as 3.1.

---

## Phase 4: Chapter Transition & Page Numbering

### 4.1 Fix chapter transition flash [PARALLEL]

**File:** Check these files for the reader component:

- `frontend/src/components/Reader.tsx` (or wherever chapter pages are fetched)
- `frontend/src/App.tsx` (if reader state lives there)

**Action:** Find the `useEffect` or similar that fetches pages when `chapterId` changes. At the START of the effect (before the fetch call), set the pages state to `[]` AND set a `loading: true` flag. Then in the render logic, when `loading` is true and `pages` is empty, show a loading skeleton instead of empty white space.

**Important:** Don't just clear pages and render nothing — show a proper loading skeleton that matches the reader page dimensions so there's no layout jump.

Example skeleton: 1-2 gray placeholder rectangles matching the typical page aspect ratio, centered in the reader viewport.

**Validate:** Navigate between chapters. Old page content disappears immediately. A skeleton appears briefly. New chapter content loads in. No visual flash of wrong content.

### 4.2 Add backend bounds checking for page number on create [PARALLEL]

**File:** `backend/src/main/java/com/manga/library/controller/PageController.java` and/or `backend/src/main/java/com/manga/library/service/PageService.java`

**Action:** In the method that handles page creation (look for `createPageAndImage` or `createPage`), before saving:

1. Query existing pages for the chapter.
2. Find `maxExistingPageNumber`.
3. If `requestedPageNumber > maxExistingPageNumber + 1`, force it to `maxExistingPageNumber + 1`.
4. If `requestedPageNumber < 1`, force it to `1`.

```java
// Pseudocode:
int maxExisting = pageRepository.findMaxPageNumberByChapterId(chapterId);
int safePageNumber = Math.max(1, Math.min(requestedPageNumber, maxExisting + 1));
```

If `findMaxPageNumberByChapterId` doesn't exist, add it to the PageRepository.

**Validate:** Call the upload API with `pageNumber=999` for a chapter with only 3 pages. The page should be created at page number 4, not 999.

### 4.3 Fix "redirecting" message that doesn't redirect [PARALLEL]

**Task:** Search for where the redirecting message is shown:

- Search in frontend for the string `"redirecting"` (case-insensitive)
- Check the flow after chapter creation or page upload

**Action:** Find the code path that shows a "redirecting" message but doesn't actually navigate. The fix is likely:

- Adding the missing `navigate()` or `window.location.href = ...` call after the message is shown
- OR removing the misleading message if redirect isn't needed

**Validate:** After fix, the redirecting message either navigates correctly or doesn't appear at all.

---

## Phase 5: Logging & Operational Visibility

### 5.1 Add operational heartbeat logs [PARALLEL]

**Files:**

- `backend/src/main/java/com/manga/library/controller/JobController.java`
- New file: `backend/src/main/java/com/manga/library/config/HealthReporter.java`

**Action:**

**A. Add debug log to getJobs:**
In `JobController.java`, in the `getJobs()` method, add at the top:

```java
log.debug("Heartbeat ping received from client");
```

(If `log` field doesn't exist, add `private static final Logger log = LoggerFactory.getLogger(JobController.class);`)

**B. Create HealthReporter scheduled task:**
Create `backend/src/main/java/com/manga/library/config/HealthReporter.java`:

```java
@Configuration
@EnableScheduling
public class HealthReporter {
    private static final Logger log = LoggerFactory.getLogger(HealthReporter.class);
    
    @Autowired private JobRepository jobRepository;
    @Autowired private StringRedisTemplate redisTemplate;
    
    @Scheduled(fixedRate = 300_000) // every 5 minutes
    public void reportHealth() {
        long pending = jobRepository.countByStatus("PENDING");
        long processing = jobRepository.countByStatus("PROCESSING");
        long failed = jobRepository.countByStatus("FAILED");
        try {
            String ping = redisTemplate.opsForValue().get("health:ping");
            log.info("Health: queue[pending={}, processing={}, failed={}] redis={}", 
                pending, processing, failed, ping != null ? "OK" : "DOWN");
        } catch (Exception e) {
            log.warn("Health: queue[pending={}, processing={}, failed={}] redis=DOWN", 
                pending, processing, failed);
        }
    }
}
```

**C. Enable Spring Boot access logging:**
In `backend/src/main/resources/application.properties` or `application.yml`, add:

```properties
server.tomcat.accesslog.enabled=true
server.tomcat.accesslog.pattern=%h %l %u %t "%r" %s %b %Dms
```

**Validate:** Check backend logs after 5 minutes — should see `Health: queue[...] redis=OK` lines. Every HTTP request appears in access logs.

### 5.2 Add cache key logging for translation and QA [PARALLEL]

**Files:**

- `worker/src/worker/services/translation.py` (find where cache keys are generated/used)
- `worker/src/worker/handlers/qa.py` (find where cache keys are generated/used)

**Action:** Search for `cache` or `cache_key` in these files. At each cache lookup/save point, add:

```python
logger.info(f"Cache key: {cache_key} (hit={bool(cached)})")
```

If the cache key includes the model name, this also verifies that different models produce different cache keys (confirming no accidental sharing) and that same models produce the same keys (confirming reuse).

**Validate:** Run a translation. Check worker logs — cache key is printed. Run QA on the same content with the same model — the cache key should match (if using same model for both TL and QA).

---

## Phase 6: Settings Configuration Integrity

### 6.1 Implement deprecation-aware settings resolution [SEQUENTIAL — depends on understanding current resolution]

**Files:**

- `backend/src/main/java/com/manga/library/service/JobCoordinatorService.java`
- `backend/src/main/java/com/manga/library/service/SystemSettingsService.java`

**Action:** In `resolveModel` and similar resolution methods in `JobCoordinatorService.java` (~line 380), after resolving a value:

1. Check if the resolved provider/model exists in the current `providerConfigCache`.
2. If NOT found and the value is not a global default:
   - Log a warning: `"Resolved model '{}' for chapter '{}' is no longer available — falling back to global default"`
   - Fall back to the global default value
   - Optionally: store the deprecation notice in Redis so the frontend can show it

**Add a warnings endpoint (optional but recommended):**
In `JobCoordinatorService.java` when building the job payload, add a `warnings` list to the response. If an override was deprecated, include: `"TL model 'X' is deprecated, using global default 'Y'"`. The frontend can display these in a dismissable alert.

**Validate:**

1. Set a series to use a model that exists in `providers.json`.
2. Remove that model from `providers.json` and republish config.
3. Run a translation for that series — it should fall back to global default with a warning log.
4. The frontend should show a deprecation notification (if you added the warnings endpoint).

### 6.2 Add `/api/settings/validate` endpoint for override health check [PARALLEL]

**File:** `backend/src/main/java/com/manga/library/controller/SettingsController.java`

**Action:** Add a new GET endpoint `@GetMapping("/validate")` that:

1. Queries all series and chapters with non-default overrides.
2. Cross-references against `providerConfigCache`.
3. Returns a list of "orphaned" overrides — series/chapters whose selected model/provider no longer exists.

**Validation output format:**

```json
{
  "orphaned": [
    {
      "entityType": "SERIES",
      "entityId": "uuid",
      "entityName": "Series Name",
      "field": "tlModel",
      "value": "old-model-id",
      "status": "DEPRECATED"
    }
  ]
}
```

**Validate:** Artificially deprecate a model. Call `/api/settings/validate`. Response lists the affected series/chapter.

---

## Phase 7: OCR Quality & Non-JP Support

### 7.1 Investigate OCR model selection for non-JP languages [PARALLEL]

**Files to check:**

- `worker/src/worker/handlers/ocr.py` or similar
- `worker/src/worker/services/ocr.py` or similar

**Action:**

1. Find where the OCR model is resolved for a job. Check if there's any language-based model selection.
2. Check if the job payload passes the chapter's primary language.
3. Look at `providers.json` for OCR models — are there better models available for Korean, Chinese, etc.?

**Expected findings and fix:**

- If the same OCR model is used for all languages, add a language-to-model mapping in `providers.json` or in the worker.
- If no good non-JP OCR model exists in `providers.json`, add one (e.g., from openrouter or a free provider) that handles Korean/Chinese.
- Add a section to `providers.json` like:

```json
{
  "ocr-model-preference": {
    "ja": "qwen/qwen3-vl-32b-instruct",
    "ko": "google/gemini-2.5-flash",
    "zh": "qwen/qwen3-vl-32b-instruct"
  }
}
```

**Validate:** Upload a Korean test image. OCR output should be readable (not garbage). Compare before/after quality.

---

## Phase 8: UI/UX Improvements

### 8.1 Fix dark theme color scheme [PARALLEL]

**File:** Create or update the MUI theme file:

- Check `frontend/src/theme.ts` or `frontend/src/App.tsx` for `createTheme` call.
- If no theme file exists, create `frontend/src/theme.ts`.

**Action:** Define a proper dark theme palette:

```typescript
const darkTheme = createTheme({
  palette: {
    mode: "dark",
    background: {
      default: "#0f0f0f",
      paper: "#1a1a1a",
    },
    // ...
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          // Use contained buttons instead of outlined for primary actions
        },
      },
    },
  },
});
```

**Specific fixes to apply:**

- Background: `#0f0f0f` instead of pure black `#000000`
- Card/surface backgrounds: `#1a1a1a` or `#1e1e1e` using `<Paper>` components instead of plain divs
- Red accents: use MUI's `error` palette tokens instead of hardcoded red hex values — they're designed for dark mode contrast
- Outlined buttons: replace primary action buttons with `variant="contained"`
- Add proper elevation (`elevation={1}` or `elevation={2}`) to cards and panels

**Validate:** Navigate through all pages in dark mode. Compare visually to reference apps (yt-diff screenshots). No jarring pure-black backgrounds. Buttons have proper contrast and fill.

### 8.2 Fix Queue Manager table layout [PARALLEL]

**File:** Find the Queue Manager component — likely `frontend/src/components/QueueManager.tsx` or similar.

**Action:**

1. Add `tableLayout: "fixed"` to the `<Table>` component's sx prop.
2. Set explicit percentage-based `width` on each `<TableCell>` or use `<colgroup>` with fixed widths.
3. Add `whiteSpace: "nowrap"`, `overflow: "hidden"`, `textOverflow: "ellipsis"` to cells that might overflow.

**Validate:** Add a job with a very long name. Table columns don't resize. Content truncates with ellipsis.

---

## Phase 9: Bug Bounty — Proactive Investigation

These are the areas the user flagged as "I sense bugs in." Each needs exploratory testing, not a specific code fix yet.

### 9.1 Post-manual-edit re-render [PARALLEL]

**Action:**

1. Open a chapter with rendered pages.
2. Edit text in the manual edit panel.
3. Click "Re-render" or save.
4. Observe: does the re-render use the new text or the old text?
5. Check if the render worker receives the updated text vs the original OCR text.

**Expected bug:** Re-render might use the original OCR text instead of the edited text. If confirmed, check the render job payload — it must include the manually edited text, not the raw OCR output.

### 9.2 Context injection [PARALLEL]

**Action:**

1. Enable context injection (series description, character names, etc.).
2. Run a translation.
3. Check if the injected context actually appears in the prompt sent to the LLM (check worker logs).
4. Verify context is injected for both batch and individual translations.

**Expected bug:** Context might only be injected for batch translation but not individual fallback (`translate_text`). This is the same pattern as issue #10.

### 9.3 Provider/model inheritance edge cases [PARALLEL]

**Action:**

1. Set series-level overrides, then set conflicting chapter-level overrides.
2. Verify chapter overrides win.
3. Set a chapter override, then set the chapter to "inherit"/"default".
4. Verify it falls back to series, then global.
5. Check `[ORPHANED]` handling — what happens when a model is removed from providers.json mid-job?

### 9.4 Fallback handling [PARALLEL]

**Action:**

1. Configure a series to use a non-existent/failing provider.
2. Enable "Use Fallback Models."
3. Trigger a translation job.
4. Verify the fallback is actually used and logged.
5. Check if ALL code paths respect fallback (batch TL, individual TL, QA, OCR).

### 9.5 Uploader reliability [PARALLEL]

**Action:**

1. Upload multiple images simultaneously.
2. Upload images while a chapter is being translated.
3. Upload images with very long filenames, special characters, or large file sizes.
4. Check for duplicate page numbers, missing pages, or corruption.

---

## Phase 10: Post-Fix Validation

### 10.1 Run detect_changes and verify impact [AFTER ALL FIXES APPLIED]

**Action:**

```bash
node .gitnexus/run.cjs analyze
```

Then run `detect_changes` and review that only expected symbols and processes are changed.

### 10.2 E2E smoke test [AFTER ALL FIXES APPLIED]

Run through this manual checklist:

1. Fresh deploy (no `.env`, empty DB) → settings page shows empty providers
2. Add API keys → providers appear
3. Create series with custom TL provider/model → model dropdown shows only that provider's models
4. Translate chapter → free model is used, no paid model appears in logs
5. Change chapter in reader → no flash of old content
6. Upload image to chapter → page number is sequential (1, 2, 3...)
7. Render a page → QA succeeds without NoSuchKey
8. Dark mode → no jarring colors, tables don't resize
9. Check logs → heartbeat lines every 5 min, cache keys printed during TL/QA
10. Navigate to `/api/settings/validate` → returns orphaned overrides if any

---

## Task Dependency Graph (for executing out of order)

```txt
Phase 0  (0.1 → 0.2)          ← start here
         ↓
Phase 1  (all 4 tasks parallel)
         ↓
Phase 2  (2.1 → 2.1b)        ← sequential within
         ↓
Phase 3  (all parallel)
         ↓
Phase 4  (all parallel)
         ↓
Phase 5  (all parallel)
         ↓
Phase 6  (6.1 → 6.2)
         ↓
Phase 7  (single task)
         ↓
Phase 8  (all parallel)
         ↓
Phase 9  (all parallel, investigation only)
         ↓
Phase 10 (after everything else)
```
