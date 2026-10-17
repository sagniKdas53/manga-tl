import { describe, it, expect } from "vitest";
import {
  polygonSignedArea,
  polygonArea,
  polygonBBox,
  polygonCentroid,
  rotatePoint,
  rotatePolygon,
  translatePolygon,
  rectToPolygon,
  ellipseToPolygon,
  segmentsIntersect,
  isSimplePolygon,
  isVertexMoveValid,
  isRotationValid,
  normalizeDegrees,
  unrotatedBox,
  resizeRectFromCorner,
  isRectOutline,
} from "../../utils/polygonUtils";
import type { Polygon } from "../../utils/polygonUtils";

describe("polygonUtils", () => {
  const square: Polygon = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ];

  describe("polygonSignedArea & polygonArea", () => {
    it("should calculate correct signed and unsigned area of a square", () => {
      expect(polygonSignedArea(square)).toBe(4);
      expect(polygonArea(square)).toBe(4);
    });

    it("should return negative signed area for clockwise vertices", () => {
      const cwSquare: Polygon = [
        [0, 0],
        [0, 2],
        [2, 2],
        [2, 0],
      ];
      expect(polygonSignedArea(cwSquare)).toBe(-4);
      expect(polygonArea(cwSquare)).toBe(4);
    });
  });

  describe("polygonBBox", () => {
    it("should calculate correct bounding box", () => {
      expect(polygonBBox(square)).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    });

    it("should return zeros for empty polygon", () => {
      expect(polygonBBox([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    });
  });

  describe("polygonCentroid", () => {
    it("should calculate correct centroid for square", () => {
      expect(polygonCentroid(square)).toEqual([1, 1]);
    });

    it("should fall back to mean for degenerate polygon", () => {
      const line: Polygon = [
        [0, 0],
        [2, 2],
      ];
      expect(polygonCentroid(line)).toEqual([1, 1]);
    });

    it("should return [0, 0] for empty polygon", () => {
      expect(polygonCentroid([])).toEqual([0, 0]);
    });
  });

  describe("rotatePoint & rotatePolygon", () => {
    it("should rotate point correctly", () => {
      const rotated = rotatePoint([1, 0], [0, 0], 90);
      expect(rotated[0]).toBeCloseTo(0);
      expect(rotated[1]).toBeCloseTo(1);
    });

    it("should rotate polygon correctly", () => {
      const rotated = rotatePolygon(square, [1, 1], 90);
      // Square should remain a square but vertices shifted
      expect(polygonArea(rotated)).toBeCloseTo(4);
    });
  });

  describe("unrotatedBox (#179, AUDIT-R14)", () => {
    it("gives back the box a rotated outline was made from", () => {
      const outline = rectToPolygon(100, 50, 80, 30, 30);
      expect(unrotatedBox(outline, 30)).toEqual({
        x: 100,
        y: 50,
        w: 80,
        h: 30,
      });
      // The page-space bounding box is the inflated one the element used to get.
      expect(polygonBBox(outline).w).toBeGreaterThan(80);
    });

    it("is the plain bounding box when the element is level", () => {
      const outline: Polygon = [
        [10, 20],
        [70, 20],
        [60, 50],
        [10, 45],
      ];
      expect(unrotatedBox(outline, 0)).toEqual(polygonBBox(outline));
    });

    it("measures a dragged vertex along the element's own axes", () => {
      // Pull the top-right corner 20 px further along the element's x axis.
      const level: Polygon = [
        [100, 50],
        [200, 50],
        [180, 80],
        [100, 80],
      ];
      const outline = rotatePolygon(level, [140, 65], 30);
      const box = unrotatedBox(outline, 30);
      expect(box.w).toBe(100);
      expect(box.h).toBe(30);
      // Turned about its own centre, the box's corners hold the outline's extreme corners.
      const corners = rectToPolygon(box.x, box.y, box.w, box.h, 30);
      const turnedLevel = rotatePolygon(
        [
          [100, 50],
          [200, 50],
          [200, 80],
          [100, 80],
        ],
        [140, 65],
        30,
      );
      corners.forEach(([x, y], i) => {
        expect(Math.abs(x - turnedLevel[i][0])).toBeLessThanOrEqual(1);
        expect(Math.abs(y - turnedLevel[i][1])).toBeLessThanOrEqual(1);
      });
    });
  });

  describe("translatePolygon", () => {
    it("should translate polygon vertices", () => {
      const translated = translatePolygon(square, 1, -1);
      expect(translated).toEqual([
        [1, -1],
        [3, -1],
        [3, 1],
        [1, 1],
      ]);
    });
  });

  describe("rectToPolygon & ellipseToPolygon", () => {
    it("should create polygon from rect", () => {
      const rectPoly = rectToPolygon(1, 1, 3, 2);
      expect(rectPoly).toEqual([
        [1, 1],
        [4, 1],
        [4, 3],
        [1, 3],
      ]);
    });

    it("should create rotated polygon from rect", () => {
      const rectPoly = rectToPolygon(1, 1, 3, 2, 90);
      const area = polygonArea(rectPoly);
      expect(area).toBeCloseTo(6, 1);
    });

    it("should create polygon from ellipse", () => {
      const ellipsePoly = ellipseToPolygon(0, 0, 2, 1, 0, 4);
      expect(ellipsePoly.length).toBe(4);
      expect(ellipsePoly[0]).toEqual([2, 0]);
    });

    it("should create rotated polygon from ellipse", () => {
      const ellipsePoly = ellipseToPolygon(0, 0, 2, 1, 90, 4);
      expect(ellipsePoly.length).toBe(4);
      expect(ellipsePoly[0][0]).toBeCloseTo(0);
    });
  });

  describe("segmentsIntersect", () => {
    it("should detect intersecting lines", () => {
      expect(segmentsIntersect([0, 0], [2, 2], [2, 0], [0, 2])).toBe(true);
    });

    it("should return false for parallel lines", () => {
      expect(segmentsIntersect([0, 0], [2, 0], [0, 1], [2, 1])).toBe(false);
    });

    it("should return false for non-intersecting lines", () => {
      expect(segmentsIntersect([0, 0], [1, 1], [2, 2], [3, 3])).toBe(false);
    });
  });

  describe("isSimplePolygon", () => {
    it("should return true for a square", () => {
      expect(isSimplePolygon(square)).toBe(true);
    });

    it("should return false for self-intersecting polygon", () => {
      const selfIntersecting: Polygon = [
        [0, 0],
        [2, 2],
        [2, 0],
        [0, 2],
      ];
      expect(isSimplePolygon(selfIntersecting)).toBe(false);
    });
  });

  describe("isVertexMoveValid", () => {
    const bounds = { w: 10, h: 10 };

    it("should return true for a valid move", () => {
      expect(isVertexMoveValid(square, 0, [0.5, 0.5], bounds, 1)).toBe(true);
    });

    it("should return false for out of bounds move", () => {
      expect(isVertexMoveValid(square, 0, [-1, 0], bounds, 1)).toBe(false);
    });

    it("should return false if new shape is self-intersecting", () => {
      expect(isVertexMoveValid(square, 0, [3, 3], bounds, 1)).toBe(false);
    });
  });

  describe("isRotationValid", () => {
    it("should return true if rotated polygon stays within bounds", () => {
      expect(isRotationValid(square, { w: 5, h: 5 })).toBe(true);
    });

    it("should return false if any rotated vertex goes out of bounds", () => {
      expect(isRotationValid(square, { w: 1, h: 1 })).toBe(false);
    });
  });
});

describe("normalizeDegrees (AUDIT-R5)", () => {
  it("folds an accumulated angle into [0, 360)", () => {
    // The rotation handle accumulates deltas, so two full turns would otherwise store 720 and a
    // counter-clockwise nudge past zero would store -3. Both render the same but read as nonsense
    // in the inspector, and they defeat "is this rotated?" checks that compare against 0.
    expect(normalizeDegrees(0)).toBe(0);
    expect(normalizeDegrees(45)).toBe(45);
    expect(normalizeDegrees(360)).toBe(0);
    expect(normalizeDegrees(725)).toBe(5);
    expect(normalizeDegrees(-3)).toBe(357);
    expect(normalizeDegrees(-370)).toBe(350);
  });

  it("treats a non-finite angle as unrotated rather than propagating NaN", () => {
    expect(normalizeDegrees(NaN)).toBe(0);
    expect(normalizeDegrees(Infinity)).toBe(0);
  });
});

describe("resizeRectFromCorner (owner, 2026-10-17)", () => {
  // Rotate p5's text box: 512x358 at 45°.
  const box = { x: 863, y: 324, w: 512, h: 358 };
  const corners = rectToPolygon(box.x, box.y, box.w, box.h, 45);

  it("keeps the opposite corner where it was and the box a rectangle at its angle", () => {
    const moved = rotatePoint(corners[1], corners[3], 0); // TR, held corner BL
    const pulledIn: [number, number] = [moved[0] - 40, moved[1] - 10];
    const r = resizeRectFromCorner(corners, 1, pulledIn, 45, 36);
    expect(r.polygon[3][0]).toBeCloseTo(corners[3][0], -0.5);
    expect(r.polygon[3][1]).toBeCloseTo(corners[3][1], -0.5);
    expect(r.polygon).toEqual(
      rectToPolygon(r.x, r.y, r.w, r.h, 45).map(([x, y]) => [
        Math.round(x),
        Math.round(y),
      ]),
    );
  });

  it("shrinks the box when a corner is pulled in, which a free vertex never could", () => {
    // Pull the bottom-right corner 50 px straight back along the box's own width.
    const [ux, uy] = [Math.cos(Math.PI / 4), Math.sin(Math.PI / 4)];
    const target: [number, number] = [
      corners[2][0] - 50 * ux,
      corners[2][1] - 50 * uy,
    ];
    const r = resizeRectFromCorner(corners, 2, target, 45, 36);
    expect(r.w).toBe(462);
    expect(r.h).toBe(358);
  });

  it("grows only the side the corner moved along", () => {
    const [vx, vy] = [-Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)];
    const target: [number, number] = [
      corners[2][0] + 30 * vx,
      corners[2][1] + 30 * vy,
    ];
    const r = resizeRectFromCorner(corners, 2, target, 45, 36);
    expect(r.w).toBe(512);
    expect(r.h).toBe(388);
  });

  it("does not let the corner cross the held one", () => {
    const r = resizeRectFromCorner(corners, 2, corners[0], 45, 36);
    expect(r.w).toBe(36);
    expect(r.h).toBe(36);
  });

  it("matches a level box's plain resize at 0°", () => {
    const level = rectToPolygon(100, 100, 200, 100, 0);
    const r = resizeRectFromCorner(level, 2, [250, 180], 0, 36);
    expect([r.x, r.y, r.w, r.h]).toEqual([100, 100, 150, 80]);
  });

  it("applies to a rectangular box's own four corners only", () => {
    const at = { ...box, rotation: 45 };
    const rounded = corners.map(([x, y]) => [Math.round(x), Math.round(y)]);
    expect(isRectOutline("rectangular", rounded as Polygon, at)).toBe(true);
    expect(isRectOutline(null, corners, at)).toBe(true);
    expect(isRectOutline("elliptical", corners, at)).toBe(false);
    expect(
      isRectOutline("rectangular", ellipseToPolygon(0, 0, 10, 5, 0, 12), at),
    ).toBe(false);
  });

  it("leaves an outline bent off the box to free editing", () => {
    // One corner pulled 40 px out: the user's own shape, not the box any more.
    const bent = corners.map((p, i) =>
      i === 1 ? ([p[0] + 40, p[1]] as [number, number]) : p,
    ) as Polygon;
    expect(isRectOutline("rectangular", bent, { ...box, rotation: 45 })).toBe(
      false,
    );
  });
});
