import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PageRenderer, RendererBusyError, RendererError } from "../src/renderer.mjs";

const FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+VaDXcQAAAABJRU5ErkJggg==";
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function renderer() {
  const fontBytes = await readFile(FONT_PATH);
  const instance = new PageRenderer({
    fonts: [
      {
        fontId: "dejavu-sans",
        family: "DejaVu Sans",
        path: FONT_PATH,
        sha256: digest(fontBytes),
      },
    ],
    maxContexts: 1,
  });
  await instance.start();
  return instance;
}

function request(overrides = {}) {
  return {
    contractVersion: "page-scene/v1",
    pageRevision: 7,
    logicalSceneSha256: "a".repeat(64),
    renderInputSha256: "b".repeat(64),
    requiredFontIds: ["dejavu-sans"],
    scene: {
      source: { href: IMAGE, width: 160, height: 90 },
      cleanupAssets: [
        {
          cleanupId: "cleanup-1",
          href: IMAGE,
          x: 20,
          y: 20,
          width: 80,
          height: 30,
          zIndex: 1,
          visible: true,
        },
      ],
      textObjects: [
        {
          objectId: "dialogue-1",
          text: "Pinned browser text",
          transform: { x: 20, y: 20, width: 80, height: 30, rotationDegrees: 12.5 },
          writingMode: "horizontal-tb",
          alignment: "center",
          style: { fontFamily: "DejaVu Sans", fill: "#000000", stroke: "#ffffff", weight: 700, padding: 2 },
          visible: true,
          zIndex: 2,
        },
        {
          objectId: "manual-blank",
          text: "",
          transform: { x: 120, y: 20, width: 20, height: 20, rotationDegrees: 0 },
          writingMode: "horizontal-tb",
          alignment: "start",
          style: { fontFamily: "DejaVu Sans", fill: "#000000", stroke: "", weight: 400, padding: 0 },
          visible: true,
          zIndex: 3,
        },
      ],
    },
    ...overrides,
  };
}

test("renders source-sized deterministic PNGs with browser and font provenance", async () => {
  const instance = await renderer();
  try {
    const first = await instance.render(request());
    const second = await instance.render(request());
    assert.equal(first.width, 160);
    assert.equal(first.height, 90);
    assert.equal(first.pngSha256, second.pngSha256);
    assert.equal(first.playwrightVersion, "1.62.1");
    assert.equal(first.fontSha256s.length, 1);
    assert.deepEqual(first.diagnostics, [
      { code: "empty-manual-text", objectId: "manual-blank" },
    ]);
    // Tracker R2 (c): the resolved font px and line breaks come back per text object.
    assert.equal(first.layout.length, 1);
    assert.equal(first.layout[0].object_id, "dialogue-1");
    assert.ok(first.layout[0].font_size > 0);
    assert.equal(first.layout[0].lines.join(" "), "Pinned browser text");
  } finally {
    await instance.stop();
  }
});

test("rejects missing fonts and untrusted image URLs before rendering", async () => {
  const instance = await renderer();
  try {
    await assert.rejects(
      instance.render(request({ requiredFontIds: ["missing-font"] })),
      (error) => error instanceof RendererError && error.message === "missing required font missing-font",
    );
    const invalid = request();
    invalid.scene.cleanupAssets[0].href = "https://untrusted.example/patch.png";
    await assert.rejects(
      instance.render(invalid),
      (error) => error instanceof RendererError && /embedded PNG/.test(error.message),
    );
  } finally {
    await instance.stop();
  }
});

test("resolves a scene font ID to its registered browser family", async () => {
  const instance = await renderer();
  try {
    const input = request();
    for (const object of input.scene.textObjects) object.style.fontFamily = "dejavu-sans";
    const result = await instance.render(input);
    assert.equal(result.width, 160);
    assert.equal(result.height, 90);
  } finally {
    await instance.stop();
  }
});

test("a second concurrent render is told the renderer is busy, not that its scene is bad", async () => {
  const instance = await renderer();
  try {
    const first = instance.render(request());
    await assert.rejects(
      instance.render(request()),
      (error) => error instanceof RendererBusyError && !(error instanceof RendererError),
    );
    await first;
    // Once the context is free the same scene renders.
    const again = await instance.render(request());
    assert.equal(again.width, 160);
  } finally {
    await instance.stop();
  }
});
