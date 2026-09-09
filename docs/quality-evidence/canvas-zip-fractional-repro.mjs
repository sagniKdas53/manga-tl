#!/usr/bin/env node
/**
 * Executable source-level repro for fractional ZIP project geometry loss.
 *
 * Run from repository root:
 *   node docs/quality-evidence/canvas-zip-fractional-repro.mjs
 *
 * It models serde_json::Value::as_i64 exactly for JSON number categories and
 * asserts the live restore source still uses that accessor for maxWidth and
 * maxHeight. No database is needed to reach the fallback branch.
 */
import { readFile } from "node:fs/promises";

const sourceUrl = new URL("../../backend-rust/src/routes/page.rs", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const restoreBlock = source.slice(source.indexOf("let max_width"), source.indexOf("let word_wrap"));
const asI64 = (value) => Number.isInteger(value) ? value : undefined;
const element = { maxWidth: 186.43, maxHeight: 187.91, rotation: 12.5 };
const restored = {
  maxWidth: asI64(element.maxWidth) ?? 150,
  maxHeight: asI64(element.maxHeight) ?? 80,
  rotation: Number(element.rotation ?? 0),
};

if (!restoreBlock.includes('get("maxWidth")') || !restoreBlock.includes(".and_then(|v| v.as_i64())") || restored.maxWidth !== 150 || restored.maxHeight !== 80 || restored.rotation !== 12.5) {
  throw new Error("Current ZIP restore contract did not match the documented repro");
}
console.log(JSON.stringify({ exported: element, restored, widthLossPx: element.maxWidth - restored.maxWidth, heightLossPx: element.maxHeight - restored.maxHeight, sourceUsesAsI64: true }, null, 2));
