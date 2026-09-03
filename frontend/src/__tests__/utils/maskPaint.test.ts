import { describe, it, expect } from "vitest";
import { paintLayerMask } from "../../utils/maskPaint";
import type { LayerElement, OcrRegion } from "../../types";

/**
 * The overlap rule for erasure masks.
 *
 * 52 % of exported pages have overlapping element polygons, and before this helper every
 * exporter filled them in order so the *later* element destroyed the earlier one's sampled
 * backdrop (`docs/mask_precision_2026-08-27.md` §2). `paintLayerMask` inverts that with
 * `destination-over` compositing: first writer wins.
 *
 * What is NOT covered: pixel content. jsdom has no canvas, so these tests drive a recording
 * context and assert the draw calls rather than the resulting image — same limitation the
 * ZIP export test documents. What that still catches is every way the rule gets lost:
 * the composite mode being dropped, a `save`/`restore` pair clobbering it, elements being
 * reordered, or one bad polygon aborting the rest of the layer. Whether the pixels actually
 * land first-writer-wins is a browser check.
 */

interface FillCall {
  kind: "fill" | "fillRect";
  style: string;
  /** composite mode in force at the moment of the fill — this is the rule under test */
  op: string;
  /** accumulated rotation in force at the moment of the fill (AUDIT-R5) */
  rotation: number;
}

function recordingCtx() {
  const calls: FillCall[] = [];
  const ctx = {
    globalCompositeOperation: "source-over",
    fillStyle: "",
    _rotation: 0,
    _stack: [] as { op: string; rotation: number }[],
    save() {
      this._stack.push({
        op: this.globalCompositeOperation,
        rotation: this._rotation,
      });
    },
    restore() {
      const prev = this._stack.pop();
      if (prev !== undefined) {
        this.globalCompositeOperation = prev.op;
        this._rotation = prev.rotation;
      }
    },
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    ellipse() {},
    translate() {},
    rotate(radians: number) {
      this._rotation += (radians * 180) / Math.PI;
    },
    fill() {
      calls.push({
        kind: "fill",
        style: this.fillStyle,
        op: this.globalCompositeOperation,
        rotation: Math.round(this._rotation),
      });
    },
    fillRect() {
      calls.push({
        kind: "fillRect",
        style: this.fillStyle,
        op: this.globalCompositeOperation,
        rotation: Math.round(this._rotation),
      });
    },
  };
  return { ctx, calls };
}

function element(over: Partial<LayerElement> = {}): LayerElement {
  return {
    id: "e1",
    text: "hello",
    layerId: "l1",
    autoSize: false,
    wordWrap: true,
    rotation: 0,
    x: 0,
    y: 0,
    visible: true,
    overflow: false,
    isManuallyEdited: false,
    maxWidth: 100,
    maxHeight: 50,
    ...over,
  } as LayerElement;
}

const square = (n: number) =>
  JSON.stringify([
    [n, n],
    [n + 10, n],
    [n + 10, n + 10],
    [n, n + 10],
  ]);

const run = (els: LayerElement[]) => {
  const { ctx, calls } = recordingCtx();
  paintLayerMask(ctx as unknown as CanvasRenderingContext2D, els);
  return { ctx, calls };
};

describe("paintLayerMask", () => {
  it("fills every element behind what is already painted, so the first writer wins", () => {
    const { calls } = run([
      element({ id: "a", maskPolygon: square(0), backgroundColor: "#aaaaaa" }),
      element({ id: "b", maskPolygon: square(5), backgroundColor: "#bbbbbb" }),
    ]);

    expect(calls).toHaveLength(2);
    // Both fills must happen under destination-over — that is the whole mechanism. If a
    // save/restore ever resets it mid-layer, the later element silently starts winning again.
    expect(calls.every((c) => c.op === "destination-over")).toBe(true);
    // Order is preserved, which is what makes "first" mean the earlier element.
    expect(calls.map((c) => c.style)).toEqual(["#aaaaaa", "#bbbbbb"]);
  });

  it("restores the caller's composite mode", () => {
    const { ctx } = run([element({ maskPolygon: square(0) })]);
    expect(ctx.globalCompositeOperation).toBe("source-over");
  });

  it("skips invisible elements", () => {
    const { calls } = run([
      element({ id: "a", visible: false, maskPolygon: square(0) }),
      element({ id: "b", visible: true, maskPolygon: square(5) }),
    ]);
    expect(calls).toHaveLength(1);
  });

  it("keeps painting the rest of the layer when one polygon is malformed", () => {
    const { calls } = run([
      element({
        id: "a",
        maskPolygon: "{not json",
        backgroundColor: "#aaaaaa",
      }),
      element({ id: "b", maskPolygon: square(5), backgroundColor: "#bbbbbb" }),
    ]);
    expect(calls.map((c) => c.style)).toEqual(["#bbbbbb"]);
  });

  it("falls back to the element box when there is no polygon", () => {
    const { calls } = run([
      element({ boxShape: "rectangular", backgroundColor: "#cccccc" }),
      element({ boxShape: "elliptical", backgroundColor: "#dddddd" }),
    ]);
    expect(calls.map((c) => c.kind)).toEqual(["fillRect", "fill"]);
    expect(calls.every((c) => c.op === "destination-over")).toBe(true);
  });

  // An element with no text must not erase: the mask would wipe the artwork and put nothing
  // back. That is the "empty bubble", and it is what SFX regions produce -- correctly left
  // untranslated, but masked anyway until this rule.
  it.each([
    ["null", null],
    ["empty", ""],
    ["whitespace", "   \n "],
  ])("does not erase an element whose text is %s", (_label, text) => {
    const { calls } = run([
      element({ id: "a", text, maskPolygon: square(0) }),
      element({ id: "b", text: "kept", maskPolygon: square(5) }),
    ]);
    expect(calls).toHaveLength(1);
  });

  it("turns the box fill with the element but leaves the polygon alone (AUDIT-R5)", () => {
    // `rotation` is the angle of the *box*, which is stored unrotated. A maskPolygon is the
    // opposite: already in absolute page coordinates with the angle baked in. Turning both would
    // double-rotate the plate; turning neither is what laid a straight white rectangle across
    // artwork beside every rotated caption.
    const region = {
      id: "r1",
      bboxW: 40,
      bboxH: 40,
      bubbleW: 40,
      bubbleH: 40,
    } as unknown as OcrRegion;
    const { ctx, calls } = recordingCtx();
    paintLayerMask(
      ctx as unknown as CanvasRenderingContext2D,
      [element({ regionId: "r1", maskPolygon: square(0), rotation: 30 })],
      new Map([["r1", region]]),
    );

    expect(calls.map((c) => [c.kind, c.rotation])).toEqual([
      ["fill", 0], // the polygon: page-space, never turned again
      ["fillRect", 30], // the box: stored unrotated, so it turns here
    ]);
  });

  it("turns a box-only element too, with no polygon in play", () => {
    const { ctx, calls } = recordingCtx();
    paintLayerMask(ctx as unknown as CanvasRenderingContext2D, [
      element({ rotation: 45 }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].rotation).toBe(45);
  });

  it("leaves an unrotated element's transform untouched", () => {
    const { ctx, calls } = recordingCtx();
    paintLayerMask(ctx as unknown as CanvasRenderingContext2D, [
      element({ rotation: 0 }),
    ]);
    expect(calls[0].rotation).toBe(0);
  });

  it("still erases a blank element an editor blanked on purpose", () => {
    // Deliberately clearing the text is how a clean plate is requested -- erase, place nothing.
    const { calls } = run([
      element({ text: "", isManuallyEdited: true, maskPolygon: square(0) }),
    ]);
    expect(calls).toHaveLength(1);
  });

  it("defaults a missing backgroundColor to white", () => {
    const { calls } = run([
      element({ maskPolygon: square(0), backgroundColor: null }),
    ]);
    expect(calls.at(0)?.style).toBe("#ffffff");
  });
});
