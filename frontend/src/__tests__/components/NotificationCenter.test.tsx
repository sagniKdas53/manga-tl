import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationCenter } from "../../components/NotificationCenter";
import { useNotifications } from "../../components/useNotifications";
import { useColorMode } from "../../hooks/useColorMode";
import { safeFetch } from "../../utils";

vi.mock("../../components/useNotifications", () => ({
  useNotifications: vi.fn(),
}));
vi.mock("../../hooks/useColorMode", () => ({
  useColorMode: vi.fn(),
}));
vi.mock("../../utils", () => ({
  safeFetch: vi.fn(),
}));

const mockShowToast = vi.fn();
vi.mock("../../components/ToastContext", () => ({
  useToast: () => ({
    showToast: mockShowToast,
  }),
}));

describe("NotificationCenter", () => {
  const mockMarkAsRead = vi.fn();
  const mockMarkAllAsRead = vi.fn();
  const mockClearAll = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (useColorMode as import("vitest").Mock).mockReturnValue({
      mode: "dark",
    });
    (useNotifications as import("vitest").Mock).mockReturnValue({
      notifications: [],
      unreadCount: 0,
      markAsRead: mockMarkAsRead,
      markAllAsRead: mockMarkAllAsRead,
      clearAll: mockClearAll,
    });
  });

  it("renders with 0 unread notifications", () => {
    render(
      <NotificationCenter
        forceOpen={false}
        onRequestOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTitle("Notifications")).toBeInTheDocument();
  });

  it("shows notifications when opened", () => {
    const notifications = [
      {
        id: "1",
        type: "INFO",
        title: "Test Notification",
        message: "Test Msg",
        read: false,
        timestamp: Date.now(),
      },
    ];
    (useNotifications as import("vitest").Mock).mockReturnValue({
      notifications,
      unreadCount: 1,
      markAsRead: mockMarkAsRead,
      markAllAsRead: mockMarkAllAsRead,
      clearAll: mockClearAll,
    });

    render(
      <NotificationCenter
        forceOpen={true}
        onRequestOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Test Notification")).toBeInTheDocument();
    expect(screen.getByText("Test Msg")).toBeInTheDocument();
  });

  it("can clear all notifications", async () => {
    render(
      <NotificationCenter
        forceOpen={true}
        onRequestOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("Clear All"));
    expect(screen.getByText("Clear All Notifications")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => {
      expect(mockClearAll).toHaveBeenCalled();
    });
  });

  it("renders complex notifications and handles download", async () => {
    // Mock user in localStorage
    localStorage.setItem("manga_user", JSON.stringify({ token: "test_token" }));

    // Mock URL methods
    global.URL.createObjectURL = vi.fn();
    global.URL.revokeObjectURL = vi.fn();

    const mockBlob = new Blob(["test"]);
    (safeFetch as import("vitest").Mock).mockResolvedValueOnce({
      ok: true,
      blob: () => Promise.resolve(mockBlob),
    });

    const notifications = [
      {
        id: "2",
        type: "EXPORT_SUCCESS",
        title: "Export Done",
        message: "Your export is ready",
        read: true,
        timestamp: Date.now(),
        context: {
          seriesTitle: "Naruto",
          chapterNumber: "123",
          pageNumber: 5,
          exportId: "exp-123",
        },
      },
    ];
    (useNotifications as import("vitest").Mock).mockReturnValue({
      notifications,
      unreadCount: 0,
      markAsRead: vi.fn(),
      markAllAsRead: vi.fn(),
      clearAll: vi.fn(),
    });

    render(
      <NotificationCenter
        forceOpen={true}
        onRequestOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Naruto › Ch.123 › Page 5")).toBeInTheDocument();

    const downloadBtn = screen.getByText("Download ZIP");
    fireEvent.click(downloadBtn);

    await waitFor(() => {
      expect(safeFetch).toHaveBeenCalledWith(
        "/api/series/chapters/exports/exp-123/download",
        expect.any(Object),
      );
      expect(global.URL.createObjectURL).toHaveBeenCalled();
    });
  });

  it("marks notification as read when row is clicked", async () => {
    const mockMarkAsRead = vi.fn();
    const notifications = [
      {
        id: "1",
        type: "INFO",
        title: "Read Me",
        message: "Msg",
        read: false,
        timestamp: Date.now(),
      },
    ];
    (useNotifications as import("vitest").Mock).mockReturnValue({
      notifications,
      unreadCount: 1,
      markAsRead: mockMarkAsRead,
      markAllAsRead: vi.fn(),
      clearAll: vi.fn(),
      dismissNotification: vi.fn(),
    });

    render(
      <NotificationCenter
        forceOpen={true}
        onRequestOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const row = screen.getByText("Read Me").closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    expect(mockMarkAsRead).toHaveBeenCalledWith("1");
  });

  it("dismisses notification", async () => {
    const mockDismiss = vi.fn();
    const notifications = [
      {
        id: "1",
        type: "INFO",
        title: "Dismiss Me",
        message: "Msg",
        read: false,
        timestamp: Date.now(),
      },
    ];
    (useNotifications as import("vitest").Mock).mockReturnValue({
      notifications,
      unreadCount: 1,
      markAsRead: vi.fn(),
      markAllAsRead: vi.fn(),
      clearAll: vi.fn(),
      dismissNotification: mockDismiss,
    });

    render(
      <NotificationCenter
        forceOpen={true}
        onRequestOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dismissBtn = screen.getByLabelText("Dismiss");
    fireEvent.click(dismissBtn);
    expect(mockDismiss).toHaveBeenCalledWith("1");
  });

  it("handles download when token is null and no stored user", async () => {
    const notifications = [
      {
        id: "3",
        type: "EXPORT_SUCCESS",
        title: "Export",
        message: "Ready",
        read: true,
        timestamp: Date.now(),
        context: { seriesTitle: "S", chapterNumber: "1", exportId: "exp-1" },
      },
    ];
    (useNotifications as import("vitest").Mock).mockReturnValue({
      notifications,
      unreadCount: 0,
      markAsRead: vi.fn(),
      markAllAsRead: vi.fn(),
      clearAll: vi.fn(),
      dismissNotification: vi.fn(),
    });

    localStorage.removeItem("manga_user");

    render(
      <NotificationCenter
        forceOpen={true}
        onRequestOpen={vi.fn()}
        onClose={vi.fn()}
        token={null}
      />,
    );

    fireEvent.click(screen.getByText("Download ZIP"));
    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        "You're signed out — please log in again to download.",
        "error",
      );
    });
  });

  it("handles download when stored user has invalid JSON", async () => {
    const notifications = [
      {
        id: "4",
        type: "EXPORT_SUCCESS",
        title: "Export",
        message: "Ready",
        read: true,
        timestamp: Date.now(),
        context: { seriesTitle: "S", chapterNumber: "1", exportId: "exp-1" },
      },
    ];
    (useNotifications as import("vitest").Mock).mockReturnValue({
      notifications,
      unreadCount: 0,
      markAsRead: vi.fn(),
      markAllAsRead: vi.fn(),
      clearAll: vi.fn(),
      dismissNotification: vi.fn(),
    });

    localStorage.setItem("manga_user", "not-json");

    render(
      <NotificationCenter
        forceOpen={true}
        onRequestOpen={vi.fn()}
        onClose={vi.fn()}
        token={null}
      />,
    );

    fireEvent.click(screen.getByText("Download ZIP"));
    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        "Couldn't read your session — please log in again.",
        "error",
      );
    });
  });

  it("handles 404 on download", async () => {
    (safeFetch as import("vitest").Mock).mockResolvedValueOnce({
      ok: false,
      status: 404,
    });
    localStorage.setItem("manga_user", JSON.stringify({ token: "test" }));

    const notifications = [
      {
        id: "5",
        type: "EXPORT_SUCCESS",
        title: "Export",
        message: "Ready",
        read: true,
        timestamp: Date.now(),
        context: { seriesTitle: "S", chapterNumber: "1", exportId: "exp-1" },
      },
    ];
    (useNotifications as import("vitest").Mock).mockReturnValue({
      notifications,
      unreadCount: 0,
      markAsRead: vi.fn(),
      markAllAsRead: vi.fn(),
      clearAll: vi.fn(),
      dismissNotification: vi.fn(),
    });

    render(
      <NotificationCenter
        forceOpen={true}
        onRequestOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Download ZIP"));
    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        "This export has expired or was already cleaned up.",
        "error",
      );
    });
  });

  it("handles download network error", async () => {
    (safeFetch as import("vitest").Mock).mockRejectedValueOnce(
      new Error("Network Error"),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem("manga_user", JSON.stringify({ token: "test" }));

    const notifications = [
      {
        id: "6",
        type: "EXPORT_SUCCESS",
        title: "Export",
        message: "Ready",
        read: true,
        timestamp: Date.now(),
        context: { seriesTitle: "S", chapterNumber: "1", exportId: "exp-1" },
      },
    ];
    (useNotifications as import("vitest").Mock).mockReturnValue({
      notifications,
      unreadCount: 0,
      markAsRead: vi.fn(),
      markAllAsRead: vi.fn(),
      clearAll: vi.fn(),
      dismissNotification: vi.fn(),
    });

    render(
      <NotificationCenter
        forceOpen={true}
        onRequestOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Download ZIP"));
    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalled();
      expect(mockShowToast).toHaveBeenCalledWith(
        "Error downloading export",
        "error",
      );
    });
    consoleSpy.mockRestore();
  });
});
