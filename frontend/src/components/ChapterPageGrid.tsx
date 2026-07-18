import React from "react";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import type { Page } from "../types";

export interface ChapterPageGridProps {
  pages: Page[];
  token: string;
  onDeletePage: (pageId: string) => void;
  onMovePage: (index: number, direction: "left" | "right") => void;
  onSelectPage: (page: Page, index: number) => void;
  onNavigate?: (path: string) => void;
}

const ChapterPageGrid: React.FC<ChapterPageGridProps> = ({
  pages,
  token,
  onDeletePage,
  onMovePage,
  onSelectPage,
}) => {
  return (
    <>
      <Typography
        variant="h5"
        sx={{ fontFamily: '"Outfit", sans-serif', fontWeight: 600 }}
      >
        Pages ({pages.length})
      </Typography>
      <div className="pages-grid">
        {pages.map((p, idx) => (
          <div
            key={p.id}
            className="page-thumbnail-container glass"
            onClick={() => {
              onSelectPage(p, idx);
            }}
            style={{ position: "relative" }}
          >
            <img
              src={p.thumbnailUrl || `${p.url}?token=${token}`}
              className="page-thumbnail"
              alt={`Page ${p.pageNumber}`}
            />
            <span className="page-num-tag">Page {p.pageNumber}</span>

            <IconButton
              className="delete-page-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDeletePage(p.id);
              }}
              size="small"
              sx={{ color: "white" }}
              title="Delete page"
            >
              <CloseIcon fontSize="small" />
            </IconButton>

            <div
              className="reorder-controls"
              onClick={(e) => e.stopPropagation()}
            >
              <IconButton
                className="reorder-btn"
                onClick={() => onMovePage(idx, "left")}
                disabled={idx === 0}
                size="small"
                title="Move page left"
              >
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
              <IconButton
                className="reorder-btn"
                onClick={() => onMovePage(idx, "right")}
                disabled={idx === pages.length - 1}
                size="small"
                title="Move page right"
              >
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </div>
          </div>
        ))}
      </div>
    </>
  );
};

export default React.memo(ChapterPageGrid);
