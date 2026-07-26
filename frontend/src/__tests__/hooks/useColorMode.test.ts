import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useColorMode } from "../../hooks/useColorMode";

describe("useColorMode hook", () => {
  beforeEach(() => {
    localStorage.clear();
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
});
