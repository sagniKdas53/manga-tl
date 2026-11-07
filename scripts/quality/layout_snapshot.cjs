#!/usr/bin/env node
// Records every page's text layout, so a later change can be traced to what it moved.
//
// For each region: the OCR pieces it holds (its key, stable across a re-OCR that groups them the
// same way), its boxes, its element's box, and the font px the renderer's own layout code fits
// from the stored text. Text is not written, only a hash, so a reworded translation shows as a
// wording change and not as a code effect.
//
// --what-if FILE fits with other boxes ({"<region id>": [x, y, w, h]}) and the same text, to see a
// change before any page is re-run.
//
// Read only. Uses the layout bundle and fonts inside the running renderer, and checks its fit
// against the sizes the renderer recorded for each page (`page_render_jobs.layout_json`).
//
//   node scripts/quality/layout_snapshot.cjs --db-container manga-tl-test-db-1 \
//     --renderer-container manga-tl-test-page-renderer-1 --label baseline --out snapshot.json

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const FONT_DIR = "/usr/share/fonts/opentype/comic-neue";
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
// The share of the smaller box two text boxes must have in common to count as overlapping. The
// same limit as NEIGHBOUR_OVERLAP_LIMIT in backend-rust/src/jobs/coordinator.rs.
const OVERLAP_SHARE = 0.1;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  for (const name of ["db-container", "renderer-container", "label", "out"]) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  return args;
}

const sha = (value, length = 12) => crypto.createHash("sha256").update(value).digest("hex").slice(0, length);

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function regionKey(region) {
  // A region of several pieces lists them; a region of one piece holds that piece itself.
  const single = region.provenance?.id?.startsWith("fragment-") ? [region.provenance.id] : [];
  const fragments = (region.provenance?.fragments ?? []).map((f) => f.fragment_id).filter(Boolean);
  const ids = fragments.length ? fragments : single;
  return ids.length ? `f-${sha([...ids].sort().join(","))}` : `r-${region.id.slice(0, 12)}`;
}

function overlapShare(a, b) {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a[2] * a[3], b[2] * b[3]);
}

function outline(raw) {
  let polygon = raw;
  if (typeof polygon === "string") {
    try {
      polygon = JSON.parse(polygon);
    } catch {
      return null;
    }
  }
  return Array.isArray(polygon) && polygon.length >= 3 ? polygon : null;
}

function outlineX(raw) {
  const polygon = outline(raw);
  if (!polygon) return null;
  const xs = polygon.map((point) => point[0]);
  return [Math.min(...xs), Math.max(...xs)];
}

function loadPages(psql) {
  const rows = psql(`select json_agg(json_build_object(
      'id', p.id, 'series', s.title, 'chapter', c.title, 'number', p.page_number, 'revision', p.scene_revision,
      'hand_edited', p.hand_edited_at is not null, 'scene', sn.scene_json,
      'layout', (select j.layout_json from page_render_jobs j where j.page_id = p.id and j.page_revision = p.scene_revision
                 and j.layout_json is not null order by j.created_at desc limit 1),
      'layout_at', (select j.completed_at from page_render_jobs j where j.page_id = p.id and j.page_revision = p.scene_revision
                 and j.layout_json is not null order by j.created_at desc limit 1),
      'regions', (select json_agg(json_build_object(
          'id', r.id, 'provenance', r.ownership_provenance, 'resolution', r.ownership_provenance->>'containerResolution',
          'bubble_id', r.bubble_id, 'type', r.region_type, 'rotation', r.rotation,
          'bbox', json_build_array(r.bbox_x, r.bbox_y, r.bbox_w, r.bbox_h),
          'bubble', json_build_array(r.bubble_x, r.bubble_y, r.bubble_w, r.bubble_h),
          'safe', json_build_array(r.safe_text_x, r.safe_text_y, r.safe_text_w, r.safe_text_h)))
        from ocr_regions r where r.page_id = p.id),
      'elements', (select json_agg(json_build_object(
          'id', e.id, 'region_id', e.region_id, 'hand', e.is_manually_edited, 'outline', e.mask_polygon))
        from layer_elements e join layers l on l.id = e.layer_id where l.page_id = p.id and l.type = 'translation'))
      order by s.title, c.title, p.page_number)
    from pages p join chapters c on c.id = p.chapter_id left join series s on s.id = c.series_id
    join page_scene_snapshots sn on sn.page_id = p.id and sn.revision = p.scene_revision`);
  return JSON.parse(rows);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = args["db-container"];
  const renderer = args["renderer-container"];
  const psql = (sql) =>
    execFileSync("docker", ["exec", "-i", db, "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], {
      input: sql,
      encoding: "utf8",
      maxBuffer: 2e9,
    }).trim();

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "layout-snapshot-"));
  const bundle = path.join(temp, "scene-static.js");
  execFileSync("docker", ["cp", "-q", `${renderer}:/app/dist/scene-static.js`, bundle]);
  const fonts = {};
  for (const name of ["ComicNeue-Regular.otf", "ComicNeue-Bold.otf"]) {
    const file = path.join(temp, name);
    execFileSync("docker", ["cp", "-qL", `${renderer}:${FONT_DIR}/${name}`, file]);
    fonts[name] = fs.readFileSync(file).toString("base64");
  }
  const rendererCreated = new Date(
    execFileSync("docker", ["inspect", "-f", "{{.Created}}", `${renderer}`], { encoding: "utf8" }).trim(),
  );
  const repo = path.resolve(__dirname, "../..");
  const image = (name) =>
    execFileSync("docker", ["inspect", "-f", "{{.Image}}", name], { encoding: "utf8" }).trim().slice(7, 19);
  const backend = db.replace(/-db-1$/, "-backend-1");
  const worker = db.replace(/-db-1$/, "-worker-1");
  const meta = {
    label: args.label,
    taken_at: new Date().toISOString(),
    repo_commit: git(["rev-parse", "--short", "HEAD"], repo),
    worker_commit: git(["rev-parse", "--short", "HEAD"], path.join(repo, "worker")),
    backend_image: image(backend),
    worker_image: image(worker),
    renderer_image: image(renderer),
    layout_bundle_sha256: sha(fs.readFileSync(bundle), 16),
    what_if: args["what-if"] ? path.basename(args["what-if"]) : null,
  };
  const whatIf = args["what-if"] ? JSON.parse(fs.readFileSync(args["what-if"], "utf8")) : {};

  const face =
    `@font-face{font-family:"Comic Neue";font-weight:100 599;src:url(data:font/otf;base64,${fonts["ComicNeue-Regular.otf"]})}` +
    `@font-face{font-family:"Comic Neue";font-weight:600 1000;src:url(data:font/otf;base64,${fonts["ComicNeue-Bold.otf"]})}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head><style>${face}</style></head><body></body></html>`);
  await page.evaluate(async () => {
    await document.fonts.load('700 16px "Comic Neue"', "a");
    await document.fonts.ready;
  });
  await page.addScriptTag({ path: bundle });
  const fit = (textObjects, width, height) =>
    page.evaluate(
      (input) => globalThis.PageSceneStatic.mountPageScene(input),
      { source: { href: BLANK, width, height }, cleanupAssets: [], textObjects },
    );

  const pages = [];
  let compared = 0;
  let agree = 0;
  const mismatches = [];
  for (const source of loadPages(psql)) {
    const doc = typeof source.scene === "string" ? JSON.parse(source.scene) : source.scene;
    const { width, height } = doc.page.source;
    const elements = new Map((source.elements ?? []).map((e) => [e.id, e]));
    const regions = new Map((source.regions ?? []).map((r) => [r.id, r]));
    const stored = new Map(((typeof source.layout === "string" ? JSON.parse(source.layout) : source.layout) ?? []).map((o) => [o.object_id, o]));
    const objects = [];
    for (const object of doc.objects) {
      if (object.kind === "manual_cleanup" || !object.text || !object.visible) continue;
      const element = elements.get(object.object_id.replace(/^text-/, ""));
      const t = object.transform;
      const box = element?.region_id && whatIf[element.region_id];
      const s = object.style;
      const style = { fontFamily: "Comic Neue", fill: s.fill, stroke: s.stroke, weight: s.weight, padding: s.padding, safetyPercent: 100 };
      if (s.font_size != null) style.fontSize = s.font_size;
      if (s.shape) style.shape = s.shape;
      const polygon = element && outline(element.outline);
      if (polygon) style.maskPolygon = polygon;
      objects.push({
        element,
        text: object.text,
        fit: {
          objectId: object.object_id,
          text: object.text,
          transform: {
            x: box ? box[0] : t.x,
            y: box ? box[1] : t.y,
            width: box ? box[2] : t.width,
            height: box ? box[3] : t.height,
            rotationDegrees: t.rotation_degrees,
          },
          writingMode: object.writing_mode,
          alignment: object.alignment,
          style,
          visible: true,
          zIndex: object.z_index,
        },
      });
    }
    const layout = objects.length ? await fit(objects.map((o) => o.fit), width, height) : { layout: [] };
    const fitted = new Map(layout.layout.map((o) => [o.object_id, o]));
    const drawn = new Map(objects.filter((o) => o.element?.region_id).map((o) => [o.element.region_id, o]));

    const rows = [];
    for (const region of regions.values()) {
      const object = drawn.get(region.id);
      const id = object?.fit.objectId;
      const result = id && fitted.get(id);
      const recorded = id && stored.get(id);
      // Only a render by this renderer can vouch for its layout code. Older ones drew with an older one.
      if (result && recorded && !whatIf[region.id] && new Date(source.layout_at) > rendererCreated) {
        compared += 1;
        if (result.font_size === recorded.font_size) agree += 1;
        else mismatches.push({ page: source.id, region: region.id, fitted: result.font_size, recorded: recorded.font_size });
      }
      const t = object?.fit.transform;
      rows.push({
        key: regionKey(region),
        region_id: region.id,
        resolution: region.resolution,
        bubble_id: region.bubble_id,
        type: region.type,
        rotation: region.rotation,
        bbox: region.bbox,
        bubble: region.bubble,
        safe: region.safe,
        box: t ? [t.x, t.y, t.width, t.height] : null,
        outline_x: outlineX(object?.element?.outline),
        px: result?.font_size ?? null,
        recorded_px: recorded?.font_size ?? null,
        lines: result?.lines?.length ?? null,
        hand: Boolean(object?.element?.hand),
        text_sha: object ? sha(object.text) : null,
      });
    }
    const drawnRows = rows.filter((r) => r.box);
    const overlaps = [];
    for (let i = 0; i < drawnRows.length; i += 1) {
      for (let j = i + 1; j < drawnRows.length; j += 1) {
        const share = overlapShare(drawnRows[i].box, drawnRows[j].box);
        if (share > OVERLAP_SHARE) overlaps.push([...[drawnRows[i].key, drawnRows[j].key].sort(), Number(share.toFixed(3))]);
      }
    }
    pages.push({
      page: source.id,
      label: `${source.series} / ${source.chapter} p${source.number}`,
      revision: source.revision,
      hand_edited: source.hand_edited,
      width,
      height,
      regions: rows.sort((a, b) => a.key.localeCompare(b.key)),
      overlaps: overlaps.sort(),
    });
  }
  await browser.close();
  fs.rmSync(temp, { recursive: true, force: true });
  meta.fit_check = { compared, agree, mismatches };
  fs.writeFileSync(args.out, `${JSON.stringify({ meta, pages }, null, 0)}\n`);
  const regionCount = pages.reduce((total, p) => total + p.regions.length, 0);
  console.log(`${args.label}: ${pages.length} pages, ${regionCount} regions`);
  console.log(`fit check: ${agree} of ${compared} elements match what the current renderer recorded`);
  for (const m of mismatches) console.log(`  differs ${m.page} ${m.region}: fitted ${m.fitted}, recorded ${m.recorded}`);
}

main().catch((error) => {
  console.error(String(error.stack || error).slice(0, 800));
  process.exit(1);
});
