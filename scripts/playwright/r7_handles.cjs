#!/usr/bin/env node
/**
 * Tracker R7 gate: the patch handles a user touches, through the real editor.
 *
 * Selects one patch, drags its frame, drags its resize corner, sets its opacity on the slider,
 * then presses Undo three times. The patch's saved row and the page's export must be exactly what
 * they were before (an unset opacity must come back as opaque on the server, not stay faded).
 *
 *   node scripts/playwright/r7_handles.cjs --base ... --page <pageId> --patch <elementId> --out <dir>
 */

const fs = require("fs");
const path = require("path");
const {
  api,
  json,
  sha256,
  login,
  sceneRevision,
  waitForNewRevisionRender,
} = require("./r7_parity.cjs");

function parseArgs(argv) {
  const args = {
    base: "http://127.0.0.1:18080/tlhub",
    page: "",
    patch: "",
    out: "",
  };
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i];
    if (argv[i] === "--base") args.base = next();
    else if (argv[i] === "--page") args.page = next();
    else if (argv[i] === "--patch") args.patch = next();
    else if (argv[i] === "--out") args.out = next();
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const { chromium } = require("playwright");
  fs.mkdirSync(args.out, { recursive: true });
  const browser = await chromium.launch();
  const page = await (
    await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  ).newPage();
  const { TLHUB_EMAIL: email, TLHUB_PASSWORD: password } = process.env;
  const token = (
    await (
      await page.request.post(`${args.base}/api/auth/login`, {
        data: { email, password },
      })
    ).json()
  ).token;
  await login(page, args.base, email, password);
  const r = page.request;

  const row = async () => {
    const d = await json(r, args.base, token, "GET", `/api/pages/${args.page}`);
    const el = d.layers
      .flatMap((l) => l.elements)
      .find((e) => e.id === args.patch);
    return {
      x: el.x,
      y: el.y,
      w: el.maxWidth,
      h: el.maxHeight,
      opacity: el.opacity ?? 1,
      visible: el.visible,
    };
  };
  const settledExport = async () => {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      const response = await api(
        r,
        args.base,
        token,
        "GET",
        `/api/pages/${args.page}/rendered`,
      );
      if (response.ok()) return sha256(await response.body());
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error("page did not settle");
  };

  const start = { row: await row(), export: await settledExport() };
  const d = await json(r, args.base, token, "GET", `/api/pages/${args.page}`);
  await page.goto(
    `${args.base}/chapters/${d.page.chapterId}/reader/${d.page.pageNumber}`,
  );
  const patch = page.locator(`[data-cleanup-id="cleanup-${args.patch}"]`);
  await patch.waitFor({ state: "attached", timeout: 60_000 });
  await patch.dispatchEvent("click");
  await page.getByTestId("patch-inspector").waitFor();

  const drag = async (locator, dx, dy) => {
    const box = await locator.boundingBox();
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
    await page.mouse.move(x + dx, y + dy, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(800);
  };
  const handles = page.locator('[data-editor-handle="inpainting"] rect');
  await drag(handles.nth(0), 60, 40);
  await drag(handles.nth(1), 50, 30);
  const slider = page.getByTestId("patch-inspector").locator(".MuiSlider-root");
  const box = await slider.boundingBox();
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height / 2);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(args.out, "handles-edited.png") });
  const edited = await row();

  await page.evaluate(
    () => document.activeElement && document.activeElement.blur(),
  );
  const before = await sceneRevision(r, args.base, token, args.page);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(2500);
  const undone = await row();
  await waitForNewRevisionRender(r, args.base, token, args.page, before);
  const end = { row: undone, export: await settledExport() };

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const report = {
    start,
    edited,
    moved: edited.x !== start.row.x || edited.y !== start.row.y,
    resized: edited.w !== start.row.w || edited.h !== start.row.h,
    faded: edited.opacity < 1,
    end,
    row_restored: same(end.row, start.row),
    export_restored: end.export === start.export,
  };
  fs.writeFileSync(
    path.join(args.out, "handles.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
  if (!(
    report.moved &&
    report.resized &&
    report.faded &&
    report.row_restored &&
    report.export_restored
  ))
    process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
