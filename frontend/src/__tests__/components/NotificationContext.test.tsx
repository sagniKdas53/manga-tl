import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { NotificationProvider } from "../../components/NotificationContext";
import { useNotifications } from "../../components/useNotifications";

let sseCallback: ((event: { type: string; data: string }) => void) | null =
  null;

vi.mock("../../utils/useSSE", () => ({
  useSSE: (
    _url: string,
    _token: string | null,
    onMessage: (event: { type: string; data: string }) => void,
  ) => {
    sseCallback = onMessage;
  },
}));

function TestConsumer() {
  const {
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    dismissNotification,
    clearAll,
    subscribe,
  } = useNotifications();

  return (
    <div>
      <span data-testid="unread-count">{unreadCount}</span>
      <span data-testid="total-count">{notifications.length}</span>
      <button onClick={() => markAllAsRead()}>Mark All Read</button>
      <button onClick={() => clearAll()}>Clear All</button>
      <button onClick={() => subscribe(() => {})()}>Subscribe Test</button>
      {notifications.map((n) => (
        <div key={n.id}>
          <span onClick={() => markAsRead(n.id)}>
            {n.title} - {n.read ? "read" : "unread"}
          </span>
          <button onClick={() => dismissNotification(n.id)}>Dismiss</button>
        </div>
      ))}
    </div>
  );
}

describe("NotificationProvider & Context", () => {
  it("provides notification state and manages events", async () => {
    render(
      <NotificationProvider token="token123">
        <TestConsumer />
      </NotificationProvider>,
    );

    expect(screen.getByTestId("unread-count")).toHaveTextContent("0");

    await act(async () => {
      if (sseCallback) {
        sseCallback({
          type: "notification",
          data: JSON.stringify({
            id: "n1",
            type: "INFO",
            title: "Task Complete",
            message: "Finished successfully",
            timestamp: "2026-07-26T00:00:00Z",
          }),
        });
        sseCallback({ type: "connected", data: "" });
        sseCallback({ type: "error", data: "Connection error" });
      }
    });

    expect(screen.getByTestId("unread-count")).toHaveTextContent("1");
    expect(screen.getByText("Task Complete - unread")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Task Complete - unread"));
    expect(screen.getByTestId("unread-count")).toHaveTextContent("0");

    fireEvent.click(screen.getByText("Mark All Read"));
    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.getByTestId("total-count")).toHaveTextContent("0");

    fireEvent.click(screen.getByText("Subscribe Test"));
    fireEvent.click(screen.getByText("Clear All"));
    expect(screen.getByTestId("total-count")).toHaveTextContent("0");
  });
});
