import { describe, expect, it, vi } from "vitest";
import type { Layer, LayerElement, OcrRegion } from "../../types";
import {
  clearSceneAssetCache,
  loadSceneAssetUrl,
  peekSceneAssetUrl,
  paintedPatches,
  regionAllowsPatch,
  regionHasPatch,
} from "../../utils/inpainting";

/**
 * Tracker R7: the editor must paint the patches the export paints, in the same order. These rules
 * mirror `build_pipeline_scene`; `tests/inpainting_layer.rs` pins the backend side.
 */

const layer = (id: string, over: Partial<Layer> = {}): Layer => ({
  id,
  type: "inpainting",
  visible: true,
  zOrder: 0,
  createdAt: "2026-09-27T00:00:00Z",
  ...over,
});

const patch = (
  id: string,
  layerId: string,
  order: number,
  over: Partial<LayerElement> = {},
): LayerElement => ({
  id,
  layerId,
  regionId: null,
  autoSize: false,
  wordWrap: false,
  rotation: 0,
  x: 10,
  y: 20,
  maxWidth: 30,
  maxHeight: 40,
  visible: true,
  overflow: false,
  isManuallyEdited: false,
  cleanupRef: {
    patchSha256: id.padEnd(64, "0"),
    patchByteLength: 1,
    maskSha256: "m".padEnd(64, "0"),
    maskByteLength: 1,
    generatorSha256: "0".repeat(64),
    bounds: { x: 10, y: 20, width: 30, height: 40 },
    order,
  },
  ...over,
});

const region = (id: string, over: Partial<OcrRegion> = {}): OcrRegion =>
  ({
    id,
    text: "テキスト",
    translatedText: "Text",
    detectedLanguage: "ja",
    confidence: 1,
    rotation: 0,
    bboxX: 0,
    bboxY: 0,
    bboxW: 10,
    bboxH: 10,
    panelReadingOrder: 1,
    bubbleReadingOrder: 1,
    cleanupPatchSha256: "a".repeat(64),
    ...over,
  }) as OcrRegion;

describe("paintedPatches", () => {
  it("paints layer by layer (z, then age), then by each patch's stored order", () => {
    const older = layer("L-old", { zOrder: -1 });
    const newer = layer("L-new", { zOrder: 0 });
    const painted = paintedPatches(
      [
        {
          layer: newer,
          elements: [patch("n2", "L-new", 2), patch("n1", "L-new", 1)],
        },
        { layer: older, elements: [patch("o1", "L-old", 5)] },
      ],
      [],
    );
    expect(painted.map((p) => p.element.id)).toEqual(["o1", "n1", "n2"]);
  });

  it("breaks an order tie by id the way Postgres sorts uuids", () => {
    const L = layer("L");
    const painted = paintedPatches(
      [
        {
          layer: L,
          elements: [
            patch("b-2", "L", 0),
            patch("a-9", "L", 0),
            patch("B-1", "L", 0),
          ],
        },
      ],
      [],
    );
    // Plain code-unit order: "B" < "a" < "b". localeCompare would put "a" first.
    expect(painted.map((p) => p.element.id)).toEqual(["B-1", "a-9", "b-2"]);
  });

  it("leaves out hidden layers, hidden or null-visible patches, and sizeless ones", () => {
    const shown = layer("shown");
    const hidden = layer("hidden", { visible: false });
    const painted = paintedPatches(
      [
        {
          layer: shown,
          elements: [
            patch("ok", "shown", 0),
            patch("off", "shown", 1, { visible: false }),
            patch("null", "shown", 2, { visible: null }),
            patch("flat", "shown", 3, { maxHeight: 0 }),
          ],
        },
        { layer: hidden, elements: [patch("history", "hidden", 0)] },
      ],
      [],
    );
    expect(painted.map((p) => p.element.id)).toEqual(["ok"]);
  });

  it("draws the edited rect and opacity, and no opacity when opaque", () => {
    const L = layer("L");
    const [moved, opaque] = paintedPatches(
      [
        {
          layer: L,
          elements: [
            patch("moved", "L", 0, {
              x: 5.5,
              y: 6,
              maxWidth: 90,
              maxHeight: 12,
              opacity: 0.4,
            }),
            patch("opaque", "L", 1, { opacity: 1 }),
          ],
        },
      ],
      [],
    );
    expect([
      moved.x,
      moved.y,
      moved.width,
      moved.height,
      moved.opacity,
    ]).toEqual([5.5, 6, 90, 12, 0.4]);
    expect(opaque.opacity).toBeUndefined();
  });
});

describe("the region decides (R7-D4)", () => {
  const L = layer("L");
  const text = (over: Partial<LayerElement> = {}): LayerElement => ({
    ...patch("t", "T", 0),
    cleanupRef: null,
    regionId: "r",
    text: "Hello",
    ...over,
  });
  const textLayer = (visible: boolean, elements: LayerElement[]) => ({
    layer: layer("T", { type: "translation", visible }),
    elements,
  });
  const withPatch = [
    { layer: L, elements: [patch("p", "L", 0, { regionId: "r" })] },
  ];

  it("keeps the patch when the text layer is hidden: the page to letter by hand", () => {
    const layers = [...withPatch, textLayer(false, [text()])];
    expect(paintedPatches(layers, [region("r")])).toHaveLength(1);
  });

  it("drops the patch of a rejected, failed or refused region, which keeps its source", () => {
    for (const verdict of [
      { qaStatus: "rejected" as const, translatedText: "Text" },
      { qaStatus: "reject_sfx" as const, translatedText: "Boom" },
      { translationFailed: true, translatedText: null },
      { translatedText: null },
    ]) {
      const layers = [
        ...withPatch,
        textLayer(true, [text({ visible: false })]),
      ];
      expect(paintedPatches(layers, [region("r", verdict)])).toHaveLength(0);
    }
  });

  it("visible English always allows the patch, as the pre-R7 export did", () => {
    const layers = [...withPatch, textLayer(true, [text()])];
    expect(
      regionAllowsPatch(region("r", { translatedText: null }), layers),
    ).toBe(true);
  });

  it("a patch whose region went away is the user's to keep", () => {
    const layers = [
      { layer: L, elements: [patch("kept", "L", 0, { regionId: "gone" })] },
    ];
    expect(paintedPatches(layers, [])).toHaveLength(1);
  });

  it("only a region with a worker patch loses its flat plate", () => {
    expect(regionHasPatch(region("r"))).toBe(true);
    expect(regionHasPatch(region("r", { cleanupPatchSha256: null }))).toBe(
      false,
    );
    expect(regionHasPatch(undefined)).toBe(false);
  });
});

describe("scene asset cache", () => {
  it("fetches an asset once for every page and caller, and keeps it across page turns", async () => {
    const utils = await import("../../utils");
    clearSceneAssetCache();
    const fetchSpy = vi
      .spyOn(utils, "safeFetch")
      .mockResolvedValue(new Response(new Blob(["png"]), { status: 200 }));
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:one");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const sha = "a".repeat(64);

    expect(peekSceneAssetUrl(sha)).toBeUndefined();
    const [first, second] = await Promise.all([
      loadSceneAssetUrl("p1", sha, "t", "low"),
      loadSceneAssetUrl("p1", sha, "t"),
    ]);
    expect([first, second]).toEqual(["blob:one", "blob:one"]);
    expect(await loadSceneAssetUrl("p2", sha, "t")).toBe("blob:one");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ priority: "low" });
    expect(peekSceneAssetUrl(sha)).toBe("blob:one");
    expect(revoke).not.toHaveBeenCalled();

    clearSceneAssetCache();
    expect(revoke).toHaveBeenCalledWith("blob:one");
    fetchSpy.mockRestore();
    create.mockRestore();
    revoke.mockRestore();
  });
});
