import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useSSE } from "./useSSE";

describe("useSSE", () => {
  let mockEventSourceInstances: any[] = [];
  let originalEventSource: any;

  beforeEach(() => {
    vi.useFakeTimers();
    mockEventSourceInstances = [];
    originalEventSource = global.EventSource;

    // Mock EventSource
    global.EventSource = vi.fn().mockImplementation(function (url: string) {
      const listeners: Record<string, Function[]> = {};
      const instance = {
        url,
        close: vi.fn(),
        addEventListener: vi.fn((event: string, cb: Function) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(cb);
        }),
        onerror: null as any,
        onopen: null as any,
        // Helper to trigger events inside tests
        trigger: (event: string, data: any) => {
          if (listeners[event]) {
            listeners[event].forEach((cb) => cb({ data }));
          }
        },
        triggerOpen: () => {
          if (instance.onopen) instance.onopen();
        },
        triggerError: (err: any) => {
          if (instance.onerror) instance.onerror(err);
        },
      };
      mockEventSourceInstances.push(instance);
      return instance;
    }) as any;
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

  it("updates lastEvent when connected or notification event is received", () => {
    const { result } = renderHook(() => useSSE("/api/sse", "token123"));
    const instance = mockEventSourceInstances[0];

    act(() => {
      instance.trigger("connected", "welcome");
    });
    expect(result.current.lastEvent).toEqual({ type: "connected", data: "welcome" });

    act(() => {
      instance.trigger("notification", "new_notification");
    });
    expect(result.current.lastEvent).toEqual({ type: "notification", data: "new_notification" });
  });

  it("handles connection error and attempts reconnection", () => {
    const { result } = renderHook(() => useSSE("/api/sse", "token123"));
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
    expect(result.current.lastEvent).toEqual({
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
