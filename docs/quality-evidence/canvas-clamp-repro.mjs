#!/usr/bin/env node
/**
 * Executable source-level repro for browser/worker horizontal-placement drift.
 *
 * From the repository root:
 *   node docs/quality-evidence/canvas-clamp-repro.mjs
 *
 * Vite loads the real TypeScript helpers; no application server, backend,
 * browser image, or model call is involved. This measures geometry only, and
 * source assertions bind the calculation to both current export call sites.
 */
import { readFile } from "node:fs/promises";
import { createServer } from "../../frontend/node_modules/vite/dist/node/index.js";

const frontendRoot = new URL("../../frontend/", import.meta.url).pathname;
const readerUrl = new URL("../../frontend/src/components/Reader.tsx", import.meta.url);
const fitTextUrl = new URL("../../frontend/src/utils/fitText.ts", import.meta.url).pathname;
const fitBoxUrl = new URL("../../frontend/src/utils/textFitBox.ts", import.meta.url).pathname;
const server = await createServer({ root: frontendRoot, logLevel: "error", server: { middlewareMode: true, hmr: false } });

try {
  const { clampLineCenter } = await server.ssrLoadModule(fitTextUrl);
  const { textFitBox } = await server.ssrLoadModule(fitBoxUrl);
  const raw = { x: 100, y: 200, width: 300, height: 120 };
  const fitted = textFitBox(raw);
  const width = 100;
  const polygonLineCenter = fitted.x + fitted.width;
  const browserCenter = clampLineCenter(polygonLineCenter, width, raw.x, raw.width);
  const workerCenter = clampLineCenter(polygonLineCenter, width, fitted.x, fitted.width);
  const reader = await readFile(readerUrl, "utf8");
  const pngRawClamp = /ctx\.measureText\(line\)\.width,\s*el\.x,\s*width,/.test(reader);
  const zipRawClamp = /textCtx\.measureText\(line\)\.width,\s*el\.x,\s*width,/.test(reader);

  if (!pngRawClamp || !zipRawClamp || workerCenter - browserCenter !== -19) {
    throw new Error("Current clamp contract did not match the documented repro");
  }
  console.log(JSON.stringify({ raw, fitted, lineWidth: width, polygonLineCenter, browserCenter, workerCenter, driftPx: workerCenter - browserCenter, browserLeft: browserCenter - width / 2, workerLeft: workerCenter - width / 2, pngRawClamp, zipRawClamp }, null, 2));
} finally {
  await server.close();
}
