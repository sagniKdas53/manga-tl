/**
 * #243: the OCR pieces a region was grouped from, for the editor's debug overlay.
 *
 * The worker stores a joined region's pieces in `ownership_provenance.fragments[]`
 * (`services/merge_regions.py`): each holds `provenance.sourceQuad` (four points in page pixels)
 * and, once the owner decision ran, `provenance.ownerDecision` with the reason it was grouped. A
 * region of one piece stores that piece's provenance itself, with no `fragments` (about half the
 * regions on the B test stack, 2026-10-07). Older rows, hand merges and regions from the fallback
 * path may lack any of it, so every field is read defensively.
 */
import type { OcrRegion } from "../types";

export interface OcrFragment {
  /** Position in the region, from 0. */
  index: number;
  quad: [number, number][];
  /** The owner decision's reason, e.g. `validated-container-continuous-lines`. */
  reason: string | null;
  /** `assigned`, `vetoed`, ... */
  state: string | null;
  /** The piece's long-axis angle in degrees, [0, 180). */
  angle: number | null;
  /** What OCR read in this piece, when the worker recorded it. */
  text: string | null;
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asQuad = (value: unknown): [number, number][] | null => {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const points = value.map((point) =>
    Array.isArray(point) &&
    point.length >= 2 &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1])
      ? ([point[0], point[1]] as [number, number])
      : null,
  );
  return points.every(Boolean) ? (points as [number, number][]) : null;
};

const asString = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

const pieceOf = (
  provenance: Record<string, unknown> | null,
  index: number,
  fallbackText: string | null,
): OcrFragment | null => {
  const quad = asQuad(provenance?.sourceQuad);
  if (!provenance || !quad) return null;
  const decision = asObject(provenance.ownerDecision);
  const angle = asObject(provenance.geometry)?.majorAxisDegrees;
  return {
    index,
    quad,
    reason: asString(decision?.reason),
    state: asString(decision?.state),
    angle: typeof angle === "number" && Number.isFinite(angle) ? angle : null,
    text: asString(provenance.text) ?? fallbackText,
  };
};

/** The region's pieces that have a quad, in stored order. */
export function ocrFragmentsOf(
  region: Pick<OcrRegion, "ownershipProvenance" | "text">,
): OcrFragment[] {
  const provenance = asObject(region.ownershipProvenance);
  const fragments = provenance?.fragments;
  if (!Array.isArray(fragments)) {
    // One piece: the region's own text is what OCR read in it.
    const piece = pieceOf(provenance, 0, asString(region.text?.trim()));
    return piece ? [piece] : [];
  }
  return fragments.flatMap((entry, position) => {
    const member = asObject(entry);
    const piece = pieceOf(
      asObject(member?.provenance),
      typeof member?.index === "number" ? member.index : position,
      null,
    );
    return piece ? [piece] : [];
  });
}

/** The hover text for one piece: its place, what OCR read, and why it was grouped. */
export function ocrFragmentLabel(
  fragment: OcrFragment,
  position: number,
  count: number,
): string {
  const lines = [`OCR piece ${position + 1} of ${count}`];
  if (fragment.text) lines.push(fragment.text);
  if (fragment.reason) {
    lines.push(
      fragment.state
        ? `${fragment.reason} (${fragment.state})`
        : fragment.reason,
    );
  }
  if (fragment.angle !== null) lines.push(`${Math.round(fragment.angle)}°`);
  return lines.join("\n");
}
