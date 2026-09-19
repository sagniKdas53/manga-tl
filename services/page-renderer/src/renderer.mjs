import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const STATIC_ENTRY_PATH = fileURLToPath(
  new URL("../dist/scene-static.js", import.meta.url),
);
const SHA256 = /^[a-f0-9]{64}$/;
const DATA_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export class RendererError extends Error {}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new RendererError(`${label} is required`);
  }
  return value;
}

function requireFinitePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RendererError(`${label} must be a finite positive number`);
  }
  return value;
}

function assertTrustedImage(asset, label) {
  if (!asset || !DATA_IMAGE.test(asset.href || "")) {
    throw new RendererError(`${label} must be an embedded PNG, JPEG, or WebP asset`);
  }
  requireFinitePositive(asset.width, `${label}.width`);
  requireFinitePositive(asset.height, `${label}.height`);
}

function pngDimensions(png) {
  if (
    png.length < 24 ||
    png.subarray(0, 8).compare(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) !== 0
  ) {
    throw new RendererError("browser did not return a PNG");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function cssFontFace(font) {
  return `@font-face{font-family:${JSON.stringify(font.family)};font-weight:100 1000;font-style:normal;src:url(data:${font.mimeType};base64,${font.base64}) format('${font.format}');font-display:block;}`;
}

/**
 * A bounded, static Chromium renderer. It never navigates to scene-provided URLs or accepts
 * caller-provided HTML; all page markup comes from the bundled page-scene entry.
 */
export class PageRenderer {
  constructor({ fonts, maxContexts = 1, playwrightVersion = "1.62.1" }) {
    if (!Number.isInteger(maxContexts) || maxContexts < 1) {
      throw new RendererError("maxContexts must be a positive integer");
    }
    this.fontConfigs = fonts;
    this.maxContexts = maxContexts;
    this.playwrightVersion = playwrightVersion;
    this.fonts = new Map();
    this.contexts = [];
    this.inUse = new Set();
    this.browser = undefined;
  }

  async start() {
    if (this.browser) return;
    if (requireString(this.playwrightVersion, "playwrightVersion") !== "1.62.1") {
      throw new RendererError("renderer requires Playwright 1.62.1");
    }
    for (const config of this.fontConfigs) {
      const fontId = requireString(config.fontId, "fontId");
      const family = requireString(config.family, `font ${fontId}.family`);
      const expectedSha256 = requireString(config.sha256, `font ${fontId}.sha256`);
      if (!SHA256.test(expectedSha256)) {
        throw new RendererError(`font ${fontId} has an invalid SHA-256`);
      }
      const bytes = await readFile(requireString(config.path, `font ${fontId}.path`));
      const actualSha256 = sha256(bytes);
      if (actualSha256 !== expectedSha256) {
        throw new RendererError(`font ${fontId} SHA-256 mismatch`);
      }
      this.fonts.set(fontId, {
        fontId,
        family,
        sha256: actualSha256,
        mimeType: config.mimeType || "font/ttf",
        format: config.format || "truetype",
        base64: bytes.toString("base64"),
      });
    }
    this.browser = await chromium.launch({ headless: true });
  }

  async stop() {
    await Promise.all(this.contexts.map((context) => context.close()));
    this.contexts = [];
    this.inUse.clear();
    await this.browser?.close();
    this.browser = undefined;
  }

  validate(request) {
    if (!request || request.contractVersion !== "page-scene/v1") {
      throw new RendererError("renderer accepts only page-scene/v1 inputs");
    }
    if (!Number.isInteger(request.pageRevision) || request.pageRevision < 0) {
      throw new RendererError("pageRevision must be a non-negative integer");
    }
    for (const field of ["logicalSceneSha256", "renderInputSha256"]) {
      if (!SHA256.test(requireString(request[field], field))) {
        throw new RendererError(`${field} must be a SHA-256`);
      }
    }
    const scene = request.scene;
    if (!scene || !Array.isArray(scene.cleanupAssets) || !Array.isArray(scene.textObjects)) {
      throw new RendererError("scene must contain source, cleanupAssets, and textObjects");
    }
    assertTrustedImage(scene.source, "source");
    for (const asset of scene.cleanupAssets) assertTrustedImage(asset, "cleanup asset");
    const requestedFonts = new Set(request.requiredFontIds || []);
    const requestedFamilies = new Set();
    for (const fontId of requestedFonts) {
      const font = this.fonts.get(fontId);
      if (!font) throw new RendererError(`missing required font ${fontId}`);
      requestedFamilies.add(font.family);
    }
    for (const object of scene.textObjects) {
      if (!object || typeof object !== "object") throw new RendererError("invalid text object");
      if (!object.style || typeof object.style.fontFamily !== "string") {
        throw new RendererError("text object has no font family");
      }
      requireFinitePositive(object.transform?.width, "text object width");
      requireFinitePositive(object.transform?.height, "text object height");
      if (!Number.isFinite(object.transform?.rotationDegrees)) {
        throw new RendererError("text object rotation must be finite");
      }
      const configuredFamily = requestedFonts.has(object.style.fontFamily)
        ? this.fonts.get(object.style.fontFamily).family
        : object.style.fontFamily;
      if (object.visible && object.text && !requestedFamilies.has(configuredFamily)) {
        throw new RendererError(`missing required font for ${object.style.fontFamily}`);
      }
    }
    for (const fontId of requestedFonts) {
      const font = this.fonts.get(fontId);
      if (!scene.textObjects.some((object) => object.style.fontFamily === fontId || object.style.fontFamily === font.family)) {
        throw new RendererError(`required font ${fontId} is not used by the scene`);
      }
    }
    return {
      scene: {
        ...scene,
        textObjects: scene.textObjects.map((object) => ({
          ...object,
          style: {
            ...object.style,
            fontFamily: requestedFonts.has(object.style.fontFamily)
              ? this.fonts.get(object.style.fontFamily).family
              : object.style.fontFamily,
          },
        })),
      },
      requestedFonts,
    };
  }

  async acquireContext() {
    const reusable = this.contexts.find((context) => !this.inUse.has(context));
    if (reusable) {
      this.inUse.add(reusable);
      return reusable;
    }
    if (this.contexts.length >= this.maxContexts) {
      throw new RendererError("renderer context capacity is exhausted");
    }
    const context = await this.browser.newContext({
      deviceScaleFactor: 1,
      viewport: { width: 1280, height: 720 },
      colorScheme: "light",
    });
    this.contexts.push(context);
    this.inUse.add(context);
    return context;
  }

  async render(request) {
    if (!this.browser) throw new RendererError("renderer is not started");
    const { scene, requestedFonts } = this.validate(request);
    const context = await this.acquireContext();
    const page = await context.newPage();
    try {
      const fonts = [...requestedFonts].map((fontId) => this.fonts.get(fontId));
      await page.setContent(
        `<!doctype html><html><head><style>${fonts.map(cssFontFace).join("\n")}html,body{margin:0;padding:0;background:white}svg{display:block}</style></head><body></body></html>`,
      );
      await page.evaluate(async (textObjects) => {
        await Promise.all(
          textObjects
            .filter((object) => object.visible && object.text)
            .map((object) =>
              document.fonts.load(
                `${object.style.weight} 16px "${object.style.fontFamily}"`,
                object.text,
              ),
            ),
        );
        await document.fonts.ready;
      }, scene.textObjects);
      await page.addScriptTag({ path: STATIC_ENTRY_PATH });
      const diagnostics = await page.evaluate((input) => {
        return globalThis.PageSceneStatic.mountPageScene(input);
      }, scene);
      await page.evaluate(async () => {
        const images = [...document.images];
        await Promise.all(
          images.map((image) =>
            image.complete
              ? Promise.resolve()
              : new Promise((resolve, reject) => {
                  image.addEventListener("load", resolve, { once: true });
                  image.addEventListener("error", () => reject(new Error("required image failed to load")), { once: true });
                }),
          ),
        );
        await document.fonts.ready;
      });
      const png = await page.locator("svg").screenshot({ type: "png", animations: "disabled" });
      const dimensions = pngDimensions(png);
      if (dimensions.width !== scene.source.width || dimensions.height !== scene.source.height) {
        throw new RendererError("browser PNG dimensions differ from source dimensions");
      }
      return {
        png,
        pngSha256: sha256(png),
        width: dimensions.width,
        height: dimensions.height,
        pageRevision: request.pageRevision,
        logicalSceneSha256: request.logicalSceneSha256,
        renderInputSha256: request.renderInputSha256,
        browserBuild: await this.browser.version(),
        playwrightVersion: this.playwrightVersion,
        fontSha256s: fonts.map((font) => font.sha256),
        diagnostics: diagnostics.diagnostics,
        layout: diagnostics.layout ?? [],
      };
    } finally {
      await page.close();
      this.inUse.delete(context);
    }
  }
}
