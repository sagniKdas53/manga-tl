import React from "react";
import Grid from "@mui/material/Grid";
import Box from "@mui/material/Box";
import {
  Typography,
  Switch,
  Slider,
  Button,
  TextField,
} from "@mui/material";
import FitScreenIcon from "@mui/icons-material/FitScreen";
import WidthFullIcon from "@mui/icons-material/WidthFull";
import HeightIcon from "@mui/icons-material/Height";
import DeleteIcon from "@mui/icons-material/Delete";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import { ReaderPageNavigation, ReaderPrevNextChapters } from "./ReaderPageNavigation";
import ConfirmModal from "./ConfirmModal";
import { useToast } from "./ToastContext";

import type { Chapter, Page } from "../types";

interface ReaderLeftSidebarProps {
  showPanels: boolean;
  setShowPanels: (val: boolean) => void;
  showOcr: boolean;
  setShowOcr: (val: boolean) => void;
  cleanScanlationView: boolean;
  setCleanScanlationView: (val: boolean) => void;
  setManuallyShownOcrLayers: (val: Set<string>) => void;
  groupByConversation: boolean;
  setGroupByConversation: (val: boolean) => void;

  zoom: number;
  setZoom: (val: number) => void;
  fitMode: "page" | "width" | "height";
  setFitMode: (val: "page" | "width" | "height") => void;

  curPageNum: number;
  totalPages: number;
  navigateToPage: (pageNum: number) => void;
  prevChapter: Chapter | null;
  nextChapter: Chapter | null;
  navigateToChapter: (chapter: Chapter) => void;

  selectedPage: Page | null;
  handleDeletePage: (pageId: string) => void;
  handleChangePageNumber: (pageId: string, newPage: number) => void;
}

// --- Shared presentational helpers -----------------------------------------

const SidebarSection: React.FC<{ title: string; children: React.ReactNode; sx?: object }> = ({
  title,
  children,
  sx,
}) => (
  <Box
    sx={{
      border: "1px solid var(--border-color)",
      borderRadius: "10px",
      p: 1.5,
      mb: 2,
      backgroundColor: "var(--bg-surface, transparent)",
      ...sx,
    }}
  >
    <Typography
      variant="overline"
      component="div"
      sx={{
        fontSize: "10.5px",
        fontWeight: 700,
        letterSpacing: "0.08em",
        color: "var(--text-dim, var(--text-muted))",
        mb: 1.25,
      }}
    >
      {title}
    </Typography>
    {children}
  </Box>
);

const ToggleRow: React.FC<{
  label: string;
  checked: boolean;
  onChange: (val: boolean) => void;
}> = ({ label, checked, onChange }) => (
  <Box
    component="label"
    onClick={(e) => { e.preventDefault(); onChange(!checked); }}
    sx={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      py: 0.5,
      px: 0.75,
      mx: -0.75,
      borderRadius: "6px",
      cursor: "pointer",
      "&:hover": { backgroundColor: "var(--bg-input, rgba(0,0,0,0.04))" },
    }}
  >
    <Typography variant="body2" sx={{ fontSize: "13px", color: "var(--text-main)" }}>
      {label}
    </Typography>
    <Switch
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      size="small"
    />
  </Box>
);

const fitModes: { key: "page" | "width" | "height"; label: string; icon: React.ReactNode }[] = [
  { key: "page", label: "Page", icon: <FitScreenIcon sx={{ fontSize: 15 }} /> },
  { key: "width", label: "Width", icon: <WidthFullIcon sx={{ fontSize: 15 }} /> },
  { key: "height", label: "Height", icon: <HeightIcon sx={{ fontSize: 15 }} /> },
];

const ReaderLeftSidebar: React.FC<ReaderLeftSidebarProps> = React.memo((props) => {
  const displayedZoom = Math.round(props.zoom * 100);

  // Local state for the "Change Page Number" input
  const [targetPageInput, setTargetPageInput] = React.useState<string>("");
  const { showToast } = useToast();
  const [confirmModal, setConfirmModal] = React.useState<{
    isOpen: boolean;
    title: string;
    message: string;
    isDangerous?: boolean;
    onConfirm: () => void;
  } | null>(null);

  React.useEffect(() => {
    // Reset target page input when current page changes
    if (props.selectedPage) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTargetPageInput(props.selectedPage.pageNumber.toString());
    }
  }, [props.selectedPage]);

  const onPageMoveSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!props.selectedPage) return;
    const newPageNum = parseInt(targetPageInput, 10);
    if (!isNaN(newPageNum)) {
      if (newPageNum < 0) {
        showToast("Page number cannot be negative", "error");
        return;
      }
      if (newPageNum > props.totalPages) {
        showToast(`Cannot move page to ${newPageNum}. The chapter only has ${props.totalPages} pages.`, "error");
        return;
      }

      if (newPageNum === 0) {
        setConfirmModal({
          isOpen: true,
          title: "Move to End",
          message: "Do you want to move this page to the end of the chapter?",
          onConfirm: () => {
            props.handleChangePageNumber(props.selectedPage!.id, 0);
            setConfirmModal(null);
          },
        });
      } else {
        props.handleChangePageNumber(props.selectedPage.id, newPageNum);
      }
    }
  };

  return (
    <Grid className="reader-left-sidebar-nhentai">
      {/* Overlays Section */}
      <SidebarSection title="Overlays">
        <Box sx={{ display: "flex", flexDirection: "column" }}>
          <ToggleRow
            label="Panel Boundaries"
            checked={props.showPanels}
            onChange={props.setShowPanels}
          />
          <ToggleRow
            label="OCR Boxes"
            checked={props.showOcr}
            onChange={props.setShowOcr}
          />
          <ToggleRow
            label="Clean Scanlation"
            checked={props.cleanScanlationView}
            onChange={(val) => {
              props.setCleanScanlationView(val);
              props.setManuallyShownOcrLayers(new Set());
            }}
          />
          <ToggleRow
            label="Group Conversation"
            checked={props.groupByConversation}
            onChange={props.setGroupByConversation}
          />
        </Box>
      </SidebarSection>

      {/* Zoom & View Section */}
      <SidebarSection title="Zoom & View">
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 1.5 }}>
          <Slider
            min={0.5}
            max={3.0}
            step={0.1}
            value={props.zoom}
            onChange={(_, val) => props.setZoom(val as number)}
            size="small"
            sx={{
              flex: 1,
              color: "var(--primary)",
            }}
          />
          <Typography
            variant="body2"
            sx={{
              minWidth: "44px",
              fontWeight: 700,
              textAlign: "right",
              color: "var(--text-main)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {displayedZoom}%
          </Typography>
        </Box>

        {/* Fit mode segmented control */}
        <Box
          sx={{
            display: "flex",
            border: "1px solid var(--border-color)",
            borderRadius: "8px",
            overflow: "hidden",
            mb: 1.5,
          }}
        >
          {fitModes.map((mode, i) => {
            const active = props.fitMode === mode.key;
            return (
              <Box
                key={mode.key}
                component="button"
                type="button"
                onClick={() => props.setFitMode(mode.key)}
                sx={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 0.5,
                  py: 0.75,
                  fontSize: "11px",
                  fontWeight: 600,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  border: "none",
                  borderLeft: i > 0 ? "1px solid var(--border-color)" : "none",
                  backgroundColor: active ? "var(--primary)" : "transparent",
                  color: active ? "#fff" : "var(--text-muted)",
                  transition: "background-color 0.15s ease, color 0.15s ease",
                  "&:hover": {
                    backgroundColor: active ? "var(--primary)" : "var(--bg-input, rgba(0,0,0,0.05))",
                  },
                }}
              >
                {mode.icon}
                {mode.label}
              </Box>
            );
          })}
        </Box>

        <Button
          variant="outlined"
          size="small"
          fullWidth
          onClick={() => {
            props.setZoom(1.0);
            props.setFitMode("page");
          }}
          disabled={props.zoom === 1.0 && props.fitMode === "page"}
          sx={{
            fontSize: "11px",
            fontWeight: 600,
            color: "var(--text-muted)",
            borderColor: "var(--border-color)",
            "&:hover": { borderColor: "var(--primary)", color: "var(--primary)" },
          }}
        >
          Reset Zoom
        </Button>
      </SidebarSection>

      {/* Navigation Section */}
      <SidebarSection title="Navigation">
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
          <ReaderPageNavigation
            currentPage={props.curPageNum}
            totalPages={props.totalPages}
            onFirstPage={() => props.navigateToPage(1)}
            onPrevPage={() => props.navigateToPage(props.curPageNum - 1)}
            onNextPage={() => props.navigateToPage(props.curPageNum + 1)}
            onLastPage={() => props.navigateToPage(props.totalPages)}
          />
          <ReaderPrevNextChapters
            hasPrevChapter={!!props.prevChapter}
            hasNextChapter={!!props.nextChapter}
            onPrevChapter={() => props.prevChapter && props.navigateToChapter(props.prevChapter)}
            onNextChapter={() => props.nextChapter && props.navigateToChapter(props.nextChapter)}
          />
        </Box>
      </SidebarSection>

      {/* Page Management Section */}
      <SidebarSection title="Page Management" sx={{ mb: 5 }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Box component="form" onSubmit={onPageMoveSubmit} sx={{ display: "flex", gap: 1 }}>
            <TextField
              size="small"
              type="number"
              placeholder="Move to..."
              value={targetPageInput}
              onChange={(e) => setTargetPageInput(e.target.value)}
              slotProps={{ htmlInput: { min: 0 } }}
              sx={{ flex: 1, "& .MuiInputBase-input": { padding: "8px 10px", fontSize: "13px" } }}
            />
            <Button
              type="submit"
              variant="contained"
              size="small"
              startIcon={<SwapHorizIcon />}
              disabled={!props.selectedPage || props.totalPages <= 1 || targetPageInput === props.selectedPage.pageNumber.toString()}
              sx={{ fontSize: "11px", fontWeight: 600, boxShadow: "none" }}
            >
              Move
            </Button>
          </Box>

          <Button
            variant="outlined"
            color="error"
            size="small"
            fullWidth
            startIcon={<DeleteIcon />}
            onClick={() => {
              if (props.selectedPage) {
                setConfirmModal({
                  isOpen: true,
                  title: "Delete Page",
                  message: "Are you sure you want to delete this page? This action cannot be undone.",
                  isDangerous: true,
                  onConfirm: () => {
                    props.handleDeletePage(props.selectedPage!.id);
                    setConfirmModal(null);
                  },
                });
              }
            }}
            disabled={!props.selectedPage}
            sx={{ fontSize: "11px", fontWeight: 600 }}
          >
            Delete Page
          </Button>
        </Box>
      </SidebarSection>

      {confirmModal && (
        <ConfirmModal
          isOpen={confirmModal.isOpen}
          title={confirmModal.title}
          message={confirmModal.message}
          isDangerous={confirmModal.isDangerous}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}
    </Grid>
  );
});

export default ReaderLeftSidebar;
