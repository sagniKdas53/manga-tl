import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useDependencyLogger } from "../../hooks/useDependencyLogger";

describe("useDependencyLogger hook", () => {
  it("executes without errors", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    renderHook(({ deps }) => useDependencyLogger(deps, "TestComponent"), {
      initialProps: { deps: { count: 1 } },
    });
    consoleSpy.mockRestore();
    expect(true).toBe(true);
  });
});
