#!/usr/bin/env node
/**
 * export_pending.cjs — drive the Reader to export pending gaps samples through our app,
 * mirroring how Torii's .torii bundles are built (original / inpainted / translated + metadata).
 *
 * Unlike capture_exports.cjs which works on a pre-existing chapter (chapter UUID + page numbers),
 * this works on raw pending directories: gaps/pending/ko|zh/sampleNNN or gaps/scraped_tweets_pairs
 * leftovers, or any dir with source.* + ref-human.* . It:
 *   1. Creates a throwaway chapter via POST /api/chapters
 *   2. Uploads each pending source as a page (POST /api/chapters/:id/pages)
 *   3. Waits for the pipeline (OCR → translate → QA) to settle
 *   4. Captures page-N-export.png + page-N-layers.zip via the same DOM hooks as
 *      capture_exports.cjs (export controls gated on !selectedItem, translation layers in DOM)
 *   5. Unpacks the zip into project/ and writes project.json, then moves the trio into the
 *      sample's dir as export.png / render.png / project/ (like promote_drops does)
 *   6. Leaves ref-torii alongside ref-mangatranslator.ai — does not replace — so Torii automation
 *      (scripts/fetch_torii.py) can run in parallel and add its own ref.
 *
 * Usage:
 *   node scripts/playwright/export_pending.cjs \
 *     --pending-dir gaps/pending/ko \
 *     --out samples \
 *     --base http://localhost:8080/tlhub --email you@example.com --password secret
 *
 *   # single sample, dry run (no upload, just show what would happen)
 *   node scripts/playwright/export_pending.cjs --pending-dir gaps/pending/ko/sample264 --dry-run
 *
 *   # limit to a subset
 *   node scripts/playwright/export_pending.cjs --pending-dir gaps/pending --limit 5 --headed
 *
 * Requires: npm i -D playwright && npx playwright install chromium
 * Respects: --force to re-export already-complete samples
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function loadChromium() {
  try { return require("playwright").chromium; }
  catch {
    console.error("playwright not installed:\n  npm i -D playwright && npx playwright install chromium");
    process.exit(2);
  }
}

const EXPORT_PNG = "Export Page (PNG)";
const EXPORT_ZIP = "Export Project (ZIP)";

const PNG_TIMEOUT = 90_000;
const ZIP_TIMEOUT = 180_000;

function parseArgs(argv) {
  const a = {
    base: process.env.TLHUB_BASE || "http://localhost:8080/tlhub",
    email: process.env.TLHUB_EMAIL || "",
    password: process.env.TLHUB_PASSWORD || "",
    pendingDir: "",
    out: "",
    limit: 0,
    force: false,
    headed: false,
    dryRun: false,
    settleMs: 1500,
  };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i], nxt = () => argv[++i];
    switch (v) {
      case "--pending-dir": a.pendingDir = nxt(); break;
      case "--out": a.out = nxt(); break;
      case "--limit": a.limit = Number(nxt()); break;
      case "--base": a.base = nxt(); break;
      case "--email": a.email = nxt(); break;
      case "--password": a.password = nxt(); break;
      case "--force": a.force = true; break;
      case "--headed": a.headed = true; break;
      case "--dry-run": a.dryRun = true; break;
      case "--settle-ms": a.settleMs = Number(nxt()); break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`unknown arg: ${v}`);
    }
  }
  return a;
}

function findPending(pendingDir) {
  const abs = path.resolve(pendingDir);
  const stat = fs.statSync(abs);
  const dirs = [];
  if (stat.isDirectory() && fs.existsSync(path.join(abs, "meta.json"))) {
    dirs.push(abs);
  } else {
    // walk gaps/pending/ko, zh, or single lang dir
    const langs = ["ja","ko","zh"];
    const roots = langs.map(l => path.join(abs, l)).filter(p => fs.existsSync(p));
    const searchRoots = roots.length ? roots : [abs];
    for (const root of searchRoots) {
      for (const name of fs.readdirSync(root)) {
        const p = path.join(root, name);
        if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, "meta.json"))) {
          dirs.push(p);
        }
      }
    }
  }
  return dirs.sort();
}

function extractProjectJson(zipPath, destPath) {
  const buf = execFileSync("unzip", ["-p", zipPath, "project.json"], { maxBuffer: 256*1024*1024 });
  if (!buf || !buf.length) throw new Error("project.json empty");
  JSON.parse(buf.toString("utf8"));
  fs.writeFileSync(destPath, buf);
}

async function login(page, args) {
  await page.goto(`${args.base}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email Address").fill(args.email);
  await page.getByLabel("Password").fill(args.password);
  await Promise.all([
    page.waitForURL(u => !u.pathname.endsWith("/login"), { timeout: 30_000 }),
    page.getByRole("button", { name: "Sign In" }).click(),
  ]);
  await page.waitForLoadState("networkidle").catch(()=>{});
}

async function createChapter(page, args, title) {
  const token = await page.evaluate(() => localStorage.getItem("token") || sessionStorage.getItem("token"));
  if (token) {
    // Ensure we have a series: create one if needed, or use existing
    let seriesId = args.seriesId;
    if (!seriesId) {
      // Try to get or create a test series
      const seriesRes = await page.request.post(`${args.base}/api/series`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { title: "Pending Exports", originalLanguage: "ja", sourceLanguage: "ja", targetLanguage: "en" },
      });
      if (seriesRes.ok()) {
        const sj = await seriesRes.json().catch(()=> ({}));
        seriesId = sj.id || sj.seriesId;
      } else {
        // fallback: list series and pick first
        const listRes = await page.request.get(`${args.base}/api/series`, { headers: { Authorization: `Bearer ${token}` } });
        if (listRes.ok()) {
          const lj = await listRes.json().catch(()=> []);
          const arr = Array.isArray(lj) ? lj : (lj.content || lj.series || []);
          if (arr.length) seriesId = arr[0].id || arr[0].seriesId;
        }
      }
    }
    if (seriesId) {
      const res = await page.request.post(`${args.base}/api/series/${seriesId}/chapters`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { title, chapterNumber: Date.now() % 100000 },
      });
      if (res.ok()) {
        const j = await res.json().catch(()=> ({}));
        if (j.id || j.chapterId) return j.id || j.chapterId;
      }
    }
  }
  // UI fallback: navigate to new chapter flow (adjust selector to your app)
  await page.goto(`${args.base}/chapters/new`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Title").fill(title).catch(()=>{});
  await page.getByRole("button", { name: "Create" }).click().catch(()=>{});
  await page.waitForURL(/\/chapters\/[^/]+\/reader\/1/, { timeout: 30_000 }).catch(()=>{});
  const m = page.url().match(/\/chapters\/([^/]+)\//);
  if (!m) throw new Error("could not determine chapter id after create");
  return m[1];
}

async function uploadSource(page, chapterId, sourcePath, args) {
  const token = await page.evaluate(() => localStorage.getItem("token") || sessionStorage.getItem("token"));
  const buf = fs.readFileSync(sourcePath);
  const res = await page.request.post(`${args.base}/api/chapters/${chapterId}/pages`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      file: { name: path.basename(sourcePath), mimeType: sourcePath.endsWith(".png") ? "image/png" : "image/jpeg", buffer: buf },
    },
  });
  if (!res.ok()) throw new Error(`upload failed ${res.status()} ${await res.text().catch(()=> "")}`);
  const j = await res.json().catch(()=> ({}));
  return j.pageNumber || j.pageId || 1;
}

async function waitForReader(page, settleMs) {
  await page.waitForSelector('img[src*="/api/images/"]', { timeout: 60_000 });
  await page.getByRole("button", { name: EXPORT_ZIP, exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForLoadState("networkidle").catch(()=>{});
  if (settleMs > 0) await page.waitForTimeout(settleMs);
}

async function captureOnce(page, pendingDir, args, stats) {
  const meta = JSON.parse(fs.readFileSync(path.join(pendingDir, "meta.json"), "utf8"));
  const sourceFile = meta.source.file;
  const sourcePath = path.join(pendingDir, sourceFile);
  const sampleId = meta.sample_id;
  // out is samples/<lang>/sampleId  — derive lang from pending path or meta.language
  const lang = meta.language || "ja";
  const outDir = args.out ? path.join(path.resolve(args.out), lang, sampleId) : path.join(path.dirname(path.dirname(pendingDir)), "samples", lang, sampleId);
  const exportPng = path.join(outDir, "export.png");
  const renderPng = path.join(outDir, "render.png");
  const zipPath = path.join(outDir, "project.zip");
  const projectDir = path.join(outDir, "project");

  if (fs.existsSync(exportPng) && fs.existsSync(path.join(projectDir, "project.json")) && !args.force) {
    console.log(`${sampleId}: already exported, skipping`);
    stats.skipped++;
    return { sampleId, status: "skipped" };
  }

  if (args.dryRun) {
    console.log(`[dry-run] would export ${sampleId} (${sourcePath} -> ${outDir})`);
    return { sampleId, status: "dry-run" };
  }

  // Create a throwaway chapter for this single page (simplest isolation)
  const chapterId = await createChapter(page, args, `pending-${sampleId}`);
  const pageNumber = await uploadSource(page, chapterId, sourcePath, args);
  console.log(`${sampleId}: uploaded as chapter ${chapterId} page ${pageNumber}`);

  // Now capture via Reader
  await page.goto(`${args.base}/chapters/${chapterId}/reader/${pageNumber}`, { waitUntil: "domcontentloaded" });
  await waitForReader(page, args.settleMs);

  fs.mkdirSync(outDir, { recursive: true });

  // Download helpers (same as capture_exports.cjs)
  const dismissModal = async () => {
    const btn = page.getByRole("button", { name: "Export Anyway" });
    try { await btn.waitFor({ state: "visible", timeout: 4000 }); await btn.click().catch(()=>{}); } catch {}
  };

  const clickAndDownload = async (name, dest, timeout) => {
    const btn = page.getByRole("button", { name, exact: true });
    await btn.waitFor({ state: "visible", timeout: 30_000 });
    const watcher = dismissModal();
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout }), btn.click()]);
    await dl.saveAs(dest);
    await watcher;
  };

  await clickAndDownload(EXPORT_PNG, exportPng, PNG_TIMEOUT);
  await clickAndDownload(EXPORT_ZIP, zipPath, ZIP_TIMEOUT);

  // Also fetch worker render via API for redundancy
  try {
    const token = await page.evaluate(() => localStorage.getItem("token") || sessionStorage.getItem("token"));
    const r = await page.request.get(`${args.base}/api/pages/${chapterId}/${pageNumber}/rendered`, { headers: { Authorization: `Bearer ${token}` }});
    if (r.ok()) fs.writeFileSync(renderPng, await r.body());
  } catch {}

  // Unpack project.json
  try {
    const projJson = path.join(outDir, "project.json");
    extractProjectJson(zipPath, projJson);
    // unpack full zip to project/ for greppability
    execFileSync("unzip", ["-o", zipPath, "-d", projectDir]);
    fs.unlinkSync(zipPath); // keep only project/
    fs.unlinkSync(projJson);
  } catch (e) {
    console.warn(`${sampleId}: could not unpack project.zip: ${e.message}`);
  }

  // Copy meta + refs into place (so the pending dir becomes a complete sample)
  const destMeta = path.join(outDir, "meta.json");
  if (!fs.existsSync(destMeta)) {
    // promote: update origin.previous_path to gaps location, keep sample_id
    const newMeta = { ...meta, origin: { ...meta.origin, previous_path: path.relative(path.resolve("corpus"), pendingDir) } };
    fs.writeFileSync(destMeta, JSON.stringify(newMeta, null, 2));
  }
  // copy ref-human if not already
  for (const ref of meta.references || []) {
    const src = path.join(pendingDir, ref.file);
    const dst = path.join(outDir, ref.file);
    if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
  }
  // also copy source
  if (!fs.existsSync(path.join(outDir, sourceFile))) fs.copyFileSync(sourcePath, path.join(outDir, sourceFile));

  console.log(`${sampleId}: ok -> ${outDir}`);
  stats.captured++;
  return { sampleId, status: "ok" };
}

const USAGE = `
export_pending.cjs — export gaps/pending samples through our app (Browser + API)

  --pending-dir <dir>   gaps/pending, gaps/pending/ko, or single sample dir (required)
  --out <dir>           samples root, default corpus/samples (samples/<lang>/sampleId)
  --limit <n>           only first n pending dirs
  --base <url>          default http://localhost:8080/tlhub [TLHUB_BASE]
  --email --password     [TLHUB_EMAIL/PASSWORD]
  --force               re-export even if export.png + project/ exist
  --headed              show browser
  --dry-run             don't upload/capture, just list
`;

(async () => {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (!args.pendingDir) { console.error("missing --pending-dir\\n"+USAGE); process.exit(2); }
  if (!args.dryRun && (!args.email || !args.password)) {
    console.error("missing credentials: --email/--password or TLHUB_EMAIL/PASSWORD");
    process.exit(2);
  }
  const pending = findPending(args.pendingDir);
  const slice = args.limit ? pending.slice(0, args.limit) : pending;
  console.log(`found ${pending.length} pending${args.limit ? `, taking ${slice.length}` : ""} under ${args.pendingDir}`);
  if (!slice.length) process.exit(0);
  if (args.dryRun) {
    for (const p of slice) console.log(" -", path.relative(process.cwd(), p));
    process.exit(0);
  }

  const browser = await loadChromium().launch({ headless: !args.headed });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const stats = { captured: 0, skipped: 0, failed: [] };
  try {
    await login(page, args);
    console.log(`logged in -> ${page.url()}`);
    for (const dir of slice) {
      try { await captureOnce(page, dir, args, stats); }
      catch (e) { console.error(`${dir}: FAILED ${e.message}`); stats.failed.push(dir); }
    }
  } finally { await browser.close(); }
  console.log(`\nCaptured ${stats.captured}, skipped ${stats.skipped}, failed ${stats.failed.length}`);
  if (stats.failed.length) console.log("failed:", stats.failed.join(", "));
  process.exit(stats.failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
