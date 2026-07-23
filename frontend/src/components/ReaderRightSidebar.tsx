import React from "react";
import Grid from "@mui/material/Grid";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import {
  IconButton,
  Button,
  CircularProgress,
  TextField,
  Select,
  MenuItem,
  Checkbox,
  FormControlLabel,
  Slider,
  Typography,
} from "@mui/material";
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
import type { Layer, LayerElement, OcrRegion } from "../types";

// --- Shared presentational helpers -----------------------------------------

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
  handleDeleteElement: (id: string) => void;
  ocrRegions: OcrRegion[];
  isRedoingRegionOcr: boolean;
  handleRedoRegion: (region: OcrRegion, type: "ocr" | "translation") => void;
  isRedoingRegionTl: boolean;
}

const ReaderRightSidebar: React.FC<ReaderRightSidebarProps> = (props) => {
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
    handleCloneLayer,
    handleDeleteLayer,
    handleAddNewElement,
    handleLaunchEyeDropper,
    handleRedoPageOcr,
    isRedoingPageOcr,
    handleRedoPageTranslation,
    isRedoingPageTranslation,
    handleExportPng,
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
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 1,
              color: "var(--text-dim, var(--text-muted))",
              textAlign: "center",
              py: 3,
              mb: 2,
              borderBottom: "1px solid var(--border-color)",
            }}
          >
            <LayersIcon sx={{ fontSize: 22, opacity: 0.5 }} />
            <Typography
              variant="body2"
              sx={{
                fontSize: "12.5px",
                color: "var(--text-muted)",
                maxWidth: 210,
              }}
            >
              Select an OCR region or a text layer to inspect and edit details.
            </Typography>
          </Box>

          {/* Translation Layers Section */}
          <SidebarSection
            title="Layers"
            headerExtra={
              <Box sx={{ display: "flex", gap: 0.25, alignItems: "center" }}>
                <IconButton
                  size="small"
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
                  sx={{ p: 0.25, color: "var(--text-muted)" }}
                >
                  <KeyboardArrowUpIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
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
                  sx={{ p: 0.25, color: "var(--text-muted)" }}
                >
                  <KeyboardArrowDownIcon fontSize="small" />
                </IconButton>
                <Box
                  sx={{
                    width: "1px",
                    height: "14px",
                    backgroundColor: "var(--border-color)",
                    mx: 0.5,
                  }}
                />
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<AddIcon sx={{ fontSize: 14 }} />}
                  onClick={handleCreateTranslationLayer}
                  title="Add Translation Layer"
                  sx={{
                    fontSize: "10px",
                    minWidth: 0,
                    px: 1,
                    py: 0.25,
                    color: "var(--text-muted)",
                    borderColor: "var(--border-color)",
                  }}
                >
                  TL
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<AddIcon sx={{ fontSize: 14 }} />}
                  onClick={handleCreateSfxLayer}
                  title="Add SFX Layer"
                  sx={{
                    fontSize: "10px",
                    minWidth: 0,
                    px: 1,
                    py: 0.25,
                    color: "var(--text-muted)",
                    borderColor: "var(--border-color)",
                  }}
                >
                  SFX
                </Button>
              </Box>
            }
          >
            {sortedLayers.length === 0 ? (
              <Typography
                variant="body2"
                sx={{
                  fontSize: "11px",
                  color: "var(--text-dim, var(--text-muted))",
                  py: 0.5,
                }}
              >
                No active layers.
              </Typography>
            ) : (
              [...sortedLayers].reverse().map((lData, idx) => {
                const isActive = lData.layer.id === activeLayerId;
                const isVisible = lData.layer.visible;
                const stackNumber = sortedLayers.length - idx;
                return (
                  <Box
                    key={lData.layer.id}
                    onClick={() => setActiveLayerId(lData.layer.id)}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      p: "6px 8px",
                      mb: 0.75,
                      borderRadius: "8px",
                      cursor: "pointer",
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
                      transition: "opacity 0.15s ease, border-color 0.15s ease",
                      "&:hover": {
                        borderColor: isActive
                          ? "var(--primary)"
                          : "var(--text-dim, var(--text-muted))",
                      },
                    }}
                  >
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 20,
                        height: 20,
                        borderRadius: "5px",
                        fontSize: "10px",
                        fontWeight: 700,
                        flexShrink: 0,
                        backgroundColor: isActive
                          ? "var(--primary)"
                          : "var(--bg-input, rgba(0,0,0,0.06))",
                        color: isActive ? "#fff" : "var(--text-muted)",
                      }}
                    >
                      {stackNumber}
                    </Box>
                    <Box
                      sx={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "2px",
                        flex: 1,
                        minWidth: 0,
                      }}
                    >
                      <Typography
                        component="span"
                        sx={{
                          fontSize: "13px",
                          fontWeight: isActive ? 700 : 600,
                          lineHeight: 1.2,
                          wordBreak: "break-word",
                          color: isActive
                            ? "var(--primary-hover)"
                            : "var(--text-main)",
                        }}
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
                        sx={{
                          fontSize: "9px",
                          color: "var(--text-dim, var(--text-muted))",
                        }}
                      >
                        {lData.elements.length} elements
                        {!isVisible ? " · hidden" : ""}
                      </Typography>
                    </Box>
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.25,
                        flexShrink: 0,
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Tooltip title={isVisible ? "Hide layer" : "Show layer"}>
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
                          sx={{ color: "var(--text-muted)" }}
                        >
                          <ContentCopyIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>

                      <Tooltip title="Delete layer">
                        <IconButton
                          size="small"
                          onClick={() => handleDeleteLayer(lData.layer.id)}
                          sx={{
                            color: "var(--text-muted)",
                            "&:hover": { color: "var(--error)" },
                          }}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  </Box>
                );
              })
            )}
          </SidebarSection>

          {/* Editor Tools Section */}
          <SidebarSection title="Editor Tools">
            <Box sx={{ display: "flex", gap: 1, mb: 1 }}>
              <Button
                variant="outlined"
                size="small"
                sx={{
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
                }}
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
                sx={{
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
                }}
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
              sx={{
                color: "var(--text-main)",
                borderColor: "var(--border-color)",
                "&:hover": {
                  borderColor: "var(--primary)",
                  color: "var(--primary)",
                },
              }}
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
                    sx={{ color: "inherit" }}
                  />
                ) : (
                  <RefreshIcon />
                )
              }
              onClick={handleRedoPageOcr}
              disabled={isRedoingPageOcr}
              fullWidth
              title="Discards this page's current OCR results and re-runs detection"
              sx={{
                mb: 1,
                color: "var(--warning)",
                borderColor: "var(--warning)",
                "&:hover": { backgroundColor: "var(--warning)", color: "#fff" },
              }}
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
                    sx={{ color: "inherit" }}
                  />
                ) : (
                  <RefreshIcon />
                )
              }
              onClick={handleRedoPageTranslation}
              disabled={isRedoingPageTranslation}
              fullWidth
              title="Discards this page's current translation and re-runs it"
              sx={{
                color: "var(--warning)",
                borderColor: "var(--warning)",
                "&:hover": { backgroundColor: "var(--warning)", color: "#fff" },
              }}
            >
              Redo Page Translation
            </Button>
          </SidebarSection>

          {/* Export Section */}
          <SidebarSection
            title="Export"
            sx={{ mb: 5 }}
          >
            <Button
              variant="outlined"
              size="small"
              startIcon={<FileDownloadIcon />}
              onClick={handleExportPng}
              fullWidth
              sx={{
                mb: 1,
                color: "var(--primary)",
                borderColor: "var(--primary)",
                "&:hover": { backgroundColor: "var(--primary)", color: "#fff" },
              }}
            >
              Export Page (PNG)
            </Button>
            <Button
              variant="outlined"
              size="small"
              startIcon={<FileDownloadIcon />}
              onClick={handleExportZip}
              fullWidth
              sx={{
                color: "var(--primary)",
                borderColor: "var(--primary)",
                "&:hover": { backgroundColor: "var(--primary)", color: "#fff" },
              }}
            >
              Export Project (ZIP)
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
          <Box
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              pb: 1.25,
              mb: 0.5,
              borderBottom: "1px solid var(--border-color)",
            }}
          >
            <Box>
              <Typography
                variant="overline"
                component="div"
                sx={{
                  fontSize: "10.5px",
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  color: "var(--text-dim, var(--text-muted))",
                  lineHeight: 1.2,
                }}
              >
                Element Inspector
              </Typography>
              <Typography
                variant="caption"
                sx={{ fontSize: "11px", color: "var(--text-muted)" }}
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
              sx={{
                borderColor: "var(--border-color)",
                color: "var(--text-main)",
                fontSize: "11px",
                fontWeight: 600,
                minWidth: "auto",
                padding: "2px 8px",
              }}
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
              <label
                style={{
                  fontSize: "11px",
                  fontWeight: "bold",
                  color: "var(--text-muted)",
                }}
              >
                Text Content
              </label>
              <TextField
                multiline
                minRows={3}
                fullWidth
                variant="outlined"
                size="small"
                value={selectedItem.text || ""}
                onChange={(e) =>
                  handleUpdateSelectedElement({ text: e.target.value })
                }
                sx={{
                  "& .MuiOutlinedInput-root": {
                    backgroundColor: "var(--bg-input, rgba(0,0,0,0.05))",
                    fontSize: "13px",
                    fontFamily: "inherit",
                  },
                }}
              />
            </Grid>

            {/* Manual Region Redo Section */}
            {selectedItem.regionId && (
              <Grid
                container
                spacing={1}
                sx={{ mb: 0.5 }}
              >
                <Grid
                  size={6}
                  sx={{ display: "flex" }}
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
                        sx={{ mr: 0.5 }}
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
                  sx={{ display: "flex" }}
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
                        sx={{ mr: 0.5 }}
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
                sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}
              >
                <label
                  style={{
                    fontSize: "11px",
                    fontWeight: "bold",
                    color: "var(--text-muted)",
                  }}
                >
                  X Position
                </label>
                <TextField
                  type="number"
                  size="small"
                  value={selectedItem.x}
                  onChange={(e) =>
                    handleUpdateSelectedElement({
                      x: parseFloat(e.target.value) || 0,
                    })
                  }
                  sx={{
                    "& .MuiInputBase-input": {
                      fontSize: "13px",
                      padding: "6px 10px",
                    },
                  }}
                />
              </Grid>
              <Grid
                size={6}
                sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}
              >
                <label
                  style={{
                    fontSize: "11px",
                    fontWeight: "bold",
                    color: "var(--text-muted)",
                  }}
                >
                  Y Position
                </label>
                <TextField
                  type="number"
                  size="small"
                  value={selectedItem.y}
                  onChange={(e) =>
                    handleUpdateSelectedElement({
                      y: parseFloat(e.target.value) || 0,
                    })
                  }
                  sx={{
                    "& .MuiInputBase-input": {
                      fontSize: "13px",
                      padding: "6px 10px",
                    },
                  }}
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
                sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}
              >
                <label
                  style={{
                    fontSize: "11px",
                    fontWeight: "bold",
                    color: "var(--text-muted)",
                  }}
                >
                  Max Width
                </label>
                <TextField
                  type="number"
                  size="small"
                  value={selectedItem.maxWidth || 0}
                  onChange={(e) =>
                    handleUpdateSelectedElement({
                      maxWidth: parseInt(e.target.value) || 0,
                    })
                  }
                  sx={{
                    "& .MuiInputBase-input": {
                      fontSize: "13px",
                      padding: "6px 10px",
                    },
                  }}
                />
              </Grid>
              <Grid
                size={6}
                sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}
              >
                <label
                  style={{
                    fontSize: "11px",
                    fontWeight: "bold",
                    color: "var(--text-muted)",
                  }}
                >
                  Max Height
                </label>
                <TextField
                  type="number"
                  size="small"
                  value={selectedItem.maxHeight || 0}
                  onChange={(e) =>
                    handleUpdateSelectedElement({
                      maxHeight: parseInt(e.target.value) || 0,
                    })
                  }
                  sx={{
                    "& .MuiInputBase-input": {
                      fontSize: "13px",
                      padding: "6px 10px",
                    },
                  }}
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
                      interactionMode === "drag"
                        ? { boxShadow: "0 0 0 3px var(--primary-glow)" }
                        : undefined
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
                        ? { boxShadow: "0 0 0 3px var(--primary-glow)" }
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
                  sx={{
                    fontSize: "10.5px",
                    color: "var(--text-dim, var(--text-muted))",
                  }}
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
                sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}
              >
                <label
                  style={{
                    fontSize: "11px",
                    fontWeight: "bold",
                    color: "var(--text-muted)",
                  }}
                >
                  Font Family
                </label>
                <Select
                  size="small"
                  value={selectedItem.font || "Comic Neue"}
                  onChange={(e) =>
                    handleUpdateSelectedElement({ font: e.target.value })
                  }
                  sx={{
                    fontSize: "13px",
                    height: "38px",
                    backgroundColor: "var(--bg-surface)",
                  }}
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
                sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}
              >
                <label
                  style={{
                    fontSize: "11px",
                    fontWeight: "bold",
                    color: "var(--text-muted)",
                  }}
                >
                  Font Size (pt)
                </label>
                <TextField
                  type="number"
                  size="small"
                  value={selectedItem.size || 16}
                  onChange={(e) =>
                    handleUpdateSelectedElement({
                      size: parseFloat(e.target.value) || 12,
                      autoSize: false,
                    })
                  }
                  sx={{
                    "& .MuiInputBase-input": {
                      fontSize: "13px",
                      padding: "6px 10px",
                    },
                  }}
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
                sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}
              >
                <label
                  style={{
                    fontSize: "11px",
                    fontWeight: "bold",
                    color: "var(--text-muted)",
                  }}
                >
                  Font Weight
                </label>
                <Select
                  size="small"
                  value={selectedItem.fontWeight || "normal"}
                  onChange={(e) =>
                    handleUpdateSelectedElement({
                      fontWeight: e.target.value as string,
                    })
                  }
                  sx={{
                    fontSize: "13px",
                    height: "38px",
                    backgroundColor: "var(--bg-surface)",
                  }}
                >
                  <MenuItem value="normal">Normal</MenuItem>
                  <MenuItem value="bold">Bold</MenuItem>
                </Select>
              </Grid>
              <Grid
                size={6}
                sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}
              >
                <label
                  style={{
                    fontSize: "11px",
                    fontWeight: "bold",
                    color: "var(--text-muted)",
                  }}
                >
                  Font Style
                </label>
                <Select
                  size="small"
                  value={selectedItem.fontStyle || "normal"}
                  onChange={(e) =>
                    handleUpdateSelectedElement({
                      fontStyle: e.target.value as string,
                    })
                  }
                  sx={{
                    fontSize: "13px",
                    height: "38px",
                    backgroundColor: "var(--bg-surface)",
                  }}
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
              <label
                style={{
                  fontSize: "11px",
                  fontWeight: "bold",
                  color: "var(--text-muted)",
                }}
              >
                Box Shape
              </label>
              <Select
                size="small"
                value={selectedItem.boxShape || "rectangular"}
                onChange={(e) =>
                  handleUpdateSelectedElement({
                    boxShape: e.target.value as string,
                  })
                }
                sx={{
                  fontSize: "13px",
                  height: "38px",
                  backgroundColor: "var(--bg-surface)",
                }}
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
              <label
                style={{
                  fontSize: "11px",
                  fontWeight: "bold",
                  color: "var(--text-muted)",
                }}
              >
                Rotation ({selectedItem.rotation || 0}°)
              </label>
              <Slider
                size="small"
                min={0}
                max={360}
                value={selectedItem.rotation || 0}
                onChange={(_, val) =>
                  handleUpdateSelectedElement({
                    rotation: val as number,
                  })
                }
                sx={{ width: "100%", mt: 1 }}
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
                label={
                  <span style={{ fontSize: "12px" }}>
                    Auto-size text to fit bubble
                  </span>
                }
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
                label={<span style={{ fontSize: "12px" }}>Visible</span>}
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
                label={
                  <span style={{ fontSize: "12px" }}>
                    Clean background mask
                  </span>
                }
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
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.5,
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "var(--warning, #eab308)",
                }}
              >
                <Box
                  sx={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    backgroundColor: "var(--warning, #eab308)",
                  }}
                />
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
            <span>
              {selectedItem.isConversation
                ? "Conversation Inspector"
                : "Region Inspector"}
            </span>
            <Button
              variant="outlined"
              size="small"
              onClick={() => setSelectedItem(null)}
              sx={{
                borderColor: "var(--border-color)",
                color: "var(--text-main)",
                fontSize: "11px",
                fontWeight: 600,
                minWidth: "auto",
                padding: "2px 8px",
              }}
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
            <span
              className="meta-badge"
              style={{
                backgroundColor: "var(--primary-glow)",
                color: "var(--primary-hover)",
                borderColor: "var(--primary)",
              }}
            >
              {selectedItem.isConversation
                ? `Conv #${selectedItem.regions[0]?.bubbleReadingOrder}`
                : `Bubble #${selectedItem.regions[0]?.bubbleReadingOrder}`}
            </span>
            <span
              className="meta-badge"
              style={{
                backgroundColor: "var(--success-glow)",
                color: "var(--success)",
              }}
            >
              {selectedItem.regions[0]?.detectedLanguage || "unknown"}
            </span>
            {selectedItem.isConversation && (
              <span
                className="meta-badge"
                style={{ textTransform: "capitalize" }}
              >
                {selectedItem.sceneType}
              </span>
            )}
            {selectedItem.approved && (
              <span
                className="meta-badge"
                style={{
                  backgroundColor: "rgba(16, 185, 129, 0.15)",
                  color: "var(--success)",
                  borderColor: "var(--success)",
                }}
              >
                Approved
              </span>
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
