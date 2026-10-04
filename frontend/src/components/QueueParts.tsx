import React from "react";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import {
  STRIP_STAGES,
  stageIndexOf,
  stageLabelOf,
  type StripState,
} from "../utils/queueStages";

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
          : `Stage ${current + 1} of ${STRIP_STAGES.length}: ${stageLabelOf(jobType)}`
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
