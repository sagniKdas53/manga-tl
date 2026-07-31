const { chromium } = require("playwright");

const BASE = "http://localhost:8080/tlhub";
const EMAIL = "valcheck-1785509793@test.local";
const PASS = "TestPass123!";

// Page -> imageId mapping for chapter 79118639 (177 pages)
const IMG_BY_PAGE = {
  5: "80faf778-af1e-4e47-a4f8-c021e37e8581",
  18: "dcfe88cd-6b34-4d61-9e8c-d1280902b3b4",
  19: "15586b18-0ac7-404b-bc26-40316f902986",
  20: "81513c18-eb55-4c46-a894-23155e6b00f4",
  21: "58354944-8112-46e2-8ec1-caa852dcaabc",
  22: "dda4f987-00d9-48c7-aab9-db7e53ac2551",
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${detail ? " | " + detail : ""}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const imageReqs = [];
  const pageErrors = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/api/images/")) imageReqs.push(u);
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console: ${m.text()}`);
  });

  // ---------- 1. LOGIN ----------
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email Address").fill(EMAIL);
  await page.getByLabel("Password").fill(PASS);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 20000 }),
    page.getByRole("button", { name: "Sign In" }).click(),
  ]);
  await page.waitForLoadState("networkidle").catch(() => {});
  console.log("LOGGED IN ->", page.url());

  // ---------- 2. DASHBOARD: series covers use thumbnails ----------
  imageReqs.length = 0;
  await page.waitForTimeout(4000);
  const dashFileReqs = imageReqs.filter((u) => u.includes("/file")).length;
  check(
    "dashboard: no /file image requests",
    dashFileReqs === 0,
    `${dashFileReqs} /file requests`,
  );

  // ---------- 3. SERIES DETAILS (chapters) ----------
  await page.locator("text=Neurometric").first().click();
  await page.waitForTimeout(3000);
  imageReqs.length = 0;
  await page.waitForTimeout(2500);
  const seriesFileReqs = imageReqs.filter((u) => u.includes("/file")).length;
  check(
    "series page: covers use /thumbnail, no /file",
    seriesFileReqs === 0,
    `${seriesFileReqs} /file requests`,
  );

  // ---------- 4. GALLERY (177 page thumbnails) ----------
  imageReqs.length = 0; // clear BEFORE clicking -> captures the full gallery load
  await page
    .locator('.chapters-grid .MuiCard-root', { hasText: "Sister" })
    .first()
    .click();
  await page.waitForSelector(".pages-grid .page-thumbnail-container", { timeout: 20000 });
  await page.waitForTimeout(4000);

  const galleryFileReqs = imageReqs.filter((u) => u.includes("/file")).length;
  const galleryThumbReqs = imageReqs.filter((u) => u.includes("/thumbnail")).length;
  check(
    "gallery: requests only /thumbnail, never /file",
    galleryFileReqs === 0 && galleryThumbReqs > 0,
    `${galleryThumbReqs} thumb / ${galleryFileReqs} file`,
  );

  // Off-screen thumbnails: initial load should NOT fetch all 177
  const loadedImgs = await page.locator(".pages-grid img[src]").count();
  check(
    "gallery: lazy loading - off-screen thumbnails have no src",
    loadedImgs < 177,
    `${loadedImgs}/177 imgs have src after initial load`,
  );

  // Scroll to bottom -> more lazy loads fire
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);
  const afterScroll = await page.locator(".pages-grid img[src]").count();
  check(
    "gallery: scrolling triggers further lazy loads",
    afterScroll > loadedImgs,
    `${loadedImgs} -> ${afterScroll}`,
  );

  // ---------- 5. READER at page 20 (bi-directional prefetch) ----------
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator(".page-thumbnail-container", { hasText: "Page 20" }).first().click();
  await page.waitForSelector(`img[src*="${IMG_BY_PAGE[20]}"]`, { timeout: 30000 });
  await page.waitForTimeout(4000);

  // file requests -> image ids
  const fileImageIds = imageReqs
    .filter((u) => u.includes("/file"))
    .map((u) => (u.match(/\/api\/images\/([^/]+)\/file/) || [])[1]);
  const unique = [...new Set(fileImageIds)];
  console.log("READER file image IDs:", unique.join(", "));

  const expectedNeighbors = [18, 19, 21, 22].map((p) => IMG_BY_PAGE[p]);
  const present = expectedNeighbors.filter((id) => unique.includes(id));
  const allInWindow =
    unique.every((id) => Object.values(IMG_BY_PAGE).includes(id)) &&
    unique.includes(IMG_BY_PAGE[20]);
  check(
    "reader: prefetches 2 pages backward AND forward (18,19,21,22)",
    present.length === 4,
    `present ${present.length}/4: ${present.join(", ")}`,
  );
  check(
    "reader: current page (20) loaded and all requests within [N-2, N+2]",
    allInWindow,
    `distinct ids: ${unique.length}`,
  );

  // ---------- 6. NAVIGATION NOT STARVED: back to gallery, then page 5 ----------
  await page.goBack();
  await page.waitForSelector(".pages-grid .page-thumbnail-container", { timeout: 20000 });
  await page.waitForTimeout(2000);
  const galleryAgain = await page.locator(".pages-grid img[src]").count();
  check("navigation: back to gallery renders", galleryAgain > 0, `${galleryAgain} imgs`);

  await page.locator(".page-thumbnail-container", { hasText: "Page 5" }).first().click();
  await page.waitForSelector(`img[src*="${IMG_BY_PAGE[5]}"]`, { timeout: 30000 });
  await page.waitForTimeout(2000);
  const p5file = imageReqs.some((u) => u.includes(`/api/images/${IMG_BY_PAGE[5]}/file`));
  check("navigation: reader page 5 loads after back-nav", p5file, IMG_BY_PAGE[5]);

  // ---------- 7. JS errors / crashes ----------
  const realErrors = pageErrors.filter(
    (e) => !e.includes("Failed to load resource") && !e.includes("404"),
  );
  check("no page JS errors / crashes", realErrors.length === 0, realErrors.slice(0, 5).join(" ; "));

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log("\n==== SUMMARY ====");
  console.log(`passed: ${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("SCRIPT ERROR:", e);
  process.exit(2);
});
