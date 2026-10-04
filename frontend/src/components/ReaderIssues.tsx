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
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import SidebarSection from "./SidebarSection";
import type { OcrRegion } from "../types";
import {
  ISSUE_ACTION_LABELS,
  type IssueAction,
  type IssueKind,
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

const KIND_LABELS: Record<IssueKind, string> = {
  cleanup: "No lettering",
  qa: "QA flagged",
  failed: "Failed",
  untranslated: "Not translated",
  overflow: "Doesn't fit",
};

interface ReviewRow {
  issue: RegionIssue;
  settled: boolean;
}

/**
 * The Review tab: everything on the page that needs a person, in reading order, numbered as the
 * balloons are numbered on the page.
 *
 * Reader review (2026-10-04) asked for a better way through a page's issues. A settled issue
 * used to vanish from the list, so after three fixes there was no telling how far you had got.
 * The list now keeps what it has shown on this page, ticks off what you settle, and draws the
 * page's progress as one segment per issue. J and K step through the open ones (Reader.tsx).
 */
export const ReviewPanel: React.FC<{
  issues: RegionIssue[];
  /** The page these issues belong to. A new page starts a new tally. */
  pageId: string | null;
  onSelect: (issue: RegionIssue) => void;
}> = ({ issues, pageId, onSelect }) => {
  // Every issue seen on this page so far, by region. Adjusted during render (React's pattern
  // for state that follows a prop), so the tally is never a frame behind the list.
  const [tally, setTally] = React.useState<{
    pageId: string | null;
    seen: Map<string, RegionIssue>;
  }>(() => ({
    pageId,
    seen: new Map(issues.map((i) => [i.region.id, i])),
  }));
  if (tally.pageId !== pageId) {
    setTally({
      pageId,
      seen: new Map(issues.map((i) => [i.region.id, i])),
    });
  } else if (issues.some((i) => tally.seen.get(i.region.id) !== i)) {
    const seen = new Map(tally.seen);
    issues.forEach((i) => seen.set(i.region.id, i));
    setTally({ pageId, seen });
  }

  const [kind, setKind] = React.useState<IssueKind | "all">("all");

  const open = new Set(issues.map((i) => i.region.id));
  const rows: ReviewRow[] = [...tally.seen.values()]
    .map((issue) => ({ issue, settled: !open.has(issue.region.id) }))
    .sort(
      (a, b) =>
        (a.issue.region.bubbleReadingOrder ?? Infinity) -
        (b.issue.region.bubbleReadingOrder ?? Infinity),
    );
  const settledCount = rows.filter((r) => r.settled).length;
  const kinds = [...new Set(issues.map((i) => i.kind))];
  const activeKind = kind !== "all" && kinds.includes(kind) ? kind : "all";
  const shown = rows.filter(
    (r) => activeKind === "all" || r.issue.kind === activeKind,
  );

  if (rows.length === 0) {
    return (
      <Typography
        component="p"
        sx={{ ...smallTextSx, color: "var(--text-muted)", py: 1 }}
      >
        Nothing to review on this page.
      </Typography>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
      <Box>
        <Box
          sx={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 1,
            mb: 0.75,
          }}
        >
          <Typography
            component="p"
            sx={{ m: 0, fontSize: "13px", fontWeight: 600 }}
          >
            {issues.length === 0
              ? `All ${rows.length} settled`
              : `${issues.length} to review`}
            {settledCount > 0 && issues.length > 0 && (
              <Box
                component="span"
                sx={{ fontWeight: 400, color: "var(--text-muted)" }}
              >
                , {settledCount} settled
              </Box>
            )}
          </Typography>
          {issues.length > 1 && (
            <Typography
              component="p"
              sx={{ m: 0, fontSize: "12px", color: "var(--text-muted)" }}
            >
              <Kbd>J</Kbd> <Kbd>K</Kbd> to step
            </Typography>
          )}
        </Box>
        <Box
          role="img"
          aria-label={`${settledCount} of ${rows.length} issues on this page settled`}
          sx={{ display: "flex", gap: "3px" }}
        >
          {rows.map((r) => (
            <Box
              key={r.issue.region.id}
              sx={{
                flex: 1,
                height: 4,
                borderRadius: "2px",
                backgroundColor: r.settled
                  ? "color-mix(in srgb, var(--text-muted) 55%, transparent)"
                  : "var(--warning)",
              }}
            />
          ))}
        </Box>
      </Box>

      {kinds.length > 1 && (
        <Box
          role="group"
          aria-label="Show issues of one kind"
          sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}
        >
          {(["all", ...kinds] as const).map((k) => {
            const count =
              k === "all"
                ? issues.length
                : issues.filter((i) => i.kind === k).length;
            const active = activeKind === k;
            return (
              <ButtonBase
                key={k}
                aria-pressed={active}
                onClick={() => setKind(k)}
                sx={{
                  px: 1,
                  height: 24,
                  borderRadius: "4px",
                  fontSize: "12px",
                  fontWeight: 500,
                  gap: 0.5,
                  color: active ? "var(--text-main)" : "var(--text-muted)",
                  backgroundColor: active
                    ? "var(--bg-chip, var(--bg-input))"
                    : "transparent",
                  "&:hover": { color: "var(--text-main)" },
                  "&.Mui-focusVisible": {
                    outline: "2px solid var(--primary)",
                  },
                }}
              >
                {k === "all" ? "All" : KIND_LABELS[k]}
                <Box
                  component="span"
                  sx={{ color: "var(--text-muted)", fontWeight: 400 }}
                >
                  {count}
                </Box>
              </ButtonBase>
            );
          })}
        </Box>
      )}

      <Box
        component="ul"
        aria-label="Issues on this page"
        sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: "2px" }}
      >
        {shown.map(({ issue, settled }) => {
          const number = issue.region.bubbleReadingOrder ?? "?";
          const text = issue.element?.text?.trim() || issue.region.text;
          const body = (
            <>
              <Box
                component="span"
                aria-hidden
                sx={settled ? settledChipSx : warningChipSx}
              >
                {settled ? <CheckRoundedIcon sx={{ fontSize: 14 }} /> : number}
              </Box>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography
                  component="span"
                  sx={{
                    display: "block",
                    fontSize: "13px",
                    fontWeight: 600,
                    color: settled ? "var(--text-muted)" : "var(--text-main)",
                  }}
                >
                  {settled ? `#${number} settled` : issue.title}
                </Typography>
                <Typography
                  component="span"
                  sx={{
                    display: "block",
                    fontSize: "12px",
                    color: "var(--text-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {text}
                </Typography>
              </Box>
            </>
          );
          return (
            <li key={issue.region.id}>
              {settled ? (
                <Box sx={{ ...rowSx, opacity: 0.7 }}>{body}</Box>
              ) : (
                <ButtonBase
                  onClick={() => onSelect(issue)}
                  aria-label={`#${number}: ${issue.title}`}
                  sx={{
                    ...rowSx,
                    "&:hover": {
                      backgroundColor: "var(--bg-input, rgba(0,0,0,0.04))",
                    },
                    "&.Mui-focusVisible": {
                      outline: "2px solid var(--primary)",
                      outlineOffset: "-2px",
                    },
                  }}
                >
                  {body}
                </ButtonBase>
              )}
            </li>
          );
        })}
      </Box>
    </Box>
  );
};

const rowSx = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 1.25,
  p: "7px 8px",
  borderRadius: "6px",
  textAlign: "left",
  justifyContent: "flex-start",
} as const;

const settledChipSx = {
  ...numberChipSx,
  color: "var(--text-muted)",
  backgroundColor: "var(--bg-input, rgba(0,0,0,0.04))",
} as const;

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Box
    component="kbd"
    sx={{
      display: "inline-block",
      minWidth: 18,
      px: 0.5,
      borderRadius: "4px",
      fontFamily: "inherit",
      fontSize: "11px",
      fontWeight: 600,
      lineHeight: "18px",
      textAlign: "center",
      color: "var(--text-main)",
      backgroundColor: "var(--bg-chip, var(--bg-input))",
    }}
  >
    {children}
  </Box>
);

/** The inspector card for one issue: what is wrong, and the quick ways to settle it. */
export const IssueCard: React.FC<{
  issue: RegionIssue;
  position: number;
  total: number;
  busy: boolean;
  onAction: (issue: RegionIssue, action: IssueAction) => void;
  onSaveTranslation: (issue: RegionIssue, text: string) => void;
  /** "Type source text": correct what OCR read; the region is then translated again. */
  onSaveSourceText: (issue: RegionIssue, text: string) => void;
  onStep: (delta: -1 | 1) => void;
}> = ({
  issue,
  position,
  total,
  busy,
  onAction,
  onSaveTranslation,
  onSaveSourceText,
  onStep,
}) => {
  const [draft, setDraft] = React.useState<{
    field: "translation" | "source";
    text: string;
  } | null>(null);
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
            label={draft.field === "source" ? "Source text" : "Translation"}
            value={draft.text}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          />
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button
              variant="contained"
              size="small"
              disabled={busy || !draft.text.trim()}
              onClick={() => {
                (draft.field === "source"
                  ? onSaveSourceText
                  : onSaveTranslation)(issue, draft.text.trim());
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
                  ? setDraft({
                      field: "translation",
                      text: issue.element?.text || "",
                    })
                  : action === "edit-source"
                    ? setDraft({
                        field: "source",
                        text: issue.region.text || "",
                      })
                    : onAction(issue, action)
              }
              // The first action is the suggested one, in the review colour; the rest are the
              // theme's quiet buttons, and Delete is a red text button.
              color={
                action === "delete"
                  ? "error"
                  : index === 0
                    ? "warning"
                    : "inherit"
              }
              sx={{ textTransform: "none", boxShadow: "none" }}
            >
              {ISSUE_ACTION_LABELS[action]}
            </Button>
          ))}
        </Box>
      )}
    </Box>
  );
};

/** What a merge would do, from the backend's dry run: pieces in reading order, and their text. */
export interface MergePreview {
  order: string[];
  text: string;
}

// A settled decision is never suggested back into a block.
const SETTLED = new Set(["rejected", "reject_sfx"]);

/**
 * Picking the fragments that form one text block. A list with checkboxes, so it works by touch as
 * well as by clicking boxes on the page.
 *
 * The pieces are read in the order the backend's dry run gives — columns right to left for
 * vertical text, lines top to bottom for horizontal — not in their Reader numbers, which follow
 * OCR's order. The panel shows that order and the joined text before anything is merged, and the
 * page numbers the picked pieces 1, 2, 3… along the same path, so the order can be checked by
 * where the pieces sit without reading the source language.
 */
export const MergePanel: React.FC<{
  regions: OcrRegion[];
  selected: string[];
  busy: boolean;
  preview: MergePreview | null;
  onToggle: (regionId: string) => void;
  onMerge: () => void;
  onCancel: () => void;
}> = ({ regions, selected, busy, preview, onToggle, onMerge, onCancel }) => {
  const ordered = [...regions].sort(
    (a, b) =>
      (a.bubbleReadingOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.bubbleReadingOrder ?? Number.MAX_SAFE_INTEGER),
  );
  const chosen = ordered.filter((r) => selected.includes(r.id));
  const byId = new Map(regions.map((r) => [r.id, r]));
  // The preview answers for one selection; while a newer one is on its way, show none.
  const current =
    preview &&
    preview.order.length === selected.length &&
    preview.order.every((id) => selected.includes(id))
      ? preview
      : null;
  // Pieces the detector put in the same balloon as a picked one, not yet picked.
  const balloons = new Set(
    chosen
      .map((r) => r.bubbleId)
      .filter((id): id is string => !!id && id.startsWith("bubble")),
  );
  const siblings = ordered.filter(
    (r) =>
      !selected.includes(r.id) &&
      !!r.bubbleId &&
      balloons.has(r.bubbleId) &&
      !SETTLED.has(r.qaStatus ?? ""),
  );
  // Merge mode is started from Editor Tools, further down the sidebar; bring the list into view.
  const panelRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    panelRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, []);
  return (
    <Box ref={panelRef}>
      <SidebarSection
        title="Merge regions"
        sx={{
          px: 1.25,
          mb: 1.5,
          borderTop: "none",
          borderRadius: "8px",
          backgroundColor: "var(--primary-glow)",
          "&:first-of-type": { pt: 1.25 },
        }}
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
        {siblings.length > 0 && (
          <Button
            variant="text"
            size="small"
            onClick={() => siblings.forEach((r) => onToggle(r.id))}
            sx={{ textTransform: "none", mt: 0.5, px: 0.5 }}
          >
            {`Add the other ${siblings.length === 1 ? "piece" : `${siblings.length} pieces`} in this balloon`}
          </Button>
        )}
        {chosen.length >= 2 && (
          <Box
            role="region"
            aria-label="Merge preview"
            sx={{
              mt: 1,
              p: 1,
              borderRadius: "6px",
              backgroundColor: "var(--bg-input, rgba(0,0,0,0.04))",
            }}
          >
            <Typography
              component="p"
              sx={{ ...smallTextSx, fontWeight: 600, mb: 0.5 }}
            >
              Read in this order
            </Typography>
            {current ? (
              <>
                <Typography
                  component="p"
                  sx={{ fontSize: "12px", color: "var(--text-main)" }}
                >
                  {current.order
                    .map((id) => `#${byId.get(id)?.bubbleReadingOrder ?? "?"}`)
                    .join(" → ")}
                </Typography>
                <Typography
                  component="p"
                  lang={chosen[0]?.detectedLanguage || undefined}
                  sx={{
                    fontSize: "13px",
                    color: "var(--text-main)",
                    my: 0.5,
                    wordBreak: "break-all",
                  }}
                >
                  {current.text}
                </Typography>
                <Typography
                  component="p"
                  sx={smallTextSx}
                >
                  The page numbers the picked pieces 1, 2, 3… in this order.
                  Japanese columns read right to left, each top to bottom;
                  horizontal lines read top to bottom.
                </Typography>
              </>
            ) : (
              <Typography
                component="p"
                sx={smallTextSx}
              >
                Working out the order…
              </Typography>
            )}
          </Box>
        )}
        <Box sx={{ display: "flex", gap: 1, mt: 1.25, alignItems: "center" }}>
          <Button
            variant="contained"
            size="small"
            disabled={busy || chosen.length < 2}
            onClick={onMerge}
            sx={{ textTransform: "none", boxShadow: "none" }}
          >
            {chosen.length >= 2 ? `Merge ${chosen.length} pieces` : "Merge"}
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
