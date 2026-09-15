import {
  clampLineCenter,
  fitTextInBox,
  textFitBox,
  type FitBox,
  type TextMeasurer,
} from "./layout.js";

export interface SceneAsset {
  href: string;
  width: number;
  height: number;
}

export interface SceneTransform extends FitBox {
  rotationDegrees: number;
}

export interface SceneTextStyle {
  fontFamily: string;
  fill: string;
  stroke: string;
  weight: number;
  padding: number;
}

export interface SceneTextObject {
  objectId: string;
  text: string;
  transform: SceneTransform;
  writingMode: "horizontal-tb" | "vertical-rl" | "vertical-lr";
  alignment: "start" | "center" | "end" | "justify";
  style: SceneTextStyle;
  visible: boolean;
  zIndex: number;
}

export interface SceneCleanupAsset extends SceneAsset {
  cleanupId: string;
  x: number;
  y: number;
  zIndex: number;
  visible: boolean;
}

export interface PageSceneContentInput {
  source: SceneAsset;
  cleanupAssets: SceneCleanupAsset[];
  textObjects: SceneTextObject[];
}

export interface ResolvedLineBox extends FitBox {
  text: string;
}

export interface ResolvedTextObject {
  objectId: string;
  fontSize: number;
  lineBoxes: ResolvedLineBox[];
}

export interface SceneLayoutDiagnostic {
  code: "empty-manual-text" | "object-clips-page" | "text-overflow";
  objectId: string;
}

export interface ResolvedPageScene {
  input: PageSceneContentInput;
  objects: ResolvedTextObject[];
  diagnostics: SceneLayoutDiagnostic[];
}

function fontSpec(style: SceneTextStyle, fontSize: number) {
  return `${style.weight} ${fontSize}px "${style.fontFamily}", sans-serif`;
}

function unrotatedBounds(transform: SceneTransform): FitBox {
  const radians = (transform.rotationDegrees * Math.PI) / 180;
  const cosine = Math.abs(Math.cos(radians));
  const sine = Math.abs(Math.sin(radians));
  const width = transform.width * cosine + transform.height * sine;
  const height = transform.width * sine + transform.height * cosine;
  return {
    x: transform.x + (transform.width - width) / 2,
    y: transform.y + (transform.height - height) / 2,
    width,
    height,
  };
}

/**
 * Resolves line geometry from an immutable content input. It owns layout only: source pixels,
 * cleanup pixels, OCR evidence, and editor controls remain outside this pure scene boundary.
 */
export function resolvePageScene(
  input: PageSceneContentInput,
  measureText: TextMeasurer,
): ResolvedPageScene {
  const diagnostics: SceneLayoutDiagnostic[] = [];
  const objects: ResolvedTextObject[] = [];

  for (const object of [...input.textObjects].sort((left, right) => left.zIndex - right.zIndex)) {
    if (!object.visible) continue;
    if (!object.text) {
      diagnostics.push({ code: "empty-manual-text", objectId: object.objectId });
      objects.push({ objectId: object.objectId, fontSize: 0, lineBoxes: [] });
      continue;
    }

    const bounds = unrotatedBounds(object.transform);
    if (
      bounds.x < 0 ||
      bounds.y < 0 ||
      bounds.x + bounds.width > input.source.width ||
      bounds.y + bounds.height > input.source.height
    ) {
      diagnostics.push({ code: "object-clips-page", objectId: object.objectId });
    }

    const fitBox = textFitBox(object.transform, {
      paddingPx: object.style.padding,
      safetyPercent: 100,
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
        fontWeight: String(object.style.weight),
      },
      measureText,
    );
    if (fit.overflow) {
      diagnostics.push({ code: "text-overflow", objectId: object.objectId });
    }

    const lineHeight = fit.fontSize * 1.2;
    const startY =
      object.transform.y +
      object.transform.height / 2 -
      ((fit.lines.length - 1) * lineHeight) / 2;
    const lineBoxes = fit.lines.map((line, index) => {
      const width = measureText(fontSpec(object.style, fit.fontSize), line);
      const center = clampLineCenter(
        fit.lineCenters?.at(index) ?? fitBox.x + fitBox.width / 2,
        width,
        fitBox.x,
        fitBox.width,
      );
      const x =
        object.alignment === "start"
          ? fitBox.x
          : object.alignment === "end"
            ? fitBox.x + fitBox.width - width
            : center - width / 2;
      return { x, y: startY + index * lineHeight - lineHeight / 2, width, height: lineHeight, text: line };
    });
    objects.push({ objectId: object.objectId, fontSize: fit.fontSize, lineBoxes });
  }

  return { input, objects, diagnostics };
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
}

/**
 * Produces a trusted SVG content scene. It contains source pixels, active cleanup assets, and
 * resolved glyphs only; the static renderer installs this markup into an SVG document directly.
 */
export function renderPageSceneSvg(scene: ResolvedPageScene): string {
  const { source } = scene.input;
  const resolvedById = new Map(
    scene.objects.map((object) => [object.objectId, object]),
  );
  const cleanupMarkup = [...scene.input.cleanupAssets]
    .filter((asset) => asset.visible)
    .sort((left, right) => left.zIndex - right.zIndex)
    .map(
      (asset) =>
        `<image data-cleanup-id="${escapeXml(asset.cleanupId)}" href="${escapeXml(asset.href)}" x="${asset.x}" y="${asset.y}" width="${asset.width}" height="${asset.height}"/>`,
    )
    .join("");
  const glyphMarkup = [...scene.input.textObjects]
    .filter((object) => object.visible)
    .sort((left, right) => left.zIndex - right.zIndex)
    .map((object) => {
      const resolved = resolvedById.get(object.objectId);
      if (!resolved || resolved.lineBoxes.length === 0) return "";
      const centerX = object.transform.x + object.transform.width / 2;
      const centerY = object.transform.y + object.transform.height / 2;
      const stroke = object.style.stroke || "none";
      const strokeWidth = object.style.stroke
        ? Math.max(1, resolved.fontSize * 0.04)
        : 0;
      const lines = resolved.lineBoxes
        .map(
          (line) =>
            `<text x="${line.x}" y="${line.y + line.height * 0.8}" fill="${escapeXml(object.style.fill)}" stroke="${escapeXml(stroke)}" stroke-width="${strokeWidth}" paint-order="stroke fill" font-family="${escapeXml(object.style.fontFamily)}" font-size="${resolved.fontSize}" font-weight="${object.style.weight}" text-anchor="start" style="writing-mode:${object.writingMode}">${escapeXml(line.text)}</text>`,
        )
        .join("");
      return `<g data-text-object-id="${escapeXml(object.objectId)}" transform="rotate(${object.transform.rotationDegrees} ${centerX} ${centerY})">${lines}</g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${source.width}" height="${source.height}" viewBox="0 0 ${source.width} ${source.height}" data-scene-content="page-scene-v1"><image data-scene-layer="source" href="${escapeXml(source.href)}" x="0" y="0" width="${source.width}" height="${source.height}"/><g data-scene-layer="cleanup">${cleanupMarkup}</g><g data-scene-layer="glyphs">${glyphMarkup}</g></svg>`;
}
