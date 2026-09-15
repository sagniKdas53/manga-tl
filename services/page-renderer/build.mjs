import { build } from "esbuild";

await build({
  entryPoints: ["src/static-entry.ts"],
  bundle: true,
  format: "iife",
  globalName: "PageSceneStatic",
  outfile: "dist/scene-static.js",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
});
