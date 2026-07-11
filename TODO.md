# TODO — Manga Library

> Last reviewed: 2026-07-10 | All completed items archived below.

## 🟡 High Priority Features

### Current bugs and issues

- [ ] Export chapter as zip, currently is broken
  - [ ] `GET https://ideapad.tail9ece4.ts.net/tlhub/api/series/chapters/82e81d7c-d5fd-4f8b-9bd7-e6441a7c338f/export?format=zip` returns 500 with
    ```RXJyb3IgZHVyaW5nIGV4cG9ydDogY291bGQgbm90IGluaXRpYWxpemUgcHJveHkgW2NvbS5tYW5nYS5saWJyYXJ5Lm1vZGVsLkltYWdlIzQ4ZDQ5ODAxLWM0ZjgtNDAwYy04MzI3LWQ2MDY2MjZmYWRhZl0gLSBubyBTZXNzaW9u``` as response body.
- [ ] In the exports the local OCR layers have model as `"model": "MangaOCR/PaddleOCR(PP-OCRv6_medium_rec)",` when it should be `"model": "PaddleOCR(PP-OCRv6_medium_rec)",` also I wonder if we should include the rest of the models like (we have a list)
- [ ] I have found another issue, say an image is added to one chapter, while being in another and then deleted from the **other** chapter because of the bug on line 19 it get's delete from **this** chapter too, and then if you try to add it again this upload fails because of the following error
  - [ ] ```manga-backend    | Caused by: org.postgresql.util.PSQLException: ERROR: duplicate key value violates unique constraint "pages_chapter_id_page_number_key"
manga-backend    |   Detail: Key (chapter_id, page_number)=(8bc70d04-8a67-4864-8527-c24196848074, 2) already exists.```
  - [ ] Check out [logs](./logs/run-7.log) and look for `8bc70d04-8a67-4864-8527-c24196848074`
- [ ] Related to this If an image belongs to to different chapters (with different over-rider it, will only follow the overrides of one chapter, testing shows that it's the one which it was in earlier but not 100% sure) also for same uuid
  - [ ] Case in point in one chapter the ocr was supposed to be local and in another using cloud but when I re-ran the ocr for cloud one it ran the local ocr flow, ie using the over-rides of the original chapter it was added to, not the one I was running it for (with cloud overrides)
- [ ] Lastly also an issue with `8bc70d04-8a67-4864-8527-c24196848074` this was added to two chapters but when I deleted it from one it got deleted from both
- [ ] The auto update the reader to load new layers as they come in is broken, since we are going to overhaul the `SSE` anyway maybe use it get the layers when triggering a manual re-ocr, manual re-tl and manual region-redo-ocr and manual region-redo-tl
  - [ ] These events are to be broadcasted anyway but if the reader is open we can use them to check for new layers if the page id matches and update the layers, instead of polling and using some react use call back mumbo jumbo.
- [ ] I accidenally dropped in a md file instead of an image the upload didn't fail, it even created a page for it, even the pipeline ran and found 0 layers
  - [ ] Checkout `https://ideapad.tail9ece4.ts.net/tlhub/chapters/ac273b52-ffa0-4af4-8ced-88fd4767b37e/hsr/reader/5` this is an md file
  - [ ] Need to add stricter validations on uploads.
- [ ] Opening the rerader or going up to the series page dismisses the upload widget the upload still happen just are not shown.
- [ ] For larger upload say 100+ images the lag is very noticeable need to optimize the upload process
- [ ] For layer update I observed a failure need to check if it's reproducible or just one off error.
- [ ] Observeing these in workers logs as well check [run logs 8](./logs/run-8.log)
  - [ ] ```manga-worker     | 2026-07-11 13:22:44,228 [INFO] Attempting to acquire Valkey lock: ocr
          manga-worker     | [OCR] Running PaddleOCR (PP-OCRv6_medium_det/PP-OCRv6_medium_rec, lang=ja).
          manga-worker     | [OCR] Memory before OCR: 1798.5 MB
          manga-worker     | 2026-07-11 13:22:44,229 [INFO] Acquired Valkey lock: ocr
          manga-worker     | [OCR] Downscaled image for OCR (upscale factor: 1.88x)
          manga-worker     | [OCR] Calling PaddleOCR...
          manga-worker     | ----------------------------------------
          manga-worker     | Exception occurred during processing of request from ('127.0.0.1', 36836)
          manga-worker     | Traceback (most recent call last):
          manga-worker     |   File "/usr/local/lib/python3.13/socketserver.py", line 697, in process_request_thread
          manga-worker     |     self.finish_request(request, client_address)
          manga-worker     |     ~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^
          manga-worker     |   File "/usr/local/lib/python3.13/socketserver.py", line 362, in finish_request
          manga-worker     |     self.RequestHandlerClass(request, client_address, self)
          manga-worker     |     ~~~~~~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
          manga-worker     |   File "/usr/local/lib/python3.13/socketserver.py", line 766, in __init__
          manga-worker     |     self.handle()
          manga-worker     |     ~~~~~~~~~~~^^
          manga-worker     | 2026-07-11 13:22:51,559 [DEBUG] Starting new HTTP connection (1): backend:8080
          manga-worker     |   File "/usr/local/lib/python3.13/http/server.py", line 447, in handle
          manga-worker     |     self.handle_one_request()
          manga-worker     |     ~~~~~~~~~~~~~~~~~~~~~~~^^
          manga-worker     |   File "/usr/local/lib/python3.13/http/server.py", line 435, in handle_one_request
          manga-worker     |     method()
          manga-worker     |     ~~~~~~^^
          manga-worker     |   File "/app/worker/health_server.py", line 132, in do_GET
          manga-worker     |     self.wfile.write(json.dumps(response_data).encode("utf-8"))
          manga-worker     |     ~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
          manga-worker     |   File "/usr/local/lib/python3.13/socketserver.py", line 845, in write
          manga-worker     |     self._sock.sendall(b)
          manga-worker     |     ~~~~~~~~~~~~~~~~~~^^^
          manga-worker     | BrokenPipeError: [Errno 32] Broken pipe
          manga-worker     | ----------------------------------------
          manga-worker     | [OCR] PaddleOCR returned.```
- [ ] Hundreads of `Null type safety` warning in the java code base, better get them checked and fixed.
- [ ] When switching pages fast it seems like the reader is reloading completely instead of just loading in the images and layers, probably some state is being reset or something, need to fix it.
- [ ] Sometimes the translations are provided as `romanized text (actual results)` mostly done by the free or cheap models, probably can be mitigated by updating the prompts Examples:
  - `要出发了哦` --> `Yào chūfā le o (About to depart!)`
  - `还有还有！` --> `MADA MADA ( NOT YET! )`
  - `エルフ!` --> `ERUFU (ELF!)`
- [ ] The `https://ideapad.tail9ece4.ts.net/tlhub/api/jobs/clear` API can't actually clear stale jobs
  - [ ] We get `{"timestamp":"2026-07-11T15:53:37.171+00:00","status":999,"error":"None"}`
- [ ] Because we have queue priority if a single image is added more than one the order of the processing gets messed up like the layout analysis ran before the OCR so the bubbles were places without any consideration for the layout
  - [ ] This is tested because sometimes manga have a cover page and that same page is used inside later so better to be safe
  - [ ] Also idempotency is nice to have check out [the logs](./logs/run-9.log)
  - [ ] Make sure that this doesn't happen, should be easy to prevent as we hash the images right?
- [ ] The clear queue button does nothing (like it calls the API but that does nothing, expected outcome it clears all jobs that are queued i.e. not getting processed or are in a state that they can't be processed, like failed or paused)
  - [ ] The cancel action for queued jobs works though although it calls a different end point
  - [ ] ```curl 'https://ideapad.tail9ece4.ts.net/tlhub/api/jobs/8d19b9ab-daa6-4e43-afed-0464f53f946d' \
  -X DELETE \
  -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0' \
  -H 'Accept: */*' \
  -H 'Accept-Language: en-US,en;q=0.9' \
  -H 'Accept-Encoding: gzip, deflate, br, zstd' \
  -H 'Referer: https://ideapad.tail9ece4.ts.net/tlhub/chapters/975dad6b-ef09-458c-85fc-b726ea6dc320/test' \
  -H 'Authorization: Bearer Token-Placeholder' \
  -H 'Origin: https://ideapad.tail9ece4.ts.net' \
  -H 'Sec-GPC: 1' \
  -H 'Connection: keep-alive' \
  -H 'Sec-Fetch-Dest: empty' \
  -H 'Sec-Fetch-Mode: cors' \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'DNT: 1' \
  -H 'Priority: u=0' \
  -H 'Pragma: no-cache' \
  -H 'Cache-Control: no-cache' \
  -H 'TE: trailers'```

#### Bugs blocked by other bugs

- [ ] currently exporting as a zip is broken, but when we fix it we have to make sure that it works as expected (and not how it was before), because before it was just exporting the original images as a zip, the translations were not rendered in.
- [ ] Post processing edits after the translations also don't get synced in the rendered output, when exported as chapter zip

### Output improvements

- [ ] For sample 1 the results are good but we need to work on improving the quality of these other type of translations
- [ ] Checkout ![samples 2](./examples/sample2/original.jpg) the output produced by `https://mangatranslator.ai/upload` ![this one](./examples/sample2/en-mangatranslator.ai.jpg) is like amazing while ours is ![this](./examples/sample2/en-local.png) and it leaves a lot to be desired
- [ ] Also ![sample 3](./examples/sample3/original.jpg) the output from the service is ![this](./examples/sample3/en-mangatranslator.ai.jpg) while ours is ![this](./examples/sample3/en-local.png) is hediously bad

### Improve the models and translation related features

- [ ] Currently we are on a yolo11n model from `juithealien/manga109-segmentation-bubble` but it seems to be abandoned and only detects text bubbles
  - [ ] Checkout the [Model Upgrade Plan](docs/model_upgrade_plan.md) it documents which model can serve as a successor
- [ ] Currently we are using the prompts in [Sample Prompts](docs/models_and_prompts.md) and processing as documented
  - [ ] However we should improve the prompts and see if we can get better results.
  - [ ] I also think we can improve the prompts for the VLM when doing OCR
    - [ ] so that they classify the text and reject sfx and gibberish and text that doesn't need to be processed at all like author name/handle, sfx and even text that's already in english in that phase
    - [ ] If we are doing Re-OCR or Redo-Region-TL with a VLM we can send in the QA feedback to help the model out, like if the reason is a manual trigger from user, then user didn't like it so do a clean redo and if the QA model didn't like it can tell it what it didn't like.
  - [ ] Also enhance the QA prompt to check for similar issues as images which have been processed locally i.e. never sent to the cloud for OCR will not have this intelligence applied to their processin but that doesn't mean we can't apply it in post processing
    - [ ] like giving it a way to directly update the text if it has a better translation
    - [ ] or can reject the text if it's sfx/gibberish etc
    - [ ] it will never be allowed to delete an elemnent only hide it (we have a toggle for that)
    - [ ] remember to keep it's ability to trigger ocr and re-translation, we can improve that as well now it can device to do a while page re-ocr or re-tl or just send a region back that is not good enough
    - [ ] but we should make it so that it never sends back the same text back for re-ocr or re-tl, or at least tries not to, i.e. the quality of the output should be strictly better than the previous output and if not it should not be sent back
    - [ ] we also need to make sure that we don't get stuck in a loop of re-ocring and re-tling (just once pass, no loops)
    - [ ] since we added redo-region-* queues this should happen pretty quick

### Front end issues

- [ ] We keep polling `/tlhub/api/jobs/status` for jobs, why can't we use SSE for this as well?
  - Frontend already has `useSSE.ts` hook, just needs a migration from polling
  - **Analysis Findings**:
    - The HAR file shows the frontend makes very frequent polling requests to `/tlhub/api/jobs` and `/tlhub/api/jobs/status` (multiple times per second in bursts, e.g., 2026-07-11T01:06:19 to 01:06:38).
    - As highlighted in `found-improvements.md`, this two-way polling is resource-intensive for the backend.
    - **Recommendation**: This is a high-impact improvement. We should transition to a hybrid approach:
      1. **Two-Way (REST API):** Frontend sends POST to start a job, receiving a `job_id`.
      2. **One-Way (SSE):** Frontend uses its existing `useSSE.ts` hook to listen to an SSE stream (e.g., `/api/jobs/stream`).
      3. **Backend Push:** As job state changes in the worker/database (PENDING -> PROCESSING -> COMPLETED), the backend automatically pushes these updates over the open SSE connection.
    - This eliminates the need for the frontend to constantly ask "is job X done?", saving significant HTTP overhead and database query load.
- [ ] It seems like the thumbnails in the main view (i.e. the list of all the series) and series page (i.e. the chapter thumbs) are not actually thumbnails but rather the full file as seen in the url `/tlhub/api/images/{{id}}/file`
  - [ ] However the chapters seems to download the thumbnails correctly from `/tlhub/api/images/{{id}}/thumbnail` in chapter page
  - [ ] Thumbnails are generated using basic bilinear interpolation + JPEG output (`PageService.java:108-141`). Switch to **Bicubic/Lanczos** interpolation and **WebP** format (~80% quality) for sharper results at smaller file sizes.
  - [ ] **Thumbnail generation blocks the upload request (synchronous on the request thread)** — `generateThumbnail` (`PageService.java:108`) runs inline *before* the HTTP response returns and before the async pipeline is triggered (`PageController.java:540` → `startPipeline` at `:562`). It is not a pipeline phase; it happens at upload/ingest time. Per upload it does, sequentially: `file.getBytes()` (full original into heap, `:480`) → `ImageIO.read` (decodes full-res into a `BufferedImage`, `:110`) → bilinear resize + `ImageIO.write(jpg)` (`:123-135`) → **two sequential MinIO round trips** (original `:535`, thumbnail `:543`).
    - [ ] **Latency**: each upload waits on full decode + resize + encode + 2 MinIO hops; hundreds of ms to seconds for hi-res pages.
    - [ ] **Memory/OOM risk**: a decoded RGB `BufferedImage` costs ~`w×h×3-4` bytes (a 5000×7000 image ≈ 105-140 MB) on top of the original `byte[]`; many concurrent uploads (Tomcat default 200 threads) can exhaust the heap.
    - [ ] **Thread-pool starvation**: the servlet thread is held for the whole decode + both MinIO uploads, reducing upload concurrency.
    - [ ] **Batch imports are the worst case**: `importProject` and `importChapter` (`SeriesController.java:574`) call this inside a **per-file loop**, serially on one request thread (`PageController.java:204`, `:248`, `:449`, `:1030`, `:1090`) → very long-running request, timeout risk, one thread pinned for minutes.
    - [ ] Already handled well: thumbnail failure is caught and upload proceeds without it (`:546-548`); duplicate-hash uploads short-circuit before thumbnailing (`PageController.java:494-528`).
    - [ ] **Fix direction**: move thumbnailing off the request path (async pipeline step or `@Async` bounded pool, then update `Image.thumbnailStoragePath` + notify via existing SSE); avoid full-res decode via `ImageReader` subsampling or imgscalr/Thumbnailator; parallelize/queue batch imports. Combine with the Bicubic/Lanczos + WebP change above.
- [ ] Also this GET `/tlhub/api/images/106e431e-b4fe-4874-8b47-c43bbda47dd8/file` seemed to work even without auth
  - [ ] And so does the thumbnails one but that's expected, right thumbs should work without auth shouldn't they?
- [ ] Add a modal for user management which can be opened by clicking on the username in the nav bar
  - [ ] Allows us to change username and password
  - [ ] not the email though
- [ ] The dialogs boxes are not fitting in the viewport correctly
  - [ ] so remove the `Cover Image URL (Optional)` from create and edit series also make sure we remove the setter for image from backend see [remove-custom-thumbnails](./examples/remove-custom-thumbnails.jpg) we can remove it as it we are going to be using proper system generated thumbs from now on
  - [ ] The global settings modal has some strgae issues fix it see [remove-custom-thumbnails](./examples/remove-custom-thumbnails.jpg)
  - [ ] See if the model overrides can be re-designed to be easier to use and display.
- [ ] Re-design the job manger see [redesign-the-job-queue](./examples/redesign-the-job-queue.jpg)
- [ ] Chapter cards also need to be added [chapter-cards](./examples/chapter-cards.jpg)
  - [ ] I had one more brilliant idea add an edit/add description in the chapter and series so that we can add descriptions and links
  - [ ] Also these can optionally be used to inject into the context of the model like we can give it the name of the series and where it is from also maybe any artist commentry (just like the boorus)
  - [ ] Remember the stretch goals **Chapter & Series Summarization** we can add it manually for now, later maybe the models can update it or generate one if not provided?
- [ ] Add a delete chapter button inside the chapter page
- [ ] Make sure that the model override components shows the models at every view, like instead of `--Inherit--` show `tencent/hy3:free (inherited from series/chapter/global)`
- [ ] We follow the `nHentai` colour scheme for dark mode for the light mode lets follow `pixiv` clour scheme.
- [ ] The main view (i.e. Where all the series are listed) should have sorting options to sort by created date or last updated at, both ascendiong and descending as series are by nature indepandeant so there is no absolute ordering them other than time.

### Backend & API Resilience

- [x] **Disable Open-In-View (OSIV)** — `spring.jpa.open-in-view` defaults to `true` in the backend (`application.yml`), which keeps DB connections open for the entire HTTP request lifecycle. This can exhaust the HikariCP pool under concurrent load.
  - Fix: Added `spring.jpa.open-in-view: false` to `backend/src/main/resources/application.yml`. Verify no lazy-loading issues exist in the service layer before deploying.
- [ ] **Cross-provider failover** — Currently within a provider (e.g., OpenRouter), the code retries the primary model then iterates through the model list (`llm_model_list`). But if the **provider itself** is down (e.g., OpenRouter returns 400s for all models), the job fails.
  - [ ] When all models within the current provider are exhausted, failover to another provider (e.g., OpenRouter → Nvidia/DeepSeek) before marking the job as failed
  - [ ] Requires a `provider` fallback list/order in config (not just model list within a single provider)
- [ ] Add a direct deep seek api provider, actually we should create a provider factory class in both java and python so that we can use almost any provider given they are following any/both of the below mentioned APIs:
  - Open AI API
  - Anthropic API

---

## 🟡 Medium Priority Improvements

### ML Processing Optimization

- [ ] **Enforce strict HTTP timeouts for cloud LLM calls** — Current approach uses ad-hoc hardcoded timeouts (60s, 90s, 120s) in `translation.py` without separating connect vs read timeouts. A frozen connection can paralyze the worker slot.
  - Set `connect_timeout=10s` and `read_timeout=45s` at the HTTP client level for all cloud provider calls
  - If a provider exceeds the read timeout, throw a `TimeoutException` to trigger retry/failover and free the worker slot

### JVM & Infrastructure Hygiene

- [x] **Clean up JVM `sun.misc.Unsafe` warnings** — Netty and other high-performance libs trigger these warnings at startup. While harmless, they clutter container logs.
  - Added `--enable-native-access=ALL-UNNAMED` to the Dockerfile `ENTRYPOINT`. This suppresses the warnings without affecting functionality.

---

## 🔵 Low Priority / Nice-to-Have

- [ ] Currently we can only import zips, add support for ePub,cbz import and export.
- [ ] **True Cross-Page Character Memory** — Feed speaker profiles to translation prompts to prevent name/gender drift across pages.
  - [ ] We have a very rudimentary implementation, in which we inject the previous pages' translated text into the current context.
  - [ ] Instead, we can maintain a memory of past pages' characters, names, places, unique words and the like and inject that into the current context.
- [ ] **Add draw-to-OCR / draw-to-translate workflow** — Let users draw a rectangle on the image canvas, then trigger OCR or translation for just that region. Requires:
  - [ ] Frontend: new tool mode in canvas (similar to free resize but for region capture)
  - [ ] Backend: new endpoint accepting image ID + bounding box coordinates
  - [ ] Worker: crop-and-process pipeline for the selected region
- [ ] **Chapter & Series Summarization** — Background worker aggregates translated dialogue and generates chapter/series summaries via AI.

---

## 🧪 Testing & QA

- [ ] Test at higher concurrenry
- [ ] Make the OCR lock dynamic and tes out if we can handle 2 OCR detection runs, or have the local OCR split into smaller parts in the pipeline like
  - [ ] One slot for OCR detection
  - [ ] One slot for OCR recognition
  - [ ] This will help parallelize even more at higher concurrenry
  - [ ] But we should add a way for the worker to let us know that it can't accept anymore jobs, because it's going OOM or out of CPU
- [ ] On that note I remember immich reserves CPU and memory for the ml-container we should do it too.
- [x] Adding a job and then immediately deleting the file, should trigger a failure, which it does
  - [ ] but the retries were at 1/3 so, retries may not be working as I have never seen a job at like 2/3 retries. This needs to be investigated.

---

## ✅ Completed (Archive)

### Bugs (Fixed)

- [x] **Hybrid cloud OCR coordinate space mismatch** — In the PP-OCRv6 det + VLM batching path (`DISABLE_LOCAL_OCR=true`), `img_original` was never set in the detector branch, causing YOLO bubble detection and VLM crop extraction to run on the downscaled image while PaddleOCR fragment coordinates were correctly rescaled to original dimensions. Fixed: decode into `img_original` before downscaling so line 434's `img = img_original if img_original is not None else img_decoded` correctly picks the full-resolution image for YOLO and VLM cropping.
- [x] Opening the settings on front-end causes the user to get logged out (most probably due to the context path. Need to check if the context path is changed does this break?).
- [x] Make the model picker options collapsible in the series and chapter dialog boxes.
- [x] Cloud OCR doesn't recognize free floating text that PP-OCR-v5/6 does, it almost always misses those. The bubbles are fine for the most part, check the latest logs for the breakdown
  - [x] There appears to be a yolo11 error in the logs as well, need to check that.
- [x] Delete Page seems to be broken
  - [x] On that note need to add CRUD tests for all levels like series, chapter, page, layer and element in the layers.
- [x] **Backend-rendered pages don't match frontend** — `RenderingService.py` uses Pillow/PIL, frontend uses HTML5 Canvas with CSS text. The two diverge significantly. Options:
  - Use a headless browser (Playwright) in the worker for pixel-perfect rendering
  - Or accept backend rendering as "draft" and add a frontend "export as seen" button that captures the canvas
- [x] **Verify manual layer edits are included in export** — Export reads from DB, so only *saved* edits are included. Ensure the frontend auto-saves or warns before export.
- [x] **Benchmark alternative cloud OCR models** — `qwen/qwen3-vl-8b-instruct` is fast but misses non-dialog text. Test other models from VLM benchmarks for accuracy vs speed tradeoffs.
- [x] Cost calculation seems wrong — fixed costs.json per million tokens and printing estimated cost
- [x] Bubble polygon detection and masking regressions after v9 — fixed, YOLO bubble masks successfully merged and propagated
- [x] Bubble grouping issues after upgrading OCR — fixed, tuned vertical/horizontal proximity algorithm threshold
- [x] Redo Page OCR was replacing old layer instead of creating new pass — fixed, preserves original
- [x] OCR layer visible when Clean Scanlation toggled — fixed, layer hidden appropriately
- [x] Layer stacking and numbering — fixed, layers numbered in stack order
- [x] Translated text breaking out of bounding box — fixed
- [x] Free resize mode not working — fixed
- [x] Clone layer added at wrong position — fixed, clone inserts above source layer; reorder via ↑↓ buttons and Shift+↑/↓
- [x] Undo doesn't work for bubble dragging — fixed
- [x] Delete confirmation dialogs don't respect light theme — fixed, uses CSS variables
- [x] Toast doesn't respect light theme — fixed, global ToastProvider with theme-aware styling
- [x] Deleting first image leaves series thumbnailless — fixed
- [x] Fix SSE user-image mapping expiry — fallback to DB on Redis miss
- [x] Clean up all Minio artifacts on page delete — added rendered image cleanup
- [x] Increase JWT access token TTL — updated to 24 hours in application.yml
- [x] Fix `CostEstimationService.java` — implemented dynamic cost estimation for OpenRouter API with filesystem and Redis caching, legacy code obsolete

### Backend & Model Picker Features (Done)

- [x] **Backend: `/api/settings` endpoint** — Expose and update model configuration at runtime.
  - [x] Refactor env vars into three groups:
    - `OCR_MODEL_PROVIDER` + `OCR_VLM_MODEL` / `OCR_VLM_MODEL_LIST`
    - `TL_MODEL_PROVIDER` + `PREFERRED_LLM_MODEL` / `PREFERRED_LLM_MODEL_LIST`
    - `QA_MODEL_PROVIDER` + `QA_LLM_MODEL` / `QA_VLM_MODEL` (+ list variants)
  - [x] Load defaults from env vars, allow runtime override via API
  - [x] Support `OCR_PROVIDER: local | cloud` (gray out local if image lacks OCR deps)
  - [x] **Model list / model picker** — `OCR_VLM_MODEL_LIST`, `TL_LLM_MODEL_LIST`, `QA_LLM_MODEL_LIST`, `QA_VLM_MODEL_LIST` are already declared as env var stubs. When the model picker UI is built, populate these lists from the API and treat position 0 as the current default. At that point, the single-model vars (`TL_LLM_MODEL`, `OCR_VLM_MODEL`, etc.) can be deprecated in favour of the list.
- [x] **Backend: Per-chapter/series model selection** — Add model config fields to `Chapter` and `Series` entities. Update APIs so a rough draft chapter can use cheap models and a final chapter uses premium models.
- [x] **Worker: Accept model config per-job** — Infrastructure exists (`ocrProvider`, `preferredModel` in job payload) but values come from global env vars only. Wire up per-chapter settings. Use defaults as safety fallback for invalid/unavailable models.
- [x] **Frontend: Settings panel** — Gear icon in navbar showing active providers + model dropdowns. Initialize from backend defaults, POST user preferences to persist.
  - [x] Add model selection fields to Add/Edit Series and Chapter dialogs
  - [x] Show configured OCR type, models, and providers on Series/Chapter cards
- [x] **Frontend: Red-outline bubbles that failed QA** — `QaResult` data exists in the DB (`qa_results` table with `region_index`, `issue_type`, `severity`). Surface this in the reader canvas by outlining failed OCR/TL regions with red margins.
- [x] **Backend: Embed QA summary in layer metadata** — Currently QA results are in a separate table. Consider denormalizing a summary (pass/fail count, critical issues) into the layer metadata JSON for faster frontend access.
- [x] **Move export button to Chapter view** — Currently only accessible inside the Reader (`ReaderToolbar.jsx`). Add export controls to `ChapterPage.jsx` so users can export without opening the reader.
- [x] Async job queue with retry & exponential backoff
- [x] Image deduplication via hashing
- [x] Unified LLM provider integration (LiteLLM)
- [x] Layer metadata tracks OCR/TL model identifiers
- [x] Worker observability & structured logging
- [x] Live updates via SSE (implemented, but has the Redis mapping bug above)
- [x] Full ZIP/ePub import for project setup
- [x] Layer project re-hydration from exported archives
- [x] Redo-OCR — fixed duplicate bubbles and ordering
- [x] Redo-Translation — fixed blank layer creation
- [x] PP-OCRv5/v6 server integration
- [x] OpenRouter cloud OCR investigation (works but quality varies by model)
- [x] Nemotron OCR v2 investigated — neither fast nor reliable, rejected
- [x] Notifications/toasts made more informative (include image/chapter/series context)
- [x] **Chapter-Level Memory Toggle** — Add a way to disable previous page context injection at the chapter level, so that say we are translating stand-alone pages we don't waste tokens on this.

### Worker Enhancements & Improvements (Done)

- [x] Fail translation job/verify YOLO on start instead of falling back to OpenCV silently when yolo11 model is missing
- [x] Remove MangaOCR and EasyOCR dependencies to optimize worker footprint and memory
- [x] Update default local OCR models to PP-OCRv6 medium
- [x] Document OCR_MERGE_THRESHOLD in README.md for tuning bubble grouping
- [x] Implement proper model seeding on worker startup before accepting jobs
- [x] Fix worker tests failing due to missing Redis — either mock Redis or add a `docker-compose.test.yml` that spins one up.

### Cost Tracking (Done)

- [x] **Cost tracking** - Even when using paid models most jobs still print `$0.00000`
- [x] The costs.json is indeed populated but not useful at all
- [x] **Track actual API costs per layer** — Once cost estimation is fixed, log real costs (tokens × price) at the layer level for both OCR and TL and QA
- [x] **Add the costs per layer to `project.json` of each page**
  - [x] Also need to add QA feedback received for layers to the layers it was generated for
  - [x] Add to each layer its estimated cost; during export we can expect project json to include `totalCost` and per-layer cost breakdown
  - [x] **Update the `meta-data.json` in chapter export ZIP** — Now includes full `project.json` with correct cost, visibility, and the `chapterTotalCost` summary

### Reliability & Crash Recovery (Done)

- [x] **Persist job queue across restarts** — Currently Redis-only (`RedisPriorityQueue`). If Redis or the host crashes/restarts, queued jobs are lost. Save queue state so the worker can resume from where it crashed. Keep Redis for fast dequeuing, Postgres as the source of truth. (Need to test this out)
- [x] **Queue Management:** Add a Queue managed in front-end just like the notification manager we have, it should be able to show us which jobs are in queue, processing and passed jobs get converted to notifications and removed, failed ones go the the bottom with a retry button on them
  - [x] We should be able to pause and resume the jobs, this will go nicely with the persistaence of jobs.
  - [x] Pausing and resuming works
  - [x] Need to test if clearing the queue does stop all the job including the currently running ones
- [x] **Docker secrets file support** — Add `_FILE` suffix convention support in backend and worker config loaders (e.g., `DB_PASSWORD_FILE=/run/secrets/db_password`). Read secrets from files mounted by Docker Swarm/Compose.
  - [x] Support reading secrets for Database Configuration
  - [x] Support reading secrets for MinIO Configuration
  - [x] Support reading secrets for JWT Configuration
  - [x] Support reading secrets for API Keys Configuration
  - [x] Maybe we can mount a json or something as a secret and read all of it at once instead or reading one file at a time?
- [x] **Add a Hybrid QA mode where both LLM and VLM are used**
  - [x] The LLM checks the translation and gives feedback on fixes, check if the correct layers are set to be visible and generates the render
  - [x] The VLM does the final pass on the rendered image

### Model Picker Improvements (Done)

```txt
# 1. OCR Model Configuration (To use cloud OCR set DISABLE_LOCAL_OCR to true)
OCR_MODEL_PROVIDER=openrouter
OCR_VLM_MODEL=qwen/qwen3-vl-32b-instruct
# Fallback list for OCR (Active model at index 0, followed by commented out fallbacks)
OCR_VLM_MODEL_LIST=qwen/qwen3-vl-32b-instruct,google/gemini-3.5-flash,nvidia/nemotron-nano-12b-v2-vl:free,google/gemini-2.5-flash,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,google/gemini-3.1-flash-lite

# 2. Translation (TL) Model Configuration
TL_MODEL_PROVIDER=openrouter
# google/gemini-3.5-flash
TL_LLM_MODEL=deepseek/deepseek-v4-pro
# Fallback list for Translation (Active model at index 0, followed by commented out fallbacks)
TL_LLM_MODEL_LIST=deepseek/deepseek-v4-pro,deepseek/deepseek-v4-flash,google/gemini-3.5-flash,google/gemma-4-31b-it:free,google/gemini-2.5-flash,tencent/hy3:free,cohere/north-mini-code:free,openai/gpt-oss-120b:free

# 3. Quality Assurance (QA) Model Configuration
QA_MODEL_PROVIDER=openrouter
QA_LLM_MODEL=deepseek/deepseek-v4-flash
# Fallback list for QA LLM (Active model at index 0, followed by commented out fallbacks)
QA_LLM_MODEL_LIST=deepseek/deepseek-v4-flash,deepseek/deepseek-v4-pro,google/gemini-3.5-flash,google/gemma-4-31b-it:free,google/gemini-2.5-flash,tencent/hy3:free,cohere/north-mini-code:free,openai/gpt-oss-120b:free
QA_VLM_MODEL=google/gemini-3.1-flash-lite
# Fallback list for QA VLM (Active model at index 0, followed by commented out fallbacks)
QA_VLM_MODEL_LIST=google/gemini-3.1-flash-lite,google/gemma-4-26b-a4b-it:free,google/gemini-3.5-flash,google/gemini-2.5-flash,nvidia/nemotron-nano-12b-v2-vl:free,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
```

- [x] As seen in the above code block despite having a picker we only really have one provider, OpenRouter.
- [x] The same model `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` on open-route, if to be used on nvidia nmi needs to be formatted as `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` so we need a way to map these different formats.
- [x] Also there should be a section for fallback models in the config which will be used when the primary model fails, the fallback will work in the same way as the primary just with a fallback priority.
- [x] Also providers should only become available if they are usable like currently the list shows that we have access to open-ai, anthoropic, ollama, lm-studio
  - [x] But we don't actually have keys configure for open-ai, anthoropic
  - [x] And since LOCAL_LLM_PROVIDER is ollama, lm-studio should also be hidden
  - [x] Say if DISABLE_LOCAL_LLM=true, thenollama and lm-studio should not be visible as options
  - [x] If DISABLE_LOCAL_OCR=true, then open-router and nvidia should be the only ones visible as options for OCR.
  - [x] Also if say in the front-end we select OCR Provider as local then OCR VLM Model should be disabled as we actually only have local models for that and the UI should be aware of it.
- [x] Need to elimeninate this `NVIDIA_OCR_API_KEY` redundant key as well since we already have `NVIDIA_API_KEY`

## 🧪 Testing & QA (Done)

- [x] Test intentional bad translations with a weak model to verify QA detection capabilities.
- [x] Test with very low quality images to observe OCR failure handling and error reporting.
- [x] Test uploading a KR (Korean) image to a JP (Japanese) series to observe language mismatch behavior.
- [x] ~~**Progress Gallery** — Create a visual showcase using `Sample1` showing output quality progression from v1 → v10+.~~ (Cancelled)

### ML Processing Optimization (Done)

- [x] ~~**Support remote workers for local OCR** — Allow spinning up dedicated workers on LAN devices for heavy local OCR (PP-OCRv6).~~ (Cancelled)
  - *Context*: Currently, local detection models (PaddleOCR-Det and YOLO speech bubble detection) run sequentially via a global process lock to avoid overloading CPU/GPU and causing OOM crashes on the host machine.
  - *Requirements*: Remote workers must expose capability APIs, health check endpoints, and task-specific concurrency status, allowing the coordinator to route OCR/detection tasks safely without resource exhaustion.
- [x] **Parallelize processing** — Currently sequential because OCR is done locally sequentially, this is a massive bottleneck. (Tests pending)
  - [x] When using cloud OCR (VLM) we can parallelize the tasks as TL and QA are already done using cloud providers, actually this can't be done as we still need to run PP-OCR-v6 det and YOLO bubble detection these are currently not being served by any cloud provider
  - [x] Add an environment variable which controls the degree of parallelism, default to 1 (i.e. No parallelism) but can be configured to support it
  - [x] Probably implemented incorrectly `CLOUD_CONCURRENCY=2` doesn't seem to be sending 2 requests to openrouter in parallel, need to fix
  - [x] If implemented correctly we can parallelize the text and bubble deteation across workers and send parallel jobs to the cloud
  - [x] These will still need to respect the rate limits, and not keep sending jobs in parallel even when we are getting 429's
