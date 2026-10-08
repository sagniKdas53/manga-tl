import { describe, expect, it } from "vitest";
import { ocrFragmentLabel, ocrFragmentsOf } from "../../utils/ocrFragments";

const QUAD = [
  [1, 2],
  [3, 2],
  [3, 8],
  [1, 8],
];

describe("ocrFragmentsOf (#243)", () => {
  it("reads each stored piece's quad and owner decision", () => {
    const fragments = ocrFragmentsOf({
      text: "joined",
      ownershipProvenance: {
        fragments: [
          {
            index: 3,
            fragment_id: "fragment-a",
            provenance: {
              sourceQuad: QUAD,
              geometry: { majorAxisDegrees: 88.8 },
              ownerDecision: { state: "assigned", reason: "geometry" },
            },
          },
        ],
        containerResolution: {},
      },
    });
    expect(fragments).toEqual([
      {
        index: 3,
        quad: QUAD,
        reason: "geometry",
        state: "assigned",
        angle: 88.8,
        text: null,
      },
    ]);
    expect(ocrFragmentLabel(fragments[0], 0, 1)).toBe(
      "OCR piece 1 of 1\ngeometry (assigned)\n89°",
    );
  });

  it("reads a one-piece region, whose provenance is the piece itself", () => {
    const [piece, ...rest] = ocrFragmentsOf({
      text: " はは ",
      ownershipProvenance: {
        id: "fragment-b",
        sourceQuad: QUAD,
        geometry: { majorAxisDegrees: 0 },
      },
    });
    expect(rest).toEqual([]);
    expect(piece).toMatchObject({ index: 0, quad: QUAD, text: "はは" });
    expect(ocrFragmentLabel(piece, 0, 1)).toBe("OCR piece 1 of 1\nはは\n0°");
  });

  it("skips what has no usable quad, and reads nothing from older rows", () => {
    expect(ocrFragmentsOf({ text: "x", ownershipProvenance: null })).toEqual(
      [],
    );
    expect(
      ocrFragmentsOf({ text: "x", ownershipProvenance: { mergedFrom: [] } }),
    ).toEqual([]);
    const fragments = ocrFragmentsOf({
      text: "joined",
      ownershipProvenance: {
        fragments: [
          { index: 0, provenance: { sourceQuad: [[1, 2]] } },
          {
            index: 1,
            provenance: {
              sourceQuad: [
                [1, 2],
                [3, 2],
                [3, "x"],
                [1, 8],
              ],
            },
          },
          { index: 2 },
          { index: 3, provenance: { sourceQuad: QUAD, text: "やあ" } },
        ],
      },
    });
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({
      index: 3,
      reason: null,
      text: "やあ",
    });
    expect(ocrFragmentLabel(fragments[0], 0, 1)).toBe("OCR piece 1 of 1\nやあ");
  });
});
