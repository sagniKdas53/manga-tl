import React, { useEffect, useRef } from "react";

export interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isDangerous?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  isDangerous = false,
  onConfirm,
  onCancel,
}) => {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Auto-focus cancel button when opened (safer default)
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => cancelRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "rgba(0, 0, 0, 0.65)",
        animation: "fadeIn 0.15s ease-out",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass"
        style={{
          padding: "28px 32px",
          minWidth: "360px",
          maxWidth: "480px",
          width: "90vw",
          animation: "scaleIn 0.18s ease-out",
        }}
      >
        {/* Icon */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            marginBottom: "14px",
          }}
        >
          <div
            style={{
              width: "38px",
              height: "38px",
              borderRadius: "10px",
              background: isDangerous
                ? "rgba(239, 68, 68, 0.15)"
                : "var(--bg-hover)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            {isDangerous ? (
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#ef4444"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                <line
                  x1="12"
                  y1="9"
                  x2="12"
                  y2="13"
                />
                <line
                  x1="12"
                  y1="17"
                  x2="12.01"
                  y2="17"
                />
              </svg>
            ) : (
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#818cf8"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                />
                <line
                  x1="12"
                  y1="8"
                  x2="12"
                  y2="12"
                />
                <line
                  x1="12"
                  y1="16"
                  x2="12.01"
                  y2="16"
                />
              </svg>
            )}
          </div>
          <h3
            style={{
              margin: 0,
              fontSize: "16px",
              fontWeight: 700,
              color: isDangerous ? "#f87171" : "var(--text-main)",
              letterSpacing: "-0.01em",
            }}
          >
            {title}
          </h3>
        </div>

        {/* Message */}
        <p
          style={{
            margin: "0 0 24px 0",
            fontSize: "13.5px",
            lineHeight: "1.7",
            color: "var(--text-muted)",
            paddingLeft: "50px",
          }}
        >
          {message}
        </p>

        {/* Actions */}
        <div
          style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}
        >
          <button
            ref={cancelRef}
            onClick={onCancel}
            style={{
              padding: "9px 18px",
              borderRadius: "8px",
              border: "1px solid var(--border-color)",
              background: "var(--bg-hover)",
              color: "var(--text-main)",
              fontSize: "13px",
              fontWeight: 500,
              cursor: "pointer",
              transition: "all 0.15s ease",
              fontFamily: "inherit",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "var(--bg-hover-more)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "var(--bg-hover)")
            }
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: "9px 18px",
              borderRadius: "8px",
              border: "none",
              background: isDangerous
                ? "linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)"
                : "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)",
              color: "#fff",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 0.15s ease",
              boxShadow: isDangerous
                ? "0 4px 14px rgba(220,38,38,0.4)"
                : "0 4px 14px rgba(99,102,241,0.4)",
              fontFamily: "inherit",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.88")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmModal;
