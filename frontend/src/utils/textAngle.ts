/**
 * E2 (#180): angles in the editor, and whether an element's angle came from OCR.
 *
 * Two conventions meet here. The worker writes an OCR angle as a line direction in [-90, 90)
 * (clockwise positive, y down), while a hand rotation has been stored as 0–360 (a -18° turn is
 * 342). The sidebar shows and edits both as one signed angle in (-180, 180].
 */
import type { OcrRegion } from "../types";

/** An angle in (-180, 180], so -18° and 342° read the same. */
export const signedDegrees = (degrees: number | null | undefined): number => {
  if (degrees == null || !Number.isFinite(degrees)) return 0;
  const wrapped = ((((degrees + 180) % 360) + 360) % 360) - 180;
  // The wrap leaves float dust (-15.6 comes back -15.599999999999994); no angle needs 1e-6°.
  const clean = Math.round(wrapped * 1e6) / 1e6;
  return clean === -180 ? 180 : clean;
};

/** One decimal for the label: "12.3°", "-18°". */
export const formatDegrees = (degrees: number | null | undefined): string =>
  `${Math.round(signedDegrees(degrees) * 10) / 10}°`;

/** The angle OCR found for a region's text, or null when the worker left it level. */
export const ocrAngle = (
  region: OcrRegion | null | undefined,
): number | null => {
  if (!region) return null;
  const angle = signedDegrees(region.rotation);
  // The worker sets a text area on every region it turns; a rotation without one is not E2's.
  return angle !== 0 && (region.textAreaW ?? 0) > 0 ? angle : null;
};

/** Is the element still at the angle OCR gave it? */
export const isOcrAngle = (
  elementRotation: number | null | undefined,
  region: OcrRegion | null | undefined,
): boolean => {
  const angle = ocrAngle(region);
  return (
    angle !== null &&
    Math.abs(signedDegrees(signedDegrees(elementRotation) - angle)) < 0.05
  );
};
