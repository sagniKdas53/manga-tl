#!/usr/bin/env node
/** Finalize visual A06-C classifications without inferring raw OCR memberships. */

const fs = require("fs");
const path = require("path");

const NON_DIALOGUE = new Set([
  "sample39-r005", "sample47-r001", "sample47-r004", "sample47-r005", "sample47-r006",
  "sample123-r002", "sample123-r004", "sample123-r012", "sample134-r003", "sample134-r006",
  "sample139-r008", "sample139-r010", "sample150-r005", "sample172-r006", "sample172-r009",
  "sample197-r005", "sample268-r003", "sample268-r004", "sample289-r004", "sample289-r005",
  "sample289-r007", "sample289-r009", "sample289-r012", "sample416-r001", "sample457-r001",
  "sample457-r002", "sample609-r001", "sample609-r002", "sample609-r004", "sample609-r005",
  "sample609-r006", "sample609-r010", "sample611-r002", "sample611-r004", "sample612-r004",
  "sample612-r006", "sample261-r012",
]);
const CAPTIONS = new Set([
  "sample139-r001", "sample150-r007", "sample197-r003", "sample289-r006", "sample320-r001",
  "sample320-r005", "sample320-r006", "sample360-r001", "sample457-r004",
]);
const BLOCKING_FUSIONS = new Set(["sample134-r001", "sample261-r008"]);
const SAMPLE7_NON_DIALOGUE = new Set(["s7-r11", "s7-r16", "s7-r17", "s7-r18", "s7-r19", "s7-r20", "s7-r21", "s7-r22", "s7-r23"]);
const SAMPLE7_CAPTIONS = new Set(["s7-r12", "s7-r13"]);

function main() {
  const [input, output, profile = "controls"] = process.argv.slice(2);
  if (!input || !output || !["controls", "sample7"].includes(profile)) {
    throw new Error("usage: finalize_a06c_control_review.cjs <draft.json> <reviewed.json> [controls|sample7]");
  }
  if (fs.existsSync(output)) throw new Error(`refusing to overwrite ${output}`);
  const payload = JSON.parse(fs.readFileSync(input, "utf8"));
  const labels = payload.sources.flatMap((source) => source.labels);
  const nonDialogue = profile === "sample7" ? SAMPLE7_NON_DIALOGUE : NON_DIALOGUE;
  const captions = profile === "sample7" ? SAMPLE7_CAPTIONS : CAPTIONS;
  const blockingFusions = profile === "sample7" ? new Set() : BLOCKING_FUSIONS;
  const known = new Set(labels.map((label) => label.id));
  for (const id of [...nonDialogue, ...captions, ...blockingFusions]) {
    if (!known.has(id)) throw new Error(`review decision refers to missing label: ${id}`);
  }

  for (const label of labels) {
    if (blockingFusions.has(label.id)) {
      label.owner_id = "unresolved";
      label.container_id = "unresolved";
      label.classification = "blocking-fused-final-region";
      label.review_state = "blocking";
      label.confidence = 0.0;
      label.evidence_basis = "Source-pixel review shows this retained final OCR box crosses independent source text extents. No owner or cleanup action is inferred without raw fragment evidence.";
    } else if (nonDialogue.has(label.id)) {
      label.owner_id = "none";
      label.container_id = "none";
      label.classification = "reviewed-non-dialogue";
      label.review_state = "reviewed";
      label.confidence = 0.95;
      label.evidence_basis = "Source-pixel review identifies this as SFX, a decorative mark, a credit, a logo, a counter, or another non-dialogue element. It is not assigned a dialogue owner or cleanup target.";
    } else if (captions.has(label.id)) {
      label.container_id = "none";
      label.classification = "reviewed-free-standing-caption";
      label.review_state = "reviewed";
      label.confidence = 0.9;
      label.evidence_basis = "Source-pixel review identifies one locally bounded free-standing caption or narration extent. It has no speech-balloon container and is not merged by proximity.";
    } else {
      label.container_id = `source-local:${label.id}`;
      label.classification = "reviewed-independent-dialogue";
      label.review_state = "reviewed";
      label.confidence = 0.95;
      label.evidence_basis = "Source-pixel review identifies one locally bounded dialogue extent. Its border/tail or local text area is independent of nearby balloons, gutters, and art; no raw fragment membership is inferred.";
    }
  }

  payload.schema_version = "a06-c-owner-labels-reviewed/v1";
  payload.status = "reviewed-with-explicit-blockers";
  payload.label_policy.verification_rule = "Each final OCR region received source-pixel review. A final-region owner is only a local source extent, not a claim about unavailable raw A02 fragment membership. Shared detector IDs, panels, conversations, and proximity never establish a shared owner.";
  payload.counts = {
    final_ocr_regions: labels.length,
    reviewed: labels.filter((label) => label.review_state === "reviewed").length,
    blocking: labels.filter((label) => label.review_state === "blocking").length,
    classifications: Object.groupBy(labels, (label) => label.classification),
    fragment_accounting: `Raw A02 fragment memberships remain unavailable. All retained final OCR regions are source-pixel reviewed; ${blockingFusions.size} fused final boxes remain explicit blockers.`,
  };
  for (const [kind, grouped] of Object.entries(payload.counts.classifications)) {
    payload.counts.classifications[kind] = grouped.length;
  }
  fs.writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
}

main();
