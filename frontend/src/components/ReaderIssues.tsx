import React from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Checkbox from "@mui/material/Checkbox";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import SidebarSection from "./SidebarSection";
import type { OcrRegion } from "../types";
import {
  ISSUE_ACTION_LABELS,
  type IssueAction,
  type RegionIssue,
} from "../utils/regionIssues";

const numberChipSx = {
  flexShrink: 0,
  minWidth: 26,
  height: 20,
  px: 0.5,
  borderRadius: "5px",
  fontSize: "10.5px",
  fontWeight: 700,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
} as const;

const warningChipSx = {
  ...numberChipSx,
  color: "var(--warning)",
  backgroundColor: "color-mix(in srgb, var(--warning) 14%, transparent)",
} as const;

const smallTextSx = {
  fontSize: "12px",
  lineHeight: 1.45,
  color: "var(--text-main)",
  m: 0,
} as const;

/** The sidebar's list of everything on the page that needs a person, in reading order. */
export const IssueList: React.FC<{
  issues: RegionIssue[];
  selectedRegionId: string | null;
  onSelect: (issue: RegionIssue) => void;
}> = ({ issues, selectedRegionId, onSelect }) => {
  if (issues.length === 0) return null;
  return (
    <SidebarSection
      title="Issues"
      headerExtra={
        <Box
          component="span"
          sx={warningChipSx}
        >
          {issues.length}
        </Box>
      }
    >
      <Box
        component="ul"
        sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: 0.5 }}
      >
        {issues.map((issue) => {
          const selected = issue.region.id === selectedRegionId;
          return (
            <li key={issue.region.id}>
              <ButtonBase
                onClick={() => onSelect(issue)}
                sx={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  p: "6px 8px",
                  borderRadius: "8px",
                  textAlign: "left",
                  border: selected
                    ? "1px solid var(--warning)"
                    : "1px solid var(--border-color)",
                  backgroundColor: selected
                    ? "color-mix(in srgb, var(--warning) 10%, transparent)"
                    : "transparent",
                  "&:hover": { borderColor: "var(--warning)" },
                }}
              >
                <Box
                  component="span"
                  sx={warningChipSx}
                >
                  #{issue.region.bubbleReadingOrder ?? "?"}
                </Box>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography
                    component="span"
                    sx={{
                      display: "block",
                      fontSize: "12.5px",
                      fontWeight: 600,
                      color: "var(--text-main)",
                    }}
                  >
                    {issue.title}
                  </Typography>
                  <Typography
                    component="span"
                    sx={{
                      display: "block",
                      fontSize: "11px",
                      color: "var(--text-muted)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {issue.element?.text?.trim() || issue.region.text}
                  </Typography>
                </Box>
              </ButtonBase>
            </li>
          );
        })}
      </Box>
    </SidebarSection>
  );
};

/** The inspector card for one issue: what is wrong, and the quick ways to settle it. */
export const IssueCard: React.FC<{
  issue: RegionIssue;
  position: number;
  total: number;
  busy: boolean;
  onAction: (issue: RegionIssue, action: IssueAction) => void;
  onSaveTranslation: (issue: RegionIssue, text: string) => void;
  onStep: (delta: -1 | 1) => void;
}> = ({
  issue,
  position,
  total,
  busy,
  onAction,
  onSaveTranslation,
  onStep,
}) => {
  const [draft, setDraft] = React.useState<string | null>(null);
  const [showDetails, setShowDetails] = React.useState(false);
  const number = issue.region.bubbleReadingOrder ?? "?";

  return (
    <Box
      role="status"
      aria-label={`Issue on region ${number}: ${issue.title}`}
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 1,
        p: 1.25,
        borderRadius: "8px",
        border: "1px solid var(--warning)",
        backgroundColor: "color-mix(in srgb, var(--warning) 10%, transparent)",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
        <WarningAmberRoundedIcon
          sx={{ fontSize: 16, color: "var(--warning)" }}
        />
        <Typography
          component="span"
          sx={{
            fontSize: "13px",
            fontWeight: 700,
            color: "var(--warning)",
            flex: 1,
          }}
        >
          #{number} · {issue.title}
        </Typography>
        {total > 1 && (
          <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <IconButton
              size="small"
              aria-label="Previous issue"
              onClick={() => onStep(-1)}
              sx={{ p: 0.25, color: "var(--text-muted)" }}
            >
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
            <Typography
              component="span"
              sx={{ fontSize: "11px", color: "var(--text-muted)" }}
            >
              {position}/{total}
            </Typography>
            <IconButton
              size="small"
              aria-label="Next issue"
              onClick={() => onStep(1)}
              sx={{ p: 0.25, color: "var(--text-muted)" }}
            >
              <ChevronRightIcon fontSize="small" />
            </IconButton>
          </Box>
        )}
      </Box>

      <Typography
        component="p"
        sx={smallTextSx}
      >
        {issue.explanation}
      </Typography>
      {issue.hint && (
        <Typography
          component="p"
          sx={{
            ...smallTextSx,
            color: "var(--text-muted)",
            fontStyle: "italic",
          }}
        >
          {issue.hint}
        </Typography>
      )}
      {issue.details && (
        <Box>
          <ButtonBase
            onClick={() => setShowDetails((v) => !v)}
            sx={{
              fontSize: "11px",
              color: "var(--text-muted)",
              textDecoration: "underline",
            }}
          >
            {showDetails ? "Hide details" : "Details"}
          </ButtonBase>
          {showDetails && (
            <Typography
              component="p"
              sx={{
                ...smallTextSx,
                fontSize: "11px",
                color: "var(--text-muted)",
                mt: 0.5,
              }}
            >
              {issue.details}
            </Typography>
          )}
        </Box>
      )}

      {draft !== null ? (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
          <TextField
            multiline
            minRows={2}
            size="small"
            autoFocus
            label="Translation"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button
              variant="contained"
              size="small"
              disabled={busy || !draft.trim()}
              onClick={() => {
                onSaveTranslation(issue, draft.trim());
                setDraft(null);
              }}
              sx={{ textTransform: "none", boxShadow: "none" }}
            >
              Save
            </Button>
            <Button
              variant="text"
              size="small"
              onClick={() => setDraft(null)}
              sx={{ textTransform: "none" }}
            >
              Cancel
            </Button>
          </Box>
        </Box>
      ) : (
        <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap" }}>
          {issue.actions.map((action, index) => (
            <Button
              key={action}
              variant={
                index === 0
                  ? "contained"
                  : action === "delete"
                    ? "text"
                    : "outlined"
              }
              size="small"
              disabled={busy}
              onClick={() =>
                action === "edit"
                  ? setDraft(issue.element?.text || "")
                  : onAction(issue, action)
              }
              sx={{
                textTransform: "none",
                boxShadow: "none",
                ...(action === "delete"
                  ? { color: "var(--error)" }
                  : index === 0
                    ? {
                        backgroundColor: "var(--warning)",
                        color: "#1f1400",
                        "&:hover": {
                          backgroundColor: "var(--warning)",
                          filter: "brightness(0.95)",
                        },
                      }
                    : {
                        color: "var(--warning)",
                        borderColor: "var(--warning)",
                        "&:hover": {
                          borderColor: "var(--warning)",
                          backgroundColor:
                            "color-mix(in srgb, var(--warning) 12%, transparent)",
                        },
                      }),
              }}
            >
              {ISSUE_ACTION_LABELS[action]}
            </Button>
          ))}
        </Box>
      )}
    </Box>
  );
};

/**
 * Picking the fragments that form one text block. A list with checkboxes, so it works by touch as
 * well as by clicking boxes on the page.
 */
export const MergePanel: React.FC<{
  regions: OcrRegion[];
  selected: string[];
  busy: boolean;
  onToggle: (regionId: string) => void;
  onMerge: () => void;
  onCancel: () => void;
}> = ({ regions, selected, busy, onToggle, onMerge, onCancel }) => {
  const ordered = [...regions].sort(
    (a, b) =>
      (a.bubbleReadingOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.bubbleReadingOrder ?? Number.MAX_SAFE_INTEGER),
  );
  const chosen = ordered.filter((r) => selected.includes(r.id));
  // Merge mode is started from Editor Tools, further down the sidebar; bring the list into view.
  const panelRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    panelRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, []);
  return (
    <Box ref={panelRef}>
      <SidebarSection
        title="Merge regions"
        sx={{ borderColor: "var(--primary)" }}
      >
        <Typography
          component="p"
          sx={{ ...smallTextSx, mb: 1 }}
        >
          Pick the pieces that are one text block, here or on the page. They
          become one region, which is cleaned and translated again as a whole.
        </Typography>
        <Box
          component="ul"
          sx={{
            listStyle: "none",
            m: 0,
            p: 0,
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          {ordered.map((region) => {
            const checked = selected.includes(region.id);
            return (
              <li key={region.id}>
                <Box
                  component="label"
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 0.5,
                    py: 0.25,
                    cursor: "pointer",
                    borderRadius: "6px",
                    backgroundColor: checked
                      ? "var(--primary-glow)"
                      : "transparent",
                  }}
                >
                  <Checkbox
                    size="small"
                    checked={checked}
                    onChange={() => onToggle(region.id)}
                    sx={{ p: 0.5 }}
                    slotProps={{
                      input: {
                        "aria-label": `Region ${region.bubbleReadingOrder ?? "?"}`,
                      },
                    }}
                  />
                  <Box
                    component="span"
                    sx={{
                      ...numberChipSx,
                      color: "var(--text-muted)",
                      backgroundColor: "var(--bg-input, rgba(0,0,0,0.06))",
                    }}
                  >
                    #{region.bubbleReadingOrder ?? "?"}
                  </Box>
                  <Typography
                    component="span"
                    sx={{
                      fontSize: "12px",
                      color: "var(--text-main)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {region.text}
                  </Typography>
                </Box>
              </li>
            );
          })}
        </Box>
        <Box sx={{ display: "flex", gap: 1, mt: 1.25, alignItems: "center" }}>
          <Button
            variant="contained"
            size="small"
            disabled={busy || chosen.length < 2}
            onClick={onMerge}
            sx={{ textTransform: "none", boxShadow: "none" }}
          >
            {chosen.length >= 2
              ? `Merge ${chosen.map((r) => `#${r.bubbleReadingOrder ?? "?"}`).join(" ")}`
              : "Merge"}
          </Button>
          <Button
            variant="text"
            size="small"
            onClick={onCancel}
            sx={{ textTransform: "none" }}
          >
            Cancel
          </Button>
        </Box>
      </SidebarSection>
    </Box>
  );
};
