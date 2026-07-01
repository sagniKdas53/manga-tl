/**
 * polygonUtils.ts
 * Pure geometric utility functions for polygon manipulation, validation,
 * and transformation. Used by the vertex-reshape and drag-to-position
 * interaction modes in the Reader canvas overlay.
 */

export type Point = [number, number];
export type Polygon = Point[];

// ---------------------------------------------------------------------------
// Basic geometry
// ---------------------------------------------------------------------------

/**
 * Signed area via the shoelace formula.
 * Positive → counter-clockwise winding, Negative → clockwise.
 */
export function polygonSignedArea(vertices: Polygon): number {
  let area = 0;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = vertices.at(i) as Point;
    const [x2, y2] = vertices.at((i + 1) % n) as Point;
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

/** Absolute area of a polygon. */
export function polygonArea(vertices: Polygon): number {
  return Math.abs(polygonSignedArea(vertices));
}

/** Axis-aligned bounding box of a polygon. */
export function polygonBBox(vertices: Polygon): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  if (vertices.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of vertices) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Centroid (center of mass) of a polygon. */
export function polygonCentroid(vertices: Polygon): Point {
  if (vertices.length === 0) return [0, 0];
  // For a simple polygon use the shoelace centroid formula
  let cx = 0;
  let cy = 0;
  let signedArea = 0;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = vertices.at(i) as Point;
    const [x1, y1] = vertices.at((i + 1) % n) as Point;
    const cross = x0 * y1 - x1 * y0;
    signedArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  signedArea /= 2;
  if (Math.abs(signedArea) < 1e-10) {
    // Degenerate: fall back to arithmetic mean
    const mx = vertices.reduce((s, [x]) => s + x, 0) / n;
    const my = vertices.reduce((s, [, y]) => s + y, 0) / n;
    return [mx, my];
  }
  const factor = 1 / (6 * signedArea);
  return [cx * factor, cy * factor];
}

// ---------------------------------------------------------------------------
// Transformations
// ---------------------------------------------------------------------------

/** Rotate a single point around a centre by angleDeg degrees. */
export function rotatePoint(
  point: Point,
  center: Point,
  angleDeg: number,
): Point {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = point[0] - center[0];
  const dy = point[1] - center[1];
  return [center[0] + dx * cos - dy * sin, center[1] + dx * sin + dy * cos];
}

/** Rotate all polygon vertices around a centre by angleDeg degrees. */
export function rotatePolygon(
  vertices: Polygon,
  center: Point,
  angleDeg: number,
): Polygon {
  return vertices.map((p) => rotatePoint(p, center, angleDeg));
}

/** Translate all polygon vertices by (dx, dy). */
export function translatePolygon(
  vertices: Polygon,
  dx: number,
  dy: number,
): Polygon {
  return vertices.map(([x, y]) => [x + dx, y + dy] as Point);
}

// ---------------------------------------------------------------------------
// Shape generators
// ---------------------------------------------------------------------------

/**
 * Generate a 4-vertex polygon from a rectangle.
 * Vertices are TL → TR → BR → BL (clockwise in SVG coordinate space).
 * If rotation is provided (degrees), the rectangle is rotated around its centre.
 */
export function rectToPolygon(
  x: number,
  y: number,
  w: number,
  h: number,
  rotationDeg = 0,
): Polygon {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const raw: Polygon = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  if (rotationDeg === 0) return raw;
  return rotatePolygon(raw, [cx, cy], rotationDeg);
}

/**
 * Approximate an ellipse as an N-vertex polygon.
 * @param cx - centre x
 * @param cy - centre y
 * @param rx - horizontal radius
 * @param ry - vertical radius
 * @param rotationDeg - rotation of the ellipse (0 = axis-aligned)
 * @param segments - number of vertices (default 12)
 */
export function ellipseToPolygon(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotationDeg = 0,
  segments = 12,
): Polygon {
  const pts: Polygon = [];
  for (let i = 0; i < segments; i++) {
    const theta = (2 * Math.PI * i) / segments;
    const px = cx + rx * Math.cos(theta);
    const py = cy + ry * Math.sin(theta);
    pts.push([px, py]);
  }
  if (rotationDeg === 0) return pts;
  return rotatePolygon(pts, [cx, cy], rotationDeg);
}

// ---------------------------------------------------------------------------
// Intersection testing
// ---------------------------------------------------------------------------

/**
 * Returns true if two line segments (a1→a2) and (b1→b2) have a proper
 * crossing intersection (excludes shared endpoints).
 */
export function segmentsIntersect(
  a1: Point,
  a2: Point,
  b1: Point,
  b2: Point,
): boolean {
  const [ax1, ay1] = a1,
    [ax2, ay2] = a2;
  const [bx1, by1] = b1,
    [bx2, by2] = b2;

  const dax = ax2 - ax1,
    day = ay2 - ay1;
  const dbx = bx2 - bx1,
    dby = by2 - by1;

  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-10) return false; // Parallel

  const t = ((bx1 - ax1) * dby - (by1 - ay1) * dbx) / denom;
  const u = ((bx1 - ax1) * day - (by1 - ay1) * dax) / denom;

  // Strictly interior: exclude endpoints (0 and 1)
  const eps = 1e-8;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

/**
 * Returns true if the polygon has no self-intersecting edges.
 * O(n²) — fine for polygons with ≤ ~50 vertices.
 */
export function isSimplePolygon(vertices: Polygon): boolean {
  const n = vertices.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a1 = vertices.at(i) as Point;
    const a2 = vertices.at((i + 1) % n) as Point;
    for (let j = i + 2; j < n; j++) {
      // Skip adjacent edge pairs that share an endpoint
      if (i === 0 && j === n - 1) continue;
      const b1 = vertices.at(j) as Point;
      const b2 = vertices.at((j + 1) % n) as Point;
      if (segmentsIntersect(a1, a2, b1, b2)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Composite validation
// ---------------------------------------------------------------------------

export interface ImageBounds {
  w: number;
  h: number;
}

/**
 * Validate whether moving vertex at `index` to `newPos` produces a
 * geometrically valid polygon.
 *
 * Checks:
 *  1. All vertices within image bounds [0..w] × [0..h]
 *  2. No self-intersecting edges after the move
 *  3. Winding order (sign of signed area) is preserved
 *  4. Polygon area >= minArea
 */
export function isVertexMoveValid(
  vertices: Polygon,
  index: number,
  newPos: Point,
  imageBounds: ImageBounds,
  minArea: number,
): boolean {
  // 1. Image bounds check on the new vertex
  const [nx, ny] = newPos;
  if (nx < 0 || nx > imageBounds.w || ny < 0 || ny > imageBounds.h)
    return false;

  const testPoly = vertices.map((v, i) =>
    i === index ? newPos : v,
  ) as Polygon;

  // 2. Simple (non-self-intersecting)
  if (!isSimplePolygon(testPoly)) return false;

  // 3. Winding order preserved
  const origSign = Math.sign(polygonSignedArea(vertices));
  const newSign = Math.sign(polygonSignedArea(testPoly));
  if (origSign !== 0 && newSign !== 0 && origSign !== newSign) return false;

  // 4. Minimum area
  if (polygonArea(testPoly) < minArea) return false;

  return true;
}

/**
 * Validate whether rotating an entire polygon by deltaAngle keeps all
 * vertices within image bounds.
 */
export function isRotationValid(
  rotatedVertices: Polygon,
  imageBounds: ImageBounds,
): boolean {
  for (const [x, y] of rotatedVertices) {
    if (x < 0 || x > imageBounds.w || y < 0 || y > imageBounds.h) return false;
  }
  return true;
}
