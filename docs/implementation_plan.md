# Fix All Issues from Issues.md — Phased Plan

Based on thorough analysis of screenshots, source code, export JSONs, worker logs, and user feedback.

---

## Phase 1 — Critical Backend Fix (Series Overrides)

> **Goal:** Fix the #1 data-loss bug — series creation silently drops all override fields.

### Issue 1: Creating a Series with Overrides Doesn't Preserve Them

**Root Cause:** In [SeriesController.java:189-197](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/controller/SeriesController.java#L189-L197), the `createSeries` builder omits all 9 override fields. Chapters work fine because their builder includes them at [line 243-258](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/controller/SeriesController.java#L243-L258).

#### [MODIFY] [SeriesController.java](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/controller/SeriesController.java)

Add all 9 override fields to the `createSeries` builder:
```diff
 Series series =
     Series.builder()
         .title(dto.getTitle())
         .originalLanguage(sourceLang != null ? sourceLang : "ja")
         .sourceLanguage(sourceLang != null ? sourceLang : "ja")
         .targetLanguage(targetLang)
         .readingDirection(dto.getReadingDirection())
+        .ocrProvider(dto.getOcrProvider())
+        .ocrModel(dto.getOcrModel())
+        .tlProvider(dto.getTlProvider())
+        .tlModel(dto.getTlModel())
+        .qaProvider(dto.getQaProvider())
+        .qaLlmModel(dto.getQaLlmModel())
+        .qaVlmModel(dto.getQaVlmModel())
+        .qaMode(dto.getQaMode())
+        .routingStrategy(dto.getRoutingStrategy())
         .createdBy(user)
         .build();
```

#### Audit Existing Tests

> [!IMPORTANT]
> The existing tests should have caught this obvious bug. Audit the `SeriesController` test class to understand why they didn't, and add/fix test coverage:
> - Verify that `createSeries` tests assert override fields are persisted in the saved entity
> - If no such test exists, add one that creates a series with overrides and verifies they round-trip through the API

### Verification
- Create a series with 6+ overrides → reload page → verify overrides are persisted
- Edit the series → verify overrides appear pre-populated
- Run `./mvnw test` — ensure new/fixed tests catch the override bug
- Verify tests would have **failed** before the fix

---

## Phase 2 — Worker: `useFallbackModels` + Logging + Model Fixes

> **Goal:** Add the `useFallbackModels` toggle and fix the worker errors from logs.

### Issue 2a: `useFallbackModels` Boolean (Per-Series / Per-Chapter)

**Semantics (confirmed by user):** When `useFallbackModels = false`, the worker should **only use the requested model**. If that model fails, **fail the job** — do NOT cascade to global default model, local LLM, DeepL, or Google Translate. This maps to the concept of `"allow_fallbacks": false` in OpenRouter's provider routing, but at the **application level** across all handlers (OCR, Translation, QA).

The current fallback cascade in the worker is:
1. Try user-specified model
2. Try global default model (if different from user model)
3. Try local LLM fallback
4. Try DeepL / Google Translate

With `useFallbackModels = false`: **Only step 1 runs.** Steps 2-4 are skipped entirely.

#### Backend Changes

##### [MODIFY] Database schema [init.sql](file:///home/sagnik/Projects/docker-composes/manga-library/database/init.sql)
Add `use_fallback_models BOOLEAN` column to `series` and `chapters` tables.

##### [MODIFY] [Series.java](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/model/Series.java)
Add `useFallbackModels` Boolean field (nullable → `null` means inherit from global).

##### [MODIFY] [Chapter.java](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/model/Chapter.java)
Add `useFallbackModels` Boolean field.

##### [MODIFY] [SeriesDto.java](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/dto/SeriesDto.java)
Add `useFallbackModels` field.

##### [MODIFY] [ChapterDto.java](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/dto/ChapterDto.java)
Add `useFallbackModels` field.

##### [MODIFY] [SeriesController.java](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/controller/SeriesController.java)
- Add `useFallbackModels` to series and chapter builders
- Pass `useFallbackModels` through `populateChapterDto` for the resolved config
- Include `useFallbackModels` in the job data sent to worker queue

#### Worker Changes

##### [MODIFY] [translation.py (handler)](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/handlers/translation.py)
Read `job_data.get("useFallbackModels", True)`. When `False`:
- Skip the "Fallback to global default model" block at [line 1060-1073](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/translation.py#L1060-L1073)
- Skip the individual fallback pass at [line 237-266](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/handlers/translation.py#L237-L266)

##### [MODIFY] [translation.py (service)](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/translation.py)
- `translate_batch_llm()` and `translate_text()` accept a `use_fallback` parameter
- When `False`, skip the global fallback model attempt

##### [MODIFY] [ocr.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/handlers/ocr.py)
Read `job_data.get("useFallbackModels", True)`. When `False`:
- Skip the global fallback VLM model block at [line 728-764](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/handlers/ocr.py#L728-L764)

##### [MODIFY] [qa.py](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/handlers/qa.py)
Same pattern — skip global model fallback when `useFallbackModels = false`.

#### Frontend Changes

##### [MODIFY] [CreateSeriesDialog.tsx](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/CreateSeriesDialog.tsx)
Add a `useFallbackModels` toggle (default: `true` / inherit) inside the Overrides accordion.

##### [MODIFY] [EditSeriesDialog.tsx](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/EditSeriesDialog.tsx)
Same toggle.

##### [MODIFY] [CreateChapterDialog.tsx](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/CreateChapterDialog.tsx)
Same toggle.

---

### Issue 2b: Enhanced Worker Logging for Routing

**User ask:** "I want to see in the logs which strategy we are using and the provider order."

Currently [_inject_openrouter_routing](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/translation.py#L314-L323) silently injects the provider block with no logging.

##### [MODIFY] [translation.py (service)](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/translation.py)
Add logging to `_inject_openrouter_routing` (**OpenRouter only** — this function already gates on `provider == "openrouter"`):
```python
def _inject_openrouter_routing(provider, routing_strategy, payload):
    if provider == "openrouter":
        if routing_strategy == "lowest-cost":
            provider_block = {
                "allow_fallbacks": False,
                "sort": "price",
                "order": ["StreamLake", "NovitaAI", "Baidu Qianfan", "Decart"],
            }
            payload["provider"] = provider_block
            logger.info(f"Routing: strategy=lowest-cost provider_order={provider_block['order']} allow_fallbacks=False")
        elif routing_strategy == "highest-throughput":
            payload["provider"] = {"allow_fallbacks": True, "sort": "throughput"}
            logger.info(f"Routing: strategy=highest-throughput allow_fallbacks=True")
```

> [!NOTE]
> This logging is inherently OpenRouter-only since the function is gated by `if provider == "openrouter"`. No other providers are affected.

---

### Issue 2c: Fix `deepseek/deepseek-v4-pro` Error

**User asked:** "What does 'Provider returned error: response_format type is unavailable' mean?"

**Explanation:** The `lowest-cost` routing strategy sends requests to budget providers like **StreamLake**. StreamLake is a Chinese inference provider that doesn't support OpenAI's `response_format: { type: "json_schema" }` parameter. When the worker sends a request with `json_schema` format, StreamLake returns a 400 error: "This response_format type is unavailable now."

**Fix — Graceful degradation:** First try `json_schema` (best parsing). If the provider returns a **400**, catch it and **retry with `json_object`** instead. This consumes one of the 3 retry attempts, which is acceptable since the second attempt should succeed on the same provider with the simpler format.

##### [MODIFY] [translation.py (service)](file:///home/sagnik/Projects/docker-composes/manga-library/unified-workers/worker/services/translation.py)
In `try_cloud_ai()` retry loop:
- On 400 response, check if `response_format` is `json_schema`
- If so, log a warning, downgrade `response_format` to `{"type": "json_object"}`, and continue to next retry attempt
- This costs one retry but ensures compatibility with budget providers like StreamLake

---

### Issue 2d: Fix Stale Model Slug

`openai/gpt-oss-120b:free` was removed from OpenRouter.

##### [MODIFY] Worker config / `.env` / system settings
Replace `openai/gpt-oss-120b:free` → `openai/gpt-oss-20b:free` wherever it appears in default model lists or fallback configs.

> [!NOTE]
> The following models are confirmed still available — **no changes needed**:
> - `google/gemma-4-26b-a4b-it:free` ✅
> - `deepseek/deepseek-v4-flash` ✅

### Verification (Phase 2)
- Create a series with `useFallbackModels = false`, run OCR → verify job fails cleanly if model is unavailable (no fallback cascade)
- Create a series with `useFallbackModels = true` (default) → verify fallback behavior works as before
- Check worker logs for routing strategy info on every request
- Verify `deepseek/deepseek-v4-pro` no longer errors with lowest-cost routing (uses `json_object` format)
- Run worker tests: `cd unified-workers && python -m pytest`

---

## Phase 3 — Frontend UX Improvements

> **Goal:** Fix visual issues — color picker, chapter buttons, provider display.

### Issue 3a: Color Selector — More Colors

Currently only 7 presets in [ColorPicker.tsx:253-263](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/ColorPicker.tsx#L253-L263).

#### [MODIFY] [ColorPicker.tsx](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/ColorPicker.tsx)

1. **Expand presets to 8 colors** (from current 7): keep Transparent, White, Black, Red, Blue, Green, Yellow + add **Orange** (#f97316). Optionally swap one for a more useful color like Pink or Purple if it feels better.

2. **Fix transparency**: When transparent preset is clicked, `onChange(null)` is called. Ensure the SV/Hue/Alpha pickers reset correctly and the badge shows the checkerboard pattern cleanly.

---

### Issue 3b: Chapter Card — Too Many Buttons

Current: 6 buttons in [ChapterHeader.tsx:156-175](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/ChapterHeader.tsx#L156-L175).

#### [MODIFY] [ChapterHeader.tsx](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/ChapterHeader.tsx)

**Split Button** for Export:
- Primary action: "Export Chapter (ZIP)" — uses cached export if available
- Dropdown arrow: "Force Re-export" option

**Overflow Menu** (⋮ icon):
- "Clear Exports" → moved here from the main action row

**Result:** 4 main buttons + 1 overflow menu:
1. Upload Page (primary)
2. Import Project (ZIP) (outlined)
3. Export Chapter ▾ (split button, outlined)
4. Delete Chapter (outlined, error)
5. ⋮ overflow → Clear Exports

---

### Issue 3c: Show Provider & Routing Info in UI

#### [MODIFY] [SeriesHeader.tsx](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/SeriesHeader.tsx)
Add resolved provider chip and routing strategy chip to the "Configured Models" section.

#### [MODIFY] [ChapterHeader.tsx](file:///home/sagnik/Projects/docker-composes/manga-library/frontend/src/components/ChapterHeader.tsx)
Add resolved provider chip and routing strategy chip to the "Configured Models" section.

> [!NOTE]
> Per user feedback: "My concern is that the page will get too crowded, but lets do it for now we can always just remove a few or hide it from UI."
>
> We'll add these as additional chips and review the density after.
>
> Per user feedback: performance should not be impacted — these are already-resolved values from the DTO, no extra API calls needed.

#### Backend — Add provider/routing to resolved slots

##### [MODIFY] [ChapterDto.java](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/dto/ChapterDto.java)
Add `provider` field to `ResolvedModelSlot` and `routingStrategy` to `ResolvedQaSlot`.

##### [MODIFY] [SeriesController.java](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/controller/SeriesController.java)
Include provider + routing strategy in the `populateChapterDto` resolved slots.

### Verification (Phase 3)
- Color picker shows 16+ presets, transparency works cleanly
- Chapter card has 4 buttons + overflow menu
- Series/Chapter headers show provider + routing strategy chips
- `npm test` passes in frontend

---

## Phase 4 — Backend Hardening & Export Improvements

> **Goal:** Fix log noise and export robustness.

### Issue 4a: MinIO Export Download — Stale Key Error

The `downloadExport` endpoint at [SeriesController.java:634-654](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/controller/SeriesController.java#L634-L654) throws when the ZIP has been cleaned up.

#### [MODIFY] [SeriesController.java](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/controller/SeriesController.java)
Add pre-download existence check → return HTTP 410 Gone with message "Export expired, please re-export to download."

---

### Issue 4b: SSE Log Noise

#### [MODIFY] [SseService.java](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/service/SseService.java)
Downgrade "Failed to send live event to user, removing emitter" from `ERROR` to `WARN`.

---

### Issue 4c: Export Metadata Enhancements

#### [MODIFY] [ChapterExportService.java](file:///home/sagnik/Projects/docker-composes/manga-library/backend/src/main/java/com/manga/library/service/ChapterExportService.java)
Add to chapter-level metadata in `meta-data.json`:
- `routingStrategy`
- `useFallbackModels`

> [!NOTE]
> `resolvedProviders` (e.g., `["StreamLake", "NovitaAI"]`) dropped — too much info with no real use in the export context.
>
> No changes to `project.json` or its importer — routing/provider details don't belong there.

### Verification (Phase 4)
- Download an expired export → get clean 410 instead of stack trace
- Trigger SSE disconnect → verify WARN level in logs
- Export chapter → verify `meta-data.json` includes `routingStrategy` and `useFallbackModels`
- Run `./mvnw test`

---

## Deferred — Issue 7: Bubbles Keep Overlapping Each Other

Flagged as TODO per user. This is a rendering/layout engine issue in the text typesetting pipeline. Not addressed in this plan.

---

## Execution Order

| Phase | Scope | Est. Files Changed | Risk |
|-------|-------|--------------------|------|
| **Phase 1** | Backend fix (1 file) | 1 | 🟢 Low |
| **Phase 2** | Worker + Backend + Frontend | ~12 | 🟡 Medium |
| **Phase 3** | Frontend + Backend DTO | ~5 | 🟢 Low |
| **Phase 4** | Backend hardening | ~4 | 🟢 Low |

Each phase is independently testable and deployable.
