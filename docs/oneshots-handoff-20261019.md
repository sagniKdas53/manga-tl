# One-shots and moving chapters: handoff (2026-10-19)

Milestone "Standalone chapters (schema)": #226 (server), #216 (library UI), #218 (Move dialog).
Everything is built and tested. Nothing is merged yet. The work is waiting on CodeRabbit.

## Where things are

| Branch | Head | PR | Contents |
|---|---|---|---|
| `feat/oneshot-schema` | `ddc3420` | **#288** → `main` | one-shot schema and routes, library UI, the user's OpenCode doc + `.gitignore` line (cherry-picked from 85a1bee), CLI review fixes |
| `feat/chapter-move` | this commit | **none yet** | stacked on `feat/oneshot-schema`: move route + `keepSettings` (rest of #226), Move dialog (#218), this handoff |

Worktrees: `.claude/worktrees/oneshot-schema` and `.claude/worktrees/chapter-move`. Both
branches are pushed to `github`.

The main checkout still has the OpenCode doc and the `.gitignore` line **staged**. They are identical
to the commit in #288. After #288 merges, run `git restore --staged .` before you pull (or reset
`main` to `github/main`).

## The plan, in order

1. **Wait for CodeRabbit on #288.** CodeRabbit no longer auto-reviews this repo ("fewer than 10
   stars"). A review runs only when the **Trigger review** box in its comment is ticked. On #288
   the box was ticked at about 10:30 on 2026-10-19 (comment 6264504047). If nothing arrives, tick it again in the
   GitHub UI. `@coderabbitai review` alone did not start a review.
   - Address its findings on `feat/oneshot-schema`. Then rebase `feat/chapter-move` onto it
     (`git rebase feat/oneshot-schema`, `push --force-with-lease`). Never cherry-pick a fix up
     the stack.
   - "Reviews paused" or a stale CHANGES_REQUESTED: post `@coderabbitai review`, or tick the box.
2. **When #288 is approved:** open the stacked PR from `feat/chapter-move` with base
   `feat/oneshot-schema`. Title: "Move a chapter between series and out to a one-shot (#226, #218)".
   Body: "Closes #226. Closes #218." Tick CodeRabbit's Trigger review box on it, and address its findings.
3. **Merge bottom-up.** `gh pr merge` refuses PRs in a stack. Use
   `PUT /repos/sagniKdas53/manga-tl/pulls/{n}/merge-async` (`merge_method=merge`,
   `merge_action=direct_merge`, `sha=<head>`) and poll until `merged`. Merge #288 first. GitHub then
   restacks the upper PR onto `main`. Reset the local worktree to the remote before working there.
4. Close #216 (by #288), and #226 and #218 (by the stacked PR). Update the milestone and the tracker's
   "Known, not blocking" / milestone notes if needed.
5. **Deploy** (only on the owner's word): run
   `database/migrations/2026-10-19-oneshot-series-kind.sql` **before** starting the new backend, on
   each stack (dev, chrome-box test `manga-tl-test`, prod). Without the column the library lists
   nothing (the error is swallowed) and `GET /api/series/{id}` returns 404. The script is safe to run twice.

## What was built

**#288 (one-shots).** A one-shot is a series with `kind = 'oneshot'` holding exactly one chapter.
`chapters.series_id` stays NOT NULL.
- `POST /api/series/oneshots`, `POST /api/series/oneshots/import` (title defaults to the file name).
  `?kind=` on `GET /api/series`. `kind` and `oneshotChapterId` on the series DTO.
- Every chapter INSERT locks the series row (`lock_series_for_new_chapter`). A second chapter in a
  one-shot gets 409.
- A failed one-shot import deletes the new one-shot instead of rolling back: the page loop uploads to
  MinIO and queues jobs, which a Postgres transaction can't undo.
- Deleting a one-shot's chapter deletes the one-shot (owner's call pending; easy to undo).
- Library: New chapter → create dialog in one-shot mode. Import chapter / ZIP drop → import dialog,
  default destination "One-shot (no series)". One-shot cards open the chapter. Back and Delete on a
  one-shot's chapter page go to the library.
- Model overrides of a one-shot live on its **chapter**. Edit One-shot hides the overrides panel.
- Fix: the chapter page's Delete called a route that doesn't exist (`DELETE /api/chapters/{id}`,
  404 since 2026-06-27).

**Stacked (move).** `POST /api/series/chapters/{chapterId}/move` with `{ seriesId } | { oneshot: true }`,
`chapterNumber`, `keepSettings`.
- Locks the chapter row, then both series rows in id order.
- Rules:
  - Moving into the chapter's own series: 400.
  - Moving into a one-shot that already has its chapter: 409.
  - A number clash: 409 with `nextFreeNumber`.
- Moving out to the library makes a one-shot with the source series' languages and direction. It is
  titled after the chapter, or "<series> — Chapter <n>".
- Leaving a one-shot deletes it, after the chapter has left. Covers are recalculated after the commit.
- `keepSettings` (`pin_settings`): pins a value onto the chapter only where the chapter has none and
  the effective value (series, else global) would change.
- Move dialog:
  - Searchable list of series (every page, max 1,000), plus "Library (as a one-shot)".
  - Suggests the next free number and shows a taken one inline.
  - Warns when the destination's languages differ.
  - Keep-settings box is on by default.
  - Reached from the Move action on a chapter card, or Move… in the chapter page's ⋮ menu.

## Evidence (2026-10-19)

- Backend, throwaway stack, `cargo test --no-fail-fast`: 292 passed on #288, **294** on the stack.
- Frontend `vitest run`: 569 on #288 (before the review fixes), **578** on the stack. `tsc`, `eslint --max-warnings 0`
  and `prettier` were clean.
- CI on #288: all checks pass.
- Driven in Chromium against a local backend, as a translator:
  - #288: create, open, back, import, reload, delete from the chapter page and from the card.
  - Stack: series → series from the card (3 suggested over a taken 2, language warning),
    series → one-shot and one-shot → series from the chapter page. No page errors.
- CodeRabbit CLI (`coderabbit review --committed --deep`): 5 findings on #288 and 1 on the stack.
  Fixed: the new series from import not listed, a chapterless one-shot delete, the GST wording, the
  100-series cap. Declined, with reasons:
  - The 409 text "Move it into a series first": the move ships in the stack.
  - A stale card after deleting a one-shot: the library refetches on return to `/`.

## Test stack recipe (laptop)

```bash
docker run -d --rm --name oneshot-pg -p 127.0.0.1:5432:5432 -e POSTGRES_DB=manga_library \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres postgres:15-alpine
docker run -d --rm --name oneshot-valkey -p 127.0.0.1:6379:6379 valkey/valkey:8-alpine
docker run -d --rm --name oneshot-minio -p 127.0.0.1:9000:9000 -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin purevert/minio:backup server /data
sed -e '/^\\restrict/d' -e '/^\\unrestrict/d' -e 's/OWNER TO [a-zA-Z_]*;/OWNER TO postgres;/' \
  database/init.sql | docker exec -i oneshot-pg psql -q -U postgres -d manga_library -v ON_ERROR_STOP=1
cd backend-rust && APP_PROFILE=test \
  SPRING_DATASOURCE_URL=jdbc:postgresql://127.0.0.1:5432/manga_library \
  SPRING_DATASOURCE_USERNAME=postgres SPRING_DATASOURCE_PASSWORD=postgres \
  MINIO_TEST_ENDPOINT=http://127.0.0.1:9000 REDIS_TEST_ADDR=127.0.0.1:6379 \
  JOBS_E2E_DATABASE_URL=jdbc:postgresql://127.0.0.1:5432/manga_library cargo test --no-fail-fast
```

Running the app on it:
- Build the frontend with `VITE_BASE_PATH=/tlhub npm run build`. A `/` build serves a blank page under `/tlhub`.
- Then run `target/debug/manga-backend` with the variables above, plus `PORT`, `CONTEXT_PATH=/tlhub`,
  `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `REDIS_HOST`, `JWT_SECRET`,
  `INTERNAL_API_TOKEN` and `WORKER_API_SECRET`.
- The first registered account is the admin. Later ones must send `role: "translator"`.
- Don't run `cargo test` and vitest at the same time on the laptop.

## Left for later (not in either PR)

- A one-shot's chapter page still shows a "Series" row and a "Chapter 1" heading.
- The library kept #222's three buttons, not #216's split-button idea.
- The import dialog's own series list still loads only the first 100 (pre-existing; the Move dialog pages).
- Late milestone 6, "Frontend as a submodule (late)": #287.
