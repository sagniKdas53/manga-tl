import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { PageRenderer, RendererBusyError, RendererError } from "./renderer.mjs";

const configSource = process.env.PAGE_RENDERER_CONFIG || "{}";
const config = JSON.parse(configSource.startsWith("/") ? readFileSync(configSource, "utf8") : configSource);
const renderer = new PageRenderer({ fonts: config.fonts || [], maxContexts: config.maxContexts || 1 });
await renderer.start();

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/render") {
    response.writeHead(404).end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const result = await renderer.render(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...result, png: undefined, pngBase64: result.png.toString("base64") }));
  } catch (error) {
    // 503 + Retry-After for "busy" so the worker waits and resends; 400 stays "this scene is bad".
    // Only the renderer's own errors carry their message back. Anything else is logged here and
    // answered with a fixed text, so no stack or internal detail reaches the caller.
    const busy = error instanceof RendererBusyError;
    const headers = { "content-type": "application/json" };
    if (busy) headers["retry-after"] = "2";
    let status = 500;
    let message = "internal renderer error; see the page-renderer log";
    if (busy || error instanceof RendererError) {
      status = busy ? 503 : 400;
      message = error.message;
    } else if (error instanceof SyntaxError) {
      status = 400;
      message = "request body is not valid JSON";
    } else {
      console.error("[page-renderer] render failed:", error);
    }
    response.writeHead(status, headers);
    response.end(JSON.stringify({ error: message }));
  }
}).listen(Number(process.env.PORT || 8090));
