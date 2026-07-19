import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Button from "@mui/material/Button";
import Tooltip from "@mui/material/Tooltip";
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
  const atStart = currentPage <= 1;
  const atEnd = currentPage >= totalPages;

  const segmentBtnSx = {
    borderRadius: 0,
    color: "var(--text-muted)",
    "&:hover": { backgroundColor: "var(--bg-input, rgba(0,0,0,0.05))", color: "var(--text-main)" },
    "&.Mui-disabled": { color: "var(--text-dim, var(--text-muted))", opacity: 0.4 },
  };

  return (
    <Box
      className="reader-page-controls-nhentai"
      sx={{
        display: "flex",
        alignItems: "stretch",
        justifyContent: "center",
        border: "1px solid var(--border-color)",
        borderRadius: "8px",
        overflow: "hidden",
        width: "100%",
      }}
    >
      <Tooltip title="First Page">
        <span>
          <IconButton size="small" onClick={onFirstPage} disabled={atStart} sx={segmentBtnSx}>
            <FirstPageIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Previous Page">
        <span>
          <IconButton size="small" onClick={onPrevPage} disabled={atStart} sx={segmentBtnSx}>
            <NavigateBeforeIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>

      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          gap: "3px",
          fontSize: "12px",
          borderLeft: "1px solid var(--border-color)",
          borderRight: "1px solid var(--border-color)",
          backgroundColor: "var(--bg-input, rgba(0,0,0,0.02))",
          px: 1,
        }}
      >
        <Box component="span" sx={{ fontWeight: 700, color: "var(--text-main)" }}>
          {currentPage}
        </Box>
        <Box component="span" sx={{ color: "var(--text-dim, var(--text-muted))" }}>
          / {totalPages}
        </Box>
      </Box>

      <Tooltip title="Next Page">
        <span>
          <IconButton size="small" onClick={onNextPage} disabled={atEnd} sx={segmentBtnSx}>
            <NavigateNextIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Last Page">
        <span>
          <IconButton size="small" onClick={onLastPage} disabled={atEnd} sx={segmentBtnSx}>
            <LastPageIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
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
  const chapterBtnSx = {
    flex: 1,
    fontSize: "11px",
    fontWeight: 600,
    color: "var(--text-muted)",
    borderColor: "var(--border-color)",
    "&:hover": {
      borderColor: "var(--primary)",
      color: "var(--primary)",
      backgroundColor: "var(--primary-glow)",
    },
  };

  return (
    <Box sx={{ display: "flex", gap: 1, width: "100%" }}>
      <Button
        variant="outlined"
        size="small"
        startIcon={<NavigateBeforeIcon />}
        sx={chapterBtnSx}
        onClick={onPrevChapter}
        disabled={!hasPrevChapter}
      >
        Prev Ch
      </Button>
      <Button
        variant="outlined"
        size="small"
        endIcon={<NavigateNextIcon />}
        sx={chapterBtnSx}
        onClick={onNextChapter}
        disabled={!hasNextChapter}
      >
        Next Ch
      </Button>
    </Box>
  );
}
