import React, { useState } from "react";
import { useNotifications, type Notification } from "./useNotifications";
import { safeFetch } from "../utils";

import Popover from "@mui/material/Popover";
import Badge from "@mui/material/Badge";
import IconButton from "@mui/material/IconButton";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import ListItemIcon from "@mui/material/ListItemIcon";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";

import NotificationsIcon from "@mui/icons-material/Notifications";
import CircleIcon from "@mui/icons-material/Circle";
import DownloadIcon from "@mui/icons-material/Download";

export const NotificationCenter: React.FC = () => {
  const { notifications, unreadCount, markAsRead, markAllAsRead, clearAll } =
    useNotifications();

  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const open = Boolean(anchorEl);
  const id = open ? "notification-popover" : undefined;

  const getIconColor = (type: string) => {
    switch (type) {
      case "ERROR":
        return "error.main";
      case "WARNING":
        return "warning.main";
      case "INFO":
      default:
        return "info.main";
    }
  };

  return (
    <Box display="flex" alignItems="center">
      <IconButton
        aria-describedby={id}
        onClick={handleClick}
        color="inherit"
        title="Notifications"
      >
        <Badge badgeContent={unreadCount} color="error">
          <NotificationsIcon />
        </Badge>
      </IconButton>

      <Popover
        id={id}
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{
          vertical: "bottom",
          horizontal: "right",
        }}
        transformOrigin={{
          vertical: "top",
          horizontal: "right",
        }}
        slotProps={{
          paper: {
            sx: {
              width: 360,
              maxHeight: 500,
              display: "flex",
              flexDirection: "column",
            },
          },
        }}
      >
        <Box
          sx={{
            p: 2,
            borderBottom: 1,
            borderColor: "divider",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            bgcolor: "background.paper",
          }}
        >
          <Typography variant="h6" component="h3">
            Notifications
          </Typography>
          {notifications.length > 0 && (
            <Stack direction="row" spacing={1}>
              <Button size="small" onClick={markAllAsRead} color="inherit">
                Mark all read
              </Button>
              <Button size="small" onClick={clearAll} color="inherit">
                Clear
              </Button>
            </Stack>
          )}
        </Box>

        {notifications.length === 0 ? (
          <Box p={4} textAlign="center">
            <Typography color="text.secondary">No notifications</Typography>
          </Box>
        ) : (
          <List sx={{ p: 0, flex: 1, overflowY: "auto" }}>
            {notifications.map((n: Notification) => (
              <React.Fragment key={n.id}>
                <ListItem
                  disablePadding
                  sx={{
                    bgcolor: n.read ? "transparent" : "action.hover",
                  }}
                >
                  <ListItemButton
                    onClick={() => markAsRead(n.id)}
                    sx={{ alignItems: "flex-start", py: 1.5 }}
                  >
                    <ListItemIcon sx={{ minWidth: 36, mt: 0.5 }}>
                      <CircleIcon
                        sx={{ fontSize: 12, color: getIconColor(n.type) }}
                      />
                    </ListItemIcon>
                    <ListItemText
                      primary={
                        <Typography variant="subtitle2" fontWeight={600}>
                          {n.title}
                        </Typography>
                      }
                      secondary={
                        <Stack spacing={0.5} mt={0.5}>
                          <Typography variant="body2" color="text.secondary">
                            {n.message}
                          </Typography>
                          {n.context && (
                            <Typography
                              variant="caption"
                              color="primary.main"
                              fontWeight={500}
                            >
                              {[
                                n.context.seriesTitle,
                                n.context.chapterNumber
                                  ? `Ch.${n.context.chapterNumber}`
                                  : null,
                                n.context.pageNumber
                                  ? `Page ${n.context.pageNumber}`
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(" › ")}
                            </Typography>
                          )}
                          <Typography variant="caption" color="text.disabled">
                            {new Date(n.timestamp).toLocaleTimeString()}
                          </Typography>
                          {n.type === "EXPORT_SUCCESS" && n.context?.exportId && (
                            <Box mt={1}>
                              <Button
                                variant="contained"
                                size="small"
                                startIcon={<DownloadIcon />}
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  try {
                                    const storedUser =
                                      localStorage.getItem("manga_user");
                                    if (!storedUser) return;
                                    const user = JSON.parse(storedUser);
                                    const res = await safeFetch(
                                      `/api/series/chapters/exports/${n.context.exportId}/download`,
                                      {
                                        headers: {
                                          Authorization: `Bearer ${user.token}`,
                                        },
                                      }
                                    );
                                    if (res.ok) {
                                      const blob = await res.blob();
                                      const url = window.URL.createObjectURL(blob);
                                      const a = document.createElement("a");
                                      a.href = url;
                                      const seriesTitle =
                                        n.context.seriesTitle || "chapter";
                                      const chapterNumber =
                                        n.context.chapterNumber || "export";
                                      a.download = `${seriesTitle} - Chapter ${chapterNumber}.zip`;
                                      document.body.appendChild(a);
                                      a.click();
                                      document.body.removeChild(a);
                                      window.URL.revokeObjectURL(url);
                                    } else {
                                      console.error("Failed to download export");
                                    }
                                  } catch (err) {
                                    console.error("Error downloading export", err);
                                  }
                                }}
                              >
                                Download ZIP
                              </Button>
                            </Box>
                          )}
                        </Stack>
                      }
                    />
                  </ListItemButton>
                </ListItem>
                <Divider component="li" />
              </React.Fragment>
            ))}
          </List>
        )}
      </Popover>
    </Box>
  );
};
