#!/usr/bin/env node
/**
 * Create the six retained A03 baseline chapters and capture their A04 browser outputs.
 *
 * This runner is intentionally limited to the fixed quality fixtures. It creates no
 * production data when used with the isolated dev Compose project and keeps every
 * chapter alive until the export pass has finished.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const FIXTURES = [
  ["sample177", "corpus/samples/ja/sample177/source.jpg"],
  ["sample222", "corpus/samples/ja/sample222/source.png"],
  ["sample61", "corpus/samples/ja/sample61/source.jpg"],
  ["sample99", "corpus/samples/ja/sample99/source.jpg"],
  ["sample93", "corpus/samples/ja/sample93/source.png"],
  ["sample83", "corpus/samples/ja/sample83/source.jpg"],
];

const CONVENTIONAL_CONTROLS = [
  ["sample7", "corpus/samples/ja/sample7/source.jpeg"],
  ["sample139", "corpus/samples/ja/sample139/source.png"],
  ["sample39", "corpus/samples/ja/sample39/source.jpg"],
  ["sample47", "corpus/samples/ja/sample47/source.jpg"],
  ["sample123", "corpus/samples/ja/sample123/source.jpg"],
  ["sample134", "corpus/samples/ja/sample134/source.jpg"],
  ["sample150", "corpus/samples/ja/sample150/source.jpg"],
  ["sample172", "corpus/samples/ja/sample172/source.jpeg"],
  ["sample192", "corpus/samples/ko/sample192/source.jpg", "ko"],
  ["sample197", "corpus/samples/ko/sample197/source.png", "ko"],
  ["sample199", "corpus/samples/ko/sample199/source.png", "ko"],
  ["sample268", "corpus/gaps/pending/ko/sample268/source.jpg", "ko"],
  ["sample289", "corpus/gaps/pending/ko/sample289/source.jpg", "ko"],
  ["sample320", "corpus/gaps/pending/ko/sample320/source.jpg", "ko"],
  ["sample360", "corpus/gaps/pending/ko/sample360/source.jpg", "ko"],
  ["sample416", "corpus/gaps/pending/ko/sample416/source.jpg", "ko"],
  ["sample206", "corpus/samples/zh/sample206/source.png", "zh"],
  ["sample208", "corpus/samples/zh/sample208/source.png", "zh"],
  ["sample226", "corpus/samples/zh/sample226/source.jpg", "zh"],
  ["sample261", "corpus/samples/zh/sample261/source.png", "zh"],
  ["sample457", "corpus/gaps/pending/zh/sample457/source.jpg", "zh"],
  ["sample609", "corpus/gaps/pending/zh/sample609/source.jpg", "zh"],
  ["sample611", "corpus/gaps/pending/zh/sample611/source.jpg", "zh"],
  ["sample612", "corpus/gaps/pending/zh/sample612/source.jpg", "zh"],
];

const PIPELINE_TIMEOUT_MS = 30 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
const EXPORT_PNG = "Export Page (PNG)";
const EXPORT_ZIP = "Export Project (ZIP)";
const EXPORT_RENDERED = "Export Rendered PNG";

function parseArgs(argv) {
  const args = {
    base: "http://localhost:18081/tlhub",
    out: "",
    email: process.env.TLHUB_EMAIL || "",
    password: process.env.TLHUB_PASSWORD || "",
    register: false,
    headed: false,
    fixtures: [],
  };
  for (let index = 2; index < argv.length; index++) {
    const value = argv[index];
    const next = () => argv[++index];
    switch (value) {
      case "--base": args.base = next(); break;
      case "--out": args.out = next(); break;
      case "--email": args.email = next(); break;
      case "--password": args.password = next(); break;
      case "--register": args.register = true; break;
      case "--headed": args.headed = true; break;
      case "--fixture": args.fixtures.push(next()); break;
      case "-h":
      case "--help": args.help = true; break;
      default: throw new Error(`unknown argument: ${value}`);
    }
  }
  return args;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function loadChromium() {
  try {
    return require("playwright").chromium;
  } catch {
    throw new Error("playwright is required; install it with npm i -D playwright && npx playwright install chromium");
  }
}

async function requestJson(request, url, options = {}) {
  const response = await request.fetch(url, options);
  if (!response.ok()) {
    throw new Error(`${options.method || "GET"} ${url} failed with HTTP ${response.status()}`);
  }
  return response.json();
}

async function registerFreshAccount(request, base) {
  const nonce = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  const email = `quality-a03-${nonce}@test.local`;
  const password = crypto.randomBytes(24).toString("base64url");
  const result = await requestJson(request, `${base}/api/auth/register`, {
    method: "POST",
    data: { email, password, displayName: "Quality A03 Runner" },
  });
  if (!result.token) throw new Error("fresh account registration did not return a token");
  return { email, password, role: result.user?.role || result.role || "unknown" };
}

async function login(page, base, credentials) {
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email Address").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 30_000 }),
    page.getByRole("button", { name: "Sign In" }).click(),
  ]);
}

async function tokenFor(page, base, credentials) {
  const response = await page.request.post(`${base}/api/auth/login`, {
    data: { email: credentials.email, password: credentials.password },
  });
  if (!response.ok()) throw new Error(`API login failed with HTTP ${response.status()}`);
  const payload = await response.json();
  if (!payload.token) throw new Error("API login did not return a token");
  return payload.token;
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

async function waitForPipeline(page, base, token, pageId, sample) {
  const deadline = Date.now() + PIPELINE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const jobs = await requestJson(page.request, `${base}/api/jobs`, { headers: auth(token) });
    const active = jobs.jobs || [];
    const failed = active.filter((job) => job.status === "FAILED" || job.status === "PAUSED");
    if (failed.length) {
      throw new Error(`${sample}: pipeline stopped with ${failed.length} failed or paused job(s)`);
    }
    if (!active.length) {
      return requestJson(page.request, `${base}/api/pages/${pageId}`, { headers: auth(token) });
    }
    await page.waitForTimeout(2_000);
  }
  throw new Error(`${sample}: pipeline did not become idle within ${PIPELINE_TIMEOUT_MS / 60_000} minutes`);
}

async function clickAndDownload(page, name, destination) {
  const button = page.getByRole("button", { name, exact: true });
  await button.waitFor({ state: "visible", timeout: 60_000 });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: DOWNLOAD_TIMEOUT_MS }),
    button.click(),
  ]);
  await download.saveAs(destination);
}

async function captureExports(page, base, token, record, out) {
  const sampleDir = path.join(out, "a04-exports", record.sample);
  fs.mkdirSync(sampleDir, { recursive: true });
  await page.goto(`${base}/chapters/${record.chapter_id}/reader/1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('img[src*="/api/images/"]', { timeout: 60_000 });
  await page.getByRole("button", { name: EXPORT_ZIP, exact: true }).waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1_500);

  await page.screenshot({ path: path.join(sampleDir, "editor.png"), fullPage: true });
  await clickAndDownload(page, EXPORT_PNG, path.join(sampleDir, "export.png"));
  await clickAndDownload(page, EXPORT_ZIP, path.join(sampleDir, "project.zip"));
  await clickAndDownload(page, EXPORT_RENDERED, path.join(sampleDir, "rendered.png"));

  try {
    execFileSync("unzip", ["-o", "project.zip", "-d", "project"], {
      cwd: sampleDir,
      stdio: "ignore",
    });
  } catch {
    throw new Error(`${record.sample}: exported project ZIP could not be unpacked`);
  }

  const effectiveFonts = await page.evaluate(() => Array.from(document.fonts).map((font) => ({
    family: font.family,
    style: font.style,
    weight: font.weight,
    status: font.status,
  })));
  const pageSnapshot = await requestJson(page.request, `${base}/api/pages/${record.page_id}`, {
    headers: auth(token),
  });
  writeJson(path.join(sampleDir, "browser-fonts.json"), effectiveFonts);
  writeJson(path.join(sampleDir, "page-snapshot.json"), pageSnapshot);
  return {
    editor_png_sha256: sha256(fs.readFileSync(path.join(sampleDir, "editor.png"))),
    export_png_sha256: sha256(fs.readFileSync(path.join(sampleDir, "export.png"))),
    rendered_png_sha256: sha256(fs.readFileSync(path.join(sampleDir, "rendered.png"))),
    project_zip_sha256: sha256(fs.readFileSync(path.join(sampleDir, "project.zip"))),
    loaded_font_faces: effectiveFonts.length,
  };
}

const USAGE = `
capture_quality_baseline.cjs — fresh A03 pipeline data plus A04 browser exports

  --out <dir>              run directory (required)
  --base <url>             isolated stack, default http://localhost:18081/tlhub
  --register               create an ephemeral account on a fresh isolated database
  --email <email>          existing account, or TLHUB_EMAIL
  --password <password>    existing account, or TLHUB_PASSWORD
  --headed                 show the browser
  --fixture <sample>       run a named fixture; repeat for multiple isolated pages
`;

(async () => {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.out) throw new Error(`missing --out\n${USAGE}`);
  if (!args.register && (!args.email || !args.password)) {
    throw new Error(`pass --register for a fresh isolated database, or supply credentials\n${USAGE}`);
  }

  const out = path.resolve(args.out);
  if (fs.existsSync(out) && fs.readdirSync(out).length) {
    throw new Error(`refusing non-empty run directory: ${out}`);
  }
  fs.mkdirSync(out, { recursive: true });
  const fixtures = args.fixtures.length
    ? [...FIXTURES, ...CONVENTIONAL_CONTROLS].filter(([sample]) => args.fixtures.includes(sample))
    : FIXTURES;
  if (!fixtures.length || (args.fixtures.length && fixtures.length !== args.fixtures.length)) {
    throw new Error(`unknown fixture: ${args.fixtures.join(", ")}`);
  }
  const chromium = loadChromium();
  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const manifest = { task: "A03/A04", started_at: new Date().toISOString(), base: args.base, pages: [] };

  try {
    const credentials = args.register
      ? await registerFreshAccount(page.request, args.base)
      : { email: args.email, password: args.password, role: "existing" };
    console.log(`authenticated isolated runner account (role=${credentials.role})`);
    await login(page, args.base, credentials);
    const token = await tokenFor(page, args.base, credentials);

    const seriesByLanguage = new Map();

    for (let index = 0; index < fixtures.length; index++) {
      const [sample, sourceRelativePath, fixtureLanguage = "ja"] = fixtures[index];
      let seriesId = seriesByLanguage.get(fixtureLanguage);
      if (!seriesId) {
        const series = await requestJson(page.request, `${args.base}/api/series`, {
          method: "POST",
          headers: auth(token),
          data: {
            title: `A03 retained baselines ${fixtureLanguage} ${new Date().toISOString()}`,
            originalLanguage: fixtureLanguage,
            sourceLanguage: fixtureLanguage,
            targetLanguage: "en",
            readingDirection: "rightToLeft",
            ocrProvider: "local",
            ocrModel: "PP-OCRv6",
            tlProvider: "openrouter",
            tlModel: "openai/gpt-5.6-luna",
            qaProvider: "openrouter",
            qaLlmModel: "openai/gpt-5.6-luna",
            qaVlmModel: "google/gemini-3.1-flash-lite",
            qaMode: "auto",
            useFallbackModels: false,
          },
        });
        seriesId = series.id || series.seriesId;
        seriesByLanguage.set(fixtureLanguage, seriesId);
      }
      const sourcePath = path.resolve(sourceRelativePath);
      const source = fs.readFileSync(sourcePath);
      const chapter = await requestJson(page.request, `${args.base}/api/series/${seriesId}/chapters`, {
        method: "POST",
        headers: auth(token),
        data: {
          title: sample,
          chapterNumber: index + 1,
          ocrProvider: "local",
          ocrModel: "PP-OCRv6",
          tlProvider: "openrouter",
          tlModel: "openai/gpt-5.6-luna",
          qaProvider: "openrouter",
          qaLlmModel: "openai/gpt-5.6-luna",
          qaVlmModel: "google/gemini-3.1-flash-lite",
          qaMode: "auto",
          useContextMemory: true,
          useFallbackModels: false,
        },
      });
      const chapterId = chapter.id || chapter.chapterId;
      const upload = await requestJson(page.request, `${args.base}/api/images`, {
        method: "POST",
        headers: auth(token),
        multipart: {
          chapterId,
          pageNumber: "1",
          file: {
            name: path.basename(sourcePath),
            mimeType: sourcePath.endsWith(".png") ? "image/png" : "image/jpeg",
            buffer: source,
          },
        },
      });
      const record = {
        sample,
        source_path: sourceRelativePath,
        source_sha256: sha256(source),
        source_language: fixtureLanguage,
        series_id: seriesId,
        chapter_id: chapterId,
        page_id: upload.pageId,
        image_id: upload.imageId,
      };
      console.log(`${sample}: pipeline running`);
      record.page_snapshot = await waitForPipeline(page, args.base, token, record.page_id, sample);
      manifest.pages.push(record);
      writeJson(path.join(out, "a03-manifest.partial.json"), manifest);
      console.log(`${sample}: pipeline complete`);
    }

    for (const record of manifest.pages) {
      console.log(`${record.sample}: capturing browser exports`);
      record.a04 = await captureExports(page, args.base, token, record, out);
      writeJson(path.join(out, "a04-manifest.partial.json"), manifest);
    }
    manifest.finished_at = new Date().toISOString();
    writeJson(path.join(out, "manifest.json"), manifest);
    for (const name of ["a03-manifest.partial.json", "a04-manifest.partial.json"]) {
      fs.rmSync(path.join(out, name), { force: true });
    }
    console.log(`completed ${fixtures.length} retained baseline(s) and exports: ${out}`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(`QUALITY BASELINE FAILED: ${error.message}`);
  process.exit(1);
});
