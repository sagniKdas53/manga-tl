import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useSSE } from "../../utils/useSSE";

interface MockEventSource {
  url: string;
  triggerOpen: () => void;
  triggerError: (err: unknown) => void;
  trigger: (event: string, data: unknown) => void;
  close: import("vitest").Mock;
}

const STREAM_URL = "/api/notifications/stream";

describe("useSSE", () => {
  let mockEventSourceInstances: MockEventSource[] = [];
  let originalEventSource: typeof EventSource;
  let originalFetch: typeof global.fetch;
  let ticketCounter: number;

  /** Lets the pending ticket fetch resolve and the hook continue into `new EventSource`. */
  const flushTicketRequest = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockEventSourceInstances = [];
    ticketCounter = 0;
    originalEventSource = global.EventSource;
    originalFetch = global.fetch;

    global.fetch = vi.fn().mockImplementation(async () => {
      ticketCounter += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ticket: `ticket-${ticketCounter}` }),
      };
    }) as unknown as typeof global.fetch;

    // Mock EventSource
    global.EventSource = vi.fn().mockImplementation(function (url: string) {
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      const instance = {
        url,
        close: vi.fn(),
        addEventListener: vi.fn(
          (event: string, cb: (...args: unknown[]) => void) => {
            listeners[event] = listeners[event] || [];
            listeners[event].push(cb);
          },
        ),
        onerror: null as ((err: unknown) => void) | null,
        onopen: null as (() => void) | null,
        // Helper to trigger events inside tests
        trigger: (event: string, data: unknown) => {
          if (listeners[event]) {
            listeners[event].forEach((cb) => cb({ data }));
          }
        },
        triggerOpen: () => {
          if (instance.onopen) instance.onopen();
        },
        triggerError: (err: unknown) => {
          if (instance.onerror) instance.onerror(err);
        },
      };
      mockEventSourceInstances.push(instance as unknown as MockEventSource);
      return instance;
    }) as unknown as typeof EventSource;
  });

  afterEach(() => {
    global.EventSource = originalEventSource;
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("does not initialize when token is null", () => {
    const { result } = renderHook(() => useSSE(STREAM_URL, null));
    expect(global.fetch).not.toHaveBeenCalled();
    expect(global.EventSource).not.toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);
  });

  it("exchanges the session token for a ticket and never puts the token in the URL", async () => {
    // AUDIT-S4: the JWT travels in an Authorization header on the ticket POST; only the
    // single-use ticket reaches the query string, which is what the access log records.
    const { result } = renderHook(() => useSSE(STREAM_URL, "token123"));
    await flushTicketRequest();

    expect(global.fetch).toHaveBeenCalledWith("/api/notifications/ticket", {
      method: "POST",
      headers: { Authorization: "Bearer token123" },
    });
    expect(global.EventSource).toHaveBeenCalledWith(
      "/api/notifications/stream?ticket=ticket-1",
    );
    expect(mockEventSourceInstances[0].url).not.toContain("token123");

    act(() => {
      mockEventSourceInstances[0].triggerOpen();
    });
    expect(result.current.isConnected).toBe(true);
  });

  it("calls onMessage when connected or notification event is received", async () => {
    const onMessage = vi.fn();
    renderHook(() => useSSE(STREAM_URL, "token123", onMessage));
    await flushTicketRequest();
    const instance = mockEventSourceInstances[0];

    act(() => {
      instance.trigger("connected", "welcome");
    });
    expect(onMessage).toHaveBeenCalledWith({
      type: "connected",
      data: "welcome",
    });

    act(() => {
      instance.trigger("notification", "new_notification");
    });
    expect(onMessage).toHaveBeenCalledWith({
      type: "notification",
      data: "new_notification",
    });
  });

  it("handles connection error and reconnects with a fresh ticket", async () => {
    const onMessage = vi.fn();
    const { result } = renderHook(() =>
      useSSE(STREAM_URL, "token123", onMessage),
    );
    await flushTicketRequest();
    const instance = mockEventSourceInstances[0];

    act(() => {
      instance.triggerOpen();
    });
    expect(result.current.isConnected).toBe(true);

    // Trigger error
    act(() => {
      instance.triggerError(new Error("SSE disconnected"));
    });

    expect(result.current.isConnected).toBe(false);
    expect(onMessage).toHaveBeenCalledWith({
      type: "error",
      data: "Connection lost. Retrying...",
    });
    expect(instance.close).toHaveBeenCalled();

    // Fast-forward 5 seconds to trigger retry
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    await flushTicketRequest();

    // Tickets are single-use, so the reconnect must mint a new one rather than replay the old.
    expect(global.EventSource).toHaveBeenCalledTimes(2);
    expect(mockEventSourceInstances[1].url).toContain("ticket=ticket-2");
  });

  it("retries without opening a stream when the ticket request fails", async () => {
    const onMessage = vi.fn();
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch;

    renderHook(() => useSSE(STREAM_URL, "token123", onMessage));
    await flushTicketRequest();

    expect(global.EventSource).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith({
      type: "error",
      data: "Connection lost. Retrying...",
    });

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    await flushTicketRequest();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
