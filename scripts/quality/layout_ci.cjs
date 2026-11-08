#!/usr/bin/env node
// CI's layout check: the renderer's own layout code on stored boxes and outlines, with stand-in text.
//
// The fixture holds no page images and no page text, so it can live in a public repo. Each text object
// keeps its box, outline, style and the lengths of its words, and the words become neutral letters.
// Any change to how text fits, in `packages/page-scene` or the renderer, shows up as a size or a line
// count that differs from the fixture.
//
//   Check, in the renderer image, which has the bundle, fonts and browser the export uses:
//     node scripts/quality/layout_ci.cjs --fixture scripts/quality/fixtures/layout-fixture.json
//
//   When a change to layout is meant, rewrite it, and add a row to the ledger. Boxes come from a stack,
//   on the host; the expected sizes from the renderer image:
//     node scripts/quality/layout_ci.cjs --fixture <file> --dump --db-container manga-tl-test-db-1
//     node scripts/quality/layout_ci.cjs --fixture <file> --write
//
//   Fit any text objects, for layout_snapshot.cjs: pages as {"pages":[{page,width,height,objects}]} on
//   stdin, {page: {objectId: [font px, lines]}} on stdout. Run in the renderer, so the fit uses its own
//   browser and font fallback (a symbol Comic Neue lacks falls back differently on a host, #325):
//     docker exec -i <renderer> node /tmp/layout_ci.cjs --fit < pages.json

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RENDERER_APP = process.env.RENDERER_APP || "/app";

const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const LETTERS = "enaosuricmvtxzdhlwbgpkyfj";

const opaque = (value) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);

/** The same word lengths and line breaks in neutral letters, so nothing of the page's text is kept. */
function standIn(text, seed) {
  let at = seed;
  return text
    .split("\n")
    .map((line) =>
      line
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => {
          let out = "";
          for (let i = 0; i < [...word].length; i += 1) {
            out += LETTERS[at % LETTERS.length];
            at += 7;
          }
          return out;
        })
        .join(" "),
    )
    .join("\n");
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--write") out.write = true;
    else if (argv[i] === "--dump") out.dump = true;
    else if (argv[i] === "--fit") out.fit = true;
    else out[argv[i].slice(2)] = argv[(i += 1)];
  }
  if (!out.fixture && !out.fit) throw new Error("--fixture is required");
  return out;
}

function readScenes(container) {
  const psql = (sql) =>
    execFileSync("docker", ["exec", "-i", container, "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], {
      input: sql,
      encoding: "utf8",
      maxBuffer: 2e9,
    }).trim();
  const rows = JSON.parse(
    psql(`select json_agg(json_build_object('id', p.id, 'scene', sn.scene_json,
        'outlines', (select json_object_agg(e.id, e.mask_polygon) from layer_elements e join layers l on l.id = e.layer_id
                     where l.page_id = p.id and l.type = 'translation' and e.mask_polygon is not null)) order by p.id)
      from pages p join page_scene_snapshots sn on sn.page_id = p.id and sn.revision = p.scene_revision`),
  );
  return rows.map((row) => {
    const doc = typeof row.scene === "string" ? JSON.parse(row.scene) : row.scene;
    const objects = [];
    doc.objects.forEach((object, index) => {
      if (object.kind === "manual_cleanup" || !object.text || !object.visible) return;
      const s = object.style;
      const t = object.transform;
      const style = { fontFamily: "Comic Neue", fill: "#000000", stroke: s.stroke ? "#ffffff" : "", weight: s.weight, padding: s.padding, safetyPercent: 100 };
      if (s.font_size != null) style.fontSize = s.font_size;
      if (s.font_style) style.fontStyle = s.font_style;
      if (s.shape) style.shape = s.shape;
      let outline = row.outlines?.[object.object_id.replace(/^text-/, "")] ?? null;
      if (typeof outline === "string") {
        try {
          outline = JSON.parse(outline);
        } catch {
          outline = null;
        }
      }
      if (Array.isArray(outline) && outline.length >= 3) style.maskPolygon = outline;
      objects.push({
        objectId: `t${index}`,
        text: standIn(object.text, index * 13),
        transform: { x: t.x, y: t.y, width: t.width, height: t.height, rotationDegrees: t.rotation_degrees },
        writingMode: object.writing_mode,
        alignment: object.alignment,
        style,
        visible: true,
        zIndex: object.z_index,
      });
    });
    return { page: opaque(row.id), width: doc.page.source.width, height: doc.page.source.height, objects };
  });
}

async function openLayout() {
  const { chromium } = require(require.resolve("playwright", { paths: [RENDERER_APP, process.cwd()] }));
  const fontDir = "/usr/share/fonts/opentype/comic-neue";
  const font = (name) => fs.readFileSync(path.join(fontDir, name)).toString("base64");
  const face =
    `@font-face{font-family:"Comic Neue";font-weight:100 599;src:url(data:font/otf;base64,${font("ComicNeue-Regular.otf")})}` +
    `@font-face{font-family:"Comic Neue";font-weight:600 1000;src:url(data:font/otf;base64,${font("ComicNeue-Bold.otf")})}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head><style>${face}</style></head><body></body></html>`);
  await page.evaluate(async () => {
    await document.fonts.load('700 16px "Comic Neue"', "a");
    await document.fonts.load('400 16px "Comic Neue"', "a");
    await document.fonts.ready;
  });
  await page.addScriptTag({ path: path.join(RENDERER_APP, "dist/scene-static.js") });
  return { browser, page };
}

async function fitPage(layoutPage, entry) {
  if (!entry.objects.length) return {};
  const result = await layoutPage.evaluate((input) => globalThis.PageSceneStatic.mountPageScene(input), {
    source: { href: BLANK, width: entry.width, height: entry.height },
    cleanupAssets: [],
    textObjects: entry.objects,
  });
  return Object.fromEntries(result.layout.map((o) => [o.object_id, [o.font_size, o.lines.length]]));
}

function save(file, pages) {
  fs.writeFileSync(file, `{"pages":[\n${pages.map((entry) => JSON.stringify(entry)).join(",\n")}\n]}\n`);
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.dump) {
    if (!options["db-container"]) throw new Error("--dump needs --db-container");
    const pages = readScenes(options["db-container"]);
    save(options.fixture, pages);
    console.log(`dumped ${pages.length} pages, ${pages.reduce((n, p) => n + p.objects.length, 0)} text objects`);
    return;
  }
  const { browser, page } = await openLayout();
  try {
    if (options.fit) {
      const { pages } = JSON.parse(fs.readFileSync(0, "utf8"));
      const out = {};
      for (const entry of pages) out[entry.page] = await fitPage(page, entry);
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return;
    }
    if (options.write) {
      const { pages } = JSON.parse(fs.readFileSync(options.fixture, "utf8"));
      for (const entry of pages) entry.expected = await fitPage(page, entry);
      save(options.fixture, pages);
      console.log(`wrote ${pages.length} pages, ${pages.reduce((n, p) => n + p.objects.length, 0)} text objects`);
      return;
    }
    const { pages } = JSON.parse(fs.readFileSync(options.fixture, "utf8"));
    let objects = 0;
    const differences = [];
    for (const entry of pages) {
      const fitted = await fitPage(page, entry);
      for (const [id, want] of Object.entries(entry.expected)) {
        objects += 1;
        const got = fitted[id];
        if (!got || got[0] !== want[0] || got[1] !== want[1]) differences.push({ page: entry.page, id, want, got });
      }
    }
    console.log(`${objects} text objects on ${pages.length} pages, ${differences.length} differ`);
    for (const d of differences.slice(0, 40)) {
      console.log(`  page ${d.page} ${d.id}: expected ${d.want[0]} px, ${d.want[1]} lines; got ${d.got ? `${d.got[0]} px, ${d.got[1]} lines` : "nothing"}`);
    }
    if (differences.length) {
      console.log("Text layout changed. If that's meant, rewrite the fixture and add a row to the layout ledger:");
      console.log("docs/quality-runs/layout-regression/README.md");
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(String(error.stack || error).slice(0, 800));
  process.exit(1);
});
