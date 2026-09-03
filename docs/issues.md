# Issues & Technical Debt

> **Standing: 104 filed, 79 closed, 25 open.** Six items were added 2026-09-03 from the Codex
> review of the fix stack — `AUDIT-R13`, `AUDIT-R14`, `AUDIT-F25`, `AUDIT-F26`, `AUDIT-F27` and
> `AUDIT-T5`, all in [Open Review Findings](#open-review-findings-prs-118-124-2026-09-03). Note
> `AUDIT-F26` disputes the `AUDIT-F19` fix; verify it before trusting that row.
>
> Re-audited 2026-09-02 against the field report in
> `new issues.pdf`. Three previously-open items were closed as *obsolete* — they described Java
> files the Rust rewrite deleted. Twenty-nine new items are filed (two, `AUDIT-B17` and
> `AUDIT-F24`, found while fixing another), and sixteen are already fixed: `AUDIT-F14`,
> `AUDIT-F15`, `AUDIT-F16`, `AUDIT-F17`, `AUDIT-F18`, `AUDIT-F19`, `AUDIT-F20`, `AUDIT-F21`,
> `AUDIT-B12`, `AUDIT-B13`, `AUDIT-B17`, `AUDIT-R1`, `AUDIT-R5`, `AUDIT-R7`, `AUDIT-T4`,
> `AUDIT-W13`.
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
| [`AUDIT-R5`](#audit-r5-high-rotation-turned-the-plate-and-left-the-glyphs-level) | High | Render/Frontend | The plate turned, the glyphs stayed level, and the box inflated on every turn — in the reader as well as the export | **Fixed 2026-09-03** |
| [`AUDIT-R6`](#audit-r6-medium-there-is-no-vertical-text-mode) | Medium | Render | No vertical setting; rotation is the only workaround and it does not render | Design needed |
| [`AUDIT-F16`](#audit-f16-medium-text-padding-was-a-hardcoded-constant) | Medium | Render/Frontend | Padding was `(ew - 8) * 0.95`, hardcoded and unreachable | **Fixed 2026-09-03** |
| [`AUDIT-R7`](#audit-r7-medium-a-rectangle-arrived-as-a-40-vertex-polygon) | Medium | Worker | The simplification tolerance was a fraction of the *perimeter*, so small shapes got a sub-pixel tolerance and kept every vertex | **Fixed 2026-09-03** |
| [`AUDIT-F15`](#audit-f15-medium-a-hidden-element-could-not-be-reached-again) | Medium | Frontend | Hiding an element removed the only way to select it | **Fixed 2026-09-03** |
| [`AUDIT-R1`](#audit-r1-medium-four-answers-to-what-rectangle-does-text-go-in) | Medium | Render | Four different fitted rectangles — the live reader used none at all | **Fixed 2026-09-03** |

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
| [`AUDIT-F19`](#audit-f19-medium-thumbnails-and-cards-never-re-poll) | Medium | Frontend | Thumbnails, chapter cards and series cards never refresh after work completes | **Fixed 2026-09-03** |
| [`AUDIT-F20`](#audit-f20-low-the-queue-manager-sorts-by-chapter-before-status) | Low | Frontend | `PROCESSING` shared a sort rank with `PENDING`, so active jobs never moved | **Fixed 2026-09-02** |
| [`AUDIT-P10`](#audit-p10-unranked-sse--websocket) | Unranked | Platform | Proposal to replace SSE with a WebSocket | Not accepted; see the entry |

### Pipeline & scheduling

| ID | Sev | Component | Summary | State |
| :--- | :--- | :--- | :--- | :--- |
| [`AUDIT-W13`](#audit-w13-high-context-injected-translation-ran-in-parallel) | High | Worker/Backend | "Previous page dialogue" was read while the previous page was still translating — and `COALESCE` handed back its Japanese | **Fixed 2026-09-02** |
| [`AUDIT-W14`](#audit-w14-medium-the-slot-policy-lets-slow-network-work-crowd-out-local-work) | Medium | Worker/Backend | Four light slots + a per-cycle capacity snapshot; OCR waits behind LLM calls | Needs measurement |
| [`AUDIT-B17`](#audit-b17-low-jobspage_id-was-never-written) | Low | Backend | `jobs.page_id` existed, was deserialised, and was never populated by the INSERT | **Fixed 2026-09-03** |
| [`AUDIT-B18`](#audit-b18-low-there-is-no-schema-migration-runner) | Low | Backend | `init.sql` only runs on a fresh volume, so no column can ever be added to a live deployment | Ready |
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
| [`AUDIT-F21`](#audit-f21-low-dark-mode-is-unpleasant-to-read) | Low | Frontend | Dark mode measured at 19:1 body contrast with 84–100% saturated accents | **Fixed 2026-09-03** |
| [`AUDIT-F24`](#audit-f24-low-the-dark-palette-is-maintained-twice) | Low | Frontend | `theme.ts` and `index.css` are two hand-kept copies of one palette | Ready |
| [`AUDIT-F9`](#audit-f9-low-responsive-layout-is-never-verified) | Low | Frontend | Responsive layout is never verified in tests | Blocked on Playwright |
| [`AUDIT-D5`](#audit-d5-low-no-memory-limits-on-auxiliary-containers) | Low | Docker | No memory limits on db, redis, minio, backend | Needs measured peak |
| [`AUDIT-T1`](#audit-t1-unranked-worker-e2e-test-suite-is-heavily-mocked) | Unranked | Testing | Worker "e2e" suite over-mocks with no real I/O assertions | Blocked on [mock_router.md](design/mock_router.md) |
| [`AUDIT-T4`](#audit-t4-unranked-nothing-proves-pagination-and-sort-against-a-real-database) | Unranked | Testing | Successor to the closed `AUDIT-T3`; the tests found two live defects | **Fixed 2026-09-03** |

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

### `AUDIT-R5` (high): Rotation turned the plate and left the glyphs level

- **Corrected 2026-09-03.** First filed as "`render.py` never reads `rotation`". Literally true —
  `grep -c rotation` was 0 — but not the cause, and acting on it would have fixed nothing.
- **What is actually going on.** `layer_elements.rotation` is, in practice, **always 0**:
  - the pipeline's element INSERT (`coordinator.rs`) omits the column entirely;
  - OCR emits `"rotation": 0.0` at every one of its five call sites;
  - `handleEnterReshapeMode` explicitly wrote `rotation: 0`, on the reasoning that the angle had
    been "baked into the polygon";
  - the rotation handle never wrote the field at all.

  What the handle *did* write was the rotated `maskPolygon` **and the bounding box of that rotated
  polygon** into `x`/`y`/`maxWidth`/`maxHeight`. Two consequences, both visible on a page:
  1. **The plate turns and the text does not.** The mask polygon is page-space, so the erase plate
     tilts correctly. The glyphs are typeset into the axis-aligned box. And the frontend canvas
     skipped `ctx.rotate` under `if (!el.maskPolygon)` — precisely when the user *had* rotated
     something, because the rotation handle only exists in reshape mode and reshape mode requires a
     polygon. So this was broken in the reader too, not just the export. That is why the report says
     "we **can't** place our text at an angle" rather than "the export loses my angle".
  2. **The box inflates every time you turn it.** A 45°-rotated 100×20 box has an 85×85 bounding
     box. The fitter then sized text for a rectangle that no longer matched the plate, and because a
     rotated bbox is fractional, every field in the inspector filled with values like
     `828.5163351` — which is also what made the save 400 before
     [`AUDIT-F14`](#audit-f14-high-rotating-a-box-makes-every-save-fail).
- **Fixed 2026-09-03.** `rotation` becomes what it always claimed to be — the element's angle:
  - `x`/`y`/`maxWidth`/`maxHeight` describe the **unrotated** box and the rotation handle no longer
    touches them; it accumulates the angle into `rotation` (folded into `[0, 360)`) and rotates only
    the mask polygon.
  - `handleEnterReshapeMode` stops zeroing the field. Only the *outline* was ever baked; the text
    has no polygon, so zeroing it silently straightened every rotated element the moment it was
    reshaped.
  - Both canvas paths and the SVG overlay rotate the glyphs whether or not a polygon exists. In the
    SVG the whole group turns and the polygon carries a counter-rotation about the same centre, so
    it nets to identity — everything else in that group (backdrop rect, editor borders, drag handle,
    text) is in unrotated box space and should turn.
  - `paintLayerMask` and `render.py` turn the **box** fill with the element and leave the **polygon**
    fill alone. Filling the box axis-aligned beside a turned mask is what laid a straight white
    rectangle across artwork on every rotated caption.
  - `render.py` draws the lines level onto a transparent tile and rotates the tile, rather than
    rotating coordinates — so the glyphs themselves turn. The tile is sized from the actual line
    placements unioned with the box, because `fit` may produce a line wider than the box and a tile
    cut to the box would crop exactly the overflow the halo exists to make readable. PIL turns
    counter-clockwise where SVG/canvas turn clockwise, so the angle is negated; guarded by
    `test_rotate_point_deg_turns_clockwise_like_the_editor`.
- **The first attempt did not work, and shipped that way for a day.** Everything described above
  landed, but `handleRotationDragStart` never initialised `rotationDrag.originalRotation` — the
  initialiser was written into `setDraggedVertex`, which has no such field. Every drag therefore
  computed `undefined + deltaAngle`, and `normalizeDegrees` mapped the NaN to 0. The polygon
  turned; the angle persisted as zero; the defect was exactly as reported. Caught by the Codex
  review of PR #118, fixed on 2026-09-03.

  **The lesson is not "add a rotation test".** TypeScript already rejected both halves — a missing
  required property on one setter, an excess one on the other — and nothing ran it, because
  `npm run build` is `vite build` and `tsc` appeared nowhere in `package.json` or the workflows.
  The unit tests this work added could not see it either: they test `normalizeDegrees` in
  isolation, and `normalizeDegrees(NaN) === 0` made the NaN path read as deliberate. See
  `AUDIT-T5`.
- **Backward compatible.** Every existing row has `rotation` 0 or NULL, so nothing re-renders
  differently until something is actually rotated.
- **Not covered here:** existing elements whose box was already inflated by the old handle keep
  that box. Re-rotating them does not shrink it back — the original box is not recoverable from
  what was stored. Nudging a vertex in reshape mode re-derives it.

### `AUDIT-R6` (medium): There is no vertical text mode

- **Locations:** `worker/src/worker/handlers/render.py`, `frontend/src/utils/fitText.ts`.
- **Problem:** Source text is frequently vertical; the fitter is horizontal-only. The report's
  workaround — rotate the box 90° — does not work, because of `AUDIT-R5`, and would be wrong anyway:
  rotated English is not vertical English, which stacks upright glyphs.
- **Next Step:** blocked on `AUDIT-R5` landing first; the transform machinery is shared.

### `AUDIT-F16` (medium): Text padding was a hardcoded constant

- **Problem:** `text_box_w = int((ew - 8) * 0.95)` — a 4px inset and a 5% margin, chosen once,
  applied to every element of every kind, unreachable from anywhere, and *not applied at all* on the
  frontend. A caption that wants to breathe and a balloon that is already tight got the same
  treatment, and there was no dial.
- **Fixed 2026-09-03**, as one change with [`AUDIT-R1`](#audit-r1-medium-four-answers-to-what-rectangle-does-text-go-in),
  because agreeing on a number and being able to change it are the same problem: the reason there
  were four rectangles is that each side owned its own literal.
- **Stored as two global settings** (`textBoxPaddingPx`, `textBoxSafetyPercent`) in the existing
  `system_settings` key/value table — **no schema change**, so no migration risk on a running
  deployment. Surfaced in the Settings dialog, sent to the worker on the job payload, and read by
  the reader from `/api/settings`.
- **Clamped on every boundary** (0–64px, 1–100%): a 0% margin, or a padding wider than half the
  box, fits every element into a zero-width rectangle — a typo in a settings form would otherwise
  stop the whole library typesetting.
- **The DTO fields deserialize with `serde(default)`**, because the struct is both the GET response
  and the PUT body: a browser holding an older bundle must still be able to save its settings
  rather than getting a 400 for omitting a field it has never heard of.
- **Not done:** *per-element* padding. That needs a column on `layer_elements`, and there is no
  migration runner — `init.sql` only runs on a fresh volume, so a new column would break every
  existing deployment until one exists. Filed as [`AUDIT-B18`](#audit-b18-low-there-is-no-schema-migration-runner).

### `AUDIT-B18` (low): There is no schema migration runner

- **Locations:** `database/init.sql` (a `pg_dump`, mounted at `docker-entrypoint-initdb.d`),
  `backend-rust/src/db.rs:48` (`build_postgres_url`, marked "consumed by migration tooling in an
  upcoming slice"), and a vestigial `flyway_schema_history` table from the Java era.
- **Problem:** `init.sql` runs **only on a fresh Postgres volume**. There is no path that applies a
  schema change to a database that already exists, so any new column silently breaks every running
  deployment — `SELECT *` into a struct expecting it fails at runtime.
- **Consequence today:** it is a hard ceiling on design. `AUDIT-F16` wanted per-element padding and
  took a global setting instead; `AUDIT-B17` was fixable only because the column already existed.
- **Next Step:** `sqlx::migrate!` is already a dependency-compatible option and `build_postgres_url`
  was written for it. Small, but it must land before anything that needs a column.

### `AUDIT-R7` (medium): A rectangle arrived as a 40-vertex polygon

- **Locations:** `worker/src/worker/services/bubble_detector.py`, `handlers/ocr.py`
  (`get_split_polygon`, the unmatched-bubble search, `cover_balloon_polygon`),
  `services/merge_regions.py` (`_merged_mask_polygon`).
- **The interesting cause.** Every contour was simplified with
  `epsilon = 0.002 * cv2.arcLength(contour, True)` — a tolerance **proportional to the perimeter**.
  That is backwards:

  | outline | old tolerance |
  | :--- | :--- |
  | 3000px-perimeter balloon | 6.0px — fine |
  | 800px-perimeter bubble | 1.6px — adequate |
  | **200px-perimeter caption plate** | **0.4px — below one pixel, so nothing was removed** |

  The smaller and simpler the shape, the tighter the tolerance it was held to. That is precisely
  why the shapes that should have come back as four points were the worst offenders.
- **The second cause.** `cover_balloon_polygon` samples every corner with the same `corner_steps`
  however small its radius, so a synthesized plate around a short caption was **28 points by
  construction** — which is the screenshot.
- **Cost:** every vertex is a drag target in reshape mode, is stored in `mask_polygon`, is
  re-serialised on every save, and is walked by `mask_solidity` and the merge hull.
- **Fixed 2026-09-03.** One `simplify_mask_polygon` at an **absolute** 2px tolerance
  (`MASK_POLYGON_TOLERANCE_PX`, env-overridable), applied at all four sites. At any size that
  flattens rasterisation jitter along a straight edge, while a balloon's tail — which sticks out
  far more than 2px, that being the point of a tail — survives untouched. Measured on synthetic
  contours: a jittery rectangle goes 56 → 4 points, a circle with a tail 38 → 19 with the tail
  intact.
- **Both directions are pinned by tests**, because a tolerance loose enough to flatten jitter is
  also loose enough to flatten a feature: `test_a_rectangle_comes_back_as_a_rectangle`,
  `test_a_balloon_tail_survives_because_it_is_not_jitter`, and
  `test_the_old_relative_tolerance_is_what_made_small_shapes_worst`, which pins the old epsilon
  below 1px and shows the jitter surviving it.
- **`_merged_mask_polygon` had no simplification at all** — the convex hull of several rounded
  outlines carries every point that happens to be extreme. It goes through the same tolerance now.
- **Not done:** snapping a near-rectangular hull to its own bounding box. The simplifier gets a
  rectangle to four points already, and a snap would be the step that could square away a shape
  that is *nearly* a rectangle but deliberately is not.

### `AUDIT-F15` (medium): A hidden element could not be reached again

- **Locations:** `frontend/src/components/ReaderRightSidebar.tsx:1370-1373` (the visibility toggle),
  `:530` (layer-level visibility).
- **Problem:** The `visible` checkbox lives on the *selected* element's inspector, and selection
  happens by clicking the element on the canvas. Hiding it removes the only handle. The layer panel
  lists layers and element counts, never the elements themselves, so there is no list to select from.
- **Fixed 2026-09-03.** The layer row's element count is now an expander, and the list under it
  gives every element a click-to-select row and its own visibility toggle. The row header also
  reports how many of the layer's elements are hidden, so a page is not silently missing text with
  nothing to say so.
- **Needed a new handler, not the existing one.** `handleUpdateSelectedElement` can only act on
  whatever is selected, which is the circularity that made hiding one-way.
  `handleSetElementVisibility` takes the element by identity instead.
- **This is also what makes [`AUDIT-B12`](#audit-b12-medium-qas-verdicts-never-reach-the-rendered-output)
  reviewable by hand** — a QA-rejected element is a hidden element, and until now there was no way
  to look at one and disagree.

### `AUDIT-R1` (medium): Four answers to "what rectangle does text go in?"

- **Locations:** `worker/src/worker/handlers/render.py` (`text_box_*`) and **three** call sites in
  `frontend/src/components/Reader.tsx`.
- **Filed as "the two renderers disagree". It was worse than that — the frontend disagreed with
  itself:**

  | caller | rectangle |
  | :--- | :--- |
  | the live reader (SVG overlay) | the **raw box** — no inset at all |
  | the reader's PNG export | box inset by 4px |
  | the reader's ZIP export | box inset by 4px |
  | `render.py`, which produces every real artifact | box inset by 4px, then × 0.95 |

  The one with no inset is the one on screen — the surface the typesetting was being judged on.
- **Measured** over a 300-element sample of the 400-export corpus:

  | | share of elements |
  | :--- | :--- |
  | frontend sets **larger** type | **272 (91%)** |
  | identical | 12 (4%) |
  | worker larger | 16 (5%) |

  Median frontend/worker font ratio **1.095**. That is the whole of the reported "the reader always
  looks better than the export" — not a quality difference between implementations, one inset
  applied on one side.
- **Fixed 2026-09-03, together with [`AUDIT-F16`](#audit-f16-medium-text-padding-was-a-hardcoded-constant).**
  One definition per language — `textFitBox` in `frontend/src/utils/textFitBox.ts` and
  `text_fit_box` in `render.py` — both driven by the same two settings, and **both asserted against
  the same parity table with the same numbers**. They are in different languages and nothing else
  can catch them drifting apart, which is precisely how there came to be four.
- **Parity was closed by giving the reader the worker's rectangle, not the reverse.** The margin
  exists to stop glyphs touching the balloon outline; it belongs on both sides rather than neither.
- **Consequence to expect:** type in the reader gets *smaller*, because the reader was the one
  being generous. It now matches what ships.
- **Next Step (unchanged):** with the two agreeing,
  [D8](render_quality_gap_2026-08-05.md#d8--the-two-renderers-disagree) becomes actionable — make
  the worker canonical and have the browser export fetch `/api/pages/{id}/rendered`, keeping the
  canvas path for live preview only. A backend *canvas* render is still not required and would be
  a third implementation.

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
  applied, or an element hidden) and enqueues one more render carrying `finalPass: true`.
  `handle_render_callback` reads that flag off the job row and skips enqueuing QA, so the
  render→QA→render→QA loop cannot start. The flag rides the job payload rather than Redis so an
  eviction cannot leave the loop live.
- **Three things the first cut got wrong**, caught in review on
  [#115](https://github.com/sagniKdas53/manga-tl/pull/115):
  1. **The manual-review path skipped the render.** One QA response can carry both an accepted
     `direct_fix` on region A *and* `needsManualIntervention` on region B. That returns
     `MANUAL_REVIEW` from an earlier branch, so the accepted edits — already written to the layers —
     never reached the artifact and nothing would come back for them. Halting means "stop
     translating", not "leave the export disagreeing with the layers". Both terminal branches
     render now.
  2. **The retry path still does not, deliberately.** A retry re-runs translation (or `qa-re-ocr`,
     which leads back to translation) and the translation callback renders on its own, so a render
     here would be thrown away and would race the retranslation about to rewrite the same layers.
  3. **"Page Processing Complete" fired before the render landed.** The QA callback announced
     corrections the exported PNG did not yet carry, and could not retract the claim if that render
     then failed. When QA defers to a final render the claim moves with it: the job carries
     `completesPipeline`, the render callback emits the notification once the artifact matches, and
     a *failed* final render emits `Re-render Failed` rather than silence. A manual-review render
     carries `completesPipeline: false` — it re-renders, but nothing is complete, so it claims
     nothing.
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
- **Fixed 2026-09-03.** One `PipelineRefreshWatcher` subscribes to `job_update` for the whole app
  and refetches the three paginated resources — series, chapters, pages — when work lands. It sits
  in `App.tsx` next to `TranslationToastWatcher` rather than in the grids, because all three grids
  read from `usePaginatedResource` hooks that already live at that level, and one subscription that
  fans out cannot go stale the way three independent ones would.
- **Coalesced, deliberately.** A finishing chapter emits a `job_update` per page per stage, so a
  naive refetch would fire dozens of times in a few seconds and each one is three HTTP round trips.
  The watcher debounces on a 4s trailing timer, so a burst of any size costs exactly one refresh
  after the burst goes quiet. It also filters to `COMPLETED` and `FAILED` — `PENDING` and
  `PROCESSING` change no row a grid renders, and a failure has to reach the grid so a red page does
  not read as still-working.
- **Still open, filed separately:** the report also asks for a per-page completion marker — a tick,
  or a small translated WebP thumbnail. That is a larger piece of work needing a rendered thumbnail
  variant the backend does not produce, and it is not blocked by anything here now that the refresh
  is honest. Guarded by five tests in `PipelineRefreshWatcher.test.tsx`, including the burst that
  must collapse to one call and the unmount that must not fire afterwards.

### `AUDIT-F20` (low): The Queue Manager sorts by chapter before status

- **Locations:** `frontend/src/components/QueueManager.tsx:552-600`.
- **Problem:** `statusOrder` gave `PROCESSING`, `PENDING` and `COMPLETED` **the same rank of 1**, so
  a job starting work did not move at all — it stayed wherever `createdAt` had put it. The
  group-ranking pass reads the same table, so a chapter with live work did not rise either. From
  the outside that is exactly the report: the queue neither prioritises active items nor appears to
  update. (`sortJobs` *is* re-run on every `job_update`; the sort just had nothing to say.)
- **Fixed 2026-09-02.** `PROCESSING` gets its own top rank. `PENDING` and `COMPLETED` keep their
  tie deliberately — they swap as a page finishes, and separating them would make finished rows jump
  the queue on the way out — and `FAILED` stays last so a stuck row does not push live work down.
- **The first cut inverted the fix**, caught in review. It used `PROCESSING: 0`, and both lookups
  read the table as `statusOrder[status] || 99` — a `0` rank is falsy, so a running job took the
  *unknown-status* fallback and sorted below even `FAILED`. Ranks now start at 1 so no rank is
  falsy, and the lookups use `?? 99` as well. Guarded by
  `puts a running job at the top of its chapter, above pending and failed`, which asserts rendered
  row order and fails on the `0`/`||` combination.

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

### `AUDIT-W13` (high): Context-injected translation ran in parallel

- **Locations:** `backend-rust/src/routes/internal.rs:415-429` (the context query),
  `worker/src/worker/services/translation.py:1074-1108` (`build_context_string`),
  `worker/src/worker/concurrency.py:101-108` (`queue:translation` is a LIGHT queue), `:78-79`
  (four light slots by default).
- **Problem:** a chapter with `use_context_memory` on has every page's translation prompt prefixed
  with the previous page's dialogue. Nothing made the previous page finish first. Four light slots
  meant four consecutive pages translated at once, so for every page but the first the prefix was
  read while its source was still in flight.
- **It is worse than a missing prefix.** The context query is
  `SELECT COALESCE(translated_text, text) FROM ocr_regions WHERE page_id = (… page_number = $2)`.
  An untranslated predecessor therefore hands back its **Japanese source text**, and the prompt
  labels it `Previous Page Dialogue (in reading order):`. The model is shown untranslated Japanese
  presented as the established English. A feature the chapter header advertises as "Context
  Injection: Enabled" was, for every page but the first, either inert or actively misleading —
  which is the mechanism behind character names and honorifics drifting exactly where the context
  was meant to hold them.
- **Fixed 2026-09-02**, in the dispatcher (`jobs/dispatcher.rs`). Before handing a
  `queue:translation` job to a worker, `earlier_page_is_still_translating` asks whether any earlier
  page of the same chapter still has an outstanding job. If so the job goes back to the **back** of
  its queue and that queue's drain stops for the cycle — the same shape, and the same reason, as
  the existing undispatchable path (`AUDIT-P3`). Going to the back is what lets the queue sort
  itself: a page that *is* ready surfaces next cycle instead of queueing behind a blocked one.
- **Three decisions inside that, each of which looks arbitrary without the reason:**
  1. **Gated in the dispatcher, not the worker.** A per-chapter lock taken inside the worker is
     the obvious alternative and would have held a light slot for the entire wait — exactly the
     failure `AUDIT-W3` describes. A job held here simply stays in Redis and costs nothing.
     **This is why W13 did *not* end up depending on W3**, contrary to how it was first filed.
  2. **Blocks on `panel-detection`, `ocr` and `layout` as well as `translation`.** Pages move
     through the pipeline at different rates — that is why they were parallel in the first place —
     so an earlier page still sitting in OCR has *no translation job to find*. Gating on
     translation alone would wave the later page straight through, which is the common case rather
     than an edge one. Guarded by
     `a_context_injecting_chapter_translates_strictly_in_page_order`, which seeds exactly that
     shape and fails without the wider predicate.
  3. **Does not block on `render` or `qa`.** QA's `direct_fix` can still rewrite an earlier page's
     `translated_text` after this page has read it, so the ordering is not absolute. Blocking on QA
     would serialise every chapter's whole pipeline end to end for the sake of small text
     corrections. The report asked for the TL phase to be sequential and the rest to stay parallel;
     this is that line, drawn deliberately.
- **Fails open, by design.** No row (context injection off, page gone) and any database error both
  read as "not blocked" — a gate that cannot answer must not stall the pipeline. A predecessor
  wedged in `PROCESSING` cannot deadlock a chapter either: the 5-minute stale sweep in
  `recovery.rs` returns it to PENDING or fails it, and a FAILED job is neither PENDING nor
  PROCESSING. A page that produced no OCR regions never enqueues a translation, so it never blocks
  the pages after it.
- **Two holes found in review** on [#116](https://github.com/sagniKdas53/manga-tl/pull/116):
  1. **Joining blockers through `image_id` let a page block itself.** Uploading the same file twice
     into one chapter is a supported path — `upload_page` appends a second page at `max+1` pointing
     at the *existing* image row — so one `image_id` can belong to two pages of one chapter. The
     later page's own job then matched the earlier page, satisfied `prev.page_number <
     me.page_number`, and requeued itself forever: a hard deadlock on a shape duplicate and blank
     pages produce routinely. Blockers are attributed by **page** now, which required fixing
     [`AUDIT-B17`](#audit-b17-low-jobspage_id-was-never-written) first. Rows predating that have a
     NULL `page_id` and simply do not block — the fail-open direction.
  2. **A PENDING job that never reached Redis blocked the chapter forever.** The insert and the
     Redis push are two steps; if the push fails, the row stays PENDING with nothing to pick it up,
     because the stale sweep only looks at PROCESSING and `requeue_pending_jobs` only runs at
     startup or on resume. That hole predates this gate, but the gate turned "one page never
     finishes" into "every later page of the chapter waits behind it". A new 2-minute sweep,
     `recovery::requeue_orphaned_pending_jobs`, puts such rows back on their queue.
     `started_at IS NULL` is what separates orphaned from in-flight.

### `AUDIT-B17` (low): `jobs.page_id` was never written

- **Locations:** `backend-rust/src/jobs/coordinator.rs:558-570` (the INSERT),
  `backend-rust/src/models.rs:314` (the field).
- **Problem:** the column exists, `Job` deserialises it, and nothing populates it. Every row read
  back from the database has `pageId: null`. Only the enqueue-time `JobRowSnapshot`
  (`coordinator.rs:591`) carries a real page id, so the `job_update` SSE emitted on enqueue has one
  and the identical-looking event emitted from `internal.rs` on every worker status change does
  not.
- **Consequence today:** consumers have to fall back to `imageId`, which is why the `AUDIT-F17`
  fix resolves a page by either key. Nothing is broken by it, but it is a trap: the obvious code
  (`WHERE page_id = …`) silently matches nothing.
- **Fixed 2026-09-03.** `enqueue_job_directly` has already resolved `page_opt` by the time it
  inserts, so the value was simply not being bound. Promoted from "ready" to done because
  `AUDIT-W13`'s ordering gate needs to attribute a blocking job to one page, and image identity
  cannot do that — see the deadlock recorded there.

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
- **Status 2026-09-02:** still deprioritized, and still independent. It was briefly filed as a
  prerequisite for `AUDIT-W13` on the assumption that W13 needed a per-chapter lock inside the
  worker. It did not — W13 gates in the dispatcher instead, so no slot is held while a job waits,
  and the two issues stayed uncoupled.
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
- **And a race that came with it**, caught in review: the lookup is asynchronous and its `cancelled`
  guard only fires when the effect tears down — closing the dialog — never on typing. A slow
  response therefore landed on top of a number the user had deliberately chosen. A touched-flag
  now blocks the write. **`CreateChapterDialog` had the identical defect**, under a comment
  claiming the protection it did not provide; fixed there too rather than left next to the one
  being fixed.

### `AUDIT-F21` (low): Dark mode is unpleasant to read

- **Locations:** `frontend/src/theme.ts` (`colorSchemes.dark`), `frontend/src/index.css` (`:root`).
- **Problem:** reported as harsh; the primary reading device is a tablet, often at night. It
  measured that way, and the numbers point at the opposite of the obvious diagnosis — the scheme
  was not short of contrast, it had far too much. Body text was `#fefefe` on `#0f0f0f`:
  **19.0:1**, against 4.5:1 for WCAG AA and 7:1 for AAA. Past roughly 15:1 on an emissive panel
  the extra ratio stops buying legibility and starts blooming the glyph edges, which is what
  "harsh" describes. Every accent also ran **84–100% saturation**, and a saturated hue on a
  near-black field is the pairing that appears to vibrate.
- **Two smaller defects fell out of measuring it.** `background.paper` and `background.default`
  were **1.15:1** apart, so a card had almost no edge of its own and the whole page read as one
  black field — nothing for the eye to rest on, which makes glare worse, not better. And
  `primary` (`#ee2553`) on `paper` was **3.99:1**, *below* AA: the link and button colour was the
  least legible text in the scheme while everything around it was over-bright.
- **Fixed 2026-09-03.** The floor comes off pure black (`#16161a`), white pulls back to a warm
  off-white (`#e2e0dd`, **13.7:1** — still clear of AAA), surfaces separate to 1.20:1, and every
  accent drops ~20 saturation points with its **hue unchanged**, so nothing changes identity.
  `primary` lands at 4.78:1 on paper, above AA for the first time.
- **Guarded in both directions**, which is the unusual part: `theme.test.ts` asserts an AA floor
  *and* a halation ceiling, so the failure it prevents is someone "improving" contrast back to
  white-on-black. Ten tests, all of which fail against the old palette.
- **Two hardcoded component colours folded back into tokens** — `MuiTableCell` had literal
  `#e0e0e0`/`#333333` borders, so the one place the scheme is meant to be tunable did not reach
  the densest tables in the app; both follow `palette.divider` now. The dark `MuiPaper` shadow
  came down from 0.4 to 0.28 black, since a black shadow under a near-black surface reads as
  grime rather than elevation.

### `AUDIT-F24` (low): The dark palette is maintained twice

- **Locations:** `frontend/src/theme.ts` (`colorSchemes.dark`), `frontend/src/index.css` (`:root`).
- **Problem:** found while fixing `AUDIT-F21`. Parts of the app are styled through MUI's `sx` and
  read `theme.palette.*`; other parts are plain CSS reading `--bg-base`, `--text-main` and
  friends. Those are two hand-maintained copies of one palette with nothing tying them together,
  and they **had already drifted**: base was `#111111` in the CSS against `#0f0f0f` in the theme,
  body text `#f3f4f6` against `#fefefe`. Neither file is wrong read on its own, which is exactly
  why it survived — each looks self-consistent.
- **Contained for now, not closed.** `AUDIT-F21` set the two files equal and added a parity test
  over the six shared tokens, so an edit to one now fails until the other follows. That stops the
  drift; it does not remove the duplication.
- **Next Step:** point the CSS variables at MUI's generated `--mui-palette-*` custom properties,
  which `cssVariables: true` already emits, and delete the hand-written values. The care needed is
  in the tokens that have *no* MUI equivalent (`--bg-canvas`, the `*-glow` overlays) and in the
  `:root.light` block, which would become mostly redundant.

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

- **Successor to `AUDIT-T3`**, which named `@WebMvcTest` classes the Rust rewrite deleted. The gap
  it described came back with the new handlers: `list_pages`, `list_chapters` and `list_series` all
  build their `ORDER BY` and `LIMIT/OFFSET` by string interpolation into a `format!`.
- **The filing was half wrong, and the correction matters.** `series_endpoints.rs` *did* cover
  `list_series` — the sort whitelist, the `sortDir` flip, the envelope shape. What had nothing at
  all were the two endpoints the reader actually walks: `list_chapters` and `list_pages`.
- **The interpolation is not the defect,** and the new tests do not pretend otherwise: the
  direction is a literal, the column comes off a whitelist, and the sizes are clamped `i64`s. What
  was unproven is that it *composes* — that a window is the window it claims to be, that the clamp
  survives the round trip, and that the arithmetic holds at the edges.
- **Fixed 2026-09-03.** `backend-rust/tests/pagination_sort.rs`, seven tests against a real
  Postgres. Rows are seeded through SQL (uploads need MinIO, and none of this is about image
  storage) and deliberately inserted **out of order**, so "sorted by page number" cannot pass by
  accident on a small unindexed scan that happens to return insertion order.
- **They found two live defects**, which is the argument for the whole item:
  - **`page * size` overflowed.** Both are `i64` and only `page` was bounded — below, not above.
    `?page=9223372036854775807&size=100` panicked into the catch-panic layer and answered **500**
    in debug; in release it wraps to a *negative* `OFFSET`, Postgres rejects the query, and the
    handler's `unwrap_or_default()` serves that rejection as an **empty list beside an honest
    `totalElements`** — worse than an error, because it looks like an answer. `offset()` saturates
    now, in both `Pagination` types.
  - **`sortDir=DESC` sorted ascending.** The match was on the literal `"desc"`, but Spring's
    `Sort.Direction.fromString` is case-insensitive, so the Java backend honoured it. A silent
    parity break that answers 200 with plausible-looking data. Compared case-insensitively now.
- **Not fixed, and deliberately:** `unwrap_or_default()` on the row queries still converts any
  database error into an empty page. The overflow was the only known way to reach it, so this is
  now unreachable rather than handled; making list handlers distinguish "no rows" from "the query
  failed" is a wider change than this item, and is worth its own pass.

---
## Open Review Findings (PRs #118-#124, 2026-09-03)

The Codex review of the 2026-09-02 fix stack raised fifteen findings. The six on PRs #115 and #116
were addressed on the branch. Four P1s were addressed on 2026-09-03 (the `AUDIT-R5` wiring above,
and the three folded into `AUDIT-F16`/`AUDIT-R1`). **These five P2s are not fixed** and are
recorded here because the PR threads close when the stack merges.

Severities are the reviewer's. Where an entry is marked *unverified* the claim has been read but
not reproduced.

### `AUDIT-R13` (medium): Reshape controls are drawn at twice the rotation

In reshape mode `currentPolygon`, its vertex circles and the rotation handle are already in
absolute page coordinates, but the enclosing group transform rotates them again; only the backdrop
polygon carries the inverse. Entering reshape on a 30°-rotated element is reported to draw its
controls at 60°, so vertex and rotation drags act from misleading positions. Frontend,
`Reader.tsx`. *Unverified.*

### `AUDIT-R14` (medium): A vertex drag re-derives the box from an already-rotated polygon

Once an element has both a nonzero `rotation` and a rotated page-space polygon, a vertex drag
assigns `polygonBBox(newPoly)` to `x`/`y`/`maxWidth`/`maxHeight` while keeping the angle. That is
the axis-aligned bounds of an already-rotated outline, which the renderer then rotates a second
time — the box inflation `AUDIT-R5` removed, reintroduced through the reshape path. Undo
reconstructs the same wrong box. Frontend, `Reader.tsx`. *Unverified.*

### `AUDIT-F25` (low): A null `visible` is hidden on the canvas and visible in the sidebar

`visible` is nullable in the database and `Option<bool>` in the model. The canvas and the new
hidden-count treat `null` as hidden; the sidebar's toggle treats it as visible, so it offers "Hide
element" and writes `false`, and the first click cannot restore the element. One falsy check, or
normalise on read. Frontend, `ReaderRightSidebar.tsx`. *Unverified.*

### `AUDIT-F26` (medium): The grid refresh re-fetches DTOs that cannot show pipeline state

Successor to `AUDIT-F19`, which is marked fixed on the strength of the refetch firing. The reviewer
argues the refetch cannot change anything: `/pages` returns the same original `/thumbnail` URL
backed by `thumbnail_storage_path`, and the chapter and series DTOs carry no job status, so React
receives identical props and image `src`. Pipeline output appears through `/rendered`. If that
holds, the untranslated grid still does not update and `AUDIT-F19` is not closed — the refresh
needs a pipeline-visible status or a rendered-thumbnail URL with a cache key. **Verify before
trusting the `AUDIT-F19` fix.** Frontend/Backend, `App.tsx` + `page.rs`. *Unverified.*

### `AUDIT-F27` (medium): The pipeline refresh debounce assumes events arrive close together

`PipelineRefreshWatcher` debounces on a four-second timer. Completions spaced further apart than
that — serialized context-aware translation, which `AUDIT-W13` deliberately made the norm — each
fire their own timer, so a long chapter performs one full loaded-window refresh per page rather
than one per burst, and `refresh()` requests every loaded pagination batch. Wants a bounded
maximum cadence or a real pipeline-terminal signal. Frontend, `PipelineRefreshWatcher.tsx`.
*Unverified.*

### `AUDIT-T5` (medium): Nothing typechecks the frontend

`npm run build` is `vite build`, which strips types without checking them, and `tsc` appears in
neither `frontend/package.json` nor any workflow. The `AUDIT-R5` wiring defect was two hard
TypeScript errors that reached `main`'s doorstep with every check green. `tsc -b --noEmit`
currently reports 80 errors — 24 in application source, 56 in tests — which is why the gate could
not simply be switched on with the fix.

---

## Recently Closed Items (Reference)

| ID | Summary | Closed Date | Resolution Details |
| :--- | :--- | :--- | :--- |
| `AUDIT-F14` | Rotating a text box made every save 400 | 2026-09-02 | `maxWidth`/`maxHeight` were `Option<i32>` and a rotated bounding box is fractional, so serde rejected the whole body. DTO rounds server-side; the rotation commit rounds the polygon before measuring it. |
| `AUDIT-F17` | The reader refreshed for four job types, on one page | 2026-09-02 | An allow-list that had gone stale (`qa`, `qa-re-ocr`, `render`, `layout` all missing) plus a guard that dropped every page but the open one. Allow-list removed; any completion invalidates the page it names. |
| `AUDIT-B12` | QA's verdicts never reached the rendered output | 2026-09-02 | The pipeline renders before it runs QA, and nothing re-rendered. QA now enqueues one `finalPass` render, which does not re-enter QA. |
| `AUDIT-B13` | A page with no translatable text failed the job | 2026-09-02 | Worker raised, costing three whole-job retries and a red queue row, for pages whose only region was an SFX or an OCR misfire. Completes with a `WARNING` notification now. |
| `AUDIT-F20` | The Queue Manager never moved active jobs up | 2026-09-02 | `PROCESSING` shared sort rank 1 with `PENDING` and `COMPLETED`, so starting work did not move a row. |
| `AUDIT-R1` + `AUDIT-F16` | Four answers to "what rectangle does text go in?" | 2026-09-03 | The live reader used the raw box, the frontend's exports insetted 4px, and `render.py` insetted 4px then took 95%. One definition per language now, both driven by the same two settings and asserted against the same parity table. |
| `AUDIT-F15` | A hidden element could not be reached again | 2026-09-03 | The `visible` toggle lived on the selected element's inspector and selecting meant clicking it on the canvas, so hiding was a one-way door. The layer panel lists elements now, each selectable with its own toggle. |
| `AUDIT-F19` | Thumbnails and cards never re-polled | 2026-09-03 | Grids rendered whatever the first fetch returned; nothing subscribed to `job_update` and nothing polled, so a chapter that finished while its page was open kept showing untranslated thumbnails until a manual reload. One app-level watcher refreshes all three grids, debounced 4s so a finishing chapter's burst costs one refetch. |
| `AUDIT-F21` | Dark mode was unpleasant to read | 2026-09-03 | Not short of contrast — it had far too much. Body text measured 19.0:1 against a 7:1 AAA threshold, which blooms glyph edges on a tablet at night, and every accent ran 84–100% saturation. Surfaces lifted, white pulled back to 13.7:1, accents desaturated at unchanged hue. Two side findings fixed with it: cards were 1.15:1 from the page behind them, and `primary` on `paper` was 3.99:1, below AA. |
| `AUDIT-T4` | Nothing proved pagination and sort against a real database | 2026-09-03 | The filing was half wrong — `list_series` was covered; `list_chapters` and `list_pages`, the two the reader walks, had nothing. Seven tests against real Postgres, seeding rows out of order so a missing `ORDER BY` cannot pass. They found two live defects: `page * size` overflowed to a 500 (or, in release, a silent empty page), and `sortDir=DESC` sorted ascending. |
| `AUDIT-R7` | A rectangle arrived as a 40-vertex polygon | 2026-09-03 | The simplification tolerance was `0.002 × perimeter`, which is 0.4px on a small caption plate — below one pixel, so nothing was removed. Smaller shapes got tighter tolerances. Now an absolute 2px everywhere, plus the synthesized cover plate (28 points by construction) and the merge hull (never simplified at all). |
| `AUDIT-R5` | Rotation turned the plate and left the glyphs level | 2026-09-03 | `rotation` was effectively always 0: the handle wrote the angle into the mask polygon and the *bounding box of that polygon* into x/y/w/h instead. So the plate tilted, the text stayed level (in the reader too — the canvas skipped `ctx.rotate` exactly when a polygon existed), and the box inflated on every turn. `rotation` is the angle now and the box is left alone. |
| `AUDIT-B17` | `jobs.page_id` was never written | 2026-09-03 | The column existed and `Job` deserialised it, but the INSERT omitted it, so every row read back had `pageId: null` and the obvious `WHERE page_id = …` matched nothing. Fixed because `AUDIT-W13`'s gate must attribute a blocker to one page. |
| `AUDIT-W13` | Context-injected translation ran in parallel | 2026-09-02 | Four light slots translated four consecutive pages at once, so each read a predecessor still in flight — and because the context query is `COALESCE(translated_text, text)`, that predecessor handed back its Japanese source labelled as the previous page's dialogue. Gated in the dispatcher, so no slot is held while a job waits. |
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
