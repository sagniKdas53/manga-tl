#!/usr/bin/env node
/**
 * corpus_batch.cjs — push a corpus sample list through a tl-hub instance as ONE chapter, then
 * harvest every finished page's artifacts back to disk.
 *
 * It is the batch-shaped sibling of scripts/playwright/export_pending.cjs. That one works a single
 * pending sample, captures it, DELETES the page to free page-slot 1 in a shared scratch chapter,
 * and deletes the scratch at the end. This one keeps the pages: a run is one series + one chapter
 * holding N pages in corpus order, which is what makes `useContextMemory` (Inject Context Memory)
 * and the reader's "6/50" page counter mean anything.
 *
 * Per page it pulls back, under <out>/NNN-<sampleId>/:
 *   render.png    GET  /api/pages/{id}/rendered      -- the worker's typeset PNG (ground truth)
 *   export.png    reader "Export PNG"               -- the frontend's canvas composite
 *   project.zip   reader "Export ZIP"               -- project.json + per-layer masks/text images
 *   project/      project.zip unpacked, for grepping
 *   editor.png    reader screenshot, Clean scanlation ON
 *   page.json     GET  /api/pages/{id}              -- layers, elements, ocrRegions, conversations
 * and one run.json manifest at the root that makes an interrupted run resumable.
 *
 * Credentials. `--email/--password` (or TLHUB_EMAIL/TLHUB_PASSWORD) are used when given. With
 * neither, the run registers its own throwaway TRANSLATOR account -- role is passed explicitly
 * because a registration that omits it, or asks for admin, is rejected with
 * "Cannot register as Admin" (backend-rust/src/routes/auth.rs:274-289). Uploading a page already
 * needs TRANSLATOR or ADMIN (routes/page.rs:411-413), so VIEWER would register fine and then fail
 * on the first upload. The generated address is stamped with the run id and printed, so the
 * account left behind on the test instance is identifiable. It is never deleted: the API surface
 * reachable from here has no delete-account route.
 *
 * Scheduling: how this instance actually processes work, because it decides the run shape.
 * A stage is a row in `jobs` (PENDING at insert) whose payload is RPUSHed onto the Redis list
 * `queue:<type>`; one dispatcher task polls every 2s, checks a global Redis pause gate, asks each
 * worker for its free heavy/light slots, then LPOPs the queues heavy-first and POSTs the payload
 * to the worker (backend-rust/src/jobs/dispatcher.rs:85-136). So the order is FIFO *in push
 * order*, which is upload order -- not random. The worker then runs one thread per accepted job
 * and heartbeats a 120s lease; each stage queues its successor inside the callback transaction.
 *
 * That makes submit-one-and-wait the wrong shape here: each page costs minutes of panel -> ocr ->
 * layout -> cleanup -> translation -> qa -> render, times the page count, and it would also need
 * the pre-existing backlog out of the way. Instead this pauses the global queue
 * (`POST /api/jobs/pause`, which gates both the dispatcher's run_cycle and every enqueue), uploads
 * every page so they sit at the head of every queue, resumes, and then harvests pages concurrently
 * as they finish. The pause is released in a `finally`, and only when this process is what paused
 * it -- `GET /api/jobs` is read first, so a queue a human paused stays paused.
 * `--pause-queue=false` submits without touching the pause gate.
 *
 * One caveat the caller has to know: with `--inject-context` the chapter stops being parallel. A
 * page whose chapter injects previous-page context is held until every earlier page's
 * panel-detection/ocr/layout/translation job has left PENDING/PROCESSING (dispatcher.rs:195-214),
 * so a 200-page chapter with context on is one long serial chain. The default is off, and the run
 * says so loudly when it is turned on with more than one page.
 *
 * Usage:
 *   node scripts/playwright/corpus_batch.cjs \
 *     --base http://192.168.0.108:18091/tlhub --lang ja --limit 200 \
 *     --series-title "Corpus Batch ja" --chapter-title corpus-upload \
 *     --ocr-provider local --ocr-model PP-OCRv6 \
 *     --tl-provider openrouter --tl-model <model> --qa-mode auto
 *
 *   # a named subset, resuming an interrupted run into the same output directory
 *   node scripts/playwright/corpus_batch.cjs --file-list ja-200.txt \
 *     --out docs/quality-runs/corpus-batch-ja --resume
 *
 * Requires: npm i -D playwright && npx playwright install chromium
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** `jobs.status` values that mean the job has not finished; anything else is terminal. */
const ACTIVE_JOB_STATUSES = new Set(["PENDING", "PROCESSING", "PAUSED"]);
/** GET /api/chapters/{id}/pages clamps `size` to 1..=100 (routes/page.rs:671), so page through. */
const PAGE_LIST_SIZE = 100;
const VIEWPORT = { width: 1600, height: 1000 };
const PNG_DOWNLOAD_TIMEOUT_MS = 120_000;
const ZIP_DOWNLOAD_TIMEOUT_MS = 240_000;
const READER_TIMEOUT_MS = 90_000;
const SIDEBAR_KEYS = ["manga_show_left_sidebar", "manga_show_right_sidebar"];

/**
 * Reader export labels, current spelling first. The right sidebar's page-actions section says
 * "Export PNG"/"Export ZIP" (components/ReaderRightSidebar.tsx:1149,1159); the older reader used
 * "Export Page (PNG)"/"Export Project (ZIP)", which scripts/playwright/export_pending.cjs still
 * matches. Both are tried so this also works against an older build.
 */
const EXPORT_PNG_LABELS = ["Export PNG", "Export Page (PNG)"];
const EXPORT_ZIP_LABELS = ["Export ZIP", "Export Project (ZIP)"];

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

const MODEL_KEYS = [
  ["ocrProvider", "--ocr-provider"],
  ["ocrModel", "--ocr-model"],
  ["cleanupMode", "--cleanup-mode"],
  ["tlProvider", "--tl-provider"],
  ["tlModel", "--tl-model"],
  ["qaProvider", "--qa-provider"],
  ["qaMode", "--qa-mode"],
  ["qaLlmModel", "--qa-llm-model"],
  ["qaVlmModel", "--qa-vlm-model"],
  ["routingStrategy", "--routing-strategy"],
];

function parseBool(v) {
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  throw new Error(`expected a boolean, got: ${v}`);
}

function parseArgs(argv) {
  const a = {
    base: process.env.TLHUB_BASE || "http://localhost:8080/tlhub",
    email: process.env.TLHUB_EMAIL || "",
    password: process.env.TLHUB_PASSWORD || "",
    displayName: process.env.TLHUB_DISPLAY_NAME || "",
    corpusRoot: process.env.TLHUB_CORPUS_ROOT || path.join(REPO_ROOT, "corpus"),
    sampleRoots: [],
    fileList: "",
    lang: "ja",
    limit: 0,
    offset: 0,
    order: "natural",
    seriesId: "",
    seriesTitle: "",
    chapterId: "",
    chapterTitle: "corpus-upload",
    append: false,
    targetLanguage: "en",
    readingDirection: "",
    models: {
      ocrProvider: "",
      ocrModel: "",
      ocrMergeThreshold: null,
      cleanupMode: "",
      tlProvider: "",
      tlModel: "",
      qaProvider: "",
      qaMode: "",
      qaLlmModel: "",
      qaVlmModel: "",
      routingStrategy: "",
      useFallbackModels: null,
    },
    injectContext: false,
    out: "",
    // 1, not more: uploading into ONE chapter is not safe to parallelise (see the note at the
    // submission site). Uploads were never the bottleneck anyway — the pipeline is.
    submitConcurrency: 1,
    captureConcurrency: 2,
    pollIntervalSec: 10,
    pageTimeoutSec: 3600,
    settleMs: 1500,
    renderPng: true,
    exportPng: true,
    projectZip: true,
    screenshot: true,
    chapterZip: false,
    deletePages: false,
    resume: false,
    pauseQueue: true,
    headed: false,
    dryRun: false,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    let v = argv[i];
    // `--flag=value` and `--flag value` mean the same (the docs use --pause-queue=false).
    let inline;
    const eq = v.startsWith("--") ? v.indexOf("=") : -1;
    if (eq > 0) {
      inline = v.slice(eq + 1);
      v = v.slice(0, eq);
    }
    const next = () => (inline !== undefined ? inline : argv[++i]);
    const model = MODEL_KEYS.find(([, flag]) => flag === v);
    if (model) {
      a.models[model[0]] = next();
      continue;
    }
    switch (v) {
      case "--base": a.base = next(); break;
      case "--email": a.email = next(); break;
      case "--password": a.password = next(); break;
      case "--display-name": a.displayName = next(); break;
      case "--corpus-root": a.corpusRoot = next(); break;
      case "--sample-root": a.sampleRoots.push(next()); break;
      case "--file-list": a.fileList = next(); break;
      case "--lang": a.lang = next(); break;
      case "--limit": a.limit = Number(next()); break;
      case "--offset": a.offset = Number(next()); break;
      case "--order": a.order = next(); break;
      case "--series-id": a.seriesId = next(); break;
      case "--series-title": a.seriesTitle = next(); break;
      case "--chapter-id": a.chapterId = next(); break;
      case "--chapter-title": a.chapterTitle = next(); break;
      case "--chapter-number": a.chapterNumber = Number(next()); break;
      case "--target-language": a.targetLanguage = next(); break;
      case "--reading-direction": a.readingDirection = next(); break;
      case "--ocr-merge-threshold": a.models.ocrMergeThreshold = Number(next()); break;
      case "--fallback-models": a.models.useFallbackModels = parseBool(next()); break;
      case "--inject-context": a.injectContext = true; break;
      case "--no-inject-context": a.injectContext = false; break;
      case "--out": a.out = next(); break;
      case "--submit-concurrency": a.submitConcurrency = Number(next()); break;
      case "--capture-concurrency": a.captureConcurrency = Number(next()); break;
      case "--poll-interval": a.pollIntervalSec = Number(next()); break;
      case "--page-timeout": a.pageTimeoutSec = Number(next()); break;
      case "--settle-ms": a.settleMs = Number(next()); break;
      case "--no-render-png": a.renderPng = false; break;
      case "--no-export-png": a.exportPng = false; break;
      case "--no-project-zip": a.projectZip = false; break;
      case "--no-screenshot": a.screenshot = false; break;
      case "--chapter-zip": a.chapterZip = true; break;
      case "--delete-pages": a.deletePages = true; break;
      case "--resume": a.resume = true; break;
      case "--pause-queue": a.pauseQueue = parseBool(next()); break;
      case "--headed": a.headed = true; break;
      case "--append": a.append = true; break;
      case "--dry-run": a.dryRun = true; break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`unknown arg: ${v}`);
    }
  }
  if (!a.seriesTitle) a.seriesTitle = `Corpus Batch (${a.lang})`;
  if (!a.readingDirection) {
    // readingDirection lives on the SERIES, so it follows the corpus language rather than the
    // page: Japanese manga reads right-to-left, Korean manhwa and Chinese manhua left-to-right.
    a.readingDirection = a.lang === "ja" ? "rightToLeft" : "leftToRight";
  }
  return a;
}

function loadChromium() {
  try { return require("playwright").chromium; }
  catch {
    console.error("playwright not installed:\n  npm i -D playwright && npx playwright install chromium");
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------------------------
// Sample discovery
// ---------------------------------------------------------------------------------------------

/** `sample2` before `sample10`, not after it: the flat lexicographic order corpus/scripts/pair_index.json uses. */
function naturalKey(value) {
  return String(value)
    .toLowerCase()
    .split(/(\d+)/)
    .map((part, i) => (i % 2 ? Number(part) : part));
}

function compareNatural(a, b) {
  const ka = naturalKey(a);
  const kb = naturalKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const x = ka[i];
    const y = kb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
    } else if (String(x) !== String(y)) {
      return String(x) < String(y) ? -1 : 1;
    }
  }
  return 0;
}

function readSampleDir(dir, lang) {
  const metaPath = path.join(dir, "meta.json");
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8")) : {};
  const declared = meta.source?.file
    || ["source.jpg", "source.jpeg", "source.png", "source.webp"].find((f) => fs.existsSync(path.join(dir, f)));
  if (!declared) {
    throw new Error(`${dir}: no source image (meta.source.file unset and no source.* on disk)`);
  }
  const imagePath = path.join(dir, declared);
  if (!fs.existsSync(imagePath)) throw new Error(`${dir}: source image ${declared} is missing`);
  const sampleLang = String(meta.language || meta.source?.lang || path.basename(path.dirname(dir))).toLowerCase();
  if (lang && sampleLang && sampleLang !== lang.toLowerCase()) return null;
  return {
    sampleId: String(meta.sample_id || path.basename(dir)),
    dir,
    imagePath,
    sourceFile: declared,
    lang: sampleLang,
  };
}

function readFileList(file) {
  if (!fs.existsSync(file)) throw new Error(`--file-list not found: ${file}`);
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => path.resolve(line));
}

/**
 * One entry per page to submit. `--file-list` entries come first in file order, then each
 * `--sample-root` in argument order; inside a root the sample ids sort naturally. A root that is
 * itself a sample directory (it has a meta.json) contributes one sample, and a root that is a
 * loose image file contributes that image.
 */
function discoverSamples(args) {
  const roots = args.fileList ? readFileList(args.fileList) : [];
  if (args.sampleRoots.length) {
    roots.push(...args.sampleRoots);
  } else if (!args.fileList) {
    // No explicit selection at all: fall back to the two corpus roots that hold <lang> samples.
    // A --file-list on its own IS the whole selection -- otherwise naming two samples in a list
    // would silently also submit all 263 of them.
    roots.push(path.join(args.corpusRoot, "samples", args.lang));
    roots.push(path.join(args.corpusRoot, "gaps", "pending", args.lang));
  }

  const samples = [];
  const skipped = [];
  for (const root of roots) {
    const abs = path.resolve(root);
    if (!fs.existsSync(abs)) {
      skipped.push(`${abs} (does not exist)`);
      continue;
    }
    if (fs.statSync(abs).isFile()) {
      samples.push({
        sampleId: path.basename(abs).replace(/\.[^.]+$/, ""),
        dir: path.dirname(abs),
        imagePath: abs,
        sourceFile: path.basename(abs),
        lang: args.lang,
      });
      continue;
    }
    if (fs.existsSync(path.join(abs, "meta.json"))) {
      const one = readSampleDir(abs, args.lang);
      if (one) samples.push(one);
      continue;
    }
    const names = fs.readdirSync(abs).filter((n) => !n.startsWith("_") && !n.startsWith("."));
    names.sort(args.order === "lex" ? undefined : (a, b) => compareNatural(a, b));
    for (const name of names) {
      const dir = path.join(abs, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      if (!fs.existsSync(path.join(dir, "meta.json"))) {
        skipped.push(`${dir} (no meta.json)`);
        continue;
      }
      const one = readSampleDir(dir, args.lang);
      if (one) samples.push(one);
      else skipped.push(`${dir} (language is not ${args.lang})`);
    }
  }

  const start = Math.max(0, args.offset | 0);
  const end = args.limit > 0 ? start + args.limit : undefined;
  return { selected: samples.slice(start, end), total: samples.length, skipped };
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

/**
 * All API traffic rides the browser context's request object, so it carries the session cookies
 * the reader uses. `token` is the JWT from login, kept for the Bearer header because the API
 * accepts either.
 */
function apiGet(ctx, urlPath) {
  return ctx.page.request.get(`${ctx.base}${urlPath}`, {
    headers: { Authorization: `Bearer ${ctx.token}` },
  });
}

async function apiJson(ctx, urlPath) {
  const res = await apiGet(ctx, urlPath);
  if (!res.ok()) throw new Error(`GET ${urlPath} -> ${res.status()} ${await res.text().catch(() => "")}`);
  return res.json().catch(() => ({}));
}

async function apiSend(ctx, method, urlPath, data) {
  const res = await ctx.page.request[method](`${ctx.base}${urlPath}`, {
    headers: { Authorization: `Bearer ${ctx.token}` },
    data,
  });
  if (!res.ok()) {
    throw new Error(`${method.toUpperCase()} ${urlPath} -> ${res.status()} ${await res.text().catch(() => "")}`);
  }
  return res.json().catch(() => ({}));
}

/** The list endpoints answer with a PagedResponse on the Rust backend and a bare array on the Java one. */
function unwrapList(payload) {
  if (Array.isArray(payload)) return payload;
  return payload.content || payload.series || payload.chapters || [];
}

async function ensureToken(ctx, args) {
  if (args.email && args.password) {
    const res = await ctx.page.request.post(`${args.base}/api/auth/login`, {
      data: { email: args.email, password: args.password },
    });
    if (!res.ok()) {
      throw new Error(
        `login failed ${res.status()} ${await res.text().catch(() => "")}\n` +
        "  These came from --email/--password or TLHUB_EMAIL/TLHUB_PASSWORD. Drop both to\n" +
        "  register a throwaway account instead.",
      );
    }
    const body = await res.json();
    ctx.adoptSession(body, `logged in as ${body.email} (${body.role})`);
    return ctx.token;
  }

  // No credentials: register a throwaway TRANSLATOR. role must be explicit -- omitting it (or
  // asking for admin) is rejected unless this registration is the very first user on the instance.
  const stamp = crypto.randomBytes(4).toString("hex");
  const email = `corpus-batch-${stamp}@example.invalid`;
  const password = crypto.randomBytes(9).toString("base64url");
  const displayName = args.displayName || `Corpus Batch ${stamp}`;
  const res = await ctx.page.request.post(`${args.base}/api/auth/register`, {
    data: { email, password, displayName, role: "translator" },
  });
  if (!res.ok()) {
    throw new Error(
      `throwaway registration failed ${res.status()} ${await res.text().catch(() => "")}\n` +
      "  Pass --email/--password to use an existing account.",
    );
  }
  const body = await res.json();
  ctx.adoptSession(body, `registered throwaway account ${body.email} (${body.role})`);
  // The password goes to a file only its owner can read, never to the log (CodeQL on #232).
  const saved = path.join(ctx.outRoot, "throwaway-account.json");
  // Tightened before the password is written: `mode` applies only to a new file, and one left by an
  // earlier run may be readable by others.
  const fd = fs.openSync(saved, "w", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, `${JSON.stringify({ email, password }, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  console.log(`  kept for this run: --email ${email} (password in ${saved})`);
  return ctx.token;
}

/**
 * Seed localStorage before any app script runs, so every tab this browser opens is already signed
 * in and already in the view state the screenshot wants. `manga_user` holds exactly what the login
 * form stores (components/Auth.tsx:78 stores the whole response), so seeding it from the API
 * response is equivalent to logging in through the UI -- and it is what makes a throwaway
 * registration usable by the reader at all. `manga_clean_view` is a plain unserialised string
 * (hooks/usePersistedState.ts). Both sidebars default to shown, but an earlier run against the
 * same origin could have hidden them.
 */
async function seedReaderStorage(page, ctx) {
  await page.addInitScript(
    ({ user, cleanView, sidebarKeys }) => {
      try {
        localStorage.setItem("manga_user", user);
        localStorage.setItem("manga_clean_view", cleanView ? "true" : "false");
        for (const key of sidebarKeys) localStorage.setItem(key, "true");
      } catch {
        /* a storage-denied origin just falls through to the app's own login redirect */
      }
    },
    { user: ctx.storedUser, cleanView: ctx.cleanView, sidebarKeys: SIDEBAR_KEYS },
  );
}

/**
 * What a chapter already holds: `highest` is the number --append continues from, `count` is what
 * the guard refuses on. Filenames are deliberately not compared -- every corpus sample names its
 * page source.*, so a filename match says nothing about which sample it is.
 */
async function chapterPageState(ctx, chapterId) {
  const body = await apiJson(
    ctx,
    `/api/chapters/${chapterId}/pages?size=${PAGE_LIST_SIZE}&page=0&sort=pageNumber,desc`,
  );
  const content = body.content || [];
  return {
    count: Number(body.totalElements ?? content.length),
    highest: content.reduce((max, p) => Math.max(max, Number(p.pageNumber) || 0), 0),
  };
}

// ---------------------------------------------------------------------------------------------
// Series and chapter
// ---------------------------------------------------------------------------------------------

/** Only the overrides the caller actually set; anything else is null so the chapter inherits. */
function overridePayload(models) {
  const payload = {};
  for (const [key] of MODEL_KEYS) payload[key] = models[key] || null;
  payload.ocrMergeThreshold = Number.isFinite(models.ocrMergeThreshold) ? models.ocrMergeThreshold : null;
  payload.useFallbackModels =
    typeof models.useFallbackModels === "boolean" ? models.useFallbackModels : null;
  return payload;
}

function describeOverrides(models) {
  const set = Object.entries(overridePayload(models)).filter(([, v]) => v !== null);
  return set.length ? set.map(([k, v]) => `${k}=${v}`).join(" ") : "(all inherited)";
}

async function ensureSeries(ctx, args) {
  if (args.seriesId) return args.seriesId;
  const existing = unwrapList(await apiJson(ctx, "/api/series?size=200"));
  const match = existing.find((s) => s.title === args.seriesTitle);
  if (match) {
    const id = match.id || match.seriesId;
    console.log(`reusing series "${args.seriesTitle}" (${id}) [direction=${match.readingDirection}]`);
    return id;
  }
  const body = await apiSend(ctx, "post", "/api/series", {
    title: args.seriesTitle,
    originalLanguage: args.lang,
    sourceLanguage: args.lang,
    targetLanguage: args.targetLanguage,
    readingDirection: args.readingDirection,
    ...overridePayload(args.models),
  });
  const id = body.id || body.seriesId;
  console.log(`created series "${args.seriesTitle}" (${id}) [direction=${args.readingDirection}]`);
  return id;
}

async function ensureChapter(ctx, args, seriesId) {
  if (args.chapterId) return args.chapterId;

  const listChapters = async () =>
    unwrapList(await apiJson(ctx, `/api/series/${seriesId}/chapters?size=200`));

  const existing = await listChapters();
  const match = existing.find((c) => c.title === args.chapterTitle);
  if (match) {
    const id = match.id || match.chapterId;
    console.log(`reusing chapter "${args.chapterTitle}" (${id})`);
    // Reuse means the pipeline runs with whatever overrides that chapter already carries, so say
    // what those are. PUT only writes the keys it is given, which is how a null means "inherit"
    // rather than "clear" (routes/series.rs:893-913).
    const wanted = overridePayload(args.models);
    const drift = Object.keys(wanted)
      .filter((k) => wanted[k] !== null && (match[k] ?? null) !== wanted[k])
      .map((k) => `${k}: chapter has ${match[k] ?? "(unset)"}, run asked for ${wanted[k]}`);
    if (drift.length) {
      console.warn(`  the reused chapter's overrides differ from this run:\n    ${drift.join("\n    ")}`);
    }
    if (args.injectContext !== !!match.useContextMemory || drift.length) {
      await apiSend(ctx, "put", `/api/series/chapters/${id}`, {
        ...wanted,
        useContextMemory: args.injectContext ? true : null,
      });
      console.log(`  applied to the reused chapter: ${describeOverrides(args.models)}, context=${args.injectContext}`);
    }
    return id;
  }

  // chapterNumber has to be free, not just 1: the backend rejects a duplicate number inside a
  // series with 409, and a series that already holds a chapter from an earlier run is the normal
  // case here.
  const used = new Set(existing.map((c) => Number(c.chapterNumber)).filter(Number.isFinite));
  let chapterNumber = args.chapterNumber > 0 ? args.chapterNumber : 1;
  if (args.chapterNumber <= 0) while (used.has(chapterNumber)) chapterNumber++;

  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const body = await apiSend(ctx, "post", `/api/series/${seriesId}/chapters`, {
        title: args.chapterTitle,
        chapterNumber,
        useContextMemory: args.injectContext,
        ...overridePayload(args.models),
      });
      const id = body.id || body.chapterId;
      console.log(
        `created chapter "${args.chapterTitle}" (${id}) [number=${chapterNumber}, ` +
        `${describeOverrides(args.models)}, context=${args.injectContext}]`,
      );
      return id;
    } catch (e) {
      // 409 means the number was taken between the list and the create. It may also mean a
      // concurrent run created OUR title, in which case reuse theirs rather than fighting.
      if (!/-> 409\b/.test(e.message)) throw e;
      lastError = e.message;
      const raced = (await listChapters()).find((c) => c.title === args.chapterTitle);
      if (raced) {
        const id = raced.id || raced.chapterId;
        console.log(`reusing chapter "${args.chapterTitle}" (${id}) [created concurrently]`);
        return id;
      }
      chapterNumber++;
    }
  }
  throw new Error(
    `no free chapter number for "${args.chapterTitle}" after 8 attempts ` +
    `(existing: ${[...used].sort((a, b) => a - b).join(", ") || "none"}; last failure: ${lastError})`,
  );
}

// ---------------------------------------------------------------------------------------------
// Queue control
// ---------------------------------------------------------------------------------------------

async function readQueue(ctx) {
  const body = await apiJson(ctx, "/api/jobs");
  return { isPaused: !!body.isPaused, jobs: body.jobs || [] };
}

async function setQueuePaused(ctx, paused) {
  const res = await ctx.page.request.post(`${ctx.base}/api/jobs/${paused ? "pause" : "resume"}`, {
    headers: { Authorization: `Bearer ${ctx.token}` },
  });
  if (!res.ok()) {
    throw new Error(`queue ${paused ? "pause" : "resume"} -> ${res.status()} ${await res.text().catch(() => "")}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------------------------

async function uploadPage(ctx, chapterId, entry) {
  const buf = fs.readFileSync(entry.sample.imagePath);
  const ext = path.extname(entry.sample.imagePath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const res = await ctx.page.request.post(`${ctx.base}/api/images`, {
    headers: { Authorization: `Bearer ${ctx.token}` },
    multipart: {
      chapterId: String(chapterId),
      pageNumber: String(entry.pageNumber),
      file: { name: entry.sample.sourceFile, mimeType, buffer: buf },
    },
  });
  if (!res.ok()) {
    const body = await res.text().catch(() => "");
    if (res.status() === 500) {
      // Possibly the concurrent-upload race (it is not the only cause: a failed store upload is
      // also a 500, so the body is kept). `insert_page` reads
      // MAX(page_number)+1, clamps the requested number into that range, and only then inserts,
      // with no lock between the read and the insert (routes/page.rs:330-348). Two uploads into
      // one chapter at once can therefore pick the same slot, and the losing INSERT trips the
      // (chapter_id, page_number) unique constraint on a `.expect(...)` -- which the catch-panic
      // layer turns into this 500 with instance "/unknown". The service needs a fix; the fix on
      // this side is --submit-concurrency 1, which is the default.
      throw new Error(
        `upload failed 500 ${body}\n` +
        `  requested page ${entry.pageNumber} into chapter ${chapterId}.\n` +
        `  If uploads overlapped (--submit-concurrency > 1), this may be the page-slot race --\n` +
        `  re-run with --submit-concurrency 1 (the default), or --resume to harvest what did land.`,
      );
    }
    throw new Error(`upload failed ${res.status()} ${body}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!body.pageId) throw new Error(`upload returned no pageId (status=${body.status})`);
  entry.sourceSha256 = crypto.createHash("sha256").update(buf).digest("hex");
  entry.pageId = body.pageId;
  entry.imageId = body.imageId;
  entry.uploadStatus = body.status;
  entry.submittedAt = new Date().toISOString();
  return body;
}

/**
 * `width` independent workers, each with its own browser tab where one is needed. Sharing a single
 * tab would serialise nothing useful: two captures navigating and downloading through the same
 * page race each other's `waitForEvent("download")` and can screenshot the wrong page.
 */
async function runQueue(items, width, workerFactory) {
  const queue = items.slice();
  let cursor = 0;
  const lanes = Math.max(1, Math.min(width || 1, queue.length || 1));
  const runners = Array.from({ length: lanes }, async (_, i) => {
    const worker = await workerFactory(i);
    try {
      while (cursor < queue.length) await worker(queue[cursor++]);
    } finally {
      if (worker.close) await worker.close();
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------------------------
// Harvest
// ---------------------------------------------------------------------------------------------

/**
 * One request per poll tick for the whole chapter rather than one per page: `list_pages` already
 * reports renderStatus ("ready" once the immutable artifact for the current scene revision exists,
 * routes/page.rs:728-734), so N pages cost one paginated read instead of N.
 */
async function fetchChapterPages(ctx, chapterId) {
  const byPageNumber = new Map();
  for (let page = 0; ; page++) {
    const body = await apiJson(
      ctx,
      `/api/chapters/${chapterId}/pages?size=${PAGE_LIST_SIZE}&page=${page}&sort=pageNumber,asc`,
    );
    const content = body.content || [];
    for (const p of content) byPageNumber.set(Number(p.pageNumber), p);
    if (!content.length || page + 1 >= Number(body.totalPages || 0)) break;
  }
  return byPageNumber;
}

/**
 * Terminal for a page is decided here, and nowhere else.
 *
 * This data model has no page-level or chapter-level processing status -- all liveness lives in
 * `jobs`, with `page_render_jobs` as the render ledger -- so a page is finished when its render
 * artifact exists AND none of its jobs is still PENDING/PROCESSING/PAUSED. A FAILED job with
 * nothing still in flight is terminal too, but it is a distinct outcome: such a page usually still
 * has a render worth keeping, so it is captured and marked failed rather than thrown away.
 */
function terminalState(entry, jobsByPage, now) {
  const jobs = jobsByPage.get(entry.pageId) || [];
  const live = jobs.filter((j) => ACTIVE_JOB_STATUSES.has(j.status));
  const failed = jobs.filter((j) => j.status === "FAILED");
  const info = entry.serverInfo || {};
  const ready = info.renderStatus === "ready";
  const renderFailed = info.renderStatus === "failed";
  const submitted = Date.parse(entry.submittedAt || "") || now;

  if (live.length === 0 && (ready || failed.length > 0 || renderFailed)) {
    if (!failed.length && !renderFailed) return { state: "done" };
    const detail = failed.length
      ? failed.map((j) => `${j.type}: ${j.error || "(no error recorded)"}`).join("; ")
      : "the final render job failed";
    return { state: ready ? "failed-with-output" : "failed", error: detail };
  }
  if (now - submitted > entry.timeoutMs) {
    return {
      state: "timeout",
      error: `${live.map((j) => j.type).join(", ") || "nothing"} still running after ${Math.round(entry.timeoutMs / 1000)}s`,
    };
  }
  return { state: "pending", live: live.map((j) => `${j.type}:${j.status}`) };
}

async function poller(ctx, chapterId, entries, wake, opts) {
  const byPageNumber = new Map();
  const jobsByPage = new Map();
  const deadline = Date.now() + opts.globalTimeoutMs;

  for (;;) {
    try {
      for (const [n, info] of await fetchChapterPages(ctx, chapterId)) byPageNumber.set(n, info);
      const queue = await readQueue(ctx);
      jobsByPage.clear();
      for (const job of queue.jobs) {
        if (!job.pageId) continue;
        const key = String(job.pageId);
        if (!jobsByPage.has(key)) jobsByPage.set(key, []);
        jobsByPage.get(key).push(job);
      }

      const now = Date.now();
      for (const entry of entries) {
        if (entry.terminal) continue;
        entry.serverInfo = byPageNumber.get(entry.pageNumber) || entry.serverInfo;
        const verdict = terminalState(entry, jobsByPage, now);
        entry.state = verdict.state;
        entry.liveJobs = verdict.live || [];
        if (verdict.error) entry.error = verdict.error;
        if (verdict.state !== "pending") {
          entry.terminal = true;
          entry.finishedAt = new Date().toISOString();
          wake(entry);
        }
      }
    } catch (e) {
      // A failed poll (first tick or any later one) is retried at the next interval; only the
      // entries themselves say when there is nothing left to wait for. Returning on a failed tick
      // would leave every capture worker on a promise that is never resolved.
      opts.onError(e);
    }

    if (entries.every((entry) => entry.terminal)) return;
    if (Date.now() > deadline) {
      for (const entry of entries) {
        if (entry.terminal) continue;
        entry.terminal = true;
        entry.state = "timeout";
        entry.error = entry.error || `global harvest timeout after ${Math.round(opts.globalTimeoutMs / 1000)}s`;
        entry.finishedAt = new Date().toISOString();
        wake(entry);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
  }
}

async function waitForTerminal(entry, registry) {
  if (entry.terminal) return;
  await new Promise((resolve) => registry.push({ entry, resolve }));
}

// ---------------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------------

async function firstVisibleButton(page, labels, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const label of labels) {
      const button = page.getByRole("button", { name: label, exact: true }).first();
      if (await button.isVisible().catch(() => false)) return button;
    }
    if (Date.now() > deadline) {
      throw new Error(`no visible button matching ${labels.join(" / ")} after ${Math.round(timeoutMs / 1000)}s`);
    }
    await page.waitForTimeout(400);
  }
}

/** The export can raise a confirm modal whose escape is "Export Anyway"; click it if it appears. */
async function dismissExportConfirm(page) {
  const button = page.getByRole("button", { name: "Export Anyway", exact: true }).first();
  try {
    await button.waitFor({ state: "visible", timeout: 5000 });
    await button.click({ timeout: 5000 }).catch(() => {});
  } catch {
    /* no modal: nothing to dismiss */
  }
}

async function clickAndDownload(page, labels, dest, timeoutMs) {
  const button = await firstVisibleButton(page, labels, 60_000);
  const confirm = dismissExportConfirm(page);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: timeoutMs }),
    button.click(),
  ]);
  await download.saveAs(dest);
  await confirm;
}

async function waitForReader(page) {
  await page.waitForSelector('img[src*="/api/images/"]', { timeout: READER_TIMEOUT_MS });
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
}

/**
 * Clean scanlation is a *view* setting, not a processing one: it hides the OCR boxes and their
 * backdrops on screen (components/Reader.tsx:4540-4546). The exports deliberately ignore it --
 * EXPORTABLE_LAYER_TYPES is translation/sfx/mask regardless of the toggle (Reader.tsx:224-243) --
 * so turning it on costs nothing and all three artifacts stay consistent with each other.
 */
async function ensureCleanScanlation(page) {
  const toggle = page.getByLabel(/Clean scanlation/i).first();
  try {
    await toggle.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    return false;
  }
  if (!(await toggle.isChecked().catch(() => false))) {
    await toggle.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  return toggle.isChecked().catch(() => false);
}

async function fetchRendered(ctx, pageId, dest) {
  const res = await apiGet(ctx, `/api/pages/${pageId}/rendered`);
  if (!res.ok()) throw new Error(`GET /api/pages/${pageId}/rendered -> ${res.status()}`);
  const body = await res.body();
  if (body.length < 8) throw new Error("the rendered response was empty");
  fs.writeFileSync(dest, body);
  return body.length;
}

async function capturePage(ctx, args, chapterId, entry, outDir, page) {
  fs.mkdirSync(outDir, { recursive: true });
  entry.artifacts = entry.artifacts || {};

  const snapshot = await apiJson(ctx, `/api/pages/${entry.pageId}`);
  fs.writeFileSync(path.join(outDir, "page.json"), JSON.stringify(snapshot, null, 2));
  const layers = Array.isArray(snapshot.layers) ? snapshot.layers : [];
  const countElements = (type) =>
    layers
      .filter((l) => (l.layer?.type || l.type) === type)
      .reduce((n, l) => n + (Array.isArray(l.elements) ? l.elements.length : 0), 0);
  entry.elements = {
    ocr: countElements("ocr"),
    translation: countElements("translation"),
    inpainting: countElements("inpainting"),
    ocrRegions: Array.isArray(snapshot.ocrRegions) ? snapshot.ocrRegions.length : 0,
  };

  if (args.renderPng) {
    try {
      const bytes = await fetchRendered(ctx, entry.pageId, path.join(outDir, "render.png"));
      entry.artifacts.renderPng = "render.png";
      entry.artifacts.renderPngBytes = bytes;
    } catch (e) {
      entry.warnings = entry.warnings || [];
      entry.warnings.push(`render.png: ${e.message}`);
    }
  }

  if (!(args.exportPng || args.projectZip || args.screenshot)) return;

  await page.goto(`${args.base}/chapters/${chapterId}/reader/${entry.pageNumber}`, {
    waitUntil: "domcontentloaded",
    timeout: READER_TIMEOUT_MS,
  });
  await waitForReader(page);

  if (args.screenshot) {
    const clean = await ensureCleanScanlation(page);
    entry.cleanScanlation = clean;
    if (!clean) {
      entry.warnings = entry.warnings || [];
      entry.warnings.push("clean scanlation toggle not found; the screenshot may show OCR boxes");
    }
    if (args.settleMs > 0) await page.waitForTimeout(args.settleMs);
    await page.screenshot({ path: path.join(outDir, "editor.png") });
    entry.artifacts.editorPng = "editor.png";
  }

  if (args.exportPng) {
    await clickAndDownload(page, EXPORT_PNG_LABELS, path.join(outDir, "export.png"), PNG_DOWNLOAD_TIMEOUT_MS);
    entry.artifacts.exportPng = "export.png";
  }

  if (args.projectZip) {
    const zipPath = path.join(outDir, "project.zip");
    await clickAndDownload(page, EXPORT_ZIP_LABELS, zipPath, ZIP_DOWNLOAD_TIMEOUT_MS);
    entry.artifacts.projectZip = "project.zip";
    try {
      execFileSync("unzip", ["-o", zipPath, "-d", path.join(outDir, "project")], { stdio: "ignore" });
      entry.artifacts.project = "project/";
    } catch (e) {
      entry.warnings = entry.warnings || [];
      entry.warnings.push(`project.zip unpack failed: ${e.message}`);
    }
  }
}

/**
 * The backend builds the chapter ZIP in the background and announces it over SSE; the frontend
 * then downloads /api/series/chapters/exports/{exportId}/download. Rather than hold an SSE
 * connection open through the browser, the same ticket handshake the frontend uses is done here
 * in Node: POST /api/notifications/ticket, read the stream, take the exportId off the
 * announcement.
 */
async function captureChapterZip(ctx, chapterId, outDir) {
  const ticketRes = await ctx.page.request.post(`${ctx.base}/api/notifications/ticket`, {
    headers: { Authorization: `Bearer ${ctx.token}` },
  });
  if (!ticketRes.ok()) {
    throw new Error(`ticket -> ${ticketRes.status()} ${await ticketRes.text().catch(() => "")}`);
  }
  const { ticket } = await ticketRes.json();

  const controller = new AbortController();
  const announced = (async () => {
    const res = await fetch(`${ctx.base}/api/notifications/stream?ticket=${encodeURIComponent(ticket)}`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        const mine = payload.chapterId === chapterId || payload.context?.chapterId === chapterId;
        if (payload.exportId && (mine || payload.type === "chapter_export_ready")) return payload.exportId;
      }
    }
  })();

  const kick = await ctx.page.request.get(
    `${ctx.base}/api/series/chapters/${chapterId}/export?format=zip&force=true`,
    { headers: { Authorization: `Bearer ${ctx.token}` } },
  );
  if (!kick.ok()) {
    controller.abort();
    throw new Error(`chapter export -> ${kick.status()} ${await kick.text().catch(() => "")}`);
  }

  try {
    const exportId = await Promise.race([
      announced,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("no export announcement within 15 minutes")), 900_000)),
    ]);
    if (!exportId) throw new Error("the notification stream closed before the export was announced");
    const res = await apiGet(ctx, `/api/series/chapters/exports/${exportId}/download`);
    if (!res.ok()) throw new Error(`chapter export download -> ${res.status()}`);
    const dest = path.join(outDir, "chapter.zip");
    fs.writeFileSync(dest, await res.body());
    return dest;
  } finally {
    controller.abort();
  }
}

// ---------------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------------

function runId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
}

function pageDirName(pageNumber, sampleId) {
  return `${String(pageNumber).padStart(3, "0")}-${sampleId}`;
}

function writeManifest(manifestPath, manifest) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function summarise(manifest) {
  const counts = {};
  for (const page of manifest.pages) counts[page.state] = (counts[page.state] || 0) + 1;
  return counts;
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

const USAGE = `
corpus_batch.cjs — submit corpus samples to a tl-hub instance as one chapter, then harvest results

Usage:
  node scripts/playwright/corpus_batch.cjs \\
    --base http://192.168.0.108:18091/tlhub --lang ja --limit 200 \\
    --series-title "Corpus Batch ja" --chapter-title corpus-upload \\
    --ocr-provider local --ocr-model PP-OCRv6 --tl-provider openrouter --tl-model <model>

Selection — file list first in file order, then sample roots in argument order
  --file-list <txt>        one sample dir or image path per line; '#' comments allowed
  --sample-root <dir>      repeatable; a sample dir, a dir of sample dirs, or one image
  --corpus-root <dir>      corpus tree root [./corpus]
  --lang <code>            keep only samples whose meta.json language matches [ja]
  --limit <n>              first n after --offset [all]
  --offset <n>             skip the first n [0]
  --order <natural|lex>    sample-id sort inside a root; 'lex' matches corpus/scripts/pair_index.json [natural]

Target
  --base <url>             instance base URL [http://localhost:8080/tlhub] [TLHUB_BASE]
  --email / --password     account to use [TLHUB_EMAIL / TLHUB_PASSWORD]. Omit BOTH and the run
                           registers its own throwaway TRANSLATOR and prints the credentials.
  --display-name <name>    display name for that throwaway account
  --series-id <uuid>       use this series instead of finding/creating one by title
  --series-title <title>   [Corpus Batch (<lang>)]
  --chapter-id <uuid>      use this chapter instead of finding/creating one by title
  --chapter-title <title>  [corpus-upload]
  --chapter-number <n>     [next free number in the series]
  --target-language <code> [en]
  --reading-direction <d>  [rightToLeft for ja, leftToRight otherwise]

Chapter model overrides — unset means inherit, matching the dialog's "N inherited"
  --ocr-provider --ocr-model --ocr-merge-threshold --cleanup-mode
  --tl-provider --tl-model
  --qa-provider --qa-mode --qa-llm-model --qa-vlm-model
  --routing-strategy --fallback-models <true|false>
  --inject-context         Inject Context Memory. Serialises the whole chapter: a page waits for
                           every earlier page's ocr/layout/translation to finish.

Harvest
  --out <dir>              output root [docs/quality-runs/corpus-batch-<ts>]
  --submit-concurrency <n> parallel uploads [4]
  --capture-concurrency <n> pages captured at once, one browser tab each [2]
  --poll-interval <sec>    liveness poll interval [10]
  --page-timeout <sec>     give up on one page after this long [3600]
  --settle-ms <n>          extra wait after the reader settles [1500]
  --no-render-png          skip GET /api/pages/{id}/rendered
  --no-export-png          skip the reader's Export PNG
  --no-project-zip         skip the reader's Export ZIP and its unpack
  --no-screenshot          skip the Clean-scanlation editor screenshot
  --chapter-zip            also pull the whole-chapter ZIP (server-side build, SSE-announced)
  --delete-pages           delete each page from the instance once its artifacts are on disk
  --resume                 reuse <out>/run.json, skip pages already captured, re-attempt the rest
  --append                   add to the END of a chapter that already has pages instead of
                             starting again at page 1. Required when reusing a populated chapter:
                             uploading onto an occupied slot makes the backend shift every later
                             page up by one, which silently renumbers pages an earlier run already
                             captured.
  --pause-queue <bool>     pause the global queue while submitting so these pages reach the head [true]
  --headed                 show the browser
  --dry-run                list the samples that would be submitted and exit
`;

(async () => {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const { selected, total, skipped } = discoverSamples(args);
  console.log(`selected ${selected.length} of ${total} ${args.lang} sample(s)`);
  if (skipped.length) console.log(`skipped ${skipped.length} entr(ies), first: ${skipped[0]}`);
  for (const s of selected.slice(0, 10)) console.log(`  ${s.sampleId}  ${path.relative(process.cwd(), s.imagePath)}`);
  if (selected.length > 10) console.log(`  ... and ${selected.length - 10} more`);
  if (!selected.length) process.exit(2);
  if (args.dryRun) process.exit(0);

  const outRoot = path.resolve(
    args.out || path.join(REPO_ROOT, "docs", "quality-runs", `corpus-batch-${runId()}`),
  );
  fs.mkdirSync(outRoot, { recursive: true });
  const manifestPath = path.join(outRoot, "run.json");

  const browser = await loadChromium().launch({ headless: !args.headed });
  const browserContext = await browser.newContext({
    viewport: VIEWPORT,
    acceptDownloads: true,
    ignoreHTTPSErrors: true,
  });
  const ctx = {
    page: await browserContext.newPage(),
    base: args.base.replace(/\/+$/, ""),
    token: "",
    outRoot,
    storedUser: "",
    cleanView: true,
    adoptSession(body, message) {
      this.token = body.token;
      this.storedUser = JSON.stringify(body);
      this.who = `${body.email} (${body.role})`;
      console.log(message);
    },
  };

  const registry = [];
  const wake = (entry) => {
    for (let i = registry.length - 1; i >= 0; i--) {
      if (registry[i].entry === entry) registry.splice(i, 1)[0].resolve();
    }
  };
  let pausedByUs = false;

  try {
    await ensureToken(ctx, args);
    await seedReaderStorage(ctx.page, ctx);

    const seriesId = await ensureSeries(ctx, args);
    const chapterId = await ensureChapter(ctx, args, seriesId);
    // Page numbering decides whether a second run is safe, so it is settled before anything else.
    //
    // `insert_page` clamps the requested number into 1..=max+1 and, when the slot is occupied,
    // shifts every page at or after it up by one (routes/page.rs:330-337). Uploading page 1 into a
    // chapter that already holds pages 1..5 therefore does not replace page 1 -- it renumbers the
    // old ones to 2..6 and inserts the new page as 1. Every page an earlier run had already
    // captured would silently change number, and this manifest's page->sample mapping with it.
    // So a populated chapter is refused unless --append says to continue past it.
    const existing = await chapterPageState(ctx, chapterId);
    if (existing.count > 0 && !args.append && !args.resume) {
      throw new Error(
        `chapter ${chapterId} already holds ${existing.count} page(s) (highest number ` +
        `${existing.highest}).\n` +
        "  Uploading onto occupied slots would renumber the pages already in it, so this run\n" +
        "  refuses to guess. Pass --append to add after the last page, --resume to re-harvest an\n" +
        "  interrupted run, or point --chapter-title/--chapter-id at an empty chapter.",
      );
    }
    if (args.append && args.resume) {
      throw new Error("--append and --resume are mutually exclusive: resume re-uses the page ids this run already submitted, append submits new ones.");
    }
    const startPage = args.append ? existing.highest + 1 : 1;
    if (args.append) {
      console.log(
        `appending after page ${existing.highest}: this run fills ${startPage}..${startPage + selected.length - 1}`,
      );
    }

    console.log(`\nseries ${seriesId}   chapter ${chapterId}`);
    console.log(`reader ${ctx.base}/chapters/${chapterId}/reader/${startPage}\n`);

    const entries = selected.map((sample, i) => ({
      // The source file is the entry's identity across runs; `pageNumber` is what the backend
      // assigned (see the reconcile below), `requestedPageNumber` what was asked for.
      sampleKey: path.resolve(sample.imagePath),
      pageNumber: startPage + i,
      sample,
      state: "pending",
      timeoutMs: args.pageTimeoutSec * 1000,
      terminal: false,
    }));

    const manifest = {
      runId: runId(),
      startedAt: new Date().toISOString(),
      base: ctx.base,
      account: ctx.who,
      seriesId,
      chapterId,
      readerUrl: `${ctx.base}/chapters/${chapterId}/reader/${startPage}`,
      firstPage: startPage,
      appendedAfterPage: args.append ? existing.highest : null,
      lang: args.lang,
      series: { title: args.seriesTitle, readingDirection: args.readingDirection },
      chapter: {
        title: args.chapterTitle,
        useContextMemory: args.injectContext,
        overrides: overridePayload(args.models),
      },
      corpusRoot: path.resolve(args.corpusRoot),
      pageCount: entries.length,
      wanted: {
        renderPng: args.renderPng,
        exportPng: args.exportPng,
        projectZip: args.projectZip,
        screenshot: args.screenshot,
        chapterZip: args.chapterZip,
      },
      pages: entries,
      counts: {},
    };

    if (args.resume && !fs.existsSync(manifestPath) && existing.count > 0) {
      throw new Error(
        `--resume: ${manifestPath} is missing, but chapter ${chapterId} already holds ` +
        `${existing.count} page(s). Without the manifest this run cannot tell which page is which\n` +
        "  sample, and uploading would renumber them. Pass the earlier run's --out, or use an empty chapter.",
      );
    }
    if (args.resume && fs.existsSync(manifestPath)) {
      const previous = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (previous.chapterId !== chapterId) {
        throw new Error(`--resume: ${manifestPath} belongs to chapter ${previous.chapterId}, not ${chapterId}`);
      }
      // Matched by source file, not page number: the backend may have assigned a page a different
      // number than requested, and a number-based match would hand one sample another's page.
      const keyOf = (p) => p.sampleKey || (p.sample && path.resolve(p.sample.imagePath));
      const byKey = new Map(previous.pages.filter(keyOf).map((p) => [keyOf(p), p]));
      let resumed = 0;
      for (const entry of entries) {
        const before = byKey.get(entry.sampleKey);
        if (!before) continue;
        if (before.sourceSha256) {
          const now = crypto.createHash("sha256").update(fs.readFileSync(entry.sample.imagePath)).digest("hex");
          if (now !== before.sourceSha256) {
            throw new Error(
              `--resume: ${entry.sample.imagePath} changed since it was uploaded as page ` +
              `${before.pageNumber}; re-uploading would add a page and shift the later ones. ` +
              "Start a new chapter instead.",
            );
          }
        }
        const dir = path.join(outRoot, pageDirName(entry.pageNumber, entry.sample.sampleId));
        if (before.state === "done" && before.artifacts && fs.existsSync(path.join(dir, "page.json"))) {
          // `sample` is dropped on purpose: this run's selection is the authority on which page is
          // which sample, so a previous manifest cannot silently re-point page N at an old file.
          const { sample: _stale, ...carried } = before;
          Object.assign(entry, carried, { terminal: true });
          resumed++;
        } else if (before.pageId && !before.pageDeleted) {
          // Already on the server: harvest it, do not upload it again. A page this run deleted is
          // uploaded again.
          entry.pageId = before.pageId;
          entry.imageId = before.imageId;
          entry.sourceSha256 = before.sourceSha256;
          entry.submittedAt = before.submittedAt;
          entry.pageNumber = before.pageNumber;
          if (before.requestedPageNumber !== undefined) {
            entry.requestedPageNumber = before.requestedPageNumber;
          }
          entry.state = "pending";
        }
      }
      console.log(`resuming: ${resumed} page(s) already captured, ${entries.length - resumed} to do\n`);
    }

    if (args.injectContext && entries.length > 1) {
      console.warn(
        `WARNING: --inject-context with ${entries.length} pages makes this chapter serial.\n` +
        "  A page waits for every earlier page's ocr/layout/translation to leave the queue\n" +
        "  (dispatcher.rs earlier_page_is_still_translating). Expect roughly one page per\n" +
        "  translation cycle rather than parallel pages.\n",
      );
    }

    const pending = entries.filter((e) => !e.terminal);
    // Resumed pages that are still on the server are only harvested.
    const toUpload = pending.filter((e) => !e.pageId);
    if (toUpload.length && args.pauseQueue) {
      const queue = await readQueue(ctx);
      if (queue.isPaused) {
        console.log(`queue was already paused (${queue.jobs.length} active job(s) listed); leaving it paused`);
      } else {
        await setQueuePaused(ctx, true);
        pausedByUs = true;
        console.log(
          `queue paused for submission (${queue.jobs.length} pre-existing job(s) already in flight ` +
          "will still finish; nothing new will be claimed until the resume below)",
        );
      }
    }

    if (pending.length) {
      console.log(
        `submitting ${toUpload.length} page(s), ${args.submitConcurrency} at a time` +
        (pending.length > toUpload.length ? ` (${pending.length - toUpload.length} resumed page(s) already on the server)` : ""),
      );
      if (args.submitConcurrency > 1) {
        console.warn(
          `WARNING: --submit-concurrency ${args.submitConcurrency} uploads into ONE chapter at once.\n` +
          "  The backend reserves a page slot with an unlocked read of MAX(page_number)+1 and\n" +
          "  only then inserts (routes/page.rs:330-348), so parallel uploads can collide: the\n" +
          "  loser 500s on the unique constraint, and the others can be silently clamped to a\n" +
          "  different page number than requested. Expect both below.\n",
        );
      }
      let submitted = 0;
      await runQueue(toUpload, args.submitConcurrency, async () => async (entry) => {
        try {
          const body = await uploadPage(ctx, chapterId, entry);
          submitted++;
          if (submitted % 10 === 0 || submitted === toUpload.length) {
            console.log(`  submitted ${submitted}/${toUpload.length}`);
          }
          if (body.status === "already_exists") {
            console.log(`  page ${entry.pageNumber} (${entry.sample.sampleId}): image already occupied that slot`);
          }
        } catch (e) {
          entry.terminal = true;
          entry.state = "upload-failed";
          entry.error = e.message;
          entry.finishedAt = new Date().toISOString();
        }
      });
      // Reconcile against what the backend actually created. Two things can make the number we
      // asked for not be the number we got: the clamp in insert_page, and a page left behind by an
      // earlier run. Without this an entry would poll for a page number that holds a different
      // sample -- or that does not exist at all, in which case it waits out the full page timeout.
      const landed = await chapterPageState(ctx, chapterId);
      const numbersById = new Map();
      for (let page = 0; page < Math.max(1, Math.ceil(landed.count / PAGE_LIST_SIZE)); page++) {
        const body = await apiJson(
          ctx,
          `/api/chapters/${chapterId}/pages?size=${PAGE_LIST_SIZE}&page=${page}&sort=pageNumber,asc`,
        );
        for (const p of body.content || []) numbersById.set(String(p.id), Number(p.pageNumber));
      }
      for (const entry of pending) {
        if (!entry.pageId || entry.terminal) continue;
        const actual = numbersById.get(String(entry.pageId));
        if (actual === undefined) {
          entry.terminal = true;
          entry.state = "upload-failed";
          entry.error = `page ${entry.pageId} is not in chapter ${chapterId} after upload`;
          entry.finishedAt = new Date().toISOString();
          continue;
        }
        if (actual !== entry.pageNumber) {
          console.warn(
            `  ${entry.sample.sampleId}: requested page ${entry.pageNumber}, backend assigned ${actual}`,
          );
          if (entry.requestedPageNumber === undefined) entry.requestedPageNumber = entry.pageNumber;
          entry.pageNumber = actual;
        }
      }
      manifest.counts = summarise(manifest);
      writeManifest(manifestPath, manifest);
    }

    if (pausedByUs) {
      await setQueuePaused(ctx, false);
      pausedByUs = false;
      console.log("queue resumed\n");
    }

    const harvest = entries.filter((e) => !e.terminal);
    if (harvest.length) {
      console.log(
        `harvesting ${harvest.length} page(s), ${args.captureConcurrency} at a time, polling every ${args.pollIntervalSec}s`,
      );
      const pollerDone = poller(ctx, chapterId, entries, wake, {
        pollIntervalMs: args.pollIntervalSec * 1000,
        globalTimeoutMs: args.pageTimeoutSec * 1000 + 900_000,
        onError: (e) => console.warn(`poll error: ${e.message}`),
      });

      let captured = 0;
      await runQueue(harvest, args.captureConcurrency, async () => {
        const page = await browserContext.newPage();
        await seedReaderStorage(page, ctx);
        return async (entry) => {
          await waitForTerminal(entry, registry);
          const dir = path.join(outRoot, pageDirName(entry.pageNumber, entry.sample.sampleId));
          entry.outputDir = path.relative(outRoot, dir);
          try {
            await capturePage(ctx, args, chapterId, entry, dir, page);
            entry.capturedAt = new Date().toISOString();
          } catch (e) {
            entry.captureError = e.message;
            console.warn(`  page ${entry.pageNumber} (${entry.sample.sampleId}): capture failed: ${e.message}`);
          }
          if (args.deletePages && entry.pageId) {
            const res = await ctx.page.request.delete(`${ctx.base}/api/pages/${entry.pageId}`, {
              headers: { Authorization: `Bearer ${ctx.token}` },
            });
            entry.pageDeleted = res.ok();
            if (!res.ok()) console.warn(`  page ${entry.pageNumber}: delete returned ${res.status()}`);
          }
          captured++;
          manifest.counts = summarise(manifest);
          writeManifest(manifestPath, manifest);
          const counts = entry.elements ? ` (ocr ${entry.elements.ocr}, tl ${entry.elements.translation})` : "";
          const why = entry.error ? ` -- ${entry.error}` : "";
          console.log(`  [${captured}/${harvest.length}] page ${entry.pageNumber} ${entry.sample.sampleId}: ${entry.state}${counts}${why}`);
        };
      });
      await pollerDone;
    }

    if (args.chapterZip) {
      console.log("pulling the chapter ZIP (built server-side, announced over SSE)");
      try {
        const dest = await captureChapterZip(ctx, chapterId, outRoot);
        manifest.chapterZip = path.basename(dest);
        console.log(`  ${path.relative(process.cwd(), dest)}`);
      } catch (e) {
        manifest.chapterZipError = e.message;
        console.warn(`  chapter ZIP failed: ${e.message}`);
      }
    }

    manifest.finishedAt = new Date().toISOString();
    manifest.counts = summarise(manifest);
    writeManifest(manifestPath, manifest);

    console.log(`\n${Object.entries(manifest.counts).map(([k, v]) => `${k}: ${v}`).join("  ")}`);
    console.log(`manifest ${path.relative(process.cwd(), manifestPath)}`);
    const incomplete = entries.filter((e) => e.state !== "done");
    if (incomplete.length) {
      console.log(
        `not clean: ${incomplete.length} page(s) — rerun with --resume --out ${path.relative(process.cwd(), outRoot)}`,
      );
    }
    // A page that rendered but had a job fail is still a failure (its artifacts are kept).
    const hard = entries.filter((e) =>
      ["upload-failed", "timeout", "failed", "failed-with-output"].includes(e.state),
    );
    process.exitCode = hard.length ? 1 : 0;
  } finally {
    if (pausedByUs) {
      await setQueuePaused(ctx, false).catch((e) => console.warn(`could not resume the queue: ${e.message}`));
    }
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(2);
});