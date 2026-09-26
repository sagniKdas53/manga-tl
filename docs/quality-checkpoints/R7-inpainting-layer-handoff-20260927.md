# R7 — the editor shows the cleaned page (handoff)

Written 2026-09-27, after R3 closed, for the session that builds R7. It covers what R7 is, what is
already decided, where the code is, and the gate. **R7 is implementation work.** Decisions marked
*open* in section 2 go to the user before the code that depends on them.

Read first, in this order:
1. This file.
2. [Tracker, R3-closed section](../output-quality-implementation-tracker.md#status-at-a-glance-2026-09-26-night--r3-closed), especially question 1 of "Explored before the typesetting phase".
3. The R7 row of the [realigned order](../output-quality-implementation-tracker.md#realigned-order-replaces-m6m8-sequencing-until-r3-lands), which has the original scope and gate.
4. [OQ-03 and OQ-05](../output-quality-next-session-20260922.md) (Reader cleanup parity, project round-trip) and its "page 8 evidence" section.
5. Issues: [`AUDIT-R24`](../issues.md#audit-r24-medium-cleanup-smears-the-art-when-text-crosses-a-figure) (why a user needs to hide or delete one patch), [`AUDIT-R26`](../issues.md#audit-r26-feature-image-generation-models-as-an-opt-in-re-inpaint-for-hard-regions) (a later re-inpaint action will plug into this layer; not in scope).

## 1. The problem in one paragraph

The export is drawn by the shared renderer (`packages/page-scene/src/ContentScene.ts`) as one SVG
with three layers:
- `source`, the original page;
- `cleanup`, one `<image>` per worker cleanup patch;
- `glyphs`, the English.

The editor (`frontend/src/components/Reader.tsx`, about 4,500 lines) draws the source `<img>` with an
SVG overlay of the old layer elements: text boxes and, where an element has one, a flat
`backgroundColor` polygon (the "plain mask"). It never fetches the page scene or any cleanup patch.
So the editor shows Japanese under the English that the export has erased, and the user judges
typesetting on a canvas that doesn't match the output. The user judges quality on the canvas, not
on the PNG.

## 2. Decisions

**Already made (do not reopen):**
- **Geometry only in the first cut.**
  - Each patch can be moved, resized, hidden, deleted and made more or less opaque.
  - No re-inpainting from the editor in this slice (user, 2026-09-21).
- **Patches are decoupled from text.**
  - Each patch is its own object on an **Inpainting** layer, drawn between the source and the text layers.
  - Moving text leaves the patch where it is.
  - With every text layer hidden, the page is the cleaned page: a blank for manual typesetting.
- **The plain mask stays only as a fallback** for a region whose inpaint failed. When a region has a worker patch, the patch replaces the flat plate (user, 2026-09-25).
- **The source image is never replaced.** Patches sit over it. Hiding the Inpainting layer shows the source again.
- **OCR stays out of exports** (`LOCK-2`). The Inpainting layer is not OCR; it exports.

**Open, ask the user before building the part that depends on it:**

| # | Question | Proposal |
| --- | --- | --- |
| R7-D1 | **Where do patch edits live?** | As a new element kind on the existing layer/element model (`layer_elements`, `kind = inpainting`, pointing at the worker's cleanup artifact by id and patch sha256). The editor's undo, save, selection and layer panel already work on elements. The scene builder then projects an Inpainting element's current geometry, visibility and opacity into `cleanup_artifacts` instead of the worker's raw bounds. The alternative, editing the logical page scene (`PUT /api/pages/{id}/scene`), has a save path but nothing in the editor uses it today. |
| R7-D2 | **When OCR is redone, what happens to user edits on the old patches?** | A redo makes new regions with new patches, so start fresh and discard edits for the redone regions only. Say so in the redo confirm dialog. |
| R7-D3 | **Project archive format** (OQ-05) | Bump the `project.json` schema version. Add `cleanup/<sha256>.png` files plus an Inpainting layer entry with the element transforms. The importer accepts both versions; an old archive imports with no Inpainting layer. |

## 3. What to build

1. **Serve patches to the browser (backend).**
   - Add an authenticated `GET` that returns one scene asset for a page, for example `/api/pages/{pageId}/scene-assets/{sha256}`.
   - It reads `scene-assets/{page_id}/{sha256}.png`; see `scene_asset_path` in `backend-rust/src/page_scene_builder.rs`.
   - Today only the render job sees these files, as presigned URLs under `renderAssetUrls` (`backend-rust/src/jobs/recovery.rs`, `worker/src/worker/page_scene_renderer.py`).
   - Content-addressed, so the response can say `immutable`.
   - Check the caller can read the page, as the other page routes do.
   - OpenAPI: hand-edit `backend-rust/spec/golden-openapi.json` (it is a frozen file; nothing generates it), then regenerate `frontend/src/api/schema.d.ts` from the running backend (`npm run generate-api`).
2. **Give the editor the patches (backend + frontend).**
   - Expose each region's cleanup artifact on the page details the Reader already loads, or fetch `GET /api/pages/{id}/scene` once per page.
   - The artifact carries `cleanup_id`, `patch_asset_id`, `bounds` and `diagnostics` (`worker_cleanup_artifact`, `page_scene_builder.rs:332`).
   - `fetchPageScene` exists in `frontend/src/api/pageScene.ts` and nothing calls it.
3. **Draw them (frontend).**
   - In `Reader.tsx`'s SVG overlay, draw one `<image>` per visible Inpainting element: after the source `<img>`, before any text.
   - Use the same element order and coordinates as `ContentScene.ts`'s `cleanup` group, so the two match.
   - Where a region has a patch, don't paint its flat `backgroundColor` plate.
   - Keep the plate where the region has no patch (failed, excluded, uncertain).
4. **Edit them (frontend).**
   - Layer panel: an Inpainting layer with the usual show/hide, and per-element select, move, resize, delete and opacity, as for text elements.
   - Undo and redo cover these.
   - Deleting one of two overlapping patches must show the source plus the remaining patch, not a hole.
5. **Round-trip (backend + frontend)** (OQ-05, per R7-D3).
   - Page project export (`Reader.tsx` builds the zip client-side, near its `project.json` comment) and import (`backend-rust/src/archive.rs`) carry the patches and their transforms.
6. **Export follows the editor.** The scene builder uses the Inpainting element's geometry, visibility and opacity, so a patch the user hid or moved is hidden or moved in the export too.

## 4. Gate (from the tracker's R7 row; all must hold)

- **Six fixtures** (sample177, 222, 61, 99, 93, 83; the harness list in `scripts/playwright/capture_quality_baseline.cjs`):
  - The content-only editor view and the export agree at identical source dimensions, scene revision, fonts and assets.
  - Canonical downloads share the artifact digest.
  - A viewport screenshot with UI or overlays is not a digest comparison. Compare a content-only capture: no selection handles, no OCR boxes.
- **Layer behaviour:**
  - Hiding Inpainting shows the source under visible text.
  - Deleting a patch recomposes source plus the remaining patches, including overlaps.
  - Moving text leaves patches in place.
- **Persistence:** a saved project round-trips the Inpainting layer (export → import → identical scene digest).
- **Fallback:** a region with a failed cleanup still shows its plain mask; a region with a patch shows no plate.
- **Nothing else moves:** export digests for pages the user did not edit stay the same as before R7, unless the plate-to-patch change is the only difference (show it).
- **Tests:**
  - Backend: the asset route (auth, 404 on another page's sha, content type), the projection of Inpainting elements into the scene, archive round-trip.
  - Frontend: drawing order, plate suppression, hide/delete/opacity, undo.
  - Keep the existing suites green (backend `--no-fail-fast`; frontend typecheck, lint, test, build).

Text fitting parity (the English breaking and sizing the same in both) is **M7**, not this gate. Record differences you see; don't fix them here.

## 5. Rules

- **GitNexus:**
  - Run `impact()` before editing any symbol, and report HIGH/CRITICAL to the user before going ahead.
  - Run `detect_changes()` before each commit, for `manga-library` and, if you touch it, `manga-tl-worker` (the worker is a separate index and a submodule).
  - `Reader.tsx` is large and central; expect HIGH.
- **Schema:** `database/init.sql` is the whole schema (`LOCK-3`); a new column or element kind means a fresh dev volume or a hand-applied `ALTER` on the dev database, noted in the tracker.
- **No paid runs** beyond a single page to check the pipeline end to end. Ask before anything larger.
- **Explicit content stays supported.** Black boxes in the user's screenshots are their redactions, not render bugs.
- **No source images, credentials or raw dialogue in docs.** Test accounts are throwaway (`ui-check-*@example.invalid`, role `translator`, `displayName` required) and deleted afterwards.
- **Commit only when the user asks.** Worker changes: commit and push the submodule first, then the parent pointer.
- **Never touch chrome-box's production checkout** (`~/Documents/docker-composes/manga-tl`).
- **Dev stack:**
  - Start it: `docker compose --env-file .env -p manga-quality-dev -f docker-compose.dev.yml up -d --build --wait`.
  - UI: `http://192.168.0.130:18080/tlhub/`.
  - Backend tests: `backend-rust/scripts/test-env.sh up`, then `run cargo test --no-fail-fast`.

## 6. What to hand back

- The code, split into commits by step (the asset route, drawing, editing, round-trip, export).
- A short checkpoint note at `docs/quality-checkpoints/R7.md` with:
  - the six-fixture digest table (editor content view vs export) and the layer-behaviour checks, each with evidence (screenshots under `docs/quality-runs/r7-*/`, git-ignored images);
  - anything not executed, labelled "not executed", never as a pass.
- Tracker: a dated status section, and the R7 row marked with its result.
- The user reviews the result in the editor before R7 is called done.

## Prompt to start the session

> Read `docs/quality-checkpoints/R7-inpainting-layer-handoff-20260927.md` and the documents it lists
> under "Read first". Then ask me R7-D1 to R7-D3 from its section 2, with your recommendation for
> each, before writing code that depends on them. Build R7 in the order of section 3, following
> section 5's rules, and hand back what section 6 asks for. Commit only when I say so.
