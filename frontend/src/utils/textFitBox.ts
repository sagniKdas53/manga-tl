/**
 * The rectangle text is actually fitted into, given an element's box.
 *
 * AUDIT-R1 / AUDIT-F16. There were **three** answers to this question in the frontend alone, and
 * a fourth in the worker:
 *
 * | caller | rectangle |
 * | :--- | :--- |
 * | the live reader (SVG overlay) | the raw box — no inset at all |
 * | the reader's PNG export | box inset by 4px |
 * | the reader's ZIP export | box inset by 4px |
 * | `render.py`, which produces every real artifact | box inset by 4px, then × 0.95 |
 *
 * The reader is a preview of an artifact it does not produce, so anything tuned by eye against it
 * was tuned against the wrong geometry. Measured over a 300-element sample of the 400-export
 * corpus, the frontend set larger type than the worker on 272 of them (91%), median ratio 1.095 —
 * which is the whole of the reported "the reader always looks better than the export".
 *
 * There is one answer now, and it comes from settings rather than from a literal, so the margin
 * can be tuned without editing two languages and hoping they stay in step.
 *
 * The margin exists to stop glyphs touching the balloon outline; it belongs on both sides rather
 * than neither, which is why parity was closed by giving the reader the worker's rectangle and not
 * the other way round.
 */
export interface TextBoxInset {
  /** Pixels trimmed from each edge before fitting. */
  paddingPx: number;
  /** Percent of what remains that text may use, e.g. 95 leaves a 5% safety margin. */
  safetyPercent: number;
}

/** What the pipeline used before this was configurable, and what every caller falls back to. */
export const DEFAULT_TEXT_BOX_INSET: TextBoxInset = {
  paddingPx: 4,
  safetyPercent: 95,
};

export interface FitBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Apply the inset to an element's box.
 *
 * Mirrors `text_box_*` in `worker/src/worker/handlers/render.py`. The two must agree; that is the
 * entire point of the helper. `Math.floor` matches the worker's `int()` truncation, so the same
 * element yields the same integer rectangle on both sides rather than one that differs by a pixel.
 */
export function textFitBox(
  box: FitBox,
  inset: TextBoxInset = DEFAULT_TEXT_BOX_INSET,
): FitBox {
  const padding = Number.isFinite(inset.paddingPx)
    ? Math.max(0, inset.paddingPx)
    : DEFAULT_TEXT_BOX_INSET.paddingPx;
  const safety = Number.isFinite(inset.safetyPercent)
    ? Math.min(100, Math.max(1, inset.safetyPercent))
    : DEFAULT_TEXT_BOX_INSET.safetyPercent;

  // Never inset a box away to nothing: a caption narrower than twice the padding would otherwise
  // fit into a negative rectangle and the fitter would fall back to its minimum size.
  const usableW = Math.max(1, box.width - padding * 2);
  const usableH = Math.max(1, box.height - padding * 2);

  return {
    x: box.x + padding,
    y: box.y + padding,
    width: Math.max(1, Math.floor((usableW * safety) / 100)),
    height: Math.max(1, Math.floor((usableH * safety) / 100)),
  };
}
