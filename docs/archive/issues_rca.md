# Root Cause Analysis (RCA) & Proposed Fixes

Below are the Root Cause Analyses and the planned fixes for the issues outlined in `docs/issues-found.md`.

## Frontend & UI State Issues

### 1. The UI doesn't show only the providers we have API keys for

**RCA**: In the backend (`SystemSettingsService.java`), when the system checks for configured API keys and finds an empty list, it uses a fallback logic (`if (activeProviders.isEmpty())`). This fallback intentionally populates the list with all hardcoded providers instead of returning an empty list, causing the frontend to render all providers regardless of whether keys are configured.
**Proposed Fix**: Remove the fallback block in `SystemSettingsService.java`. If `activeProviders` is empty, simply return an empty list so the frontend accurately reflects the lack of configured API keys.

### 2. The System Settings was empty on first load (default population not working)

**RCA**: In `docker-compose.yml`, environment variables are mounted directly without Docker fallback values. When the `.env` file is missing or incomplete, Docker passes empty strings. In Spring Boot, `@Value("${OCR_MODEL_PROVIDER:openrouter}")` detects the presence of the variable (even though it's empty) and evaluates to an empty string `""`, completely overwriting Spring's intended defaults on the first load.
**Proposed Fix**:

1. In `docker-compose.yml`, use bash parameter expansion for fallbacks (e.g., `- OCR_MODEL_PROVIDER=${OCR_MODEL_PROVIDER:-openrouter}`).
2. In Spring Boot, check if the injected string is `.isBlank()` and forcefully override it to the default value if necessary.

### 3. The free models have (free)(free) on them twice

**RCA**: The OpenRouter API payload already includes `"(free)"` in the model's name string (e.g., `"Google: Gemini 2.5 Flash (free)"`). In `SettingsModal.tsx`, the frontend maps over the models and forcefully appends `" (Free)"` again if the model's boolean `free` flag is true, resulting in the duplication.
**Proposed Fix**: Update `SettingsModal.tsx` to conditionally append `" (Free)"` only if the model's name string does not already contain `(free)` (using a case-insensitive check).

### 4. Mapping not working in chapter and series pages

**RCA**: In dialogs like `EditSeriesDialog.tsx` and `CreateSeriesDialog.tsx`, the model dropdown components are hardcoded to map over the static fallback list (e.g., `settings?.tlLlmModelList`). Unlike the global `SettingsModal.tsx`, they do not dynamically map over the context-aware list of models belonging to the currently selected provider.
**Proposed Fix**: Update the dropdown mapping logic in the series and chapter dialogs to derive available models dynamically from `settings?.providerModelsMap?.[selectedProvider]?.[task]`, mirroring the logic used in `SettingsModal.tsx`.

### 5. Only for the "use fall back models", the X doesn't show up when overridden

**RCA**: In the frontend dialogs (e.g., `EditSeriesDialog.tsx`), the state for fallback models is initialized as a boolean. Unlike the text-based model overrides which have a conditional `<IconButton>` to clear the value to `""`, the developer entirely omitted the clear `<IconButton>` JSX block for the "Use Fallback Models" dropdown.
**Proposed Fix**: Add an `<IconButton>` with a clear icon to the `Use Fallback Models` `<FormControl>` inside the frontend dialogs, configured to reset the form value back to `null` (inherited state) when clicked.

### 6. Changing page number in reader view gives "Failed to update page number"

**RCA**: Updating a page number in the reader makes a `PATCH /api/pages/${pageId}/number` request. However, in the backend's `SecurityConfig.java`, the CORS configuration explicitly allows `GET`, `POST`, `PUT`, `DELETE`, and `OPTIONS`, completely omitting `PATCH`. The request is immediately rejected due to CORS.
**Proposed Fix**: Update `SecurityConfig.java` to include `"PATCH"` in the `allowedMethods` array of the CORS configuration.

### 7. When changing chapters, we can briefly see the previous chapter's content

**RCA**: In `App.tsx` or `Reader.tsx`, the `useEffect` that listens for `chapterId` changes sets a loading boolean but fails to clear the existing `pages` array (e.g., `setPages([])`). The component continuously renders with the stale `pages` array until the new chapter's pages finish fetching.
**Proposed Fix**: Immediately call `setPages([])` (and reset loaded image IDs) when the `chapterId` changes in the dependency array, ensuring the view clears out before the new data arrives.

---

## Backend, Storage & Worker Issues

### 8. Somehow a chapter with only one image got added as page 21

**RCA**: This is a direct side-effect of Issue #7. Because the frontend `pages` array is not cleared immediately when changing chapters, a user navigating to a brand new chapter momentarily retains the previous chapter's 20 pages in local state. If they immediately click "Upload", the frontend calculates `nextNum = pages.length + 1` (which equals 21) and sends `pageNumber=21` to the backend. The backend's `PageController` blindly accepts this out-of-bounds page number during creation.
**Proposed Fix**:

1. Fixing Issue #7 will naturally prevent the frontend from sending out-of-bounds page numbers.
2. Defensively update the backend's `createPageAndImage` logic to enforce bounds checking (similar to `updatePageNumber`), coercing any requested page number strictly to `max_existing + 1` if it exceeds the valid sequence limit.

### 9. S3 operation failed; code: NoSuchKey (rendered image missing)

**RCA**: The render worker (`render.py`) saves the rendered typeset image using `render_target_id = page_id or image_id`. When triggered manually (e.g., via "Retry Render" on a page), it saves to `rendered/{pageId}.png`. However, the QA worker (`qa.py`) explicitly hardcodes the S3 fetch path to `rendered/{image_id}.png`. Because the render was saved under the page ID but QA looks for the image ID, S3 throws a `NoSuchKey` error.
**Proposed Fix**: Unify the file naming convention. Update `render.py` to strictly save output using `image_id` (since physical artifacts tie closer to the image entity), or alternatively pass both IDs contextually and update `qa.py` to attempt fetching from `pageId` first, falling back to `imageId`.

### 10. Strictly free tl doesn't seem to be free (DeepSeek called instead of Neuromatic)

**RCA**: In the translation worker (`translation.py`), if batch translation fails, it falls back to an individual region translation mechanism (`translate_text`). However, this fallback logic hardcodes the provider lookup to the global environment variables (`TL_CONFIG.provider` and `TL_CONFIG.llm_model`), completely ignoring the chapter-level overrides (`tlProvider`, `tlModel`) passed in the `job_data`. This bypasses the "Neuromatic" override and inadvertently queries the global paid model.
**Proposed Fix**: Update `worker/src/worker/services/translation.py`'s `translate_text` function to accept `provider` and `model` as override parameters. Pass these down from the `job_data` in the main handler loop so the individual fallback respects chapter-level preferences.

### 11. Multiple sources of truth and precedence

**RCA**: Precedence is resolved purely in the backend (`JobCoordinatorService.java`) with strict hierarchy: `Chapter > Series > Global settings`. The `providers.json` is not part of this hierarchy in the backend; instead, it is parsed by the worker to validate active models and published to Redis to populate the UI dropdowns. The backend blindly resolves the string overrides while the worker enforces whether the models actually exist.
**Proposed Fix**: Inject a validation step in `JobCoordinatorService.java` that queries the cached `providers.json` map from Redis. If the resolved hierarchical string override does not exist in the valid models list (e.g., it was deprecated), throw an error or automatically gracefully fallback to the global default.

### 12. The backend doesn't have any heartbeat logs it's almost silent

**RCA**: The frontend implements a heartbeat by polling `GET /api/jobs` every 30-60 seconds. However, in `JobController.java`, the `getJobs()` method does not contain any logging statements. Additionally, Spring Boot's HTTP access logging is disabled by default. Therefore, the polling happens completely silently.
**Proposed Fix**: Add a `log.debug("Heartbeat ping received from client");` inside the `JobController.getJobs()` endpoint and adjust the logging profile so trace/debug operations are visible without overwhelming production logs.

---

## UI / UX Enhancements

### 13. The dark colour scheme sucks (Inspired by yt-diff)

**RCA**: The application uses pure jarring colors (e.g., pure black `#000000` or aggressive reds) on AMOLED dark displays, and tables resize unpredictably based on content load.
**Proposed Fix**:

- Transition to a softer dark theme hierarchy (e.g., `#0f0f0f` for app backgrounds, and `#272727` for elevated surface cards) as seen in modern apps like YouTube.
- Implement Material-UI `<Paper>` components for elevation and swap outlined buttons to `variant="contained"` for better visual grounding.
- Set `table-layout: fixed` and define explicit percentage column widths on the Queue Manager table so its dimensions remain static regardless of text overflow.
