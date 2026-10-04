import React from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import {
  STRIP_STAGES,
  formatElapsed,
  stageIndexOf,
  stageLabelOf,
  type StripState,
} from "../utils/queueStages";
import type {
  FinishedPage,
  PageLink,
  PageOutcome,
} from "../utils/finishedPages";

const segmentColor = (
  kind: "done" | "current" | "todo",
  state: StripState,
): string => {
  if (kind === "todo") return "var(--bg-chip)";
  // Done is quiet grey, so the one running segment is the only pink on the row.
  if (kind === "done")
    return "color-mix(in srgb, var(--text-muted) 55%, transparent)";
  switch (state) {
    case "failed":
      return "var(--error)";
    case "paused":
      return "var(--text-dim)";
    case "waiting":
      return "color-mix(in srgb, var(--primary) 35%, var(--bg-chip))";
    default:
      return "var(--primary)";
  }
};

export const PipelineStrip: React.FC<{
  jobType: string;
  state: StripState;
  /** A finished final stage: every segment done. */
  allDone?: boolean;
  /** Part of the QA retry loop: the current segment is hatched. */
  retry?: boolean;
}> = ({ jobType, state, allDone = false, retry = false }) => {
  const current = stageIndexOf(jobType);
  return (
    <Box
      role="img"
      aria-label={
        allDone
          ? "All stages done"
          : current >= 0
            ? `Stage ${current + 1} of ${STRIP_STAGES.length}: ${stageLabelOf(jobType)}`
            : `Stage: ${stageLabelOf(jobType)}`
      }
      sx={{ display: "flex", gap: "3px", width: "100%" }}
    >
      {STRIP_STAGES.map((stage, i) => {
        const kind =
          allDone || (current >= 0 && i < current)
            ? "done"
            : i === current
              ? "current"
              : "todo";
        const color = segmentColor(kind, state);
        return (
          <Tooltip
            key={stage.key}
            title={stage.label}
            placement="top"
            disableInteractive
          >
            <Box
              sx={{
                flex: 1,
                height: 6,
                borderRadius: "2px",
                bgcolor: color,
                // Hatched: a retry after QA, or a failure (so it never reads as "running").
                backgroundImage:
                  kind === "current" && (retry || state === "failed")
                    ? `repeating-linear-gradient(135deg, ${color} 0 3px, transparent 3px 6px)`
                    : "none",
                ...(kind === "current" && state === "running" && !retry
                  ? {
                      animation: "stripPulse 1.6s ease-in-out infinite",
                      "@keyframes stripPulse": {
                        "0%, 100%": { opacity: 1 },
                        "50%": { opacity: 0.55 },
                      },
                      "@media (prefers-reduced-motion: reduce)": {
                        animation: "none",
                      },
                    }
                  : {}),
              }}
            />
          </Tooltip>
        );
      })}
    </Box>
  );
};

const OUTCOME_COLOR: Record<PageOutcome, string> = {
  done: "var(--text-muted)",
  review: "var(--warning)",
  failed: "var(--error)",
};

/**
 * The Done tab: pages that finished this session, grouped by chapter, newest first, each with
 * how it ended and, when the queue knows where it is, a way to open it.
 */
export const FinishedList: React.FC<{
  pages: FinishedPage[];
  now: number;
  onOpenPage?: (link: PageLink) => void;
}> = ({ pages, now, onOpenPage }) => {
  if (pages.length === 0) {
    return (
      <Box sx={{ px: 3, py: 6, textAlign: "center" }}>
        <Typography sx={{ fontWeight: 600 }}>Nothing finished yet</Typography>
        <Typography
          variant="body2"
          sx={{ color: "text.secondary", mt: 0.5 }}
        >
          Pages land here when they finish, with what QA made of them.
        </Typography>
      </Box>
    );
  }
  const groups: { label: string; rows: FinishedPage[] }[] = [];
  for (const page of pages) {
    const label = page.chapterLabel ?? "Other pages";
    const group = groups.find((g) => g.label === label);
    if (group) group.rows.push(page);
    else groups.push({ label, rows: [page] });
  }
  return (
    <>
      {groups.map((group) => (
        <Box
          key={group.label}
          component="section"
          aria-label={group.label}
        >
          <Typography
            component="h3"
            sx={{
              px: 2,
              py: 1,
              m: 0,
              fontSize: "0.875rem",
              fontWeight: 600,
              position: "sticky",
              top: 0,
              zIndex: 1,
              bgcolor: "background.paper",
              borderBottom: 1,
              borderColor: "divider",
            }}
          >
            {group.label}
          </Typography>
          <Box
            role="list"
            sx={{ m: 0, p: 0 }}
          >
            {group.rows.map((page) => {
              const ago = Number.isFinite(page.at)
                ? formatElapsed(new Date(page.at).toISOString(), now)
                : null;
              // A problem is named in the backend's own words ("Manual Review Needed",
              // "Re-render Failed"); a clean finish is just Done.
              const said = page.outcome === "done" ? "Done" : page.title;
              return (
                <Box
                  key={page.id}
                  role="listitem"
                  aria-label={`${page.pageLabel}: ${said}`}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1.5,
                    px: 2,
                    py: 1,
                    borderBottom: 1,
                    borderColor: "divider",
                  }}
                >
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography
                      component="span"
                      sx={{ fontWeight: 600, fontSize: "0.875rem", mr: 1 }}
                    >
                      {page.pageLabel}
                    </Typography>
                    <Typography
                      component="span"
                      sx={{
                        fontSize: "0.8125rem",
                        color: OUTCOME_COLOR[page.outcome],
                      }}
                    >
                      {said}
                    </Typography>
                  </Box>
                  {ago && (
                    <Typography
                      component="span"
                      sx={{
                        fontSize: "0.75rem",
                        color: "text.secondary",
                        flexShrink: 0,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {ago} ago
                    </Typography>
                  )}
                  {page.link && onOpenPage && (
                    <Button
                      size="small"
                      variant="text"
                      onClick={() => onOpenPage(page.link!)}
                      aria-label={`Open ${page.pageLabel}`}
                      sx={{ minWidth: 0, flexShrink: 0 }}
                    >
                      Open
                    </Button>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      ))}
    </>
  );
};
