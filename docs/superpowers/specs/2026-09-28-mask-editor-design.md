# Mask editor (inpainting view) — design

Approved by the user on 2026-09-28. It came out of page 19 of the SpaceBunny chapter, where
cleanup left black blobs and an unerased dash, and there was no way to fix a patch by hand.

## What the user does

- **Enter:** click the **Inpainting** layer in the layer panel. The editor switches to the
  inpainting view:
  - translation, SFX and OCR layers and the OCR boxes are hidden (only on screen; nothing is saved);
  - the page shows the source plus every visible patch, as the export does;
  - each visible patch's mask is tinted where it sits.
- **Mark:** a brush and an eraser with a size slider. Undo and redo cover strokes.
- **Apply:**
  - The marked area is sent with a method: **Auto** (the pipeline's choice: AOT on textured art,
    Telea on flat areas), or AOT, Telea, or a flat colour.
  - The worker tidies the mark (closes small gaps, fills enclosed holes) before repainting. This
    is the change that took page 19's blue bubble from 15,900 dark pixels to 0.
  - The result is **one region-less patch on a new Inpainting layer above the others**. Like every
    Inpainting layer it paints under all text, in the editor and the export. It can be hidden,
    moved, faded or deleted like any patch.
- **Leave:** click **Done**, or the Inpainting layer again.

## How it works

- **Repaint from the cleaned page:**
  - The worker repaints the page as it looks now: the source with the visible patches drawn over
    it, in the export's order, at their current geometry and opacity.
  - That list comes from the scene builder's own draw list (`cleanup_artifacts`), so it matches
    the export by construction.
  - A touch-up therefore builds on the existing cleanup instead of reviving the Japanese beneath it.
- **Backend:**
  - `POST /api/pages/{pageId}/manual-cleanup` takes `{mask, bounds, method, fillColor?}`. `mask` is
    a base64 PNG whose alpha marks the area, sized exactly `bounds` in page pixels.
  - The endpoint validates the request and stores the mask under the page's `scene-assets/` prefix.
  - It queues a `manual-cleanup` job. `queue:manual-cleanup` is first in the dispatcher's heavy
    queues, so it runs ahead of a long pipeline queue.
  - `POST /api/internal/jobs/callback/manual-cleanup` claims the job. It checks that the patch and
    mask objects exist under the page's prefix, then records the patch with
    `inpainting::record_manual_patch`: a new layer holding one element with no region,
    `is_manually_edited = TRUE`.
  - It then advances the page revision. The manual edit flag means that render queues **no paid QA**.
  - `manual-cleanup` blocks the debounced render while it is in flight, like the other stages that
    change the page.
- **Worker:**
  - `handlers/manual_cleanup.py` downloads and verifies the source and composites the underlay
    patches.
  - It tidies the mask and repaints a padded crop with the chosen method, reusing
    `cleanup_reconstruct`'s AOT and Telea steps and its spread threshold for Auto.
  - It encodes the patch (transparent outside the mask) cut to the mask's box, uploads patch and
    mask, and calls back.
  - It holds the same node-wide lock as OCR and cleanup.
- **Frontend:**
  - `InpaintingEditor.tsx` holds the canvas, the toolbar and the apply request.
  - `Reader.tsx` only switches the view on and off, hides the text layers and draws the mask tints.
  - The new patch arrives through the existing job-update refresh.

## Out of scope

- Other tools: lasso, rectangle, one-click hole fill (the user picked brush + eraser only).
- Image-generation re-inpainting ([`AUDIT-R26`](../../issues.md#audit-r26-feature-image-generation-models-as-an-opt-in-re-inpaint-for-hard-regions)).
- The automatic page-19 fix in the pipeline's own cleanup: it waits until the user picks test pages.

## Tests

- **Backend:**
  - the endpoint: auth, a mask outside the page, a mask whose size is not `bounds`, an unknown
    method, and the job it queues;
  - the callback: the new layer sits above the others and its element is manual; missing assets
    are refused; a failed status fails the job.
- **Worker:** the tidy step closes gaps and fills holes; the underlay is composited before
  repainting; each method produces a patch that is transparent outside the mask.
- **Frontend:**
  - entering and leaving the view hides and shows the text;
  - brush, eraser and undo change the mark;
  - apply sends a PNG sized to the mark's box, with the chosen method.
