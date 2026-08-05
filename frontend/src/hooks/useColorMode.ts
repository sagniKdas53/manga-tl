import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "manga_theme";

type ColorMode = "light" | "dark";

/**
 * Last value read from storage. React calls `getSnapshot` on every render and again on every
 * store notification, and each call was a synchronous `localStorage` read for a value that only
 * changes when something writes it — so the read happens once and `subscribe` invalidates it.
 *
 * Note this is *not* about tearing: the snapshot is a string, and `Object.is("dark", "dark")` is
 * true however many times it is read. A fresh object per call would be a different matter.
 */
let cachedMode: ColorMode | null = null;

function readStoredMode(): ColorMode {
  return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
}

function getSnapshot(): ColorMode {
  cachedMode ??= readStoredMode();
  return cachedMode;
}

/** A null key means the whole store was cleared, which changes our value too. */
const affectsUs = (e: StorageEvent) => e.key === null || e.key === STORAGE_KEY;

// Registered once at module scope rather than inside `subscribe`, for two reasons: the cache has
// to be dropped even when no component is subscribed, or a change made while the tree was
// unmounted would be served stale on the next mount; and listeners fire in registration order, so
// this one is guaranteed to have run before any subscriber is told to re-read.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (affectsUs(e)) cachedMode = null;
  });
}

function subscribe(callback: () => void): () => void {
  const handler = (e: StorageEvent) => {
    if (affectsUs(e)) callback();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

export function useColorMode() {
  const mode = useSyncExternalStore(subscribe, getSnapshot);

  const toggleMode = useCallback(() => {
    const next: ColorMode = mode === "dark" ? "light" : "dark";
    const previous = localStorage.getItem(STORAGE_KEY);
    localStorage.setItem(STORAGE_KEY, next);

    // Writing in this tab does not fire a real `storage` event, so this stands in for one. It has
    // to carry newValue and oldValue: reading them off the event is the ordinary way to handle
    // `storage`, and a listener that did so would have seen null here and concluded the theme had
    // been cleared rather than changed.
    // No `storageArea`: the test setup substitutes a plain object for localStorage, and jsdom
    // rejects anything that is not a real Storage. Nothing here reads it.
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: STORAGE_KEY,
        newValue: next,
        oldValue: previous,
      }),
    );
  }, [mode]);

  return { mode, toggleMode } as const;
}
