import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationCenter } from "./NotificationCenter";
import { useNotifications } from "./useNotifications";
import { useColorMode } from "../hooks/useColorMode";

vi.mock("./useNotifications", () => ({
  useNotifications: vi.fn(),
}));
vi.mock("../hooks/useColorMode", () => ({
  useColorMode: vi.fn(),
}));
vi.mock("../utils", () => ({
  safeFetch: vi.fn(),
}));

describe("NotificationCenter", () => {
  const mockMarkAsRead = vi.fn();
  const mockMarkAllAsRead = vi.fn();
  const mockClearAll = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useColorMode as any).mockReturnValue({
      mode: "dark",
    });
    (useNotifications as any).mockReturnValue({
      notifications: [],
      unreadCount: 0,
      markAsRead: mockMarkAsRead,
      markAllAsRead: mockMarkAllAsRead,
      clearAll: mockClearAll,
    });
  });

  it("renders with 0 unread notifications", () => {
    render(<NotificationCenter forceOpen={false} onRequestOpen={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTitle("Notifications")).toBeInTheDocument();
  });

  it("shows notifications when opened", () => {
    const notifications = [
      { id: "1", type: "INFO", title: "Test Notification", message: "Test Msg", read: false, timestamp: Date.now() }
    ];
    (useNotifications as any).mockReturnValue({
      notifications,
      unreadCount: 1,
      markAsRead: mockMarkAsRead,
      markAllAsRead: mockMarkAllAsRead,
      clearAll: mockClearAll,
    });
    
    render(<NotificationCenter forceOpen={true} onRequestOpen={vi.fn()} onClose={vi.fn()} />);
    
    expect(screen.getByText("Test Notification")).toBeInTheDocument();
    expect(screen.getByText("Test Msg")).toBeInTheDocument();
  });

  it("can clear all notifications", async () => {
    render(<NotificationCenter forceOpen={true} onRequestOpen={vi.fn()} onClose={vi.fn()} />);
    
    fireEvent.click(screen.getByLabelText("Clear All"));
    expect(screen.getByText("Clear All Notifications")).toBeInTheDocument();
    
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => {
      expect(mockClearAll).toHaveBeenCalled();
    });
  });
});
