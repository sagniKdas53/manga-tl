/* eslint-disable react-refresh/only-export-components */
import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Slide from "@mui/material/Slide";
import { TransitionGroup } from "react-transition-group";

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

      let duration = options?.duration;
      if (duration === undefined) {
        if (options?.action) {
          duration = 10000;
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

  return (
    <ToastContext.Provider
      value={{ showToast, showSuccess, showError, showInfo }}
    >
      {children}

      <Box
        sx={{
          position: "fixed",
          top: 24,
          left: 24,
          zIndex: 10001,
          display: "flex",
          flexDirection: "column",
          gap: 1.5,
          pointerEvents: "none",
        }}
      >
        <TransitionGroup component={null}>
          {toasts.map((t) => (
            <Slide key={t.id} direction="right">
              <Alert
                severity={t.type}
                variant="filled"
                sx={{
                  pointerEvents: "auto",
                  minWidth: 300,
                  maxWidth: 400,
                  boxShadow: 3,
                }}
                action={
                  t.action ? (
                    <Button
                      color="inherit"
                      size="small"
                      onClick={() => {
                        t.action!.onClick();
                        setToasts((prev) =>
                          prev.filter((toast) => toast.id !== t.id),
                        );
                      }}
                    >
                      {t.action.label}
                    </Button>
                  ) : undefined
                }
              >
                {t.text}
              </Alert>
            </Slide>
          ))}
        </TransitionGroup>
      </Box>
    </ToastContext.Provider>
  );
};
