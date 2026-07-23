import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePersistedState } from "../hooks/usePersistedState";

const testKey = "test-usePersistedState";

beforeEach(() => {
  localStorage.clear();
});

describe("usePersistedState", () => {
  it("uses defaultValue when no saved value exists", () => {
    const { result } = renderHook(() => usePersistedState(testKey, "default"));
    expect(result.current[0]).toBe("default");
  });

  it("persists value changes to localStorage", () => {
    const { result } = renderHook(() => usePersistedState(testKey, "default"));
    act(() => {
      result.current[1]("updated");
    });
    expect(result.current[0]).toBe("updated");
    expect(localStorage.getItem(testKey)).toBe("updated");
  });

  it("restores saved string value from localStorage", () => {
    localStorage.setItem(testKey, "savedValue");
    const { result } = renderHook(() => usePersistedState(testKey, "default"));
    expect(result.current[0]).toBe("savedValue");
  });

  it("restores saved number value from localStorage", () => {
    localStorage.setItem(testKey, "42.5");
    const { result } = renderHook(() => usePersistedState(testKey, 0));
    expect(result.current[0]).toBe(42.5);
  });

  it("falls back to defaultValue for invalid number", () => {
    localStorage.setItem(testKey, "notANumber");
    const { result } = renderHook(() => usePersistedState(testKey, 10));
    expect(result.current[0]).toBe(10);
  });

  it("restores saved boolean true from localStorage", () => {
    localStorage.setItem(testKey, "true");
    const { result } = renderHook(() => usePersistedState(testKey, false));
    expect(result.current[0]).toBe(true);
  });

  it("restores saved boolean false from localStorage", () => {
    localStorage.setItem(testKey, "false");
    const { result } = renderHook(() => usePersistedState(testKey, true));
    expect(result.current[0]).toBe(false);
  });

  it("uses custom deserialize function", () => {
    localStorage.setItem(testKey, '{"x":1}');
    const { result } = renderHook(() =>
      usePersistedState(testKey, { x: 0 }, { deserialize: JSON.parse }),
    );
    expect(result.current[0]).toEqual({ x: 1 });
  });

  it("uses custom serialize function", () => {
    const serialize = vi.fn((v: { x: number }) => JSON.stringify(v));
    const { result } = renderHook(() =>
      usePersistedState(
        testKey,
        { x: 0 },
        { serialize, deserialize: JSON.parse },
      ),
    );
    act(() => {
      result.current[1]({ x: 42 });
    });
    expect(serialize).toHaveBeenCalledWith({ x: 42 });
  });

  it("falls back to defaultValue on localStorage parse error", () => {
    const problematicDeserialize = () => {
      throw new Error("parse error");
    };
    localStorage.setItem(testKey, "bad");
    const { result } = renderHook(() =>
      usePersistedState(testKey, "fallback", {
        deserialize: problematicDeserialize,
      }),
    );
    expect(result.current[0]).toBe("fallback");
  });

  it("uses setPersistedValue with updater function", () => {
    const { result } = renderHook(() => usePersistedState(testKey, 0));
    act(() => {
      result.current[1]((prev: number) => prev + 1);
    });
    expect(result.current[0]).toBe(1);
  });

  it("falls back to defaultValue when localStorage throws", () => {
    const getItemSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage error");
      });
    const { result } = renderHook(() => usePersistedState(testKey, "fallback"));
    expect(result.current[0]).toBe("fallback");
    getItemSpy.mockRestore();
  });
});
