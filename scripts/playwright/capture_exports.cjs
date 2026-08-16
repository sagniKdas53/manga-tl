#!/usr/bin/env node
/**
 * capture_exports.cjs — drive the Reader and capture the browser-side half of corpus/exports/.
 *
 * `page-N-export.png` and `page-N-layers.zip` are built in the browser: the canvas composite and
 * JSZip both live in Reader.tsx, so there is no server-side path to either. The worker render
 * (`page-N-rendered.png`) does have one — `GET /api/pages/{pageId}/rendered` — and belongs in the
 * Python arm; `--rendered` is here only for when that arm is not being run.
 *
 *   node scripts/playwright/capture_exports.cjs \
 *     --chapter 3f1c...  --pages 1-50  --out corpus/exports/qa-off
 *
 * Playwright is not a repo dependency. Install it first:
 *
 *   npm i -D playwright && npx playwright install chromium
 *
 * Three things this has to respect, all load-bearing:
 *
 *   1. The export controls only render when nothing is selected — ReaderRightSidebar.tsx guards
 *      the whole block on `!selectedItem`. So never click into the canvas.
 *   2. The export is only correct once the translation layers are in the DOM. handleExportPng
 *      awaits ensureFontsLoaded itself, but a canvas drawn before the layers arrive is a clean
 *      page with no text on it and no error anywhere. Hence the post-hoc element-count check.
 *   3. The unsaved-edits modal only fires when `dirtyElements` is non-empty, which a fresh
 *      navigation should never produce. It is dismissed with "Export Anyway" if it appears, and
 *      counted — seeing it at all means state leaked between pages.
 *
 * Resumable: a page whose outputs already exist is skipped unless --force. Exits non-zero if any
 * page failed, so a caller can retry the same command and only pay for what is missing.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/** Required lazily so --help and argument validation work before anyone has installed it. */
function loadChromium() {
  try {
    return require("playwright").chromium;
  } catch {
    console.error(
      "playwright is not installed. It is not a repo dependency:\n" +
      "  npm i -D playwright && npx playwright install chromium",
    );
    process.exit(2);
  }
}

const EXPORT_PNG = "Export Page (PNG)";
const EXPORT_ZIP = "Export Project (ZIP)";
const EXPORT_RENDERED = "Export Rendered PNG";

// The ZIP export rasterises one mask and one text layer per element, so it is much slower than
// the flat page composite. Both are generous on purpose: a timeout here costs a whole re-run.
const PNG_TIMEOUT_MS = 90_000;
const ZIP_TIMEOUT_MS = 180_000;

function parseArgs(argv) {
  const args = {
    base: process.env.TLHUB_BASE || "http://localhost:8080/tlhub",
    email: process.env.TLHUB_EMAIL || "",
    password: process.env.TLHUB_PASSWORD || "",
    chapter: "",
    out: "",
    pages: "",
    rendered: false,
    keepZip: false,
    force: false,
    headed: false,
    settleMs: 1500,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--base": args.base = next(); break;
      case "--email": args.email = next(); break;
      case "--password": args.password = next(); break;
      case "--chapter": args.chapter = next(); break;
      case "--out": args.out = next(); break;
      case "--pages": args.pages = next(); break;
      case "--settle-ms": args.settleMs = Number(next()); break;
      case "--rendered": args.rendered = true; break;
      case "--keep-zip": args.keepZip = true; break;
      case "--force": args.force = true; break;
      case "--headed": args.headed = true; break;
      case "-h": case "--help": args.help = true; break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

/** "1-50" | "3" | "1,4,9-12" -> [1,4,9,10,11,12] */
function parsePages(spec) {
  const out = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (b < a) throw new Error(`bad range: ${part}`);
      for (let n = a; n <= b; n++) out.push(n);
    } else if (/^\d+$/.test(part)) {
      out.push(Number(part));
    } else {
      throw new Error(`bad page spec: ${part}`);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * project.json out of the layer bundle, so the probes have something to read without unpacking
 * ~320MB of zips that are gitignored anyway. Shells out rather than taking a zip dependency for
 * one file; if unzip is missing the bundle is kept and the caller warned, not failed.
 */
function extractProjectJson(zipPath, destPath) {
  const buf = execFileSync("unzip", ["-p", zipPath, "project.json"], {
    maxBuffer: 256 * 1024 * 1024,
  });
  if (!buf || !buf.length) throw new Error("project.json was empty");
  JSON.parse(buf.toString("utf8")); // fail here rather than three stages later
  fs.writeFileSync(destPath, buf);
}

function countTranslationElements(projectPath) {
  try {
    const data = JSON.parse(fs.readFileSync(projectPath, "utf8"));
    const layers = data.layers || [];
    return layers
      .filter((l) => (l.type || l?.layer?.type) === "translation")
      .reduce((n, l) => n + ((l.elements || []).length), 0);
  } catch {
    return null;
  }
}

/**
 * Wait for the modal handleExportPng/handleExportZip raise when `dirtyElements` is non-empty, and
 * take the "Export Anyway" branch. Resolves either way — the common case is that it never shows.
 */
async function dismissUnsavedModal(page, stats) {
  const btn = page.getByRole("button", { name: "Export Anyway" });
  try {
    await btn.waitFor({ state: "visible", timeout: 4000 });
  } catch {
    return;
  }
  stats.unsavedModals += 1;
  await btn.click().catch(() => { });
}

async function clickAndDownload(page, buttonName, destPath, timeout, stats) {
  const button = page.getByRole("button", { name: buttonName, exact: true });
  await button.waitFor({ state: "visible", timeout: 30_000 });

  const modalWatcher = dismissUnsavedModal(page, stats);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout }),
    button.click(),
  ]);
  await download.saveAs(destPath);
  await modalWatcher;
  return destPath;
}

/**
 * Ready enough to export: the page image is up, the export controls are rendered (which also
 * means nothing is selected), and the network has stopped. The layers arriving is checked after
 * the fact against project.json — there is no DOM signal for it that survives a refactor.
 */
async function waitForReader(page, settleMs) {
  await page.waitForSelector('img[src*="/api/images/"]', { timeout: 60_000 });
  await page
    .getByRole("button", { name: EXPORT_ZIP, exact: true })
    .waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForLoadState("networkidle").catch(() => { });
  if (settleMs > 0) await page.waitForTimeout(settleMs);
}

async function capturePage(page, pageNumber, args, stats) {
  const tag = `page-${pageNumber}`;
  const exportPng = path.join(args.out, `${tag}-export.png`);
  const zipPath = path.join(args.out, `${tag}-layers.zip`);
  const projectPath = path.join(args.out, `${tag}-project.json`);
  const renderedPng = path.join(args.out, `${tag}-rendered.png`);

  const done =
    fs.existsSync(exportPng) &&
    fs.existsSync(projectPath) &&
    (!args.rendered || fs.existsSync(renderedPng));
  if (done && !args.force) {
    console.log(`${tag}: already captured, skipping`);
    stats.skipped += 1;
    return { page: pageNumber, status: "skipped" };
  }

  const consoleErrors = [];
  const onConsole = (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  };
  page.on("console", onConsole);

  try {
    await page.goto(`${args.base}/chapters/${args.chapter}/reader/${pageNumber}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForReader(page, args.settleMs);

    await clickAndDownload(page, EXPORT_PNG, exportPng, PNG_TIMEOUT_MS, stats);
    await clickAndDownload(page, EXPORT_ZIP, zipPath, ZIP_TIMEOUT_MS, stats);
    if (args.rendered) {
      await clickAndDownload(page, EXPORT_RENDERED, renderedPng, PNG_TIMEOUT_MS, stats);
    }

    let elements = null;
    try {
      extractProjectJson(zipPath, projectPath);
      elements = countTranslationElements(projectPath);
      if (!args.keepZip) fs.unlinkSync(zipPath);
    } catch (err) {
      console.warn(`${tag}: could not extract project.json (${err.message}); keeping the zip`);
      stats.warnings.push(`${tag}: ${err.message}`);
    }

    // Zero translation elements is the signature of exporting before the layers landed. It is not
    // fatal — a page can legitimately have none — but it is the thing worth re-checking by eye.
    if (elements === 0) {
      console.warn(`${tag}: project.json has no translation elements`);
      stats.warnings.push(`${tag}: 0 translation elements`);
    }

    const errs = consoleErrors.filter(
      (e) => !e.includes("Failed to load resource") && !e.includes("404"),
    );
    if (errs.length) stats.warnings.push(`${tag}: console: ${errs.slice(0, 3).join(" ; ")}`);

    console.log(`${tag}: ok${elements === null ? "" : ` (${elements} translation elements)`}`);
    stats.captured += 1;
    return { page: pageNumber, status: "ok", elements, consoleErrors: errs.length };
  } catch (err) {
    console.error(`${tag}: FAILED — ${err.message}`);
    stats.failed.push(pageNumber);
    return { page: pageNumber, status: "failed", error: String(err.message) };
  } finally {
    page.off("console", onConsole);
  }
}

async function login(page, args) {
  await page.goto(`${args.base}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email Address").fill(args.email);
  await page.getByLabel("Password").fill(args.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 30_000 }),
    page.getByRole("button", { name: "Sign In" }).click(),
  ]);
  await page.waitForLoadState("networkidle").catch(() => { });
}

const USAGE = `
capture_exports.cjs — capture the browser-side half of corpus/exports/

  --chapter <id>      chapter UUID to read from            (required)
  --out <dir>         output directory, e.g. corpus/exports/qa-off  (required)
  --pages <spec>      1-50 | 3 | 1,4,9-12                  (required)
  --base <url>        default http://localhost:8080/tlhub  [TLHUB_BASE]
  --email <addr>      [TLHUB_EMAIL]
  --password <pass>   [TLHUB_PASSWORD]
  --rendered          also click "Export Rendered PNG" (prefer the API arm)
  --keep-zip          keep page-N-layers.zip after extracting project.json
  --force             re-capture pages that already have output
  --headed            run with a visible browser
  --settle-ms <n>     extra wait after networkidle, default 1500
`;

(async () => {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  for (const required of ["chapter", "out", "pages"]) {
    if (!args[required]) {
      console.error(`missing --${required}\n${USAGE}`);
      process.exit(2);
    }
  }
  if (!args.email || !args.password) {
    console.error("missing credentials: pass --email/--password or set TLHUB_EMAIL/TLHUB_PASSWORD");
    process.exit(2);
  }

  const pages = parsePages(args.pages);
  fs.mkdirSync(args.out, { recursive: true });

  const stats = { captured: 0, skipped: 0, failed: [], unsavedModals: 0, warnings: [] };
  const started = new Date();

  const browser = await loadChromium().launch({ headless: !args.headed });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
  });
  const page = await context.newPage();

  const results = [];
  try {
    await login(page, args);
    console.log(`logged in -> ${page.url()}`);
    console.log(`capturing ${pages.length} pages into ${args.out}`);
    for (const n of pages) {
      results.push(await capturePage(page, n, args, stats));
    }
  } finally {
    await browser.close();
  }

  const summary = {
    chapter: args.chapter,
    base: args.base,
    pages: pages.length,
    captured: stats.captured,
    skipped: stats.skipped,
    failed: stats.failed,
    unsaved_modals: stats.unsavedModals,
    warnings: stats.warnings,
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    results,
  };
  fs.writeFileSync(
    path.join(args.out, "_capture.json"),
    JSON.stringify(summary, null, 2),
  );

  console.log("\n==== SUMMARY ====");
  console.log(`captured ${stats.captured}, skipped ${stats.skipped}, failed ${stats.failed.length}`);
  if (stats.unsavedModals) {
    console.log(`unsaved-edits modal appeared ${stats.unsavedModals}x — state is leaking between pages`);
  }
  for (const w of stats.warnings) console.log(`warn: ${w}`);
  if (stats.failed.length) console.log(`failed pages: ${stats.failed.join(", ")}`);

  process.exit(stats.failed.length ? 1 : 0);
})().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(2);
});
