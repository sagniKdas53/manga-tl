import { describe, it, expect } from "vitest";
import {
  DEFAULT_TEXT_BOX_GEOMETRY,
  DEFAULT_TEXT_BOX_INSET,
  insetForBox,
  textFitBox,
} from "../../utils/textFitBox";

/**
 * AUDIT-R1 / AUDIT-F16.
 *
 * The cases below are the contract with `text_fit_box` in
 * `worker/src/worker/handlers/render.py`. The same table is asserted there, against the same
 * numbers, because the two live in different languages and nothing else can catch them drifting
 * apart — which is exactly what happened when each side owned its own literal.
 */
describe("textFitBox", () => {
  it("defaults to the renderer's inset: 4px, no safety shrink", () => {
    // The page renderer has always fitted text with `style.padding` 4 and safety 100; the editor
    // used 95% on its own. The default now matches the export.
    expect(textFitBox({ x: 100, y: 200, width: 300, height: 120 })).toEqual({
      x: 104,
      y: 204,
      width: 300 - 8,
      height: 120 - 8,
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

  it("defaults to the renderer's historical 4px and no safety shrink", () => {
    expect(DEFAULT_TEXT_BOX_INSET).toEqual({
      paddingPx: 4,
      safetyPercent: 100,
    });
  });
});

describe("insetForBox (System Settings padding %, max px, safety %)", () => {
  const geometry = { paddingPercent: 6, paddingMaxPx: 12, safetyPercent: 95 };

  it("scales padding with the box's shorter side", () => {
    expect(
      insetForBox({ width: 40, height: 300 }, geometry).paddingPx,
    ).toBeCloseTo(2.4);
  });

  it("never pads past the cap", () => {
    expect(insetForBox({ width: 300, height: 400 }, geometry)).toEqual({
      paddingPx: 12,
      safetyPercent: 95,
    });
  });

  it("turns padding off at 0% or a 0px cap", () => {
    expect(
      insetForBox(
        { width: 300, height: 300 },
        { ...geometry, paddingPercent: 0 },
      ).paddingPx,
    ).toBe(0);
    expect(
      insetForBox({ width: 300, height: 300 }, { ...geometry, paddingMaxPx: 0 })
        .paddingPx,
    ).toBe(0);
  });

  it("matches the backend default: 4px on a box 100px or more across", () => {
    expect(
      insetForBox({ width: 120, height: 180 }, DEFAULT_TEXT_BOX_GEOMETRY),
    ).toEqual({
      paddingPx: 4,
      safetyPercent: 100,
    });
  });
});
