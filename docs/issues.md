# Issues & Technical Debt

> **Standing: 66 filed, 59 closed, 7 open.** No critical or high-severity items open.
>
> - **Resolved items** move to [docs/archive/history.md](archive/history.md) with root cause, fix details, and measurements.
> - **Feature roadmap & active milestones** are tracked in [TODO.md](../TODO.md).
> - **Visual rendering defects (D1–D16)** are tracked in [docs/render_quality_gap_2026-08-05.md](render_quality_gap_2026-08-05.md).
> - **Architectural proposals & RFCs** live in [docs/design/](design/).

---

## Open Issues Summary

| ID | Severity | Component | Summary | Status / Blocker |
| :--- | :--- | :--- | :--- | :--- |
| [`AUDIT-W3`](#audit-w3-medium--cooldowns-and-lock-waits-burn-a-job-slot) | Medium | Worker | Cooldowns and lock waits block a concurrency slot doing nothing | Deprioritized; needs concurrency test harness |
| [`AUDIT-F9`](#audit-f9-low--responsive-layout-is-never-verified) | Low | Frontend | Responsive layout (tablet viewports) is never verified in tests | Blocked on Playwright real-browser test suite |
| [`AUDIT-D5`](#audit-d5-low--no-memory-limits-on-auxiliary-containers) | Low | Docker | No memory limits on db, redis, minio, or backend containers | Needs measured memory peak under load |
| [`AUDIT-T1`](#audit-t1-unranked--worker-e2e-test-suite-is-heavily-mocked) | Unranked | Testing | Worker "e2e" test suite over-mocks with no real I/O assertions | Blocked on [mock_router.md](design/mock_router.md) |
| [`AUDIT-T3`](#audit-t3-unranked--webmvctest-cannot-verify-spring-data-sort-composition) | Unranked | Testing | `@WebMvcTest` with mocked repos cannot prove Spring Data sort composition | Needs `@SpringBootTest` + Testcontainers |
| [`AUDIT-Q1`](#audit-q1-unranked--redundant-objectsrequirenonnull-calls) | Unranked | Code Quality | ~253 redundant `Objects.requireNonNull` calls guarding literals & locals | Ready for mechanical cleanup pass |
| [`AUDIT-Q2`](#audit-q2-low--inline-fully-qualified-class-names-in-controllers) | Low | Code Quality | Inline fully-qualified class names instead of imports in controllers | Fold into `AUDIT-Q1` pass |

---

## 1. Worker & Concurrency

### `AUDIT-W3` (medium) — Cooldowns and lock waits burn a job slot

- **Locations:**
  - Provider cooldown sleep: `worker/src/worker/core/llm_client.py:93-100` (up to 60s)
  - Lock spin-wait: `worker/src/worker/utils/lock.py:21-26` (up to 600s)
  - Local AI per-endpoint timeout: `worker/src/worker/services/translation.py:576` (up to 10 min total)
- **Problem:** Three places block a worker thread while holding a concurrency slot. With `MAX_HEAVY_SLOTS=1`, a single provider cooldown or lock wait stalls all heavy pipeline work. (Light jobs are isolated since `AUDIT-W10` raised light slots to 4).
- **Next Step / Blocker:** Deprioritized by user decision. Fixing this requires real concurrency testing to ensure releasing slots during waits does not introduce deadlock or race conditions.

---

## 2. Frontend & UI

### `AUDIT-F9` (low) — Responsive layout is never verified

- **Locations:** `frontend/src/` (all 47 test files run at an implicit default viewport; `window.matchMedia` is not mocked).
- **Problem:** Zero tests utilize `useMediaQuery` or `theme.breakpoints`. The primary reading device is an Android tablet, but no automated test checks responsive rendering or touch drawer behavior at tablet viewport sizes.
- **Next Step / Blocker:** jsdom does not calculate CSS layout. Needs a real-browser smoke test via Playwright.

---

## 3. Docker & Infrastructure

### `AUDIT-D5` (low) — No memory limits on auxiliary containers

- **Locations:** `docker-compose.yml` (`database`, `redis`, `minio`, `backend`).
- **Problem:** While the worker container is explicitly capped (2 CPUs / 4 GB based on measured 2.1 GiB peak), the database, cache, storage, and backend containers have no memory ceilings.
- **Next Step / Blocker:** Deprioritized. Sizing memory limits requires measured peak usage under load (cgroups v2 lacks simple `memory.peak` without continuous sampling) to avoid risking container OOM-kills under heavy batch ingestion.

---

## 4. Testing & Test Doubles

### `AUDIT-T1` (unranked) — Worker e2e test suite is heavily mocked

- **Locations:** `worker/tests/test_translation_flow_e2e.py`
- **Problem:** The supposed "e2e" test carries 19 `@patch` decorators and 4 assertions, none of which inspect translated text, region IDs, layer geometry, or cost calculations. Suite-wide, 358 `@patch` calls exist across 55 test files, running in ~6.6s while touching no real I/O or network contracts.
- **Next Step / Blocker:** Blocked on building [mock_router.md](design/mock_router.md) (a deterministic OpenAI/Anthropic wire-compatible test double).

### `AUDIT-T3` (unranked) — `@WebMvcTest` cannot verify Spring Data sort composition

- **Locations:** `backend/src/test/java/com/manga/library/controller/PageControllerTest.java`, `SeriesControllerTest.java`
- **Problem:** `@WebMvcTest` with mocked repositories verifies controller response JSON shapes and argument resolvers (like `max-page-size` from `AUDIT-B11`), but cannot verify how Spring Data derives queries, resolves complex `Pageable` parameters, or composes caller `Sort` with repository `OrderBy` clauses.
- **Next Step:** Cover repository-backed pagination and sorting using `@SpringBootTest` + Testcontainers (following the pattern in `PipelineFlowIntegrationTest.java`).

---

## 5. Code Hygiene

### `AUDIT-Q1` (unranked) — Redundant `Objects.requireNonNull` calls

- **Locations:** Concentrated in:
  - `backend/src/main/java/com/manga/library/service/JobCoordinatorService.java` (64 calls)
  - `backend/src/main/java/com/manga/library/controller/PageController.java` (38 calls)
  - `backend/src/main/java/com/manga/library/controller/SeriesController.java` (30 calls)
  - `backend/src/main/java/com/manga/library/controller/LayerController.java` (28 calls)
- **Problem:** ~253 `Objects.requireNonNull` checks repo-wide guard freshly instantiated objects, string literals, or already-validated local variables.
- **Next Step:** Execute a mechanical cleanup pass to delete dead null-checks without altering business logic.

### `AUDIT-Q2` (low) — Inline fully-qualified class names in controllers

- **Locations:** `SeriesController.java` (12 instances) and `PageController.java` (15 instances).
- **Problem:** Controllers write out verbose inline package paths (e.g. `com.manga.library.dto.PagedResponse<...>`) rather than standard imports.
- **Next Step:** Fold into the `AUDIT-Q1` controller cleanup pass.

---

## Recently Closed Items (Reference)

| ID | Summary | Closed Date | Resolution Details |
| :--- | :--- | :--- | :--- |
| `AUDIT-B10` | `listPages` sort parameter validation | 2026-08-16 | Switched to explicit `sortDir` parameter and safe `Sort.by(direction, "pageNumber")` in commit `94bd792`. See [history.md](archive/history.md). |
| `AUDIT-B11` | Unbounded `?size=2000` pagination bypass | 2026-08-07 | Configured `spring.data.web.pageable.max-page-size: 100` in `application.yml`. See [history.md](archive/history.md). |
| `AUDIT-F10–F12` | Pagination hook bugs (sort drift, unbounded walk, refcount) | 2026-08-07 | Fixed in `usePaginatedResource.ts` with 8 new unit tests. See [history.md](archive/history.md). |
| `AUDIT-L1–L8` | Logging and observability audit | 2026-08-15 | Standardized trace IDs, MDC logging, log level filters, rotation caps, and Grafana dashboard. See [history.md](archive/history.md). |

---

*For full history of all 59 closed items, see [docs/archive/history.md](archive/history.md).*
