import { describe, expect, it } from "vitest";
import type { OcrRegion } from "../../types";
import {
  formatDegrees,
  isOcrAngle,
  ocrAngle,
  signedDegrees,
} from "../../utils/textAngle";

const region = (rotation: number, textAreaW: number | null = 300) =>
  ({ id: "r1", rotation, textAreaW }) as unknown as OcrRegion;

describe("signedDegrees", () => {
  it("reads a stored hand rotation of 342° as -18°", () => {
    expect(signedDegrees(342)).toBe(-18);
    expect(signedDegrees(336)).toBe(-24);
  });
  it("keeps OCR angles as they are", () => {
    expect(signedDegrees(-15.6)).toBeCloseTo(-15.6);
    expect(signedDegrees(45)).toBe(45);
  });
  it("treats missing values as level and 180/-180 as one angle", () => {
    expect(signedDegrees(undefined)).toBe(0);
    expect(signedDegrees(Number.NaN)).toBe(0);
    expect(signedDegrees(-180)).toBe(180);
    expect(signedDegrees(540)).toBe(180);
  });
});

describe("formatDegrees", () => {
  it("rounds to one decimal", () => {
    expect(formatDegrees(12.3456)).toBe("12.3°");
    expect(formatDegrees(342)).toBe("-18°");
    expect(formatDegrees(null)).toBe("0°");
  });
});

describe("ocrAngle and isOcrAngle", () => {
  it("is the region's angle only when the worker turned it", () => {
    expect(ocrAngle(region(12.5))).toBe(12.5);
    expect(ocrAngle(region(0))).toBeNull();
    // A rotation with no text area did not come from E2.
    expect(ocrAngle(region(12.5, null))).toBeNull();
    expect(ocrAngle(undefined)).toBeNull();
  });
  it("matches an element still at the OCR angle, in either convention", () => {
    expect(isOcrAngle(-15.6, region(-15.6))).toBe(true);
    expect(isOcrAngle(344.4, region(-15.6))).toBe(true);
    expect(isOcrAngle(0, region(-15.6))).toBe(false);
    expect(isOcrAngle(-10, region(-15.6))).toBe(false);
    expect(isOcrAngle(0, region(0))).toBe(false);
  });
});
