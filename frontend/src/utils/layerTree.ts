/**
 * F3 (#178): layer groups and merging, as the editor sees them.
 *
 * A group is a layer of type `group`. It holds no elements; other layers point at it with
 * `parentId`, and groups do not nest. A layer is shown only while it and its group are visible,
 * the backend's rule (`backend-rust/src/layer_tree.rs`), which the scene builder and so the export
 * follow. Hiding a group leaves its layers' own switches alone.
 */
import type { Layer, LayerElement } from "../types";

export const GROUP_LAYER_TYPE = "group";

type LayerData = { layer: Layer; elements: LayerElement[] };

export const isGroupLayer = (layer: Pick<Layer, "type">): boolean =>
  layer.type.toLowerCase() === GROUP_LAYER_TYPE;

/** Which layers merge together: text with text, patches with patches; null never merges. */
export type MergeKind = "text" | "patches";

export function mergeKindOf(layer: Pick<Layer, "type">): MergeKind | null {
  const type = layer.type.toLowerCase();
  if (type === "translation" || type === "sfx") return "text";
  if (type === "inpainting") return "patches";
  return null;
}

/** Whether the layer is shown: its own switch, and its group's. */
export function isLayerShown(
  layer: Pick<Layer, "visible" | "parentId">,
  layers: { layer: Layer }[],
): boolean {
  if (layer.visible !== true) return false;
  if (!layer.parentId) return true;
  const group = layers.find(({ layer: other }) => other.id === layer.parentId);
  return !group || group.layer.visible === true;
}

const byStack = (a: LayerData, b: LayerData) =>
  a.layer.zOrder - b.layer.zOrder ||
  (a.layer.createdAt < b.layer.createdAt
    ? -1
    : a.layer.createdAt > b.layer.createdAt
      ? 1
      : 0) ||
  (a.layer.id < b.layer.id ? -1 : a.layer.id > b.layer.id ? 1 : 0);

export type PanelRow =
  | { kind: "layer"; data: LayerData; depth: 0 | 1 }
  | { kind: "group"; data: LayerData; members: LayerData[] };

/**
 * The panel's rows, top of the stack first. A group sits where its topmost layer is (an empty one
 * where its own zOrder is) and lists its layers under it, also top first.
 */
export function panelRows(layers: LayerData[]): PanelRow[] {
  const groups = new Map(
    layers
      .filter(({ layer }) => isGroupLayer(layer))
      .map((data) => [data.layer.id, data] as const),
  );
  const members = new Map<string, LayerData[]>();
  const loose: LayerData[] = [];
  for (const data of layers) {
    if (isGroupLayer(data.layer)) continue;
    const parent = data.layer.parentId ? groups.get(data.layer.parentId) : null;
    if (parent) {
      members.set(parent.layer.id, [
        ...(members.get(parent.layer.id) ?? []),
        data,
      ]);
    } else {
      loose.push(data);
    }
  }
  type Entry = { at: LayerData; row: PanelRow; rows: PanelRow[] };
  const entries: Entry[] = loose.map((data) => {
    const row: PanelRow = { kind: "layer", data, depth: 0 };
    return { at: data, row, rows: [row] };
  });
  for (const group of groups.values()) {
    const held = [...(members.get(group.layer.id) ?? [])].sort(byStack);
    const row: PanelRow = { kind: "group", data: group, members: held };
    entries.push({
      at: held.at(-1) ?? group,
      row,
      rows: [
        row,
        ...[...held]
          .reverse()
          .map((data): PanelRow => ({ kind: "layer", data, depth: 1 })),
      ],
    });
  }
  return entries
    .sort((a, b) => byStack(b.at, a.at))
    .flatMap((entry) => entry.rows);
}

/**
 * Whether merging `set` would skip a shown like layer lying between its lowest and highest layer
 * in the stack: the merged elements would then move under it and the page would change. Only a
 * shown set can: a hidden merge paints nothing. The server refuses the same case.
 */
export function mergeSkipsShownLayer(
  set: LayerData[],
  layers: LayerData[],
): boolean {
  if (set.length < 2) return false;
  const kind = mergeKindOf(set[0].layer);
  if (!kind || !isLayerShown(set[0].layer, layers)) return false;
  const sorted = [...set].sort(byStack);
  const lowest = sorted[0];
  const highest = sorted[sorted.length - 1];
  const ids = new Set(set.map(({ layer }) => layer.id));
  return layers.some(
    (data) =>
      !ids.has(data.layer.id) &&
      mergeKindOf(data.layer) === kind &&
      isLayerShown(data.layer, layers) &&
      byStack(lowest, data) < 0 &&
      byStack(data, highest) < 0,
  );
}

/**
 * Whether the layers can share one target language: at most one language among those that name
 * one (an SFX layer names none). The server refuses English and French text in one layer.
 */
export function languagesAgree(set: LayerData[]): boolean {
  const named = set
    .map(({ layer }) => layer.targetLanguage?.trim().toLowerCase())
    .filter((language): language is string => Boolean(language));
  return new Set(named).size <= 1;
}

/**
 * The layer "Merge down" merges `data` into: the nearest layer below it in the stack, in the same
 * group (or also at the top level), if that one merges with it, is shown or hidden alike, and no
 * shown like layer of another group lies between them. Null when there is none; the server
 * refuses the same cases.
 */
export function mergeDownTarget(
  data: LayerData,
  layers: LayerData[],
): LayerData | null {
  const kind = mergeKindOf(data.layer);
  if (!kind) return null;
  const siblings = layers
    .filter(
      ({ layer }) =>
        !isGroupLayer(layer) &&
        (layer.parentId ?? null) === (data.layer.parentId ?? null),
    )
    .sort(byStack);
  const index = siblings.findIndex(({ layer }) => layer.id === data.layer.id);
  const below = index > 0 ? siblings[index - 1] : undefined;
  if (!below || mergeKindOf(below.layer) !== kind) return null;
  if (
    isLayerShown(below.layer, layers) !== isLayerShown(data.layer, layers) ||
    (below.layer.visible === true) !== (data.layer.visible === true)
  )
    return null;
  if (!languagesAgree([below, data])) return null;
  return mergeSkipsShownLayer([below, data], layers) ? null : below;
}

/** The shown layers of one kind, bottom first: what "Merge visible" merges. */
export function shownLayersOf(
  kind: MergeKind,
  layers: LayerData[],
): LayerData[] {
  return layers
    .filter(
      ({ layer }) => mergeKindOf(layer) === kind && isLayerShown(layer, layers),
    )
    .sort(byStack);
}

/**
 * What merging a group merges: its like layers by kind, split into the shown ones and the hidden
 * ones (a hidden layer never merges into a shown one), and by their own switches, bottom first. A
 * set that would skip a shown like layer outside the group is left out, as the server would
 * refuse it.
 */
export function groupMergeSets(
  groupId: string,
  layers: LayerData[],
): LayerData[][] {
  const held = layers
    .filter(({ layer }) => layer.parentId === groupId)
    .sort(byStack);
  // Split by what shows and by each layer's own switch: in a hidden group the switches can still
  // differ, and the merged layer keeps only one, so showing the group would change the page.
  const states = [
    [true, true],
    [false, true],
    [false, false],
  ] as const;
  return (["text", "patches"] as const)
    .flatMap((kind) => {
      const like = held.filter(({ layer }) => mergeKindOf(layer) === kind);
      return states.map(([shown, own]) =>
        like.filter(
          ({ layer }) =>
            isLayerShown(layer, layers) === shown &&
            (layer.visible === true) === own,
        ),
      );
    })
    .filter(
      (set) =>
        set.length > 1 &&
        languagesAgree(set) &&
        !mergeSkipsShownLayer(set, layers),
    );
}

/** Hidden layers outside any group: what "Group hidden layers" folds away (re-run history). */
export function hiddenLooseLayers(layers: LayerData[]): LayerData[] {
  return layers.filter(
    ({ layer }) =>
      !isGroupLayer(layer) && !layer.parentId && layer.visible !== true,
  );
}

/** The panel's name for a layer: its stored name, else one from its type. */
export function layerDisplayName(layer: Layer): string {
  const stored = (layer.metadataJson as { layer_name?: unknown } | null)
    ?.layer_name;
  if (typeof stored === "string" && stored.trim()) return stored;
  const type = layer.type.toLowerCase();
  if (type === "translation")
    return `Translation (${layer.targetLanguage?.toUpperCase() || "EN"})`;
  if (type === "sfx") return "SFX Layer";
  if (type === "ocr") return "OCR Layer";
  if (type === "inpainting") return "Inpainting";
  if (type === GROUP_LAYER_TYPE) return "Group";
  return `Layer (${layer.type})`;
}
