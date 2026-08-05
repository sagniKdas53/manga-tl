import React from "react";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Chip from "@mui/material/Chip";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import type { Page } from "../types";
import LazyImage from "./LazyImage";

export interface ChapterPageGridProps {
  pages: Page[];
  onDeletePage: (pageId: string) => void;
  onMovePage: (index: number, direction: "left" | "right") => void;
  onSelectPage: (page: Page, index: number) => void;
  onNavigate?: (path: string) => void;
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
}) => {
  return (
    <>
      <Typography
        variant="h5"
        sx={{ fontWeight: 600 }}
      >
        Pages ({pages.length})
      </Typography>
      <Grid
        container
        spacing={2.5}
        sx={{ mt: 0.5 }}
      >
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
                  disabled={idx === pages.length - 1}
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
    </>
  );
};

export default React.memo(ChapterPageGrid);
