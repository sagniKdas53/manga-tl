// Capture-only companion to capture_quality_baseline.cjs for a page the pipeline already finished
// (R1, 2026-09-18: sample61 outlived the harness's 30-minute idle window). Same artifacts:
// export.png via the reader button, project.zip, page-snapshot.json, current-render sha.
// Usage: TLHUB_EMAIL=… TLHUB_PASSWORD=… node scripts/playwright/capture_existing_page.cjs <base> <chapterId> <pageId> <sample> <runDir>
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const [base, chapterId, pageId, sample, out] = process.argv.slice(2);
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const auth = (t) => ({ Authorization: `Bearer ${t}` });
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const login = await page.request.post(`${base}/api/auth/login`, { data: { email: process.env.TLHUB_EMAIL, password: process.env.TLHUB_PASSWORD } });
  const token = (await login.json()).token;
  const rendered = await page.request.fetch(`${base}/api/pages/${pageId}/rendered`, { headers: auth(token) });
  if (!rendered.ok()) throw new Error(`current render not ready: HTTP ${rendered.status()}`);
  const currentSha = sha256(await rendered.body());
  await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email Address").fill(process.env.TLHUB_EMAIL);
  await page.getByLabel("Password").fill(process.env.TLHUB_PASSWORD);
  await Promise.all([page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 30000 }), page.getByRole("button", { name: "Sign In" }).click()]);
  const dir = path.join(out, "a04-exports", sample); fs.mkdirSync(dir, { recursive: true });
  await page.goto(`${base}/chapters/${chapterId}/reader/1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('img[src*="/api/images/"]', { timeout: 60000 });
  await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(dir, "editor.png"), fullPage: true });
  for (const [name, file] of [["Export Page (PNG)", "export.png"], ["Export Project (ZIP)", "project.zip"]]) {
    const button = page.getByRole("button", { name, exact: true }); await button.waitFor({ state: "visible", timeout: 60000 });
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 120000 }), button.click()]);
    await dl.saveAs(path.join(dir, file));
  }
  execFileSync("unzip", ["-o", "project.zip", "-d", "project"], { cwd: dir, stdio: "ignore" });
  const snap = await (await page.request.get(`${base}/api/pages/${pageId}`, { headers: auth(token) })).json();
  fs.writeFileSync(path.join(dir, "page-snapshot.json"), JSON.stringify(snap, null, 2));
  const record = { sample, page_id: pageId, chapter_id: chapterId, captured_by: "capture_existing_page.cjs", captured_at: new Date().toISOString(),
    export_png_sha256: sha256(fs.readFileSync(path.join(dir, "export.png"))), current_render_png_sha256: currentSha,
    project_zip_sha256: sha256(fs.readFileSync(path.join(dir, "project.zip"))) };
  fs.writeFileSync(path.join(dir, "capture-record.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
