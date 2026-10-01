import { useCallback, useEffect, useRef, useState } from "react";
import { safeFetch } from "../utils";
import { binaryMask, markBounds } from "../utils/inpaintingMask";

/**
 * The mask editor's state (2026-09-28), shared by the brush canvas on the page and the tool panel
 * that replaces the right sidebar while the Inpainting view is open.
 *
 * Two marks live on two page-sized canvases:
 * - **paint** (brush): an area to repaint with the chosen method;
 * - **restore** (eraser over anything the user did not paint): an area where the original page
 *   goes back, undoing an automatic patch there. The eraser first rubs out the user's own paint;
 *   only what it crosses outside that paint becomes a restore mark.
 * Apply sends each mark that has pixels as its own `manual-cleanup` job; each lands as a new top
 * Inpainting layer.
 *
 * History is the list of strokes, replayed from blank on undo/redo. Full-page snapshots cost
 * ~35 MB each on a 2500x3500 page, and the first version kept thirty of them.
 */

export type RepaintMethod = "auto" | "aot" | "telea" | "flat";
/** The two tools that mark the page. */
export type MarkTool = "brush" | "eraser";
/** "pan" moves the page instead of marking it, as holding Space does. */
export type InpaintingTool = MarkTool | "pan";

export const PAINT_COLOUR = "rgb(255, 64, 160)";
export const RESTORE_COLOUR = "rgb(230, 20, 20)";

interface Point {
  x: number;
  y: number;
}

interface Stroke {
  tool: MarkTool;
  size: number;
  points: Point[];
}

interface Options {
  pageId: string;
  token: string;
  width: number;
  height: number;
  onQueued: (what: "repaint" | "restore" | "both") => void;
  onError: (message: string) => void;
}

const dab = (
  ctx: CanvasRenderingContext2D,
  from: Point,
  to: Point,
  size: number,
  colour: string,
  op: GlobalCompositeOperation,
) => {
  ctx.globalCompositeOperation = op;
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.globalCompositeOperation = "source-over";
};

export function useInpaintingEditor({
  pageId,
  token,
  width,
  height,
  onQueued,
  onError,
}: Options) {
  const paintRef = useRef<HTMLCanvasElement | null>(null);
  const restoreRef = useRef<HTMLCanvasElement | null>(null);
  const scratch = useRef<HTMLCanvasElement | null>(null);
  const strokes = useRef<Stroke[]>([]);
  const current = useRef<Stroke | null>(null);

  const [tool, setTool] = useState<InpaintingTool>("brush");
  const [brushSize, setBrushSize] = useState(24);
  const [method, setMethod] = useState<RepaintMethod>("auto");
  const [fillColor, setFillColor] = useState("#ffffff");
  const [sending, setSending] = useState(false);
  // `step` strokes are on screen; `tools[i]` is stroke i's tool, so the buttons can tell what is
  // marked and Redo knows when there is nothing to redo.
  const [step, setStep] = useState(0);
  const [tools, setTools] = useState<MarkTool[]>([]);
  const [panKeyHeld, setPanKeyHeld] = useState(false);

  /** One segment of a stroke, on both canvases. */
  const segment = useCallback(
    (stroke: Stroke, from: Point, to: Point) => {
      const paint = paintRef.current?.getContext("2d");
      const restore = restoreRef.current?.getContext("2d");
      if (!paint || !restore || !paintRef.current) return;
      if (stroke.tool === "brush") {
        dab(paint, from, to, stroke.size, PAINT_COLOUR, "source-over");
        dab(restore, from, to, stroke.size, RESTORE_COLOUR, "destination-out");
        return;
      }
      // Eraser: restore = restore + (segment - paint), then paint = paint - segment.
      if (!scratch.current) {
        scratch.current = document.createElement("canvas");
        scratch.current.width = width;
        scratch.current.height = height;
      }
      const tmp = scratch.current.getContext("2d");
      if (!tmp) return;
      const pad = stroke.size / 2 + 2;
      const bx = Math.max(0, Math.floor(Math.min(from.x, to.x) - pad));
      const by = Math.max(0, Math.floor(Math.min(from.y, to.y) - pad));
      const bw = Math.min(width, Math.ceil(Math.max(from.x, to.x) + pad)) - bx;
      const bh = Math.min(height, Math.ceil(Math.max(from.y, to.y) + pad)) - by;
      if (bw <= 0 || bh <= 0) return;
      tmp.clearRect(bx, by, bw, bh);
      dab(tmp, from, to, stroke.size, RESTORE_COLOUR, "source-over");
      tmp.globalCompositeOperation = "destination-out";
      tmp.drawImage(paintRef.current, bx, by, bw, bh, bx, by, bw, bh);
      tmp.globalCompositeOperation = "source-over";
      restore.drawImage(scratch.current, bx, by, bw, bh, bx, by, bw, bh);
      dab(paint, from, to, stroke.size, PAINT_COLOUR, "destination-out");
    },
    [width, height],
  );

  const replay = useCallback(
    (count: number) => {
      paintRef.current?.getContext("2d")?.clearRect(0, 0, width, height);
      restoreRef.current?.getContext("2d")?.clearRect(0, 0, width, height);
      for (const stroke of strokes.current.slice(0, count)) {
        stroke.points.forEach((point, i) =>
          segment(stroke, stroke.points[Math.max(0, i - 1)], point),
        );
      }
    },
    [segment, width, height],
  );

  const beginStroke = (point: Point) => {
    if (tool === "pan") return;
    const stroke = { tool, size: brushSize, points: [point] };
    current.current = stroke;
    segment(stroke, point, point);
  };
  const extendStroke = (point: Point) => {
    const stroke = current.current;
    if (!stroke) return;
    segment(stroke, stroke.points[stroke.points.length - 1], point);
    stroke.points.push(point);
  };
  const endStroke = () => {
    const stroke = current.current;
    if (!stroke) return;
    current.current = null;
    strokes.current = [...strokes.current.slice(0, step), stroke];
    setStep(strokes.current.length);
    setTools(strokes.current.map((s) => s.tool));
  };

  const show = (count: number) => {
    if (count < 0 || count > strokes.current.length) return;
    replay(count);
    setStep(count);
  };

  /** Drops every stroke not yet applied. */
  const cancel = () => {
    strokes.current = [];
    current.current = null;
    replay(0);
    setStep(0);
    setTools([]);
  };

  const live = tools.slice(0, step);
  // Enough to enable the buttons; Apply measures the pixels (an eraser may have rubbed paint out).
  const hasPaint = live.includes("brush");
  const hasRestore = live.includes("eraser");

  const cutMark = (canvas: HTMLCanvasElement | null) => {
    const ctx = canvas?.getContext("2d");
    if (!ctx) return null;
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const box = markBounds(pixels, width, height);
    if (!box) return null;
    const cut = document.createElement("canvas");
    cut.width = box.width;
    cut.height = box.height;
    const cutCtx = cut.getContext("2d");
    if (!cutCtx) return null;
    const cutPixels = cutCtx.createImageData(box.width, box.height);
    cutPixels.data.set(binaryMask(pixels, width, box));
    cutCtx.putImageData(cutPixels, 0, 0);
    return { mask: cut.toDataURL("image/png"), bounds: box };
  };

  const post = async (body: object) => {
    const res = await safeFetch(`/api/pages/${pageId}/manual-cleanup`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(detail || `Repaint failed (${res.status})`);
    }
  };

  const apply = async () => {
    const repaint = cutMark(paintRef.current);
    const restore = cutMark(restoreRef.current);
    if (!repaint && !restore) return;
    setSending(true);
    try {
      if (repaint) {
        await post({
          ...repaint,
          method,
          ...(method === "flat" ? { fillColor } : {}),
        });
      }
      if (restore) await post({ ...restore, method: "restore" });
      cancel();
      onQueued(repaint && restore ? "both" : repaint ? "repaint" : "restore");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  // Space held = pan instead of paint (the canvas lets the pointer through to the page).
  useEffect(() => {
    const typing = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      return (
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      );
    };
    const down = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e.target)) return;
      e.preventDefault(); // no page scroll, and no "click" on a focused Apply button
      setPanKeyHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || typing(e.target)) return;
      e.preventDefault();
      setPanKeyHeld(false);
    };
    const blur = () => setPanKeyHeld(false);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
    };
  }, []);

  return {
    paintRef,
    restoreRef,
    width,
    height,
    tool,
    setTool,
    brushSize,
    setBrushSize,
    method,
    setMethod,
    fillColor,
    setFillColor,
    sending,
    canUndo: step > 0,
    canRedo: step < tools.length,
    undo: () => show(step - 1),
    redo: () => show(step + 1),
    hasPaint,
    hasRestore,
    cancel,
    apply,
    panKeyHeld,
    // The canvas lets the pointer through to the page, which pans on a drag.
    panning: panKeyHeld || tool === "pan",
    beginStroke,
    extendStroke,
    endStroke,
  };
}

export type InpaintingEditorState = ReturnType<typeof useInpaintingEditor>;
