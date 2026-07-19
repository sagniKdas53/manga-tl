import { createContext, useContext } from "react";

export type SSEEvent = {
  type: string;
  data: string;
};

export interface Notification {
  id: string;
  type: "INFO" | "WARNING" | "ERROR" | "EXPORT_SUCCESS";
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
  imageId?: string;
  context?: {
    seriesTitle?: string;
    chapterNumber?: string;
    chapterTitle?: string;
    pageNumber?: string;
    exportId?: string;
  };
}

export interface NotificationContextType {
  notifications: Notification[];
  unreadCount: number;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  clearAll: () => void;
  subscribe: (callback: (event: SSEEvent) => void) => () => void;
}

export const NotificationContext = createContext<
  NotificationContextType | undefined
>(undefined);

export const useNotifications = () => {
  const context = useContext(NotificationContext);
  if (context === undefined) {
    throw new Error(
      "useNotifications must be used within a NotificationProvider",
    );
  }
  return context;
};
