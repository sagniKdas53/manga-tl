/* eslint-disable react-refresh/only-export-components */
import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastMessage {
  id: string;
  text: string;
  type: "success" | "error" | "info";
  duration?: number;
  action?: ToastAction;
}

interface ToastOptions {
  duration?: number;
  action?: ToastAction;
}

interface ToastContextValue {
  showToast: (
    text: string,
    type?: "success" | "error" | "info",
    options?: ToastOptions,
  ) => void;
  showSuccess: (text: string, options?: ToastOptions) => void;
  showError: (text: string, options?: ToastOptions) => void;
  showInfo: (text: string, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export const useToast = (): ToastContextValue => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
};

interface ToastProviderProps {
  children: ReactNode;
}

export const ToastProvider: React.FC<ToastProviderProps> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback(
    (
      text: string,
      type: "success" | "error" | "info" = "info",
      options?: ToastOptions,
    ) => {
      const id = Math.random().toString(36).substring(2, 9);

      // Default duration is longer for errors, or infinite if there's an action, unless explicitly provided
      let duration = options?.duration;
      if (duration === undefined) {
        if (options?.action) {
          duration = 10000; // 10 seconds if it requires action
        } else {
          duration = type === "error" ? 6000 : 4000;
        }
      }

      setToasts((prev) => [...prev, { id, text, type, ...options }]);

      if (duration > 0) {
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, duration);
      }
    },
    [],
  );

  const showSuccess = useCallback(
    (text: string, options?: ToastOptions) =>
      showToast(text, "success", options),
    [showToast],
  );
  const showError = useCallback(
    (text: string, options?: ToastOptions) => showToast(text, "error", options),
    [showToast],
  );
  const showInfo = useCallback(
    (text: string, options?: ToastOptions) => showToast(text, "info", options),
    [showToast],
  );

  const value = useMemo(
    () => ({ showToast, showSuccess, showError, showInfo }),
    [showToast, showSuccess, showError, showInfo],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/* Fixed toast container */}
      <div
        style={{
          position: "fixed",
          top: "24px",
          left: "24px",
          zIndex: 10001,
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="glass"
            style={{
              padding: "12px 20px",
              borderRadius: "10px",
              color: "var(--text-main)",
              fontSize: "14px",
              fontWeight: 500,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
              borderLeft: `4px solid ${
                t.type === "success"
                  ? "var(--success)"
                  : t.type === "error"
                    ? "var(--error)"
                    : "var(--primary)"
              }`,
              background: "var(--bg-surface)",
              pointerEvents: "auto",
              minWidth: "300px",
              maxWidth: "400px",
              animation: "slideIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                flex: 1,
              }}
            >
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "24px",
                  height: "24px",
                  borderRadius: "50%",
                  background:
                    t.type === "success"
                      ? "var(--success-glow)"
                      : t.type === "error"
                        ? "rgba(239,68,68,0.15)"
                        : "var(--primary-glow)",
                  color:
                    t.type === "success"
                      ? "var(--success)"
                      : t.type === "error"
                        ? "#ef4444"
                        : "var(--primary)",
                }}
              >
                {t.type === "success" ? "✓" : t.type === "error" ? "✗" : "ℹ"}
              </span>
              <span style={{ lineHeight: 1.4 }}>{t.text}</span>
            </div>

            {t.action && (
              <button
                onClick={() => {
                  t.action!.onClick();
                  setToasts((prev) =>
                    prev.filter((toast) => toast.id !== t.id),
                  );
                }}
                style={{
                  padding: "6px 12px",
                  borderRadius: "6px",
                  border: "1px solid var(--border-color)",
                  background: "var(--bg-hover)",
                  color: "var(--text-main)",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                  flexShrink: 0,
                  transition: "background 0.2s",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "var(--bg-hover-more)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "var(--bg-hover)")
                }
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};
