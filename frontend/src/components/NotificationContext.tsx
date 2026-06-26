import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useSSE } from '../utils/useSSE';

export interface Notification {
  id: string;
  type: 'INFO' | 'WARNING' | 'ERROR';
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
  imageId?: string;
}

interface NotificationContextType {
  notifications: Notification[];
  unreadCount: number;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  clearAll: () => void;
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

interface NotificationProviderProps {
  children: ReactNode;
  token: string | null;
}

export const NotificationProvider: React.FC<NotificationProviderProps> = ({ children, token }) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  
  // Connect to SSE stream
  const { lastEvent } = useSSE('/api/notifications/stream', token);

  useEffect(() => {
    if (!lastEvent) return;

    if (lastEvent.type === 'notification') {
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
        
        setNotifications((prev) => {
          // Prevent duplicates
          if (prev.find(n => n.id === newNotification.id)) return prev;
          return [newNotification, ...prev];
        });
      } catch (e) {
        console.error('Failed to parse notification payload', e);
      }
    } else if (lastEvent.type === 'connected') {
      console.log('SSE notification stream: Connection established.');
    } else if (lastEvent.type === 'error') {
      console.error('SSE notification stream error:', lastEvent.data);
    }
  }, [lastEvent]);

  const markAsRead = (id: string) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
  };

  const markAllAsRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  };

  const clearAll = () => {
    setNotifications([]);
  };

  const unreadCount = notifications.filter(n => !n.read).length;

  return (
    <NotificationContext.Provider value={{ notifications, unreadCount, markAsRead, markAllAsRead, clearAll }}>
      {children}
    </NotificationContext.Provider>
  );
};

export const useNotifications = () => {
  const context = useContext(NotificationContext);
  if (context === undefined) {
    throw new Error('useNotifications must be used within a NotificationProvider');
  }
  return context;
};
