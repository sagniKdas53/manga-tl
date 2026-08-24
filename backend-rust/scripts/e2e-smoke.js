/* Phase 4 step 4 — frontend E2E smoke against the Rust backend.
 * login/register → series create → chapter create → page upload (single image + zip)
 * → reader shows the page → SSE stream connected → settings save/load.
 */
const { chromium } = require("playwright");
const fs = require("fs");

const BASE = "http://localhost:8083/tlhub";
const SHOTS = "/tmp/opencode/e2e-shots";
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function pngWithColor(r, g, b) {
  // 1x1 PNG with an arbitrary RGB pixel: patch the IHDR-less trick is overkill —
  // reuse the same bytes; dedup by hash only matters within one chapter upload.
  return Buffer.from(PNG_1PX);
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
