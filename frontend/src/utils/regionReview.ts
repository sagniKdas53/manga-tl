import type { LayerElement, OcrRegion } from "../types";

/** Why a Translation row is not drawn, or why its region still needs a look. */
export function regionRowStatus(
  region: OcrRegion | undefined,
  element: LayerElement,
): { label: string; tone: "warning" | "muted" } | null {
  if (
    region?.qaStatus === "cleanup_review" ||
    region?.qaStatus === "manual_review"
  )
    return { label: "Review", tone: "warning" };
  if (element.visible === true) return null;
  if (region?.qaStatus === "rejected")
    return { label: "Rejected", tone: "muted" };
  if (region?.qaStatus === "reject_sfx") return { label: "SFX", tone: "muted" };
  if (region?.translationFailed) return { label: "Failed", tone: "warning" };
  if (!(element.text || "").trim())
    return { label: "Not translated", tone: "muted" };
  return null;
}

/** Elements in reading order, so both layers list regions #1..#n the same way. */
export function inReadingOrder(
  elements: LayerElement[],
  regionById: Map<string, OcrRegion>,
): LayerElement[] {
  const order = (e: LayerElement) =>
    (e.regionId && regionById.get(e.regionId)?.bubbleReadingOrder) ||
    Number.MAX_SAFE_INTEGER;
  return [...elements].sort((a, b) => order(a) - order(b));
}
