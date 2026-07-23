import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import IconButton from "@mui/material/IconButton";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import MenuOpenIcon from "@mui/icons-material/MenuOpen";

interface ReaderTopNavProps {
  title: string;
  /**
   * Optional structured breadcrumb, e.g. ["No Overrides", "Ch. 1", "Page 2"].
   * When provided, renders with differentiated weight per segment instead of
   * the flat title string. Falls back to `title` if omitted.
   */
  segments?: string[];
  onBack: () => void;
  onToggleLeftSidebar: () => void;
  onToggleRightSidebar: () => void;
  leftSidebarOpen?: boolean;
  rightSidebarOpen?: boolean;
}

const navButtonSx = (active?: boolean) => ({
  color: active ? "var(--primary)" : "var(--text-muted)",
  backgroundColor: active ? "var(--primary-glow)" : "transparent",
  transition: "background-color 0.15s ease, color 0.15s ease",
  "&:hover": {
    backgroundColor: active
      ? "var(--primary-glow)"
      : "var(--bg-input, rgba(0,0,0,0.05))",
    color: "var(--primary)",
  },
});

export default function ReaderTopNav({
  title,
  segments,
  onBack,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  leftSidebarOpen,
  rightSidebarOpen,
}: ReaderTopNavProps) {
  return (
    <Box
      className="reader-navbar-nhentai"
      sx={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 2,
        px: 2,
        py: 1,
        backgroundColor: "var(--bg-surface, transparent)",
        borderBottom: "1px solid var(--border-color)",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.5,
          flex: "0 0 auto",
        }}
      >
        <Tooltip title="Back">
          <IconButton
            size="small"
            onClick={onBack}
            sx={navButtonSx()}
          >
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        </Tooltip>

        <Tooltip title={leftSidebarOpen ? "Hide Settings" : "Show Settings"}>
          <IconButton
            size="small"
            onClick={onToggleLeftSidebar}
            sx={navButtonSx(leftSidebarOpen)}
          >
            <MenuOpenIcon
              fontSize="small"
              sx={{
                transition: "transform 0.2s ease",
                transform: leftSidebarOpen ? "rotate(0deg)" : "rotate(180deg)",
              }}
            />
          </IconButton>
        </Tooltip>
      </Box>

      <Box
        sx={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "center",
          gap: 0.5,
          minWidth: 0,
          maxWidth: "55%",
          fontFamily: "var(--font-display, inherit)",
        }}
      >
        {segments && segments.length > 0 ? (
          segments.map((segment, i) => {
            const isLast = i === segments.length - 1;
            return (
              <Box
                key={i}
                sx={{
                  display: "flex",
                  alignItems: "baseline",
                  minWidth: 0,
                  gap: 0.5,
                }}
              >
                {i > 0 && (
                  <ChevronRightIcon
                    sx={{
                      fontSize: 13,
                      color: "var(--text-dim, var(--text-muted))",
                      flexShrink: 0,
                    }}
                  />
                )}
                <Box
                  component="span"
                  sx={{
                    fontSize: isLast ? "14px" : "13px",
                    fontWeight: isLast ? 700 : 500,
                    color: isLast ? "var(--text-main)" : "var(--text-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {segment}
                </Box>
              </Box>
            );
          })
        ) : (
          <Box
            component="span"
            sx={{
              fontWeight: 600,
              fontSize: "14px",
              color: "var(--text-main)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </Box>
        )}
      </Box>

      <Box sx={{ flex: "0 0 auto" }}>
        <Tooltip title={rightSidebarOpen ? "Hide Inspector" : "Show Inspector"}>
          <IconButton
            size="small"
            onClick={onToggleRightSidebar}
            sx={navButtonSx(rightSidebarOpen)}
          >
            <MenuOpenIcon
              fontSize="small"
              sx={{
                transition: "transform 0.2s ease",
                transform: rightSidebarOpen ? "rotate(180deg)" : "rotate(0deg)",
              }}
            />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}
