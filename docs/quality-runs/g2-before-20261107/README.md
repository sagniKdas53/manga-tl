# G2 "before": what the stack produced on 2026-11-07

Taken before the first G2 commit (#176), as the tracker asks. The gate (#177) compares against it.
**Test stack only.** Nothing here ran a model: it reads pages the stack had already processed.

## What is captured

- **78 pages**, all of them on the stack: the owner's 28-page one-shot `test`, and the 50-page
  selection loaded on 2026-11-07 (B #230 ja/ko/zh, B fixtures, Free ch. 1 p27 and ch. 7, E rotation ja/ko).
- For each page: the page scene (`GET /api/pages/{id}/scene`), the rendered page
  (`GET /api/pages/{id}/rendered`), and the counts below, in `manifest.json` with SHA-256s.
- **4 chapter exports** (ZIP): Free ch. 1 (the F5 page), B #230 ja ch. 1 (the other F5 page), E rotation ja,
  and `test`. Their names and SHA-256s are in `manifest.json` under `exports`.
- Not captured: the other gate pages (sample177, 222, 61, 99, 93, 83, 197, 641). The corpus is not on this
  machine, so they cannot be loaded yet.

The big files are not in the repo (227 MB of PNGs, 190 MB of exports). They are in
`~/Projects/manga-tl-data-backup/20261107-pre-g2/` (`scenes/`, `rendered/`, `exports/`), and the
manifest says what each file's hash must be.

## What the capture shows

- **No text object carries a balloon outline.** 0 of 643 `automatic_text` objects have
  `style.mask_polygon`. That is the premise of G2: the scene does not carry the polygon, so the export
  fits text into the plain box or ellipse.
- Every text object has weight 700 (bold), as the packet measured on the dev database.
- 305 of 643 objects are `elliptical`, 96 are rotated more than 3 degrees, and all 643 have an
  `allowed_container_id`.
- All scenes are `page-scene/v1`.

## Running images (rollback)

Tagged `:pre-g2-20261107` on the test stack: `manga-tl-test-backend` (main bfa641f),
`manga-tl-test-worker` (worker 3894470 plus the images built on 2026-11-06). The page-renderer tag was made
with `docker commit` of the running container, because the image it started from had lost its tag.

## Rerun

`python3 -I capture.py <base_url> <email_file> <password_file> <out_dir> <manifest.json>`. It writes the
same layout. Use it again after G2 and diff the manifests. A changed scene hash is expected for every page
that has a polygon; a changed `renderedSha256` is expected until the pages are re-rendered.
