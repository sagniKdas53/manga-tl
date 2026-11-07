#!/usr/bin/env node
/**
 * Gate #177: every text element has the same lines and font px in the editor and in the export.
 *
 * For each page it compares
 *   - the editor: what the Reader draws, read off its DOM (`[data-element-id]` and its
 *     `[data-text-pass="fill"]` text, in the page's own coordinates);
 *   - the export: the layout the renderer reported for the page's current scene, which the backend
 *     keeps in the render ledger (`page_render_jobs.layout_json`).
 *
 * The ledger has no API route, so it is read with psql inside the database container. Read only.
 * Nothing here renders or edits: re-render a page first if you want its current scene compared.
 * A page whose scene has no ledger row is reported as `no-render`, not as a match.
 *
 *   TLHUB_EMAIL=... TLHUB_PASSWORD=... node scripts/playwright/g2_parity.cjs \
 *     --base http://127.0.0.1:18093/tlhub --db-container manga-tl-test-db-1 \
 *     --out <dir> --tag after --page sample99=<pageId> [--page ...]
 *
 * Exits 1 if any page differs, so it can stand as a gate.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { json, login } = require("./r7_parity.cjs");

const FONT_PX_TOLERANCE = 0.01;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseArgs(argv) {
  const args = {
    base: "http://127.0.0.1:18093/tlhub",
    dbContainer: "manga-tl-test-db-1",
    out: "",
    tag: "run",
    email: process.env.TLHUB_EMAIL || "",
    password: process.env.TLHUB_PASSWORD || "",
    pages: [],
  };
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--base":
        args.base = next();
        break;
      case "--db-container":
        args.dbContainer = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--tag":
        args.tag = next();
        break;
      case "--page": {
        const [name, id] = next().split("=");
        if (!UUID.test(id || "")) throw new Error(`bad page id for ${name}`);
        args.pages.push({ name, id });
        break;
      }
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

/** The layout of the newest finished render of the page's current scene, or null. */
function exportLayout(container, pageId) {
  const sql =
    "SELECT coalesce(json_build_object(" +
    "'job_id', r.job_id, 'revision', p.scene_revision, 'layout', r.layout_json)::text, '') " +
    "FROM pages p " +
    "JOIN page_scene_snapshots s ON s.page_id = p.id AND s.revision = p.scene_revision " +
    "JOIN page_render_jobs r ON r.page_id = p.id " +
    "AND r.logical_scene_sha256 = s.logical_scene_sha256 AND r.status = 'succeeded' " +
    `WHERE p.id = '${pageId}' ORDER BY r.completed_at DESC LIMIT 1`;
  const out = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "sh",
      "-c",
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At',
    ],
    { input: sql, encoding: "utf8" },
  ).trim();
  return out ? JSON.parse(out) : null;
}

/** Every text object in the scene, in the shapes the scene route answers with. */
function sceneTextObjects(scene) {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      if (typeof value.object_id === "string" && value.style) found.push(value);
      Object.values(value).forEach(walk);
    }
  };
  walk(scene);
  return found;
}

/** What the Reader draws: `{elementId: {fontSize, lines}}`. */
function readEditor() {
  const drawn = {};
  for (const group of document.querySelectorAll("[data-element-id]")) {
    const passes = [...group.querySelectorAll('[data-text-pass="fill"]')];
    if (!passes.length) continue;
    const lines = passes
      .flatMap((pass) => (pass.textContent || "").split("\n"))
      .filter((line) => line !== "");
    if (!lines.length) continue;
    drawn[group.getAttribute("data-element-id")] = {
      fontSize: parseFloat(passes[0].style.fontSize),
      lines,
    };
  }
  return drawn;
}

/** Reads the editor until it has stopped changing: fitting re-runs once the fonts arrive. */
async function settledEditor(page) {
  // "attached": an element with no text draws an empty, invisible pass, and it may come first.
  await page.waitForSelector('[data-text-pass="fill"]', {
    state: "attached",
    timeout: 60_000,
  });
  await page.evaluate(() => document.fonts.ready);
  let previous = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = await page.evaluate(readEditor);
    const text = JSON.stringify(current);
    if (text === previous) return current;
    previous = text;
    await page.waitForTimeout(1000);
  }
  throw new Error("the editor's text did not settle within 30 s");
}

/** Pure comparison; `editor` is keyed by element id, `layout` by `text-<element id>`. */
function compareLayouts(editor, layout) {
  const exported = new Map(
    layout.map((entry) => [entry.object_id.replace(/^text-/, ""), entry]),
  );
  const differences = [];
  let matched = 0;
  for (const [id, drawn] of Object.entries(editor)) {
    const entry = exported.get(id);
    if (!entry) {
      differences.push({ id, kind: "only-in-editor", editor: drawn });
      continue;
    }
    const sizeDiffers =
      Math.abs(drawn.fontSize - entry.font_size) > FONT_PX_TOLERANCE;
    const linesDiffer =
      JSON.stringify(drawn.lines) !== JSON.stringify(entry.lines);
    if (sizeDiffers || linesDiffer) {
      differences.push({
        id,
        kind: sizeDiffers ? "font-px" : "line-breaks",
        editor: drawn,
        export: { fontSize: entry.font_size, lines: entry.lines },
      });
    } else {
      matched += 1;
    }
  }
  for (const [id, entry] of exported) {
    if (!(id in editor)) {
      differences.push({
        id,
        kind: "only-in-export",
        export: { fontSize: entry.font_size, lines: entry.lines },
      });
    }
  }
  return { matched, differences };
}

async function main() {
  const args = parseArgs(process.argv);
  const { chromium } = require("playwright");
  fs.mkdirSync(args.out, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  const response = await page.request.post(`${args.base}/api/auth/login`, {
    data: { email: args.email, password: args.password },
  });
  const { token } = await response.json();
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
    const scene = await json(
      page.request,
      args.base,
      token,
      "GET",
      `/api/pages/${id}/scene`,
    );
    const objects = sceneTextObjects(scene);
    const render = exportLayout(args.dbContainer, id);
    const { chapterId, pageNumber } = details.page;
    await page.goto(`${args.base}/chapters/${chapterId}/reader/${pageNumber}`, {
      waitUntil: "domcontentloaded",
    });
    const editor = await settledEditor(page);
    await page.screenshot({
      path: path.join(args.out, `${name}-${args.tag}-editor.png`),
    });
    const compared = render
      ? compareLayouts(editor, render.layout || [])
      : { matched: 0, differences: [{ id, kind: "no-render" }] };
    const result = {
      name,
      page_id: id,
      scene_revision: scene.page.revision,
      render_job: render ? render.job_id : null,
      text_objects: objects.length,
      with_outline: objects.filter((o) => o.style.mask_polygon).length,
      matched: compared.matched,
      differences: compared.differences,
    };
    results.push(result);
    const kinds = {};
    for (const difference of compared.differences) {
      kinds[difference.kind] = (kinds[difference.kind] || 0) + 1;
    }
    console.log(
      `${name}: revision ${result.scene_revision}, ${result.with_outline}/${result.text_objects} outlines, ` +
        `${result.matched} match, differ ${JSON.stringify(kinds)}`,
    );
  }
  fs.writeFileSync(
    path.join(args.out, `parity-${args.tag}.json`),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
  const failed = results.filter((r) => r.differences.length).length;
  console.log(`${results.length - failed}/${results.length} pages match`);
  if (failed) process.exitCode = 1;
}

module.exports = { compareLayouts, sceneTextObjects, settledEditor };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
