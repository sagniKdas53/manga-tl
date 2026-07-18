import React from 'react';
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
import { ColorPicker } from "./ColorPicker";
import type { Layer, LayerElement, OcrRegion } from "../types";

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
  setInteractionMode: React.Dispatch<React.SetStateAction<"none" | "drag" | "reshape">>;
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
    selectedItem, setSelectedItem,
    activeLayerId, setActiveLayerId,
    sortedLayers,
    handleMoveLayer, handleCreateTranslationLayer, handleCreateSfxLayer,
    handleToggleLayerVisibility, handleCloneLayer, handleDeleteLayer,
    handleAddNewElement, handleLaunchEyeDropper,
    handleRedoPageOcr, isRedoingPageOcr,
    handleRedoPageTranslation, isRedoingPageTranslation,
    handleExportPng, handleExportZip,
    interactionMode, setInteractionMode, undoStack, handleUndo, handleEnterReshapeMode,
    handleUpdateSelectedElement, dirtyElements, handleSaveElementChanges, handleDeleteElement,
    ocrRegions, isRedoingRegionOcr, handleRedoRegion, isRedoingRegionTl
  } = props;

  return (
<div className="reader-right-sidebar-nhentai">
            {!selectedItem && (
              <>
                <div
                  style={{
                    color: "var(--text-muted)",
                    fontSize: "13px",
                    textAlign: "center",
                    padding: "16px 0 24px",
                    borderBottom: "1px solid var(--border-color)",
                    marginBottom: "24px",
                  }}
                >
                  Select an OCR region or a text layer to inspect and edit
                  details.
                </div>

                {/* Translation Layers Section */}
                <div className="panel-section">
                  <div
                    className="panel-section-title"
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span>Layers</span>
                    <div
                      style={{
                        display: "flex",
                        gap: "4px",
                        alignItems: "center",
                      }}
                    >
                      {/* Up/Down reorder buttons — left group */}
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
                          activeLayerId &&
                          handleMoveLayer(activeLayerId, "down")
                        }
                      >
                        <KeyboardArrowDownIcon fontSize="small" />
                      </IconButton>
                      {/* Divider */}
                      <div
                        style={{
                          width: "1px",
                          height: "14px",
                          background: "var(--border-color)",
                          margin: "0 2px",
                        }}
                      />
                      {/* Add layer buttons — right group */}
                      <Button
                        variant="outlined"
                        size="small"
                        startIcon={<AddIcon />}
                        style={{ fontSize: "10px" }}
                        onClick={handleCreateTranslationLayer}
                        title="Add Translation Layer"
                      >
                        TL
                      </Button>
                      <Button
                        variant="outlined"
                        size="small"
                        startIcon={<AddIcon />}
                        style={{ fontSize: "10px" }}
                        onClick={handleCreateSfxLayer}
                        title="Add SFX Layer"
                      >
                        SFX
                      </Button>
                    </div>
                  </div>

                  {sortedLayers.length === 0 ? (
                    <div
                      style={{
                        fontSize: "11px",
                        color: "var(--text-muted)",
                        padding: "4px 0",
                      }}
                    >
                      No active layers.
                    </div>
                  ) : (
                    [...sortedLayers].reverse().map((lData, idx) => {
                      const isActive = lData.layer.id === activeLayerId;
                      const stackNumber = sortedLayers.length - idx;
                      const stackLabel = `#${stackNumber}`;
                      return (
                        <div
                          key={lData.layer.id}
                          className="overlay-toggle"
                          onClick={() => setActiveLayerId(lData.layer.id)}
                          style={{
                            padding: "6px 8px",
                            border: isActive
                              ? "1px solid var(--primary)"
                              : "1px solid var(--border-color)",
                            borderRadius: "6px",
                            marginBottom: "6px",
                            backgroundColor: isActive
                              ? "var(--primary-glow)"
                              : "rgba(255,255,255,0.02)",
                            cursor: "pointer",
                            boxShadow: isActive
                              ? "0 0 8px var(--primary-glow)"
                              : "none",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "2px",
                            }}
                          >
                            <span
                              style={{
                                fontSize: "12px",
                                fontWeight: isActive ? 700 : 600,
                                color: isActive
                                  ? "var(--primary-hover)"
                                  : "inherit",
                              }}
                            >
                              {stackLabel}{" "}
                              {typeof lData.layer.metadataJson?.layer_name === "string" ? lData.layer.metadataJson.layer_name :
                                (lData.layer.type === "translation"
                                  ? `Translation (${lData.layer.targetLanguage?.toUpperCase() || "EN"})`
                                  : lData.layer.type === "sfx"
                                    ? "SFX Layer"
                                    : lData.layer.type === "ocr"
                                      ? "OCR Layer"
                                      : `Layer (${lData.layer.type})`)}
                            </span>
                            <span
                              style={{
                                fontSize: "9px",
                                color: "var(--text-dim)",
                              }}
                            >
                              {lData.elements.length} elements
                            </span>
                          </div>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "8px",
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <IconButton
                              size="small"
                              onClick={() =>
                                handleToggleLayerVisibility(lData.layer.id)
                              }
                              color={
                                lData.layer.visible ? "primary" : "default"
                              }
                              title="Toggle layer visibility"
                            >
                              {lData.layer.visible ? (
                                <VisibilityIcon fontSize="small" />
                              ) : (
                                <VisibilityOffIcon fontSize="small" />
                              )}
                            </IconButton>

                            <IconButton
                              size="small"
                              onClick={() => handleCloneLayer(lData.layer.id)}
                              title="Clone layer (copies above, hides original as backup)"
                            >
                              <ContentCopyIcon fontSize="small" />
                            </IconButton>

                            <IconButton
                              size="small"
                              onClick={() => handleDeleteLayer(lData.layer.id)}
                              title="Delete layer"
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* Editor Tools Section */}
                <div className="panel-section">
                  <div className="panel-section-title">Editor Tools</div>
                  <div
                    style={{ display: "flex", gap: "8px", marginBottom: "8px" }}
                  >
                    <Button
                      variant="outlined"
                      size="small"
                      style={{
                        flex: 1,
                        padding: "8px",
                        fontSize: "11px",
                        fontWeight: 600,
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
                      style={{
                        flex: 1,
                        padding: "8px",
                        fontSize: "11px",
                        fontWeight: 600,
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
                  </div>
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<ColorizeIcon />}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                    }}
                    onClick={() => handleLaunchEyeDropper("backgroundColor")}
                    disabled={!selectedItem || !selectedItem.isLayerElement}
                    title="Sample color from screen to apply to selected element's background"
                  >
                    Color Dropper
                  </Button>
                </div>

                {/* Page Actions Section */}
                <div className="panel-section">
                  <div className="panel-section-title">Page Actions</div>
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<RefreshIcon />}
                    onClick={handleRedoPageOcr}
                    disabled={isRedoingPageOcr}
                    style={{
                      width: "100%",
                      marginBottom: "8px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                    }}
                  >
                    {isRedoingPageOcr ? (
                      <CircularProgress size={12} sx={{ mr: 0.5 }} />
                    ) : null}
                    Redo Page OCR
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<RefreshIcon />}
                    onClick={handleRedoPageTranslation}
                    disabled={isRedoingPageTranslation}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                    }}
                  >
                    {isRedoingPageTranslation ? (
                      <CircularProgress size={12} sx={{ mr: 0.5 }} />
                    ) : null}
                    Redo Page Translation
                  </Button>
                </div>

                {/* Export Section */}
                <div
                  className="panel-section"
                  style={{ paddingBottom: "40px" }}
                >
                  <div className="panel-section-title">Export</div>
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<FileDownloadIcon />}
                    onClick={handleExportPng}
                    style={{
                      width: "100%",
                      marginBottom: "8px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                    }}
                  >
                    Export Page (PNG)
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    startIcon={<FileDownloadIcon />}
                    onClick={handleExportZip}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                    }}
                  >
                    Export Project (ZIP)
                  </Button>
                </div>
              </>
            )}

            {selectedItem && selectedItem.isLayerElement && (
              <div
                className="ocr-detail-card"
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                <div
                  className="panel-section-title"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    margin: 0,
                  }}
                >
                  <span>Element Inspector</span>
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
                </div>

                {/* Text Content */}
                <div
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
                </div>

                {/* Manual Region Redo Section */}
                {selectedItem.regionId && (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "8px",
                      marginBottom: "4px",
                    }}
                  >
                    <Button
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
                        <CircularProgress size={12} sx={{ mr: 0.5 }} />
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

                    <Button
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
                        <CircularProgress size={12} sx={{ mr: 0.5 }} />
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
                  </div>
                )}

                {/* Positioning Coordinates Row */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "8px",
                  }}
                >
                  <div
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
                      sx={{ "& .MuiInputBase-input": { fontSize: "13px", padding: "6px 10px" } }}
                    />
                  </div>
                  <div
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
                      sx={{ "& .MuiInputBase-input": { fontSize: "13px", padding: "6px 10px" } }}
                    />
                  </div>
                </div>

                {/* Dimensions Row */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "8px",
                  }}
                >
                  <div
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
                      sx={{ "& .MuiInputBase-input": { fontSize: "13px", padding: "6px 10px" } }}
                    />
                  </div>
                  <div
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
                      sx={{ "& .MuiInputBase-input": { fontSize: "13px", padding: "6px 10px" } }}
                    />
                  </div>
                </div>

                {/* Drag & Reshape Mode Buttons — contextually swap to Undo during active modes */}
                <div style={{ margin: "4px 0", display: "flex", gap: "6px" }}>
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
                      variant={interactionMode === "drag" ? "contained" : "outlined"}
                      size="small"
                      startIcon={<OpenWithIcon />}
                      style={{ flex: 1, fontSize: "12px" }}
                      onClick={() =>
                        setInteractionMode((prev) =>
                          prev === "drag" ? "none" : "drag",
                        )
                      }
                      title="Drag the element to a new position on the image"
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
                      variant={interactionMode === "reshape" ? "contained" : "outlined"}
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
                    >
                      {interactionMode === "reshape" ? "Reshaping…" : "Reshape"}
                    </Button>
                  )}
                </div>

                {/* Font & Style settings */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "8px",
                  }}
                >
                  <div
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
                  </div>
                  <div
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
                      sx={{ "& .MuiInputBase-input": { fontSize: "13px", padding: "6px 10px" } }}
                    />
                  </div>
                </div>

                {/* Font Weight & Style Row */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "8px",
                  }}
                >
                  <div
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
                  </div>
                  <div
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
                  </div>
                </div>

                {/* Box Shape selection */}
                <div
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
                      handleUpdateSelectedElement({ boxShape: e.target.value as string })
                    }
                    sx={{
                      fontSize: "13px",
                      height: "38px",
                      backgroundColor: "var(--bg-surface)",
                    }}
                  >
                    <MenuItem value="rectangular">Rectangular</MenuItem>
                    <MenuItem value="elliptical">Elliptical (Contour-Based)</MenuItem>
                  </Select>
                </div>

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
                {selectedItem.text !== undefined &&
                  selectedItem.text !== null && (
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
                      onLaunchEyeDropper={() =>
                        handleLaunchEyeDropper("textColor")
                      }
                      allowTransparent={false}
                    />
                  )}

                {/* Rotation Slider */}
                <div
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
                </div>

                {/* Checkboxes Row */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                    borderTop: "1px solid var(--border-color)",
                    paddingTop: "10px",
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
                    label={<span style={{ fontSize: "12px" }}>Auto-size text to fit bubble</span>}
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
                    label={<span style={{ fontSize: "12px" }}>Clean background mask</span>}
                  />
                </div>

                {/* Action Buttons */}
                <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                  <Button
                    variant="contained"
                    color="primary"
                    size="small"
                    style={{
                      flex: 1,
                      padding: "8px",
                      position: "relative",
                      border: dirtyElements.has(selectedItem.id)
                        ? "1px solid var(--warning, #eab308)"
                        : undefined,
                    }}
                    onClick={() => handleSaveElementChanges(selectedItem as LayerElement)}
                  >
                    Save
                    {dirtyElements.has(selectedItem.id) && (
                      <span
                        style={{
                          position: "absolute",
                          top: "6px",
                          right: "6px",
                          width: "6px",
                          height: "6px",
                          borderRadius: "50%",
                          background: "var(--error, #ef4444)",
                        }}
                      />
                    )}
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
                </div>
              </div>
            )}

            {selectedItem && !selectedItem.isLayerElement && (
              <div
                className="ocr-detail-card"
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                <div
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
                </div>

                <div
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
                </div>

                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--text-muted)",
                    marginBottom: "8px",
                  }}
                >
                  Position: x={selectedItem.bboxX}, y={selectedItem.bboxY} (
                  {selectedItem.bboxW}x{selectedItem.bboxH})
                </div>

                <div
                  style={{
                    overflowY: "auto",
                    flex: 1,
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                  }}
                >
                  {selectedItem.regions.map((reg: OcrRegion, idx: number) => (
                    <div
                      key={reg.id}
                      style={{
                        borderBottom:
                          idx < selectedItem.regions.length - 1
                            ? "1px dashed var(--border-color)"
                            : "none",
                        paddingBottom: "12px",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "10px",
                          fontWeight: 700,
                          color: "var(--text-muted)",
                          marginBottom: "4px",
                          textTransform: "uppercase",
                        }}
                      >
                        Region #{idx + 1} Original
                      </div>
                      <div
                        className="ocr-text-preview"
                        style={{ marginBottom: "8px" }}
                      >
                        {reg.text}
                      </div>

                      {reg.translatedText && (
                        <>
                          <div
                            style={{
                              fontSize: "10px",
                              fontWeight: 700,
                              color: "var(--text-muted)",
                              marginBottom: "4px",
                              textTransform: "uppercase",
                            }}
                          >
                            Region #{idx + 1} Translation
                          </div>
                          <div
                            className="ocr-text-preview"
                            style={{
                              color: "var(--primary-hover)",
                              borderColor: "var(--primary)",
                            }}
                          >
                            {reg.translatedText}
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
  );
};

export default React.memo(ReaderRightSidebar);
