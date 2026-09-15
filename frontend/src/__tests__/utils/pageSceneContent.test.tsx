import { describe, expect, it } from "vitest";
import {
  renderPageSceneSvg,
  resolvePageScene,
  type PageSceneContentInput,
} from "@manga-library/page-scene";

const measureText = (font: string, text: string) => {
  const fontSize = Number(/(\d+)px/.exec(font)?.[1] ?? 16);
  return text.length * fontSize * 0.5;
};

function sceneInput(): PageSceneContentInput {
  return {
    source: { href: "source.png", width: 100, height: 100 },
    cleanupAssets: [
      {
        cleanupId: "cleanup-dialogue",
        href: "cleanup.png",
        x: 10,
        y: 10,
        width: 40,
        height: 20,
        zIndex: 1,
        visible: true,
      },
    ],
    textObjects: [
      {
        objectId: "rotated-dialogue",
        text: "Hello world",
        transform: { x: 10, y: 10, width: 40, height: 20, rotationDegrees: 15 },
        writingMode: "horizontal-tb",
        alignment: "center",
        style: { fontFamily: "Test Font", fill: "#111111", stroke: "#ffffff", weight: 700, padding: 2 },
        visible: true,
        zIndex: 2,
      },
      {
        objectId: "visible-manual-blank",
        text: "",
        transform: { x: 70, y: 70, width: 10, height: 10, rotationDegrees: 0 },
        writingMode: "horizontal-tb",
        alignment: "start",
        style: { fontFamily: "Test Font", fill: "#000000", stroke: "", weight: 400, padding: 0 },
        visible: true,
        zIndex: 3,
      },
      {
        objectId: "off-page",
        text: "Overflow",
        transform: { x: 88, y: 88, width: 20, height: 20, rotationDegrees: 45 },
        writingMode: "horizontal-tb",
        alignment: "end",
        style: { fontFamily: "Test Font", fill: "#000000", stroke: "", weight: 400, padding: 0 },
        visible: true,
        zIndex: 4,
      },
    ],
  };
}

describe("page-scene content", () => {
  it("resolves source-space lines and reports blank and clipping diagnostics", () => {
    const scene = resolvePageScene(sceneInput(), measureText);

    expect(scene.objects.find((object) => object.objectId === "rotated-dialogue")?.lineBoxes).not.toHaveLength(0);
    expect(scene.objects.find((object) => object.objectId === "visible-manual-blank")?.lineBoxes).toEqual([]);
    expect(scene.diagnostics).toEqual(
      expect.arrayContaining([
        { code: "empty-manual-text", objectId: "visible-manual-blank" },
        { code: "object-clips-page", objectId: "off-page" },
      ]),
    );
  });

  it("renders cleanup before styled glyphs without editor or OCR overlays", () => {
    const scene = resolvePageScene(sceneInput(), measureText);
    const document = new DOMParser().parseFromString(
      renderPageSceneSvg(scene),
      "image/svg+xml",
    );
    const cleanup = document.querySelector('[data-scene-layer="cleanup"]');
    const glyphs = document.querySelector('[data-scene-layer="glyphs"]');
    const text = document.querySelector(
      '[data-text-object-id="rotated-dialogue"] text',
    );

    expect(cleanup?.compareDocumentPosition(glyphs!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      document
        .querySelector('[data-cleanup-id="cleanup-dialogue"]')
        ?.getAttribute("href"),
    ).toBe("cleanup.png");
    expect(text?.getAttribute("stroke")).toBe("#ffffff");
    expect(
      document
        .querySelector('[data-text-object-id="rotated-dialogue"]')
        ?.getAttribute("transform"),
    ).toBe("rotate(15 30 20)");
    expect(document.querySelector('[data-scene-layer="ocr"]')).toBeNull();
    expect(document.querySelector("[data-editor-handle]")).toBeNull();
  });
});
