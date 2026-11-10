import { describe, expect, it } from "vitest";
import type { ElementFit } from "../../utils/elementFit";
import {
  collisionsByRegion,
  drawnTexts,
  elementLineBoxes,
  quadsOverlap,
  sidesToChange,
  textCollisions,
  turnedCorners,
  type DrawnText,
} from "../../utils/textCollisions";
import { regionIssue, regionIssues } from "../../utils/regionIssues";
import type { LayerElement, OcrRegion } from "../../types";

// Every character measures 10 px, so a line's width is 10 × its length.
const measure = (_font: string, text: string) => text.length * 10;

const element = (id: string, extra: Partial<LayerElement> = {}) =>
  ({
    id,
    regionId: `r-${id}`,
    text: "あいうえお",
    visible: true,
    x: 0,
    y: 0,
    maxWidth: 100,
    maxHeight: 40,
    rotation: 0,
    isManuallyEdited: false,
    ...extra,
  }) as unknown as LayerElement;

const region = (id: string, order: number, extra: Partial<OcrRegion> = {}) =>
  ({
    id,
    text: "かきく",
    bubbleReadingOrder: order,
    bboxX: 0,
    bboxY: 0,
    bboxW: 100,
    bboxH: 40,
    ...extra,
  }) as unknown as OcrRegion;

/** One line, centred in the element's box, at 20 px. */
const oneLine = (el: LayerElement, line = el.text || ""): ElementFit => ({
  box: {
    x: el.x,
    y: el.y,
    width: el.maxWidth || 100,
    height: el.maxHeight || 40,
  },
  fit: {
    fontSize: 20,
    lines: [line],
    overflow: false,
    lineCenters: [el.x + (el.maxWidth || 100) / 2],
  },
  fontSize: 20,
  overflow: false,
});

const drawn = (...elements: LayerElement[]): DrawnText[] =>
  drawnTexts(elements, (el) => oneLine(el), measure);

describe("elementLineBoxes", () => {
  it("places lines as the renderer does: centred, 1.2 × the size apart, measured wide", () => {
    const el = element("a", { x: 100, y: 200, maxWidth: 200, maxHeight: 100 });
    const fit: ElementFit = {
      box: { x: 100, y: 200, width: 200, height: 100 },
      fit: {
        fontSize: 20,
        lines: ["あい", "うえおか"],
        overflow: false,
        lineCenters: [200, 200],
      },
      fontSize: 20,
      overflow: false,
    };
    const [first, second] = elementLineBoxes(el, fit, measure);
    // Two lines of 24 px centred on y = 250: centres at 238 and 262.
    expect(first).toEqual({ x: 190, y: 226, width: 20, height: 24 });
    expect(second).toEqual({ x: 180, y: 250, width: 40, height: 24 });
  });

  it("keeps a line inside its fit box when its fitted centre would push it out", () => {
    const el = element("a", { x: 0, y: 0, maxWidth: 100, maxHeight: 40 });
    const fit = oneLine(el, "あいうえお");
    fit.fit.lineCenters = [10];
    expect(elementLineBoxes(el, fit, measure)[0].x).toBe(0);
  });
});

describe("textCollisions", () => {
  it("finds two texts whose lines share area", () => {
    // a's line runs 25..75, b's 65..115.
    const a = element("a", { x: 0 });
    const b = element("b", { x: 40 });
    expect(textCollisions(drawn(a, b))).toEqual([["a", "b"]]);
  });

  it("leaves boxes alone that overlap only in their padding", () => {
    // The boxes share 40 px, but each 50 px line sits in the middle of its 100 px box.
    const a = element("a", { x: 0 });
    const b = element("b", { x: 60, text: "あい" });
    expect(textCollisions(drawn(a, b))).toEqual([]);
  });

  it("does not count lines that only touch", () => {
    expect(
      quadsOverlap(
        turnedCorners({ x: 0, y: 0, width: 10, height: 10 }, element("a")),
        turnedCorners({ x: 10, y: 0, width: 10, height: 10 }, element("b")),
      ),
    ).toBe(false);
  });

  it("turns lines with their element, so an angled text is caught where its level box is clear", () => {
    // Level, b's line (y 58..82) is below a's (y 8..32). Turned 60° about its centre, a's long
    // line swings down into it.
    const a = element("a", { text: "あいうえおかきくけ", maxWidth: 100 });
    const b = element("b", { y: 50, text: "あいうえおかきくけ" });
    const fitOf = (el: LayerElement) => oneLine(el);
    expect(textCollisions(drawnTexts([a, b], fitOf, measure))).toEqual([]);
    const turned = { ...a, rotation: 60 } as LayerElement;
    expect(textCollisions(drawnTexts([turned, b], fitOf, measure))).toEqual([
      ["a", "b"],
    ]);
  });

  it("ignores hidden and empty elements", () => {
    const a = element("a", { x: 0 });
    expect(textCollisions(drawn(a, element("b", { x: 40 })))).toHaveLength(1);
    expect(
      textCollisions(drawn(a, element("b", { x: 40, visible: false }))),
    ).toEqual([]);
    expect(
      textCollisions(drawn(a, element("b", { x: 40, text: "  " }))),
    ).toEqual([]);
  });
});

describe("sidesToChange (overlap_shrink.rs keeps_its_shape)", () => {
  const side = (id: string, el: Partial<LayerElement>, area: number) => ({
    element: element(id, el),
    region: region(`r-${id}`, 1, { bboxW: area, bboxH: 1 }),
  });

  it("a hand-edited box keeps its shape", () => {
    const hand = side("a", { isManuallyEdited: true }, 10);
    const machine = side("b", {}, 1000);
    expect(sidesToChange(hand, machine)).toEqual([machine]);
  });

  it("two hand-edited boxes both need a person", () => {
    const a = side("a", { isManuallyEdited: true }, 10);
    const b = side("b", { isManuallyEdited: true }, 10);
    expect(sidesToChange(a, b)).toEqual([a, b]);
  });

  it("the bigger source footprint keeps its shape", () => {
    const big = side("a", { text: "あ" }, 1000);
    const small = side("b", { text: "あいうえおかきくけこ" }, 800);
    expect(sidesToChange(big, small)).toEqual([small]);
  });

  it("within 15 % the longer text keeps its shape", () => {
    const long = side("a", { text: "あいうえお" }, 1000);
    const short = side("b", { text: "あい" }, 1100);
    expect(sidesToChange(long, short)).toEqual([short]);
  });
});

describe("overlap issues", () => {
  it("puts one issue on the side that should change, naming the other bubble", () => {
    const a = element("a", { x: 0 });
    const b = element("b", { x: 40 });
    const regions = [
      region("r-a", 1, { bboxW: 200 }),
      region("r-b", 2, { bboxW: 50 }),
    ];
    const collisions = collisionsByRegion(
      drawn(a, b),
      new Map(regions.map((r) => [r.id, r])),
    );
    const issues = regionIssues(
      regions,
      new Map([
        ["r-a", a],
        ["r-b", b],
      ]),
      new Set(),
      collisions,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].region.id).toBe("r-b");
    expect(issues[0].kind).toBe("overlap");
    expect(issues[0].explanation).toContain("bubble 1");
  });

  it("says when angled text is why the shrink left it", () => {
    const issue = regionIssue(region("r-a", 1), element("a"), false, {
      other: region("r-b", 2),
      turned: true,
    });
    expect(issue?.explanation).toContain("angle");
  });

  it("an overflow on the same region is shown first", () => {
    const issue = regionIssue(region("r-a", 1), element("a"), true, {
      other: undefined,
      turned: false,
    });
    expect(issue?.kind).toBe("overflow");
  });
});
