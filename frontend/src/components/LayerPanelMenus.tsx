/**
 * F3 (#178): the Layers panel's menus: Add layer, Merge, and each row's own actions.
 *
 * Only like layers merge (text with text, patches with patches), and a merge never changes the
 * page: where two layers have text for one region the upper one stays and the lower is kept
 * hidden (D2). The server enforces the same rules; these menus only offer what it will accept.
 */
import React from "react";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import ListSubheader from "@mui/material/ListSubheader";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Divider from "@mui/material/Divider";
import AddIcon from "@mui/icons-material/Add";
import CallMergeIcon from "@mui/icons-material/CallMerge";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import UndoIcon from "@mui/icons-material/Undo";
import RedoIcon from "@mui/icons-material/Redo";
import type { Layer, LayerElement } from "../types";
import type { components } from "../api/schema";
import {
  groupMergeSets,
  hiddenLooseLayers,
  isGroupLayer,
  layerDisplayName,
  mergeDownTarget,
  shownLayersOf,
  languagesAgree,
} from "../utils/layerTree";

type LayerData = { layer: Layer; elements: LayerElement[] };

/** The panel's F3 actions; the Reader sends each to the server and reloads the page's layers. */
export interface LayerActions {
  addLayer: (type: "translation" | "sfx" | "inpainting" | "group") => void;
  renameLayer: (layerId: string, name: string) => void;
  setLayerGroup: (layerId: string, groupId: string | null) => void;
  groupLayers: (layerIds: string[], name: string) => void;
  mergeLayers: (layerIds: string[]) => void;
  deleteHiddenTexts: (layerId: string) => void;
  /** Deletes a group and keeps its layers. */
  ungroup: (groupId: string) => void;
  /** F4: undo or redo the page's newest layer action, on the server, so it survives a reload. */
  undoLayerAction: () => void;
  redoLayerAction: () => void;
  /** F4: re-reads what Undo and Redo would do (the reason either is blocked can change any time). */
  refreshLayerHistory: () => void;
}

/** F4: the page's layer history, as `GET /api/pages/{pageId}/layer-history` answers. */
export type LayerHistory = components["schemas"]["LayerHistory"];
type LayerHistoryEntry = components["schemas"]["LayerHistoryEntry"];

// The header's old "+ TL" / "+ SFX" look.
const menuButtonSx = {
  fontSize: "10px",
  minWidth: 0,
  px: 1,
  py: 0.25,
  color: "var(--text-muted)",
  borderColor: "var(--border-color)",
} as const;

function useMenu() {
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  return {
    anchor,
    open: (event: React.MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      setAnchor(event.currentTarget);
    },
    close: () => setAnchor(null),
  };
}

const askName = (current: string) => {
  const name = window.prompt("Layer name:", current)?.trim();
  return name ? name : null;
};

export const AddLayerMenu: React.FC<{
  onAddTranslation: () => void;
  onAddSfx: () => void;
  actions?: Partial<LayerActions>;
}> = ({ onAddTranslation, onAddSfx, actions }) => {
  const menu = useMenu();
  const pick = (run: () => void) => () => {
    menu.close();
    run();
  };
  return (
    <>
      <Button
        variant="outlined"
        size="small"
        startIcon={<AddIcon sx={{ fontSize: 14 }} />}
        onClick={menu.open}
        aria-haspopup="menu"
        title="Add a layer"
        sx={menuButtonSx}
      >
        Add layer
      </Button>
      <Menu
        anchorEl={menu.anchor}
        open={Boolean(menu.anchor)}
        onClose={menu.close}
      >
        <MenuItem onClick={pick(onAddTranslation)}>Text layer</MenuItem>
        <MenuItem onClick={pick(onAddSfx)}>SFX layer</MenuItem>
        {actions?.addLayer && [
          <MenuItem
            key="inpainting"
            onClick={pick(() => actions.addLayer?.("inpainting"))}
          >
            Patch layer
          </MenuItem>,
          <MenuItem
            key="group"
            onClick={pick(() => actions.addLayer?.("group"))}
          >
            Group
          </MenuItem>,
        ]}
      </Menu>
    </>
  );
};

export const MergeMenu: React.FC<{
  layers: LayerData[];
  actions?: Partial<LayerActions>;
}> = ({ layers, actions }) => {
  const menu = useMenu();
  if (!actions?.mergeLayers) return null;
  const shownText = shownLayersOf("text", layers);
  const shownPatches = shownLayersOf("patches", layers);
  const hidden = hiddenLooseLayers(layers);
  const pick = (run: () => void) => () => {
    menu.close();
    run();
  };
  return (
    <>
      <Button
        variant="outlined"
        size="small"
        startIcon={<CallMergeIcon sx={{ fontSize: 14 }} />}
        onClick={menu.open}
        aria-haspopup="menu"
        title="Merge or group layers"
        sx={menuButtonSx}
      >
        Merge
      </Button>
      <Menu
        anchorEl={menu.anchor}
        open={Boolean(menu.anchor)}
        onClose={menu.close}
      >
        <MenuItem
          disabled={shownText.length < 2 || !languagesAgree(shownText)}
          title={
            languagesAgree(shownText)
              ? undefined
              : "The visible text layers are in more than one language"
          }
          onClick={pick(() =>
            actions.mergeLayers?.(shownText.map(({ layer }) => layer.id)),
          )}
        >
          Merge visible text layers ({shownText.length})
        </MenuItem>
        <MenuItem
          disabled={shownPatches.length < 2}
          onClick={pick(() =>
            actions.mergeLayers?.(shownPatches.map(({ layer }) => layer.id)),
          )}
        >
          Merge visible patch layers ({shownPatches.length})
        </MenuItem>
        <Divider />
        <MenuItem
          disabled={!actions.groupLayers || hidden.length === 0}
          onClick={pick(() =>
            actions.groupLayers?.(
              hidden.map(({ layer }) => layer.id),
              "Hidden layers",
            ),
          )}
        >
          Group hidden layers ({hidden.length})
        </MenuItem>
      </Menu>
    </>
  );
};

/** A layer row's own menu: rename, merge down, and its group. */
export const LayerRowMenu: React.FC<{
  data: LayerData;
  layers: LayerData[];
  actions?: Partial<LayerActions>;
}> = ({ data, layers, actions }) => {
  const menu = useMenu();
  if (!actions?.renameLayer) return null;
  const below = mergeDownTarget(data, layers);
  const groups = layers.filter(({ layer }) => isGroupLayer(layer));
  const pick = (run: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    menu.close();
    run();
  };
  return (
    <>
      <IconButton
        size="small"
        aria-label="Layer actions"
        aria-haspopup="menu"
        onClick={menu.open}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu
        anchorEl={menu.anchor}
        open={Boolean(menu.anchor)}
        onClose={menu.close}
        onClick={(e) => e.stopPropagation()}
      >
        <MenuItem
          onClick={pick(() => {
            const name = askName(layerDisplayName(data.layer));
            if (name) actions.renameLayer?.(data.layer.id, name);
          })}
        >
          Rename…
        </MenuItem>
        <MenuItem
          disabled={!below}
          title={
            below
              ? `Into ${layerDisplayName(below.layer)}`
              : "No like layer below it, one shown while the other is hidden, or a shown like layer between them"
          }
          onClick={pick(() => {
            if (below) actions.mergeLayers?.([data.layer.id, below.layer.id]);
          })}
        >
          Merge down
        </MenuItem>
        <Divider />
        <ListSubheader sx={{ lineHeight: "28px" }}>Group</ListSubheader>
        {groups
          .filter(({ layer }) => layer.id !== data.layer.parentId)
          .map(({ layer }) => (
            <MenuItem
              key={layer.id}
              onClick={pick(() =>
                actions.setLayerGroup?.(data.layer.id, layer.id),
              )}
            >
              Move to {layerDisplayName(layer)}
            </MenuItem>
          ))}
        <MenuItem
          onClick={pick(() => {
            const name = askName("Group");
            if (name) actions.groupLayers?.([data.layer.id], name);
          })}
        >
          New group with this layer…
        </MenuItem>
        {data.layer.parentId && (
          <MenuItem
            onClick={pick(() => actions.setLayerGroup?.(data.layer.id, null))}
          >
            Remove from group
          </MenuItem>
        )}
      </Menu>
    </>
  );
};

/** A group row's menu: rename, merge what it holds, ungroup. */
export const GroupRowMenu: React.FC<{
  group: LayerData;
  layers: LayerData[];
  actions?: Partial<LayerActions>;
}> = ({ group, layers, actions }) => {
  const menu = useMenu();
  if (!actions?.renameLayer) return null;
  const sets = groupMergeSets(group.layer.id, layers);
  const pick = (run: () => void) => (event: React.MouseEvent) => {
    event.stopPropagation();
    menu.close();
    run();
  };
  return (
    <>
      <IconButton
        size="small"
        aria-label="Group actions"
        aria-haspopup="menu"
        onClick={menu.open}
      >
        <MoreVertIcon fontSize="small" />
      </IconButton>
      <Menu
        anchorEl={menu.anchor}
        open={Boolean(menu.anchor)}
        onClose={menu.close}
        onClick={(e) => e.stopPropagation()}
      >
        <MenuItem
          onClick={pick(() => {
            const name = askName(layerDisplayName(group.layer));
            if (name) actions.renameLayer?.(group.layer.id, name);
          })}
        >
          Rename…
        </MenuItem>
        <MenuItem
          disabled={sets.length === 0}
          title="Merges its text layers together, and its patch layers together"
          onClick={pick(() => {
            for (const set of sets) {
              actions.mergeLayers?.(set.map(({ layer }) => layer.id));
            }
          })}
        >
          Merge the group&apos;s layers
        </MenuItem>
        <MenuItem onClick={pick(() => actions.ungroup?.(group.layer.id))}>
          Ungroup (keep the layers)
        </MenuItem>
      </Menu>
    </>
  );
};

/** What a history button says: the action, or why it cannot run. */
function historyTitle(
  verb: "Undo" | "Redo",
  entry: LayerHistoryEntry | null | undefined,
): string {
  if (!entry) return `Nothing to ${verb.toLowerCase()} in the layers`;
  if (entry.blocked)
    return `Can't ${verb.toLowerCase()} "${entry.label}": ${entry.blocked}`;
  return `${verb} ${entry.label}`;
}

/**
 * F4 (#178): Undo and Redo for layer actions (add, delete, rename, reorder, group, ungroup, merge,
 * delete hidden texts). They act on the server's record of the last 20, so they work after a
 * reload; Ctrl+Z stays the undo of element edits. Hovering re-reads the history, so a reason to
 * refuse (an edit since, a layer shown or hidden since) is current when it is read.
 */
export const LayerHistoryButtons: React.FC<{
  history: LayerHistory | null | undefined;
  actions?: Partial<LayerActions>;
}> = ({ history, actions }) => {
  if (!actions?.undoLayerAction || !actions.redoLayerAction) return null;
  const undo = history?.undo;
  const redo = history?.redo;
  const button = (
    verb: "Undo" | "Redo",
    entry: LayerHistoryEntry | null | undefined,
    run: () => void,
    icon: React.ReactNode,
  ) => (
    // A disabled button takes no pointer, so the span carries the reason.
    <span title={historyTitle(verb, entry)}>
      <IconButton
        size="small"
        aria-label={`${verb} layer action`}
        disabled={!entry || Boolean(entry.blocked)}
        onClick={(event) => {
          event.stopPropagation();
          run();
        }}
        sx={{ p: 0.25, color: "var(--text-muted)" }}
      >
        {icon}
      </IconButton>
    </span>
  );
  return (
    <span
      data-testid="layer-history"
      style={{ display: "inline-flex" }}
      onMouseEnter={() => actions.refreshLayerHistory?.()}
    >
      {button(
        "Undo",
        undo,
        actions.undoLayerAction,
        <UndoIcon sx={{ fontSize: 16 }} />,
      )}
      {button(
        "Redo",
        redo,
        actions.redoLayerAction,
        <RedoIcon sx={{ fontSize: 16 }} />,
      )}
    </span>
  );
};
