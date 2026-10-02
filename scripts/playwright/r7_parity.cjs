#!/usr/bin/env node
/**
 * Tracker R7 gate: the editor's content view and the export agree.
 *
 * For each page it
 *   1. opens the Reader and reads, from the live canvas, the cleanup patches it draws
 *      (`.svg-overlay [data-scene-layer="cleanup"] image`: bytes, rect, order, opacity);
 *   2. rasterises them over the page's ORIGINAL (from /file, not the lossy /reader variant) with
 *      the page-renderer's own bundle (`services/page-renderer/dist/scene-static.js`,
 *      `mountPageScene`) in the renderer's own browser setup — no UI, no handles, no OCR boxes;
 *   3. downloads the page's current export artifact (`/api/pages/{id}/rendered`);
 *   4. writes both PNGs for `r7_compare.py`, which compares decoded RGBA.
 *
 * Text is compared separately: English fitting parity is M7, not R7. Run it with every text layer
 * hidden (`--hide-text`) for the digest comparison; the script restores the layers afterwards.
 * Hiding a layer re-renders the page; to keep that re-render from queueing a paid QA pass, the
 * page is first marked hand-edited by a no-op save of one Inpainting element (`--mark-edited`).
 *
 *   node scripts/playwright/r7_parity.cjs --base http://127.0.0.1:18080/tlhub \
 *     --out docs/quality-runs/r7-.../parity --page sample177=<pageId> [--hide-text] [--mark-edited]
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STATIC_ENTRY = path.join(
  __dirname,
  "../../services/page-renderer/dist/scene-static.js",
);
const RENDER_TIMEOUT_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const args = {
    base: "http://127.0.0.1:18080/tlhub",
    out: "",
    email: process.env.TLHUB_EMAIL || "",
    password: process.env.TLHUB_PASSWORD || "",
    pages: [],
    hideText: false,
    markEdited: false,
    tag: "content",
  };
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--base":
        args.base = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--page": {
        const [name, id] = next().split("=");
        args.pages.push({ name, id });
        break;
      }
      case "--hide-text":
        args.hideText = true;
        break;
      case "--mark-edited":
        args.markEdited = true;
        break;
      case "--tag":
        args.tag = next();
        break;
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (!args.out || !args.pages.length || !args.email || !args.password) {
    throw new Error(
      "need --out, at least one --page name=id, and TLHUB_EMAIL/TLHUB_PASSWORD",
    );
  }
  return args;
}

const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

async function api(request, base, token, method, url, data) {
  const response = await request.fetch(`${base}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    data: data ? JSON.stringify(data) : undefined,
  });
  return response;
}

/** For write routes that answer with an empty body. */
async function ok(request, base, token, method, url, data) {
  const response = await api(request, base, token, method, url, data);
  if (!response.ok())
    throw new Error(
      `${method} ${url}: HTTP ${response.status()} ${await response.text()}`,
    );
}

async function json(request, base, token, method, url, data) {
  const response = await api(request, base, token, method, url, data);
  if (!response.ok())
    throw new Error(
      `${method} ${url}: HTTP ${response.status()} ${await response.text()}`,
    );
  return response.json();
}

/** Waits for the render artifact of the page's current revision and returns it. */
async function currentRender(request, base, token, pageId, notBefore) {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await api(
      request,
      base,
      token,
      "GET",
      `/api/pages/${pageId}/rendered`,
    );
    if (response.ok()) {
      const bytes = await response.body();
      if (!notBefore || sha256(bytes) !== notBefore) return bytes;
    } else if (
      response.status() === 409 &&
      (await response.json()).status === "failed"
    ) {
      throw new Error(`render failed for page ${pageId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(
    `no current render for page ${pageId} within ${RENDER_TIMEOUT_MS / 60000} min`,
  );
}

async function waitForNewRevisionRender(
  request,
  base,
  token,
  pageId,
  revisionBefore,
) {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pages = await json(
      request,
      base,
      token,
      "GET",
      `/api/pages/${pageId}`,
    );
    const response = await api(
      request,
      base,
      token,
      "GET",
      `/api/pages/${pageId}/rendered`,
    );
    if (response.ok() && pages) {
      const scene = await api(
        request,
        base,
        token,
        "GET",
        `/api/pages/${pageId}/scene`,
      );
      const revision = scene.ok() ? (await scene.json()).page.revision : -1;
      if (revision > revisionBefore) return response.body();
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(
    `page ${pageId} did not re-render past revision ${revisionBefore}`,
  );
}

async function sceneRevision(request, base, token, pageId) {
  const scene = await api(
    request,
    base,
    token,
    "GET",
    `/api/pages/${pageId}/scene`,
  );
  return scene.ok() ? (await scene.json()).page.revision : -1;
}

async function login(page, base, email, password) {
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email Address").fill(email);
  await page.getByLabel("Password").fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith("/login"), {
      timeout: 30_000,
    }),
    page.getByRole("button", { name: "Sign In" }).click(),
  ]);
}

/** What the editor canvas paints for cleanup, read off its DOM, with every patch inlined. */
async function editorPatches(page, expected) {
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll(
        '.svg-overlay [data-scene-layer="cleanup"] image',
      ).length === count,
    expected,
    { timeout: 60_000 },
  );
  return page.evaluate(async () => {
    const toDataUrl = async (href) => {
      const blob = await (await fetch(href)).blob();
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    };
    const overlay = document.querySelector(".svg-overlay");
    const [, , width, height] = overlay
      .getAttribute("viewBox")
      .split(" ")
      .map(Number);
    const images = [
      ...overlay.querySelectorAll('[data-scene-layer="cleanup"] image'),
    ];
    const patches = [];
    for (const [index, image] of images.entries()) {
      patches.push({
        cleanupId: image.getAttribute("data-cleanup-id"),
        href: await toDataUrl(image.getAttribute("href")),
        x: Number(image.getAttribute("x")),
        y: Number(image.getAttribute("y")),
        width: Number(image.getAttribute("width")),
        height: Number(image.getAttribute("height")),
        opacity: image.hasAttribute("opacity")
          ? Number(image.getAttribute("opacity"))
          : undefined,
        preserveAspectRatio: image.getAttribute("preserveAspectRatio"),
        zIndex: index,
        visible: true,
      });
    }
    return { width, height, patches };
  });
}

/** The editor's content, rasterised the way page-renderer rasterises an export. */
async function rasteriseEditorContent(browser, source, patches) {
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    viewport: { width: 1280, height: 720 },
    colorScheme: "light",
  });
  const page = await context.newPage();
  try {
    await page.setContent(
      "<!doctype html><html><head><style>html,body{margin:0;padding:0;background:white}svg{display:block}</style></head><body></body></html>",
    );
    await page.addScriptTag({ path: STATIC_ENTRY });
    await page.evaluate(
      (input) => globalThis.PageSceneStatic.mountPageScene(input),
      { source, cleanupAssets: patches, textObjects: [] },
    );
    await page.evaluate(async () => {
      await Promise.all(
        [...document.images].map((image) =>
          image.complete
            ? null
            : new Promise((resolve) =>
                image.addEventListener("load", resolve, { once: true }),
              ),
        ),
      );
    });
    return await page
      .locator("svg")
      .screenshot({ type: "png", animations: "disabled" });
  } finally {
    await context.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const { chromium } = require("playwright");
  fs.mkdirSync(args.out, { recursive: true });
  const browser = await chromium.launch();
  const ui = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  });
  const page = await ui.newPage();
  const loginResponse = await page.request.post(`${args.base}/api/auth/login`, {
    data: { email: args.email, password: args.password },
  });
  const token = (await loginResponse.json()).token;
  await login(page, args.base, args.email, args.password);
  const results = [];

  for (const { name, id } of args.pages) {
    const details = await json(
      page.request,
      args.base,
      token,
      "GET",
      `/api/pages/${id}`,
    );
    const { chapterId, pageNumber, imageId } = details.page;
    const textLayers = details.layers.filter(
      (l) =>
        ["translation", "sfx"].includes(l.layer.type) &&
        l.layer.visible === true,
    );
    const patchElement = details.layers
      .filter((l) => l.layer.type === "inpainting")
      .flatMap((l) => l.elements)[0];

    let revisionBefore = await sceneRevision(
      page.request,
      args.base,
      token,
      id,
    );
    if (args.markEdited && patchElement) {
      // A no-op save: the same opacity. It stamps is_manually_edited, which makes the render
      // callback skip QA for this page (coordinator.rs, "manual edits exist").
      await json(
        page.request,
        args.base,
        token,
        "PUT",
        `/api/layer-elements/${patchElement.id}`,
        {
          opacity: patchElement.opacity ?? 1,
        },
      );
    }
    if (args.hideText) {
      for (const layer of textLayers) {
        await ok(
          page.request,
          args.base,
          token,
          "PUT",
          `/api/layers/${layer.layer.id}`,
          { visible: false },
        );
      }
    }
    try {
      const exported =
        args.markEdited || args.hideText
          ? Buffer.from(
              await waitForNewRevisionRender(
                page.request,
                args.base,
                token,
                id,
                revisionBefore,
              ),
            )
          : await currentRender(page.request, args.base, token, id);
      const scene = await json(
        page.request,
        args.base,
        token,
        "GET",
        `/api/pages/${id}/scene`,
      );

      const originalResponse = await api(
        page.request,
        args.base,
        token,
        "GET",
        `/api/images/${imageId}/file`,
      );
      const originalBytes = await originalResponse.body();
      const mime = originalResponse.headers()["content-type"] || "image/png";

      await page.goto(
        `${args.base}/chapters/${chapterId}/reader/${pageNumber}`,
        { waitUntil: "domcontentloaded" },
      );
      const expected = scene.cleanup_artifacts.filter(
        (c) => c.generator_sha256 !== LEGACY_GENERATOR,
      ).length;
      const editor = await editorPatches(page, expected);
      await page.screenshot({
        path: path.join(args.out, `${name}-${args.tag}-editor-viewport.png`),
      });
      const editorPng = await rasteriseEditorContent(
        browser,
        {
          href: `data:${mime};base64,${originalBytes.toString("base64")}`,
          width: editor.width,
          height: editor.height,
        },
        editor.patches,
      );

      fs.writeFileSync(
        path.join(args.out, `${name}-${args.tag}-editor.png`),
        editorPng,
      );
      fs.writeFileSync(
        path.join(args.out, `${name}-${args.tag}-export.png`),
        exported,
      );
      results.push({
        name,
        page_id: id,
        tag: args.tag,
        text_hidden: args.hideText,
        source: {
          width: editor.width,
          height: editor.height,
          sha256: sha256(originalBytes),
        },
        scene_revision: scene.page.revision,
        logical_scene_cleanups: scene.cleanup_artifacts.length,
        editor_patches: editor.patches.length,
        editor_png_sha256: sha256(editorPng),
        export_png_sha256: sha256(exported),
        editor_cleanup_order: editor.patches.map((p) => p.cleanupId),
        export_cleanup_order: scene.cleanup_artifacts.map((c) => c.cleanup_id),
      });

      console.log(
        `${name}: editor ${editor.patches.length} patches, export revision ${scene.page.revision}`,
      );
    } finally {
      // Always put the page back: a failed capture must not leave its text hidden.
      if (args.hideText) {
        for (const layer of textLayers) {
          await ok(
            page.request,
            args.base,
            token,
            "PUT",
            `/api/layers/${layer.layer.id}`,
            { visible: true },
          );
        }
      }
    }
  }
  fs.writeFileSync(
    path.join(args.out, `parity-${args.tag}.json`),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}

// The pre-R7 flat plate's generator: a plate is drawn by the text element, not the cleanup group.
const LEGACY_GENERATOR = crypto
  .createHash("sha256")
  .update("legacy-mask-polygon-fill/v1")
  .digest("hex");

module.exports = {
  api,
  ok,
  json,
  sha256,
  login,
  editorPatches,
  rasteriseEditorContent,
  sceneRevision,
  waitForNewRevisionRender,
  LEGACY_GENERATOR,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
