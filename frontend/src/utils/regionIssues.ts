import type { Layer, LayerElement, OcrRegion } from "../types";

/** A quick resolution the issues view offers. */
export type IssueAction =
  | "mask"
  | "reject"
  | "accept"
  | "delete"
  | "redo-translation"
  | "redo-ocr"
  | "edit"
  | "fit";

export type IssueKind =
  "cleanup" | "qa" | "failed" | "untranslated" | "overflow";

export interface RegionIssue {
  region: OcrRegion;
  /** The translation element that draws the region, when there is one. */
  element: LayerElement | undefined;
  kind: IssueKind;
  /** One line: what is wrong. */
  title: string;
  /** What it means for the page and what the actions do, in plain words. */
  explanation: string;
  /** The raw detector/QA text behind the finding, shown collapsed. */
  details: string | null;
  /** A suggestion that is not an action here, e.g. merging a fragment. */
  hint: string | null;
  actions: IssueAction[];
}

export const ISSUE_ACTION_LABELS: Record<IssueAction, string> = {
  mask: "Cover with plain mask",
  reject: "Keep original",
  accept: "Keep translation",
  delete: "Delete region",
  "redo-translation": "Redo translation",
  "redo-ocr": "Redo OCR",
  edit: "Type translation",
  fit: "Shrink to fit",
};

// QA says this when a bubble was split into pieces: "Fragment 「あたって」 … this bubble is a
// single sentence". Merging the pieces is the fix, so the issue says so.
const FRAGMENT_FEEDBACK =
  /fragment|single sentence|part of (a|the|one) (longer )?sentence/i;

const NO_TEXT_ACTIONS: IssueAction[] = [
  "redo-translation",
  "edit",
  "redo-ocr",
  "reject",
  "delete",
];

/**
 * What, if anything, needs a person on this region. `null` means nothing does: rejected and SFX
 * regions are settled decisions, shown in the layer list but never counted as work.
 */
export function regionIssue(
  region: OcrRegion,
  element: LayerElement | undefined,
  overflowing: boolean,
): RegionIssue | null {
  const base = { region, element, details: null, hint: null };
  switch (region.qaStatus) {
    case "rejected":
    case "reject_sfx":
      return null;
    case "cleanup_review":
      return {
        ...base,
        kind: "cleanup",
        title: "No lettering found here",
        explanation:
          "The text detector found nothing to erase in this box, so the translation is drawn over the original. Cover it with a plain mask, keep the original, or delete the box if it isn't text.",
        details: region.qaFeedback || null,
        actions: ["mask", "reject", "edit", "delete"],
      };
    case "manual_review":
    case "failed":
      return {
        ...base,
        kind: "qa",
        title: "QA flagged this translation",
        explanation:
          region.qaFeedback || "QA asked for a person to check this region.",
        hint:
          region.qaFeedback && FRAGMENT_FEEDBACK.test(region.qaFeedback)
            ? "This reads like one piece of a longer sentence. Use Merge regions to join it with its neighbours; the block is then cleaned and translated as one."
            : null,
        actions: ["redo-translation", "edit", "accept", "redo-ocr", "delete"],
      };
  }
  if (region.translationFailed) {
    return {
      ...base,
      kind: "failed",
      title: "Translation failed",
      explanation:
        "The translator returned nothing usable for this region, so the original is left showing.",
      actions: NO_TEXT_ACTIONS,
    };
  }
  if (!(element?.text || "").trim()) {
    return {
      ...base,
      kind: "untranslated",
      title: "Not translated",
      explanation:
        "OCR read this region but it has no translation, so the original is left showing.",
      actions: NO_TEXT_ACTIONS,
    };
  }
  if (overflowing) {
    return {
      ...base,
      kind: "overflow",
      title: "Text doesn't fit its box",
      explanation: element?.autoSize
        ? "The translation is taller than its box even at the smallest size (the red dotted outline). Make the box bigger or the text shorter."
        : "The translation is taller than its box (the red dotted outline). Shrink it to fit, or make the box bigger or the text shorter.",
      actions: element?.autoSize ? ["edit"] : ["fit", "edit"],
    };
  }
  return null;
}

/** Every region needing a person, in reading order. */
export function regionIssues(
  regions: OcrRegion[],
  elementByRegion: Map<string, LayerElement>,
  overflowingElementIds: Set<string>,
): RegionIssue[] {
  return regions
    .map((region) => {
      const element = elementByRegion.get(region.id);
      return regionIssue(
        region,
        element,
        !!element &&
          element.visible === true &&
          overflowingElementIds.has(element.id),
      );
    })
    .filter((issue): issue is RegionIssue => issue !== null)
    .sort(
      (a, b) =>
        (a.region.bubbleReadingOrder ?? Number.MAX_SAFE_INTEGER) -
        (b.region.bubbleReadingOrder ?? Number.MAX_SAFE_INTEGER),
    );
}

/**
 * The element that draws each region on the page: from the topmost visible translation layer that
 * has one, preferring a visible element. Region-redo overlays sit on top, so a redone bubble
 * resolves to its newest reading.
 */
export function translationElementByRegion(
  layers: { layer: Layer; elements: LayerElement[] }[],
): Map<string, LayerElement> {
  const byRegion = new Map<string, LayerElement>();
  const translationLayers = layers
    .filter((l) => l.layer.type === "translation" && l.layer.visible === true)
    .sort((a, b) => b.layer.zOrder - a.layer.zOrder);
  for (const { elements } of translationLayers) {
    for (const element of elements) {
      if (!element.regionId) continue;
      const seen = byRegion.get(element.regionId);
      if (!seen || (seen.visible !== true && element.visible === true)) {
        byRegion.set(element.regionId, element);
      }
    }
  }
  return byRegion;
}
