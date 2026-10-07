import { describe, expect, it } from "vitest";
import type { Layer, LayerElement } from "../../types";
import {
  groupMergeSets,
  hiddenLooseLayers,
  isLayerShown,
  layerDisplayName,
  mergeDownTarget,
  mergeSkipsShownLayer,
  panelRows,
  shownLayersOf,
} from "../../utils/layerTree";
import { paintedPatches } from "../../utils/inpainting";

/** F3 (#178): groups and merging, as the editor reads them. */

const layer = (
  id: string,
  zOrder: number,
  over: Partial<Layer> = {},
): { layer: Layer; elements: LayerElement[] } => ({
  layer: {
    id,
    type: "translation",
    visible: true,
    zOrder,
    createdAt: "2026-10-07T00:00:00Z",
    ...over,
  },
  elements: [],
});

describe("layer groups (F3)", () => {
  const page = [
    layer("ocr", 0, { type: "ocr", visible: false }),
    layer("base", 1),
    layer("retry", 2, { parentId: "g", visible: false }),
    layer("retry2", 3, { parentId: "g" }),
    layer("g", 9, { type: "group", metadataJson: { layer_name: "Re-runs" } }),
    layer("sfx", 4, { type: "sfx" }),
  ];

  it("shows a layer only while it and its group are visible", () => {
    expect(isLayerShown(page[3].layer, page)).toBe(true);
    const hiddenGroup = page.map((d) =>
      d.layer.id === "g" ? { ...d, layer: { ...d.layer, visible: false } } : d,
    );
    expect(isLayerShown(hiddenGroup[3].layer, hiddenGroup)).toBe(false);
    expect(isLayerShown(hiddenGroup[1].layer, hiddenGroup)).toBe(true);
  });

  it("lists a group where its top layer is, with its layers under it", () => {
    expect(
      panelRows(page).map((row) =>
        row.kind === "group"
          ? `group:${row.data.layer.id}`
          : `${row.depth ? "  " : ""}${row.data.layer.id}`,
      ),
    ).toEqual(["sfx", "group:g", "  retry2", "  retry", "base", "ocr"]);
  });

  it("merges down only into a like layer below, in the same group, shown alike", () => {
    // retry2, shown, sits between sfx and base: merging would move sfx's text under it.
    expect(mergeDownTarget(page[5], page)).toBeNull();
    const retry2Hidden = page.map((d) =>
      d.layer.id === "retry2"
        ? { ...d, layer: { ...d.layer, visible: false } }
        : d,
    );
    expect(mergeDownTarget(retry2Hidden[5], retry2Hidden)?.layer.id).toBe(
      "base",
    );
    // retry2's neighbour in its group is hidden while retry2 is shown.
    expect(mergeDownTarget(page[3], page)).toBeNull();
    // base's neighbour below is OCR, which never merges.
    expect(mergeDownTarget(page[1], page)).toBeNull();
    expect(mergeDownTarget(page[0], page)).toBeNull();
  });

  it("offers merge visible, group merges and folding hidden layers", () => {
    expect(shownLayersOf("text", page).map((d) => d.layer.id)).toEqual([
      "base",
      "retry2",
      "sfx",
    ]);
    const ids = (sets: { layer: Layer }[][]) =>
      sets.map((set) => set.map((d) => d.layer.id));
    // retry is hidden and retry2 shown: a hidden layer never merges into a shown one.
    expect(ids(groupMergeSets("g", page))).toEqual([]);
    const bothHidden = page.map((d) =>
      d.layer.id === "retry2"
        ? { ...d, layer: { ...d.layer, visible: false } }
        : d,
    );
    expect(ids(groupMergeSets("g", bothHidden))).toEqual([["retry", "retry2"]]);
    // Two shown layers of the group with a shown loose layer between them stay apart.
    const straddling = [
      layer("a", 1, { parentId: "g" }),
      layer("loose", 2),
      layer("b", 3, { parentId: "g" }),
      layer("g", 9, { type: "group" }),
    ];
    expect(ids(groupMergeSets("g", straddling))).toEqual([]);
    expect(
      mergeSkipsShownLayer(
        straddling.slice(0, 1).concat(straddling[2]),
        straddling,
      ),
    ).toBe(true);
    expect(hiddenLooseLayers(page).map((d) => d.layer.id)).toEqual(["ocr"]);
    expect(layerDisplayName(page[4].layer)).toBe("Re-runs");
    expect(layerDisplayName(page[1].layer)).toBe("Translation (EN)");
  });

  it("paints no patch of a layer in a hidden group, as the export does", () => {
    const patch: LayerElement = {
      id: "p",
      layerId: "inp",
      regionId: null,
      autoSize: false,
      wordWrap: false,
      rotation: 0,
      x: 0,
      y: 0,
      maxWidth: 10,
      maxHeight: 10,
      visible: true,
      overflow: false,
      isManuallyEdited: false,
      cleanupRef: {
        patchSha256: "a".repeat(64),
        patchByteLength: 1,
        maskSha256: "b".repeat(64),
        maskByteLength: 1,
        generatorSha256: "0".repeat(64),
        bounds: { x: 0, y: 0, width: 10, height: 10 },
        order: 0,
      },
    };
    const layers = (groupVisible: boolean) => [
      {
        ...layer("inp", 1, { type: "inpainting", parentId: "g" }),
        elements: [patch],
      },
      layer("g", 2, { type: "group", visible: groupVisible }),
    ];
    expect(paintedPatches(layers(true), [])).toHaveLength(1);
    expect(paintedPatches(layers(false), [])).toHaveLength(0);
  });
});
