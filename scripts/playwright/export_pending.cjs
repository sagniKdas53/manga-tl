#!/usr/bin/env node
/**
 * export_pending.cjs — drive the Reader to export pending gaps samples through our app,
 * mirroring how Torii's .torii bundles are built (original / inpainted / translated + metadata).
 *
 * Uploads run through **throwaway `__scratch__` containers that are reused and then deleted**, so a
 * 150-page batch no longer buries the real library. It used to create one chapter per sample
 * (`pending-sample264`), which left 150 chapters behind.
 *
 * It cannot always be exactly one series and one chapter, and the reason is the data model:
 * `readingDirection` is a **series** field while the OCR/TL model choice is a **chapter** field. So
 * the minimum is one scratch series per (language, direction) and one chapter per model config
 * within it -- a single-language run really is one and one. Scratch containers are also found and
 * reused across runs, so an interrupted run leaves the same handful rather than fresh orphans.
 *
 * Cleanup, in order: each page is deleted as soon as its artifacts are safely on disk (which also
 * drops the MinIO objects), then chapters, then series. Deleting a series is ADMIN-only, so a
 * TRANSLATOR account leaves an empty scratch series that the next run reuses -- harmless. Cleanup
 * runs in a `finally`, so a crashed run still tidies up. `--keep-scratch` / `--keep-pages` opt out.
 *
 * Automatically inspects language and image dimensions (standard manga, webtoon vertical strip,
 * double spread) to pick the right settings:
 *   - Korean (ko) -> leftToRight, local PP-OCRv5 (korean_PP-OCRv5_mobile_rec)
 *   - Chinese (zh) -> leftToRight, local PP-OCRv6 (PP-OCRv6_medium_rec)
 *   - Japanese (ja) -> rightToLeft, local PP-OCRv6 (PP-OCRv6_medium_rec)
 *   - Webtoon strip (aspect ratio >= 2.0) -> leftToRight reading direction
 *   - Translation engine -> OpenRouter GPT-5.6 Luna (openai/gpt-5.6-luna, matches Torii)
 *
 * It:
 *   1. Resolves/creates the scratch series & chapter via backend API (reused across samples)
 *   2. Uploads pending source image as page 1 (POST /api/images)
 *   3. Waits for the async pipeline (OCR -> inpaint -> LLM translation -> QA) to settle
 *   4. Captures export.png + project.zip via Reader DOM export controls
 *   5. Unpacks project.zip into project/ directory (with project.json, masks, layer PNGs)
 *   6. Downloads worker rendered image (GET /api/pages/:id/rendered) -> render.png
 *   7. Deletes the page; at the end of the run, deletes the scratch chapters and series
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
    keepScratch: false,
    keepPages: false,
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
    shard: "",
  };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i], nxt = () => argv[++i];
    switch (v) {
      case "--pending-dir": a.pendingDir = nxt(); break;
      case "--out": a.out = nxt(); break;
      case "--series-id": a.seriesId = nxt(); break;
      case "--chapter-id": a.chapterId = nxt(); break;
      case "--keep-scratch": a.keepScratch = true; break;
      case "--keep-pages": a.keepPages = true; break;
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
      case "--shard": a.shard = nxt(); break;
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

// ---------------------------------------------------------------------------------------------
// Scratch series/chapters.
//
// This used to create one chapter *per sample* ("pending-sample264"), so a 150-page run left 150
// chapters behind, burying the real library. Now every run funnels into throwaway containers that
// are reused and then deleted.
//
// It cannot always be literally one series and one chapter, and the reason is the data model:
// `readingDirection` lives on the **series** (ja is rightToLeft, ko/zh and webtoons are
// leftToRight), while the OCR/TL model choice lives on the **chapter**. So the minimum is one
// scratch series per (language, direction) actually encountered and one chapter per model config
// inside it. A single-language run really is one series and one chapter; a mixed ja/ko/zh run is
// three and three, all named `__scratch__…` and all removed at the end.
//
// Scratch containers are also *found and reused* across runs, not just within one, so an
// interrupted run leaves at most the same handful rather than a fresh orphan every time.
const SCRATCH_PREFIX = "__scratch__";

function seriesKey(c) { return `${c.lang}|${c.readingDirection}`; }
function chapterKey(c) { return `${c.ocrProvider}:${c.ocrModel}|${c.tlProvider}:${c.tlModel}|${c.qaProvider || "-"}:${c.qaMode || "-"}`; }

async function getOrCreateSeries(page, args, smartConfig, run) {
  const token = await getAuthToken(page, args);
  if (!token) throw new Error("not authenticated: cannot get token");
  if (args.seriesId) return args.seriesId;

  const key = seriesKey(smartConfig);
  if (run.series.has(key)) return run.series.get(key);

  const title = `${SCRATCH_PREFIX} ${smartConfig.lang} ${smartConfig.readingDirection}`;
  const listRes = await page.request.get(`${args.base}/api/series?size=200`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (listRes.ok()) {
    const lj = await listRes.json().catch(() => ({}));
    const arr = Array.isArray(lj) ? lj : (lj.content || lj.series || []);
    const match = arr.find(x => x.title === title);
    if (match) {
      const id = match.id || match.seriesId;
      console.log(`reusing scratch series "${title}" (${id})`);
      run.series.set(key, id);
      return id;
    }
  }

  const createRes = await page.request.post(`${args.base}/api/series`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      title,
      originalLanguage: smartConfig.lang,
      sourceLanguage: smartConfig.lang,
      targetLanguage: "en",
      readingDirection: smartConfig.readingDirection,
      ocrProvider: smartConfig.ocrProvider,
      ocrModel: smartConfig.ocrModel,
      tlProvider: smartConfig.tlProvider,
      tlModel: smartConfig.tlModel,
      qaProvider: smartConfig.qaProvider,
      qaMode: smartConfig.qaMode,
      useFallbackModels: true,
    },
  });
  if (!createRes.ok()) {
    throw new Error(`Failed to create scratch series: ${createRes.status()} ${await createRes.text().catch(() => "")}`);
  }
  const sj = await createRes.json().catch(() => ({}));
  const id = sj.id || sj.seriesId;
  console.log(`created scratch series "${title}" (${id}) [direction=${smartConfig.readingDirection}]`);
  run.series.set(key, id);
  run.createdSeries.add(id);
  return id;
}

async function getOrCreateChapter(page, args, seriesId, sampleId, smartConfig, run) {
  const token = await getAuthToken(page, args);
  if (!token) throw new Error("not authenticated: cannot get token");
  if (args.chapterId) return args.chapterId;

  const key = `${seriesId}|${chapterKey(smartConfig)}`;
  if (run.chapters.has(key)) return run.chapters.get(key);

  // --shard MUST be distinct for every runner working the corpus at the same time.
  //
  // uploadSource puts every sample at pageNumber 1 and relies on the page being deleted after
  // capture to free the slot -- safe only while one process owns the chapter. Two shards that
  // resolve to the same chapter both upload page 1 and both then open
  // `/chapters/<id>/reader/1`, so each exports whichever page most recently landed in the slot.
  // That is not theoretical: it put another sample's export into 7 of the 123 pages under
  // gaps/pending (ja/sample616, 634; ko/sample271, 280, 290, 296, 304) and into samples/ja/sample2,
  // and it is invisible whenever the two pages happen to share dimensions.
  //
  // Putting the shard label in the title gives each runner its own chapter, so page 1 is private
  // again and cleanupScratch still only deletes what this process created.
  const shardSuffix = args.shard ? ` #${args.shard}` : "";
  const title = `${SCRATCH_PREFIX} ${smartConfig.ocrModel} ${smartConfig.tlModel}${shardSuffix}`;
  const listChapters = async () => {
    const res = await page.request.get(`${args.base}/api/series/${seriesId}/chapters?size=200`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok()) return [];
    const cj = await res.json().catch(() => ({}));
    return Array.isArray(cj) ? cj : (cj.content || cj.chapters || []);
  };

  const existing = await listChapters();
  const match = existing.find(c => c.title === title);
  if (match) {
    const id = match.id || match.chapterId;
    console.log(`reusing scratch chapter "${title}" (${id})`);
    run.chapters.set(key, id);
    return id;
  }

  // chapterNumber has to be free, not just 1. The backend rejects a duplicate number within a
  // series with 409, and once shards get their own chapters there is more than one scratch
  // chapter in the series -- so a hardcoded 1 fails for every shard after the first. Take the
  // next number above whatever is already there, and retry on 409, because two shards computing
  // "next" at the same moment will compute the same one.
  const used = new Set(existing.map(c => Number(c.chapterNumber)).filter(Number.isFinite));
  let chapterNumber = 1;
  while (used.has(chapterNumber)) chapterNumber++;

  let createRes;
  for (let attempt = 0; attempt < 8; attempt++) {
    createRes = await page.request.post(`${args.base}/api/series/${seriesId}/chapters`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
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
      },
    });
    if (createRes.status() !== 409) break;
    // Someone else took this number between the list and the create. It may also be that they
    // created OUR title, in which case reuse theirs rather than fighting for a number.
    const raced = (await listChapters()).find(c => c.title === title);
    if (raced) {
      const id = raced.id || raced.chapterId;
      console.log(`reusing scratch chapter "${title}" (${id}) [created concurrently]`);
      run.chapters.set(key, id);
      return id;
    }
    chapterNumber++;
  }
  if (!createRes.ok()) {
    throw new Error(`Failed to create scratch chapter: ${createRes.status()} ${await createRes.text().catch(() => "")}`);
  }
  const cj = await createRes.json().catch(() => ({}));
  const id = cj.id || cj.chapterId;
  console.log(`created scratch chapter "${title}" (${id}) [ocr=${smartConfig.ocrModel} tl=${smartConfig.tlModel}]`);
  run.chapters.set(key, id);
  run.createdChapters.add(id);
  return id;
}

async function deletePage(page, args, pageId) {
  // Pages are deleted as we go so the scratch chapter never grows past a page or two -- the Reader
  // loads a whole chapter, and a 150-page scratch chapter would slow every later capture down.
  // DELETE /api/pages/{id} also removes the MinIO objects, so this is a real cleanup, not a
  // database-only one.
  try {
    const token = await getAuthToken(page, args);
    const r = await page.request.delete(`${args.base}/api/pages/${pageId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok()) console.warn(`  could not delete page ${pageId}: ${r.status()}`);
    return r.ok();
  } catch (e) {
    console.warn(`  could not delete page ${pageId}: ${e.message}`);
    return false;
  }
}

async function cleanupScratch(page, args, run) {
  if (args.keepScratch) {
    console.log("\n--keep-scratch: leaving scratch series/chapters in place");
    return;
  }
  const token = await getAuthToken(page, args).catch(() => null);
  if (!token) { console.warn("cleanup skipped: no auth token"); return; }
  console.log("\ncleaning up scratch containers");

  for (const id of run.createdChapters) {
    const r = await page.request.delete(`${args.base}/api/series/chapters/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(e => ({ ok: () => false, status: () => e.message }));
    console.log(`  chapter ${id}: ${r.ok() ? "deleted" : "FAILED " + r.status()}`);
  }
  for (const id of run.createdSeries) {
    const r = await page.request.delete(`${args.base}/api/series/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(e => ({ ok: () => false, status: () => e.message }));
    // DELETE /api/series/{id} is ADMIN-only. A TRANSLATOR account gets 403 here, which is not a
    // failure of the run -- the chapters are already gone and the empty scratch series is reused
    // by the next run rather than duplicated.
    console.log(`  series ${id}: ${r.ok() ? "deleted" : "left in place (" + r.status() + ")"}`);
  }
}

async function uploadSource(page, chapterId, sourcePath, args, run) {
  const token = await getAuthToken(page, args);
  const buf = fs.readFileSync(sourcePath);
  const mimeType = sourcePath.endsWith(".png") ? "image/png" : "image/jpeg";

  // Page numbering, and why it is not simply always 1.
  //
  // Every sample used to get its own chapter, so hardcoding pageNumber=1 was safe. Now that the
  // chapter is shared across the whole run, two samples uploaded as page 1 would collide. Deleting
  // each page once its artifacts are captured normally keeps slot 1 free -- so page deletion is
  // load-bearing here, not just tidiness. `--keep-pages` deliberately breaks that invariant, so in
  // that mode we increment instead of reusing the slot.
  const key = String(chapterId);
  const next = (run && run.pageNo.get(key)) || 1;
  const pageNumber = args.keepPages ? next : 1;
  if (run) run.pageNo.set(key, next + 1);

  const res = await page.request.post(`${args.base}/api/images`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      chapterId: String(chapterId),
      pageNumber: String(pageNumber),
      file: { name: path.basename(sourcePath), mimeType, buffer: buf },
    },
  });
  if (!res.ok()) throw new Error(`upload failed ${res.status()} ${await res.text().catch(()=> "")}`);
  const j = await res.json().catch(()=> ({}));
  return {
    pageNumber: j.pageNumber || pageNumber,
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

async function captureOnce(page, pendingDir, args, stats, run) {
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

  const seriesId = await getOrCreateSeries(page, args, smartConfig, run);
  const chapterId = await getOrCreateChapter(page, args, seriesId, sampleId, smartConfig, run);
  const { pageNumber, pageId } = await uploadSource(page, chapterId, sourcePath, args, run);
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

  // Unpack project.json.
  //
  // The zip is KEPT. It used to be deleted here ("keep only project/"), which was wrong on two
  // counts: producing it costs a full pipeline run including paid LLM translation, so it is not
  // cheap to reproduce; and the corpus convention is to keep it — corpus/.gitignore:52 ignores
  // `samples/**/project.zip` precisely because it "is present locally and absent in a fresh
  // clone". Unpacking is for greppability, not a replacement for the artifact.
  try {
    const projJson = path.join(outDir, "project.json");
    extractProjectJson(zipPath, projJson);
    // unpack full zip to project/ for greppability
    execFileSync("unzip", ["-o", zipPath, "-d", projectDir]);
    // project.json now exists inside project/; the top-level copy was only a validity check
    if (fs.existsSync(projJson)) fs.unlinkSync(projJson);
  } catch (e) {
    console.warn(`${sampleId}: could not unpack project.zip: ${e.message} (zip kept at ${zipPath})`);
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

  // Only now that every artifact is written to disk is it safe to drop the page from the app.
  if (!args.keepPages) await deletePage(page, args, pageId);

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
  --shard <label>        REQUIRED when several runners work at once: gives this one its own
                         scratch chapter. Sharing a chapter means sharing page slot 1, and the
                         shards then export each other's pages. See getOrCreateChapter.
  --headed               show browser window
  --dry-run              don't upload/capture, just list matching directories
  --keep-scratch         do not delete the scratch series/chapters at the end (debugging)
  --keep-pages           do not delete each page after its artifacts are captured.
                         Pages then accumulate in the shared scratch chapter and are
                         numbered sequentially instead of reusing slot 1.
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
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const stats = { captured: 0, skipped: 0, failed: [] };
  const run = { series: new Map(), chapters: new Map(), pageNo: new Map(),
                createdSeries: new Set(), createdChapters: new Set() };
  try {
    await login(page, args);
    console.log(`logged in -> ${page.url()}`);
    for (const dir of slice) {
      try { await captureOnce(page, dir, args, stats, run); }
      catch (e) { console.error(`${dir}: FAILED ${e.message}`); stats.failed.push(dir); }
    }
  } finally {
    // Cleanup runs even when the loop threw, so a crashed run does not leave containers behind.
    try { await cleanupScratch(page, args, run); } catch (e) { console.warn(`cleanup failed: ${e.message}`); }
    await browser.close();
  }
  console.log(`\nCaptured ${stats.captured}, skipped ${stats.skipped}, failed ${stats.failed.length}`);
  if (stats.failed.length) console.log("failed:", stats.failed.join(", "));
  process.exit(stats.failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
