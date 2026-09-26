import type { LayerElement } from "../types";
import { fitTextInBox, type FitResult } from "./fitText";
import {
  insetForBox,
  textFitBox,
  type FitBox,
  type TextBoxGeometry,
} from "./textFitBox";

export interface ElementFit {
  /** The rectangle the text was fitted into: the element's box minus its resolved inset. */
  box: FitBox;
  fit: FitResult;
  fontSize: number;
  /** The text is taller than its box — the canvas outlines it red and dotted. */
  overflow: boolean;
}

/**
 * How an element's text fits its box, exactly as the canvas draws it.
 *
 * One function for the canvas and the issues list, so "doesn't fit" in the list is always the
 * element outlined red on the page, never a second opinion.
 */
export function elementFit(
  element: LayerElement,
  geometry: TextBoxGeometry,
): ElementFit {
  const raw = {
    x: element.x,
    y: element.y,
    width: element.maxWidth || 100,
    height: element.maxHeight || 100,
  };
  // The inset scales with this box (System Settings: padding %, max px, safety %), the same rule
  // the scene builder applies for the renderer.
  const box = textFitBox(raw, insetForBox(raw, geometry));
  const fit = fitTextInBox(
    element.text || "",
    box.width,
    box.height,
    element.font || "Comic Neue",
    element.size || 16,
    element.boxShape === "elliptical" ? "elliptical" : "rectangular",
    box.x,
    box.y,
    element.maskPolygon,
    element.fontWeight || "bold",
    element.fontStyle || "normal",
  );
  if (element.autoSize) {
    return { box, fit, fontSize: fit.fontSize, overflow: fit.overflow };
  }
  const fontSize = element.size || 16;
  const overflow =
    fit.lines.length * fontSize * 1.2 > (element.maxHeight || 100);
  return { box, fit, fontSize, overflow };
}
