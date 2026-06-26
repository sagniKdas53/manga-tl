import React, { useState, useRef, useEffect } from 'react';
import { useNotifications, type Notification } from './NotificationContext';

export const NotificationCenter: React.FC = () => {
  const { notifications, unreadCount, markAsRead, markAllAsRead, clearAll } = useNotifications();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleDropdown = () => setIsOpen(!isOpen);

  const getIconColor = (type: string) => {
    switch (type) {
      case 'ERROR': return '#f44336';
      case 'WARNING': return '#ff9800';
      case 'INFO':
      default: return '#2196f3';
    }
  };

  return (
    <div className="notification-center" ref={dropdownRef} style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <button 
        className="theme-toggle-btn" 
        onClick={toggleDropdown}
        style={{ position: 'relative' }}
        title="Notifications"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
        </svg>
        {unreadCount > 0 && (
          <span style={{
            position: 'absolute',
            top: 2,
            right: 2,
            backgroundColor: 'var(--primary, #ed2553)',
            color: 'white',
            borderRadius: '50%',
            width: '14px',
            height: '14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '9px',
            fontWeight: 'bold',
            lineHeight: 1
          }}>
            {unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="glass" style={{
          position: 'absolute',
          top: '100%',
          right: 0,
          marginTop: '12px',
          width: '320px',
          maxHeight: '400px',
          overflowY: 'auto',
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          color: 'var(--text-main)'
        }}>
          <div style={{ padding: '12px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: '16px', color: 'var(--text-main)' }}>Notifications</h3>
            {notifications.length > 0 && (
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={markAllAsRead} style={{ fontSize: '12px', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>Mark all read</button>
                <button onClick={clearAll} style={{ fontSize: '12px', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>Clear</button>
              </div>
            )}
          </div>
          
          {notifications.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
              No notifications
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {notifications.map((n: Notification) => (
                <li 
                  key={n.id} 
                  onClick={() => markAsRead(n.id)}
                  style={{ 
                    padding: '12px', 
                    borderBottom: '1px solid var(--border-color)',
                    backgroundColor: n.read ? 'transparent' : 'var(--bg-hover)',
                    cursor: 'pointer',
                    display: 'flex',
                    gap: '12px',
                    alignItems: 'flex-start'
                  }}
                >
                  <div style={{ 
                    width: '8px', 
                    height: '8px', 
                    borderRadius: '50%', 
                    backgroundColor: getIconColor(n.type),
                    marginTop: '6px'
                  }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '14px', marginBottom: '4px', color: 'var(--text-main)' }}>{n.title}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>{n.message}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-dim)' }}>{new Date(n.timestamp).toLocaleTimeString()}</div>
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
