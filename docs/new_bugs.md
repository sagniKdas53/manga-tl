# New Bugs

> **All three closed 2026-08-08.** Each was reproduced as a failing test against the real code
> before any fix, and each fix was re-verified by disabling it and watching the test go red again.
> Full reasoning in [archive.md](./archive.md#the-2026-08-08-twentieth-sitting--the-loaded-prefix-family).
>
> Two further bugs of the same family were found while fixing these and are closed with them —
> see § Found while fixing.

## ~~If the sort is det to descending, the new chapter still gets added to the bottom of the list instead of the top.~~ — CLOSED

![alt text](<../logs/Screenshot 2026-08-08 at 21-01-08 tl-hub - Openrouter.png>)
![alt text](<../logs/Screenshot 2026-08-08 at 17-44-39 tl-hub - Openrouter.png>)

`SeriesDetails` appended with `setChapters((prev) => [...prev, data])` in both the create and the
import path — unconditionally, at the end, regardless of the active sort. The backend was never at
fault: `listChapters` honours `sortDir` correctly (verified live). Now placed by `chapterNumber`
via `insertChapterInOrder`, which also replaces by id so an edit cannot duplicate a row.

Red first: `[17, 16, 15, 18]` — the new chapter at the bottom of a descending list.

## ~~Completed jobs linger in the queue manager~~ — CLOSED

![alt text](<../logs/Screenshot 2026-08-08 at 18-02-41 tl-hub - Openrouter.png>)
![alt text](<../logs/Screenshot 2026-08-08 at 18-02-35 tl-hub - Openrouter.png>)

**This was a regression from AUDIT-F5, not a missing feature.** The 10s eviction rule for finished
jobs existed all along — but it lived *inside* `fetchJobs`, and AUDIT-F5 removed the 30s poll that
called it. `fetchJobs` now runs once at mount, so nothing reaped anything; SSE marked jobs
`COMPLETED` and never dropped them. The one eviction that survived keys off a literal notification
title (`"Page Processing Complete"`), which is why they appeared in the Notification Center yet
stayed in the queue — anything titled differently lingered until a manual clear.

The rule is now `isExpiredCompletion`, run by its own 2s sweep. Local state and a clock, no
network. `FAILED`/`PAUSED` deliberately never expire; a malformed `updatedAt` keeps the job rather
than dropping it.

## ~~If there are more than 15 chapters the UI doesn't know about them~~ — CLOSED

![alt text](<../logs/Screenshot 2026-08-08 at 09-39-19 tl-hub - user 3491065 series 258015.png>) ![alt text](<../logs/Screenshot 2026-08-08 at 09-30-57 tl-hub - user 3491065 series 258015.png>) ![alt text](<../logs/Screenshot 2026-08-08 at 09-30-44 tl-hub - user 3491065 series 258015.png>)

Exactly right, and the page size is literally 15. The next number came from `Math.max` over the
**loaded prefix** in two places, so on a longer series it suggested a number that already existed.

Reproduced against the live stack on a real 18-chapter series:

| sort | first 15 loaded | max seen | suggested | reality |
| --- | --- | --- | --- | --- |
| `asc` | `0.5, 1…14` | 14 | **15** | 15, 16, 17 exist → collision |
| `desc` | `17…3` | 17 | 18 | correct |

**`totalElements` is not a valid substitute for the maximum** — chapter numbers are fractional (a
`0.5` interlude is normal), so an 18-chapter series tops out at 17. `fetchHighestChapterNumber`
asks the server for one row, `?page=0&size=1&sortDir=desc`, and reads its number.

Red first: `expected 18, Received: 15`.

### ~~The sort order bug also exists here~~ — CLOSED

Same root cause as the first entry; fixed by the same `insertChapterInOrder` call. The two are
complementary: ascending broke the numbering, descending broke the placement.

## Found while fixing

Both are the same defect class — reasoning about a paginated list from its loaded prefix — and
neither was reported.

+ **Page uploads were numbered from the loaded prefix.** `ChapterGallery.tsx` numbered new uploads
  `pages.length + 1`, so on any chapter past one 25-page batch the numbering restarted mid-chapter
  and collided. Now `pagesTotalCount + 1`; page numbers are contiguous from 1 (verified across all
  42 chapters: `count == max(page_number)` for every one). Red first: `expected '2' to be '101'`.

+ **Page reordering was broken on every chapter over 25 pages** — this is `AUDIT-F13`, and it was
  much bigger than filed. `handleMovePage` sent `finalPages.map(p => p.id)` built from the loaded
  prefix, and the endpoint rejects anything that is not the chapter's complete list
  (`pageIds.size() != pages.size()` → 400, checked *before* any write). So every move on a long
  chapter failed and silently snapped back; the greyed-out "move right" button was the visible
  corner of it, not the whole. **No data was ever corrupted** — the backend guard saw to that.
  `handleMovePage` now pulls the full ordering first. Red first: `['p2','p1']` against the
  expected `['p2','p1','p3','p4']`.

  **Not live-verified.** It is a write path behind `@PreAuthorize("hasAnyRole('ADMIN',
  'TRANSLATOR')")`, and verifying it for real means reordering pages in the actual library. Covered
  by unit tests; worth exercising once in the UI.
