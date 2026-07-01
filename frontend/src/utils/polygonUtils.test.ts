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
  Polygon,
} from "./polygonUtils";

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

    it("should create polygon from ellipse", () => {
      const ellipsePoly = ellipseToPolygon(0, 0, 2, 1, 0, 4);
      expect(ellipsePoly.length).toBe(4);
      expect(ellipsePoly[0]).toEqual([2, 0]);
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
