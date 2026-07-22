import React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

interface SidebarSectionProps {
  title?: string;
  children: React.ReactNode;
  sx?: object;
  headerExtra?: React.ReactNode;
}

const SidebarSection: React.FC<SidebarSectionProps> = ({ title, children, sx, headerExtra }) => (
  <Box
    sx={{
      border: "1px solid var(--border-color)",
      borderRadius: "10px",
      p: 1.5,
      mb: 2,
      backgroundColor: "var(--bg-surface, transparent)",
      ...sx,
    }}
  >
    {title && (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          mb: 1.25,
        }}
      >
        <Typography
          variant="overline"
          component="div"
          sx={{
            fontSize: "10.5px",
            fontWeight: 700,
            letterSpacing: "0.08em",
            color: "var(--text-dim, var(--text-muted))",
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
