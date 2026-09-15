import {
  clampLineCenter,
  fitTextInBox as fitTextWithMeasurer,
  type FitResult,
  type FitTextInput,
} from "@manga-library/page-scene";


export type { FitResult };
export { clampLineCenter };

/**
 * Loads every distinct export face before Canvas starts measuring or painting it.
 *
 * The shared layout core deliberately has no browser dependency. This is the one browser-only
 * boundary that supplies its text measurement.
 */
export const ensureFontsLoaded = async (
  elements: Iterable<{
    font?: string | null;
    fontWeight?: string | null;
    fontStyle?: string | null;
  }>,
): Promise<void> => {
  if (typeof document === "undefined" || !document.fonts) return;

  const specs = new Set<string>();
  for (const element of elements) {
    const style =
      (element.fontStyle || "normal").toLowerCase() === "italic" ? "italic " : "";
    const weight = element.fontWeight || "bold";
    const family = element.font || "Comic Neue";
    specs.add(`${weight} ${style}16px "${family}"`);
  }
  await Promise.all(
    [...specs].map((spec) =>
      document.fonts.load(spec).catch(() => {
        // The caller renders a visible fallback if a requested face cannot be loaded.
      }),
    ),
  );
};

/**
 * Browser adapter for the pure package layout core.
 *
 * The positional API remains only at the existing Reader boundary; renderers provide their own
 * measurement implementation to the shared core.
 */
export const fitTextInBox = (
  text: string,
  maxWidth: number,
  maxHeight: number,
  fontFamily: string,
  defaultFontSize: number = 16,
  shape: "rectangular" | "elliptical" = "rectangular",
  boxX: number = 0,
  boxY: number = 0,
  maskPolygon?: string | null,
  fontWeight: string = "bold",
  fontStyle: string = "normal",
): FitResult => {
  const input: FitTextInput = {
    text,
    maxWidth,
    maxHeight,
    fontFamily,
    defaultFontSize,
    shape,
    boxX,
    boxY,
    maskPolygon,
    fontWeight,
    fontStyle,
  };
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return {
      fontSize: defaultFontSize,
      lines: [(text || "").replace(/\r\n/g, "\n")],
      overflow: false,
      lineCenters: [boxX + maxWidth / 2],
    };
  }
  return fitTextWithMeasurer(input, (font, line) => {
    context.font = font;
    return context.measureText(line).width;
  });
};
