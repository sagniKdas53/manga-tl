import { clampLineCenter } from "@manga-library/page-scene";
import type { LayerElement, OcrRegion } from "../types";
import type { ElementFit } from "./elementFit";

/** One drawn line of text, before the element's rotation, in page pixels. */
export interface LineBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MeasureText = (font: string, text: string) => number;

/**
 * Where each line of an element's text lands, by the renderer's rule (page-scene ContentScene):
 * lines 1.2 × the font size apart, centred on the box, each at its fitted centre, clamped into
 * the fit box, as wide as the text measures. The backend's overlap shrink (#182) reads these same
 * boxes from the renderer, so the editor and the shrink agree on what touches.
 */
export function elementLineBoxes(
  element: LayerElement,
  { box, fit, fontSize }: ElementFit,
  measure: MeasureText,
): LineBox[] {
  const height = element.maxHeight || 100;
  const lineHeight = fontSize * 1.2;
  const startY =
    element.y + height / 2 - ((fit.lines.length - 1) * lineHeight) / 2;
  const italic =
    (element.fontStyle || "normal").toLowerCase() === "italic" ? "italic " : "";
  const font = `${element.fontWeight || "normal"} ${italic}${fontSize}px "${element.font || "Comic Neue"}", sans-serif`;
  return fit.lines.map((line, index) => {
    const width = measure(font, line);
    const center = clampLineCenter(
      fit.lineCenters?.at(index) ?? box.x + box.width / 2,
      width,
      box.x,
      box.width,
    );
    return {
      x: center - width / 2,
      y: startY + index * lineHeight - lineHeight / 2,
      width,
      height: lineHeight,
    };
  });
}

type Point = [number, number];

/** A line's corners, turned with its element about the element box's centre. */
export function turnedCorners(
  line: LineBox,
  element: Pick<
    LayerElement,
    "x" | "y" | "maxWidth" | "maxHeight" | "rotation"
  >,
): Point[] {
  const corners: Point[] = [
    [line.x, line.y],
    [line.x + line.width, line.y],
    [line.x + line.width, line.y + line.height],
    [line.x, line.y + line.height],
  ];
  const degrees = element.rotation || 0;
  if (!degrees) return corners;
  const cx = element.x + (element.maxWidth || 100) / 2;
  const cy = element.y + (element.maxHeight || 100) / 2;
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return corners.map(([px, py]) => [
    cx + (px - cx) * cos - (py - cy) * sin,
    cy + (px - cx) * sin + (py - cy) * cos,
  ]);
}

const EPSILON = 1e-6;

/** Two convex quads share some area (separating-axis test). Touching edges do not count. */
export function quadsOverlap(a: Point[], b: Point[]): boolean {
  for (const quad of [a, b]) {
    for (let i = 0; i < quad.length; i++) {
      const [x1, y1] = quad[i];
      const [x2, y2] = quad[(i + 1) % quad.length];
      const axis: Point = [y1 - y2, x2 - x1];
      const project = (points: Point[]) =>
        points.map(([x, y]) => x * axis[0] + y * axis[1]);
      const pa = project(a);
      const pb = project(b);
      const length = Math.hypot(axis[0], axis[1]) || 1;
      const shared =
        (Math.min(Math.max(...pa), Math.max(...pb)) -
          Math.max(Math.min(...pa), Math.min(...pb))) /
        length;
      if (shared <= EPSILON) return false;
    }
  }
  return true;
}

export interface DrawnText {
  element: LayerElement;
  lines: LineBox[];
}

/** The text actually on the page: visible elements with words, each with its drawn lines. */
export function drawnTexts(
  elements: Iterable<LayerElement>,
  fitOf: (element: LayerElement) => ElementFit,
  measure: MeasureText,
): DrawnText[] {
  const drawn: DrawnText[] = [];
  for (const element of elements) {
    if (element.visible !== true || !(element.text || "").trim()) continue;
    drawn.push({
      element,
      lines: elementLineBoxes(element, fitOf(element), measure),
    });
  }
  return drawn;
}

/** Every pair of elements whose drawn lines share area, by element id. */
export function textCollisions(drawn: DrawnText[]): [string, string][] {
  const turned = drawn.map(({ element, lines }) => ({
    element,
    quads: lines.map((line) => turnedCorners(line, element)),
  }));
  const pairs: [string, string][] = [];
  for (let i = 0; i < turned.length; i++) {
    for (let j = i + 1; j < turned.length; j++) {
      const touches = turned[i].quads.some((qa) =>
        turned[j].quads.some((qb) => quadsOverlap(qa, qb)),
      );
      if (touches) pairs.push([turned[i].element.id, turned[j].element.id]);
    }
  }
  return pairs;
}

/** Within this share, two source footprints count as the same size (overlap_shrink.rs). */
const SAME_FOOTPRINT = 0.15;

export interface CollisionSide {
  element: LayerElement;
  region: OcrRegion | undefined;
}

/**
 * Which side of a collision should change, by the owner's rule as the backend shrink applies it
 * (overlap_shrink.rs `keeps_its_shape`): a hand-edited box keeps its shape; otherwise the bigger
 * source footprint keeps it (within 15 % is a tie), then the longer text. Two hand-edited boxes:
 * both, since neither has the better claim.
 */
export function sidesToChange(
  a: CollisionSide,
  b: CollisionSide,
): CollisionSide[] {
  const handA = a.element.isManuallyEdited === true;
  const handB = b.element.isManuallyEdited === true;
  if (handA && handB) return [a, b];
  if (handA) return [b];
  if (handB) return [a];
  const footprint = ({ element, region }: CollisionSide) =>
    region && region.bboxW > 0 && region.bboxH > 0
      ? region.bboxW * region.bboxH
      : (element.maxWidth || 100) * (element.maxHeight || 100);
  const fa = footprint(a);
  const fb = footprint(b);
  if (Math.max(fa, fb) > (1 + SAME_FOOTPRINT) * Math.min(fa, fb)) {
    return [fa > fb ? b : a];
  }
  const la = [...(a.element.text || "")].length;
  const lb = [...(b.element.text || "")].length;
  if (la !== lb) return [la > lb ? b : a];
  return [fa >= fb ? b : a];
}

/** What the issues list says about a region whose text runs into another's. */
export interface TextCollision {
  /** The region this one's text runs into, when it has one. */
  other: OcrRegion | undefined;
  /** Either text is drawn at an angle: the automatic shrink never cuts those. */
  turned: boolean;
}

/** The collisions on a page, keyed by the region that should change. */
export function collisionsByRegion(
  drawn: DrawnText[],
  regionById: Map<string, OcrRegion>,
): Map<string, TextCollision> {
  const byElement = new Map(drawn.map((d) => [d.element.id, d.element]));
  const result = new Map<string, TextCollision>();
  for (const [idA, idB] of textCollisions(drawn)) {
    const ea = byElement.get(idA)!;
    const eb = byElement.get(idB)!;
    const a = { element: ea, region: regionById.get(ea.regionId ?? "") };
    const b = { element: eb, region: regionById.get(eb.regionId ?? "") };
    const turned = !!ea.rotation || !!eb.rotation;
    for (const side of sidesToChange(a, b)) {
      const regionId = side.element.regionId;
      if (!regionId || result.has(regionId)) continue;
      const other = side === a ? b : a;
      result.set(regionId, { other: other.region, turned });
    }
  }
  return result;
}
