import React from "react";
import {
  Box,
  Typography,
  Switch,
  FormControlLabel,
  Slider,
  Button,
  TextField,
  Divider,
} from "@mui/material";
import FitScreenIcon from "@mui/icons-material/FitScreen";
import WidthFullIcon from "@mui/icons-material/WidthFull";
import HeightIcon from "@mui/icons-material/Height";
import DeleteIcon from "@mui/icons-material/Delete";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import { ReaderPageNavigation, ReaderPrevNextChapters } from "./ReaderPageNavigation";

// Types derived from existing usage
interface Chapter {
  id: string;
  chapterNumber: number;
}
interface Page {
  id: string;
  pageNumber: number;
}

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

const ReaderLeftSidebar: React.FC<ReaderLeftSidebarProps> = React.memo((props) => {
  const displayedZoom = Math.round(props.zoom * 100);

  // Local state for the "Change Page Number" input
  const [targetPageInput, setTargetPageInput] = React.useState<string>("");

  React.useEffect(() => {
    // Reset target page input when current page changes
    if (props.selectedPage) {
      setTargetPageInput(props.selectedPage.pageNumber.toString());
    }
  }, [props.selectedPage]);

  const onPageMoveSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!props.selectedPage) return;
    const newPageNum = parseInt(targetPageInput, 10);
    if (!isNaN(newPageNum)) {
      props.handleChangePageNumber(props.selectedPage.id, newPageNum);
    }
  };

  return (
    <div className="reader-left-sidebar-nhentai">
      {/* Overlays Section */}
      <div className="panel-section">
        <div className="panel-section-title">OVERLAYS</div>
        <Box sx={{ display: "flex", flexDirection: "column" }}>
          <FormControlLabel
            control={
              <Switch
                checked={props.showPanels}
                onChange={(e) => props.setShowPanels(e.target.checked)}
                size="small"
              />
            }
            label={<Typography variant="body2">Panel Boundaries</Typography>}
          />
          <FormControlLabel
            control={
              <Switch
                checked={props.showOcr}
                onChange={(e) => props.setShowOcr(e.target.checked)}
                size="small"
              />
            }
            label={<Typography variant="body2">OCR Boxes</Typography>}
          />
          <FormControlLabel
            control={
              <Switch
                checked={props.cleanScanlationView}
                onChange={(e) => {
                  props.setCleanScanlationView(e.target.checked);
                  props.setManuallyShownOcrLayers(new Set());
                }}
                size="small"
                color="primary"
              />
            }
            label={<Typography variant="body2">Clean Scanlation</Typography>}
          />
          <FormControlLabel
            control={
              <Switch
                checked={props.groupByConversation}
                onChange={(e) => props.setGroupByConversation(e.target.checked)}
                size="small"
              />
            }
            label={<Typography variant="body2">Group Conversation</Typography>}
          />
        </Box>
      </div>

      {/* Zoom & View Section */}
      <div className="panel-section">
        <div className="panel-section-title">ZOOM & VIEW</div>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 1.5 }}>
          <Slider
            min={0.5}
            max={3.0}
            step={0.1}
            value={props.zoom}
            onChange={(_, val) => props.setZoom(val as number)}
            size="small"
            sx={{ flex: 1 }}
          />
          <Typography variant="body2" sx={{ minWidth: "40px", fontWeight: "bold", textAlign: 'right' }}>
            {displayedZoom}%
          </Typography>
        </Box>
        <Box sx={{ display: "flex", gap: 1, mb: 1.5 }}>
          <Button
            size="small"
            variant={props.fitMode === "page" ? "contained" : "outlined"}
            onClick={() => props.setFitMode("page")}
            startIcon={<FitScreenIcon />}
            sx={{ flex: 1, fontSize: "11px", fontWeight: 600 }}
          >
            Page
          </Button>
          <Button
            size="small"
            variant={props.fitMode === "width" ? "contained" : "outlined"}
            onClick={() => props.setFitMode("width")}
            startIcon={<WidthFullIcon />}
            sx={{ flex: 1, fontSize: "11px", fontWeight: 600 }}
          >
            Width
          </Button>
          <Button
            size="small"
            variant={props.fitMode === "height" ? "contained" : "outlined"}
            onClick={() => props.setFitMode("height")}
            startIcon={<HeightIcon />}
            sx={{ flex: 1, fontSize: "11px", fontWeight: 600 }}
          >
            Height
          </Button>
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
          sx={{ fontSize: "11px", fontWeight: 600 }}
        >
          Reset Zoom
        </Button>
      </div>

      {/* Navigation Section */}
      <div className="panel-section">
        <div className="panel-section-title">NAVIGATION</div>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
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
      </div>

      {/* Page Management Section */}
      <div className="panel-section" style={{ marginBottom: 40 }}>
        <div className="panel-section-title">PAGE MANAGEMENT</div>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          <form onSubmit={onPageMoveSubmit} style={{ display: 'flex', gap: '8px' }}>
            <TextField
              size="small"
              type="number"
              placeholder="Move to..."
              value={targetPageInput}
              onChange={(e) => setTargetPageInput(e.target.value)}
              sx={{ flex: 1 }}
              inputProps={{ style: { padding: '8px 10px', fontSize: '13px' } }}
            />
            <Button
              type="submit"
              variant="contained"
              size="small"
              startIcon={<SwapHorizIcon />}
              disabled={!props.selectedPage || targetPageInput === props.selectedPage.pageNumber.toString()}
              sx={{ fontSize: "11px", fontWeight: 600 }}
            >
              Move
            </Button>
          </form>
          
          <Button
            variant="outlined"
            color="error"
            size="small"
            fullWidth
            startIcon={<DeleteIcon />}
            onClick={() => {
              if (props.selectedPage) {
                if (window.confirm("Are you sure you want to delete this page? This cannot be undone.")) {
                  props.handleDeletePage(props.selectedPage.id);
                }
              }
            }}
            disabled={!props.selectedPage}
            sx={{ fontSize: "11px", fontWeight: 600 }}
          >
            Delete Page
          </Button>
        </Box>
      </div>
    </div>
  );
});

export default ReaderLeftSidebar;
