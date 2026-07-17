/* eslint-disable react-refresh/only-export-components */
import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Snackbar from "@mui/material/Snackbar";

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

const alertSeverity: Record<"success" | "error" | "info", "success" | "error" | "info"> = {
  success: "success",
  error: "error",
  info: "info",
};

export const ToastProvider: React.FC<ToastProviderProps> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback(
    (
      text: string,
      type: "success" | "error" | "info" = "info",
      options?: ToastOptions,
    ) => {
      const id = Math.random().toString(36).substring(2, 9);

      let duration = options?.duration;
      if (duration === undefined) {
        if (options?.action) {
          duration = 10000;
        } else {
          duration = type === "error" ? 6000 : 4000;
        }
      }

      setToasts((prev) => [...prev, { id, text, type, duration, action: options?.action }]);

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

      {toasts.map((t, i) => (
        <Snackbar
          key={t.id}
          open
          anchorOrigin={{ vertical: "top", horizontal: "left" }}
          sx={{
            top: `${24 + i * 72}px !important`,
          }}
        >
          <Alert
            severity={alertSeverity[t.type]}
            variant="filled"
            sx={{
              minWidth: 300,
              maxWidth: 400,
              boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
              alignItems: "center",
            }}
            action={
              t.action ? (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    t.action!.onClick();
                    setToasts((prev) => prev.filter((toast) => toast.id !== t.id));
                  }}
                >
                  {t.action.label}
                </Button>
              ) : undefined
            }
          >
            {t.text}
          </Alert>
        </Snackbar>
      ))}
    </ToastContext.Provider>
  );
};
