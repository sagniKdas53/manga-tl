import React, { useState } from "react";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import NotificationsIcon from "@mui/icons-material/Notifications";
import DoneAllIcon from "@mui/icons-material/DoneAll";
import ClearAllIcon from "@mui/icons-material/ClearAll";
import CloseIcon from "@mui/icons-material/Close";
import { useNotifications, type Notification } from "./useNotifications";
import { safeFetch } from "../utils";
import ConfirmModal from "./ConfirmModal";

const severityColor: Record<string, string> = {
  EXPORT_SUCCESS: "#4caf50",
  SUCCESS: "#4caf50",
  ERROR: "#f44336",
  WARNING: "#ff9800",
  INFO: "#2196f3",
};

interface Props {
  mode: "light" | "dark";
  forceOpen: boolean;
  onRequestOpen: () => void;
  onClose: () => void;
}

export const NotificationCenter: React.FC<Props> = ({
  mode,
  forceOpen,
  onRequestOpen,
  onClose,
}) => {
  const { notifications, unreadCount, markAsRead, markAllAsRead, clearAll } =
    useNotifications();

  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    isDangerous: boolean;
    action: () => void;
  }>({
    isOpen: false,
    title: "",
    message: "",
    isDangerous: false,
    action: () => {},
  });

  const handleClearAll = () => {
    setConfirmModal({
      isOpen: true,
      title: "Clear All Notifications",
      message:
        "Are you sure you want to clear all notifications? This cannot be undone.",
      isDangerous: true,
      action: () => {
        setConfirmModal((prev) => ({ ...prev, isOpen: false }));
        clearAll();
      },
    });
  };

  const handleDownload = async (
    exportId: string,
    seriesTitle?: string,
    chapterNumber?: string,
  ) => {
    try {
      const storedUser = localStorage.getItem("manga_user");
      if (!storedUser) return;
      const user = JSON.parse(storedUser);
      const res = await safeFetch(
        `/api/series/chapters/exports/${exportId}/download`,
        {
          headers: { Authorization: `Bearer ${user.token}` },
        },
      );
      if (res.ok) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${seriesTitle || "chapter"} - Chapter ${chapterNumber || "export"}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error("Error downloading export", err);
    }
  };

  const formatTime = (timestamp: number) => {
    const d = new Date(timestamp);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    if (isToday) return d.toLocaleTimeString();
    return d.toLocaleDateString() + " " + d.toLocaleTimeString();
  };

  return (
    <>
      <Badge
        badgeContent={unreadCount}
        color="primary"
        invisible={unreadCount === 0}
      >
        <IconButton
          onClick={onRequestOpen}
          color="inherit"
          size="small"
          title="Notifications"
        >
          <NotificationsIcon
            sx={{ color: mode === "dark" ? "white" : "black" }}
          />
        </IconButton>
      </Badge>

      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        isDangerous={confirmModal.isDangerous}
        onConfirm={confirmModal.action}
        onCancel={() => setConfirmModal((prev) => ({ ...prev, isOpen: false }))}
      />

      <Drawer
        anchor="right"
        open={forceOpen}
        onClose={onClose}
                slotProps={{ paper: { sx: { width: 520 } } }}
      >
        <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Box
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              px: 2,
              py: 1,
              borderBottom: 1,
              borderColor: "divider",
            }}
          >
            <Typography
              variant="h6"
              sx={{ fontSize: "16px", fontWeight: 600 }}
            >
              Notifications
            </Typography>
            <Box sx={{ display: "flex", gap: 1 }}>
              <Tooltip title="Mark All Read">
                <IconButton
                  size="small"
                  onClick={markAllAsRead}
                >
                  <DoneAllIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Clear All">
                <IconButton
                  size="small"
                  onClick={handleClearAll}
                >
                  <ClearAllIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Close">
                <IconButton
                  size="small"
                  onClick={onClose}
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>

          {notifications.length === 0 ? (
            <Box
              sx={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "text.secondary",
              }}
            >
              No notifications
            </Box>
          ) : (
            <Table
              size="small"
              stickyHeader
            >
              <TableHead>
                <TableRow>
                  <TableCell sx={{ px: 2 }}>Notification</TableCell>
                  <TableCell
                    sx={{ px: 2 }}
                    align="right"
                  >
                    Time
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {notifications.map((n: Notification) => {
                  const color = severityColor[n.type] || "#2196f3";
                  return (
                    <TableRow
                      key={n.id}
                      onClick={() => markAsRead(n.id)}
                      sx={{
                        cursor: "pointer",
                        bgcolor: n.read ? "transparent" : "action.hover",
                        "&:last-child td, &:last-child th": {
                          borderBottom: 0,
                        },
                      }}
                    >
                      <TableCell sx={{ px: 2 }}>
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: 1.5,
                          }}
                        >
                          <Box
                            sx={{
                              width: 10,
                              height: 10,
                              borderRadius: "50%",
                              backgroundColor: color,
                              boxShadow: n.read ? "none" : `0 0 6px ${color}66`,
                              flexShrink: 0,
                              mt: 0.6,
                            }}
                          />
                          <Box>
                            <Typography
                              variant="body2"
                              sx={{ fontWeight: 600, fontSize: "13px" }}
                            >
                              {n.title}
                            </Typography>
                            <Typography
                              variant="caption"
                              sx={{
                                display: "block",
                                color: "text.secondary",
                                fontSize: "12px",
                              }}
                            >
                              {n.message}
                            </Typography>
                            {n.context && (
                              <Typography
                                variant="caption"
                                sx={{
                                  display: "block",
                                  color: "primary.main",
                                  opacity: 0.8,
                                  fontSize: "10px",
                                  mt: 0.25,
                                }}
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
                            {n.type === "EXPORT_SUCCESS" &&
                              n.context?.exportId && (
                                <Box sx={{ mt: 1 }}>
                                  <Button
                                    size="small"
                                    variant="outlined"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDownload(
                                        n.context!.exportId!,
                                        n.context?.seriesTitle,
                                        n.context?.chapterNumber,
                                      );
                                    }}
                                  >
                                    Download ZIP
                                  </Button>
                                </Box>
                              )}
                          </Box>
                        </Box>
                      </TableCell>
                      <TableCell
                        sx={{ px: 2 }}
                        align="right"
                      >
                        <Typography
                          variant="caption"
                          sx={{
                            color: "text.disabled",
                            fontSize: "11px",
                          }}
                        >
                          {formatTime(n.timestamp)}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Box>
      </Drawer>
    </>
  );
};
