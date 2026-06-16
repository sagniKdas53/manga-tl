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
            currentLine = "";
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
  };

  let fontSize = defaultFontSize;
  let lines = wrapText(cleanText, fontSize);
  const lineHeightMultiplier = 1.2;

  while (fontSize > 10) {
    const totalHeight = lines.length * fontSize * lineHeightMultiplier;
    if (totalHeight <= maxHeight) {
      return { fontSize, lines, overflow: false };
    }
    fontSize--;
    lines = wrapText(cleanText, fontSize);
  }

  const totalHeight = lines.length * fontSize * lineHeightMultiplier;
  return {
    fontSize: 10,
    lines,
    overflow: totalHeight > maxHeight,
  };
};
