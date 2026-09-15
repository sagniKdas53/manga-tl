import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { PageRenderer, RendererError } from "./renderer.mjs";

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
    const status = error instanceof RendererError ? 400 : 500;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}).listen(Number(process.env.PORT || 8090));
