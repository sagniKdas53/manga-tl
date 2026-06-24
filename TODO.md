# Bugs / TODO

## Completed Issues

- [x] If an image is sent for Redo Page OCR a new OCR layer is not created instead the old one is getting replaced, the translation for that page is also getting deleted and updated in it's respective TL later, no new layer for TL too (this is not what I wanted, as the previous one might be needed for RnD/QA, I wanted the original pass's data to be preserved and insted a new pass being done)
- [x] For images that have been translated the OCR layer shouldn't be shown (i.e. Just have it's visibality turned off temporarliy) if the Clean Scanlation button is toggled on (same applies for export page as Image option, unless the user toggles if on manully the let them do what they want)
- [x] The layers are great they organize the elemets well and stack well on each other (one improvemnt I can think of is numbering the layers in the oder they are stacked), they are like very easy to switch over, if I say click on the OCR mask then the element inspector for the OCR region in the OCR layer opens up but then I fi click on the translated mask the same happens for the other layer it's as if they are all active in the same place (I suspect the inablity of the front-end to determine the active alayer if there is any such thing is the primary reason why free resize doesn't work it just doesn't know which layer to create box in which can then be moved and resized as needed)
- [x] The Translated text is breaking out of it's bounding box, see sample1 v7 both the OCR (atleast has the correct mask) and the Typeset version (the mask is onlyon the bubbles but the text overflows)

## Frontend Issues & Improvements

- [ ] The free resize mode doesn't work on the front-end, say I select a translated box the element inspetor opens up now when I click on the Switch to free resize mode the button changes Free Resizing: Active but the box that desigantes the selection to be dragged across the image or resized to desired shape doesn't appear, clicking on the image just clears off the free resize mode.
  - [ ] For some reason this is not working at all
- [ ] Almost perfect, need more testing (Relates to translated text breaking out of bounding box)
- [ ] **Model Picker in UI:** Add a model picker in the front-end interface to allow users to select the worker model (e.g., OCR or Translation model) dynamically when multiple providers are available.
- [ ] **Progress Gallery:** Create a gallery using `Sample1`, visually showcasing the progression of capabilities and output quality from `v1` to `v8` and more.

## Backend & Worker Pipeline Improvements

- [ ] **Async Job Queue with Retry & Backoff:** Refactor the translation and OCR pipeline into an asynchronous job queue (e.g., BullMQ, Celery). If a provider is unavailable or an API call fails, prevent it from returning blank translations and erroneously passing QA. Instead, requeue the job with an exponential backoff strategy to ensure reliability over long periods.
- [ ] **Image Deduplication via Hashing:** Implement image hashing (similar to Immich) to detect if an uploaded image has already been OCR'd and translated. If a matching hash exists, link to the existing processed image/data. This optimization will save database space, significantly reduce processing time, and prevent duplicate API costs.
- [ ] **Unified LLM Provider Integration:** Integrate a popular LLM abstraction library (like `LiteLLM` or `LangChain`) that automatically maps provider names to correct API URLs and seamlessly handles multiple API keys (configured via secrets or `.env` files).
- [ ] **Layer Metadata Tracking:** Store the specific model identifiers used for OCR and translation within the respective layer's metadata. This enables future model performance comparisons and must also be included in the project's export zip archive.
- [ ] **Worker Observability & Logging:** Implement comprehensive testing and monitoring for worker logs. Ensure that the input and output for each pipeline step (OCR, Translation, Rendering) are logged and that the intermediate rendered outputs are easily verifiable to monitor the worker's internal state.
