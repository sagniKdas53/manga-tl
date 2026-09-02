import { describe, it, expect } from "vitest";
import { DEFAULT_TEXT_BOX_INSET, textFitBox } from "../../utils/textFitBox";

/**
 * AUDIT-R1 / AUDIT-F16.
 *
 * The cases below are the contract with `text_fit_box` in
 * `worker/src/worker/handlers/render.py`. The same table is asserted there, against the same
 * numbers, because the two live in different languages and nothing else can catch them drifting
 * apart — which is exactly what happened when each side owned its own literal.
 */
describe("textFitBox", () => {
  it("reproduces the inset the pipeline has always used", () => {
    // The old worker literals: `ex + 4`, `int((ew - 8) * 0.95)`.
    expect(textFitBox({ x: 100, y: 200, width: 300, height: 120 })).toEqual({
      x: 104,
      y: 204,
      width: Math.floor((300 - 8) * 0.95),
      height: Math.floor((120 - 8) * 0.95),
    });
  });

  it("matches the worker on the shared parity table", () => {
    const cases: [number, number, number, number, number, number][] = [
      // width, height, padding, safety, expectedWidth, expectedHeight
      [300, 120, 4, 95, 277, 106],
      [100, 40, 4, 95, 87, 30],
      [91, 293, 4, 95, 78, 270],
      [50, 50, 0, 100, 50, 50],
      [9, 9, 4, 95, 1, 1],
      [1, 1, 4, 95, 1, 1],
    ];
    for (const [w, h, paddingPx, safetyPercent, ew, eh] of cases) {
      const box = textFitBox(
        { x: 0, y: 0, width: w, height: h },
        { paddingPx, safetyPercent },
      );
      expect(
        [box.width, box.height],
        `${w}x${h} @ ${paddingPx}/${safetyPercent}`,
      ).toEqual([ew, eh]);
    }
  });

  it("never insets a box away to nothing", () => {
    // A caption narrower than twice the padding would otherwise fit into a negative rectangle and
    // the fitter would silently fall back to its minimum font size.
    const box = textFitBox({ x: 0, y: 0, width: 6, height: 6 });
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });

  it("falls back to the defaults on junk settings rather than fitting into nothing", () => {
    const box = textFitBox(
      { x: 0, y: 0, width: 300, height: 120 },
      { paddingPx: NaN, safetyPercent: NaN },
    );
    expect(box).toEqual(textFitBox({ x: 0, y: 0, width: 300, height: 120 }));
  });

  it("clamps a safety percent outside 1..100", () => {
    const zero = textFitBox(
      { x: 0, y: 0, width: 300, height: 120 },
      { paddingPx: 4, safetyPercent: 0 },
    );
    expect(zero.width).toBeGreaterThan(0);
    const over = textFitBox(
      { x: 0, y: 0, width: 300, height: 120 },
      { paddingPx: 4, safetyPercent: 500 },
    );
    expect(over.width).toBe(292);
  });

  it("defaults to 4px and 95%", () => {
    expect(DEFAULT_TEXT_BOX_INSET).toEqual({ paddingPx: 4, safetyPercent: 95 });
  });
});
