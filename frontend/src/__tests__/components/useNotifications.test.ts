import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useNotifications } from "../../components/useNotifications";

describe("useNotifications hook", () => {
  it("throws error when used outside NotificationProvider", () => {
    expect(() => renderHook(() => useNotifications())).toThrow(
      "useNotifications must be used within a NotificationProvider",
    );
  });
});
