import React, { useState, useRef, useEffect } from "react";
import Badge from "@mui/material/Badge";
import IconButton from "@mui/material/IconButton";
import NotificationsIcon from "@mui/icons-material/Notifications";
import { useNotifications, type Notification } from "./useNotifications";
import { safeFetch } from "../utils";

export const NotificationCenter: React.FC = () => {
  const { notifications, unreadCount, markAsRead, markAllAsRead, clearAll } =
    useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const toggleDropdown = () => setIsOpen(!isOpen);

  const getIconColor = (type: string) => {
    switch (type) {
      case "ERROR":
        return "#f44336";
      case "WARNING":
        return "#ff9800";
      case "INFO":
      default:
        return "#2196f3";
    }
  };

  return (
    <div
      className="notification-center"
      ref={dropdownRef}
      style={{ position: "relative", display: "flex", alignItems: "center" }}
    >
      <Badge badgeContent={unreadCount} color="primary" invisible={unreadCount === 0}>
        <IconButton onClick={toggleDropdown} color="inherit" size="small" title="Notifications">
          <NotificationsIcon fontSize="small" />
        </IconButton>
      </Badge>

      {isOpen && (
        <div
          className="glass"
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: "12px",
            width: "320px",
            maxHeight: "400px",
            overflowY: "auto",
            zIndex: 1000,
            display: "flex",
            flexDirection: "column",
            color: "var(--text-main)",
          }}
        >
          <div
            style={{
              padding: "12px",
              borderBottom: "1px solid var(--border-color)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <h3
              style={{ margin: 0, fontSize: "16px", color: "var(--text-main)" }}
            >
              Notifications
            </h3>
            {notifications.length > 0 && (
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  onClick={markAllAsRead}
                  style={{
                    fontSize: "12px",
                    background: "none",
                    border: "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                  }}
                >
                  Mark all read
                </button>
                <button
                  onClick={clearAll}
                  style={{
                    fontSize: "12px",
                    background: "none",
                    border: "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                  }}
                >
                  Clear
                </button>
              </div>
            )}
          </div>

          {notifications.length === 0 ? (
            <div
              style={{
                padding: "24px",
                textAlign: "center",
                color: "var(--text-muted)",
              }}
            >
              No notifications
            </div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {notifications.map((n: Notification) => (
                <li
                  key={n.id}
                  onClick={() => markAsRead(n.id)}
                  style={{
                    padding: "12px",
                    borderBottom: "1px solid var(--border-color)",
                    backgroundColor: n.read ? "transparent" : "var(--bg-hover)",
                    cursor: "pointer",
                    display: "flex",
                    gap: "12px",
                    alignItems: "flex-start",
                  }}
                >
                  <div
                    style={{
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      backgroundColor: getIconColor(n.type),
                      marginTop: "6px",
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        fontWeight: "bold",
                        fontSize: "14px",
                        marginBottom: "4px",
                        color: "var(--text-main)",
                      }}
                    >
                      {n.title}
                    </div>
                    <div
                      style={{
                        fontSize: "12px",
                        color: "var(--text-muted)",
                        marginBottom: "4px",
                      }}
                    >
                      {n.message}
                    </div>
                    {n.context && (
                      <div
                        style={{
                          fontSize: "10px",
                          color: "var(--primary, var(--text-muted))",
                          opacity: 0.8,
                          marginBottom: "4px",
                          fontWeight: "500",
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
                      </div>
                    )}
                    <div style={{ fontSize: "10px", color: "var(--text-dim)" }}>
                      {new Date(n.timestamp).toLocaleTimeString()}
                    </div>
                    {n.type === "EXPORT_SUCCESS" && n.context?.exportId && (
                      <div style={{ marginTop: "8px" }}>
                        <button
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
                                },
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
                          className="btn btn-primary"
                          style={{ fontSize: "12px", padding: "4px 12px" }}
                        >
                          Download ZIP
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
