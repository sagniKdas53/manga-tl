import React, { useState, useEffect, ReactNode } from "react";
import { useSSE } from "../utils/useSSE";
import { getContextPath } from "../utils";
import { NotificationContext, type Notification } from "./useNotifications";

interface NotificationProviderProps {
  children: ReactNode;
  token: string | null;
}

export const NotificationProvider: React.FC<NotificationProviderProps> = ({
  children,
  token,
}) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  // Connect to SSE stream
  const contextPath = getContextPath();
  const { lastEvent } = useSSE(
    `${contextPath}/api/notifications/stream`,
    token,
  );

  useEffect(() => {
    if (!lastEvent) return;

    if (lastEvent.type === "notification") {
      try {
        const data = JSON.parse(lastEvent.data);
        const newNotification: Notification = {
          id: data.id,
          type: data.type,
          title: data.title,
          message: data.message,
          timestamp: data.timestamp,
          read: false,
          imageId: data.imageId,
        };

        // Defer state update to satisfy set-state-in-effect rule
        Promise.resolve().then(() => {
          setNotifications((prev) => {
            // Prevent duplicates
            if (prev.find((n) => n.id === newNotification.id)) return prev;
            return [newNotification, ...prev];
          });
        });
      } catch (e) {
        console.error("Failed to parse notification payload", e);
      }
    } else if (lastEvent.type === "connected") {
      console.log("SSE notification stream: Connection established.");
    } else if (lastEvent.type === "error") {
      console.error("SSE notification stream error:", lastEvent.data);
    }
  }, [lastEvent]);

  const markAsRead = (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
  };

  const markAllAsRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const clearAll = () => {
    setNotifications([]);
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount,
        markAsRead,
        markAllAsRead,
        clearAll,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
};
