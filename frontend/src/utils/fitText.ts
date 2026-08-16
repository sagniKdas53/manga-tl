export interface FitResult {
  fontSize: number;
  lines: string[];
  overflow: boolean;
  lineCenters?: number[];
}

/**
 * Wait for every distinct font/weight/style combination an export is about to draw.
 *
 * Canvas `fillText` never triggers a web font load the way DOM text does -- it just silently
 * substitutes the fallback if the requested face isn't already in `document.fonts` at the moment
 * it's called. On-screen text is fine because some earlier DOM paint has almost always already
 * triggered the `@font-face` load by the time the user does anything; a freshly built export
 * canvas has no such guarantee, especially moments after opening a page. `document.fonts.load`
 * requests the face explicitly and is a no-op if it's already loaded, so this is safe to call
 * unconditionally before every canvas-based export.
 */
export const ensureFontsLoaded = async (
  elements: Iterable<{
    font?: string | null;
    fontWeight?: string | null;
    fontStyle?: string | null;
  }>,
): Promise<void> => {
  // The CSS Font Loading API isn't implemented in every environment (jsdom, notably) -- fall
  // back to the old always-fell-back-silently behaviour there rather than throwing.
  if (typeof document === "undefined" || !document.fonts) return;

  const specs = new Set<string>();
  for (const el of elements) {
    const style =
      (el.fontStyle || "normal").toLowerCase() === "italic" ? "italic " : "";
    const weight = el.fontWeight || "bold";
    const family = el.font || "Comic Neue";
    specs.add(`${weight} ${style}16px "${family}"`);
  }
  await Promise.all(
    [...specs].map((spec) =>
      document.fonts.load(spec).catch(() => {
        // A face that fails to load falls back the same way it always did; this is strictly
        // best-effort and must never block the export.
      }),
    ),
  );
};

/**
 * Keep a drawn line inside the box it belongs to.
 *
 * A line's centre comes from the shape it was wrapped to and its width from the glyphs, so an
 * off-centre line can start left of the box or end right of it — and walk into the next panel. A
 * line too wide for the box at all has nowhere to go, so it stays centred.
 */
export const clampLineCenter = (
  center: number,
  lineWidth: number,
  boxX: number,
  boxWidth: number,
): number => {
  if (lineWidth > boxWidth) return boxX + boxWidth / 2;
  const half = lineWidth / 2;
  return Math.min(Math.max(center, boxX + half), boxX + boxWidth - half);
};

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
  const cleanText = (text || "").replace(/\r\n/g, "\n");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return {
      fontSize: defaultFontSize,
      lines: [cleanText],
      overflow: false,
      lineCenters: [boxX + maxWidth / 2],
    };
  }

  let polygonPoints: [number, number][] | null = null;
  if (maskPolygon) {
    try {
      const parsed =
        typeof maskPolygon === "string" ? JSON.parse(maskPolygon) : maskPolygon;
      if (
        Array.isArray(parsed) &&
        parsed.every((p) => Array.isArray(p) && p.length === 2)
      ) {
        polygonPoints = parsed as [number, number][];
      }
    } catch (e) {
      console.error("Failed to parse maskPolygon", e);
    }
  }

  // The mask is a flow constraint only when it is wider than the box it is being flowed into.
  //
  // It serves two purposes at once: it is the shape painted over the source text, and — below — the
  // shape the lines are wrapped to. Those agree for a balloon, where the mask is the outline and the
  // box is an inset of it. They disagree for free-floating text, where the mask is the tight
  // rectangle round the vertical Japanese column: wrapping to it would set English back down that
  // column and undo the box the caller asked for. When the mask does not span the box, the box is
  // the deliberate one of the two, so the mask keeps its erasing job and loses its typesetting one.
  if (polygonPoints) {
    const xs = polygonPoints.map((p) => p[0]);
    if (Math.min(...xs) > boxX + 2 || Math.max(...xs) < boxX + maxWidth - 2) {
      polygonPoints = null;
    }
  }

  const wrapText = (
    txt: string,
    fSize: number,
  ): { lines: string[]; lineCenters: number[]; failed: boolean } => {
    ctx.font = `${fontWeight} ${fontStyle === "italic" ? "italic " : ""}${fSize}px "${fontFamily}", sans-serif`;
    const paragraphs = txt.split("\n");

    // 1. Polygon-aware wrapping
    if (polygonPoints && polygonPoints.length > 0) {
      const lineHeight = fSize * 1.2;
      const tryWrapForNLines = (
        N: number,
      ): { lines: string[]; lineCenters: number[] } | null => {
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
            const p1 = polygonPoints!.at(i)!;
            const p2 = polygonPoints!.at((i + 1) % polygonPoints!.length)!;
            const [x1, y1] = p1;
            const [x2, y2] = p2;
            if (
              (y1 <= lineCenterY && y2 > lineCenterY) ||
              (y2 <= lineCenterY && y1 > lineCenterY)
            ) {
              const ix = x1 + ((lineCenterY - y1) * (x2 - x1)) / (y2 - y1);
              intersects.push(ix);
            }
          }

          if (intersects.length >= 2) {
            intersects.sort((a, b) => a - b);
            let bestSpan = { left: boxX, right: boxX + maxWidth };
            let maxOverlapLen = 0;
            for (let i = 0; i < intersects.length - 1; i += 2) {
              const segmentLeft = intersects.at(i)!;
              const segmentRight = intersects.at(i + 1)!;
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
                if (
                  ctx.measureText(testPart).width > nextAllowedW &&
                  currentWordPart
                ) {
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
            if (
              lineIndex >= N &&
              paragraphs.indexOf(para) < paragraphs.length - 1
            )
              return null;
          }
        }

        return tentativeLines.length <= N
          ? { lines: tentativeLines, lineCenters: tentativeCenters }
          : null;
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
      return {
        lines: fallbackLines,
        lineCenters: fallbackCenters,
        failed: true,
      };
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
              if (
                ctx.measureText(testPart).width > maxWidth &&
                currentWordPart
              ) {
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
              if (
                ctx.measureText(testPart).width > currentAllowedW &&
                currentWordPart
              ) {
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
          if (
            lineIndex >= N &&
            paragraphs.indexOf(para) < paragraphs.length - 1
          )
            return null;
        }
      }

      return tentativeLines.length <= N ? tentativeLines : null;
    };

    const maxPossibleLines = Math.floor(maxHeight / lineHeight);
    if (maxPossibleLines > 0) {
      for (let N = 1; N <= maxPossibleLines; N++) {
        const wrapped = tryWrapForNLines(N);
        if (wrapped !== null) {
          return {
            lines: wrapped,
            lineCenters: wrapped.map(() => boxX + maxWidth / 2),
            failed: false,
          };
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
    return {
      lines: fallbackLines,
      lineCenters: fallbackLines.map(() => boxX + maxWidth / 2),
      failed: true,
    };
  };

  // D7 (docs/render_quality_gap_2026-08-05.md), same bug as render.py's fit_text_in_box_py:
  // `maxWidth / 3` assumed roughly 3 characters per line and capped the search before it ever
  // ran. `largestSizeWhere(true)` below already rejects any size that overflows the box or
  // breaks a word, so the pre-cap added no safety -- it only ever foreclosed sizes the search
  // would otherwise have accepted, hitting hardest on tall narrow boxes (vertical Japanese
  // speech bubbles). Dropped the width term, matching the Python fix.
  const maxStartSize = Math.min(Math.floor(maxHeight / 2), 72);
  const startSize = Math.max(maxStartSize, defaultFontSize);

  const minFontSize = 6;
  const lineHeightMultiplier = 1.2;

  type Wrap = { lines: string[]; lineCenters: number[]; failed: boolean };
  const evaluated = new Map<
    number,
    { res: Wrap; fitsHeight: boolean; fitsClean: boolean }
  >();

  /** True when the wrap cut a word apart to make it fit — "collection" as "collect" / "ion". */
  const brokeAWord = (res: Wrap) =>
    res.lines.join(" ").split(/\s+/).filter(Boolean).join(" ") !==
    cleanText.split(/\s+/).filter(Boolean).join(" ");

  const widestLine = (res: Wrap, fSize: number) => {
    ctx.font = `${fontWeight} ${fontStyle === "italic" ? "italic " : ""}${fSize}px "${fontFamily}", sans-serif`;
    return res.lines.reduce(
      (widest, line) => Math.max(widest, ctx.measureText(line).width),
      0,
    );
  };

  const evaluate = (fSize: number) => {
    const cached = evaluated.get(fSize);
    if (cached) return cached;
    const res = wrapText(cleanText, fSize);
    const fitsHeight =
      res.lines.length * fSize * lineHeightMultiplier <= maxHeight;
    const fitsClean =
      fitsHeight &&
      !res.failed &&
      !brokeAWord(res) &&
      widestLine(res, fSize) <= maxWidth;
    const out = { res, fitsHeight, fitsClean };
    evaluated.set(fSize, out);
    return out;
  };

  const largestSizeWhere = (clean: boolean) => {
    let low = minFontSize;
    let high = startSize;
    let best: { fs: number; res: Wrap } | null = null;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const { res, fitsHeight, fitsClean } = evaluate(mid);
      if (clean ? fitsClean : fitsHeight) {
        best = { fs: mid, res };
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  };

  // Largest size that lays the text out whole: every word intact and every line inside the box.
  //
  // Height was the only real test before. `failed` covers the explicit fallback wrap, but a word
  // wider than the line it lands on gets split per character *inside* a successful wrap, and that
  // split is invisible here — so the search kept growing the font until the height ran out and
  // returned the largest size that mangles the text rather than the largest size that sets it.
  // The exported page showed it as "CLOTHE/S", "IMMEDI/ATELY", "colle/cted".
  //
  // When nothing sets cleanly — a single word wider than the box even at 6px — fall back to the old
  // height-only rule, so such a region still gets the largest legible size rather than the minimum.
  const best = largestSizeWhere(true) ?? largestSizeWhere(false);
  const bestFs = best?.fs ?? minFontSize;
  const bestRes = best?.res ?? wrapText(cleanText, minFontSize);

  const totalHeight = bestRes.lines.length * bestFs * lineHeightMultiplier;
  return {
    fontSize: bestFs,
    lines: bestRes.lines,
    overflow: totalHeight > maxHeight || bestRes.failed,
    lineCenters: bestRes.lineCenters,
  };
};
