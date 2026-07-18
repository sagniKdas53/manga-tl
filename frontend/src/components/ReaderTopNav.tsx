
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import IconButton from "@mui/material/IconButton";
import MenuOpenIcon from '@mui/icons-material/MenuOpen';

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
          <MenuOpenIcon fontSize="small" sx={{ transform: leftSidebarOpen ? "rotate(0deg)" : "rotate(180deg)" }} />
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
        title="Right Sidebar"
        onClick={onToggleRightSidebar}
      >
        <MenuOpenIcon fontSize="small" sx={{ transform: rightSidebarOpen ? "rotate(180deg)" : "rotate(0deg)" }} />
      </IconButton>
    </div>
  );
}
