import React from "react";
import IconButton from "@mui/material/IconButton";
import Button from "@mui/material/Button";
import FirstPageIcon from "@mui/icons-material/FirstPage";
import LastPageIcon from "@mui/icons-material/LastPage";
import NavigateBeforeIcon from "@mui/icons-material/NavigateBefore";
import NavigateNextIcon from "@mui/icons-material/NavigateNext";

interface ReaderPageNavigationProps {
  currentPage: number;
  totalPages: number;
  onFirstPage: () => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onLastPage: () => void;
}

export function ReaderPageNavigation({
  currentPage,
  totalPages,
  onFirstPage,
  onPrevPage,
  onNextPage,
  onLastPage,
}: ReaderPageNavigationProps) {
  return (
    <div
      className="reader-page-controls-nhentai"
      style={{
        display: "flex",
        justifyContent: "center",
        marginBottom: "12px",
        gap: "6px",
      }}
    >
      <IconButton
        size="small"
        onClick={onFirstPage}
        disabled={currentPage <= 1}
        title="First Page"
      >
        <FirstPageIcon fontSize="small" />
      </IconButton>
      <IconButton
        size="small"
        onClick={onPrevPage}
        disabled={currentPage <= 1}
        title="Previous Page"
      >
        <NavigateBeforeIcon fontSize="small" />
      </IconButton>

      <span
        className="reader-page-indicator-nhentai"
        style={{ margin: "0 4px", fontSize: "12px" }}
      >
        <strong>{currentPage}</strong> / {totalPages}
      </span>

      <IconButton
        size="small"
        onClick={onNextPage}
        disabled={currentPage >= totalPages}
        title="Next Page"
      >
        <NavigateNextIcon fontSize="small" />
      </IconButton>
      <IconButton
        size="small"
        onClick={onLastPage}
        disabled={currentPage >= totalPages}
        title="Last Page"
      >
        <LastPageIcon fontSize="small" />
      </IconButton>
    </div>
  );
}

interface ReaderPrevNextChaptersProps {
  hasPrevChapter: boolean;
  hasNextChapter: boolean;
  onPrevChapter: () => void;
  onNextChapter: () => void;
}

export function ReaderPrevNextChapters({
  hasPrevChapter,
  hasNextChapter,
  onPrevChapter,
  onNextChapter,
}: ReaderPrevNextChaptersProps) {
  return (
    <div style={{ display: "flex", gap: "8px", width: "100%" }}>
      <Button
        variant="outlined"
        size="small"
        startIcon={<NavigateBeforeIcon />}
        style={{ flex: 1, fontSize: "11px" }}
        onClick={onPrevChapter}
        disabled={!hasPrevChapter}
      >
        Prev Ch
      </Button>
      <Button
        variant="outlined"
        size="small"
        startIcon={<NavigateNextIcon />}
        style={{ flex: 1, fontSize: "11px" }}
        onClick={onNextChapter}
        disabled={!hasNextChapter}
      >
        Next Ch
      </Button>
    </div>
  );
}
