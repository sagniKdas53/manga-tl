# Bugs / TODO

## Completed Issues

- [x] If an image is sent for Redo Page OCR a new OCR layer is not created instead the old one is getting replaced, the translation for that page is also getting deleted and updated in it's respective TL later, no new layer for TL too (this is not what I wanted, as the previous one might be needed for RnD/QA, I wanted the original pass's data to be preserved and insted a new pass being done)
- [x] For images that have been translated the OCR layer shouldn't be shown (i.e. Just have it's visibality turned off temporarliy) if the Clean Scanlation button is toggled on (same applies for export page as Image option, unless the user toggles if on manully the let them do what they want)
- [x] The layers are great they organize the elemets well and stack well on each other (one improvemnt I can think of is numbering the layers in the oder they are stacked), they are like very easy to switch over, if I say click on the OCR mask then the element inspector for the OCR region in the OCR layer opens up but then I fi click on the translated mask the same happens for the other layer it's as if they are all active in the same place (I suspect the inablity of the front-end to determine the active alayer if there is any such thing is the primary reason why free resize doesn't work it just doesn't know which layer to create box in which can then be moved and resized as needed)
- [x] The Translated text is breaking out of it's bounding box, see sample1 v7 both the OCR (atleast has the correct mask) and the Typeset version (the mask is onlyon the bubbles but the text overflows)

## [DONE] Frontend Issues & Improvements

- [x] The free resize mode doesn't work on the front-end, say I select a translated box the element inspetor opens up now when I click on the Switch to free resize mode the button changes Free Resizing: Active but the box that desigantes the selection to be dragged across the image or resized to desired shape doesn't appear, clicking on the image just clears off the free resize mode.
  - [x] For some reason this is not working at all
- [x] Almost perfect, need more testing (Relates to translated text breaking out of bounding box)
- [x] Add a clone layer in front-end (Partially implemented)
  - [x] It works but the new layer get added at the top regardless of what the original layer's position were
  - [x] Like say there are 3 layers, 1 base the original OCR, 2 the translation, 3 a user generated layer to do some final touch up
  - [x] If I clone the layer two I expect it to be added as a layer over two, ie the clone becomes layer three and the existing layer 3 gets promoted to layer 4 (and so on)
  - [x] Now it's okay if it can't be done like that, in that case we would need a way to re-order the layers manually, I could use the shift key to re-order them (Shift Up to promote one, Shift Down to demote one) — ↑↓ buttons added to LAYERS header; Shift+↑/↓ keyboard shortcuts also work
- [x] Undo button doesn't work for dragging a bubble but works perfectly for the reshaping flow, need to investiage and fix.
- [x] **Model Picker in UI:** See new section below.
- [x] The delete confirmation boxes, don't respect the light mode theme, are laggy (on a tablet, which I tested on) and in general don't look good — **fixed**: now uses CSS variables, no blur, no cubic-bezier bounce.
- [x] The toast doesn't respect the light mode theme and also is only used for upload completed notification — **fixed**: global ToastProvider uses `var(--text-main)` and fires translation SSE toasts outside Reader.

## Model Picker / Runtime Settings

- [ ] **Backend:** New `/api/settings` endpoint to expose and update model configuration at runtime.
  - [ ] Support setting OCR provider: Local, Cloud (This should be enough as can just gray out the local option if the image doesn't include OCR deps or is disabled by the env var)
  - [ ] Now that we have cloud OCR as well maybe we should rename the env variables to have three parts, OCR_MODEL_PROVIDER and it's dependant OCR_VLM_MODEL or OCR_VLM_MODEL_LIST
  - [ ] Next have a TL_MODEL_PROVIDER and it's dependant PREFERRED_LLM_MODEL or PREFERRED_LLM_MODEL_LIST
  - [ ] Lastly QA_MODEL_PROVIDER which will have two dependant variables QA_LLM_MODEL and QA_VLM_MODEL and their list forms to provide options
  - [ ] We will set the defaults at conatiner level using env vars, these can then be loaded to the back-end to be passed onto the worker and front-end
- [ ] **Backend:** Update the chapter and series meta-data api's to support chapter level model selctions, so that say we are doing a rough draft for a chapter we can use the free or very cheap model to do a draft and then maybe we want high quality for another chapter we can just configure it use paid fast models.
- [ ] **Worker:** These different types of models, at various stages can be passed onto the worker as a part of the job meta-data, this would also help use populate the layer meta-data as we will know which job is using what to produce a layer or render
- [ ] We can pass on the defaults as a safty fallback incase the models passed for a job are not available or wrong.
- [ ] **Frontend:** Settings panel in the navbar (gear icon) showing active provider's + model dropdowns. This initilzes the defaults for the user form the data passed on by the back-end but can also post the user preferences back to the back-end to presist
  - [ ] Need to add additioanl fields in the add and edit series and chapter's dialog boxes so that we can quickly configure the models for a series or chapter.
  - [ ] Also show the OCR type used, models and provider's used for the series and chapter in their cards so that we know at a glance whats configured.

## [DONE] Backend & Worker Pipeline Improvements

- [x] **Async Job Queue with Retry & Backoff:** Refactor the translation and OCR pipeline into an asynchronous job queue (e.g., BullMQ, Celery). If a provider is unavailable or an API call fails, prevent it from returning blank translations and erroneously passing QA. Instead, requeue the job with an exponential backoff strategy to ensure reliability over long periods.
- [x] **Image Deduplication via Hashing:** Implement image hashing (similar to Immich) to detect if an uploaded image has already been OCR'd and translated. If a matching hash exists, link to the existing processed image/data. This optimization will save database space, significantly reduce processing time, and prevent duplicate API costs.
- [x] **Unified LLM Provider Integration:** Integrate a popular LLM abstraction library (like `LiteLLM` or `LangChain`) that automatically maps provider names to correct API URLs and seamlessly handles multiple API keys (configured via secrets or `.env` files).
- [x] **Layer Metadata Tracking:** Store the specific model identifiers used for OCR and translation within the respective layer's metadata. This enables future model performance comparisons and must also be included in the project's export zip archive.
- [x] **Worker Observability & Logging:** Implement comprehensive testing and monitoring for worker logs. Ensure that the input and output for each pipeline step (OCR, Translation, Rendering) are logged and that the intermediate rendered outputs are easily verifiable to monitor the worker's internal state.
- [x] **Live Updates via SSE:** Implement live updates on the front-end using Server-Sent Events (SSE) in the Java backend. When you upload a page and have it open in the reader, an event should be broadcasted to the front-end when its OCR is ready so the layer is fetched and loaded on the canvas. When translation is done, the same happens. The same live updates should also happen for Redo of OCR and translations.
- [x] **Full zip/ePub import:** Support importing full epubs or zips to automatically set up projects and initialize pages.
- [x] **Layer Project Re-hydration:** Support importing previously exported translation projects to restore workspace and layers state.
- [x] **Redo-OCR:** Having some issues, like duplicate bubble  and order getting messed up will need to fix and test.
- [x] **Redo-Translation:** Not working at all right now (needs investigating), basically just creates a blank layer with no elements, redo-ing ocr though works and it even creates a new TL layer for the new OCR layer.

## Testing & Quality Assurance

- [ ] Test intentional bad translation using a very dumb translation model to verify QA model capabilities.
- [ ] Test with very bad quality images to observe OCR failure handling.
- [ ] Test uploading a KR image to a JP series to observe system behavior.
- [ ] Fix worker tests failing due to missing Redis instance (either mock the redis server or spin one up for tests).

## Series Configuration

- [ ] Add source and target languages to series configuration.
  - [ ] `JP --> EN` (original use case).
  - [ ] `EN --> EN` (create thumbnails, perform OCR for later search/summarization, no translation needed).
  - [ ] `KR --> JP` (experimental LLM translation).
- [ ] Add a model picker at the series level using series config.

## Frontend Issues & Improvements

- [ ] Incorporate QA feedback into the front-end by outlining the OCR and/or translation bubble in red margins for layers that failed QA (manual intervention needed).
- [x] Make notifications and toasts more informative (include specific image, chapter, or series instead of just the step that was done).
- [x] Deleting the first image of first chapter of a series causes the series to be thumbnail less, which the chapter successfully identifies and uses the now first page inside it, the series doesn't (this also implies that if the first chapter is deleted a similar issue will occur)
- [ ] **[LOW PRIORITY] Progress Gallery:** Create a gallery using `Sample1`, visually showcasing the progression of capabilities and output quality from `v1` to `v10` and more.
- [ ] The export chapter as zip should have been placed in the chapter view not inside the reader.
- [ ] The SSE is broken, most images say `Could not find owner user for image {{uuid}} in Redis. Cannot send SSE notification`
- [ ] The exported chapter has only the back-end rendered images, they are not as high quality as the front-end images, need to rectify this.

## Backend & Worker Pipeline Improvements

- [ ] Store QA feedback as metadata in the layers.
- [ ] If a layer fails QA, store the region that failed and the reason in the layer metadata.
- [x] Investigate using OpenRouter for OCR models to speed up processing via cloud (keeping the local system as a fallback).
  - [ ] qwen/qwen3-vl-8b-instruct is fast but not as good as the PP-OCR-V5 used locally like it keeps missing dialog and text if they are not in dailog boxes.
  - [ ] Should also check the other models from benchmarks
  - [x] Also need to investiagte if the nemotron-ocr-v2 can be used over nvidia api's for extremely fast and reliable ocr, no it's nither fast nor reliable
- [ ] Add support for exporting whole rendered chapters as a zip/ePub.
- [ ] Add a `meta-data.json` to the chapter export zip containing data about all pages (order, layer counts, active layer, manual-qa-needed, manual-changes-done, OCR/TL models used, cost of page's, cost of chapter if paid models are used).
- [ ] Log and keep track of costs if paid models are used (save this as metadata at image level if possible at layer level for both OCR and TL and QA as well).
- [ ] All the cost estimations show `Estimated cost: $0.00000` when it clearly isn't
- [ ] The real bottleneck was local OCR model, but if we are using cloud OCR we can defenitly parallelize a bit.
- [ ] We can build a slim worker image that doesn't have all the OCR things and just uses the cloud OCR
- [ ] **[LOW PRIORITY] Chapter & Series Summarization:** Background worker aggregates translated dialogue and generates summaries of chapters and series using the AI backend.
- [ ] **[LOW PRIORITY] Cross-Page Character Memory Tracking:** Feed speaker profiles to the translation engine prompts to avoid name/gender drift across chapter pages.
