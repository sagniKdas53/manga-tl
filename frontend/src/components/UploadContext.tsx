/* eslint-disable react-refresh/only-export-components */
import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import Box from "@mui/material/Box";
import Collapse from "@mui/material/Collapse";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";

export interface UploadQueueItem {
  id: string;
  name: string;
  progress: number;
  status: "pending" | "uploading" | "completed" | "failed";
  error?: string;
}

/** Stable dispatch functions — never changes reference, no re-render on progress ticks */
interface UploadDispatchContextValue {
  addItems: (items: UploadQueueItem[]) => void;
  updateItem: (id: string, update: Partial<UploadQueueItem>) => void;
  clearCompleted: () => void;
  dismiss: () => void;
}

/** Reactive state — changes on every progress tick */
interface UploadStateContextValue {
  items: UploadQueueItem[];
  showPanel: boolean;
  isExpanded: boolean;
  setIsExpanded: (v: boolean) => void;
}

/** Legacy combined shape for backwards compatibility */
interface UploadContextValue extends UploadDispatchContextValue, UploadStateContextValue {}

const UploadDispatchContext = createContext<UploadDispatchContextValue | null>(null);
const UploadStateContext = createContext<UploadStateContextValue | null>(null);

/** Use only the stable dispatch functions — zero re-renders from progress ticks */
export const useUploadDispatch = (): UploadDispatchContextValue => {
  const ctx = useContext(UploadDispatchContext);
  if (!ctx) throw new Error("useUploadDispatch must be used inside <UploadProvider>");
  return ctx;
};

/** Use the reactive state (items, showPanel, isExpanded) */
export const useUploadState = (): UploadStateContextValue => {
  const ctx = useContext(UploadStateContext);
  if (!ctx) throw new Error("useUploadState must be used inside <UploadProvider>");
  return ctx;
};

/** Legacy hook — composes both contexts. Prefer useUploadDispatch for components that only call actions. */
export const useUploadQueue = (): UploadContextValue => {
  const dispatch = useUploadDispatch();
  const state = useUploadState();
  return { ...dispatch, ...state };
};

interface UploadProviderProps {
  children: ReactNode;
}

export const UploadProvider: React.FC<UploadProviderProps> = ({ children }) => {
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [showPanel, setShowPanel] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);

  const addItems = useCallback((newItems: UploadQueueItem[]) => {
    setItems((prev) => [...prev, ...newItems]);
    setShowPanel(true);
    setIsExpanded(true);
  }, []);

  const updateItem = useCallback(
    (id: string, update: Partial<UploadQueueItem>) => {
      setItems((prev) =>
        prev.map((item) => (item.id === id ? { ...item, ...update } : item)),
      );
    },
    [],
  );

  const clearCompleted = useCallback(() => {
    setItems((prev) =>
      prev.filter((i) => i.status !== "completed" && i.status !== "failed"),
    );
    if (items.every((i) => i.status === "completed" || i.status === "failed")) {
      setShowPanel(false);
    }
  }, [items]);

  const dismiss = useCallback(() => {
    setShowPanel(false);
    setItems([]);
  }, []);

  /** Stable dispatch object — memoized on stable callbacks, never changes */
  const dispatchValue = useMemo<UploadDispatchContextValue>(
    () => ({ addItems, updateItem, clearCompleted, dismiss }),
    [addItems, updateItem, clearCompleted, dismiss],
  );

  /** State object — changes on every progress tick */
  const stateValue = useMemo<UploadStateContextValue>(
    () => ({ items, showPanel, isExpanded, setIsExpanded }),
    [items, showPanel, isExpanded],
  );

  return (
    <UploadDispatchContext.Provider value={dispatchValue}>
      <UploadStateContext.Provider value={stateValue}>
        {children}
      {showPanel && (
        <Paper
          sx={{
            position: "fixed",
            bottom: 24,
            right: 24,
            width: 360,
            zIndex: 10000,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 12px 32px rgba(0,0,0,0.3)",
          }}
        >
          <Box
            sx={{
              px: 2,
              py: 1,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              cursor: "pointer",
              userSelect: "none",
            }}
            onClick={() => setIsExpanded(!isExpanded)}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  bgcolor: items.some(
                    (i) => i.status === "uploading" || i.status === "pending",
                  )
                    ? "warning.main"
                    : "success.main",
                }}
              />
              <Typography
                variant="subtitle2"
                sx={{ fontWeight: 600 }}
              >
                {items.some(
                  (i) => i.status === "uploading" || i.status === "pending",
                )
                  ? `Uploading ${items.filter((i) => i.status === "uploading" || i.status === "pending").length} file(s)...`
                  : "Uploads Completed"}
              </Typography>
            </Box>
            <Box
              sx={{ display: "flex", alignItems: "center", gap: 1 }}
              onClick={(e) => e.stopPropagation()}
            >
              <IconButton
                aria-label={
                  isExpanded ? "Collapse upload list" : "Expand upload list"
                }
                aria-expanded={isExpanded}
                size="small"
                onClick={() => setIsExpanded(!isExpanded)}
              >
                {isExpanded ? (
                  <ExpandLessIcon fontSize="small" />
                ) : (
                  <ExpandMoreIcon fontSize="small" />
                )}
              </IconButton>
              <IconButton
                aria-label="Dismiss uploads"
                size="small"
                onClick={dismiss}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>
          </Box>

          <Collapse in={isExpanded}>
            <Box
              sx={{
                p: 2,
                display: "flex",
                flexDirection: "column",
                gap: 1.5,
                maxHeight: 300,
                overflowY: "auto",
              }}
            >
              {items.map((item) => (
                <Box key={item.id}>
                  <Box
                    sx={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <Typography
                      variant="caption"
                      sx={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        maxWidth: "75%",
                      }}
                      title={item.name}
                    >
                      {item.name}
                    </Typography>
                    <Typography
                      variant="caption"
                      sx={{
                        fontWeight: 600,
                        color:
                          item.status === "completed"
                            ? "success.main"
                            : item.status === "failed"
                              ? "error.main"
                              : "text.secondary",
                      }}
                    >
                      {item.status === "uploading"
                        ? `${item.progress}%`
                        : item.status}
                    </Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={item.progress}
                    color={
                      item.status === "failed"
                        ? "error"
                        : item.status === "completed"
                          ? "success"
                          : "primary"
                    }
                    sx={{ height: 4, borderRadius: 2, mt: 0.25 }}
                  />
                </Box>
              ))}
            </Box>
          </Collapse>
        </Paper>
      )}
      </UploadStateContext.Provider>
    </UploadDispatchContext.Provider>
  );
};
