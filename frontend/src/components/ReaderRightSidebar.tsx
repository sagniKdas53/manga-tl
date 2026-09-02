import React from "react";
import Grid from "@mui/material/Grid";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import IconButton from "@mui/material/IconButton";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import TextField from "@mui/material/TextField";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Slider from "@mui/material/Slider";
import Typography from "@mui/material/Typography";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import AddIcon from "@mui/icons-material/Add";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteIcon from "@mui/icons-material/Delete";
import ColorizeIcon from "@mui/icons-material/Colorize";
import RefreshIcon from "@mui/icons-material/Refresh";
import FileDownloadIcon from "@mui/icons-material/FileDownload";
import UndoIcon from "@mui/icons-material/Undo";
import OpenWithIcon from "@mui/icons-material/OpenWith";
import CropIcon from "@mui/icons-material/Crop";
import LayersIcon from "@mui/icons-material/Layers";
import { ColorPicker } from "./ColorPicker";
import SidebarSection from "./SidebarSection";
import type { SystemStyleObject, Theme } from "@mui/system";
import type { Layer, LayerElement, OcrRegion } from "../types";

// --- AUDIT-F2: static sx literals hoisted to module scope --------------------
//
// Every one of these was previously a fresh object literal reconstructed on every render of
// this component (28 state values live one level up in Reader.tsx, so this sidebar re-renders
// on most reader interactions). None of them depend on props, state, or loop variables, so
// there is nothing to gain from inlining them — Emotion can cache a stable reference instead
// of re-serialising the same declarations every time. Blocks that genuinely vary per render
// (loop index, active/visible flags, interaction mode) stay inline below; a few of those split
// their static parts out here too, merged in via the `sx` array form.

const emptyStateContainerSx = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 1,
  color: "var(--text-dim, var(--text-muted))",
  textAlign: "center",
  py: 3,
  mb: 2,
  borderBottom: "1px solid var(--border-color)",
} as const;

const emptyStateIconSx = { fontSize: 22, opacity: 0.5 } as const;

const emptyStateTextSx = {
  fontSize: "12.5px",
  color: "var(--text-muted)",
  maxWidth: 210,
} as const;

const layerHeaderActionsSx = {
  display: "flex",
  gap: 0.25,
  alignItems: "center",
} as const;

const layerMoveButtonSx = { p: 0.25, color: "var(--text-muted)" } as const;

const layerHeaderDividerSx = {
  width: "1px",
  height: "14px",
  backgroundColor: "var(--border-color)",
  mx: 0.5,
} as const;

const smallAddIconSx = { fontSize: 14 } as const;

const addLayerButtonSx = {
  fontSize: "10px",
  minWidth: 0,
  px: 1,
  py: 0.25,
  color: "var(--text-muted)",
  borderColor: "var(--border-color)",
} as const;

const noLayersTextSx = {
  fontSize: "11px",
  color: "var(--text-dim, var(--text-muted))",
  py: 0.5,
} as const;

// The layer row itself depends on `isActive`/`isVisible` per item, so the dynamic half stays
// inline — but the declarations that never change are still worth not reallocating every time
// any layer's active/visible state changes any *other* row.
const layerRowBaseSx = {
  display: "flex",
  alignItems: "center",
  gap: 1,
  p: "6px 8px",
  mb: 0.75,
  borderRadius: "8px",
  cursor: "pointer",
  transition: "opacity 0.15s ease, border-color 0.15s ease",
} as const;

const layerStackNumberBaseSx = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  borderRadius: "5px",
  fontSize: "10px",
  fontWeight: 700,
  flexShrink: 0,
} as const;

const layerNameColumnSx = {
  display: "flex",
  flexDirection: "column",
  gap: "2px",
  flex: 1,
  minWidth: 0,
} as const;

const layerNameBaseSx = {
  fontSize: "13px",
  lineHeight: 1.2,
  wordBreak: "break-word",
} as const;

const layerElementCountSx = {
  fontSize: "9px",
  color: "var(--text-dim, var(--text-muted))",
} as const;

// AUDIT-F15: the layer's elements, listed under it. Indented and hairlined so the list reads as
// belonging to the row above rather than as more layers.
const elementListSx = {
  ml: 3,
  mb: 0.5,
  borderLeft: "1px solid var(--border-color)",
  pl: 1,
} as const;

const elementRowSx = {
  display: "flex",
  alignItems: "center",
  gap: 0.5,
  borderRadius: 1,
  px: 0.5,
  cursor: "pointer",
  "&:hover": { backgroundColor: "var(--bg-input, rgba(0,0,0,0.06))" },
} as const;

const elementLabelSx = {
  flex: 1,
  minWidth: 0,
  fontSize: "12px",
  color: "var(--text-muted)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

const layerActionsRowSx = {
  display: "flex",
  alignItems: "center",
  gap: 0.25,
  flexShrink: 0,
} as const;

const cloneLayerButtonSx = { color: "var(--text-muted)" } as const;

const deleteLayerButtonSx = {
  color: "var(--text-muted)",
  "&:hover": { color: "var(--error)" },
} as const;

const editorToolRowSx = { display: "flex", gap: 1, mb: 1 } as const;

const editorToolButtonSx = {
  flex: 1,
  py: 1,
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--text-main)",
  borderColor: "var(--border-color)",
  "&:hover": {
    borderColor: "var(--primary)",
    color: "var(--primary)",
    backgroundColor: "var(--primary-glow)",
  },
} as const;

const colorDropperButtonSx = {
  color: "var(--text-main)",
  borderColor: "var(--border-color)",
  "&:hover": {
    borderColor: "var(--primary)",
    color: "var(--primary)",
  },
} as const;

const inlineSpinnerSx = { color: "inherit" } as const;

const redoOcrButtonSx = {
  mb: 1,
  color: "var(--warning)",
  borderColor: "var(--warning)",
  "&:hover": { backgroundColor: "var(--warning)", color: "#fff" },
} as const;

const redoTranslationButtonSx = {
  color: "var(--warning)",
  borderColor: "var(--warning)",
  "&:hover": { backgroundColor: "var(--warning)", color: "#fff" },
} as const;

const exportSectionSx = { mb: 5 } as const;

const exportButtonWithMarginSx = {
  mb: 1,
  color: "var(--primary)",
  borderColor: "var(--primary)",
  "&:hover": { backgroundColor: "var(--primary)", color: "#fff" },
} as const;

const exportButtonSx = {
  color: "var(--primary)",
  borderColor: "var(--primary)",
  "&:hover": { backgroundColor: "var(--primary)", color: "#fff" },
} as const;

const inspectorHeaderRowSx = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  pb: 1.25,
  mb: 0.5,
  borderBottom: "1px solid var(--border-color)",
} as const;

const inspectorTitleSx = {
  fontSize: "10.5px",
  fontWeight: 700,
  letterSpacing: "0.08em",
  color: "var(--text-dim, var(--text-muted))",
  lineHeight: 1.2,
} as const;

const inspectorSubtitleSx = {
  fontSize: "11px",
  color: "var(--text-muted)",
} as const;

// Shared by both the layer-element inspector and the region inspector's own "Deselect".
const deselectButtonSx = {
  borderColor: "var(--border-color)",
  color: "var(--text-main)",
  fontSize: "11px",
  fontWeight: 600,
  minWidth: "auto",
  padding: "2px 8px",
} as const;

const textContentFieldSx = {
  "& .MuiOutlinedInput-root": {
    backgroundColor: "var(--bg-input, rgba(0,0,0,0.05))",
    fontSize: "13px",
    fontFamily: "inherit",
  },
} as const;

const regionRedoGridSx = { mb: 0.5 } as const;
const regionRedoColSx = { display: "flex" } as const;
const redoSpinnerMarginSx = { mr: 0.5 } as const;

// Reused across all four X/Y/MaxWidth/MaxHeight fields and both Font Size columns.
const fieldColumnSx = {
  display: "flex",
  flexDirection: "column",
  gap: 0.5,
} as const;

// Reused across every plain numeric TextField in Position/Size and Typography.
const numericFieldInputSx = {
  "& .MuiInputBase-input": {
    fontSize: "13px",
    padding: "6px 10px",
  },
} as const;

// Reused across all four Select fields (font family/weight/style, box shape).
const selectFieldSx = {
  fontSize: "13px",
  height: "38px",
  backgroundColor: "var(--bg-surface)",
} as const;

const rotationSliderSx = { width: "100%", mt: 1 } as const;

// Identical glow applied to whichever of Drag/Reshape is currently active.
const activeModeGlowSx = {
  boxShadow: "0 0 0 3px var(--primary-glow)",
} as const;

const interactionHintTextSx = {
  fontSize: "10.5px",
  color: "var(--text-dim, var(--text-muted))",
} as const;

const unsavedChangesRowSx = {
  display: "flex",
  alignItems: "center",
  gap: 0.5,
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--warning, #eab308)",
} as const;

const unsavedChangesDotSx = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  backgroundColor: "var(--warning, #eab308)",
} as const;

// --- Shared presentational helpers -----------------------------------------

const fieldLabelSx = {
  fontSize: "11px",
  fontWeight: "bold",
  color: "var(--text-muted)",
} as const;

/**
 * The inspector's field captions were eleven copies of the same raw `<label>` carrying the
 * same three inline declarations. Worse, not one of them named a control: a `<label>` that
 * is only a *sibling* of its input associates with nothing, so every number box and dropdown
 * below reached assistive technology unnamed. Callers now pass either `htmlFor` (for the
 * text fields, which really are labelable) or `id` (for `Select` and `Slider`, which are not
 * — those point back at it with `labelId` / `aria-labelledby`).
 */
const FieldLabel: React.FC<{
  htmlFor?: string;
  id?: string;
  children: React.ReactNode;
}> = ({ htmlFor, id, children }) => (
  <Box
    component="label"
    htmlFor={htmlFor}
    id={id}
    sx={fieldLabelSx}
  >
    {children}
  </Box>
);

/**
 * `.meta-badge` is defined in index.css and these tints override it. As inline styles they
 * always won; as plain `sx` they would only win on emotion happening to inject after the
 * stylesheet, which is injection order, not a rule. Scoping to `&.meta-badge` makes the
 * generated selector specificity (0,2,0) against the class's (0,1,0) — it wins outright.
 * That matters most for the `capitalize` badge, which contradicts the class's `uppercase`.
 */
const MetaBadge: React.FC<{
  overrides?: SystemStyleObject<Theme>;
  children: React.ReactNode;
}> = ({ overrides, children }) => (
  <Box
    component="span"
    className="meta-badge"
    sx={overrides ? { "&.meta-badge": overrides } : undefined}
  >
    {children}
  </Box>
);

// Assuming types are defined here or imported
// You may need to adjust types based on actual project structure
export interface LayerData {
  layer: Layer;
  elements: LayerElement[];
}

export interface ReaderRightSidebarProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectedItem: any; // Fallback to any to avoid complex type mismatch for now
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSelectedItem: (item: any) => void;
  activeLayerId: string | null;
  setActiveLayerId: (id: string | null) => void;
  sortedLayers: LayerData[];
  layers: LayerData[];
  manuallyShownOcrLayers: Set<string>;
  cleanScanlationView: boolean;
  handleMoveLayer: (id: string, direction: "up" | "down") => void;
  handleCreateTranslationLayer: () => void;
  handleCreateSfxLayer: () => void;
  handleToggleLayerVisibility: (id: string) => void;
  handleCloneLayer: (id: string) => void;
  handleDeleteLayer: (id: string) => void;
  handleAddNewElement: (type: "text" | "mask") => void;
  handleLaunchEyeDropper: (field: string) => void;
  handleRedoPageOcr: () => void;
  isRedoingPageOcr: boolean;
  handleRedoPageTranslation: () => void;
  isRedoingPageTranslation: boolean;
  handleExportPng: () => void;
  handleExportRenderedPng: () => void;
  handleExportZip: () => void;
  interactionMode: string;
  setInteractionMode: React.Dispatch<
    React.SetStateAction<"none" | "drag" | "reshape">
  >;
  undoStack: LayerElement[];
  handleUndo: () => void;
  handleEnterReshapeMode: (element: LayerElement) => void;
  handleUpdateSelectedElement: (updates: Partial<LayerElement>) => void;
  dirtyElements: Set<string>;
  handleSaveElementChanges: (element: LayerElement) => void;
  handleSetElementVisibility: (element: LayerElement, visible: boolean) => void;
  handleDeleteElement: (id: string) => void;
  ocrRegions: OcrRegion[];
  isRedoingRegionOcr: boolean;
  handleRedoRegion: (region: OcrRegion, type: "ocr" | "translation") => void;
  isRedoingRegionTl: boolean;
}

const ReaderRightSidebar: React.FC<ReaderRightSidebarProps> = (props) => {
  // AUDIT-F15: which layers have their element list open. A layer's elements are the only way to
  // reach one that has been hidden — hiding removes it from the canvas, which was the only place
  // it could be selected.
  const [expandedLayers, setExpandedLayers] = React.useState<Set<string>>(
    new Set(),
  );
  const toggleLayerExpanded = React.useCallback((layerId: string) => {
    setExpandedLayers((prev) => {
      const next = new Set(prev);
      if (!next.delete(layerId)) next.add(layerId);
      return next;
    });
  }, []);

  const {
    selectedItem,
    setSelectedItem,
    activeLayerId,
    setActiveLayerId,
    sortedLayers,
    handleMoveLayer,
    handleCreateTranslationLayer,
    handleCreateSfxLayer,
    handleToggleLayerVisibility,
    handleSetElementVisibility,
    handleCloneLayer,
    handleDeleteLayer,
    handleAddNewElement,
    handleLaunchEyeDropper,
    handleRedoPageOcr,
    isRedoingPageOcr,
    handleRedoPageTranslation,
    isRedoingPageTranslation,
    handleExportPng,
    handleExportRenderedPng,
    handleExportZip,
    interactionMode,
    setInteractionMode,
    undoStack,
    handleUndo,
    handleEnterReshapeMode,
    handleUpdateSelectedElement,
    dirtyElements,
    handleSaveElementChanges,
    handleDeleteElement,
    ocrRegions,
    isRedoingRegionOcr,
    handleRedoRegion,
    isRedoingRegionTl,
  } = props;

  return (
    <Grid className="reader-right-sidebar-nhentai">
      {!selectedItem && (
        <>
          <Box sx={emptyStateContainerSx}>
            <LayersIcon sx={emptyStateIconSx} />
            <Typography
              variant="body2"
              sx={emptyStateTextSx}
            >
              Select an OCR region or a text layer to inspect and edit details.
            </Typography>
          </Box>

          {/* Translation Layers Section */}
          <SidebarSection
            title="Layers"
            headerExtra={
              <Box sx={layerHeaderActionsSx}>
                <IconButton
                  size="small"
                  aria-label="Move layer up"
                  title="Move layer up"
                  disabled={
                    !activeLayerId ||
                    sortedLayers.findIndex(
                      (l) => l.layer.id === activeLayerId,
                    ) ===
                      sortedLayers.length - 1
                  }
                  onClick={() =>
                    activeLayerId && handleMoveLayer(activeLayerId, "up")
                  }
                  sx={layerMoveButtonSx}
                >
                  <KeyboardArrowUpIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  aria-label="Move layer down"
                  title="Move layer down"
                  disabled={
                    !activeLayerId ||
                    sortedLayers.findIndex(
                      (l) => l.layer.id === activeLayerId,
                    ) === 0
                  }
                  onClick={() =>
                    activeLayerId && handleMoveLayer(activeLayerId, "down")
                  }
                  sx={layerMoveButtonSx}
                >
                  <KeyboardArrowDownIcon fontSize="small" />
                </IconButton>
                <Box sx={layerHeaderDividerSx} />
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<AddIcon sx={smallAddIconSx} />}
                  onClick={handleCreateTranslationLayer}
                  title="Add Translation Layer"
                  sx={addLayerButtonSx}
                >
                  TL
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<AddIcon sx={smallAddIconSx} />}
                  onClick={handleCreateSfxLayer}
                  title="Add SFX Layer"
                  sx={addLayerButtonSx}
                >
                  SFX
                </Button>
              </Box>
            }
          >
            {sortedLayers.length === 0 ? (
              <Typography
                variant="body2"
                sx={noLayersTextSx}
              >
                No active layers.
              </Typography>
            ) : (
              [...sortedLayers].reverse().map((lData, idx) => {
                const isActive = lData.layer.id === activeLayerId;
                const isVisible = lData.layer.visible;
                const stackNumber = sortedLayers.length - idx;
                const isExpanded = expandedLayers.has(lData.layer.id);
                const hiddenCount = lData.elements.filter(
                  (el) => !el.visible,
                ).length;
                return (
                  <React.Fragment key={lData.layer.id}>
                    <Box
                      onClick={() => setActiveLayerId(lData.layer.id)}
                      sx={[
                        layerRowBaseSx,
                        {
                          border: isActive
                            ? "1px solid var(--primary)"
                            : "1px solid var(--border-color)",
                          backgroundColor: isActive
                            ? "var(--primary-glow)"
                            : "transparent",
                          boxShadow: isActive
                            ? "0 0 8px var(--primary-glow)"
                            : "none",
                          opacity: isVisible ? 1 : 0.5,
                          "&:hover": {
                            borderColor: isActive
                              ? "var(--primary)"
                              : "var(--text-dim, var(--text-muted))",
                          },
                        },
                      ]}
                    >
                      <Box
                        sx={[
                          layerStackNumberBaseSx,
                          {
                            backgroundColor: isActive
                              ? "var(--primary)"
                              : "var(--bg-input, rgba(0,0,0,0.06))",
                            color: isActive ? "#fff" : "var(--text-muted)",
                          },
                        ]}
                      >
                        {stackNumber}
                      </Box>
                      <Box sx={layerNameColumnSx}>
                        <Typography
                          component="span"
                          sx={[
                            layerNameBaseSx,
                            {
                              fontWeight: isActive ? 700 : 600,
                              color: isActive
                                ? "var(--primary-hover)"
                                : "var(--text-main)",
                            },
                          ]}
                        >
                          {typeof lData.layer.metadataJson?.layer_name ===
                          "string"
                            ? lData.layer.metadataJson.layer_name
                            : lData.layer.type === "translation"
                              ? `Translation (${lData.layer.targetLanguage?.toUpperCase() || "EN"})`
                              : lData.layer.type === "sfx"
                                ? "SFX Layer"
                                : lData.layer.type === "ocr"
                                  ? "OCR Layer"
                                  : `Layer (${lData.layer.type})`}
                        </Typography>
                        <Typography
                          component="span"
                          sx={[
                            layerElementCountSx,
                            {
                              cursor: lData.elements.length
                                ? "pointer"
                                : "default",
                              userSelect: "none",
                            },
                          ]}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (lData.elements.length) {
                              toggleLayerExpanded(lData.layer.id);
                            }
                          }}
                          title={
                            lData.elements.length
                              ? "Show this layer's elements"
                              : undefined
                          }
                        >
                          {lData.elements.length > 0
                            ? `${isExpanded ? "▾" : "▸"} `
                            : ""}
                          {lData.elements.length} elements
                          {hiddenCount ? ` · ${hiddenCount} hidden` : ""}
                          {!isVisible ? " · layer hidden" : ""}
                        </Typography>
                      </Box>
                      <Box
                        sx={layerActionsRowSx}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Tooltip
                          title={isVisible ? "Hide layer" : "Show layer"}
                        >
                          <IconButton
                            size="small"
                            onClick={() =>
                              handleToggleLayerVisibility(lData.layer.id)
                            }
                            sx={{
                              color: isVisible
                                ? "var(--primary)"
                                : "var(--text-dim, var(--text-muted))",
                            }}
                          >
                            {isVisible ? (
                              <VisibilityIcon fontSize="small" />
                            ) : (
                              <VisibilityOffIcon fontSize="small" />
                            )}
                          </IconButton>
                        </Tooltip>

                        <Tooltip title="Clone layer (copies above, hides original as backup)">
                          <IconButton
                            size="small"
                            onClick={() => handleCloneLayer(lData.layer.id)}
                            sx={cloneLayerButtonSx}
                          >
                            <ContentCopyIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>

                        <Tooltip title="Delete layer">
                          <IconButton
                            size="small"
                            onClick={() => handleDeleteLayer(lData.layer.id)}
                            sx={deleteLayerButtonSx}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Box>
                    </Box>
                    {isExpanded && (
                      <Box sx={elementListSx}>
                        {lData.elements.map((element) => {
                          const elementVisible = element.visible !== false;
                          const isSelectedElement =
                            selectedItem?.id === element.id &&
                            selectedItem?.isLayerElement;
                          const label =
                            (element.text || "").trim() || "(no text)";
                          return (
                            <Box
                              key={element.id}
                              onClick={() => {
                                setActiveLayerId(lData.layer.id);
                                setSelectedItem({
                                  ...element,
                                  isLayerElement: true,
                                });
                              }}
                              sx={[
                                elementRowSx,
                                {
                                  opacity: elementVisible ? 1 : 0.55,
                                  backgroundColor: isSelectedElement
                                    ? "var(--primary-glow)"
                                    : "transparent",
                                },
                              ]}
                            >
                              <Typography
                                component="span"
                                sx={elementLabelSx}
                                title={label}
                              >
                                {label}
                              </Typography>
                              <Tooltip
                                title={
                                  elementVisible
                                    ? "Hide element"
                                    : "Show element"
                                }
                              >
                                <IconButton
                                  size="small"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleSetElementVisibility(
                                      element,
                                      !elementVisible,
                                    );
                                  }}
                                  sx={{
                                    color: elementVisible
                                      ? "var(--primary)"
                                      : "var(--text-dim, var(--text-muted))",
                                  }}
                                >
                                  {elementVisible ? (
                                    <VisibilityIcon fontSize="small" />
                                  ) : (
                                    <VisibilityOffIcon fontSize="small" />
                                  )}
                                </IconButton>
                              </Tooltip>
                            </Box>
                          );
                        })}
                      </Box>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </SidebarSection>

          {/* Editor Tools Section */}
          <SidebarSection title="Editor Tools">
            <Box sx={editorToolRowSx}>
              <Button
                variant="outlined"
                size="small"
                sx={editorToolButtonSx}
                onClick={() => handleAddNewElement("text")}
                disabled={!activeLayerId}
                title={
                  activeLayerId
                    ? "Add a new text element to active layer"
                    : "Select or create a layer first"
                }
              >
                Add Text
              </Button>
              <Button
                variant="outlined"
                size="small"
                sx={editorToolButtonSx}
                onClick={() => handleAddNewElement("mask")}
                disabled={!activeLayerId}
                title={
                  activeLayerId
                    ? "Add a new background mask to active layer"
                    : "Select or create a layer first"
                }
              >
                Add Mask
              </Button>
            </Box>
            <Button
              variant="outlined"
              size="small"
              startIcon={<ColorizeIcon />}
              fullWidth
              sx={colorDropperButtonSx}
              onClick={() => handleLaunchEyeDropper("backgroundColor")}
              disabled={!selectedItem || !selectedItem.isLayerElement}
              title="Sample color from screen to apply to selected element's background"
            >
              Color Dropper
            </Button>
          </SidebarSection>

          {/* Page Actions Section */}
          <SidebarSection title="Page Actions">
            <Button
              variant="outlined"
              size="small"
              startIcon={
                isRedoingPageOcr ? (
                  <CircularProgress
                    size={12}
                    sx={inlineSpinnerSx}
                  />
                ) : (
                  <RefreshIcon />
                )
              }
              onClick={handleRedoPageOcr}
              disabled={isRedoingPageOcr}
              fullWidth
              title="Discards this page's current OCR results and re-runs detection"
              sx={redoOcrButtonSx}
            >
              Redo Page OCR
            </Button>
            <Button
              variant="outlined"
              size="small"
              startIcon={
                isRedoingPageTranslation ? (
                  <CircularProgress
                    size={12}
                    sx={inlineSpinnerSx}
                  />
                ) : (
                  <RefreshIcon />
                )
              }
              onClick={handleRedoPageTranslation}
              disabled={isRedoingPageTranslation}
              fullWidth
              title="Discards this page's current translation and re-runs it"
              sx={redoTranslationButtonSx}
            >
              Redo Page Translation
            </Button>
          </SidebarSection>

          {/* Export Section */}
          <SidebarSection
            title="Export"
            sx={exportSectionSx}
          >
            <Button
              variant="outlined"
              size="small"
              startIcon={<FileDownloadIcon />}
              onClick={handleExportPng}
              fullWidth
              sx={exportButtonWithMarginSx}
            >
              Export Page (PNG)
            </Button>
            <Button
              variant="outlined"
              size="small"
              startIcon={<FileDownloadIcon />}
              onClick={handleExportZip}
              fullWidth
              sx={exportButtonWithMarginSx}
            >
              Export Project (ZIP)
            </Button>
            <Button
              variant="outlined"
              size="small"
              startIcon={<FileDownloadIcon />}
              onClick={handleExportRenderedPng}
              fullWidth
              sx={exportButtonSx}
            >
              Export Rendered PNG
            </Button>
          </SidebarSection>
        </>
      )}

      {selectedItem && selectedItem.isLayerElement && (
        <Grid
          className="ocr-detail-card"
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <Box sx={inspectorHeaderRowSx}>
            <Box>
              <Typography
                variant="overline"
                component="div"
                sx={inspectorTitleSx}
              >
                Element Inspector
              </Typography>
              <Typography
                variant="caption"
                sx={inspectorSubtitleSx}
              >
                {selectedItem.text !== undefined && selectedItem.text !== null
                  ? "Text element"
                  : "Mask element"}
              </Typography>
            </Box>
            <Button
              variant="outlined"
              size="small"
              onClick={() => setSelectedItem(null)}
              sx={deselectButtonSx}
            >
              Deselect
            </Button>
          </Box>

          {/* Content */}
          <SidebarSection title="Content">
            <Grid
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <FieldLabel htmlFor="element-text-content">
                Text Content
              </FieldLabel>
              <TextField
                id="element-text-content"
                multiline
                minRows={3}
                fullWidth
                variant="outlined"
                size="small"
                value={selectedItem.text || ""}
                onChange={(e) =>
                  handleUpdateSelectedElement({ text: e.target.value })
                }
                sx={textContentFieldSx}
              />
            </Grid>

            {/* Manual Region Redo Section */}
            {selectedItem.regionId && (
              <Grid
                container
                spacing={1}
                sx={regionRedoGridSx}
              >
                <Grid
                  size={6}
                  sx={regionRedoColSx}
                >
                  <Button
                    fullWidth
                    variant="outlined"
                    size="small"
                    style={{
                      justifyContent: "center",
                      gap: "6px",
                      fontSize: "12px",
                      padding: "8px 6px",
                      height: "36px",
                    }}
                    disabled={
                      isRedoingRegionOcr ||
                      (selectedItem &&
                        "layerType" in selectedItem &&
                        (selectedItem.layerType === "translation" ||
                          selectedItem.layerType === "tl"))
                    }
                    title={
                      selectedItem &&
                      "layerType" in selectedItem &&
                      (selectedItem.layerType === "translation" ||
                        selectedItem.layerType === "tl")
                        ? "Select an OCR layer element to redo OCR"
                        : undefined
                    }
                    onClick={() => {
                      const actualRegion = ocrRegions.find(
                        (r) => r.id === selectedItem.regionId,
                      );
                      if (actualRegion) handleRedoRegion(actualRegion, "ocr");
                    }}
                  >
                    {isRedoingRegionOcr ? (
                      <CircularProgress
                        size={12}
                        sx={redoSpinnerMarginSx}
                      />
                    ) : (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                      </svg>
                    )}
                    Redo OCR
                  </Button>
                </Grid>

                <Grid
                  size={6}
                  sx={regionRedoColSx}
                >
                  <Button
                    fullWidth
                    variant="outlined"
                    size="small"
                    style={{
                      justifyContent: "center",
                      gap: "6px",
                      fontSize: "12px",
                      padding: "8px 6px",
                      height: "36px",
                    }}
                    disabled={isRedoingRegionTl}
                    onClick={() => {
                      const actualRegion = ocrRegions.find(
                        (r) => r.id === selectedItem.regionId,
                      );
                      if (actualRegion)
                        handleRedoRegion(actualRegion, "translation");
                    }}
                  >
                    {isRedoingRegionTl ? (
                      <CircularProgress
                        size={12}
                        sx={redoSpinnerMarginSx}
                      />
                    ) : (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                      </svg>
                    )}
                    Redo TL
                  </Button>
                </Grid>
              </Grid>
            )}
          </SidebarSection>

          {/* Position & Size */}
          <SidebarSection title="Position & Size">
            {/* Positioning Coordinates Row */}
            <Grid
              container
              spacing={1}
            >
              <Grid
                size={6}
                sx={fieldColumnSx}
              >
                <FieldLabel htmlFor="element-x">X Position</FieldLabel>
                <TextField
                  id="element-x"
                  type="number"
                  size="small"
                  value={selectedItem.x}
                  onChange={(e) =>
                    handleUpdateSelectedElement({
                      x: parseFloat(e.target.value) || 0,
                    })
                  }
                  sx={numericFieldInputSx}
                />
              </Grid>
              <Grid
                size={6}
                sx={fieldColumnSx}
              >
                <FieldLabel htmlFor="element-y">Y Position</FieldLabel>
                <TextField
                  id="element-y"
                  type="number"
                  size="small"
                  value={selectedItem.y}
                  onChange={(e) =>
                    handleUpdateSelectedElement({
                      y: parseFloat(e.target.value) || 0,
                    })
                  }
                  sx={numericFieldInputSx}
                />
              </Grid>
            </Grid>

            {/* Dimensions Row */}
            <Grid
              container
              spacing={1}
            >
              <Grid
                size={6}
                sx={fieldColumnSx}
              >
                <FieldLabel htmlFor="element-max-width">Max Width</FieldLabel>
                <TextField
                  id="element-max-width"
                  type="number"
                  size="small"
                  value={selectedItem.maxWidth || 0}
                  onChange={(e) =>
                    handleUpdateSelectedElement({
                      maxWidth: parseInt(e.target.value) || 0,
                    })
                  }
                  sx={numericFieldInputSx}
                />
              </Grid>
              <Grid
                size={6}
                sx={fieldColumnSx}
              >
                <FieldLabel htmlFor="element-max-height">Max Height</FieldLabel>
                <TextField
                  id="element-max-height"
                  type="number"
                  size="small"
                  value={selectedItem.maxHeight || 0}
                  onChange={(e) =>
                    handleUpdateSelectedElement({
                      maxHeight: parseInt(e.target.value) || 0,
                    })
                  }
                  sx={numericFieldInputSx}
                />
              </Grid>
            </Grid>

            {/* Drag & Reshape Mode Buttons — contextually swap to Undo during active modes */}
            <Grid
              style={{ display: "flex", flexDirection: "column", gap: "6px" }}
            >
              <Grid style={{ display: "flex", gap: "6px" }}>
                {/* LEFT BUTTON: Drag (idle) or Undo (while reshaping) */}
                {interactionMode === "reshape" ? (
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<UndoIcon />}
                    style={{ flex: 1, fontSize: "12px" }}
                    onClick={handleUndo}
                    disabled={undoStack.length === 0}
                    title={`Undo last action${undoStack.length > 0 ? ` (${undoStack.length} available)` : " — nothing to undo"}`}
                  >
                    Undo
                  </Button>
                ) : (
                  <Button
                    variant={
                      interactionMode === "drag" ? "contained" : "outlined"
                    }
                    size="small"
                    startIcon={<OpenWithIcon />}
                    style={{ flex: 1, fontSize: "12px" }}
                    onClick={() =>
                      setInteractionMode((prev) =>
                        prev === "drag" ? "none" : "drag",
                      )
                    }
                    title="Drag the element to a new position on the image"
                    sx={
                      interactionMode === "drag" ? activeModeGlowSx : undefined
                    }
                  >
                    {interactionMode === "drag" ? "Dragging…" : "Drag"}
                  </Button>
                )}

                {/* RIGHT BUTTON: Reshape (idle) or Undo (while dragging) */}
                {interactionMode === "drag" ? (
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<UndoIcon />}
                    style={{ flex: 1, fontSize: "12px" }}
                    onClick={handleUndo}
                    disabled={undoStack.length === 0}
                    title={`Undo last action${undoStack.length > 0 ? ` (${undoStack.length} available)` : " — nothing to undo"}`}
                  >
                    Undo
                  </Button>
                ) : (
                  <Button
                    variant={
                      interactionMode === "reshape" ? "contained" : "outlined"
                    }
                    size="small"
                    startIcon={<CropIcon />}
                    style={{ flex: 1, fontSize: "12px" }}
                    onClick={() => {
                      if (interactionMode === "reshape") {
                        setInteractionMode("none");
                      } else {
                        handleEnterReshapeMode(selectedItem as LayerElement);
                      }
                    }}
                    title="Drag individual vertices to reshape the bubble polygon. Auto-generates polygon for rect/ellipse shapes."
                    sx={
                      interactionMode === "reshape"
                        ? activeModeGlowSx
                        : undefined
                    }
                  >
                    {interactionMode === "reshape" ? "Reshaping…" : "Reshape"}
                  </Button>
                )}
              </Grid>
              {interactionMode !== "none" && (
                <Typography
                  variant="caption"
                  sx={interactionHintTextSx}
                >
                  {interactionMode === "drag"
                    ? "Touch or drag the bubble on the page to move it."
                    : "Drag a vertex to reshape, or the top handle to rotate."}
                </Typography>
              )}
            </Grid>
          </SidebarSection>

          {/* Typography */}
          <SidebarSection title="Typography">
            {/* Font & Style settings */}
            <Grid
              container
              spacing={1}
            >
              <Grid
                size={6}
                sx={fieldColumnSx}
              >
                <FieldLabel id="element-font-family-label">
                  Font Family
                </FieldLabel>
                <Select
                  labelId="element-font-family-label"
                  size="small"
                  value={selectedItem.font || "Comic Neue"}
                  onChange={(e) =>
                    handleUpdateSelectedElement({ font: e.target.value })
                  }
                  sx={selectFieldSx}
                >
                  <MenuItem value="Comic Neue">Comic Neue</MenuItem>
                  <MenuItem value="Bangers">Bangers</MenuItem>
                  <MenuItem value="Luckiest Guy">Luckiest Guy</MenuItem>
                  <MenuItem value="Arial">Arial</MenuItem>
                  <MenuItem value="Courier New">Courier New</MenuItem>
                </Select>
              </Grid>
              <Grid
                size={6}
                sx={fieldColumnSx}
              >
                <FieldLabel htmlFor="element-font-size">
                  Font Size (pt)
                </FieldLabel>
                <TextField
                  id="element-font-size"
                  type="number"
                  size="small"
                  value={selectedItem.size || 16}
                  onChange={(e) =>
                    handleUpdateSelectedElement({
                      size: parseFloat(e.target.value) || 12,
                      autoSize: false,
                    })
                  }
                  sx={numericFieldInputSx}
                />
              </Grid>
            </Grid>

            {/* Font Weight & Style Row */}
            <Grid
              container
              spacing={1}
            >
              <Grid
                size={6}
                sx={fieldColumnSx}
              >
                <FieldLabel id="element-font-weight-label">
                  Font Weight
                </FieldLabel>
                <Select
                  labelId="element-font-weight-label"
                  size="small"
                  value={selectedItem.fontWeight || "normal"}
                  onChange={(e) =>
                    handleUpdateSelectedElement({
                      fontWeight: e.target.value as string,
                    })
                  }
                  sx={selectFieldSx}
                >
                  <MenuItem value="normal">Normal</MenuItem>
                  <MenuItem value="bold">Bold</MenuItem>
                </Select>
              </Grid>
              <Grid
                size={6}
                sx={fieldColumnSx}
              >
                <FieldLabel id="element-font-style-label">
                  Font Style
                </FieldLabel>
                <Select
                  labelId="element-font-style-label"
                  size="small"
                  value={selectedItem.fontStyle || "normal"}
                  onChange={(e) =>
                    handleUpdateSelectedElement({
                      fontStyle: e.target.value as string,
                    })
                  }
                  sx={selectFieldSx}
                >
                  <MenuItem value="normal">Normal</MenuItem>
                  <MenuItem value="italic">Italic</MenuItem>
                </Select>
              </Grid>
            </Grid>
          </SidebarSection>

          {/* Appearance */}
          <SidebarSection title="Appearance">
            {/* Box Shape selection */}
            <Grid
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <FieldLabel id="element-box-shape-label">Box Shape</FieldLabel>
              <Select
                labelId="element-box-shape-label"
                size="small"
                value={selectedItem.boxShape || "rectangular"}
                onChange={(e) =>
                  handleUpdateSelectedElement({
                    boxShape: e.target.value as string,
                  })
                }
                sx={selectFieldSx}
              >
                <MenuItem value="rectangular">Rectangular</MenuItem>
                <MenuItem value="elliptical">
                  Elliptical (Contour-Based)
                </MenuItem>
              </Select>
            </Grid>

            {/* Mask Background Color (only relevant if clean background mask is enabled) */}
            {selectedItem.wordWrap && (
              <ColorPicker
                label="Mask Background Color"
                value={
                  selectedItem.backgroundColor !== undefined &&
                  selectedItem.backgroundColor !== null
                    ? selectedItem.backgroundColor
                    : "#ffffff"
                }
                onChange={(val) =>
                  handleUpdateSelectedElement({ backgroundColor: val })
                }
                onLaunchEyeDropper={() =>
                  handleLaunchEyeDropper("backgroundColor")
                }
                allowTransparent={true}
              />
            )}

            {/* Text Color (only relevant if it is a text-bearing element) */}
            {selectedItem.text !== undefined && selectedItem.text !== null && (
              <ColorPicker
                label="Text Color"
                value={
                  selectedItem.textColor !== undefined &&
                  selectedItem.textColor !== null
                    ? selectedItem.textColor
                    : "#000000"
                }
                onChange={(val) =>
                  handleUpdateSelectedElement({ textColor: val })
                }
                onLaunchEyeDropper={() => handleLaunchEyeDropper("textColor")}
                allowTransparent={false}
              />
            )}

            {/* Rotation Slider */}
            <Grid
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <FieldLabel id="element-rotation-label">
                Rotation ({selectedItem.rotation || 0}°)
              </FieldLabel>
              <Slider
                aria-labelledby="element-rotation-label"
                size="small"
                min={0}
                max={360}
                value={selectedItem.rotation || 0}
                onChange={(_, val) =>
                  handleUpdateSelectedElement({
                    rotation: val as number,
                  })
                }
                sx={rotationSliderSx}
              />
            </Grid>
          </SidebarSection>

          {/* Behavior */}
          <SidebarSection title="Behavior">
            {/* Checkboxes Row */}
            <Grid
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={selectedItem.autoSize}
                    onChange={(e) =>
                      handleUpdateSelectedElement({
                        autoSize: e.target.checked,
                      })
                    }
                  />
                }
                slotProps={{ typography: { fontSize: "12px" } }}
                label="Auto-size text to fit bubble"
              />

              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={selectedItem.visible}
                    onChange={(e) =>
                      handleUpdateSelectedElement({
                        visible: e.target.checked,
                      })
                    }
                  />
                }
                slotProps={{ typography: { fontSize: "12px" } }}
                label="Visible"
              />

              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={selectedItem.wordWrap}
                    onChange={(e) =>
                      handleUpdateSelectedElement({
                        wordWrap: e.target.checked,
                      })
                    }
                  />
                }
                slotProps={{ typography: { fontSize: "12px" } }}
                label="Clean background mask"
              />
            </Grid>
          </SidebarSection>

          {/* Action Buttons */}
          <Grid
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              marginTop: "4px",
            }}
          >
            {dirtyElements.has(selectedItem.id) && (
              <Box sx={unsavedChangesRowSx}>
                <Box sx={unsavedChangesDotSx} />
                Unsaved changes
              </Box>
            )}
            <Grid style={{ display: "flex", gap: "8px" }}>
              <Button
                variant="contained"
                color="primary"
                size="small"
                style={{
                  flex: 1,
                  padding: "8px",
                  boxShadow: "none",
                  border: dirtyElements.has(selectedItem.id)
                    ? "1px solid var(--warning, #eab308)"
                    : undefined,
                }}
                onClick={() =>
                  handleSaveElementChanges(selectedItem as LayerElement)
                }
              >
                Save
              </Button>
              <Button
                variant="outlined"
                color="error"
                size="small"
                style={{
                  flex: 1,
                  padding: "8px",
                }}
                onClick={() => handleDeleteElement(selectedItem.id)}
              >
                Delete
              </Button>
            </Grid>
          </Grid>
        </Grid>
      )}

      {selectedItem && !selectedItem.isLayerElement && (
        <Grid
          className="ocr-detail-card"
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <Grid
            className="panel-section-title"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              margin: 0,
            }}
          >
            <Typography component="span">
              {selectedItem.isConversation
                ? "Conversation Inspector"
                : "Region Inspector"}
            </Typography>
            <Button
              variant="outlined"
              size="small"
              onClick={() => setSelectedItem(null)}
              sx={deselectButtonSx}
            >
              Deselect
            </Button>
          </Grid>

          <Grid
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "6px",
              margin: "4px 0 8px",
            }}
          >
            <MetaBadge
              overrides={{
                backgroundColor: "var(--primary-glow)",
                color: "var(--primary-hover)",
                borderColor: "var(--primary)",
              }}
            >
              {selectedItem.isConversation
                ? `Conv #${selectedItem.regions[0]?.bubbleReadingOrder}`
                : `Bubble #${selectedItem.regions[0]?.bubbleReadingOrder}`}
            </MetaBadge>
            <MetaBadge
              overrides={{
                backgroundColor: "var(--success-glow)",
                color: "var(--success)",
              }}
            >
              {selectedItem.regions[0]?.detectedLanguage || "unknown"}
            </MetaBadge>
            {selectedItem.isConversation && (
              <MetaBadge overrides={{ textTransform: "capitalize" }}>
                {selectedItem.sceneType}
              </MetaBadge>
            )}
            {selectedItem.approved && (
              <MetaBadge
                overrides={{
                  backgroundColor: "rgba(16, 185, 129, 0.15)",
                  color: "var(--success)",
                  borderColor: "var(--success)",
                }}
              >
                Approved
              </MetaBadge>
            )}
          </Grid>

          <Grid
            style={{
              fontSize: "12px",
              color: "var(--text-muted)",
              marginBottom: "8px",
            }}
          >
            Position: x={selectedItem.bboxX}, y={selectedItem.bboxY} (
            {selectedItem.bboxW}x{selectedItem.bboxH})
          </Grid>

          <Grid
            style={{
              overflowY: "auto",
              flex: 1,
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            {selectedItem.regions.map((reg: OcrRegion, idx: number) => (
              <Grid
                key={reg.id}
                style={{
                  borderBottom:
                    idx < selectedItem.regions.length - 1
                      ? "1px dashed var(--border-color)"
                      : "none",
                  paddingBottom: "12px",
                }}
              >
                <Grid
                  style={{
                    fontSize: "10px",
                    fontWeight: 700,
                    color: "var(--text-muted)",
                    marginBottom: "4px",
                    textTransform: "uppercase",
                  }}
                >
                  Region #{idx + 1} Original
                </Grid>
                <Grid
                  className="ocr-text-preview"
                  style={{ marginBottom: "8px" }}
                >
                  {reg.text}
                </Grid>

                {reg.translatedText && (
                  <>
                    <Grid
                      style={{
                        fontSize: "10px",
                        fontWeight: 700,
                        color: "var(--text-muted)",
                        marginBottom: "4px",
                        textTransform: "uppercase",
                      }}
                    >
                      Region #{idx + 1} Translation
                    </Grid>
                    <Grid
                      className="ocr-text-preview"
                      style={{
                        color: "var(--primary-hover)",
                        borderColor: "var(--primary)",
                      }}
                    >
                      {reg.translatedText}
                    </Grid>
                  </>
                )}
              </Grid>
            ))}
          </Grid>
        </Grid>
      )}
    </Grid>
  );
};

export default React.memo(ReaderRightSidebar);
