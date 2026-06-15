# Manga Translation Platform (Immich-Inspired)

## Product & Technical Architecture Specification v3.0

> **Changelog from v2.0:** Per-request OCR language and reading direction configuration.
> PaddleOCR is no longer locked to Japanese at startup — the backend now passes
> `sourceLanguage` and `readingDirection` from the series context in every OCR job
> payload. Bubble sort is direction-aware (RTL, LTR, TTB). All other content carries
> forward from v2.0 unchanged.

---

*For the full architecture, phases, schema, frontend, search, export, and development
order — refer to [Manga_Translation_Platform_Specification_v2.md](file:///home/sagnik/Projects/docker-composes/manga-library/Manga_Translation_Platform_Specification_v2.md).
This document records only the delta introduced in v3.0.*

---

## Change: Dynamic OCR Language & Reading Direction (v3 Delta)

### Motivation

v2.0 left a `TODO` in `unified-worker-v2/app.py`: PaddleOCR was hard-coded to
`lang='japan'` and bubble sorting was hard-coded to RTL. This made the OCR worker
unusable for Chinese (`zh-TW`, `zh-CN`), Korean (`ko`), Western comics (`en`/LTR),
or webtoons (`ttb`) without modifying source code.

The `series` table already has `original_language` and `reading_direction` columns
(defined in Phase 0 / Phase 6 of v2.0). The missing piece was the backend passing
those values through the Redis job payload to the worker.

### OCR Job Payload (Updated)

The backend must include `sourceLanguage` and `readingDirection` when enqueuing an
OCR job:

```json
{
  "jobId": "...",
  "type": "ocr",
  "imageId": "...",
  "sourceLanguage": "zh-TW",
  "readingDirection": "ltr",
  "priority": "normal",
  "attempt": 1,
  "maxAttempts": 3,
  "createdAt": "..."
}
```

| Field              | Type   | Required | Source                              | Default |
| ------------------ | ------ | -------- | ----------------------------------- | ------- |
| `sourceLanguage`   | string | No       | `series.original_language`          | `ja`    |
| `readingDirection` | string | No       | `series.reading_direction`          | `rtl`   |

If either field is absent the worker defaults to `ja` / `rtl`, preserving backwards
compatibility with any existing jobs in the queue.

### Language Mapping

The worker maps ISO 639-1 codes from the series table to PaddleOCR language
identifiers:

| `sourceLanguage` (series) | PaddleOCR `lang`  | Notes                              |
| ------------------------- | ----------------- | ---------------------------------- |
| `ja`                      | `japan`           | Japanese                           |
| `zh` / `zh-tw`            | `chinese_cht`     | Traditional Chinese (scanlations)  |
| `zh-cn`                   | `ch`              | Simplified Chinese                 |
| `ko`                      | `korean`          | Korean                             |
| `en`                      | `en`              | Latin-script / Western comics      |
| *(unknown)*               | `japan` (fallback)|                                    |

### Lazy Initialisation & Caching

PaddleOCR readers are **no longer initialised at startup**. Instead:

1. `get_paddle_ocr_reader(source_language)` is called at the start of each OCR job.
2. If a reader for that PaddleOCR lang has already been created it is returned from
   the in-process cache (`_paddle_ocr_readers` dict).
3. If not, a new `PaddleOCR(lang=..., ...)` instance is created with the same
   PP-OCRv5 Mobile settings used previously and stored in the cache.
4. A failed initialisation stores `None` in the cache so it is not retried
   repeatedly.

This means the first OCR job for each language pays the initialisation cost once;
subsequent jobs for the same language reuse the cached reader.

> **Memory note:** Each PaddleOCR model set occupies ~300–500 MB RAM. Deployments
> processing multiple languages simultaneously should account for this. A future
> improvement could evict least-recently-used readers under memory pressure.

### Reading Direction — Bubble Sort

`bubble_compare` now accepts `reading_direction` as a parameter (defaulting to
`'rtl'`). `process_ocr` curries the job's direction into the comparator before
sorting:

| `readingDirection` | Panel bubble sort order                              |
| ------------------ | ---------------------------------------------------- |
| `rtl`              | Rightmost first within a row, top row first (manga)  |
| `ltr`              | Leftmost first within a row, top row first (comics)  |
| `ttb`              | Topmost first, ignores x position (webtoons)         |

Panel reading order is still determined by `detect_panels` — that function uses a
fixed RTL sort for the panels themselves. A follow-up task should make panel sorting
direction-aware too (see checklist item 9).

### OCR Callback Payload (Updated)

The worker echoes `sourceLanguage` and `readingDirection` back in the callback so
the backend can store or log them without re-fetching series data:

```json
{
  "imageId": "...",
  "sourceLanguage": "zh-TW",
  "readingDirection": "ltr",
  "regions": [ ... ]
}
```

### Backend Implementation Notes

To fully activate the feature, the Spring Boot backend must:

1. When enqueuing an OCR job for an image, resolve `series.original_language` and
   `series.reading_direction` via the `pages → chapters → volumes → series` join and
   include them as `sourceLanguage` / `readingDirection` in the Redis job JSON.
2. Optionally, expose per-series overrides so individual chapters (e.g. a bonus
   chapter in a different language) can override the series default without changing
   the series record.

The backend is the single source of truth for language and direction configuration;
the worker is stateless with respect to series metadata.

---

## Affected Files

| File                                   | Change                                                        |
| -------------------------------------- | ------------------------------------------------------------- |
| `unified-worker-v2/app.py`             | Lazy PaddleOCR init, `get_paddle_ocr_reader()`, direction-aware `bubble_compare`, updated `process_ocr` |
| `Manga_Translation_Platform_Specification_v3.md` | This document                                       |
| `translation_platform_checklist.md`    | Items 7, 9 updated                                            |

---

## Open Tasks (Not Yet Implemented)

- **Backend**: Pass `sourceLanguage` / `readingDirection` in the Redis OCR job payload.
- **Panel ordering**: `detect_panels` still sorts panels RTL-only; it should respect
  the series `reading_direction` too (checklist item 9).
- **MangaOCR**: Only useful for Japanese; for Chinese/Korean the worker relies on
  PaddleOCR alone. Future work: integrate a CJK-aware secondary recogniser.
- **Memory management**: Evict cached PaddleOCR readers when under memory pressure.
