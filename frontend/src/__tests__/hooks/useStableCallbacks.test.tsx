import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useStableCallbacks } from "../../hooks/useStableCallbacks";

describe("useStableCallbacks", () => {
  it("keeps each wrapper's identity across renders", () => {
    const { result, rerender } = renderHook(
      ({ n }) => useStableCallbacks({ onSave: () => n }),
      { initialProps: { n: 1 } },
    );
    const first = result.current.onSave;
    rerender({ n: 2 });
    expect(result.current.onSave).toBe(first);
  });

  it("calls the latest version of the callback, with its arguments", () => {
    const early = vi.fn();
    const late = vi.fn(() => "late");
    const { result, rerender } = renderHook(
      ({ cb }) => useStableCallbacks({ onSave: cb }),
      { initialProps: { cb: early as (x: number) => unknown } },
    );
    rerender({ cb: late });
    expect(result.current.onSave(7)).toBe("late");
    expect(late).toHaveBeenCalledWith(7);
    expect(early).not.toHaveBeenCalled();
  });

  it("does nothing when an optional callback is absent", () => {
    const { result } = renderHook(() =>
      useStableCallbacks({ onOptional: undefined as (() => void) | undefined }),
    );
    expect(() => result.current.onOptional?.()).not.toThrow();
  });
});
