export interface FitResult {
  fontSize: number;
  lines: string[];
  overflow: boolean;
}

export const fitTextInBox = (
  text: string,
  maxWidth: number,
  maxHeight: number,
  fontFamily: string,
  defaultFontSize: number = 16,
  shape: 'rectangular' | 'elliptical' = 'rectangular',
): FitResult => {
  const cleanText = (text || "").replace(/\r\n/g, "\n");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { fontSize: defaultFontSize, lines: [cleanText], overflow: false };
  }

  const wrapText = (txt: string, fSize: number): string[] => {
    ctx.font = `bold ${fSize}px "${fontFamily}", sans-serif`;
    const paragraphs = txt.split("\n");
    const resultLines: string[] = [];

    if (shape !== 'elliptical') {
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
      return resultLines;
    }

    // --- Elliptical wrapping ---
    const lineHeight = fSize * 1.2;
    const halfH = maxHeight / 2;
    const halfW = maxWidth / 2;

    // Helper to wrap text for a fixed number of lines N
    const tryWrapForNLines = (N: number): string[] | null => {
      const tentativeLines: string[] = [];
      let currentLine = "";
      let lineIndex = 0;

      // Compute allowed width for each line i from 0 to N-1
      const getLineAllowedWidth = (idx: number): number => {
        const dy = (idx + 0.5 - N / 2) * lineHeight;
        const ratio = dy / halfH;
        if (Math.abs(ratio) >= 1.0) return 0;
        return 2.0 * halfW * Math.sqrt(1.0 - ratio * ratio) * 0.92;
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
    if (maxPossibleLines <= 0) {
      return [cleanText];
    }

    for (let N = 1; N <= maxPossibleLines; N++) {
      const wrapped = tryWrapForNLines(N);
      if (wrapped !== null) {
        return wrapped;
      }
    }

    // Fallback: simple rectangular wrap if elliptical fit fails completely
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
    return fallbackLines;
  };

  let fontSize = defaultFontSize;
  let lines = wrapText(cleanText, fontSize);
  const lineHeightMultiplier = 1.2;

  while (fontSize > 6) {
    const totalHeight = lines.length * fontSize * lineHeightMultiplier;
    if (totalHeight <= maxHeight) {
      return { fontSize, lines, overflow: false };
    }
    fontSize--;
    lines = wrapText(cleanText, fontSize);
  }

  const totalHeight = lines.length * fontSize * lineHeightMultiplier;
  return {
    fontSize: 6,
    lines,
    overflow: totalHeight > maxHeight,
  };
};
