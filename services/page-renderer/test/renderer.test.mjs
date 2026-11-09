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
    // #182: one box per line, in page px before the rotation, one line height (1.2 em) tall, inside
    // the object's transform horizontally.
    const { line_boxes: boxes, lines, font_size: px } = first.layout[0];
    assert.equal(boxes.length, lines.length);
    for (const [x, y, width, height] of boxes) {
      assert.ok(Math.abs(height - px * 1.2) <= 0.1, `line height ${height} for ${px} px`);
      assert.ok(width > 0 && x >= 20 && x + width <= 100.1, `line box ${x}+${width} inside 20..100`);
      assert.ok(Number.isFinite(y));
    }
    for (let i = 1; i < boxes.length; i += 1) assert.ok(boxes[i][1] > boxes[i - 1][1], "lines run downward");
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

const BOLD_FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

async function twoFaceFont() {
  const [regular, bold] = await Promise.all([readFile(FONT_PATH), readFile(BOLD_FONT_PATH)]);
  return {
    fontId: "dejavu-sans",
    family: "DejaVu Sans",
    faces: [
      { path: FONT_PATH, sha256: digest(regular), weight: "100 599" },
      { path: BOLD_FONT_PATH, sha256: digest(bold), weight: "600 1000" },
    ],
  };
}

function requestAtWeight(weight) {
  const input = request();
  input.scene.textObjects[0].style.weight = weight;
  return input;
}

test("a font with two faces draws each weight in its own face (#322)", async () => {
  const oneFace = await renderer();
  const twoFaces = new PageRenderer({ fonts: [await twoFaceFont()], maxContexts: 1 });
  try {
    await twoFaces.start();
    const regularFace400 = await oneFace.render(requestAtWeight(400));
    const regularFace700 = await oneFace.render(requestAtWeight(700));
    // One face answers for every weight: what the export did before #322.
    assert.equal(regularFace700.pngSha256, regularFace400.pngSha256);

    const drawn400 = await twoFaces.render(requestAtWeight(400));
    const drawn700 = await twoFaces.render(requestAtWeight(700));
    assert.equal(drawn400.pngSha256, regularFace400.pngSha256);
    assert.notEqual(drawn700.pngSha256, regularFace700.pngSha256);
    assert.equal(drawn700.fontSha256s.length, 2);
  } finally {
    await oneFace.stop();
    await twoFaces.stop();
  }
});

test("every face of a font must match its SHA-256 and declare a weight range", async () => {
  const wrongHash = await twoFaceFont();
  wrongHash.faces[1].sha256 = "0".repeat(64);
  await assert.rejects(
    new PageRenderer({ fonts: [wrongHash] }).start(),
    (error) => error instanceof RendererError && /SHA-256 mismatch/.test(error.message),
  );
  const noRange = await twoFaceFont();
  noRange.faces[1].weight = "bold; color:red";
  await assert.rejects(
    new PageRenderer({ fonts: [noRange] }).start(),
    (error) => error instanceof RendererError && /weight/.test(error.message),
  );
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

test("a context that cannot open a page is dropped, and the next render gets a fresh one", async () => {
  const instance = await renderer();
  try {
    await instance.render(request());
    const [broken] = instance.contexts;
    broken.newPage = async () => {
      throw new Error("Target page, context or browser has been closed");
    };
    await assert.rejects(instance.render(request()), /has been closed/);
    assert.equal(instance.inUse.size, 0, "the failed render released its slot");
    const again = await instance.render(request());
    assert.equal(again.width, 160);
    assert.ok(!instance.contexts.includes(broken), "the broken context left the pool");
  } finally {
    await instance.stop();
  }
});

test("a render whose page will not close still frees its slot, and drops the context", async () => {
  const instance = await renderer();
  try {
    await instance.render(request());
    const [dying] = instance.contexts;
    const openPage = dying.newPage.bind(dying);
    dying.newPage = async () => {
      const page = await openPage();
      page.setContent = async () => {
        throw new Error("Target page, context or browser has been closed");
      };
      page.close = async () => {
        throw new Error("Target page, context or browser has been closed");
      };
      return page;
    };
    await assert.rejects(instance.render(request()), /has been closed/);
    assert.equal(instance.inUse.size, 0, "the failed render released its slot");
    assert.ok(!instance.contexts.includes(dying), "the dead context left the pool");
    const again = await instance.render(request());
    assert.equal(again.width, 160);
  } finally {
    await instance.stop();
  }
});

test("contract rule 8: the browser draws the editor's fixed size, not an auto-fit one", async () => {
  // Page 30 (2026-10-02): the user set the line to 152 px with auto-size off; the export
  // auto-fitted it to 72 because the renderer never saw the size.
  const instance = await renderer();
  try {
    const base = request();
    const dialogue = (style) => ({
      ...base.scene.textObjects[0],
      transform: { x: 10, y: 5, width: 140, height: 80, rotationDegrees: 0 },
      text: "Hi",
      style: { ...base.scene.textObjects[0].style, ...style },
    });
    const sizeOf = async (style) => {
      const result = await instance.render({
        ...base,
        scene: { ...base.scene, textObjects: [dialogue(style)] },
      });
      return result.layout.find((object) => object.object_id === "dialogue-1").font_size;
    };
    assert.ok((await sizeOf({})) <= 40);
    assert.equal(await sizeOf({ fontSize: 30, fontStyle: "italic", shape: "elliptical" }), 30);
  } finally {
    await instance.stop();
  }
});
