import React, { useRef } from "react";
import { createPortal } from "react-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Slider from "@mui/material/Slider";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import BrushIcon from "@mui/icons-material/Brush";
import AutoFixOffIcon from "@mui/icons-material/AutoFixOff";
import UndoIcon from "@mui/icons-material/Undo";
import RedoIcon from "@mui/icons-material/Redo";
import SidebarSection from "./SidebarSection";
import {
  PAINT_COLOUR,
  RESTORE_COLOUR,
  useInpaintingEditor,
  type InpaintingEditorState,
  type RepaintMethod,
} from "../hooks/useInpaintingEditor";

/**
 * The mask editor's two halves (2026-09-28): the brush canvases, laid over the page image, and
 * the tool panel, which takes the right sidebar's place so nothing floats over the page.
 *
 * One `InpaintingSession` per page (the Reader keys it by page id, so a new page starts blank)
 * owns the state and portals each half into the host element the Reader gives it.
 *
 * The canvases are the page's own pixel grid (CSS-scaled with the image), so a stroke's
 * coordinates are page pixels and the masks need no rescaling.
 */

interface SessionProps {
  pageId: string;
  token: string;
  /** The page's pixel size: the canvases' own resolution. */
  width: number;
  height: number;
  /** Where the canvases go: a box exactly over the page image. */
  canvasHost: HTMLElement | null;
  /** Where the panel goes: the right sidebar's slot. */
  panelHost: HTMLElement | null;
  patches: PatchListItem[];
  highlightedPatchId: string | null;
  onHighlightPatch: (id: string | null) => void;
  onDone: () => void;
  onQueued: (what: "repaint" | "restore" | "both") => void;
  onError: (message: string) => void;
}

export default function InpaintingSession({
  pageId,
  token,
  width,
  height,
  canvasHost,
  panelHost,
  patches,
  highlightedPatchId,
  onHighlightPatch,
  onDone,
  onQueued,
  onError,
}: SessionProps) {
  const editor = useInpaintingEditor({
    pageId,
    token,
    width,
    height,
    onQueued,
    onError,
  });
  return (
    <>
      {canvasHost && createPortal(<InpaintingCanvas editor={editor} />, canvasHost)}
      {panelHost &&
        createPortal(
          <InpaintingPanel
            editor={editor}
            patches={patches}
            highlightedPatchId={highlightedPatchId}
            onHighlightPatch={onHighlightPatch}
            onDone={onDone}
          />,
          panelHost,
        )}
    </>
  );
}

/** The page's two marks: pink = repaint, red = put the original back. */
function InpaintingCanvas({ editor }: { editor: InpaintingEditorState }) {
  const cursor = useRef<HTMLDivElement | null>(null);
  const drawing = useRef(false);
  const {
    width,
    height,
    brushSize,
    panKeyHeld,
    tool,
    paintRef,
    restoreRef,
    beginStroke,
    extendStroke,
    endStroke,
  } = editor;

  const pointOf = (e: React.PointerEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * width) / Math.max(1, rect.width),
      y: ((e.clientY - rect.top) * height) / Math.max(1, rect.height),
    };
  };

  // The brush outline follows the pointer without a React render per move.
  const moveCursor = (e: React.PointerEvent<HTMLElement>) => {
    const ring = cursor.current;
    if (!ring) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const size = (brushSize * rect.width) / Math.max(1, width);
    ring.style.display = "block";
    ring.style.width = `${size}px`;
    ring.style.height = `${size}px`;
    ring.style.left = `${e.clientX - rect.left - size / 2}px`;
    ring.style.top = `${e.clientY - rect.top - size / 2}px`;
  };

  const finish = () => {
    if (!drawing.current) return;
    drawing.current = false;
    endStroke();
  };

  const layer: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    opacity: 0.5,
    pointerEvents: "none",
  };

  return (
    <div
      data-testid="inpainting-canvas"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 3,
        cursor: panKeyHeld ? "grab" : "none",
        touchAction: "none",
        // Space held: let the pointer through so the reader pans instead of painting.
        pointerEvents: panKeyHeld ? "none" : "auto",
      }}
      // Pointer and mouse events are separate streams; the reader pans on mousedown.
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drawing.current = true;
        beginStroke(pointOf(e));
      }}
      onPointerMove={(e) => {
        moveCursor(e);
        if (drawing.current) extendStroke(pointOf(e));
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onPointerLeave={(e) => {
        if (cursor.current) cursor.current.style.display = "none";
        if (!e.currentTarget.hasPointerCapture?.(e.pointerId)) finish();
      }}
    >
      <canvas
        ref={paintRef}
        data-testid="inpainting-paint"
        width={width}
        height={height}
        style={layer}
      />
      <canvas
        ref={restoreRef}
        data-testid="inpainting-restore"
        width={width}
        height={height}
        style={layer}
      />
      <div
        ref={cursor}
        style={{
          position: "absolute",
          display: "none",
          borderRadius: "50%",
          border: `1.5px solid ${tool === "brush" ? PAINT_COLOUR : RESTORE_COLOUR}`,
          boxShadow: "0 0 0 1px rgba(255,255,255,0.8)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

export interface PatchListItem {
  /** The patch element's id. */
  id: string;
  label: string;
  detail: string;
}

interface PanelProps {
  editor: InpaintingEditorState;
  patches: PatchListItem[];
  highlightedPatchId: string | null;
  onHighlightPatch: (id: string | null) => void;
  onDone: () => void;
}

const rowSx = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  width: "100%",
  textAlign: "left",
  px: 1,
  py: 0.75,
  borderRadius: "6px",
  border: "1px solid transparent",
  cursor: "pointer",
  bgcolor: "transparent",
  color: "inherit",
  font: "inherit",
  "&:hover": { bgcolor: "var(--bg-hover, rgba(127,127,127,0.08))" },
} as const;

/** The tools and the page's patch list, in the right sidebar's place. */
function InpaintingPanel({
  editor,
  patches,
  highlightedPatchId,
  onHighlightPatch,
  onDone,
}: PanelProps) {
  const canApply = (editor.hasPaint || editor.hasRestore) && !editor.sending;
  return (
    <Box
      className="reader-right-sidebar-nhentai"
      role="toolbar"
      aria-label="Inpainting tools"
    >
      <SidebarSection title="Inpainting">
        <ToggleButtonGroup
          size="small"
          exclusive
          fullWidth
          value={editor.tool}
          onChange={(_e, value) => value && editor.setTool(value)}
          sx={{ mb: 1 }}
        >
          <ToggleButton
            value="brush"
            aria-label="Brush"
          >
            <BrushIcon
              fontSize="small"
              sx={{ mr: 0.75 }}
            />
            Repaint
          </ToggleButton>
          <ToggleButton
            value="eraser"
            aria-label="Eraser"
          >
            <AutoFixOffIcon
              fontSize="small"
              sx={{ mr: 0.75 }}
            />
            Restore
          </ToggleButton>
        </ToggleButtonGroup>
        <Typography
          variant="caption"
          component="p"
          sx={{ color: "var(--text-muted)", mb: 1, lineHeight: 1.4 }}
        >
          {editor.tool === "brush"
            ? "Paint over what should be repainted (pink)."
            : "Rub out your own paint, or mark where an automatic patch should go and the original page come back (red)."}{" "}
          Hold Space to pan.
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 1 }}>
          <Typography
            variant="caption"
            sx={{ minWidth: 30 }}
          >
            Size
          </Typography>
          <Slider
            size="small"
            min={4}
            max={200}
            value={editor.brushSize}
            onChange={(_e, value) => editor.setBrushSize(value as number)}
            aria-label="Brush size"
          />
          <Typography
            variant="caption"
            sx={{ minWidth: 28, textAlign: "right" }}
          >
            {editor.brushSize}
          </Typography>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.5 }}>
          <Select
            size="small"
            value={editor.method}
            onChange={(e) => editor.setMethod(e.target.value as RepaintMethod)}
            inputProps={{ "aria-label": "Repaint method" }}
            sx={{ flex: 1 }}
          >
            <MenuItem value="auto">Auto</MenuItem>
            <MenuItem value="aot">AOT</MenuItem>
            <MenuItem value="telea">Telea</MenuItem>
            <MenuItem value="flat">Flat colour</MenuItem>
          </Select>
          {editor.method === "flat" && (
            <input
              type="color"
              aria-label="Fill colour"
              value={editor.fillColor}
              onChange={(e) => editor.setFillColor(e.target.value)}
            />
          )}
          <Tooltip title="Undo stroke">
            <span>
              <IconButton
                size="small"
                aria-label="Undo stroke"
                disabled={!editor.canUndo}
                onClick={editor.undo}
              >
                <UndoIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Redo stroke">
            <span>
              <IconButton
                size="small"
                aria-label="Redo stroke"
                disabled={!editor.canRedo}
                onClick={editor.redo}
              >
                <RedoIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
        <Box sx={{ display: "flex", gap: 1 }}>
          <Button
            size="small"
            variant="contained"
            disabled={!canApply}
            onClick={() => void editor.apply()}
          >
            {editor.sending ? "Queuing…" : "Apply"}
          </Button>
          <Button
            size="small"
            variant="text"
            disabled={!(editor.hasPaint || editor.hasRestore) || editor.sending}
            onClick={editor.cancel}
          >
            Cancel
          </Button>
          <Box sx={{ flex: 1 }} />
          <Button
            size="small"
            variant="outlined"
            onClick={onDone}
          >
            Done
          </Button>
        </Box>
      </SidebarSection>

      <SidebarSection title={`Patches on this page (${patches.length})`}>
        {patches.length === 0 ? (
          <Typography
            variant="body2"
            sx={{ color: "var(--text-muted)" }}
          >
            No patches yet.
          </Typography>
        ) : (
          <Box
            component="ul"
            sx={{ listStyle: "none", m: 0, p: 0 }}
          >
            {patches.map((patch) => {
              const active = patch.id === highlightedPatchId;
              return (
                <li key={patch.id}>
                  <Box
                    component="button"
                    type="button"
                    data-patch-row={patch.id}
                    aria-pressed={active}
                    onClick={() => onHighlightPatch(active ? null : patch.id)}
                    sx={{
                      ...rowSx,
                      ...(active && {
                        borderColor: "var(--primary)",
                        bgcolor: "var(--primary-soft, rgba(33,150,243,0.08))",
                      }),
                    }}
                  >
                    <Typography
                      variant="body2"
                      noWrap
                      sx={{ maxWidth: "100%", fontWeight: active ? 600 : 400 }}
                    >
                      {patch.label}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{ color: "var(--text-muted)" }}
                    >
                      {patch.detail}
                    </Typography>
                  </Box>
                </li>
              );
            })}
          </Box>
        )}
      </SidebarSection>
    </Box>
  );
}
