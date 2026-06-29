import React, { useEffect, useRef } from 'react';

export interface InfoModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  type?: 'success' | 'error' | 'info';
  onClose: () => void;
}

const InfoModal: React.FC<InfoModalProps> = ({
  isOpen,
  title,
  message,
  type = 'info',
  onClose,
}) => {
  const okRef = useRef<HTMLButtonElement>(null);

  // Auto-focus OK button when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => okRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const iconColor =
    type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#818cf8';

  const iconBg =
    type === 'success'
      ? 'rgba(16,185,129,0.15)'
      : type === 'error'
      ? 'rgba(239,68,68,0.15)'
      : 'rgba(99,102,241,0.15)';

  const icon =
    type === 'success' ? (
      /* Checkmark */
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ) : type === 'error' ? (
      /* X circle */
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    ) : (
      /* Info */
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={iconColor} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    );

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0, 0, 0, 0.65)',
        animation: 'fadeIn 0.15s ease-out',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="glass"
        style={{
          padding: '28px 32px',
          minWidth: '360px',
          maxWidth: '480px',
          width: '90vw',
          animation: 'scaleIn 0.18s ease-out',
        }}
      >
        {/* Icon + Title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
          <div style={{
            width: '38px',
            height: '38px',
            borderRadius: '10px',
            background: iconBg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}>
            {icon}
          </div>
          <h3 style={{
            margin: 0,
            fontSize: '16px',
            fontWeight: 700,
            color: 'var(--text-main)',
            letterSpacing: '-0.01em',
          }}>
            {title}
          </h3>
        </div>

        {/* Message */}
        <p style={{
          margin: '0 0 24px 0',
          fontSize: '13.5px',
          lineHeight: '1.7',
          color: 'var(--text-muted)',
          paddingLeft: '50px',
        }}>
          {message}
        </p>

        {/* Single dismiss button */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            ref={okRef}
            onClick={onClose}
            style={{
              padding: '9px 24px',
              borderRadius: '8px',
              border: 'none',
              background:
                type === 'error'
                  ? 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)'
                  : type === 'success'
                  ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                  : 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
              color: '#fff',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'opacity 0.15s ease',
              boxShadow:
                type === 'error'
                  ? '0 4px 14px rgba(220,38,38,0.4)'
                  : type === 'success'
                  ? '0 4px 14px rgba(16,185,129,0.4)'
                  : '0 4px 14px rgba(99,102,241,0.4)',
              fontFamily: 'inherit',
            }}
            onMouseEnter={e => (e.currentTarget.style.opacity = '0.88')}
            onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
};

export default InfoModal;
