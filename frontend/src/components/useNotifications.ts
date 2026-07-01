import { createContext, useContext } from "react";

export interface Notification {
  id: string;
  type: "INFO" | "WARNING" | "ERROR";
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
  imageId?: string;
}

export interface NotificationContextType {
  notifications: Notification[];
  unreadCount: number;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  clearAll: () => void;
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
