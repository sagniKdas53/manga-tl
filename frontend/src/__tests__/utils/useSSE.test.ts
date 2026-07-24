import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useSSE } from "../../utils/useSSE";

interface MockEventSource {
  triggerOpen: () => void;
  triggerError: (err: unknown) => void;
  trigger: (event: string, data: unknown) => void;
  close: import("vitest").Mock;
}

describe("useSSE", () => {
  let mockEventSourceInstances: MockEventSource[] = [];
  let originalEventSource: typeof EventSource;

  beforeEach(() => {
    vi.useFakeTimers();
    mockEventSourceInstances = [];
    originalEventSource = global.EventSource;

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
    vi.useRealTimers();
  });

  it("does not initialize when token is null", () => {
    const { result } = renderHook(() => useSSE("/api/sse", null));
    expect(global.EventSource).not.toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);
  });

  it("initializes EventSource and sets isConnected on open", () => {
    const { result } = renderHook(() => useSSE("/api/sse", "token123"));
    expect(global.EventSource).toHaveBeenCalledWith("/api/sse?token=token123");

    const instance = mockEventSourceInstances[0];
    act(() => {
      instance.triggerOpen();
    });

    expect(result.current.isConnected).toBe(true);
  });

  it("calls onMessage when connected or notification event is received", () => {
    const onMessage = vi.fn();
    renderHook(() => useSSE("/api/sse", "token123", onMessage));
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

  it("handles connection error and attempts reconnection", () => {
    const onMessage = vi.fn();
    const { result } = renderHook(() =>
      useSSE("/api/sse", "token123", onMessage),
    );
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

    // A new EventSource should have been instantiated
    expect(global.EventSource).toHaveBeenCalledTimes(2);
  });
});
