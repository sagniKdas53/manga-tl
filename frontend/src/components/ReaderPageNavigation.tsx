import React from "react";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import ButtonBase from "@mui/material/ButtonBase";
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
  /** Go straight to a page; the counter becomes a number field on double-click or double-tap. */
  onJumpToPage?: (page: number) => void;
}

/** Two taps this close together count as a double-tap; touch browsers don't all fire dblclick. */
const DOUBLE_TAP_MS = 350;

const segmentBtnSx = {
  borderRadius: 0,
  width: 34,
  color: "var(--text-muted)",
  "&:hover": {
    backgroundColor: "var(--bg-input, rgba(0,0,0,0.05))",
    color: "var(--text-main)",
  },
  "&.Mui-disabled": {
    color: "var(--text-dim, var(--text-muted))",
    opacity: 0.4,
  },
} as const;

/** The counter, which turns into a page-number field when asked. */
const PageCounter: React.FC<{
  currentPage: number;
  totalPages: number;
  onJumpToPage?: (page: number) => void;
}> = ({ currentPage, totalPages, onJumpToPage }) => {
  const [draft, setDraft] = React.useState<string | null>(null);
  const lastTapRef = React.useRef(0);
  const canJump = !!onJumpToPage && totalPages > 1;

  const startEditing = () => {
    if (canJump) setDraft(String(currentPage));
  };
  const commit = () => {
    const typed = parseInt(draft ?? "", 10);
    setDraft(null);
    if (Number.isNaN(typed)) return;
    const page = Math.min(totalPages, Math.max(1, typed));
    if (page !== currentPage) onJumpToPage?.(page);
  };

  if (draft !== null) {
    return (
      <Box
        component="input"
        type="number"
        inputMode="numeric"
        min={1}
        max={totalPages}
        autoFocus
        aria-label={`Go to page, 1 to ${totalPages}`}
        value={draft}
        onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.target.select()}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
          setDraft(e.target.value)
        }
        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
          // The Reader turns pages on arrow keys; typing a number must not.
          e.stopPropagation();
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setDraft(null);
        }}
        onBlur={() => setDraft(null)}
        sx={{
          flex: 1,
          minWidth: 0,
          border: "none",
          outline: "2px solid var(--primary)",
          outlineOffset: "-2px",
          background: "var(--bg-input, transparent)",
          color: "var(--text-main)",
          font: "inherit",
          fontSize: "13px",
          fontWeight: 700,
          textAlign: "center",
          fontVariantNumeric: "tabular-nums",
          MozAppearance: "textfield",
          "&::-webkit-inner-spin-button, &::-webkit-outer-spin-button": {
            WebkitAppearance: "none",
            margin: 0,
          },
        }}
      />
    );
  }

  return (
    <Tooltip
      title={canJump ? "Double-click to type a page number" : ""}
      describeChild
    >
      <ButtonBase
        aria-label={`Page ${currentPage} of ${totalPages}`}
        onDoubleClick={startEditing}
        onPointerUp={(e) => {
          if (e.pointerType !== "touch") return;
          const now = e.timeStamp;
          if (now - lastTapRef.current < DOUBLE_TAP_MS) {
            lastTapRef.current = 0;
            startEditing();
          } else {
            lastTapRef.current = now;
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "F2") {
            e.preventDefault();
            startEditing();
          }
        }}
        sx={{
          flex: 1,
          gap: "3px",
          fontSize: "13px",
          fontFamily: "inherit",
          fontVariantNumeric: "tabular-nums",
          cursor: canJump ? "text" : "default",
          "&:hover": canJump
            ? { backgroundColor: "var(--bg-input, rgba(0,0,0,0.04))" }
            : undefined,
          "&.Mui-focusVisible": {
            outline: "2px solid var(--primary)",
            outlineOffset: "-2px",
          },
        }}
      >
        <Box
          component="span"
          sx={{ fontWeight: 700, color: "var(--text-main)" }}
        >
          {currentPage}
        </Box>
        <Box
          component="span"
          sx={{ color: "var(--text-dim, var(--text-muted))" }}
        >
          / {totalPages}
        </Box>
      </ButtonBase>
    </Tooltip>
  );
};

export function ReaderPageNavigation({
  currentPage,
  totalPages,
  onFirstPage,
  onPrevPage,
  onNextPage,
  onLastPage,
  onJumpToPage,
}: ReaderPageNavigationProps) {
  const atStart = currentPage <= 1;
  const atEnd = currentPage >= totalPages;

  return (
    <Box
      className="reader-page-controls-nhentai"
      sx={{
        display: "flex",
        alignItems: "stretch",
        height: 34,
        borderRadius: "6px",
        overflow: "hidden",
        width: "100%",
        backgroundColor: "var(--bg-raised, var(--bg-input))",
      }}
    >
      <Tooltip title="First page">
        <span>
          <IconButton
            data-testid="first-page-btn"
            aria-label="First page"
            size="small"
            onClick={onFirstPage}
            disabled={atStart}
            sx={segmentBtnSx}
          >
            <FirstPageIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Previous page">
        <span>
          <IconButton
            data-testid="prev-page-btn"
            aria-label="Previous page"
            size="small"
            onClick={onPrevPage}
            disabled={atStart}
            sx={segmentBtnSx}
          >
            <NavigateBeforeIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>

      <PageCounter
        currentPage={currentPage}
        totalPages={totalPages}
        onJumpToPage={onJumpToPage}
      />

      <Tooltip title="Next page">
        <span>
          <IconButton
            data-testid="next-page-btn"
            aria-label="Next page"
            size="small"
            onClick={onNextPage}
            disabled={atEnd}
            sx={segmentBtnSx}
          >
            <NavigateNextIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Last page">
        <span>
          <IconButton
            data-testid="last-page-btn"
            aria-label="Last page"
            size="small"
            onClick={onLastPage}
            disabled={atEnd}
            sx={segmentBtnSx}
          >
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
    width: 30,
    height: 30,
    borderRadius: "6px",
    color: "var(--text-muted)",
    "&:hover": {
      color: "var(--text-main)",
      backgroundColor: "var(--bg-input, rgba(0,0,0,0.04))",
    },
  };

  return (
    <Box
      role="group"
      aria-label="Chapter"
      sx={{ display: "flex", alignItems: "center", gap: 0.5, width: "100%" }}
    >
      <Box
        component="span"
        sx={{ flex: 1, fontSize: "13px", color: "var(--text-main)" }}
      >
        Chapter
      </Box>
      <Tooltip title="Previous chapter">
        <span>
          <IconButton
            size="small"
            aria-label="Previous chapter"
            onClick={onPrevChapter}
            disabled={!hasPrevChapter}
            sx={chapterBtnSx}
          >
            <NavigateBeforeIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Next chapter">
        <span>
          <IconButton
            size="small"
            aria-label="Next chapter"
            onClick={onNextChapter}
            disabled={!hasNextChapter}
            sx={chapterBtnSx}
          >
            <NavigateNextIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
}
