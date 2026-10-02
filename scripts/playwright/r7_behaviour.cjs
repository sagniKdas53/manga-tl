#!/usr/bin/env node
/**
 * Tracker R7 gate: layer behaviour, persistence, fallback and canonical downloads, on live pages.
 *
 *   --page  <id>  a page with an overlapping pair of patches and no fallback plate (sample177)
 *   --plate <id>  a page with a region whose cleanup gave no patch (sample93)
 *   --download name=id (repeatable) pages whose "Export Page (PNG)" download is checked
 *
 * Pixel comparisons decode both PNGs in the browser and compare RGBA. Every page this touches is
 * put back as it was (layers shown again, the deleted patch restored by Undo, the text moved back).
 * Pages must already be marked hand-edited (r7_parity.cjs --mark-edited) so a re-render queues no
 * paid QA pass; the imported copy inherits that mark from project.json.
 */

const fs = require("fs");
const path = require("path");
const {
  api,
  ok,
  json,
  sha256,
  login,
  editorPatches,
  rasteriseEditorContent,
  sceneRevision,
  waitForNewRevisionRender,
  LEGACY_GENERATOR,
} = require("./r7_parity.cjs");

function parseArgs(argv) {
  const args = {
    base: "http://127.0.0.1:18080/tlhub",
    out: "",
    page: "",
    plate: "",
    downloads: [],
    steps: "hide,delete,move,roundtrip",
    deleteId: "",
  };
  for (let i = 2; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--base":
        args.base = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--page":
        args.page = next();
        break;
      case "--steps":
        args.steps = next();
        break;
      case "--delete":
        args.deleteId = next();
        break;
      case "--plate":
        args.plate = next();
        break;
      case "--download": {
        const [name, id] = next().split("=");
        args.downloads.push({ name, id });
        break;
      }
      default:
        throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  return args;
}

/** RGBA comparison in the browser: {identical, differing, bbox}. */
async function comparePngs(browser, a, b, region) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    return await page.evaluate(
      async ({ a, b, region }) => {
        const load = async (b64) => {
          const image = new Image();
          image.src = `data:image/png;base64,${b64}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d", { colorSpace: "srgb" });
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, canvas.width, canvas.height);
        };
        const [x, y] = [await load(a), await load(b)];
        if (x.width !== y.width || x.height !== y.height)
          return { identical: false, sizeDiffers: true };
        let differing = 0;
        let bbox = null;
        for (let i = 0; i < x.data.length; i += 4) {
          const px = (i / 4) % x.width;
          const py = Math.floor(i / 4 / x.width);
          if (
            region &&
            !(
              px >= region.x &&
              px < region.x + region.w &&
              py >= region.y &&
              py < region.y + region.h
            )
          )
            continue;
          if (
            region?.exclude &&
            px >= region.exclude.x &&
            px < region.exclude.x + region.exclude.w &&
            py >= region.exclude.y &&
            py < region.exclude.y + region.exclude.h
          )
            continue;
          if (
            x.data[i] !== y.data[i] ||
            x.data[i + 1] !== y.data[i + 1] ||
            x.data[i + 2] !== y.data[i + 2] ||
            x.data[i + 3] !== y.data[i + 3]
          ) {
            differing += 1;
            bbox = bbox
              ? [
                  Math.min(bbox[0], px),
                  Math.min(bbox[1], py),
                  Math.max(bbox[2], px),
                  Math.max(bbox[3], py),
                ]
              : [px, py, px, py];
          }
        }
        return { identical: differing === 0, differing, bbox };
      },
      { a: a.toString("base64"), b: b.toString("base64"), region },
    );
  } finally {
    await context.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const email = process.env.TLHUB_EMAIL;
  const password = process.env.TLHUB_PASSWORD;
  const { chromium } = require("playwright");
  fs.mkdirSync(args.out, { recursive: true });
  const browser = await chromium.launch();
  const ui = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
  });
  const page = await ui.newPage();
  const token = (
    await (
      await page.request.post(`${args.base}/api/auth/login`, {
        data: { email, password },
      })
    ).json()
  ).token;
  await login(page, args.base, email, password);
  const r = page.request;
  const report = {};
  const save = (name, bytes) =>
    fs.writeFileSync(path.join(args.out, name), bytes);

  const details = (id) => json(r, args.base, token, "GET", `/api/pages/${id}`);
  /** The page's scene once its current revision has rendered (no snapshot exists before that). */
  const scene = async (id) => {
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      if (
        (
          await api(r, args.base, token, "GET", `/api/pages/${id}/rendered`)
        ).ok()
      ) {
        return json(r, args.base, token, "GET", `/api/pages/${id}/scene`);
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error(`page ${id} did not settle`);
  };
  const setLayers = async (layers, visible) => {
    for (const layer of layers)
      await ok(r, args.base, token, "PUT", `/api/layers/${layer.id}`, {
        visible,
      });
  };
  const rerender = async (id, change) => {
    const before = await sceneRevision(r, args.base, token, id);
    await change();
    return Buffer.from(
      await waitForNewRevisionRender(r, args.base, token, id, before),
    );
  };
  const openReader = async (id) => {
    const { page: meta } = await details(id);
    await page.goto(
      `${args.base}/chapters/${meta.chapterId}/reader/${meta.pageNumber}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForSelector(".svg-overlay", { state: "attached" });
  };
  /** The open editor's content, rasterised; `reload` re-opens the Reader first (loses Undo). */
  const editorContent = async (id, expected, reload = true) => {
    const { page: meta } = await details(id);
    if (reload) await openReader(id);
    const editor = await editorPatches(page, expected);
    const original = await api(
      r,
      args.base,
      token,
      "GET",
      `/api/images/${meta.imageId}/file`,
    );
    const mime = original.headers()["content-type"] || "image/png";
    return rasteriseEditorContent(
      browser,
      {
        href: `data:${mime};base64,${(await original.body()).toString("base64")}`,
        width: editor.width,
        height: editor.height,
      },
      editor.patches,
    );
  };

  // ---------------------------------------------------------------- sample177: layer behaviour
  const id = args.page;
  const layersOf = async (type) =>
    (await details(id)).layers
      .filter((l) => l.layer.type === type && l.layer.visible === true)
      .map((l) => l.layer);
  const textLayers = [
    ...(await layersOf("translation")),
    ...(await layersOf("sfx")),
  ];
  const inpaintingLayers = await layersOf("inpainting");
  // Only the patches the page actually paints: R7-D4 leaves a region without usable English its
  // source, so its (visible) element is not drawn.
  const drawnIds = new Set(
    (await scene(id)).cleanup_artifacts.map((c) =>
      c.cleanup_id.replace(/^cleanup-/, ""),
    ),
  );
  const patches = (await details(id)).layers
    .filter((l) => l.layer.type === "inpainting" && l.layer.visible === true)
    .flatMap((l) =>
      l.elements.filter((e) => e.visible === true && drawnIds.has(e.id)),
    );

  if (args.steps.includes("hide") || args.steps.includes("delete"))
    try {
      // 1. Hiding Inpainting shows the source again.
      const contentExport = await rerender(id, () =>
        setLayers(textLayers, false),
      );
      save("hide-inpainting-0-content-export.png", contentExport);
      const sourceExport = await rerender(id, () =>
        setLayers(inpaintingLayers, false),
      );
      save("hide-inpainting-1-source-export.png", sourceExport);
      const sourceEditor = await editorContent(id, 0);
      save("hide-inpainting-1-source-editor.png", sourceEditor);
      report.hide_inpainting = {
        editor_vs_export: await comparePngs(
          browser,
          sourceEditor,
          sourceExport,
        ),
        differs_from_cleaned_page: !(
          await comparePngs(browser, sourceExport, contentExport)
        ).identical,
      };
      // ... and with the English showing, the source is under it (evidence image only).
      const underText = await rerender(id, () => setLayers(textLayers, true));
      save("hide-inpainting-2-source-under-text-export.png", underText);
      await openReader(id);
      await page.screenshot({
        path: path.join(args.out, "hide-inpainting-2-editor-viewport.png"),
      });
      await rerender(id, async () => {
        await setLayers(inpaintingLayers, true);
        await setLayers(textLayers, false);
      });

      // 2. Deleting one of two overlapping patches, in the editor: source plus the remaining patch.
      const sceneNow = await scene(id);
      const order = sceneNow.cleanup_artifacts.map((c) =>
        c.cleanup_id.replace(/^cleanup-/, ""),
      );
      let pair = null;
      for (const a of patches) {
        for (const b of patches) {
          if (a.id >= b.id) continue;
          if (
            a.x < b.x + b.maxWidth &&
            b.x < a.x + a.maxWidth &&
            a.y < b.y + b.maxHeight &&
            b.y < a.y + a.maxHeight
          )
            pair = [a, b];
        }
      }
      if (args.deleteId) {
        // An explicit patch, with the first overlapping patch painted under it as its partner.
        const target = patches.find((p) => p.id === args.deleteId);
        if (!target) throw new Error(`no visible patch ${args.deleteId}`);
        const under = patches.find(
          (b) =>
            b.id !== target.id &&
            order.indexOf(b.id) < order.indexOf(target.id) &&
            target.x < b.x + b.maxWidth &&
            b.x < target.x + target.maxWidth &&
            target.y < b.y + b.maxHeight &&
            b.y < target.y + target.maxHeight,
        );
        if (!under)
          throw new Error(
            `patch ${args.deleteId} overlaps nothing painted under it`,
          );
        pair = [target, under];
      }
      if (!pair) throw new Error("no overlapping pair of patches on this page");
      const [upper, lower] =
        order.indexOf(pair[0].id) > order.indexOf(pair[1].id)
          ? pair
          : [pair[1], pair[0]];
      const before = await sceneRevision(r, args.base, token, id);
      await openReader(id);
      await page
        .locator(`[data-cleanup-id="cleanup-${upper.id}"]`)
        .dispatchEvent("click");
      await page.getByRole("button", { name: "Delete patch" }).click();
      await page.waitForFunction(
        (cleanupId) =>
          !document.querySelector(`[data-cleanup-id="${cleanupId}"]`),
        `cleanup-${upper.id}`,
      );
      const afterDelete = Buffer.from(
        await waitForNewRevisionRender(r, args.base, token, id, before),
      );
      save("delete-overlap-1-export.png", afterDelete);
      const afterDeleteEditor = await editorContent(
        id,
        patches.length - 1,
        false,
      );
      save("delete-overlap-1-editor.png", afterDeleteEditor);
      // For r7_recompose.py: the remaining patches, where and in what order the export drew them.
      save(
        "delete-overlap-1-scene.json",
        JSON.stringify(await scene(id), null, 2),
      );
      const rect = {
        x: upper.x,
        y: upper.y,
        w: upper.maxWidth,
        h: upper.maxHeight,
      };
      report.delete_overlapping_patch = {
        deleted: upper.id,
        remaining_under_it: lower.id,
        overlap: {
          x: Math.max(upper.x, lower.x),
          y: Math.max(upper.y, lower.y),
          w:
            Math.min(upper.x + upper.maxWidth, lower.x + lower.maxWidth) -
            Math.max(upper.x, lower.x),
          h:
            Math.min(upper.y + upper.maxHeight, lower.y + lower.maxHeight) -
            Math.max(upper.y, lower.y),
        },
        editor_vs_export: await comparePngs(
          browser,
          afterDeleteEditor,
          afterDelete,
        ),
        changed_only_inside_deleted_patch: (
          await comparePngs(browser, afterDelete, contentExport)
        ).bbox,
        deleted_rect: rect,
        // Outside the patch that stays, the deleted patch's rect is the source again.
        outside_overlap_equals_source: await comparePngs(
          browser,
          afterDelete,
          sourceExport,
          {
            ...rect,
            exclude: {
              x: lower.x,
              y: lower.y,
              w: lower.maxWidth,
              h: lower.maxHeight,
            },
          },
        ),
        // Inside the overlap the remaining patch shows: neither the source (a hole) nor the old top.
        overlap_is_not_source: !(
          await comparePngs(browser, afterDelete, sourceExport, {
            x: Math.max(upper.x, lower.x),
            y: Math.max(upper.y, lower.y),
            w:
              Math.min(upper.x + upper.maxWidth, lower.x + lower.maxWidth) -
              Math.max(upper.x, lower.x),
            h:
              Math.min(upper.y + upper.maxHeight, lower.y + lower.maxHeight) -
              Math.max(upper.y, lower.y),
          })
        ).identical,
      };
      // Undo in the editor brings it back, and the export returns to the cleaned page it was.
      const beforeUndo = await sceneRevision(r, args.base, token, id);
      await page.keyboard.press("Control+z");
      await page.waitForFunction(
        (count) =>
          document.querySelectorAll(
            '.svg-overlay [data-scene-layer="cleanup"] image',
          ).length === count,
        patches.length,
      );
      const afterUndo = Buffer.from(
        await waitForNewRevisionRender(r, args.base, token, id, beforeUndo),
      );
      save("delete-overlap-2-undo-export.png", afterUndo);
      report.undo_delete = {
        export_back_to_cleaned_page: await comparePngs(
          browser,
          afterUndo,
          contentExport,
        ),
      };
    } finally {
      await setLayers(inpaintingLayers, true);
      await setLayers(textLayers, true);
    }

  // 3. Moving text leaves the patches where they are.
  if (args.steps.includes("move")) {
    const text = (await details(id)).layers
      .filter((l) => l.layer.type === "translation" && l.layer.visible === true)
      .flatMap((l) => l.elements)
      .find((e) => e.visible === true && e.text && e.regionId);
    const boundsBefore = (await scene(id)).cleanup_artifacts.map((c) => [
      c.cleanup_id,
      c.bounds,
    ]);
    await rerender(id, () =>
      ok(r, args.base, token, "PUT", `/api/layer-elements/${text.id}`, {
        x: text.x + 40,
        y: text.y + 25,
      }),
    );
    const moved = await scene(id);
    const textAfter = moved.objects.find(
      (o) => o.object_id === `text-${text.id}`,
    );
    report.move_text = {
      element: text.id,
      text_moved_by: [
        textAfter.transform.x - text.x,
        textAfter.transform.y - text.y,
      ],
      patches_unchanged:
        JSON.stringify(
          moved.cleanup_artifacts.map((c) => [c.cleanup_id, c.bounds]),
        ) === JSON.stringify(boundsBefore),
    };
    await rerender(id, () =>
      ok(r, args.base, token, "PUT", `/api/layer-elements/${text.id}`, {
        x: text.x,
        y: text.y,
      }),
    );
  }

  // 4. A saved project round-trips the Inpainting layer.
  if (args.steps.includes("roundtrip")) {
    const originalExport = Buffer.from(
      await (
        await api(r, args.base, token, "GET", `/api/pages/${id}/rendered`)
      ).body(),
    );
    save("round-trip-0-original-export.png", originalExport);
    const originalScene = await scene(id);
    await openReader(id);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByText("Export Project (ZIP)", { exact: true }).click(),
    ]);
    const zipPath = path.join(args.out, "round-trip-1-project.zip");
    await download.saveAs(zipPath);
    const zipBytes = fs.readFileSync(zipPath);
    const series = await json(r, args.base, token, "POST", "/api/series", {
      title: `R7 round-trip ${Date.now()}`,
      readingDirection: "rightToLeft",
    });
    const chapter = await json(
      r,
      args.base,
      token,
      "POST",
      `/api/series/${series.id}/chapters`,
      { chapterNumber: 1 },
    );
    const imported = await r.post(
      `${args.base}/api/chapters/${chapter.id}/import-project`,
      {
        headers: { Authorization: `Bearer ${token}` },
        multipart: {
          file: {
            name: "project.zip",
            mimeType: "application/zip",
            buffer: zipBytes,
          },
        },
      },
    );
    if (!imported.ok())
      throw new Error(
        `import failed: HTTP ${imported.status()} ${await imported.text()}`,
      );
    const importedId = (await imported.json()).pageId;
    const importedExport = Buffer.from(
      await waitForNewRevisionRender(r, args.base, token, importedId, -1),
    );
    save("round-trip-2-imported-export.png", importedExport);
    const importedScene = await scene(importedId);
    const strip = (s) => ({
      cleanups: s.cleanup_artifacts.map((c) => ({
        patch: s.assets.find((a) => a.asset_id === c.patch_asset_id).sha256,
        bounds: c.bounds,
        opacity: c.opacity ?? 1,
      })),
      text: s.objects
        .filter((o) => o.kind !== "manual_cleanup")
        .sort((a, b) => a.z_index - b.z_index)
        .map((o) => ({
          text: o.text,
          transform: o.transform,
          style: o.style,
          visible: o.visible,
        })),
    });
    // What each editor paints: the imported one must not add plates the export does not draw.
    const editorCounts = async (pageId) => {
      await openReader(pageId);
      await page.waitForTimeout(3000);
      return {
        patches: await page
          .locator('.svg-overlay [data-scene-layer="cleanup"] image')
          .count(),
        plates: await page.locator(".svg-overlay polygon").count(),
      };
    };
    report.round_trip_editor = {
      original: await editorCounts(id),
      imported: await editorCounts(importedId),
    };
    report.round_trip = {
      imported_page: importedId,
      series_id: series.id,
      project_zip_sha256: sha256(zipBytes),
      scene_without_ids_identical:
        JSON.stringify(strip(originalScene)) ===
        JSON.stringify(strip(importedScene)),
      render_vs_original: await comparePngs(
        browser,
        importedExport,
        originalExport,
      ),
      original_export_sha256: sha256(originalExport),
      imported_export_sha256: sha256(importedExport),
    };
  }

  // 5. Fallback: a region whose cleanup gave nothing keeps its plate; a patched region has none.
  if (args.plate) {
    const d = await details(args.plate);
    const regionById = new Map(
      d.ocrRegions.map((region) => [region.id, region]),
    );
    const plated = d.layers
      .filter((l) => l.layer.type === "translation" && l.layer.visible === true)
      .flatMap((l) => l.elements)
      .filter(
        (e) =>
          e.visible === true &&
          e.maskPolygon &&
          e.regionId &&
          (e.text || "").trim(),
      );
    await openReader(args.plate);
    await page
      .waitForFunction(
        () => document.querySelectorAll(".svg-overlay polygon").length > 0,
        null,
        { timeout: 60_000 },
      )
      .catch(() => {});
    const polygons = await page.$$eval(".svg-overlay polygon", (nodes) =>
      nodes.map((n) => n.getAttribute("points")),
    );
    const pts = (e) =>
      JSON.parse(e.maskPolygon)
        .map((p) => `${p[0]},${p[1]}`)
        .join(" ");
    const s = await scene(args.plate);
    report.fallback_plate = {
      no_patch_regions_with_plate: plated
        .filter((e) => !regionById.get(e.regionId)?.cleanupPatchSha256)
        .map((e) => ({
          element: e.id,
          drawn_in_editor: polygons.includes(pts(e)),
        })),
      patched_regions_drawing_a_plate: plated.filter(
        (e) =>
          regionById.get(e.regionId)?.cleanupPatchSha256 &&
          polygons.includes(pts(e)),
      ).length,
      export_plates: s.cleanup_artifacts.filter(
        (c) => c.generator_sha256 === LEGACY_GENERATOR,
      ).length,
    };
    await page.screenshot({
      path: path.join(args.out, "fallback-plate-editor-viewport.png"),
    });
  }

  // 6. Canonical downloads: the editor's "Export Page (PNG)" is the render artifact.
  report.downloads = [];
  for (const { name, id: pageId } of args.downloads) {
    await openReader(pageId);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByText("Export Page (PNG)", { exact: true }).click(),
    ]);
    const file = path.join(args.out, `download-${name}.png`);
    await download.saveAs(file);
    report.downloads.push({
      name,
      page_id: pageId,
      download_sha256: sha256(fs.readFileSync(file)),
    });
  }

  fs.writeFileSync(
    path.join(args.out, "behaviour.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
