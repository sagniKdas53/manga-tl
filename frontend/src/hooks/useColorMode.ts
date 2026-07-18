import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "manga_theme";

function getSnapshot(): "light" | "dark" {
  return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
}

function subscribe(callback: () => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

export function useColorMode() {
  const mode = useSyncExternalStore(subscribe, getSnapshot);

  const toggleMode = useCallback(() => {
    const next = mode === "dark" ? "light" : "dark";
    localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
  }, [mode]);

  return { mode, toggleMode } as const;
}
