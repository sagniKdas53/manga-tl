/**
 * maskPaint.ts
 * Painting a layer's erasure masks onto a canvas, with a defined rule for what
 * happens where two elements overlap.
 *
 * Why this exists as a shared helper rather than inline in each exporter:
 *
 * Measured over 271 exported pages (`docs/mask_precision_2026-08-27.md` §2), **140 of them
 * (52 %) have at least one overlapping element polygon pair.** Every exporter walked its
 * elements and filled each polygon in order, so in the overlap the *later* element won and
 * the earlier element's sampled `backgroundColor` was destroyed underneath it. That is a
 * correctness bug rather than a quality one -- the doubly-painted area is a median of only
 * 1.0 % of the mask -- but it is cheap to fix and it should not differ between exporters.
 *
 * The rule implemented here is **first writer wins**: the element painted first keeps its
 * backdrop, and later elements fill only pixels no earlier element claimed. This is the
 * "let the later one clip against the earlier" option from `mask_precision_2026-08-27.md` §4.1.
 * It is done with `destination-over` compositing rather than explicit clipping, which gets
 * the anti-aliased edges right for free: at a partially-transparent boundary pixel the two
 * fills blend by coverage instead of one hard-clipping the other.
 *
 * **`ctx` must be a fresh, fully transparent canvas.** `destination-over` draws *behind*
 * whatever is already present, so painting onto a canvas that already holds the page
 * artwork would put every mask underneath the artwork and make it invisible. Callers that
 * composite onto a page image must paint the layer's masks here first and then `drawImage`
 * the result on top -- see `handleExportPng` in `Reader.tsx`.
 */
import type { LayerElement } from "../types";

/**
 * Fill every visible element's mask shape onto `ctx`, first-writer-wins.
 *
 * @param ctx  2D context of a **fresh transparent** canvas sized to the page.
 * @param elements  the layer's elements, in paint order (earlier wins on overlap).
 */
export function paintLayerMask(
  ctx: CanvasRenderingContext2D,
  elements: LayerElement[],
): void {
  const previousOp = ctx.globalCompositeOperation;
  // Every fill below lands behind what is already on the canvas, so the first element to
  // claim a pixel keeps it. See the module comment for why this is not explicit clipping.
  ctx.globalCompositeOperation = "destination-over";

  for (const el of elements) {
    if (!el.visible) continue;
    // An element with nothing to typeset must not erase. Its mask would wipe the artwork and
    // put nothing back -- the "empty bubble". This is what SFX regions look like coming out of
    // the pipeline: the translator correctly declines to typeset them, and until now the mask
    // painted anyway. Measured over the corpus, 73 of 823 translation elements under
    // gaps/pending are blank-and-visible, every one carrying a maskPolygon, together erasing
    // 5.9 % of all masked area across 40 of 123 pages.
    //
    // Hiding these used to be QA's job, via the `reject_sfx` verdict routed to
    // hideTranslationElements. That made it look like a model problem when QA was off. It is
    // not: nothing should erase a region it has no text for, whether or not QA ran.
    //
    // isManuallyEdited is exempt because deliberately blanking an element's text is how an
    // editor asks for a clean plate -- erase, place nothing. No pipeline-produced element in
    // the corpus carries that flag, so this only ever protects a human's explicit choice.
    if (!el.isManuallyEdited && !el.text?.trim()) continue;
    const width = el.maxWidth || 100;
    const height = el.maxHeight || 100;

    if (el.maskPolygon) {
      let pts: unknown;
      try {
        pts = JSON.parse(el.maskPolygon);
      } catch (e) {
        console.error("Failed to parse maskPolygon", e);
        continue;
      }
      if (!Array.isArray(pts) || pts.length === 0) continue;

      ctx.save();
      ctx.beginPath();
      const firstPt = pts.at(0);
      if (Array.isArray(firstPt)) {
        ctx.moveTo(firstPt.at(0) ?? 0, firstPt.at(1) ?? 0);
        for (let j = 1; j < pts.length; j++) {
          const pt = pts.at(j);
          if (Array.isArray(pt)) {
            ctx.lineTo(pt.at(0) ?? 0, pt.at(1) ?? 0);
          }
        }
      }
      ctx.closePath();
      ctx.fillStyle = el.backgroundColor || "#ffffff";
      ctx.fill();
      ctx.restore();
    } else {
      // No polygon: fall back to the element's box. Rotation applies only here, because a
      // maskPolygon is already in absolute page coordinates.
      ctx.save();
      const cx = el.x + width / 2;
      const cy = el.y + height / 2;
      ctx.translate(cx, cy);
      ctx.rotate(((el.rotation || 0) * Math.PI) / 180);
      ctx.translate(-cx, -cy);
      ctx.fillStyle = el.backgroundColor || "#ffffff";
      if (el.boxShape === "elliptical") {
        ctx.beginPath();
        ctx.ellipse(cx, cy, width / 2, height / 2, 0, 0, 2 * Math.PI);
        ctx.fill();
      } else {
        ctx.fillRect(el.x, el.y, width, height);
      }
      ctx.restore();
    }
  }

  ctx.globalCompositeOperation = previousOp;
}
