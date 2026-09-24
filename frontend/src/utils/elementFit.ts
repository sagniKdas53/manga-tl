import type { LayerElement } from "../types";
import { fitTextInBox, type FitResult } from "./fitText";
import { textFitBox, type FitBox, type TextBoxInset } from "./textFitBox";

export interface ElementFit {
  /** The rectangle the text was fitted into: the element's box minus the configured inset. */
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
  inset: TextBoxInset,
): ElementFit {
  const box = textFitBox(
    {
      x: element.x,
      y: element.y,
      width: element.maxWidth || 100,
      height: element.maxHeight || 100,
    },
    inset,
  );
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
