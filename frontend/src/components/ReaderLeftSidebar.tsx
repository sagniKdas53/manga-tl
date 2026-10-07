import React from "react";
import Box from "@mui/material/Box";
import {
  Typography,
  Switch,
  Slider,
  Button,
  TextField,
  IconButton,
} from "@mui/material";
import FitScreenIcon from "@mui/icons-material/FitScreen";
import WidthFullIcon from "@mui/icons-material/WidthFull";
import HeightIcon from "@mui/icons-material/Height";
import DeleteIcon from "@mui/icons-material/Delete";
import AddIcon from "@mui/icons-material/Add";
import RemoveIcon from "@mui/icons-material/Remove";
import {
  ReaderPageNavigation,
  ReaderPrevNextChapters,
} from "./ReaderPageNavigation";
import ConfirmModal from "./ConfirmModal";
import { useToast } from "./ToastContext";
import SidebarSection from "./SidebarSection";

import type { Chapter, Page } from "../types";

interface ReaderLeftSidebarProps {
  showPanels: boolean;
  setShowPanels: (val: boolean) => void;
  showOcr: boolean;
  setShowOcr: (val: boolean) => void;
  showOcrFragments: boolean;
  setShowOcrFragments: (val: boolean) => void;
  cleanScanlationView: boolean;
  setCleanScanlationView: (val: boolean) => void;
  setManuallyShownOcrLayers: (val: Set<string>) => void;
  groupByConversation: boolean;
  setGroupByConversation: (val: boolean) => void;

  zoom: number;
  setZoom: (val: number) => void;
  fitMode: "page" | "width" | "height";
  setFitMode: (val: "page" | "width" | "height") => void;
  prefetchAhead: number;
  setPrefetchAhead: (val: number) => void;

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

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.1;
/** How far ahead pages can be fetched. Each one costs bandwidth on a slow link. */
const PREFETCH_MAX = 6;

const ToggleRow: React.FC<{
  label: string;
  checked: boolean;
  onChange: (val: boolean) => void;
  /** A sub-option of the row above it: indented, and inert while `disabled`. */
  nested?: boolean;
  disabled?: boolean;
}> = ({ label, checked, onChange, nested = false, disabled = false }) => (
  <Box
    component="label"
    onClick={(e) => {
      e.preventDefault();
      if (!disabled) onChange(!checked);
    }}
    sx={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      minHeight: 32,
      px: 0.75,
      mx: -0.75,
      pl: nested ? 2.5 : 0.75,
      borderRadius: "6px",
      cursor: disabled ? "default" : "pointer",
      "&:hover": disabled
        ? undefined
        : { backgroundColor: "var(--bg-input, rgba(0,0,0,0.04))" },
    }}
  >
    <Typography
      variant="body2"
      sx={{
        fontSize: "13px",
        color: disabled ? "var(--text-muted)" : "var(--text-main)",
      }}
    >
      {label}
    </Typography>
    <Switch
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      size="small"
    />
  </Box>
);

const fitModes: {
  key: "page" | "width" | "height";
  label: string;
  icon: React.ReactNode;
}[] = [
  { key: "page", label: "Page", icon: <FitScreenIcon sx={{ fontSize: 15 }} /> },
  {
    key: "width",
    label: "Width",
    icon: <WidthFullIcon sx={{ fontSize: 15 }} />,
  },
  {
    key: "height",
    label: "Height",
    icon: <HeightIcon sx={{ fontSize: 15 }} />,
  },
];

const stepButtonSx = {
  width: 28,
  height: 28,
  borderRadius: "6px",
  color: "var(--text-muted)",
  backgroundColor: "var(--bg-raised, var(--bg-input))",
  "&:hover": {
    color: "var(--text-main)",
    backgroundColor: "var(--bg-chip, var(--bg-input))",
  },
} as const;

const hintSx = {
  fontSize: "12px",
  lineHeight: 1.45,
  color: "var(--text-muted)",
  m: 0,
} as const;

/**
 * The Reader's left sidebar: how the page is shown, which page, and what to do with it.
 *
 * Reader review (2026-10-04): prefetch sat directly under the zoom slider as a second slider,
 * and the two were easy to mix up. Zoom keeps its slider at the top; how far ahead to load is a
 * stepper at the bottom, in its own group, so the two controls differ in both place and shape.
 */
const ReaderLeftSidebar: React.FC<ReaderLeftSidebarProps> = React.memo(
  (props) => {
    const displayedZoom = Math.round(props.zoom * 100);
    const zoomIsDefault = props.zoom === 1.0 && props.fitMode === "page";

    // Local state for the "Move to" input
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

    const setZoomClamped = (value: number) =>
      props.setZoom(
        Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)) * 10) / 10,
      );

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
          showToast(
            `Cannot move page to ${newPageNum}. The chapter only has ${props.totalPages} pages.`,
            "error",
          );
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
      <Box
        component="aside"
        aria-label="View and pages"
        className="reader-left-sidebar-nhentai"
      >
        <SidebarSection title="Show on page">
          <Box sx={{ display: "flex", flexDirection: "column" }}>
            <ToggleRow
              label="Panel boundaries"
              checked={props.showPanels}
              onChange={props.setShowPanels}
            />
            <ToggleRow
              label="Show debug"
              checked={props.showOcr}
              onChange={props.setShowOcr}
            />
            <ToggleRow
              label="OCR fragments"
              nested
              disabled={!props.showOcr}
              checked={props.showOcr && props.showOcrFragments}
              onChange={props.setShowOcrFragments}
            />
            <ToggleRow
              label="Clean scanlation"
              checked={props.cleanScanlationView}
              onChange={(val) => {
                props.setCleanScanlationView(val);
                props.setManuallyShownOcrLayers(new Set());
              }}
            />
            <ToggleRow
              label="Group conversations"
              checked={props.groupByConversation}
              onChange={props.setGroupByConversation}
            />
          </Box>
        </SidebarSection>

        <SidebarSection
          title="Zoom"
          headerExtra={
            <Button
              variant="text"
              size="small"
              aria-label="Reset zoom"
              onClick={() => {
                props.setZoom(1.0);
                props.setFitMode("page");
              }}
              disabled={zoomIsDefault}
              sx={{
                minWidth: 0,
                px: 1,
                py: 0,
                fontSize: "12px",
                color: "var(--text-muted)",
              }}
            >
              Reset
            </Button>
          }
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.25 }}>
            <IconButton
              size="small"
              aria-label="Zoom out"
              onClick={() => setZoomClamped(props.zoom - ZOOM_STEP)}
              disabled={props.zoom <= ZOOM_MIN}
              sx={stepButtonSx}
            >
              <RemoveIcon sx={{ fontSize: 16 }} />
            </IconButton>
            <Slider
              min={ZOOM_MIN}
              max={ZOOM_MAX}
              step={ZOOM_STEP}
              value={props.zoom}
              onChange={(_, val) => props.setZoom(val as number)}
              size="small"
              aria-label="Zoom"
              getAriaValueText={(v) => `${Math.round(v * 100)}%`}
              sx={{ flex: 1, mx: 0.5, color: "var(--primary)" }}
            />
            <IconButton
              size="small"
              aria-label="Zoom in"
              onClick={() => setZoomClamped(props.zoom + ZOOM_STEP)}
              disabled={props.zoom >= ZOOM_MAX}
              sx={stepButtonSx}
            >
              <AddIcon sx={{ fontSize: 16 }} />
            </IconButton>
            <Typography
              component="output"
              variant="body2"
              sx={{
                minWidth: "42px",
                fontWeight: 700,
                textAlign: "right",
                color: "var(--text-main)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {displayedZoom}%
            </Typography>
          </Box>

          <Box
            role="group"
            aria-label="Fit to"
            sx={{
              display: "flex",
              gap: "2px",
              p: "2px",
              borderRadius: "6px",
              backgroundColor: "var(--bg-raised, var(--bg-input))",
            }}
          >
            {fitModes.map((mode) => {
              const active = props.fitMode === mode.key;
              return (
                <Box
                  key={mode.key}
                  component="button"
                  type="button"
                  aria-pressed={active}
                  onClick={() => props.setFitMode(mode.key)}
                  sx={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 0.5,
                    height: 28,
                    fontSize: "12px",
                    fontWeight: 600,
                    fontFamily: "inherit",
                    cursor: "pointer",
                    border: "none",
                    borderRadius: "4px",
                    backgroundColor: active
                      ? "var(--bg-surface)"
                      : "transparent",
                    color: active ? "var(--text-main)" : "var(--text-muted)",
                    boxShadow: active ? "0 1px 2px rgba(0,0,0,0.25)" : "none",
                    transition: "background-color 0.15s ease, color 0.15s ease",
                    "&:hover": { color: "var(--text-main)" },
                    "&:focus-visible": {
                      outline: "2px solid var(--primary)",
                      outlineOffset: "-2px",
                    },
                  }}
                >
                  {mode.icon}
                  {mode.label}
                </Box>
              );
            })}
          </Box>
        </SidebarSection>

        <SidebarSection title="Pages">
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
            <ReaderPageNavigation
              currentPage={props.curPageNum}
              totalPages={props.totalPages}
              onFirstPage={() => props.navigateToPage(1)}
              onPrevPage={() => props.navigateToPage(props.curPageNum - 1)}
              onNextPage={() => props.navigateToPage(props.curPageNum + 1)}
              onLastPage={() => props.navigateToPage(props.totalPages)}
              onJumpToPage={props.navigateToPage}
            />
            <ReaderPrevNextChapters
              hasPrevChapter={!!props.prevChapter}
              hasNextChapter={!!props.nextChapter}
              onPrevChapter={() =>
                props.prevChapter && props.navigateToChapter(props.prevChapter)
              }
              onNextChapter={() =>
                props.nextChapter && props.navigateToChapter(props.nextChapter)
              }
            />
          </Box>
        </SidebarSection>

        <SidebarSection title="This page">
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <Box
              component="form"
              onSubmit={onPageMoveSubmit}
              sx={{ display: "flex", alignItems: "center", gap: 1 }}
            >
              <Typography
                component="label"
                htmlFor="reader-move-page"
                sx={{
                  fontSize: "13px",
                  color: "var(--text-main)",
                  flexShrink: 0,
                }}
              >
                Move to
              </Typography>
              <TextField
                id="reader-move-page"
                size="small"
                type="number"
                value={targetPageInput}
                onChange={(e) => setTargetPageInput(e.target.value)}
                slotProps={{ htmlInput: { min: 0 } }}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  "& .MuiInputBase-input": {
                    padding: "6px 8px",
                    fontSize: "13px",
                  },
                }}
              />
              <Button
                type="submit"
                variant="outlined"
                size="small"
                disabled={
                  !props.selectedPage ||
                  props.totalPages <= 1 ||
                  targetPageInput === props.selectedPage.pageNumber.toString()
                }
                sx={{ fontSize: "12px", flexShrink: 0 }}
              >
                Move
              </Button>
            </Box>
            <Typography sx={hintSx}>0 moves the page to the end.</Typography>

            <Button
              variant="text"
              color="error"
              size="small"
              startIcon={<DeleteIcon />}
              onClick={() => {
                if (props.selectedPage) {
                  setConfirmModal({
                    isOpen: true,
                    title: "Delete Page",
                    message:
                      "Are you sure you want to delete this page? This action cannot be undone.",
                    isDangerous: true,
                    onConfirm: () => {
                      props.handleDeletePage(props.selectedPage!.id);
                      setConfirmModal(null);
                    },
                  });
                }
              }}
              disabled={!props.selectedPage}
              sx={{ alignSelf: "flex-start", fontSize: "12px", px: 1 }}
            >
              Delete page
            </Button>
          </Box>
        </SidebarSection>

        {/* Prefetch depth. Warming costs bandwidth on a slow link, so it is the reader's call
            how far ahead to spend it; 0 turns prefetching off entirely. */}
        <SidebarSection title="Loading">
          <Box
            role="group"
            aria-labelledby="reader-load-ahead-label"
            sx={{ display: "flex", alignItems: "center", gap: 1 }}
          >
            <Typography
              id="reader-load-ahead-label"
              sx={{ fontSize: "13px", color: "var(--text-main)", flex: 1 }}
            >
              Load ahead
            </Typography>
            <IconButton
              size="small"
              aria-label="Load fewer pages ahead"
              onClick={() =>
                props.setPrefetchAhead(Math.max(0, props.prefetchAhead - 1))
              }
              disabled={props.prefetchAhead <= 0}
              sx={stepButtonSx}
            >
              <RemoveIcon sx={{ fontSize: 16 }} />
            </IconButton>
            <Typography
              component="output"
              aria-live="polite"
              sx={{
                minWidth: 56,
                textAlign: "center",
                fontSize: "13px",
                fontWeight: 600,
                color: "var(--text-main)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {props.prefetchAhead === 0
                ? "Off"
                : `${props.prefetchAhead} page${props.prefetchAhead === 1 ? "" : "s"}`}
            </Typography>
            <IconButton
              size="small"
              aria-label="Load more pages ahead"
              onClick={() =>
                props.setPrefetchAhead(
                  Math.min(PREFETCH_MAX, props.prefetchAhead + 1),
                )
              }
              disabled={props.prefetchAhead >= PREFETCH_MAX}
              sx={stepButtonSx}
            >
              <AddIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Box>
          <Typography sx={{ ...hintSx, mt: 0.75 }}>
            Pages fetched before you turn to them. Fewer saves data on a slow
            connection.
          </Typography>
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
      </Box>
    );
  },
);

export default ReaderLeftSidebar;
