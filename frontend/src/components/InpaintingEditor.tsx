import React, { useCallback, useRef, useState } from "react";
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
import DeleteSweepIcon from "@mui/icons-material/DeleteSweep";
import { safeFetch } from "../utils";
import { binaryMask, markBounds } from "../utils/inpaintingMask";

/**
 * The mask editor (2026-09-28): the user paints over what a cleanup pass left behind, and Apply
 * queues a repaint of that area (`POST /api/pages/{id}/manual-cleanup`). The result comes back as
 * a new patch on its own Inpainting layer, through the Reader's usual job-update refresh.
 *
 * The canvas is the page's own pixel grid (CSS-scaled with the image), so a stroke's coordinates
 * are page pixels and the mask needs no rescaling.
 */

export type RepaintMethod = "auto" | "aot" | "telea" | "flat";

const HISTORY_LIMIT = 30;
const STROKE_COLOUR = "rgb(255, 64, 160)";

interface InpaintingEditorProps {
  pageId: string;
  token: string;
  /** The page's pixel size: the canvas's own resolution. */
  width: number;
  height: number;
  onDone: () => void;
  onQueued: () => void;
  onError: (message: string) => void;
}

/** The brush canvas, laid over the page image. */
export const InpaintingCanvas = React.forwardRef<
  HTMLCanvasElement,
  {
    width: number;
    height: number;
    brushSize: number;
    erasing: boolean;
    onStrokeEnd: () => void;
  }
>(function InpaintingCanvas(
  { width, height, brushSize, erasing, onStrokeEnd },
  ref,
) {
  const last = useRef<{ x: number; y: number } | null>(null);

  const pointOf = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * width) / Math.max(1, rect.width),
      y: ((e.clientY - rect.top) * height) / Math.max(1, rect.height),
    };
  };

  const stroke = (
    canvas: HTMLCanvasElement,
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.globalCompositeOperation = erasing ? "destination-out" : "source-over";
    ctx.strokeStyle = STROKE_COLOUR;
    ctx.fillStyle = STROKE_COLOUR;
    ctx.lineWidth = brushSize;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.arc(to.x, to.y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  return (
    <canvas
      ref={ref}
      data-testid="inpainting-canvas"
      width={width}
      height={height}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        opacity: 0.5,
        cursor: "crosshair",
        touchAction: "none",
        zIndex: 3,
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const point = pointOf(e);
        last.current = point;
        stroke(e.currentTarget, point, point);
      }}
      onPointerMove={(e) => {
        if (!last.current) return;
        const point = pointOf(e);
        stroke(e.currentTarget, last.current, point);
        last.current = point;
      }}
      onPointerUp={() => {
        if (!last.current) return;
        last.current = null;
        onStrokeEnd();
      }}
      onPointerLeave={() => {
        if (!last.current) return;
        last.current = null;
        onStrokeEnd();
      }}
    />
  );
});

/**
 * Canvas + toolbar. Rendered inside the page's positioned image box, so the canvas lines up with
 * the image; the toolbar is fixed to the bottom of the window.
 */
export default function InpaintingEditor({
  pageId,
  token,
  width,
  height,
  onDone,
  onQueued,
  onError,
}: InpaintingEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [erasing, setErasing] = useState(false);
  const [brushSize, setBrushSize] = useState(24);
  const [method, setMethod] = useState<RepaintMethod>("auto");
  const [fillColor, setFillColor] = useState("#ffffff");
  const [sending, setSending] = useState(false);
  // Snapshots of the canvas after each stroke. `step` strokes are on screen (0 = blank);
  // `strokes` is how many snapshots exist, so Redo knows when there is nothing to redo.
  const history = useRef<ImageData[]>([]);
  const [step, setStep] = useState(0);
  const [strokes, setStrokes] = useState(0);
  const [hasMark, setHasMark] = useState(false);

  const context = () => canvasRef.current?.getContext("2d") ?? null;

  const refreshHasMark = useCallback(() => {
    const ctx = context();
    if (!ctx) return setHasMark(false);
    setHasMark(
      markBounds(ctx.getImageData(0, 0, width, height).data, width, height) !==
        null,
    );
  }, [width, height]);

  // The Reader keys this component by page, so a new page always starts from a blank mark.
  const resetHistory = () => {
    context()?.clearRect(0, 0, width, height);
    history.current = [];
    setStep(0);
    setStrokes(0);
    setHasMark(false);
  };

  const onStrokeEnd = () => {
    const ctx = context();
    if (!ctx) return;
    const kept = history.current.slice(0, step);
    kept.push(ctx.getImageData(0, 0, width, height));
    history.current = kept.slice(-HISTORY_LIMIT);
    setStep(history.current.length);
    setStrokes(history.current.length);
    refreshHasMark();
  };

  /** Puts the canvas back to how it was after `count` strokes. */
  const show = (count: number) => {
    const ctx = context();
    if (!ctx || count < 0 || count > history.current.length) return;
    if (count === 0) ctx.clearRect(0, 0, width, height);
    else ctx.putImageData(history.current[count - 1], 0, 0);
    setStep(count);
    refreshHasMark();
  };

  const apply = async () => {
    const ctx = context();
    if (!ctx) return;
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const box = markBounds(pixels, width, height);
    if (!box) return;
    const cut = document.createElement("canvas");
    cut.width = box.width;
    cut.height = box.height;
    const cutCtx = cut.getContext("2d");
    if (!cutCtx) return;
    const cutPixels = cutCtx.createImageData(box.width, box.height);
    cutPixels.data.set(binaryMask(pixels, width, box));
    cutCtx.putImageData(cutPixels, 0, 0);
    setSending(true);
    try {
      const res = await safeFetch(`/api/pages/${pageId}/manual-cleanup`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mask: cut.toDataURL("image/png"),
          bounds: box,
          method,
          ...(method === "flat" ? { fillColor } : {}),
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `Repaint failed (${res.status})`);
      }
      resetHistory();
      onQueued();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <InpaintingCanvas
        ref={canvasRef}
        width={width}
        height={height}
        brushSize={brushSize}
        erasing={erasing}
        onStrokeEnd={onStrokeEnd}
      />
      <Box
        role="toolbar"
        aria-label="Inpainting tools"
        onPointerDown={(e) => e.stopPropagation()}
        sx={{
          position: "fixed",
          left: "50%",
          bottom: 16,
          transform: "translateX(-50%)",
          zIndex: 1300,
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 1.5,
          px: 2,
          py: 1,
          maxWidth: "calc(100vw - 32px)",
          borderRadius: 2,
          bgcolor: "var(--bg-card-content)",
          backdropFilter: "blur(8px)",
          color: "var(--text-main, inherit)",
          boxShadow: 6,
        }}
      >
        <Typography
          variant="caption"
          sx={{ fontWeight: 700 }}
        >
          Inpainting
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={erasing ? "eraser" : "brush"}
          onChange={(_e, value) => value && setErasing(value === "eraser")}
        >
          <ToggleButton
            value="brush"
            aria-label="Brush"
          >
            <BrushIcon fontSize="small" />
          </ToggleButton>
          <ToggleButton
            value="eraser"
            aria-label="Eraser"
          >
            <AutoFixOffIcon fontSize="small" />
          </ToggleButton>
        </ToggleButtonGroup>
        <Box sx={{ width: 120, display: "flex", alignItems: "center", gap: 1 }}>
          <Slider
            size="small"
            min={4}
            max={200}
            value={brushSize}
            onChange={(_e, value) => setBrushSize(value as number)}
            aria-label="Brush size"
          />
          <Typography
            variant="caption"
            sx={{ minWidth: 28 }}
          >
            {brushSize}
          </Typography>
        </Box>
        <Tooltip title="Undo stroke">
          <span>
            <IconButton
              size="small"
              aria-label="Undo stroke"
              disabled={step === 0}
              onClick={() => show(step - 1)}
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
              disabled={step >= strokes}
              onClick={() => show(step + 1)}
            >
              <RedoIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Clear the mark">
          <span>
            <IconButton
              size="small"
              aria-label="Clear the mark"
              disabled={!hasMark}
              onClick={resetHistory}
            >
              <DeleteSweepIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Select
          size="small"
          value={method}
          onChange={(e) => setMethod(e.target.value as RepaintMethod)}
          inputProps={{ "aria-label": "Repaint method" }}
          sx={{ minWidth: 110 }}
        >
          <MenuItem value="auto">Auto</MenuItem>
          <MenuItem value="aot">AOT</MenuItem>
          <MenuItem value="telea">Telea</MenuItem>
          <MenuItem value="flat">Flat colour</MenuItem>
        </Select>
        {method === "flat" && (
          <input
            type="color"
            aria-label="Fill colour"
            value={fillColor}
            onChange={(e) => setFillColor(e.target.value)}
          />
        )}
        <Button
          size="small"
          variant="contained"
          disabled={!hasMark || sending}
          onClick={() => void apply()}
        >
          {sending ? "Queuing…" : "Apply"}
        </Button>
        <Button
          size="small"
          variant="outlined"
          onClick={onDone}
        >
          Done
        </Button>
      </Box>
    </>
  );
}
