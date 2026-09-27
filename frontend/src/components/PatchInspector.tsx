import React from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Slider from "@mui/material/Slider";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import SidebarSection from "./SidebarSection";
import type { LayerElement, OcrRegion } from "../types";

/**
 * Tracker R7: the inspector for one cleanup patch on the Inpainting layer. Geometry only in this
 * first cut (user, 2026-09-21): move, resize, fade, hide, delete. Every change is one undo step and
 * reaches the export, which draws the patch exactly as it is left here.
 */
export interface PatchInspectorProps {
  element: LayerElement;
  region?: OcrRegion;
  onUpdate: (updates: Partial<LayerElement>) => void;
  onSetVisibility: (element: LayerElement, visible: boolean) => void;
  onDelete: (id: string) => void;
  onDeselect: () => void;
}

const numberFields: {
  key: "x" | "y" | "maxWidth" | "maxHeight";
  label: string;
  min: number;
}[] = [
  { key: "x", label: "X", min: 0 },
  { key: "y", label: "Y", min: 0 },
  { key: "maxWidth", label: "Width", min: 1 },
  { key: "maxHeight", label: "Height", min: 1 },
];

const PatchInspector: React.FC<PatchInspectorProps> = ({
  element,
  region,
  onUpdate,
  onSetVisibility,
  onDelete,
  onDeselect,
}) => {
  const opacityPercent = Math.round((element.opacity ?? 1) * 100);
  // The slider previews locally and commits once, so a drag is one undo step, not fifty. The
  // draft exists only while dragging; otherwise the element's own value shows.
  const [draftOpacity, setDraftOpacity] = React.useState<number | null>(null);
  const shownOpacity = draftOpacity ?? opacityPercent;

  const bounds = element.cleanupRef?.bounds;
  const atCleanupBounds =
    !bounds ||
    (element.x === bounds.x &&
      element.y === bounds.y &&
      element.maxWidth === Math.round(bounds.width) &&
      element.maxHeight === Math.round(bounds.height));
  const visible = element.visible === true;

  return (
    <Box
      className="ocr-detail-card"
      sx={{ flex: 1, display: "flex", flexDirection: "column", gap: "12px" }}
      data-testid="patch-inspector"
    >
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <Box>
          <Typography
            variant="overline"
            component="div"
            sx={{ fontWeight: 700, lineHeight: 1.4 }}
          >
            Cleanup Patch
          </Typography>
          <Typography
            variant="caption"
            sx={{ color: "var(--text-muted)" }}
          >
            {region?.bubbleReadingOrder
              ? `Region #${region.bubbleReadingOrder}`
              : "No region (kept from an earlier pass)"}
          </Typography>
        </Box>
        <Button
          variant="outlined"
          size="small"
          onClick={onDeselect}
        >
          Deselect
        </Button>
      </Box>

      <SidebarSection title="Position & Size">
        <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1 }}>
          {numberFields.map(({ key, label, min }) => (
            <TextField
              key={key}
              label={label}
              type="number"
              size="small"
              value={Math.round(Number(element[key] ?? 0))}
              slotProps={{ htmlInput: { min, step: 1 } }}
              onChange={(e) => {
                const value = Math.round(Number(e.target.value));
                if (Number.isFinite(value) && value >= min)
                  onUpdate({ [key]: value });
              }}
            />
          ))}
        </Box>
        <Button
          size="small"
          sx={{ mt: 1 }}
          disabled={atCleanupBounds}
          onClick={() =>
            bounds &&
            onUpdate({
              x: bounds.x,
              y: bounds.y,
              maxWidth: Math.round(bounds.width),
              maxHeight: Math.round(bounds.height),
            })
          }
        >
          Reset to where cleanup put it
        </Button>
      </SidebarSection>

      <SidebarSection title="Opacity">
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, px: 1 }}>
          <Slider
            aria-label="Patch opacity"
            size="small"
            min={0}
            max={100}
            value={shownOpacity}
            onChange={(_, value) => setDraftOpacity(value as number)}
            onChangeCommitted={(_, value) => {
              setDraftOpacity(null);
              onUpdate({ opacity: (value as number) / 100 });
            }}
          />
          <Typography
            variant="caption"
            sx={{ minWidth: 36, textAlign: "right" }}
          >
            {shownOpacity}%
          </Typography>
        </Box>
      </SidebarSection>

      <Box sx={{ display: "flex", gap: 1 }}>
        <Button
          variant="outlined"
          size="small"
          sx={{ flex: 1 }}
          onClick={() => onSetVisibility(element, !visible)}
        >
          {visible ? "Hide patch" : "Show patch"}
        </Button>
        <Button
          variant="outlined"
          color="error"
          size="small"
          sx={{ flex: 1 }}
          onClick={() => onDelete(element.id)}
        >
          Delete patch
        </Button>
      </Box>
      <Typography
        variant="caption"
        sx={{ color: "var(--text-muted)" }}
      >
        Hiding or deleting a patch shows the original page underneath. Undo
        (Ctrl+Z) brings it back.
      </Typography>
    </Box>
  );
};

export default PatchInspector;
