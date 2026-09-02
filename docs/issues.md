# Issues & Technical Debt

> **Standing: 95 filed, 69 closed, 26 open.** Re-audited 2026-09-02 against the field report in
> `new issues.pdf`. Three previously-open items were closed as *obsolete* — they described Java
> files the Rust rewrite deleted. Twenty-seven new items were filed, and six of them are already
> fixed: `AUDIT-F14`, `AUDIT-F17`, `AUDIT-F18`, `AUDIT-F20`, `AUDIT-B12`, `AUDIT-B13`.
>
> *(The previous header read "68 filed, 61 closed, 7 open" while listing eight open items. The
> table was right and the count was one short; these numbers are taken from the table.)*
>
> - **Resolved items** move to [docs/archive/history.md](archive/history.md) with root cause, fix details, and measurements.
> - **Feature roadmap & active milestones** are tracked in [TODO.md](../TODO.md).
> - **Visual rendering defects (D1–D16)** are tracked in [docs/render_quality_gap_2026-08-05.md](render_quality_gap_2026-08-05.md).
> - **Architectural proposals & RFCs** live in [docs/design/](design/).
> - **[Locked decisions](#locked-decisions)** are settled deliberately and must not be reverted as
>   "cleanup". Read that section before changing anything it names.

---

## Audit of 2026-09-02

The 2026-09-02 field report (24 bullets, 8 screenshots) was reconciled against the tree. Result:

**Three open items were stale, not open.** `AUDIT-Q1`, `AUDIT-Q2` and `AUDIT-T3` all named files
under `backend/src/main/java/`. That directory no longer exists — `docker-compose.yml` builds
`backend-rust/Dockerfile`, and the Java tree was deleted with the rewrite. The ~253
`Objects.requireNonNull` calls, the inline fully-qualified class names and the `@WebMvcTest`
that could not prove a Spring Data sort are all gone with the code that carried them. Closed as
obsolete; `AUDIT-T3`'s *concern* (nothing proves pagination and sort compose correctly against a
real database) is refiled as `AUDIT-T4` against the Rust handlers, because that gap is real again.

**One item moved file but is still live.** `AUDIT-W3`'s paths were written against
`worker/src/worker/core/llm_client.py`; the module is now
`worker/src/worker/services/llm_client.py:118-125`. The blocking `time.sleep` is unchanged.

**The rest of the report is new.** Nothing in it duplicates an existing open item, and two bullets
land on things already tracked elsewhere: "no texture matching anywhere" is
[D1](render_quality_gap_2026-08-05.md), the largest open item on the roadmap, and "text doesn't
fill the bubble" partly overlaps `AUDIT-R1`, the 9.5% renderer disagreement.

**What the report is really about.** Twenty of twenty-four bullets are one of three things:

1. **The editor cannot express what the renderer would need anyway** (rotation, vertical text,
   padding, per-element addressing). The canvas offers a control; the export ignores it, or the
   save rejects it.
2. **The rendered artifact and the canvas have no link.** Edits never re-render (`AUDIT-B15`),
   QA's own verdicts never reached the export, because it runs after the only render
   (`AUDIT-B12`), and rotation is baked into a polygon the renderer never reads (`AUDIT-R5`).
3. **The UI does not believe the backend.** SSE arrives and is discarded for the wrong job type
   or the wrong page (`AUDIT-F17`), thumbnails and cards never re-poll (`AUDIT-F19`), the queue
   sorts by chapter before status (`AUDIT-F20`).

That is the re-orientation: **stop treating these as twenty-four bugs and close the three seams.**

---
## Locked Decisions

Choices taken deliberately, against a plausible-looking alternative, with the measurement that
decided them. **Each one has been reverted or nearly reverted at least once because the code looks
wrong without this context.** If you are about to change something here, the burden is a new
measurement, not a tidier-looking implementation.

### `LOCK-1` — Free-standing text keeps its column's height. It is never squared into a box.

**Decided 2026-08-29 (Sagnik). Do not revert without re-measuring.**

`free_text_box` (`backend-rust/src/jobs/coordinator.rs`) turns a caption with no balloon into a
text box. It used to preserve *area*: a 91×293 column became 186×187, equal area, target aspect
1.0, capped at 2.5× widening. That reads like the obvious thing to do — English is horizontal,
Japanese is vertical, so reshape the column.

**It is backwards, and the reason is not visible in the function.** The column's height was
already erased and available. The width it was traded for was not. Every pixel of widening bought
line length by spending artwork, and the erase plate never grew to match, so the difference was
drawn onto the page.

Measured over the 400-export corpus (300-element sample, `HKXfexLbAAAN7IE` p4 as the worked case):

| | box width | median font | text past the plate |
| :--- | :--- | :--- | :--- |
| squared (before) | 1.72× the column | 37px | **38%** |
| height kept (now) | **1.00× for 70% of captions** | 35px | **0%** |

329 of 552 free-floating elements had text outside their erased plate, a median 42% of the box
width. On p4, 47% of the caption's glyph ink sat on the character's bow and hand.

**The rule now:** the height is never touched. The width grows only when the column falls below
`FREE_TEXT_MIN_WIDTH_FRACTION` (7% of page width) — a column too narrow to hold an English word at
any size — and is still capped by `FREE_TEXT_MAX_WIDEN`. Whatever widening survives is erased
along with the column, because the renderers fill the union of mask and box for a region with no
detected bubble.

**Three things that will tempt a revert:**

1. *"Clamp the box to the OCR column instead."* Tested. It fails outright on the worst cases —
   the biggest overhangs are 25–57px columns where no English word fits at any font size.
2. *"Restore the squaring, the type is bigger."* It is not. p4 sets at **45px** now against the
   squared box's 44px, because the recovered height pays for more than the lost width did.
3. *"Hyphenation got worse."* It did, and that is the accepted price: elements setting every word
   whole go from 88% to ~72%. This is the trade `render.py` already states in its tier comment —
   *a broken word is ugly and local; text outside its box lands on someone else's panel.*
   `FREE_TEXT_MIN_WIDTH_FRACTION` is the dial if the balance needs revisiting; 0.09 gives ~75%
   word-whole at 21% median overhang, 0.11 gives 80% at 33%.

Guarded by `keeps_the_column_height_instead_of_squaring_it_away`,
`does_not_widen_a_column_that_clears_the_readable_floor` and
`caps_the_widening_of_an_extremely_narrow_column` in `coordinator.rs`.

### `LOCK-2` — An OCR layer never reaches an export, whatever the reader is showing.

**Decided 2026-08-29 (Sagnik).**

Exports used to decide this from `cleanScanlationView`, the on-screen overlay toggle, so whether a
downloaded PNG carried the source-text boxes depended on how the reader happened to be configured
when the button was pressed. A view setting must not decide what lands in a file.

`isExportableLayer` in `Reader.tsx` is the single statement of the rule and admits
`translation`, `sfx` and `mask` only. `project.json` still carries every layer including OCR, so a
re-import is lossless — `import_project` reads only that file and never the layer rasters.

The worker was always right here: `render.py` draws only `translation` and `sfx` layers regardless
of any view state, which is why `/api/pages/{id}/rendered` and the backend chapter ZIP were already
clean and only the frontend's own exports disagreed.

Guarded by the OCR-layer assertions in `ReaderExportZip.test.tsx`.

---
## Open Issues Summary

Severity is "how much does this cost the output", not "how hard is it to fix".

### Seam 1 — the editor and the renderer disagree about what an element is

| ID | Sev | Component | Summary | State |
| :--- | :--- | :--- | :--- | :--- |
| [`AUDIT-F14`](#audit-f14-high-rotating-a-box-makes-every-save-fail) | High | Frontend/Backend | Rotating a text box 400s the save | **Fixed 2026-09-02** |
| [`AUDIT-R5`](#audit-r5-high-the-worker-renderer-has-no-concept-of-rotation) | High | Render | `render.py` never reads `rotation`; angled boxes flatten in every export | **Root-caused, ready** |
| [`AUDIT-R6`](#audit-r6-medium-there-is-no-vertical-text-mode) | Medium | Render | No vertical setting; rotation is the only workaround and it does not render | Design needed |
| [`AUDIT-F16`](#audit-f16-medium-text-padding-is-a-hardcoded-constant) | Medium | Render/Frontend | Padding is `(ew - 8) * 0.95`, hardcoded, unexposed, and differs from the reader | Ready (folds into `AUDIT-R1`) |
| [`AUDIT-R7`](#audit-r7-medium-a-rectangle-arrives-as-a-40-vertex-polygon) | Medium | Worker | `epsilon = 0.002 * arcLength` keeps every pixel of contour jitter | **Root-caused, ready** |
| [`AUDIT-F15`](#audit-f15-medium-a-hidden-element-cannot-be-reached-again) | Medium | Frontend | Hiding an element removes the only way to select it | Ready |
| [`AUDIT-R1`](#audit-r1-medium-the-two-renderers-disagree-by-95-of-font-size) | Medium | Render | Frontend sets 9.5% larger type than the worker | Ready: close the inset gap, then make the worker canonical (D8) |

### Seam 2 — the canvas and the artifact are not connected

| ID | Sev | Component | Summary | State |
| :--- | :--- | :--- | :--- | :--- |
| [`AUDIT-B15`](#audit-b15-medium-the-debounced-re-render-is-one-shot-and-can-lose-an-edit-permanently) | Medium | Backend | The 5s re-render sweeper marks a page rendered when it *asks* for the render, so a lost render job strands that edit forever | Root-caused; needs repro to confirm it is the reported symptom |
| [`AUDIT-B12`](#audit-b12-medium-qas-verdicts-never-reach-the-rendered-output) | Medium | Backend/Render | QA runs *after* the only render, so no `direct_fix` or `reject_sfx` reaches the export | **Fixed 2026-09-02** |
| [`AUDIT-B16`](#audit-b16-low-region-redo-layer-provenance) | Low | Backend | A region redo's new layer is not always what the reader ends up showing | Needs repro |
| [`AUDIT-R11`](#audit-r11-high-no-texture-aware-erasure-d1) | High | Render | Flat-fill erasure only; complex backgrounds are destroyed | = [D1](render_quality_gap_2026-08-05.md), roadmap item |

### Seam 3 — the UI does not believe the backend

| ID | Sev | Component | Summary | State |
| :--- | :--- | :--- | :--- | :--- |
| [`AUDIT-F17`](#audit-f17-high-the-reader-refreshes-for-four-job-types-on-one-page) | High | Frontend | SSE arrives; the reader discards it for QA/render, and for every page but the open one | **Fixed 2026-09-02** |
| [`AUDIT-F19`](#audit-f19-medium-thumbnails-and-cards-never-re-poll) | Medium | Frontend | Thumbnails, chapter cards and series cards never refresh after work completes | Ready |
| [`AUDIT-F20`](#audit-f20-low-the-queue-manager-sorts-by-chapter-before-status) | Low | Frontend | `PROCESSING` shared a sort rank with `PENDING`, so active jobs never moved | **Fixed 2026-09-02** |
| [`AUDIT-P10`](#audit-p10-unranked-sse--websocket) | Unranked | Platform | Proposal to replace SSE with a WebSocket | Not accepted; see the entry |

### Pipeline & scheduling

| ID | Sev | Component | Summary | State |
| :--- | :--- | :--- | :--- | :--- |
| [`AUDIT-W13`](#audit-w13-high-context-injected-translation-runs-in-parallel) | High | Worker | "Previous page dialogue" is read while the previous page is still translating | **Root-caused, ready** |
| [`AUDIT-W14`](#audit-w14-medium-the-slot-policy-lets-slow-network-work-crowd-out-local-work) | Medium | Worker/Backend | Four light slots + a per-cycle capacity snapshot; OCR waits behind LLM calls | Needs measurement |
| [`AUDIT-B13`](#audit-b13-medium-a-page-with-no-translatable-text-fails-the-job) | Medium | Worker/Backend | An untranslatable page raises and burns 3 attempts; it should warn | **Fixed 2026-09-02** |
| [`AUDIT-B14`](#audit-b14-medium-delete-then-re-add-leaves-a-chapter-inconsistent) | Medium | Backend/Frontend | Page count stale, old slot held, reader hangs on the loading screen | Needs repro |
| [`AUDIT-W3`](#audit-w3-medium-cooldowns-and-lock-waits-burn-a-job-slot) | Medium | Worker | Cooldowns and lock waits block a concurrency slot doing nothing | Deprioritized; needs concurrency test harness |
| [`AUDIT-F23`](#audit-f23-medium-no-paint-region-redo-and-no-batch-redo) | Medium | Frontend | Redo is per-region and free-form only; no painted region, no batch | Feature |
| [`AUDIT-F22`](#audit-f22-medium-no-re-run-entire-chapter-action) | Medium | Frontend/Backend | Only "Force Re-export" / "Clear Exports"; no pipeline re-run | Feature |

### Layout quality

| ID | Sev | Component | Summary | State |
| :--- | :--- | :--- | :--- | :--- |
| [`AUDIT-R8`](#audit-r8-medium-text-under-fills-and-over-runs-its-balloon) | Medium | Render | Some balloons are half empty, others leak a line past the mask | Overlaps `AUDIT-R1` |
| [`AUDIT-R9`](#audit-r9-medium-neighbouring-text-boxes-are-allowed-to-overlap) | Medium | Render | Nothing checks box-vs-box collision at layout time | Design needed |
| [`AUDIT-R10`](#audit-r10-medium-overlapping-bubbles-are-erased-as-one) | Medium | Worker | Two touching balloons merge into one plate | Design needed |
| [`AUDIT-R12`](#audit-r12-medium-sfx-appear-to-shrink-neighbouring-balloons) | Medium | Worker | Hypothesis: an SFX overlapping a balloon truncates its mask | Needs measurement |

### Cosmetic & long tail

| ID | Sev | Component | Summary | State |
| :--- | :--- | :--- | :--- | :--- |
| [`AUDIT-F18`](#audit-f18-low-import-chapter-keeps-a-stale-chapter-number) | Low | Frontend | `useState(nextNum)` never re-syncs when the dialog reopens | **Fixed 2026-09-02** |
| [`AUDIT-F21`](#audit-f21-low-dark-mode-is-unpleasant-to-read) | Low | Frontend | Dark mode contrast is harsh | Ready |
| [`AUDIT-F9`](#audit-f9-low-responsive-layout-is-never-verified) | Low | Frontend | Responsive layout is never verified in tests | Blocked on Playwright |
| [`AUDIT-D5`](#audit-d5-low-no-memory-limits-on-auxiliary-containers) | Low | Docker | No memory limits on db, redis, minio, backend | Needs measured peak |
| [`AUDIT-T1`](#audit-t1-unranked-worker-e2e-test-suite-is-heavily-mocked) | Unranked | Testing | Worker "e2e" suite over-mocks with no real I/O assertions | Blocked on [mock_router.md](design/mock_router.md) |
| [`AUDIT-T4`](#audit-t4-unranked-nothing-proves-pagination-and-sort-against-a-real-database) | Unranked | Testing | Successor to the closed `AUDIT-T3`, refiled against the Rust handlers | Ready |

---
## 1. Seam 1 — the editor and the renderer disagree about what an element is

### `AUDIT-F14` (high): Rotating a box makes every save fail

- **Locations:** `backend-rust/src/routes/layers.rs:34-36` (the DTO),
  `frontend/src/utils/polygonUtils.ts:36-54` (`polygonBBox`),
  `frontend/src/components/Reader.tsx:1769-1783` (the rotation commit).
- **Problem:** `LayerElementInput` declares `maxWidth: Option<i32>` and `maxHeight: Option<i32>`.
  `rotatePoint` does trigonometry and does not round, so the bounding box of a rotated polygon has
  fractional width and height. `saveElementChanges` puts those straight into `maxWidth`/`maxHeight`.
  `serde_json` refuses a float for an `i32`, axum turns that into a `JsonRejection`, and the handler
  answers `error::unreadable_body` — a 400 the UI reports as "Error updating element on server".
- **Why only rotation:** the drag path rounds (`Reader.tsx:1336-1345`, `Math.round`) and the vertex
  reshape path rounds its vertices, so both produce integral boxes. Rotation is the one commit that
  does not, which is exactly the shape of the report — *changing the angle* fails, moving does not.
- **Fixed 2026-09-02.** The DTO takes a JSON number and rounds server-side
  (`deserialize_rounded_i32`), so no caller has to know the column is an integer; and the rotation
  commit now rounds the polygon *before* measuring it, which also stops the stored mask and the
  stored box drifting up to a pixel apart. Guarded by
  `accepts_the_fractional_box_a_rotation_produces` and
  `absent_and_null_box_dimensions_both_stay_none` in `layers.rs`.

### `AUDIT-R5` (high): The worker renderer has no concept of rotation

- **Locations:** `worker/src/worker/handlers/render.py` (the whole file),
  `frontend/src/components/Reader.tsx:1461-1485`.
- **Problem:** `grep -c rotation worker/src/worker/handlers/render.py` is **0**. The column exists in
  the schema, the reader draws it, the API round-trips it, and the renderer that produces every
  export ignores it. The frontend even bakes rotation into the mask polygon and resets the field to
  0 (`Reader.tsx:1475-1485`), so the *mask* rotates and the *text* does not.
- **Effect:** every angled box in a deliverable is axis-aligned — "translation flattens every image".
- **Next Step:** render the text into a transparent RGBA scratch layer, rotate it about the box
  centre, and composite. The erase plate already follows the mask polygon, so only the glyph pass
  needs the transform. Pair with `AUDIT-F14`, which is what makes the value reach the database.

### `AUDIT-R6` (medium): There is no vertical text mode

- **Locations:** `worker/src/worker/handlers/render.py`, `frontend/src/utils/fitText.ts`.
- **Problem:** Source text is frequently vertical; the fitter is horizontal-only. The report's
  workaround — rotate the box 90° — does not work, because of `AUDIT-R5`, and would be wrong anyway:
  rotated English is not vertical English, which stacks upright glyphs.
- **Next Step:** blocked on `AUDIT-R5` landing first; the transform machinery is shared.

### `AUDIT-F16` (medium): Text padding is a hardcoded constant

- **Locations:** `worker/src/worker/handlers/render.py:1135-1136`.
- **Problem:** `text_box_w = int((ew - 8) * 0.95)` — a 4px inset and a 5% margin, chosen once, applied
  to every element of every kind, and not applied at all on the frontend. There is no per-element or
  per-series control, so a caption that wants to breathe and a balloon that is already tight get the
  same treatment.
- **Note:** this is the *same constant* that `AUDIT-R1` measures as the 9.5% renderer disagreement.
  Fix them together: give the element a padding field, default it to today's effective value, and
  have both renderers read it. That closes R1 by construction rather than by agreeing on a number.

### `AUDIT-R7` (medium): A rectangle arrives as a 40-vertex polygon

- **Locations:** `worker/src/worker/services/bubble_detector.py:204-206`.
- **Problem:** `epsilon = 0.002 * cv2.arcLength(contour, True)` is roughly ten times tighter than the
  usual 0.01–0.02, so every pixel of anti-aliasing jitter along a straight edge survives
  `approxPolyDP`. A rectangular caption plate comes back with dozens of collinear vertices, which is
  what the screenshot shows: a box that should have four handles has about forty.
- **Cost:** it is not only ugly. Every vertex is a drag target in reshape mode, is stored in
  `mask_polygon`, is re-serialised on every save, and is walked by `mask_solidity` and the merge
  hull.
- **Next Step:** raise epsilon and add a collinearity pass, then a rectangle snap when the simplified
  hull is within tolerance of its own bounding box. Measure vertex counts before/after on the corpus;
  do not eyeball it — the tolerance that flattens jitter can also flatten a real balloon tail.

### `AUDIT-F15` (medium): A hidden element cannot be reached again

- **Locations:** `frontend/src/components/ReaderRightSidebar.tsx:1370-1373` (the visibility toggle),
  `:530` (layer-level visibility).
- **Problem:** The `visible` checkbox lives on the *selected* element's inspector, and selection
  happens by clicking the element on the canvas. Hiding it removes the only handle. The layer panel
  lists layers and element counts, never the elements themselves, so there is no list to select from.
- **Next Step:** make the layer row expand into its elements. That is also the prerequisite for
  `AUDIT-B12` being reviewable by hand — a QA-rejected element is a hidden element.

### `AUDIT-R1` (medium): The two renderers disagree by 9.5% of font size

- **Locations:** `worker/src/worker/handlers/render.py` (`render_image_core`, the `text_box_*`
  block) vs `frontend/src/components/Reader.tsx` (the `fitTextInBox` call).
- **Problem:** the worker insets the element box before fitting —
  `text_box_w = int((ew - 8) * 0.95)`, a 4px inset plus a 5% safety margin — and the frontend
  passes `element.maxWidth`/`maxHeight` raw. Same fitter, same fonts, different rectangle.

  Measured over a 300-element sample of the 400-export corpus:

  | | share of elements |
  | :--- | :--- |
  | frontend sets **larger** type | **272 (91%)** |
  | identical | 12 (4%) |
  | worker larger | 16 (5%) |

  Median frontend/worker font ratio **1.095**, mean 1.106.

  This is the whole of the reported "the reader always looks better than the export". It is not a
  quality difference between the implementations — it is one inset applied on one side.
- **Why it matters beyond looks:** the reader is a preview of an artifact it does not produce.
  Anything tuned by eye in the reader is tuned against the wrong geometry.
- **Next Step:** merged with `AUDIT-F16` — make the inset an element field both renderers read,
  rather than a constant one of them applies. Then [D8](render_quality_gap_2026-08-05.md#d8--the-two-renderers-disagree)
  becomes actionable: make the worker canonical and have the browser export fetch
  `/api/pages/{id}/rendered`, keeping the canvas path for live preview only.
- **Note on direction:** a backend *canvas* render is not required and would be a third
  implementation. The worker's PIL renderer is already the single-source candidate and already gets
  layer filtering right (see [`LOCK-2`](#lock-2--an-ocr-layer-never-reaches-an-export-whatever-the-reader-is-showing)).

---

## 2. Seam 2 — the canvas and the artifact are not connected

### `AUDIT-B15` (medium): The debounced re-render is one-shot and can lose an edit permanently

- **Correction, 2026-09-02.** This was first filed as "no edit anywhere enqueues a render job". That
  is **wrong** — I missed the sweeper. `recovery::process_pending_renders`
  (`backend-rust/src/jobs/recovery.rs:145-197`) runs every 5s (`jobs/mod.rs:34-40`), finds pages
  with `last_edited_at` older than 10s whose `last_rendered_at` predates the edit, and enqueues a
  render redo. `touch_page` is called from all six mutating layer routes. The link exists.
- **What is actually wrong with it.** The sweeper stamps `last_rendered_at = now()` at *enqueue*
  time (`recovery.rs:187`), not when the render lands, and it gates that on
  `trigger_page_redo(...).is_ok()` — which is not a real check, because `trigger_page_redo` returns
  `Ok(())` unconditionally after calling `enqueue_job_directly`, and `enqueue_job_directly` swallows
  its own insert failure with a `tracing::error!` and returns `()`.

  So the stamp says "rendered" the moment the job is *asked for*. If that job is then lost — the
  insert failed, the queue was cleared, the worker was down long enough for the row to exhaust its
  attempts — the page's `last_rendered_at` is already newer than its `last_edited_at`, the sweeper's
  own predicate excludes it forever, and that edit never renders again. There is no retry, because
  the only trigger is the predicate that was just falsified.
- **Why this is a plausible reading of the report** ("changes to the canvas are not synced to the
  rendered output like ever"): the failure is sticky. One lost render per page is enough to make the
  feature look permanently broken for that page, and editing more does not recover it — a *new*
  edit does re-arm the predicate, so the symptom is intermittent rather than total, which is exactly
  how it would be described.
- **Next Step:** stamp `last_rendered_at` from the render callback only — it already does this
  (`internal.rs:1157-1161` for the image, `coordinator.rs:2077-2082` for the page) — and give the
  sweeper a separate "render requested at" marker so it debounces without claiming completion.
  Make `trigger_page_redo` propagate the enqueue failure rather than returning `Ok(())` regardless.
- **Still needs a repro to confirm** this is the reported symptom and not a second cause. Capture a
  page where an edit did not reach `/rendered`, and compare its `last_edited_at`,
  `last_rendered_at`, and the status of its most recent `render` job.

### `AUDIT-B12` (medium): QA's verdicts never reach the rendered output

- **Locations:** `backend-rust/src/jobs/coordinator.rs` — `"render"` is enqueued in **exactly one
  place** (the end of `handle_translation_callback`), and `handle_render_callback` enqueues `qa`.
- **What the report said:** "If QA rejects a text box the mask is still kept so we have a blank box
  without any text", and separately "Rejected bubble should also hide their mask".
- **What it actually is.** Three suspects were checked and cleared first, which is worth recording
  because each looks like the obvious culprit:
  1. `render.py:1055-1057` skips an element with no text *before* it draws anything, so the worker
     never paints a plate with nothing on it.
  2. `paintLayerMask` (`frontend/src/utils/maskPaint.ts:60-72`) already refuses both an invisible
     element and a blank-text one, with a corpus measurement in the comment.
  3. The reader's SVG overlay filters on `element.visible` too.

  The renderers were right. **The pipeline order was wrong:** `translation → render → qa`. QA is
  the last stage that edits layers and it runs *after* the only render the page ever gets. So a
  `direct_fix` rewrote text that `/rendered` and the chapter ZIP kept showing uncorrected, and a
  `reject_sfx` hid an element the rendered PNG still had typeset. The reader looked right and the
  artifact did not — which from the outside is indistinguishable from "the mask is still kept".
- **Fixed 2026-09-02.** `handle_qa_callback` tracks whether it changed anything (`direct_fix`
  applied, or an element hidden) and, on the terminal branch, enqueues one more render carrying
  `finalPass: true`. `handle_render_callback` reads that flag off the job row and skips enqueuing
  QA, so the render→QA→render→QA loop cannot start. The flag rides the job payload rather than
  Redis so an eviction cannot leave the loop live.
- **Note:** human edits have their own path to a re-render (the 5s debounced sweeper), which is why
  this needed a fix of its own. QA is not an editor and never went through it. See
  [`AUDIT-B15`](#audit-b15-medium-the-debounced-re-render-is-one-shot-and-can-lose-an-edit-permanently)
  for the defect in that sweeper.

### `AUDIT-B16` (low): Region-redo layer provenance

- **Locations:** `backend-rust/src/jobs/coordinator.rs:2425-2503` (`create_region_redo_overlay`).
- **Problem:** The report says a translation region redo "doesn't make a new layer", but the attached
  screenshot shows a `Translation (region redo)` layer with 1 element sitting above an 11-element
  `Translation` layer — i.e. the layer *is* created. The likely real complaint is that the redo
  result does not become what the page shows or exports, which would make it indistinguishable from
  "no new layer" at the reader.
- **Next Step:** needs a repro before any code change. Capture the layer list, the element's
  `visible`/`region_id`, and what `/rendered` returns, on one page where this happens.

### `AUDIT-R11` (high): No texture-aware erasure (D1)

- **Locations:** the erasure path in `worker/src/worker/handlers/render.py`.
- **Problem:** Erasure is a flat colour fill over the balloon contour. It is fine on a white balloon
  and destroys anything else — screentone, gradient, hair, a busy panel. Restated from the field
  report as "there is no texture matching anywhere, we just sample and mask".
- **Status:** this is [D1](render_quality_gap_2026-08-05.md), already the largest item on the
  roadmap, already scoped, already the reason the 6.85%-vs-1.92% flattening gap exists. Filed here
  only so the field report maps cleanly onto the tracker. Do not start it before the seams above are
  closed — a better fill on a page whose edits never render is wasted.

---
## 3. Seam 3 — the UI does not believe the backend

### `AUDIT-F17` (high): The reader refreshes for four job types, on one page

- **Locations:** `frontend/src/components/Reader.tsx:523-570`.
- **Problem:** the SSE transport is healthy. `useSSE` reconnects with jittered backoff, the backend
  emits `job_update` on enqueue, on every worker status PATCH
  (`backend-rust/src/routes/internal.rs:148-165`) and on failure, and `NotificationContext` fans it
  out to subscribers. The reader then throws most of it away:

  ```ts
  const relevantTypes = ["ocr", "translation", "region-redo-ocr", "region-redo-tl"];
  ```

  1. **`qa`, `qa-re-ocr`, `render` and `layout` are not in the list.** QA rewrites text and hides
     elements — the last thing to touch a page before it is final — and never triggers a refresh.
  2. **The guard is `data.pageId === selectedPage.id || data.imageId === selectedPage.imageId`.**
     Updates for any other page are dropped on the floor rather than invalidating that page's cache
     entry, so the prefetched neighbour a reader is about to page into is stale by construction.
     This is the report's separate bullet, "if the reader is open and then pages other than the open
     one have layer updates they are not fetched".
- **Fixed 2026-09-02.** Inverted: any completion for any page drops that page's cache entry and
  bumps the epoch; only the *open* page additionally forces a visible reload. The allow-list is
  gone rather than extended — it is the wrong shape, since it goes stale silently every time a job
  type is added, which is how four of them came to be missing. Guarded by
  `refreshes on a qa completion...` and `drops a background page's cached details...` in
  `Reader.test.tsx`.

### `AUDIT-F19` (medium): Thumbnails and cards never re-poll

- **Locations:** `frontend/src/components/ChapterPageGrid.tsx`, `ChapterCardGrid.tsx`,
  `SeriesDetails.tsx`.
- **Problem:** Grids render whatever the initial fetch returned. Nothing subscribes to `job_update`,
  and there is no background poll, so a chapter that finishes translating while its page is open
  keeps showing untranslated thumbnails until a manual reload.
- **Next Step:** the same subscription `AUDIT-F17` needs. The report also asks for a per-page
  completion marker — a tick, or a small translated WebP — which is a separate, larger piece of work
  (it needs a rendered thumbnail variant); file the marker separately once the refresh works.

### `AUDIT-F20` (low): The Queue Manager sorts by chapter before status

- **Locations:** `frontend/src/components/QueueManager.tsx:552-600`.
- **Problem:** `statusOrder` gave `PROCESSING`, `PENDING` and `COMPLETED` **the same rank of 1**, so
  a job starting work did not move at all — it stayed wherever `createdAt` had put it. The
  group-ranking pass reads the same table, so a chapter with live work did not rise either. From
  the outside that is exactly the report: the queue neither prioritises active items nor appears to
  update. (`sortJobs` *is* re-run on every `job_update`; the sort just had nothing to say.)
- **Fixed 2026-09-02.** `PROCESSING` gets rank 0. `PENDING` and `COMPLETED` keep their tie
  deliberately — they swap as a page finishes, and separating them would make finished rows jump
  the queue on the way out — and `FAILED` stays last so a stuck row does not push live work down.

### `AUDIT-P10` (unranked): SSE → WebSocket

- **Report:** "SSE is ass let's move to WS".
- **Assessment — recommend not doing this, and here is the evidence.** Every concrete SSE complaint
  in the report is `AUDIT-F17`: a client-side type filter and a page guard. The transport delivered
  the events. Replacing it would mean rebuilding the ticket handshake (`AUDIT-S4`), the pending-
  notification replay through Redis, the jittered reconnect (`AUDIT-F3`), the visibility-aware
  backoff and the session-expiry path — all of which are load-bearing and all of which SSE gets for
  free from the browser's own `EventSource` reconnect.
- **The one thing WebSocket would buy** is a client→server channel, which nothing currently needs;
  the UI writes over REST.
- **Next Step:** fix `AUDIT-F17` first. If events still feel unreliable after that, reopen this with
  a measurement — dropped events per session, or reconnect frequency — not a preference.

---

## 4. Pipeline & scheduling

### `AUDIT-W13` (high): Context-injected translation runs in parallel

- **Locations:** `worker/src/worker/services/translation.py:1074-1108` (`build_context_string`),
  `worker/src/worker/concurrency.py:101-108` (`LIGHT_QUEUES` contains `queue:translation`),
  `:78-79` (four light slots by default).
- **Problem:** `build_context_string` injects `Previous Page Dialogue (in reading order)` — the
  translated text of page N−1 — into page N's prompt. Translation is a *light* queue with four
  slots, so pages N−1, N, N+1 and N+2 translate concurrently. Page N reads a previous page that has
  not been written yet, so the context is empty or stale for every page but the first.
- **Effect:** the feature the chapter header advertises as "Context Injection: Enabled" is, for most
  pages, off. Character names and honorifics drift exactly where the context was meant to hold them.
- **Next Step:** when a chapter has context injection enabled, its translation jobs need a chapter-
  scoped serial lane — a per-chapter lock or a dedicated single-slot queue — while OCR, layout,
  render and QA stay parallel. `utils/lock.py` already provides the primitive. **Watch out for
  `AUDIT-W3`:** a per-chapter lock held during a 10-minute LLM call would burn a light slot, so
  these two are now coupled and W3 stops being deferrable.

### `AUDIT-W14` (medium): The slot policy lets slow network work crowd out local work

- **Locations:** `worker/src/worker/concurrency.py:78-108`,
  `backend-rust/src/jobs/dispatcher.rs:143-200`.
- **Problem:** two things, both visible in the report's screenshot (three translations `PROCESSING`
  while OCR and layout sit `PENDING`):
  1. `MAX_LIGHT_SLOTS` defaults to `MAX_CONCURRENT_JOBS - MAX_HEAVY_SLOTS`. The comment above it
     records why (`AUDIT-W10`: the light tier was 4× slower than the heavy tier and the heavy slot
     idled 95.9% of the time). That was measured against a workload where light work was cheap. It
     no longer is — translation is now the slow stage.
  2. `Dispatcher::dispatch_slot` reads `/capabilities` **once per cycle** and then dispatches in a
     loop without decrementing the snapshot (`dispatcher.rs:143-152`). Within one cycle it can hand
     a worker more jobs than the worker said it could take.
- **Next Step:** decrement the capacity snapshot as jobs are dispatched — that one is unambiguous.
  The tier split is a *measurement* question, not a preference: re-run the W10 timing with the
  current model mix before moving the default. Do not "restore 2 light + 1 heavy" from memory; W10
  moved it deliberately and recorded why.

### `AUDIT-B13` (medium): A page with no translatable text fails the job

- **Locations:** `worker/src/worker/handlers/translation.py:359-405`,
  `backend-rust/src/jobs/coordinator.rs:1710-1735`.
- **Problem:** when every region on a page fails to translate, the worker posts the callback and then
  `raise RuntimeError(...)`. `process_job_rq` catches it and retries the whole job up to
  `maxAttempts` (3) before marking it `FAILED`. For a page whose only region was an SFX, a
  watermark, or an OCR misfire on a texture, that is three full LLM round-trips to arrive at a red
  row in the queue that the user must dismiss by hand.
- **Distinguish two cases:** *zero regions* is already handled correctly and quietly
  (`coordinator.rs:940-950` completes the job). *All regions failed* is the broken one.
- **Fixed 2026-09-02.** The worker stops raising (the callback already carries
  `allFailed`/`failedCount`/`totalCount`), and the coordinator completes the job with a `WARNING`
  notification — "No Translatable Text" — instead of marking it FAILED. Guarded by
  `test_a_page_with_nothing_translatable_finishes_instead_of_raising`.
- **Deliberately not distinguished:** a provider outage produces the same all-empty result here,
  because the service layer swallows transport errors into `None`. That is worth separating one
  day, but it does not change *this* decision: by this point every region has had three attempts,
  so a whole-job retry cannot help either case. The warning names the symptom, which is actionable
  for both.

### `AUDIT-B14` (medium): Delete then re-add leaves a chapter inconsistent

- **Locations:** `backend-rust/src/routes/page.rs:945-985` (`delete_page`), `:238-320`
  (`insert_page`, the two-phase renumber).
- **Problem:** the report describes three symptoms after deleting a page and re-uploading it: the
  chapter's page count does not update, the page is not reachable from the reader, and the old
  slot is still held so navigating there shows the loading screen forever.
- **Next Step:** needs a repro before a fix — the three symptoms could be one backend renumbering
  bug or one stale frontend list, and guessing between them wastes the fix. Reproduce with the page
  grid and the reader both open, and capture `GET /api/chapters/{id}/pages` alongside the reader's
  cache state.

### `AUDIT-W3` (medium): Cooldowns and lock waits burn a job slot

- **Locations:**
  - Provider cooldown sleep: `worker/src/worker/services/llm_client.py:118-125` (up to 60s)
  - Lock spin-wait: `worker/src/worker/utils/lock.py` (up to 600s)
  - Local AI per-endpoint timeout: `worker/src/worker/services/translation.py` (up to 10 min total)
- **Problem:** Three places block a worker thread while holding a concurrency slot. With
  `MAX_HEAVY_SLOTS=1`, a single provider cooldown or lock wait stalls all heavy pipeline work.
- **Status change 2026-09-02:** was "deprioritized by user decision". `AUDIT-W13`'s fix installs a
  per-chapter lock in the translation path, which is precisely the pattern this issue says is
  unsafe today. **W3 is now a prerequisite for W13**, not an independent nice-to-have.
- **Next Step / Blocker:** still needs real concurrency testing to prove that releasing a slot during
  a wait does not deadlock.

### `AUDIT-F23` (medium): No paint-region redo and no batch redo

- **Report:** "Need to add a paint region to redo OCR and TL (need to add a batch mode as well, not
  free-form like Torii)."
- **Locations:** the existing per-region redo is `coordinator.rs:2425` +
  `worker/src/worker/handlers/redo.py`.
- **Next Step:** feature work on top of the existing redo job types — a brush that produces a mask,
  and a multi-select that submits one job per selected region. No blocker; sequence after the seams.

### `AUDIT-F22` (medium): No "re-run entire chapter" action

- **Locations:** `frontend/src/components/ChapterHeader.tsx:455-475` (the overflow menu).
- **Problem:** the menu offers `Force Re-export` and `Clear Exports`, both of which act on artifacts,
  not on the pipeline. Re-running a chapter after a settings change means re-triggering each page.
- **Next Step:** an action that calls `start_pipeline` for every page in the chapter. Confirm first —
  it is expensive and it discards existing layers.

---

## 5. Layout quality

### `AUDIT-R8` (medium): Text under-fills and over-runs its balloon

- **Evidence:** the report's third screenshot, with balloon masks colourised. Several balloons are
  half empty; others push a line past the mask edge.
- **Relationship to `AUDIT-R1`:** partly the same cause — the reader and the worker fit against
  different rectangles, so what looks correct in one is wrong in the other. Do not open this as
  separate work until `AUDIT-R1`/`AUDIT-F16` have landed and the remainder has been re-measured on
  the corpus.

### `AUDIT-R9` (medium): Neighbouring text boxes are allowed to overlap

- **Problem:** layout places each element from its own region geometry. Nothing checks a box against
  its neighbours, so two close regions can produce two boxes that intersect and print over each
  other.
- **Next Step:** a post-layout collision pass. Note the constraint from
  [`LOCK-1`](#lock-1--free-standing-text-keeps-its-columns-height-it-is-never-squared-into-a-box):
  resolving a collision by shrinking a box is fine, resolving it by *moving* a box onto artwork
  is not.

### `AUDIT-R10` (medium): Overlapping bubbles are erased as one

- **Locations:** `worker/src/worker/services/merge_regions.py:65-82` (`_merged_mask_polygon`).
- **Problem:** when two balloons touch, the merge takes the convex hull of both polygons. The hull of
  two overlapping ellipses covers the artwork in the notches between them, so the erase plate eats
  page it does not own.
- **Next Step:** union rather than hull for the mask, keeping the hull only for the text box. The
  renderer already fills a polygon; a multi-polygon is the schema change.

### `AUDIT-R12` (medium): SFX appear to shrink neighbouring balloons

- **Report hypothesis:** "because of SFX (hypothesis) sometimes bubbles don't reach their full size";
  the screenshot shows two tall balloons whose text sets in a narrow column.
- **Assessment:** plausible mechanism is an SFX region overlapping the balloon and truncating the
  detected mask, but this has not been measured, and the same screenshot is equally consistent with
  a narrow `safe_rect` from `YOLO_MASK_EROSION` (`bubble_detector.py:210-218`).
- **Next Step:** measure before fixing. On the corpus, compare balloon mask area with and without an
  overlapping SFX region present. Two hypotheses, one cheap query.

---

## 6. Cosmetic & long tail

### `AUDIT-F18` (low): Import Chapter keeps a stale chapter number

- **Locations:** `frontend/src/components/ImportChapterDialog.tsx:36`.
- **Problem:** `const [chapterNum, setChapterNum] = useState(nextNum)`. `useState` takes its argument
  only on the first render. The dialog is mounted once and toggled with `open`, so after importing
  chapter 3 the next open still proposes 3. The `useEffect` at `:88` already re-syncs
  `useFallbackModels` on open and simply does not do the same for the number.
- **Fixed 2026-09-02.** Re-syncs `chapterNum` and `title` on open, and — following what
  `CreateChapterDialog` already does — asks the server for the highest chapter number rather than
  trusting `nextNum`, which is derived from one 15-row page of chapters and is simply wrong on a
  longer series.

### `AUDIT-F21` (low): Dark mode is unpleasant to read

- **Locations:** `frontend/src/hooks/useColorMode.ts` and the theme definition.
- **Problem:** reported as harsh. The primary reading device is a tablet, often at night.
- **Next Step:** soften surface contrast and desaturate accents in the dark scheme. Cosmetic, no
  blocker, low risk — but it is *not* free of judgement, so change tokens rather than component
  styles so it can be reverted in one place.

### `AUDIT-F9` (low): Responsive layout is never verified

- **Locations:** `frontend/src/` — no test file uses `useMediaQuery`, `theme.breakpoints`, or mocks
  `window.matchMedia`.
- **Problem:** the primary reading device is an Android tablet and no automated test checks
  responsive rendering or touch drawer behaviour at tablet viewports.
- **Next Step / Blocker:** jsdom does not calculate CSS layout. Needs a real-browser smoke test via
  Playwright.

### `AUDIT-D5` (low): No memory limits on auxiliary containers

- **Locations:** `docker-compose.yml` — only the worker has a `deploy.resources.limits` block.
- **Problem:** `db`, `redis`, `minio` and `backend` have no memory ceiling.
- **Next Step / Blocker:** sizing requires a measured peak under load; guessing risks OOM-kills
  during batch ingestion.

### `AUDIT-T1` (unranked): Worker e2e test suite is heavily mocked

- **Locations:** `worker/tests/test_translation_flow_e2e.py`
- **Problem:** 19 `@patch` decorators and 4 assertions, none inspecting translated text, region IDs,
  layer geometry or cost. Suite-wide, **407** `@patch` calls across the worker tests, running fast
  because they touch no real I/O or network contract.
- **Next Step / Blocker:** blocked on [mock_router.md](design/mock_router.md).

### `AUDIT-T4` (unranked): Nothing proves pagination and sort against a real database

- **Successor to `AUDIT-T3`**, which named `@WebMvcTest` classes the Rust rewrite deleted. The gap it
  described came back with the new handlers: `backend-rust/src/routes/page.rs:652-675` builds its
  `ORDER BY` and `LIMIT/OFFSET` by string interpolation, and nothing exercises it against Postgres.
- **Next Step:** cover it with a database-backed integration test, alongside the `max-page-size`
  clamp that `AUDIT-B11` installed.

---
## Recently Closed Items (Reference)

| ID | Summary | Closed Date | Resolution Details |
| :--- | :--- | :--- | :--- |
| `AUDIT-F14` | Rotating a text box made every save 400 | 2026-09-02 | `maxWidth`/`maxHeight` were `Option<i32>` and a rotated bounding box is fractional, so serde rejected the whole body. DTO rounds server-side; the rotation commit rounds the polygon before measuring it. |
| `AUDIT-F17` | The reader refreshed for four job types, on one page | 2026-09-02 | An allow-list that had gone stale (`qa`, `qa-re-ocr`, `render`, `layout` all missing) plus a guard that dropped every page but the open one. Allow-list removed; any completion invalidates the page it names. |
| `AUDIT-B12` | QA's verdicts never reached the rendered output | 2026-09-02 | The pipeline renders before it runs QA, and nothing re-rendered. QA now enqueues one `finalPass` render, which does not re-enter QA. |
| `AUDIT-B13` | A page with no translatable text failed the job | 2026-09-02 | Worker raised, costing three whole-job retries and a red queue row, for pages whose only region was an SFX or an OCR misfire. Completes with a `WARNING` notification now. |
| `AUDIT-F20` | The Queue Manager never moved active jobs up | 2026-09-02 | `PROCESSING` shared sort rank 1 with `PENDING` and `COMPLETED`, so starting work did not move a row. |
| `AUDIT-F18` | Import Chapter kept a stale chapter number | 2026-09-02 | `useState(nextNum)` only read its argument on first mount. Re-syncs on open and asks the server for the true maximum. |
| `AUDIT-Q1` | ~253 redundant `Objects.requireNonNull` calls | 2026-09-02 | **Obsolete.** All four named files lived under `backend/src/main/java/`, deleted by the Rust rewrite. `docker-compose.yml` builds `backend-rust/Dockerfile`. Nothing to clean up. |
| `AUDIT-Q2` | Inline fully-qualified class names in controllers | 2026-09-02 | **Obsolete.** Same cause as `AUDIT-Q1` — `SeriesController.java` and `PageController.java` no longer exist. |
| `AUDIT-T3` | `@WebMvcTest` cannot verify Spring Data sort composition | 2026-09-02 | **Obsolete as written** — the test classes are gone with the Java tree. The underlying gap is real against the Rust handlers and is refiled as [`AUDIT-T4`](#audit-t4-unranked-nothing-proves-pagination-and-sort-against-a-real-database). |
| `AUDIT-R2` | Free-standing captions typeset outside their erased plate | 2026-08-29 | `free_text_box` squared a 91×293 column into 186×187, discarding erased height for artwork it did not own; 329 of 552 free-floating corpus elements had text on bare art. Fixed in `abdcce2` + worker `55dc693`. See [`LOCK-1`](#lock-1--free-standing-text-keeps-its-columns-height-it-is-never-squared-into-a-box). |
| `AUDIT-R3` | OCR layers leaked into frontend exports | 2026-08-29 | Export filtering was gated on the `cleanScanlationView` overlay toggle, so a view setting decided a file's contents. See [`LOCK-2`](#lock-2--an-ocr-layer-never-reaches-an-export-whatever-the-reader-is-showing). |
| `AUDIT-B10` | `listPages` sort parameter validation | 2026-08-16 | Switched to explicit `sortDir` parameter and safe `Sort.by(direction, "pageNumber")` in commit `94bd792`. See [history.md](archive/history.md). |
| `AUDIT-B11` | Unbounded `?size=2000` pagination bypass | 2026-08-07 | Configured `spring.data.web.pageable.max-page-size: 100` in `application.yml`. See [history.md](archive/history.md). |
| `AUDIT-F10–F12` | Pagination hook bugs (sort drift, unbounded walk, refcount) | 2026-08-07 | Fixed in `usePaginatedResource.ts` with 8 new unit tests. See [history.md](archive/history.md). |
| `AUDIT-L1–L8` | Logging and observability audit | 2026-08-15 | Standardized trace IDs, MDC logging, log level filters, rotation caps, and Grafana dashboard. See [history.md](archive/history.md). |

---

*For full history of all closed items, see [docs/archive/history.md](archive/history.md).*
