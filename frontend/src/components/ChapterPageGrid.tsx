import React from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Chip from "@mui/material/Chip";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import ImportExportIcon from "@mui/icons-material/ImportExport";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import type { Page } from "../types";
import LazyImage from "./LazyImage";
import LoadMoreSentinel from "./LoadMoreSentinel";

export interface ChapterPageGridProps {
  pages: Page[];
  onDeletePage: (pageId: string) => void;
  onMovePage: (index: number, direction: "left" | "right") => void;
  onSelectPage: (page: Page, index: number) => void;
  onNavigate?: (path: string) => void;
  /** Total page count on the server — `pages.length` is only what's loaded so far. */
  totalCount: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  /** Page-number sort direction, applied server-side (see App.tsx). */
  sortAsc: boolean;
  onToggleSort: () => void;
}

/**
 * Overlay controls reveal on hover, and stay visible whenever anything inside them has focus.
 * `:focus-within` is what makes them reachable by keyboard at all — an opacity-0 control is
 * still in the tab order, so without it you could focus a delete button you cannot see.
 */
const REVEAL_ON_HOVER = {
  opacity: 0,
  transition: "opacity 0.2s ease",
  ".MuiCard-root:hover &, .MuiCard-root:focus-within &": { opacity: 1 },
};

const ChapterPageGrid: React.FC<ChapterPageGridProps> = ({
  pages,
  onDeletePage,
  onMovePage,
  onSelectPage,
  totalCount,
  hasMore,
  isLoadingMore,
  onLoadMore,
  sortAsc,
  onToggleSort,
}) => {
  return (
    <>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1}
        sx={{
          justifyContent: "space-between",
          alignItems: { xs: "stretch", sm: "center" },
          mb: 1,
        }}
      >
        <Typography
          variant="h5"
          sx={{ fontWeight: 600 }}
        >
          Pages ({totalCount || pages.length})
        </Typography>
        <Button
          variant="outlined"
          size="small"
          startIcon={<ImportExportIcon />}
          onClick={onToggleSort}
        >
          Sort: {sortAsc ? "Ascending ↑" : "Descending ↓"}
        </Button>
      </Stack>
      <Grid
        container
        spacing={2.5}
        sx={{ mt: 0.5 }}
      >
        {/* Sorted server-side by pageNumber (see App.tsx) — re-sorting here would only
            order the loaded prefix, which is not the same list. */}
        {pages.map((p, idx) => (
          <Grid
            key={p.id}
            size={{ xs: 6, sm: 4, md: 3, lg: 2 }}
          >
            <Card
              onClick={() => {
                onSelectPage(p, idx);
              }}
              sx={{
                position: "relative",
                aspectRatio: "3/4",
                overflow: "hidden",
                cursor: "pointer",
                "&:hover img": { transform: "scale(1.05)" },
              }}
            >
              <LazyImage
                src={p.thumbnailUrl}
                alt={`Page ${p.pageNumber}`}
                sx={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  transition: "transform 0.3s ease",
                }}
              />
              <Chip
                label={`Page ${p.pageNumber}`}
                size="small"
                sx={{
                  position: "absolute",
                  bottom: 8,
                  left: 8,
                  fontWeight: 700,
                  bgcolor: "rgba(0, 0, 0, 0.7)",
                  color: "#f3f4f6",
                }}
              />

              <IconButton
                onClick={(e) => {
                  e.stopPropagation();
                  onDeletePage(p.id);
                }}
                size="small"
                aria-label="Delete page"
                title="Delete page"
                sx={{
                  position: "absolute",
                  top: 8,
                  right: 8,
                  color: "common.white",
                  bgcolor: "rgba(239, 68, 68, 0.9)",
                  "&:hover": { bgcolor: "error.main" },
                  ...REVEAL_ON_HOVER,
                }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>

              <Box
                onClick={(e) => e.stopPropagation()}
                sx={{
                  position: "absolute",
                  top: "50%",
                  left: 0,
                  right: 0,
                  transform: "translateY(-50%)",
                  display: "flex",
                  justifyContent: "space-between",
                  px: 1.5,
                  zIndex: 5,
                  // The band spans the full width across the middle of the card. Without this
                  // it would swallow the click that opens the page.
                  pointerEvents: "none",
                  "& .MuiIconButton-root": { pointerEvents: "auto" },
                  ...REVEAL_ON_HOVER,
                }}
              >
                <IconButton
                  onClick={() => onMovePage(idx, "left")}
                  disabled={idx === 0}
                  size="small"
                  aria-label="Move page left"
                  title="Move page left"
                  sx={{
                    bgcolor: "primary.main",
                    color: "common.white",
                    boxShadow: 2,
                    "&:hover": { bgcolor: "primary.dark" },
                  }}
                >
                  <ChevronLeftIcon fontSize="small" />
                </IconButton>
                <IconButton
                  onClick={() => onMovePage(idx, "right")}
                  // `pages` is the loaded prefix, so this used to disable the control on the
                  // last *fetched* page — page 25 of 177 could not be moved right even though
                  // 152 followed it. The chapter's real length is the bound.
                  disabled={idx === (totalCount || pages.length) - 1}
                  size="small"
                  aria-label="Move page right"
                  title="Move page right"
                  sx={{
                    bgcolor: "primary.main",
                    color: "common.white",
                    boxShadow: 2,
                    "&:hover": { bgcolor: "primary.dark" },
                  }}
                >
                  <ChevronRightIcon fontSize="small" />
                </IconButton>
              </Box>
            </Card>
          </Grid>
        ))}
      </Grid>

      <LoadMoreSentinel
        hasMore={hasMore}
        isLoading={isLoadingMore}
        onLoadMore={onLoadMore}
      />
    </>
  );
};

export default React.memo(ChapterPageGrid);
