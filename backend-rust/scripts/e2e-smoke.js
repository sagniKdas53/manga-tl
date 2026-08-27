/* Phase 4 step 4 — frontend E2E smoke against the Rust backend.
 * login/register → series create → chapter create → page upload (single image + zip)
 * → reader shows the page → SSE stream connected → settings save/load.
 */
const { chromium } = require("playwright");
const fs = require("fs");

const BASE = "http://localhost:8083/tlhub";
const SHOTS = "/tmp/opencode/e2e-shots";
const zlib = require("zlib");

// Pages are deliberately LARGER THAN 2 MB.
//
// This script used to upload a 1x1 PNG for both the single-image and the ZIP path. That
// is exactly why the 2 MB DefaultBodyLimit regression (deviation 12) survived a "passing"
// E2E: axum rejected every real manga scan with a confusing 400 "multipart error", and
// nothing in the suite ever sent a body big enough to notice. Every upload fixture in the
// Rust test suite was a 1x1 or 64x64 PNG too.
//
// So the fixture is now a real truecolor PNG of realistic page dimensions filled with
// seeded noise. Noise is the point: it does not compress, so the encoded file stays over
// the old limit instead of deflating back down to a few hundred bytes.
const PAGE_W = 1000;
const PAGE_H = 900; // 1000*3+1 bytes/row * 900 ≈ 2.7 MB encoded

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

function pngWithColor(r, g, b) {
  // Seeded from the requested tint, so each call yields DIFFERENT bytes (the backend
  // dedups identical uploads by hash within a chapter) but the same bytes on every run.
  let seed = (r * 73856093) ^ (g * 19349663) ^ (b * 83492791) ^ 0x9e3779b9;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) & 0xff;
  };

  const stride = PAGE_W * 3 + 1; // +1 filter byte per scanline
  const raw = Buffer.alloc(stride * PAGE_H);
  for (let y = 0; y < PAGE_H; y++) {
    const row = y * stride;
    raw[row] = 0; // filter type 0 (None)
    for (let x = 0; x < PAGE_W; x++) {
      const p = row + 1 + x * 3;
      // Tint toward the requested colour but keep the low bits noisy, so the image is
      // visually identifiable in a screenshot AND incompressible.
      raw[p] = (r + rand()) & 0xff;
      raw[p + 1] = (g + rand()) & 0xff;
      raw[p + 2] = (b + rand()) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(PAGE_W, 0);
  ihdr.writeUInt32BE(PAGE_H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function zipOf(entries) {
  // Minimal stored (no compression) ZIP writer.
  const { execSync } = require("child_process");
  fs.mkdirSync("/tmp/opencode/zipwork", { recursive: true });
  fs.rmSync("/tmp/opencode/zipwork/out.zip", { force: true });
  for (const [name, buf] of entries) {
    fs.writeFileSync(`/tmp/opencode/zipwork/${name}`, buf);
  }
  execSync(
    "cd /tmp/opencode/zipwork && zip -X -0 out.zip " +
      entries.map(([n]) => JSON.stringify(n)).join(" "),
  );
  return fs.readFileSync("/tmp/opencode/zipwork/out.zip");
}

let sseConnected = false;
let failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL ${name}: ${err.message ?? err}`);
  }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  page.setDefaultTimeout(15000);

  let sseResponse = null;
  page.on("response", (resp) => {
    if (resp.url().includes("/api/notifications/stream")) {
      if (resp.status() === 200) sseConnected = true;
    }
  });

  // ---- auth: ask the backend which mode we need, then drive that form ----
  const setupResp = await page.request.get(`${BASE}/api/auth/setup-required`);
  const setupRequired = (await setupResp.json()).setupRequired === true;

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/01-landing.png` });

  if (!setupRequired) {
    // Existing admin: make sure we are on the SIGN IN view.
    const signInToggle = page.getByRole("button", { name: /already have an account/i }).first();
    if (await signInToggle.isVisible().catch(() => false)) {
      await signInToggle.click();
      await page.waitForTimeout(600);
    }
  } else {
    const signUpLink = page.getByRole("button", { name: /sign up/i }).first();
    if (await signUpLink.isVisible().catch(() => false)) {
      await signUpLink.click();
      await page.waitForTimeout(600);
    }
  }

  const registerVisible = setupRequired && (
    await page
      .getByLabel(/Display Name/i)
      .isVisible({ timeout: 6000 })
      .catch(() => false)
  );

  if (registerVisible) {
    await page.getByLabel(/Display Name/i).fill("E2E Admin");
    await page.getByLabel(/Email Address/i).fill("admin@e2e.local");
    await page.getByLabel(/Password/i).first().fill("e2e-password-123");
    await page.screenshot({ path: `${SHOTS}/02-register-filled.png` });
    await page
      .getByRole("button", { name: /create account|register|sign up/i })
      .last()
      .click();
    await page.waitForTimeout(2500);
  }

  // If registration was rejected (user already exists from an earlier run), switch to
  // the sign-in view explicitly and log in there.
  await page.waitForTimeout(2000);
  if (page.url().includes("/login")) {
    const toggle = page.getByRole("button", { name: /already have an account|sign in/i }).first();
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
      await page.waitForTimeout(600);
    }
    await page.getByLabel(/Email Address/i).fill("admin@e2e.local");
    await page.getByLabel(/Password/i).first().fill("e2e-password-123");
    await page.getByRole("button", { name: /sign in/i }).last().click();
  }

  await page.waitForURL((u) => !String(u).includes("/login"), { timeout: 20000 });
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${SHOTS}/03-dashboard.png` });

  await check("SSE stream connected after login", async () => {
    if (!sseConnected) throw new Error("no 200 on /api/notifications/stream");
  });

  // ---- create series ----
  await page.getByRole("button", { name: /new series/i }).first().click();
  await page.getByLabel(/Series Title/i).first().fill("E2E Series");
  await page.screenshot({ path: `${SHOTS}/04-series-dialog.png` });
  await page.getByRole("button", { name: /create series/i }).last().click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1200);

  await check("series card visible on dashboard", async () => {
    const card = page.getByText("E2E Series", { exact: false }).first();
    if (!(await card.isVisible())) throw new Error("E2E Series not found on dashboard");
  });

  // open the series page
  await page.getByText("E2E Series", { exact: false }).first().click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOTS}/05-series-page.png` });

  // ---- add chapter ----
  await page.getByRole("button", { name: /add chapter/i }).first().click();
  await page.getByLabel(/Chapter Number/i).fill("1");
  await page.getByRole("button", { name: /add chapter|create chapter|save/i }).last().click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/06-chapter-added.png` });

  // enter the chapter workspace (click chapter 1 card/link)
  await page.getByText(/chapter\s*1/i).first().click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOTS}/07-chapter-workspace.png` });

  // ---- upload a single image via the hidden file input ----
  await page.setInputFiles("#file-upload", {
    name: "p1.png",
    mimeType: "image/png",
    buffer: pngWithColor(10, 200, 10),
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/08-after-single-upload.png` });

  await check("uploaded page appears in the grid", async () => {
    const img = page.locator('img[src*="/api/"], img[src*="thumbnail"]').first();
    await img.waitFor({ state: "visible", timeout: 10000 });
    const ok =
      (await img.getAttribute("src")) !== null;
    if (!ok) throw new Error("page image has no src");
  });

  // ---- upload a ZIP of pages ----
  const zipBuf = zipOf([
    ["002_a.png", pngWithColor(200, 0, 0)],
    ["003_b.png", pngWithColor(0, 0, 200)],
  ]);
  fs.writeFileSync("/tmp/opencode/pages.zip", zipBuf);
  await page.setInputFiles("#file-upload", {
    name: "pages.zip",
    mimeType: "application/zip",
    buffer: zipBuf,
  });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SHOTS}/09-after-zip-upload.png` });

  // ---- open reader and confirm the page renders ----
  const thumb = page.locator('img[src*="/api/"], img[src*="thumbnail"]').first();
  await thumb.click({ timeout: 10000 }).catch(async () => {
    // fall back to direct URL navigation once we know the chapter id from the URL
    const m = page.url().match(/chapters\/([0-9a-f-]{36})/);
    if (!m) throw new Error("cannot determine chapter id for reader navigation");
    await page.goto(`${BASE}/chapters/${m[1]}/reader/1`, { waitUntil: "networkidle" });
  });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/10-reader.png` });

  await check("reader renders the page image", async () => {
    const imgs = page.locator("img");
    const n = await imgs.count();
    let loaded = 0;
    for (let i = 0; i < n; i++) {
      if ((await imgs.nth(i).getAttribute("src"))?.match(/reader|file|rendered/)) {
        const natural = await imgs.nth(i).evaluate((el) => el.naturalWidth);
        if (natural > 0) loaded++;
      }
    }
    if (loaded === 0) throw new Error("no page bitmap rendered in reader");
  });

  // ---- settings save/load ----
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.locator('[aria-label="Settings"]').first().click();
  await page.getByText(/System Settings/i).waitFor({ state: "visible", timeout: 10000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/11-settings-modal.png` });

  await check("settings modal loads values from GET /api/settings", async () => {
    // MUI outlined labels are not always label-associated; assert visible text instead.
    await page
      .locator('[role="dialog"]')
      .getByText("Global OCR Provider", { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 10000 });
    const provider = await page
      .locator('[role="dialog"]')
      .getByText("openrouter", { exact: false })
      .first()
      .isVisible();
    if (!provider) throw new Error("loaded defaults not shown (openrouter missing)");
  });

  await page.getByRole("button", { name: /save settings/i }).last().click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/12-settings-saved.png` });

  await check("settings PUT accepted (modal closes or no error shown)", async () => {
    const dialogOpen = await page.locator('[role="dialog"]').isVisible().catch(() => false);
    if (dialogOpen) {
      const err = await page
        .locator('[role="dialog"]')
        .getByText(/failed|error/i)
        .count();
      if (err > 0) throw new Error("settings save surfaced an error");
    }
  });

  await browser.close();

  console.log(failures.length === 0 ? "E2E SMOKE: ALL PASS" : `E2E SMOKE: ${failures.length} FAILURES`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
