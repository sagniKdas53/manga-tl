import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useColorMode } from "../../hooks/useColorMode";

describe("useColorMode hook", () => {
  beforeEach(() => {
    localStorage.clear();
    // getSnapshot caches, and a same-tab clear() fires no event. A cross-tab clear does, with a
    // null key — dispatching it here is what a real browser would have done, and it keeps these
    // tests independent of the order they run in.
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });

  it("defaults to dark mode when localStorage is empty", () => {
    const { result } = renderHook(() => useColorMode());
    expect(result.current.mode).toBe("dark");
  });

  it("toggles mode between light and dark", () => {
    const { result } = renderHook(() => useColorMode());
    expect(result.current.mode).toBe("dark");

    act(() => {
      result.current.toggleMode();
    });

    expect(result.current.mode).toBe("light");
    expect(localStorage.getItem("manga_theme")).toBe("light");
  });

  it("carries the new and old values on the event it synthesises", () => {
    const { result } = renderHook(() => useColorMode());
    const seen: StorageEvent[] = [];
    const listener = (e: Event) => seen.push(e as StorageEvent);
    window.addEventListener("storage", listener);

    act(() => {
      result.current.toggleMode();
    });
    window.removeEventListener("storage", listener);

    // Reading newValue off the event is the ordinary way to handle `storage`. Omitting it meant a
    // listener would read null and conclude the theme had been cleared rather than changed.
    expect(seen).toHaveLength(1);
    expect(seen[0].key).toBe("manga_theme");
    expect(seen[0].newValue).toBe("light");
    expect(seen[0].oldValue).toBeNull();
  });

  it("picks up a change made in another tab", () => {
    const { result } = renderHook(() => useColorMode());
    expect(result.current.mode).toBe("dark");

    act(() => {
      localStorage.setItem("manga_theme", "light");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "manga_theme",
          newValue: "light",
        }),
      );
    });

    // The cached snapshot has to be invalidated by the subscription, or a second tab's toggle
    // would never reach this one.
    expect(result.current.mode).toBe("light");
  });
});
