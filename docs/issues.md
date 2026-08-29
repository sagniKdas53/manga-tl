# Issues & Technical Debt

> **Standing: 68 filed, 61 closed, 7 open.** No critical or high-severity items open.
>
> - **Resolved items** move to [docs/archive/history.md](archive/history.md) with root cause, fix details, and measurements.
> - **Feature roadmap & active milestones** are tracked in [TODO.md](../TODO.md).
> - **Visual rendering defects (D1–D16)** are tracked in [docs/render_quality_gap_2026-08-05.md](render_quality_gap_2026-08-05.md).
> - **Architectural proposals & RFCs** live in [docs/design/](design/).
> - **[Locked decisions](#locked-decisions)** are settled deliberately and must not be reverted as
>   "cleanup". Read that section before changing anything it names.

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

| ID | Severity | Component | Summary | Status / Blocker |
| :--- | :--- | :--- | :--- | :--- |
| [`AUDIT-R1`](#audit-r1-medium--the-two-renderers-disagree-by-95-of-font-size) | Medium | Render | Frontend sets 9.5% larger type than the worker, so the reader always looks better than the export | Ready: close the inset gap, then make the worker canonical (D8) |
| [`AUDIT-W3`](#audit-w3-medium--cooldowns-and-lock-waits-burn-a-job-slot) | Medium | Worker | Cooldowns and lock waits block a concurrency slot doing nothing | Deprioritized; needs concurrency test harness |
| [`AUDIT-F9`](#audit-f9-low--responsive-layout-is-never-verified) | Low | Frontend | Responsive layout (tablet viewports) is never verified in tests | Blocked on Playwright real-browser test suite |
| [`AUDIT-D5`](#audit-d5-low--no-memory-limits-on-auxiliary-containers) | Low | Docker | No memory limits on db, redis, minio, or backend containers | Needs measured memory peak under load |
| [`AUDIT-T1`](#audit-t1-unranked--worker-e2e-test-suite-is-heavily-mocked) | Unranked | Testing | Worker "e2e" test suite over-mocks with no real I/O assertions | Blocked on [mock_router.md](design/mock_router.md) |
| [`AUDIT-T3`](#audit-t3-unranked--webmvctest-cannot-verify-spring-data-sort-composition) | Unranked | Testing | `@WebMvcTest` with mocked repos cannot prove Spring Data sort composition | Needs `@SpringBootTest` + Testcontainers |
| [`AUDIT-Q1`](#audit-q1-unranked--redundant-objectsrequirenonnull-calls) | Unranked | Code Quality | ~253 redundant `Objects.requireNonNull` calls guarding literals & locals | Ready for mechanical cleanup pass |
| [`AUDIT-Q2`](#audit-q2-low--inline-fully-qualified-class-names-in-controllers) | Low | Code Quality | Inline fully-qualified class names instead of imports in controllers | Fold into `AUDIT-Q1` pass |

---

## 1. Worker & Concurrency

### `AUDIT-W3` (medium): Cooldowns and lock waits burn a job slot

- **Locations:**
  - Provider cooldown sleep: `worker/src/worker/core/llm_client.py:93-100` (up to 60s)
  - Lock spin-wait: `worker/src/worker/utils/lock.py:21-26` (up to 600s)
  - Local AI per-endpoint timeout: `worker/src/worker/services/translation.py:576` (up to 10 min total)
- **Problem:** Three places block a worker thread while holding a concurrency slot. With `MAX_HEAVY_SLOTS=1`, a single provider cooldown or lock wait stalls all heavy pipeline work. (Light jobs are isolated since `AUDIT-W10` raised light slots to 4).
- **Next Step / Blocker:** Deprioritized by user decision. Fixing this requires real concurrency testing to ensure releasing slots during waits does not introduce deadlock or race conditions.

---

## 2. Rendering Parity

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
  quality difference between the implementations — it is one inset applied on one side. Fuller
  balloons read as better typesetting, so the frontend wins on sight every time.

- **Why it matters beyond looks:** the reader is a preview of an artifact it does not produce.
  Anything tuned by eye in the reader is tuned against the wrong geometry.
- **Next Step:** decide which rectangle is correct and apply it on both sides — the margin exists
  to stop glyphs touching the balloon outline, so it probably belongs in both rather than neither.
  Once the two agree, [D8](render_quality_gap_2026-08-05.md#d8--the-two-renderers-disagree) becomes
  actionable: make the worker canonical and have the browser export fetch
  `/api/pages/{id}/rendered` (which `handleExportRenderedPng` already does), keeping the canvas
  path for live preview only.
- **Note on direction:** a backend *canvas* render is not required and would be a third
  implementation. The worker's PIL renderer is already the single-source candidate, is already
  authoritative for the chapter ZIP and `/rendered`, and is already the one that gets layer
  filtering right (see [`LOCK-2`](#lock-2--an-ocr-layer-never-reaches-an-export-whatever-the-reader-is-showing)).

---

## 2b. Frontend & UI

### `AUDIT-F9` (low): Responsive layout is never verified

- **Locations:** `frontend/src/` (all 47 test files run at an implicit default viewport; `window.matchMedia` is not mocked).
- **Problem:** Zero tests use `useMediaQuery` or `theme.breakpoints`. The primary reading device is an Android tablet, but no automated test checks responsive rendering or touch drawer behavior at tablet viewport sizes.
- **Next Step / Blocker:** jsdom does not calculate CSS layout. Needs a real-browser smoke test via Playwright.

---

## 3. Docker & Infrastructure

### `AUDIT-D5` (low): No memory limits on auxiliary containers

- **Locations:** `docker-compose.yml` (`database`, `redis`, `minio`, `backend`).
- **Problem:** While the worker container is explicitly capped (2 CPUs / 4 GB based on measured 2.1 GiB peak), the database, cache, storage, and backend containers have no memory ceilings.
- **Next Step / Blocker:** Deprioritized. Sizing memory limits requires measured peak usage under load (cgroups v2 lacks simple `memory.peak` without continuous sampling) to avoid risking container OOM-kills under heavy batch ingestion.

---

## 4. Testing & Test Doubles

### `AUDIT-T1` (unranked): Worker e2e test suite is heavily mocked

- **Locations:** `worker/tests/test_translation_flow_e2e.py`
- **Problem:** The supposed "e2e" test carries 19 `@patch` decorators and 4 assertions, none of which inspect translated text, region IDs, layer geometry, or cost calculations. Suite-wide, 358 `@patch` calls exist across 55 test files, running in ~6.6s while touching no real I/O or network contracts.
- **Next Step / Blocker:** Blocked on building [mock_router.md](design/mock_router.md) (a deterministic OpenAI/Anthropic wire-compatible test double).

### `AUDIT-T3` (unranked): `@WebMvcTest` cannot verify Spring Data sort composition

- **Locations:** `backend/src/test/java/com/manga/library/controller/PageControllerTest.java`, `SeriesControllerTest.java`
- **Problem:** `@WebMvcTest` with mocked repositories verifies controller response JSON shapes and argument resolvers (like `max-page-size` from `AUDIT-B11`), but cannot verify how Spring Data derives queries, resolves complex `Pageable` parameters, or composes caller `Sort` with repository `OrderBy` clauses.
- **Next Step:** Cover repository-backed pagination and sorting using `@SpringBootTest` + Testcontainers (following the pattern in `PipelineFlowIntegrationTest.java`).

---

## 5. Code Hygiene

### `AUDIT-Q1` (unranked): Redundant `Objects.requireNonNull` calls

- **Locations:** Concentrated in:
  - `backend/src/main/java/com/manga/library/service/JobCoordinatorService.java` (64 calls)
  - `backend/src/main/java/com/manga/library/controller/PageController.java` (38 calls)
  - `backend/src/main/java/com/manga/library/controller/SeriesController.java` (30 calls)
  - `backend/src/main/java/com/manga/library/controller/LayerController.java` (28 calls)
- **Problem:** ~253 `Objects.requireNonNull` checks repo-wide guard freshly instantiated objects, string literals, or already-validated local variables.
- **Next Step:** Execute a mechanical cleanup pass to delete dead null-checks without altering business logic.

### `AUDIT-Q2` (low): Inline fully-qualified class names in controllers

- **Locations:** `SeriesController.java` (12 instances) and `PageController.java` (15 instances).
- **Problem:** Controllers write out verbose inline package paths (e.g. `com.manga.library.dto.PagedResponse<...>`) rather than standard imports.
- **Next Step:** Fold into the `AUDIT-Q1` controller cleanup pass.

---

## Recently Closed Items (Reference)

| ID | Summary | Closed Date | Resolution Details |
| :--- | :--- | :--- | :--- |
| `AUDIT-R2` | Free-standing captions typeset outside their erased plate | 2026-08-29 | `free_text_box` squared a 91×293 column into 186×187, discarding erased height for artwork it did not own; 329 of 552 free-floating corpus elements had text on bare art. Fixed in `abdcce2` + worker `55dc693`. See [`LOCK-1`](#lock-1--free-standing-text-keeps-its-columns-height-it-is-never-squared-into-a-box). |
| `AUDIT-R3` | OCR layers leaked into frontend exports | 2026-08-29 | Export filtering was gated on the `cleanScanlationView` overlay toggle, so a view setting decided a file's contents. See [`LOCK-2`](#lock-2--an-ocr-layer-never-reaches-an-export-whatever-the-reader-is-showing). |
| `AUDIT-B10` | `listPages` sort parameter validation | 2026-08-16 | Switched to explicit `sortDir` parameter and safe `Sort.by(direction, "pageNumber")` in commit `94bd792`. See [history.md](archive/history.md). |
| `AUDIT-B11` | Unbounded `?size=2000` pagination bypass | 2026-08-07 | Configured `spring.data.web.pageable.max-page-size: 100` in `application.yml`. See [history.md](archive/history.md). |
| `AUDIT-F10–F12` | Pagination hook bugs (sort drift, unbounded walk, refcount) | 2026-08-07 | Fixed in `usePaginatedResource.ts` with 8 new unit tests. See [history.md](archive/history.md). |
| `AUDIT-L1–L8` | Logging and observability audit | 2026-08-15 | Standardized trace IDs, MDC logging, log level filters, rotation caps, and Grafana dashboard. See [history.md](archive/history.md). |

---

*For full history of all 59 closed items, see [docs/archive/history.md](archive/history.md).*
