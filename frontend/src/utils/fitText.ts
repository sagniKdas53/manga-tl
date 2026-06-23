export interface FitResult {
  fontSize: number;
  lines: string[];
  overflow: boolean;
  lineCenters?: number[];
}

export const fitTextInBox = (
  text: string,
  maxWidth: number,
  maxHeight: number,
  fontFamily: string,
  defaultFontSize: number = 16,
  shape: 'rectangular' | 'elliptical' = 'rectangular',
  boxX: number = 0,
  boxY: number = 0,
  maskPolygon?: string | null,
  fontWeight: string = 'bold',
  fontStyle: string = 'normal',
): FitResult => {
  const cleanText = (text || "").replace(/\r\n/g, "\n");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { fontSize: defaultFontSize, lines: [cleanText], overflow: false, lineCenters: [boxX + maxWidth / 2] };
  }

  let polygonPoints: [number, number][] | null = null;
  if (maskPolygon) {
    try {
      const parsed = typeof maskPolygon === 'string' ? JSON.parse(maskPolygon) : maskPolygon;
      if (Array.isArray(parsed) && parsed.every(p => Array.isArray(p) && p.length === 2)) {
        polygonPoints = parsed as [number, number][];
      }
    } catch (e) {
      console.error("Failed to parse maskPolygon", e);
    }
  }

  const wrapText = (txt: string, fSize: number): { lines: string[]; lineCenters: number[]; failed: boolean } => {
    ctx.font = `${fontWeight} ${fontStyle === 'italic' ? 'italic ' : ''}${fSize}px "${fontFamily}", sans-serif`;
    const paragraphs = txt.split("\n");

    // 1. Polygon-aware wrapping
    if (polygonPoints && polygonPoints.length > 0) {
      const lineHeight = fSize * 1.2;
      const tryWrapForNLines = (N: number): { lines: string[]; lineCenters: number[] } | null => {
        const tentativeLines: string[] = [];
        const tentativeCenters: number[] = [];
        let currentLine = "";
        let lineIndex = 0;

        const getLineSpan = (idx: number): { left: number; right: number } => {
          const totalTextHeight = N * lineHeight;
          const yStart = boxY + (maxHeight - totalTextHeight) / 2;
          const lineCenterY = yStart + (idx + 0.5) * lineHeight;

          const intersects: number[] = [];
          for (let i = 0; i < polygonPoints!.length; i++) {
            const p1 = polygonPoints![i];
            const p2 = polygonPoints![(i + 1) % polygonPoints!.length];
            const [x1, y1] = p1;
            const [x2, y2] = p2;
            if ((y1 <= lineCenterY && y2 > lineCenterY) || (y2 <= lineCenterY && y1 > lineCenterY)) {
              const ix = x1 + ((lineCenterY - y1) * (x2 - x1)) / (y2 - y1);
              intersects.push(ix);
            }
          }

          if (intersects.length >= 2) {
            intersects.sort((a, b) => a - b);
            let bestSpan = { left: boxX, right: boxX + maxWidth };
            let maxOverlapLen = 0;
            for (let i = 0; i < intersects.length - 1; i += 2) {
              const segmentLeft = intersects[i];
              const segmentRight = intersects[i + 1];
              const overlapLeft = Math.max(segmentLeft, boxX);
              const overlapRight = Math.min(segmentRight, boxX + maxWidth);
              const overlapLen = overlapRight - overlapLeft;
              if (overlapLen > maxOverlapLen) {
                maxOverlapLen = overlapLen;
                bestSpan = { left: overlapLeft, right: overlapRight };
              }
            }
            if (maxOverlapLen > 0) {
              return bestSpan;
            }
          }
          return { left: boxX, right: boxX + maxWidth };
        };

        for (const para of paragraphs) {
          if (!para) {
            tentativeLines.push("");
            const span = getLineSpan(lineIndex);
            tentativeCenters.push((span.left + span.right) / 2);
            lineIndex++;
            if (lineIndex >= N) return null;
            continue;
          }

          const words = para.split(" ");
          for (const word of words) {
            const span = getLineSpan(lineIndex);
            const allowedW = (span.right - span.left) * 0.95;
            const wordWidth = ctx.measureText(word).width;

            if (wordWidth > allowedW) {
              if (currentLine) {
                tentativeLines.push(currentLine);
                tentativeCenters.push((span.left + span.right) / 2);
                lineIndex++;
                if (lineIndex >= N) return null;
              }

              let currentWordPart = "";
              for (const char of word) {
                const testPart = currentWordPart + char;
                const nextSpan = getLineSpan(lineIndex);
                const nextAllowedW = (nextSpan.right - nextSpan.left) * 0.95;
                if (ctx.measureText(testPart).width > nextAllowedW && currentWordPart) {
                  tentativeLines.push(currentWordPart);
                  tentativeCenters.push((nextSpan.left + nextSpan.right) / 2);
                  currentWordPart = char;
                  lineIndex++;
                  if (lineIndex >= N) return null;
                } else {
                  currentWordPart = testPart;
                }
              }
              currentLine = currentWordPart;
            } else {
              const testLine = currentLine ? `${currentLine} ${word}` : word;
              if (ctx.measureText(testLine).width > allowedW && currentLine) {
                tentativeLines.push(currentLine);
                tentativeCenters.push((span.left + span.right) / 2);
                currentLine = word;
                lineIndex++;
                if (lineIndex >= N) return null;
              } else {
                currentLine = testLine;
              }
            }
          }

          if (currentLine) {
            const span = getLineSpan(lineIndex);
            tentativeLines.push(currentLine);
            tentativeCenters.push((span.left + span.right) / 2);
            currentLine = "";
            lineIndex++;
            if (lineIndex >= N && paragraphs.indexOf(para) < paragraphs.length - 1) return null;
          }
        }

        return tentativeLines.length <= N ? { lines: tentativeLines, lineCenters: tentativeCenters } : null;
      };

      const maxPossibleLines = Math.floor(maxHeight / lineHeight);
      if (maxPossibleLines > 0) {
        for (let N = 1; N <= maxPossibleLines; N++) {
          const wrapped = tryWrapForNLines(N);
          if (wrapped !== null) {
            return { ...wrapped, failed: false };
          }
        }
      }

      // Fallback if fits failed
      const fallbackLines: string[] = [];
      const fallbackCenters: number[] = [];
      for (const para of paragraphs) {
        if (!para) {
          fallbackLines.push("");
          fallbackCenters.push(boxX + maxWidth / 2);
          continue;
        }
        const words = para.split(" ");
        let currentLine = "";
        for (const word of words) {
          const testLine = currentLine ? `${currentLine} ${word}` : word;
          if (ctx.measureText(testLine).width > maxWidth && currentLine) {
            fallbackLines.push(currentLine);
            fallbackCenters.push(boxX + maxWidth / 2);
            currentLine = word;
          } else {
            currentLine = testLine;
          }
        }
        if (currentLine) {
          fallbackLines.push(currentLine);
          fallbackCenters.push(boxX + maxWidth / 2);
        }
      }
      return { lines: fallbackLines, lineCenters: fallbackCenters, failed: true };
    }

    // 2. Rectangular wrapping (non-elliptical fallback)
    if (shape !== "elliptical") {
      const resultLines: string[] = [];
      let wordOverflow = false;
      for (const para of paragraphs) {
        if (!para) {
          resultLines.push("");
          continue;
        }
        const words = para.split(" ");
        let currentLine = "";

        for (const word of words) {
          const wordWidth = ctx.measureText(word).width;
          if (wordWidth > maxWidth) {
            wordOverflow = true;
            if (currentLine) {
              resultLines.push(currentLine);
            }
            let currentWordPart = "";
            for (const char of word) {
              const testPart = currentWordPart + char;
              if (ctx.measureText(testPart).width > maxWidth && currentWordPart) {
                resultLines.push(currentWordPart);
                currentWordPart = char;
              } else {
                currentWordPart = testPart;
              }
            }
            currentLine = currentWordPart;
          } else {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            const metrics = ctx.measureText(testLine);
            if (metrics.width > maxWidth && currentLine) {
              resultLines.push(currentLine);
              currentLine = word;
            } else {
              currentLine = testLine;
            }
          }
        }
        if (currentLine) {
          resultLines.push(currentLine);
        }
      }
      const lineCenters = resultLines.map(() => boxX + maxWidth / 2);
      return { lines: resultLines, lineCenters, failed: wordOverflow };
    }

    // 3. Elliptical wrapping (legacy elliptical)
    const lineHeight = fSize * 1.2;
    const halfH = maxHeight / 2;
    const halfW = maxWidth / 2;

    const tryWrapForNLines = (N: number): string[] | null => {
      const tentativeLines: string[] = [];
      let currentLine = "";
      let lineIndex = 0;

      const getLineAllowedWidth = (idx: number): number => {
        const dy = (idx + 0.5 - N / 2) * lineHeight;
        const ratio = dy / halfH;
        if (Math.abs(ratio) >= 1.0) return 0;
        return 2.0 * halfW * Math.sqrt(1.0 - ratio * ratio) * 0.95;
      };

      for (const para of paragraphs) {
        if (!para) {
          tentativeLines.push("");
          lineIndex++;
          if (lineIndex >= N) return null;
          continue;
        }

        const words = para.split(" ");
        for (const word of words) {
          const allowedW = getLineAllowedWidth(lineIndex);
          if (allowedW <= 0) return null;

          const wordWidth = ctx.measureText(word).width;

          if (wordWidth > allowedW) {
            if (currentLine) {
              tentativeLines.push(currentLine);
              lineIndex++;
              if (lineIndex >= N) return null;
            }

            let currentWordPart = "";
            for (const char of word) {
              const testPart = currentWordPart + char;
              const currentAllowedW = getLineAllowedWidth(lineIndex);
              if (ctx.measureText(testPart).width > currentAllowedW && currentWordPart) {
                tentativeLines.push(currentWordPart);
                currentWordPart = char;
                lineIndex++;
                if (lineIndex >= N) return null;
              } else {
                currentWordPart = testPart;
              }
            }
            currentLine = currentWordPart;
          } else {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            if (ctx.measureText(testLine).width > allowedW && currentLine) {
              tentativeLines.push(currentLine);
              currentLine = word;
              lineIndex++;
              if (lineIndex >= N) return null;
            } else {
              currentLine = testLine;
            }
          }
        }

        if (currentLine) {
          tentativeLines.push(currentLine);
          currentLine = "";
          lineIndex++;
          if (lineIndex >= N && paragraphs.indexOf(para) < paragraphs.length - 1) return null;
        }
      }

      return tentativeLines.length <= N ? tentativeLines : null;
    };

    const maxPossibleLines = Math.floor(maxHeight / lineHeight);
    if (maxPossibleLines > 0) {
      for (let N = 1; N <= maxPossibleLines; N++) {
        const wrapped = tryWrapForNLines(N);
        if (wrapped !== null) {
          return { lines: wrapped, lineCenters: wrapped.map(() => boxX + maxWidth / 2), failed: false };
        }
      }
    }

    const fallbackLines: string[] = [];
    for (const para of paragraphs) {
      if (!para) {
        fallbackLines.push("");
        continue;
      }
      const words = para.split(" ");
      let currentLine = "";
      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        if (ctx.measureText(testLine).width > maxWidth && currentLine) {
          fallbackLines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }
      if (currentLine) fallbackLines.push(currentLine);
    }
    return { lines: fallbackLines, lineCenters: fallbackLines.map(() => boxX + maxWidth / 2), failed: true };
  };

  const maxStartSize = Math.min(Math.floor(maxHeight / 2), Math.floor(maxWidth / 3), 72);
  const startSize = Math.max(maxStartSize, defaultFontSize);

  let low = 6;
  let high = startSize;
  let bestFs = 6;
  let bestRes = wrapText(cleanText, 6);
  const lineHeightMultiplier = 1.2;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const wrapResult = wrapText(cleanText, mid);
    const totalHeight = wrapResult.lines.length * mid * lineHeightMultiplier;
    if (totalHeight <= maxHeight && !wrapResult.failed) {
      bestFs = mid;
      bestRes = wrapResult;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const totalHeight = bestRes.lines.length * bestFs * lineHeightMultiplier;
  return {
    fontSize: bestFs,
    lines: bestRes.lines,
    overflow: totalHeight > maxHeight || bestRes.failed,
    lineCenters: bestRes.lineCenters,
  };
};
