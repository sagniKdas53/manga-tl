#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index++) {
    const value = argv[index];
    if (!value.startsWith("--")) throw new Error(`unknown argument: ${value}`);
    args[value.slice(2)] = argv[++index];
  }
  for (const name of ["selection", "run", "out"]) {
    if (!args[name]) throw new Error(`missing --${name}`);
  }
  return args;
}

function buildOwnerDrafts(selection, run) {
  const manifestPages = new Map(run.pages.map((page) => [page.sample, page]));
  const sources = selection.samples
    .filter((sample) => sample.id !== "sample7")
    .map((sample) => {
      const page = manifestPages.get(sample.id);
      if (!page) throw new Error(`${sample.id}: missing fresh run page`);
      if (sha256(sample.source) !== sample.sha256 || page.source_sha256 !== sample.sha256) {
        throw new Error(`${sample.id}: source digest mismatch`);
      }
      const snapshotPath = path.join(path.dirname(args.run), "a04-exports", sample.id, "page-snapshot.json");
      const snapshot = readJson(snapshotPath);
      const labels = snapshot.ocrRegions.map((region, index) => ({
        id: `${sample.id}-r${String(index + 1).padStart(3, "0")}`,
        owner_id: `${sample.id}-owner-r${String(index + 1).padStart(3, "0")}`,
        container_id: "unresolved",
        fragment_member_identity: `final OCR region ${region.id}; raw A02 members absent`,
        geometry: {
          coordinate_space: "source-pixels",
          role: "final OCR bbox",
          bbox: [region.bboxX, region.bboxY, region.bboxW, region.bboxH],
        },
        confidence: 0.5,
        evidence_basis: "Conservative initial owner draft from one retained final OCR region. Detector bubble IDs, panels, conversations, and proximity do not establish a shared owner or container.",
        review_state: "draft",
      }));
      return {
        sample: sample.id,
        language: sample.language,
        style: sample.style,
        source_path: sample.source,
        source_digest: sample.sha256,
        dimensions: { width: sample.width, height: sample.height },
        current_ocr_artifact: `a04-exports/${sample.id}/page-snapshot.json`,
        final_ocr_region_count: labels.length,
        raw_a02_fragment_capture: "absent",
        labels,
      };
    });
  const finalRegions = sources.reduce((total, source) => total + source.final_ocr_region_count, 0);
  return {
    schema_version: "a06-c-owner-labels-draft/v1",
    task: "A06-C",
    status: "coordinator-review-required",
    label_policy: {
      coordinate_space: "source-pixels",
      verification_rule: "Every final OCR region starts as a separate draft owner. Shared detector bubble IDs, panel/conversation membership, and proximity cannot merge owners. Raw A02 fragment evidence is absent.",
    },
    sources,
    counts: {
      sources: sources.length,
      final_ocr_regions: finalRegions,
      labels: { draft: finalRegions, total: finalRegions },
    },
  };
}

const args = parseArgs(process.argv);
const selection = readJson(args.selection);
const run = readJson(args.run);
fs.writeFileSync(args.out, `${JSON.stringify(buildOwnerDrafts(selection, run), null, 2)}\n`);
