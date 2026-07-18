import React from "react";
import { useNavigate } from "react-router-dom";
import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import SettingsIcon from "@mui/icons-material/Settings";
import LogoutIcon from "@mui/icons-material/Logout";
import PersonIcon from "@mui/icons-material/Person";

import { useColorMode } from "../hooks/useColorMode";
import type { User } from "../types";
import { NotificationCenter } from "./NotificationCenter";
import { QueueManager } from "./QueueManager";
import logoDark from "../assets/logo-dark.svg";
import logoLight from "../assets/logo-light.svg";

interface NavBarProps {
  user: User | null;
  activeDrawer: "none" | "queue" | "notifications";
  setActiveDrawer: React.Dispatch<React.SetStateAction<"none" | "queue" | "notifications">>;
  setIsSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsUserModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  handleLogout: () => void;
}

export const NavBar: React.FC<NavBarProps> = ({
  user,
  activeDrawer,
  setActiveDrawer,
  setIsSettingsOpen,
  setIsUserModalOpen,
  handleLogout,
}) => {
  const navigate = useNavigate();
  const { mode, toggleMode } = useColorMode();

  return (
    <AppBar
      position="sticky"
      color="inherit"
      sx={{ bgcolor: "background.paper", color: "text.primary" }}
    >
      <Toolbar variant="dense">
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            cursor: user ? "pointer" : "default",
            flexGrow: 1,
          }}
          onClick={() => user && navigate("/")}
        >
          <Box
            component="img"
            src={(mode === "dark" ? logoDark : logoLight) as string}
            alt="tl-hub"
            sx={{ height: 28, width: "auto" }}
          />
          <Typography
            variant="h6"
            sx={{
              fontFamily: '"Outfit", sans-serif',
              fontWeight: 700,
              color: "text.primary",
            }}
          >
            tl-hub
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <IconButton
            onClick={toggleMode}
            color="inherit"
            title={`Switch to ${mode === "dark" ? "Light" : "Dark"} Mode`}
          >
            {mode === "dark" ? <LightModeIcon /> : <DarkModeIcon />}
          </IconButton>
          {user && (
            <>
              <IconButton
                onClick={() => setIsSettingsOpen(true)}
                color="inherit"
                title="Settings"
              >
                <SettingsIcon />
              </IconButton>
              <QueueManager
                token={user?.token || null}
                forceOpen={activeDrawer === "queue"}
                onRequestOpen={() => setActiveDrawer("queue")}
                onClose={() => setActiveDrawer("none")}
              />
              <NotificationCenter
                forceOpen={activeDrawer === "notifications"}
                onRequestOpen={() => setActiveDrawer("notifications")}
                onClose={() => setActiveDrawer("none")}
              />
              <IconButton
                onClick={() => setIsUserModalOpen(true)}
                size="small"
                color="inherit"
                sx={{ minWidth: "auto" }}
                title="Account"
              >
                <PersonIcon />
              </IconButton>
              <IconButton
                onClick={handleLogout}
                size="small"
                color="inherit"
                sx={{ minWidth: "auto" }}
                title="Sign Out"
              >
                <LogoutIcon />
              </IconButton>
            </>
          )}
        </Stack>
      </Toolbar>
    </AppBar>
  );
};
