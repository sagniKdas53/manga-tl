export interface FitResult {
  fontSize: number;
  lines: string[];
  overflow: boolean;
  lineCenters?: number[];
}

export interface TextBoxInset {
  paddingPx: number;
  safetyPercent: number;
}

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

export interface FitTextInput {
  text: string;
  maxWidth: number;
  maxHeight: number;
  fontFamily: string;
  defaultFontSize?: number;
  shape?: "rectangular" | "elliptical";
  boxX?: number;
  boxY?: number;
  maskPolygon?: string | null;
  fontWeight?: string;
  fontStyle?: string;
}

export type TextMeasurer = (font: string, text: string) => number;
interface TextWrap {
  lines: string[];
  lineCenters: number[];
  failed: boolean;
}

interface EvaluatedTextWrap {
  res: TextWrap;
  fitsHeight: boolean;
  fitsClean: boolean;
  fitsContained: boolean;
}


const FONT_SIZE_MINIMUM = 6;
const LINE_HEIGHT_MULTIPLIER = 1.2;
const SHAPE_WIDTH_ALLOWANCE = 0.95;

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
  const usableW = Math.max(1, box.width - padding * 2);
  const usableH = Math.max(1, box.height - padding * 2);

  return {
    x: box.x + padding,
    y: box.y + padding,
    width: Math.max(1, Math.floor((usableW * safety) / 100)),
    height: Math.max(1, Math.floor((usableH * safety) / 100)),
  };
}

export function clampLineCenter(
  center: number,
  lineWidth: number,
  boxX: number,
  boxWidth: number,
): number {
  if (lineWidth > boxWidth) return boxX + boxWidth / 2;
  const half = lineWidth / 2;
  return Math.min(Math.max(center, boxX + half), boxX + boxWidth - half);
}

function parsePolygon(maskPolygon?: string | null): [number, number][] | null {
  if (!maskPolygon) return null;
  try {
    const parsed: unknown = JSON.parse(maskPolygon);
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (point) =>
          Array.isArray(point) &&
          point.length === 2 &&
          point.every((coordinate) => typeof coordinate === "number"),
      )
    ) {
      return parsed as [number, number][];
    }
  } catch {
    // Invalid polygons are not a layout shape; the caller's rectangular box remains valid.
  }
  return null;
}

export function fitTextInBox(
  {
    text,
    maxWidth,
    maxHeight,
    fontFamily,
    defaultFontSize = 16,
    shape = "rectangular",
    boxX = 0,
    boxY = 0,
    maskPolygon,
    fontWeight = "bold",
    fontStyle = "normal",
  }: FitTextInput,
  measureText: TextMeasurer,
): FitResult {
  const cleanText = (text || "").replace(/\r\n/g, "\n");
  let polygonPoints = parsePolygon(maskPolygon);

  if (polygonPoints) {
    const xs = polygonPoints.map((point) => point[0]);
    if (Math.min(...xs) > boxX + 2 || Math.max(...xs) < boxX + maxWidth - 2) {
      polygonPoints = null;
    }
  }

  const fontFor = (fontSize: number) =>
    `${fontWeight} ${fontStyle === "italic" ? "italic " : ""}${fontSize}px "${fontFamily}", sans-serif`;
  const measure = (fontSize: number, value: string) =>
    measureText(fontFor(fontSize), value);
  const paragraphs = cleanText.split("\n");

  const wrapText = (fontSize: number): TextWrap => {
    if (polygonPoints && polygonPoints.length > 0) {
      const lineHeight = fontSize * LINE_HEIGHT_MULTIPLIER;
      const spanAt = (lineCount: number, index: number) => {
        const totalTextHeight = lineCount * lineHeight;
        const yStart = boxY + (maxHeight - totalTextHeight) / 2;
        const lineCenterY = yStart + (index + 0.5) * lineHeight;
        const intersections: number[] = [];

        for (let pointIndex = 0; pointIndex < polygonPoints.length; pointIndex++) {
          const [x1, y1] = polygonPoints.at(pointIndex)!;
          const [x2, y2] = polygonPoints.at((pointIndex + 1) % polygonPoints.length)!;
          if (
            (y1 <= lineCenterY && y2 > lineCenterY) ||
            (y2 <= lineCenterY && y1 > lineCenterY)
          ) {
            intersections.push(x1 + ((lineCenterY - y1) * (x2 - x1)) / (y2 - y1));
          }
        }

        if (intersections.length >= 2) {
          intersections.sort((left, right) => left - right);
          let best = { left: boxX, right: boxX + maxWidth };
          let widest = 0;
          for (let intersectionIndex = 0; intersectionIndex < intersections.length - 1; intersectionIndex += 2) {
            const left = Math.max(intersections.at(intersectionIndex)!, boxX);
            const right = Math.min(intersections.at(intersectionIndex + 1)!, boxX + maxWidth);
            if (right - left > widest) {
              widest = right - left;
              best = { left, right };
            }
          }
          if (widest > 0) return best;
        }
        return { left: boxX, right: boxX + maxWidth };
      };

      const tryWrap = (lineCount: number) => {
        const lines: string[] = [];
        const centers: number[] = [];
        let currentLine = "";
        let lineIndex = 0;

        for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
          const paragraph = paragraphs.at(paragraphIndex)!;
          if (!paragraph) {
            const span = spanAt(lineCount, lineIndex);
            lines.push("");
            centers.push((span.left + span.right) / 2);
            lineIndex++;
            if (lineIndex >= lineCount) return null;
            continue;
          }
          for (const word of paragraph.split(" ")) {
            const span = spanAt(lineCount, lineIndex);
            const allowedWidth = (span.right - span.left) * SHAPE_WIDTH_ALLOWANCE;
            if (measure(fontSize, word) > allowedWidth) {
              if (currentLine) {
                lines.push(currentLine);
                centers.push((span.left + span.right) / 2);
                lineIndex++;
                if (lineIndex >= lineCount) return null;
              }
              let wordPart = "";
              for (const character of word) {
                const nextSpan = spanAt(lineCount, lineIndex);
                if (
                  measure(fontSize, wordPart + character) >
                    (nextSpan.right - nextSpan.left) * SHAPE_WIDTH_ALLOWANCE &&
                  wordPart
                ) {
                  lines.push(wordPart);
                  centers.push((nextSpan.left + nextSpan.right) / 2);
                  wordPart = character;
                  lineIndex++;
                  if (lineIndex >= lineCount) return null;
                } else {
                  wordPart += character;
                }
              }
              currentLine = wordPart;
            } else {
              const nextLine = currentLine ? `${currentLine} ${word}` : word;
              if (measure(fontSize, nextLine) > allowedWidth && currentLine) {
                lines.push(currentLine);
                centers.push((span.left + span.right) / 2);
                currentLine = word;
                lineIndex++;
                if (lineIndex >= lineCount) return null;
              } else {
                currentLine = nextLine;
              }
            }
          }
          if (currentLine) {
            const span = spanAt(lineCount, lineIndex);
            lines.push(currentLine);
            centers.push((span.left + span.right) / 2);
            currentLine = "";
            lineIndex++;
            if (lineIndex >= lineCount && paragraphIndex < paragraphs.length - 1) return null;
          }
        }
        return lines.length <= lineCount ? { lines, centers } : null;
      };

      for (let lineCount = 1; lineCount <= Math.floor(maxHeight / lineHeight); lineCount++) {
        const wrapped = tryWrap(lineCount);
        if (wrapped) return { lines: wrapped.lines, lineCenters: wrapped.centers, failed: false };
      }
    }

    if (shape !== "elliptical" || polygonPoints) {
      const lines: string[] = [];
      let wordOverflow = false;
      for (const paragraph of paragraphs) {
        if (!paragraph) {
          lines.push("");
          continue;
        }
        let currentLine = "";
        for (const word of paragraph.split(" ")) {
          if (measure(fontSize, word) > maxWidth) {
            wordOverflow = true;
            if (currentLine) lines.push(currentLine);
            let wordPart = "";
            for (const character of word) {
              if (measure(fontSize, wordPart + character) > maxWidth && wordPart) {
                lines.push(wordPart);
                wordPart = character;
              } else {
                wordPart += character;
              }
            }
            currentLine = wordPart;
          } else {
            const nextLine = currentLine ? `${currentLine} ${word}` : word;
            if (measure(fontSize, nextLine) > maxWidth && currentLine) {
              lines.push(currentLine);
              currentLine = word;
            } else {
              currentLine = nextLine;
            }
          }
        }
        if (currentLine) lines.push(currentLine);
      }
      return {
        lines,
        lineCenters: lines.map(() => boxX + maxWidth / 2),
        failed: wordOverflow,
      };
    }

    const lineHeight = fontSize * LINE_HEIGHT_MULTIPLIER;
    const halfHeight = maxHeight / 2;
    const halfWidth = maxWidth / 2;
    const allowedWidth = (lineIndex: number, lineCount: number) => {
      const dy = (lineIndex + 0.5 - lineCount / 2) * lineHeight;
      const ratio = dy / halfHeight;
      return Math.abs(ratio) >= 1
        ? 0
        : 2 * halfWidth * Math.sqrt(1 - ratio * ratio) * SHAPE_WIDTH_ALLOWANCE;
    };
    const tryEllipse = (lineCount: number) => {
      const lines: string[] = [];
      let currentLine = "";
      let lineIndex = 0;
      for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
        const paragraph = paragraphs.at(paragraphIndex)!;
        if (!paragraph) {
          lines.push("");
          lineIndex++;
          if (lineIndex >= lineCount) return null;
          continue;
        }
        for (const word of paragraph.split(" ")) {
          const width = allowedWidth(lineIndex, lineCount);
          if (width <= 0) return null;
          if (measure(fontSize, word) > width) {
            if (currentLine) {
              lines.push(currentLine);
              lineIndex++;
              if (lineIndex >= lineCount) return null;
            }
            let wordPart = "";
            for (const character of word) {
              if (measure(fontSize, wordPart + character) > allowedWidth(lineIndex, lineCount) && wordPart) {
                lines.push(wordPart);
                wordPart = character;
                lineIndex++;
                if (lineIndex >= lineCount) return null;
              } else {
                wordPart += character;
              }
            }
            currentLine = wordPart;
          } else {
            const nextLine = currentLine ? `${currentLine} ${word}` : word;
            if (measure(fontSize, nextLine) > width && currentLine) {
              lines.push(currentLine);
              currentLine = word;
              lineIndex++;
              if (lineIndex >= lineCount) return null;
            } else {
              currentLine = nextLine;
            }
          }
        }
        if (currentLine) {
          lines.push(currentLine);
          currentLine = "";
          lineIndex++;
          if (lineIndex >= lineCount && paragraphIndex < paragraphs.length - 1) return null;
        }
      }
      return lines.length <= lineCount ? lines : null;
    };

    for (let lineCount = 1; lineCount <= Math.floor(maxHeight / lineHeight); lineCount++) {
      const lines = tryEllipse(lineCount);
      if (lines) {
        return { lines, lineCenters: lines.map(() => boxX + maxWidth / 2), failed: false };
      }
    }

    const lines: string[] = [];
    for (const paragraph of paragraphs) {
      if (!paragraph) {
        lines.push("");
        continue;
      }
      let currentLine = "";
      for (const word of paragraph.split(" ")) {
        const nextLine = currentLine ? `${currentLine} ${word}` : word;
        if (measure(fontSize, nextLine) > maxWidth && currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = nextLine;
        }
      }
      if (currentLine) lines.push(currentLine);
    }
    return { lines, lineCenters: lines.map(() => boxX + maxWidth / 2), failed: true };
  };

  const maxStartSize = Math.min(Math.floor(maxHeight / 2), 72);
  const startSize = Math.max(maxStartSize, defaultFontSize);
  const evaluated = new Map<number, EvaluatedTextWrap>();
  const evaluate = (fontSize: number) => {
    const cached = evaluated.get(fontSize);
    if (cached) return cached;
    const res = wrapText(fontSize);
    const widestLine = res.lines.reduce(
      (widest, line) => Math.max(widest, measure(fontSize, line)),
      0,
    );
    const fitsHeight = res.lines.length * fontSize * LINE_HEIGHT_MULTIPLIER <= maxHeight;
    const unbroken =
      res.lines.join(" ").split(/\s+/).filter(Boolean).join(" ") ===
      cleanText.split(/\s+/).filter(Boolean).join(" ");
    const out = {
      res,
      fitsHeight,
      fitsClean: fitsHeight && !res.failed && unbroken && widestLine <= maxWidth,
      fitsContained: fitsHeight && widestLine <= maxWidth,
    };
    evaluated.set(fontSize, out);
    return out;
  };
  const largestSizeWhere = (criterion: "clean" | "contained" | "height") => {
    let low = FONT_SIZE_MINIMUM;
    let high = startSize;
    let best: { fontSize: number; res: TextWrap } | null = null;
    while (low <= high) {
      const fontSize = Math.floor((low + high) / 2);
      const result = evaluate(fontSize);
      const passes = {
        clean: result.fitsClean,
        contained: result.fitsContained,
        height: result.fitsHeight,
      }[criterion];
      if (passes) {
        best = { fontSize, res: result.res };
        low = fontSize + 1;
      } else {
        high = fontSize - 1;
      }
    }
    return best;
  };

  const best =
    largestSizeWhere("clean") ??
    largestSizeWhere("contained") ??
    largestSizeWhere("height");
  const fontSize = best?.fontSize ?? FONT_SIZE_MINIMUM;
  const result = best?.res ?? wrapText(fontSize);
  return {
    fontSize,
    lines: result.lines,
    overflow: result.lines.length * fontSize * LINE_HEIGHT_MULTIPLIER > maxHeight || result.failed,
    lineCenters: result.lineCenters,
  };
}
