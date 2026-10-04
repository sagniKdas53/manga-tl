import React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

interface SidebarSectionProps {
  title?: string;
  children: React.ReactNode;
  sx?: object;
  headerExtra?: React.ReactNode;
}

/**
 * One group of controls in a Reader sidebar.
 *
 * Groups used to be bordered cards with an all-caps overline each, so a sidebar was a stack of
 * boxes inside a box and a third of its height was frame (reader review, 2026-10-04). Now a group
 * is its controls under a plain sentence-case label, with one hairline between groups.
 */
const SidebarSection: React.FC<SidebarSectionProps> = ({
  title,
  children,
  sx,
  headerExtra,
}) => (
  <Box
    component="section"
    aria-label={title}
    className="sidebar-section"
    sx={{
      py: 1.75,
      borderTop: "1px solid var(--border-color)",
      "&:first-of-type": { borderTop: "none", pt: 0.5 },
      ...sx,
    }}
  >
    {title && (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1,
          minHeight: 28,
          mb: 0.75,
        }}
      >
        <Typography
          component="h3"
          sx={{
            m: 0,
            fontSize: "12.5px",
            fontWeight: 600,
            color: "var(--text-muted)",
          }}
        >
          {title}
        </Typography>
        {headerExtra}
      </Box>
    )}
    {children}
  </Box>
);

export default SidebarSection;
