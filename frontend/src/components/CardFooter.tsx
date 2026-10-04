import React from "react";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";

/**
 * The bottom row of a library or chapter card: what the item is on the left, what you can do
 * with it on the right. Both sets are always visible, so a tablet needs no hover to reach them.
 */

export interface CardInfo {
  key: string;
  icon: React.ReactElement;
  /** Short text beside the icon; omit for an icon-only flag. */
  text?: React.ReactNode;
  /** Spelled out on hover and for screen readers. */
  label: string;
}

export interface CardAction {
  title: string;
  icon: React.ReactElement;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
}

const CardFooter: React.FC<{ info: CardInfo[]; actions: CardAction[] }> = ({
  info,
  actions,
}) => (
  <Box
    sx={{
      display: "flex",
      alignItems: "center",
      gap: 1,
      px: 1,
      pb: 0.75,
      pt: 0.25,
      minHeight: 34,
    }}
  >
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.25,
        flex: 1,
        minWidth: 0,
        overflow: "hidden",
        color: "text.secondary",
        fontSize: "0.75rem",
      }}
    >
      {info.map((item) => (
        <Tooltip
          key={item.key}
          title={item.label}
        >
          <Box
            component="span"
            aria-label={item.label}
            sx={{
              display: "inline-flex",
              alignItems: "center",
              gap: 0.4,
              whiteSpace: "nowrap",
              "& svg": { fontSize: 15 },
            }}
          >
            {item.icon}
            {item.text}
          </Box>
        </Tooltip>
      ))}
    </Box>
    <Box sx={{ display: "flex", flexShrink: 0 }}>
      {actions.map((action) => (
        <IconButton
          key={action.title}
          size="small"
          aria-label={action.title}
          title={action.title}
          onClick={action.onClick}
          onKeyDown={(e) => e.stopPropagation()}
          sx={{
            width: 28,
            height: 28,
            color: "text.secondary",
            "& svg": { fontSize: 17 },
            "&:hover": {
              color: action.danger ? "error.main" : "text.primary",
            },
          }}
        >
          {action.icon}
        </IconButton>
      ))}
    </Box>
  </Box>
);

export default CardFooter;
