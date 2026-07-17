import React, { useState, useRef, useCallback, useMemo, type ReactNode } from "react";
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

  const subscribersRef = useRef<((event: SSEEvent) => void)[]>([]);

  const subscribe = useCallback((cb: (event: SSEEvent) => void) => {
    subscribersRef.current.push(cb);
    return () => {
      subscribersRef.current = subscribersRef.current.filter((x) => x !== cb);
    };
  }, []);

  // Connect to SSE stream
  const contextPath = getContextPath();
  useSSE(`${contextPath}/api/notifications/stream`, token, (event) => {
    // Notify all subscribers
    subscribersRef.current.forEach((cb) => cb(event));

    if (event.type === "notification") {
      try {
        const data = JSON.parse(event.data);
        const newNotification: Notification = {
          id: data.id,
          type: data.type,
          title: data.title,
          message: data.message,
          timestamp: data.timestamp,
          read: false,
          imageId: data.imageId,
          context: data.context,
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
    } else if (event.type === "connected") {
      console.log("SSE notification stream: Connection established.");
    } else if (event.type === "error") {
      console.error("SSE notification stream error:", event.data);
    }
  });

  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
  }, []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const value = useMemo(
    () => ({
      notifications,
      unreadCount,
      markAsRead,
      markAllAsRead,
      clearAll,
      subscribe,
    }),
    [notifications, unreadCount, markAsRead, markAllAsRead, clearAll, subscribe],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
};
