import React from "react";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import SettingsIcon from "@mui/icons-material/Settings";
import IconButton from "@mui/material/IconButton";

interface ReaderTopNavProps {
  title: string;
  onBack: () => void;
  onToggleLeftSidebar: () => void;
  onToggleRightSidebar: () => void;
  leftSidebarOpen?: boolean;
  rightSidebarOpen?: boolean;
}

export default function ReaderTopNav({
  title,
  onBack,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  leftSidebarOpen,
  rightSidebarOpen,
}: ReaderTopNavProps) {
  return (
    <div
      className="reader-navbar-nhentai"
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <IconButton
          className="reader-nav-btn back-btn"
          size="small"
          title="Back"
          onClick={onBack}
        >
          <ArrowBackIcon fontSize="small" />
        </IconButton>

        <IconButton
          className={`reader-nav-btn gear-btn ${leftSidebarOpen ? "active" : ""}`}
          size="small"
          title="Settings"
          onClick={onToggleLeftSidebar}
        >
          <SettingsIcon fontSize="small" />
        </IconButton>
      </div>

      <div
        style={{
          fontWeight: 600,
          fontSize: "14px",
          fontFamily: "var(--font-display)",
          color: "var(--text-main)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: "50%",
        }}
      >
        {title}
      </div>

      <IconButton
        className={`reader-nav-btn gear-btn ${rightSidebarOpen ? "active" : ""}`}
        size="small"
        title="Settings"
        onClick={onToggleRightSidebar}
      >
        <SettingsIcon fontSize="small" />
      </IconButton>
    </div>
  );
}
