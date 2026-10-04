import React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Tooltip from "@mui/material/Tooltip";
import LazyImage from "./LazyImage";

/**
 * Shared pieces of the series and chapter headers (UI overhaul, #214).
 *
 * The old headers put a caption above every value and a coloured chip under it, so a header was
 * a wall of "Context Injection / [Enabled]" pairs. These read like a colophon instead: the label
 * sits to the left of its value, and a value's state is said in words.
 */

export interface MetaRow {
  label: string;
  value: React.ReactNode;
  /** Hidden rows keep the call sites declarative (`hidden: !usesOpenRouter`). */
  hidden?: boolean;
}

export const MetaRows: React.FC<{ rows: MetaRow[] }> = ({ rows }) => (
  <Box
    component="dl"
    sx={{
      display: "grid",
      gridTemplateColumns: { xs: "112px 1fr", sm: "136px 1fr" },
      columnGap: 2,
      rowGap: 0.75,
      m: 0,
      alignItems: "baseline",
    }}
  >
    {rows
      .filter((row) => !row.hidden)
      .map((row) => (
        <React.Fragment key={row.label}>
          <Typography
            component="dt"
            variant="body2"
            sx={{ color: "text.secondary" }}
          >
            {row.label}
          </Typography>
          <Box
            component="dd"
            sx={{ m: 0, minWidth: 0, fontSize: "0.875rem" }}
          >
            {row.value}
          </Box>
        </React.Fragment>
      ))}
  </Box>
);

/** A value plus where it came from, when it was not set at this level. */
export const Inherited: React.FC<{
  value: React.ReactNode;
  from?: string | null;
}> = ({ value, from }) => (
  <>
    {value}
    {from && (
      <Typography
        component="span"
        variant="body2"
        sx={{ color: "text.secondary", ml: 0.75 }}
      >
        from {from}
      </Typography>
    )}
  </>
);

/**
 * One model, as a neutral pill: what it does, its name, its provider, and where the value comes
 * from. Settings are looked up chapter first, then series, then system settings; the last part
 * of the pill names the level that answered ("set here", "from series", "from settings").
 */
export type SettingSource = "chapter" | "series" | "global";

export const ModelPill: React.FC<{
  role: string;
  model: string;
  provider?: string | null;
  source: SettingSource;
  /** The level this header shows. */
  level: "chapter" | "series";
  disabled?: boolean;
}> = ({ role, model, provider, source, level, disabled = false }) => {
  const setHere = source === level;
  const origin = setHere
    ? "set here"
    : source === "series"
      ? "from series"
      : "from settings";
  const chain =
    level === "chapter"
      ? "Looked up on the chapter, then the series, then system settings."
      : "Looked up on the series, then system settings.";
  const answer = setHere
    ? `Set on this ${level}.`
    : source === "series"
      ? "Not set on the chapter, so the series' value is used."
      : `Not set on the ${level === "chapter" ? "chapter or series" : "series"}, so the system setting is used.`;
  return (
    <Tooltip
      title={`${answer} ${chain}${disabled ? " Not used in the current QA mode." : ""}`}
    >
      <Box
        component="span"
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.75,
          maxWidth: "100%",
          px: 1,
          py: 0.25,
          borderRadius: "4px",
          bgcolor: "var(--bg-chip)",
          fontSize: "0.8125rem",
          opacity: disabled ? 0.55 : 1,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        <Box
          component="span"
          sx={{ color: "text.secondary" }}
        >
          {role}
        </Box>
        <Box
          component="span"
          sx={{ overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {model}
        </Box>
        {provider && (
          <Box
            component="span"
            sx={{ color: "text.secondary" }}
          >
            {provider}
          </Box>
        )}
        <Box
          component="span"
          sx={{
            pl: 0.75,
            borderLeft: 1,
            borderColor: "divider",
            color: setHere ? "primary.main" : "text.secondary",
            fontWeight: setHere ? 600 : 400,
          }}
        >
          {origin}
        </Box>
      </Box>
    </Tooltip>
  );
};

export const PillRow: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>{children}</Box>
);

/** Cover on the left, details on the right; stacks on a phone. */
export const HeaderShell: React.FC<{
  coverUrl?: string | null;
  coverAlt: string;
  coverFallback: string;
  children: React.ReactNode;
}> = ({ coverUrl, coverAlt, coverFallback, children }) => (
  <Box
    sx={{
      bgcolor: "background.paper",
      borderRadius: "10px",
      p: { xs: 2, sm: 3 },
      display: "grid",
      gridTemplateColumns: { xs: "1fr", sm: "176px 1fr" },
      gap: { xs: 2, sm: 3 },
      alignItems: "start",
    }}
  >
    <Box
      sx={{
        width: { xs: 140, sm: "100%" },
        aspectRatio: "2 / 3",
        borderRadius: "4px",
        overflow: "hidden",
        bgcolor: "background.default",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {coverUrl ? (
        <LazyImage
          src={coverUrl}
          alt={coverAlt}
          sx={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <Typography
          variant="body2"
          sx={{ color: "text.secondary", p: 2, textAlign: "center" }}
        >
          {coverFallback}
        </Typography>
      )}
    </Box>
    <Box sx={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
      {children}
    </Box>
  </Box>
);
