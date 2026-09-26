var PageSceneStatic = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/static-entry.ts
  var static_entry_exports = {};
  __export(static_entry_exports, {
    mountPageScene: () => mountPageScene
  });

  // ../../packages/page-scene/src/layout.ts
  var DEFAULT_TEXT_BOX_INSET = {
    paddingPx: 4,
    safetyPercent: 95
  };
  var FONT_SIZE_MINIMUM = 6;
  var LINE_HEIGHT_MULTIPLIER = 1.2;
  var SHAPE_WIDTH_ALLOWANCE = 0.95;
  function textFitBox(box, inset = DEFAULT_TEXT_BOX_INSET) {
    const padding = Number.isFinite(inset.paddingPx) ? Math.max(0, inset.paddingPx) : DEFAULT_TEXT_BOX_INSET.paddingPx;
    const safety = Number.isFinite(inset.safetyPercent) ? Math.min(100, Math.max(1, inset.safetyPercent)) : DEFAULT_TEXT_BOX_INSET.safetyPercent;
    const usableW = Math.max(1, box.width - padding * 2);
    const usableH = Math.max(1, box.height - padding * 2);
    return {
      x: box.x + padding,
      y: box.y + padding,
      width: Math.max(1, Math.floor(usableW * safety / 100)),
      height: Math.max(1, Math.floor(usableH * safety / 100))
    };
  }
  function clampLineCenter(center, lineWidth, boxX, boxWidth) {
    if (lineWidth > boxWidth) return boxX + boxWidth / 2;
    const half = lineWidth / 2;
    return Math.min(Math.max(center, boxX + half), boxX + boxWidth - half);
  }
  function parsePolygon(maskPolygon) {
    if (!maskPolygon) return null;
    try {
      const parsed = JSON.parse(maskPolygon);
      if (Array.isArray(parsed) && parsed.every(
        (point) => Array.isArray(point) && point.length === 2 && point.every((coordinate) => typeof coordinate === "number")
      )) {
        return parsed;
      }
    } catch {
    }
    return null;
  }
  function fitTextInBox({
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
    fontStyle = "normal"
  }, measureText) {
    const cleanText = (text || "").replace(/\r\n/g, "\n");
    let polygonPoints = parsePolygon(maskPolygon);
    if (polygonPoints) {
      const xs = polygonPoints.map((point) => point[0]);
      if (Math.min(...xs) > boxX + 2 || Math.max(...xs) < boxX + maxWidth - 2) {
        polygonPoints = null;
      }
    }
    const fontFor = (fontSize2) => `${fontWeight} ${fontStyle === "italic" ? "italic " : ""}${fontSize2}px "${fontFamily}", sans-serif`;
    const measure = (fontSize2, value) => measureText(fontFor(fontSize2), value);
    const paragraphs = cleanText.split("\n");
    const wrapText = (fontSize2) => {
      if (polygonPoints && polygonPoints.length > 0) {
        const lineHeight2 = fontSize2 * LINE_HEIGHT_MULTIPLIER;
        const spanAt = (lineCount, index) => {
          const totalTextHeight = lineCount * lineHeight2;
          const yStart = boxY + (maxHeight - totalTextHeight) / 2;
          const lineCenterY = yStart + (index + 0.5) * lineHeight2;
          const intersections = [];
          for (let pointIndex = 0; pointIndex < polygonPoints.length; pointIndex++) {
            const [x1, y1] = polygonPoints.at(pointIndex);
            const [x2, y2] = polygonPoints.at((pointIndex + 1) % polygonPoints.length);
            if (y1 <= lineCenterY && y2 > lineCenterY || y2 <= lineCenterY && y1 > lineCenterY) {
              intersections.push(x1 + (lineCenterY - y1) * (x2 - x1) / (y2 - y1));
            }
          }
          if (intersections.length >= 2) {
            intersections.sort((left, right) => left - right);
            let best2 = { left: boxX, right: boxX + maxWidth };
            let widest = 0;
            for (let intersectionIndex = 0; intersectionIndex < intersections.length - 1; intersectionIndex += 2) {
              const left = Math.max(intersections.at(intersectionIndex), boxX);
              const right = Math.min(intersections.at(intersectionIndex + 1), boxX + maxWidth);
              if (right - left > widest) {
                widest = right - left;
                best2 = { left, right };
              }
            }
            if (widest > 0) return best2;
          }
          return { left: boxX, right: boxX + maxWidth };
        };
        const tryWrap = (lineCount) => {
          const lines2 = [];
          const centers = [];
          let currentLine = "";
          let lineIndex = 0;
          for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
            const paragraph = paragraphs.at(paragraphIndex);
            if (!paragraph) {
              const span = spanAt(lineCount, lineIndex);
              lines2.push("");
              centers.push((span.left + span.right) / 2);
              lineIndex++;
              if (lineIndex >= lineCount) return null;
              continue;
            }
            for (const word of paragraph.split(" ")) {
              const span = spanAt(lineCount, lineIndex);
              const allowedWidth2 = (span.right - span.left) * SHAPE_WIDTH_ALLOWANCE;
              if (measure(fontSize2, word) > allowedWidth2) {
                if (currentLine) {
                  lines2.push(currentLine);
                  centers.push((span.left + span.right) / 2);
                  lineIndex++;
                  if (lineIndex >= lineCount) return null;
                }
                let wordPart = "";
                for (const character of word) {
                  const nextSpan = spanAt(lineCount, lineIndex);
                  if (measure(fontSize2, wordPart + character) > (nextSpan.right - nextSpan.left) * SHAPE_WIDTH_ALLOWANCE && wordPart) {
                    lines2.push(wordPart);
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
                if (measure(fontSize2, nextLine) > allowedWidth2 && currentLine) {
                  lines2.push(currentLine);
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
              lines2.push(currentLine);
              centers.push((span.left + span.right) / 2);
              currentLine = "";
              lineIndex++;
              if (lineIndex >= lineCount && paragraphIndex < paragraphs.length - 1) return null;
            }
          }
          return lines2.length <= lineCount ? { lines: lines2, centers } : null;
        };
        for (let lineCount = 1; lineCount <= Math.floor(maxHeight / lineHeight2); lineCount++) {
          const wrapped = tryWrap(lineCount);
          if (wrapped) return { lines: wrapped.lines, lineCenters: wrapped.centers, failed: false };
        }
      }
      if (shape !== "elliptical" || polygonPoints) {
        const lines2 = [];
        let wordOverflow = false;
        for (const paragraph of paragraphs) {
          if (!paragraph) {
            lines2.push("");
            continue;
          }
          let currentLine = "";
          for (const word of paragraph.split(" ")) {
            if (measure(fontSize2, word) > maxWidth) {
              wordOverflow = true;
              if (currentLine) lines2.push(currentLine);
              let wordPart = "";
              for (const character of word) {
                if (measure(fontSize2, wordPart + character) > maxWidth && wordPart) {
                  lines2.push(wordPart);
                  wordPart = character;
                } else {
                  wordPart += character;
                }
              }
              currentLine = wordPart;
            } else {
              const nextLine = currentLine ? `${currentLine} ${word}` : word;
              if (measure(fontSize2, nextLine) > maxWidth && currentLine) {
                lines2.push(currentLine);
                currentLine = word;
              } else {
                currentLine = nextLine;
              }
            }
          }
          if (currentLine) lines2.push(currentLine);
        }
        return {
          lines: lines2,
          lineCenters: lines2.map(() => boxX + maxWidth / 2),
          failed: wordOverflow
        };
      }
      const lineHeight = fontSize2 * LINE_HEIGHT_MULTIPLIER;
      const halfHeight = maxHeight / 2;
      const halfWidth = maxWidth / 2;
      const allowedWidth = (lineIndex, lineCount) => {
        const dy = (lineIndex + 0.5 - lineCount / 2) * lineHeight;
        const ratio = dy / halfHeight;
        return Math.abs(ratio) >= 1 ? 0 : 2 * halfWidth * Math.sqrt(1 - ratio * ratio) * SHAPE_WIDTH_ALLOWANCE;
      };
      const tryEllipse = (lineCount) => {
        const lines2 = [];
        let currentLine = "";
        let lineIndex = 0;
        for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
          const paragraph = paragraphs.at(paragraphIndex);
          if (!paragraph) {
            lines2.push("");
            lineIndex++;
            if (lineIndex >= lineCount) return null;
            continue;
          }
          for (const word of paragraph.split(" ")) {
            const width = allowedWidth(lineIndex, lineCount);
            if (width <= 0) return null;
            if (measure(fontSize2, word) > width) {
              if (currentLine) {
                lines2.push(currentLine);
                lineIndex++;
                if (lineIndex >= lineCount) return null;
              }
              let wordPart = "";
              for (const character of word) {
                if (measure(fontSize2, wordPart + character) > allowedWidth(lineIndex, lineCount) && wordPart) {
                  lines2.push(wordPart);
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
              if (measure(fontSize2, nextLine) > width && currentLine) {
                lines2.push(currentLine);
                currentLine = word;
                lineIndex++;
                if (lineIndex >= lineCount) return null;
              } else {
                currentLine = nextLine;
              }
            }
          }
          if (currentLine) {
            lines2.push(currentLine);
            currentLine = "";
            lineIndex++;
            if (lineIndex >= lineCount && paragraphIndex < paragraphs.length - 1) return null;
          }
        }
        return lines2.length <= lineCount ? lines2 : null;
      };
      for (let lineCount = 1; lineCount <= Math.floor(maxHeight / lineHeight); lineCount++) {
        const lines2 = tryEllipse(lineCount);
        if (lines2) {
          return { lines: lines2, lineCenters: lines2.map(() => boxX + maxWidth / 2), failed: false };
        }
      }
      const lines = [];
      for (const paragraph of paragraphs) {
        if (!paragraph) {
          lines.push("");
          continue;
        }
        let currentLine = "";
        for (const word of paragraph.split(" ")) {
          const nextLine = currentLine ? `${currentLine} ${word}` : word;
          if (measure(fontSize2, nextLine) > maxWidth && currentLine) {
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
    const evaluated = /* @__PURE__ */ new Map();
    const evaluate = (fontSize2) => {
      const cached = evaluated.get(fontSize2);
      if (cached) return cached;
      const res = wrapText(fontSize2);
      const widestLine = res.lines.reduce(
        (widest, line) => Math.max(widest, measure(fontSize2, line)),
        0
      );
      const fitsHeight = res.lines.length * fontSize2 * LINE_HEIGHT_MULTIPLIER <= maxHeight;
      const unbroken = res.lines.join(" ").split(/\s+/).filter(Boolean).join(" ") === cleanText.split(/\s+/).filter(Boolean).join(" ");
      const out = {
        res,
        fitsHeight,
        fitsClean: fitsHeight && !res.failed && unbroken && widestLine <= maxWidth,
        fitsContained: fitsHeight && widestLine <= maxWidth
      };
      evaluated.set(fontSize2, out);
      return out;
    };
    const largestSizeWhere = (criterion) => {
      let low = FONT_SIZE_MINIMUM;
      let high = startSize;
      let best2 = null;
      while (low <= high) {
        const fontSize2 = Math.floor((low + high) / 2);
        const result2 = evaluate(fontSize2);
        const passes = {
          clean: result2.fitsClean,
          contained: result2.fitsContained,
          height: result2.fitsHeight
        }[criterion];
        if (passes) {
          best2 = { fontSize: fontSize2, res: result2.res };
          low = fontSize2 + 1;
        } else {
          high = fontSize2 - 1;
        }
      }
      return best2;
    };
    const best = largestSizeWhere("clean") ?? largestSizeWhere("contained") ?? largestSizeWhere("height");
    const fontSize = best?.fontSize ?? FONT_SIZE_MINIMUM;
    const result = best?.res ?? wrapText(fontSize);
    return {
      fontSize,
      lines: result.lines,
      overflow: result.lines.length * fontSize * LINE_HEIGHT_MULTIPLIER > maxHeight || result.failed,
      lineCenters: result.lineCenters
    };
  }

  // ../../packages/page-scene/src/ContentScene.ts
  var STROKE_WIDTH_RATIO = 0.18;
  function resolvedTextLayout(scene) {
    return scene.objects.filter((object) => object.lineBoxes.length > 0).map((object) => ({
      object_id: object.objectId,
      font_size: object.fontSize,
      lines: object.lineBoxes.map((line) => line.text)
    }));
  }
  function fontSpec(style, fontSize) {
    return `${style.weight} ${fontSize}px "${style.fontFamily}", sans-serif`;
  }
  function unrotatedBounds(transform) {
    const radians = transform.rotationDegrees * Math.PI / 180;
    const cosine = Math.abs(Math.cos(radians));
    const sine = Math.abs(Math.sin(radians));
    const width = transform.width * cosine + transform.height * sine;
    const height = transform.width * sine + transform.height * cosine;
    return {
      x: transform.x + (transform.width - width) / 2,
      y: transform.y + (transform.height - height) / 2,
      width,
      height
    };
  }
  function resolvePageScene(input, measureText) {
    const diagnostics = [];
    const objects = [];
    for (const object of [...input.textObjects].sort((left, right) => left.zIndex - right.zIndex)) {
      if (!object.visible) continue;
      if (!object.text) {
        diagnostics.push({ code: "empty-manual-text", objectId: object.objectId });
        objects.push({ objectId: object.objectId, fontSize: 0, lineBoxes: [] });
        continue;
      }
      const bounds = unrotatedBounds(object.transform);
      if (bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > input.source.width || bounds.y + bounds.height > input.source.height) {
        diagnostics.push({ code: "object-clips-page", objectId: object.objectId });
      }
      const fitBox = textFitBox(object.transform, {
        paddingPx: object.style.padding,
        safetyPercent: 100
      });
      const fit = fitTextInBox(
        {
          text: object.text,
          maxWidth: fitBox.width,
          maxHeight: fitBox.height,
          fontFamily: object.style.fontFamily,
          shape: "rectangular",
          boxX: fitBox.x,
          boxY: fitBox.y,
          fontWeight: String(object.style.weight)
        },
        measureText
      );
      if (fit.overflow) {
        diagnostics.push({ code: "text-overflow", objectId: object.objectId });
      }
      const lineHeight = fit.fontSize * 1.2;
      const startY = object.transform.y + object.transform.height / 2 - (fit.lines.length - 1) * lineHeight / 2;
      const lineBoxes = fit.lines.map((line, index) => {
        const width = measureText(fontSpec(object.style, fit.fontSize), line);
        const center = clampLineCenter(
          fit.lineCenters?.at(index) ?? fitBox.x + fitBox.width / 2,
          width,
          fitBox.x,
          fitBox.width
        );
        const x = object.alignment === "start" ? fitBox.x : object.alignment === "end" ? fitBox.x + fitBox.width - width : center - width / 2;
        return { x, y: startY + index * lineHeight - lineHeight / 2, width, height: lineHeight, text: line };
      });
      objects.push({ objectId: object.objectId, fontSize: fit.fontSize, lineBoxes });
    }
    return { input, objects, diagnostics };
  }
  function escapeXml(value) {
    return value.replace(
      /[&<>"']/g,
      (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;"
      })[character]
    );
  }
  function renderPageSceneSvg(scene) {
    const { source } = scene.input;
    const resolvedById = new Map(
      scene.objects.map((object) => [object.objectId, object])
    );
    const cleanupMarkup = [...scene.input.cleanupAssets].filter((asset) => asset.visible).sort((left, right) => left.zIndex - right.zIndex).map(
      (asset) => `<image data-cleanup-id="${escapeXml(asset.cleanupId)}" href="${escapeXml(asset.href)}" x="${asset.x}" y="${asset.y}" width="${asset.width}" height="${asset.height}"/>`
    ).join("");
    const glyphMarkup = [...scene.input.textObjects].filter((object) => object.visible).sort((left, right) => left.zIndex - right.zIndex).map((object) => {
      const resolved = resolvedById.get(object.objectId);
      if (!resolved || resolved.lineBoxes.length === 0) return "";
      const centerX = object.transform.x + object.transform.width / 2;
      const centerY = object.transform.y + object.transform.height / 2;
      const common = `font-family="${escapeXml(object.style.fontFamily)}" font-size="${resolved.fontSize}" font-weight="${object.style.weight}" text-anchor="start" style="writing-mode:${object.writingMode}"`;
      const lineText = (line, paint) => `<text x="${line.x}" y="${line.y + line.height * 0.8}" ${paint} ${common}>${escapeXml(line.text)}</text>`;
      const strokePass = object.style.stroke ? resolved.lineBoxes.map(
        (line) => lineText(
          line,
          `fill="none" stroke="${escapeXml(object.style.stroke)}" stroke-width="${Math.max(1, resolved.fontSize * STROKE_WIDTH_RATIO)}" stroke-linejoin="round" stroke-linecap="round"`
        )
      ).join("") : "";
      const fillPass = resolved.lineBoxes.map((line) => lineText(line, `fill="${escapeXml(object.style.fill)}" stroke="none"`)).join("");
      return `<g data-text-object-id="${escapeXml(object.objectId)}" transform="rotate(${object.transform.rotationDegrees} ${centerX} ${centerY})"><g data-text-pass="stroke">${strokePass}</g><g data-text-pass="fill">${fillPass}</g></g>`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${source.width}" height="${source.height}" viewBox="0 0 ${source.width} ${source.height}" data-scene-content="page-scene-v1"><image data-scene-layer="source" href="${escapeXml(source.href)}" x="0" y="0" width="${source.width}" height="${source.height}"/><g data-scene-layer="cleanup">${cleanupMarkup}</g><g data-scene-layer="glyphs">${glyphMarkup}</g></svg>`;
  }

  // src/static-entry.ts
  function mountPageScene(input) {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("browser canvas text measurement is unavailable");
    const scene = resolvePageScene(input, (font, text) => {
      context.font = font;
      return context.measureText(text).width;
    });
    document.body.innerHTML = renderPageSceneSvg(scene);
    return {
      diagnostics: scene.diagnostics,
      layout: resolvedTextLayout(scene),
      width: input.source.width,
      height: input.source.height
    };
  }
  return __toCommonJS(static_entry_exports);
})();
//# sourceMappingURL=scene-static.js.map
