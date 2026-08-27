#!/usr/bin/env node
/**
 * export_pending.cjs — drive the Reader to export pending gaps samples through our app,
 * mirroring how Torii's .torii bundles are built (original / inpainted / translated + metadata).
 *
 * Automatically inspects language and image dimensions (standard manga, webtoon vertical strip,
 * double spread) to smartly create or reuse series & chapters:
 *   - Korean (ko) -> leftToRight, local PP-OCRv5 (korean_PP-OCRv5_mobile_rec)
 *   - Chinese (zh) -> leftToRight, local PP-OCRv6 (PP-OCRv6_medium_rec)
 *   - Japanese (ja) -> rightToLeft, local PP-OCRv6 (PP-OCRv6_medium_rec)
 *   - Webtoon strip (aspect ratio >= 2.0) -> leftToRight reading direction
 *   - Translation engine -> OpenRouter GPT-5.6 Luna (openai/gpt-5.6-luna, matches Torii)
 *
 * It:
 *   1. Resolves/creates smart series & chapter via backend API
 *   2. Uploads pending source image as page 1 (POST /api/images)
 *   3. Waits for the async pipeline (OCR -> inpaint -> LLM translation -> QA) to settle
 *   4. Captures export.png + project.zip via Reader DOM export controls
 *   5. Unpacks project.zip into project/ directory (with project.json, masks, layer PNGs)
 *   6. Downloads worker rendered image (GET /api/pages/:id/rendered) -> render.png
 *
 * Usage:
 *   TLHUB_EMAIL=you@example.com TLHUB_PASSWORD=secret TLHUB_BASE=http://localhost:8084/tlhub \
 *   node scripts/playwright/export_pending.cjs --pending-dir corpus/gaps/pending/zh/sample501
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
    seriesId: "",
    chapterId: "",
    ocrProvider: "",
    ocrModel: "",
    tlProvider: "",
    tlModel: "",
    qaProvider: "",
    qaMode: "",
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
      case "--series-id": a.seriesId = nxt(); break;
      case "--chapter-id": a.chapterId = nxt(); break;
      case "--ocr-provider": a.ocrProvider = nxt(); break;
      case "--ocr-model": a.ocrModel = nxt(); break;
      case "--tl-provider": a.tlProvider = nxt(); break;
      case "--tl-model": a.tlModel = nxt(); break;
      case "--qa-provider": a.qaProvider = nxt(); break;
      case "--qa-mode": a.qaMode = nxt(); break;
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

async function getAuthToken(page, args) {
  let token = await page.evaluate(() => {
    const raw = localStorage.getItem("manga_user");
    if (raw) {
      try {
        const u = JSON.parse(raw);
        if (u && u.token) return u.token;
      } catch {}
    }
    return localStorage.getItem("token") || sessionStorage.getItem("token");
  });
  if (!token && args && args.email && args.password) {
    try {
      const res = await page.request.post(`${args.base}/api/auth/login`, {
        data: { email: args.email, password: args.password },
      });
      if (res.ok()) {
        const j = await res.json().catch(() => ({}));
        if (j.token) token = j.token;
      }
    } catch {}
  }
  return token;
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

function getImageDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height, type: "png", aspectRatio: height / (width || 1) };
  }
  // JPEG
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let offset = 2;
    while (offset < buf.length - 8) {
      if (buf[offset] !== 0xFF) { offset++; continue; }
      const marker = buf[offset + 1];
      if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) || (marker >= 0xC9 && marker <= 0xCB) || (marker >= 0xCD && marker <= 0xCF)) {
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        return { width, height, type: "jpeg", aspectRatio: height / (width || 1) };
      }
      const len = buf.readUInt16BE(offset + 2);
      offset += 2 + len;
    }
  }
  return null;
}

function deriveSmartConfig(lang, imageInfo, meta, args) {
  const normLang = (lang || meta?.language || meta?.source?.lang || "ja").toLowerCase();
  const aspectRatio = imageInfo?.aspectRatio || 1.4;
  const isWebtoon = aspectRatio >= 2.0;
  const isSpread = aspectRatio <= 0.8;

  // Reading direction
  let readingDirection = "rightToLeft";
  if (args.readingDirection) {
    readingDirection = args.readingDirection;
  } else if (isWebtoon) {
    readingDirection = "leftToRight";
  } else if (normLang === "ko") {
    readingDirection = "leftToRight";
  } else if (normLang.startsWith("zh")) {
    readingDirection = "leftToRight";
  } else if (normLang === "ja") {
    readingDirection = "rightToLeft";
  } else {
    readingDirection = "leftToRight";
  }

  // OCR Model: PP-OCRv5 for Korean (has Hangul rec model), PP-OCRv6 for Japanese/Chinese
  let ocrProvider = args.ocrProvider || "local";
  let ocrModel = args.ocrModel;
  if (!ocrModel) {
    if (normLang === "ko") {
      ocrModel = "PP-OCRv5";
    } else {
      ocrModel = "PP-OCRv6";
    }
  }

  // Translation Model: Torii uses GPT-5.6 Luna via OpenRouter
  const tlProvider = args.tlProvider || "openrouter";
  const tlModel = args.tlModel || "openai/gpt-5.6-luna";

  const typeLabel = isWebtoon ? " Webtoon" : (isSpread ? " Spread" : "");
  const seriesTitle = `Pending Exports (${normLang.toUpperCase()}${typeLabel})`;

  return {
    lang: normLang,
    isWebtoon,
    isSpread,
    readingDirection,
    ocrProvider,
    ocrModel,
    seriesTitle,
    tlProvider,
    tlModel,
    qaProvider: args.qaProvider || null,
    qaMode: args.qaMode || null,
  };
}

async function getOrCreateSeries(page, args, smartConfig) {
  const token = await getAuthToken(page, args);
  if (!token) throw new Error("not authenticated: cannot get token");

  if (args.seriesId) return args.seriesId;

  const lang = smartConfig.lang;

  // List existing series and find one matching language & direction
  const listRes = await page.request.get(`${args.base}/api/series?size=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (listRes.ok()) {
    const lj = await listRes.json().catch(() => ({}));
    const arr = Array.isArray(lj) ? lj : (lj.content || lj.series || []);
    const match = arr.find(s =>
      (s.sourceLanguage === lang || s.originalLanguage === lang) &&
      (s.readingDirection === smartConfig.readingDirection || !s.readingDirection) &&
      (s.title && s.title.toLowerCase().includes("pending"))
    ) || arr.find(s => s.sourceLanguage === lang || s.originalLanguage === lang);
    if (match) {
      console.log(`Reusing series "${match.title}" (${match.id || match.seriesId}) for lang=${lang}`);
      return match.id || match.seriesId;
    }
  }

  // Create new series with smart defaults
  const seriesPayload = {
    title: smartConfig.seriesTitle,
    originalLanguage: lang,
    sourceLanguage: lang,
    targetLanguage: "en",
    readingDirection: smartConfig.readingDirection,
    ocrProvider: smartConfig.ocrProvider,
    ocrModel: smartConfig.ocrModel,
    tlProvider: smartConfig.tlProvider,
    tlModel: smartConfig.tlModel,
    qaProvider: smartConfig.qaProvider,
    qaMode: smartConfig.qaMode,
    useFallbackModels: true,
  };

  const createRes = await page.request.post(`${args.base}/api/series`, {
    headers: { Authorization: `Bearer ${token}` },
    data: seriesPayload,
  });
  if (createRes.ok()) {
    const sj = await createRes.json().catch(() => ({}));
    const id = sj.id || sj.seriesId;
    console.log(`Created series "${smartConfig.seriesTitle}" (${id}) for lang=${lang} [direction=${smartConfig.readingDirection}, ocr=${smartConfig.ocrModel}]`);
    return id;
  }
  throw new Error(`Failed to create series: ${createRes.status()} ${await createRes.text().catch(() => "")}`);
}

async function getOrCreateChapter(page, args, seriesId, sampleId, smartConfig) {
  const token = await getAuthToken(page, args);
  if (!token) throw new Error("not authenticated: cannot get token");

  if (args.chapterId) return args.chapterId;

  const title = `pending-${sampleId}`;
  const listRes = await page.request.get(`${args.base}/api/series/${seriesId}/chapters?size=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (listRes.ok()) {
    const cj = await listRes.json().catch(() => ({}));
    const arr = Array.isArray(cj) ? cj : (cj.content || cj.chapters || []);
    const match = arr.find(c => c.title === title || c.title === sampleId);
    if (match) {
      console.log(`Reusing chapter "${match.title}" (${match.id || match.chapterId})`);
      return match.id || match.chapterId;
    }
  }

  const numMatch = sampleId.match(/\d+/);
  const chapterNumber = numMatch ? Number(numMatch[0]) : (Date.now() % 100000);

  const chapterPayload = {
    title,
    chapterNumber,
    ocrProvider: smartConfig.ocrProvider,
    ocrModel: smartConfig.ocrModel,
    tlProvider: smartConfig.tlProvider,
    tlModel: smartConfig.tlModel,
    qaProvider: smartConfig.qaProvider,
    qaMode: smartConfig.qaMode,
    useContextMemory: true,
    useFallbackModels: true,
  };

  const createRes = await page.request.post(`${args.base}/api/series/${seriesId}/chapters`, {
    headers: { Authorization: `Bearer ${token}` },
    data: chapterPayload,
  });
  if (createRes.ok()) {
    const cj = await createRes.json().catch(() => ({}));
    const id = cj.id || cj.chapterId;
    console.log(`Created chapter "${title}" (${id}) [num=${chapterNumber}]`);
    return id;
  }
  throw new Error(`Failed to create chapter: ${createRes.status()} ${await createRes.text().catch(() => "")}`);
}

async function uploadSource(page, chapterId, sourcePath, args) {
  const token = await getAuthToken(page, args);
  const buf = fs.readFileSync(sourcePath);
  const mimeType = sourcePath.endsWith(".png") ? "image/png" : "image/jpeg";
  const res = await page.request.post(`${args.base}/api/images`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      chapterId: String(chapterId),
      pageNumber: "1",
      file: { name: path.basename(sourcePath), mimeType, buffer: buf },
    },
  });
  if (!res.ok()) throw new Error(`upload failed ${res.status()} ${await res.text().catch(()=> "")}`);
  const j = await res.json().catch(()=> ({}));
  return {
    pageNumber: 1,
    pageId: j.pageId,
    imageId: j.imageId,
  };
}

async function waitForPipeline(page, pageId, args, timeoutMs = 180_000) {
  const token = await getAuthToken(page, args);
  const start = Date.now();
  console.log(`Waiting for pipeline to complete on page ${pageId}...`);
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await page.request.get(`${args.base}/api/pages/${pageId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok()) {
        const data = await res.json().catch(() => ({}));
        const layers = data.layers || [];
        const tlLayer = layers.find(l => (l.layer?.type || l.type) === "translation");
        if (tlLayer && tlLayer.elements && tlLayer.elements.length > 0) {
          console.log(`Pipeline complete: ${tlLayer.elements.length} translation elements generated`);
          return true;
        }
      }
    } catch (e) {}
    await page.waitForTimeout(3000);
  }
  console.warn(`Pipeline wait timed out after ${timeoutMs}ms, proceeding to Reader`);
  return false;
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
  const lang = meta.language || meta.source?.lang || "ja";
  const outDir = args.out ? path.join(path.resolve(args.out), lang, sampleId) : pendingDir;
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

  const sourceBuf = fs.readFileSync(sourcePath);
  const imageInfo = getImageDimensions(sourceBuf);
  const smartConfig = deriveSmartConfig(lang, imageInfo, meta, args);

  console.log(`${sampleId}: [${lang}] ${imageInfo?.width || '?'}x${imageInfo?.height || '?'} (ratio: ${imageInfo?.aspectRatio ? imageInfo.aspectRatio.toFixed(2) : '?'}) -> dir: ${smartConfig.readingDirection}, ocr: ${smartConfig.ocrModel}`);

  const seriesId = await getOrCreateSeries(page, args, smartConfig);
  const chapterId = await getOrCreateChapter(page, args, seriesId, sampleId, smartConfig);
  const { pageNumber, pageId } = await uploadSource(page, chapterId, sourcePath, args);
  console.log(`${sampleId}: uploaded as chapter ${chapterId} page ${pageNumber} (pageId ${pageId})`);

  // Wait for the backend pipeline to finish OCR + translation + inpainting
  await waitForPipeline(page, pageId, args);

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
    const token = await getAuthToken(page, args);
    const r = await page.request.get(`${args.base}/api/pages/${pageId}/rendered`, { headers: { Authorization: `Bearer ${token}` }});
    if (r.ok()) fs.writeFileSync(renderPng, await r.body());
  } catch {}

  // Unpack project.json
  try {
    const projJson = path.join(outDir, "project.json");
    extractProjectJson(zipPath, projJson);
    // unpack full zip to project/ for greppability
    execFileSync("unzip", ["-o", zipPath, "-d", projectDir]);
    fs.unlinkSync(zipPath); // keep only project/
    if (fs.existsSync(projJson)) fs.unlinkSync(projJson);
  } catch (e) {
    console.warn(`${sampleId}: could not unpack project.zip: ${e.message}`);
  }

  // Copy meta + refs into place if outputting to an external directory
  if (path.resolve(outDir) !== path.resolve(pendingDir)) {
    const destMeta = path.join(outDir, "meta.json");
    if (!fs.existsSync(destMeta)) {
      const newMeta = { ...meta, origin: { ...meta.origin, previous_path: path.relative(path.resolve("corpus"), pendingDir) } };
      fs.writeFileSync(destMeta, JSON.stringify(newMeta, null, 2));
    }
    for (const ref of meta.references || []) {
      const src = path.join(pendingDir, ref.file);
      const dst = path.join(outDir, ref.file);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
    if (!fs.existsSync(path.join(outDir, sourceFile))) fs.copyFileSync(sourcePath, path.join(outDir, sourceFile));
  }

  console.log(`${sampleId}: ok -> ${outDir}`);
  stats.captured++;
  return { sampleId, status: "ok" };
}

const USAGE = `
export_pending.cjs — export gaps/pending samples through our app (Browser + API)

Usage:
  node scripts/playwright/export_pending.cjs \\
    --pending-dir corpus/gaps/pending/ko/sample264 \\
    --base http://localhost:8084/tlhub --email you@example.com --password secret

Options:
  --pending-dir <dir>    gaps/pending, gaps/pending/ko, or single sample dir (required)
  --out <dir>            custom output root (default: writes in-place to sample dir)
  --limit <n>            only process first n pending dirs
  --base <url>           backend base URL, default http://localhost:8080/tlhub [TLHUB_BASE]
  --email <email>        login email [TLHUB_EMAIL]
  --password <pwd>       login password [TLHUB_PASSWORD]
  --force                re-export even if export.png + project/ exist
  --headed               show browser window
  --dry-run              don't upload/capture, just list matching directories
  --series-id <uuid>     override / force specific series ID
  --chapter-id <uuid>    override / force specific chapter ID
  --ocr-provider <name>  override OCR provider (default: local)
  --ocr-model <name>     override OCR model (default: PP-OCRv5 for KO, PP-OCRv6 for JA/ZH)
  --tl-provider <name>   override translation provider (default: openrouter)
  --tl-model <name>      override translation model (default: openai/gpt-5.6-luna)
  --qa-provider <name>   override QA provider
  --qa-mode <mode>       override QA mode (auto / disabled / always)
  --settle-ms <n>        extra wait time in ms after networkidle (default: 1500)
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
