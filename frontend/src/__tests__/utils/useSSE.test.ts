import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useSSE, sseRetryDelayMs } from "../../utils/useSSE";

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

  describe("AUDIT-F3 — retry backoff, jitter and the visibility gate", () => {
    /** Forces the jitter to its maximum so delays are the deterministic nominal value. */
    const pinJitterHigh = () => vi.spyOn(Math, "random").mockReturnValue(1);

    const setVisibility = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
    };

    afterEach(() => {
      vi.restoreAllMocks();
      setVisibility("visible");
    });

    it("grows the delay exponentially and caps it at 60s", () => {
      pinJitterHigh();
      // With jitter pinned high the value is the full nominal delay: 5s, 10s, 20s, 40s, then the cap.
      expect(sseRetryDelayMs(0)).toBe(5000);
      expect(sseRetryDelayMs(1)).toBe(10000);
      expect(sseRetryDelayMs(2)).toBe(20000);
      expect(sseRetryDelayMs(3)).toBe(40000);
      expect(sseRetryDelayMs(4)).toBe(60000);
      expect(sseRetryDelayMs(50)).toBe(60000);
    });

    it("keeps a floor of half the nominal delay, so retries still make progress", () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      expect(sseRetryDelayMs(0)).toBe(2500);
      expect(sseRetryDelayMs(99)).toBe(30000);
    });

    it("backs off across consecutive failures instead of retrying flat every 5s", async () => {
      pinJitterHigh();
      renderHook(() => useSSE(STREAM_URL, "token123"));
      await flushTicketRequest();

      act(() => mockEventSourceInstances[0].triggerError(new Error("down")));

      // First retry is due at 5s, not before.
      act(() => void vi.advanceTimersByTime(4999));
      expect(global.EventSource).toHaveBeenCalledTimes(1);
      act(() => void vi.advanceTimersByTime(1));
      await flushTicketRequest();
      expect(global.EventSource).toHaveBeenCalledTimes(2);

      // Second failure must wait 10s — under the old flat 5s it would already have reconnected.
      act(() =>
        mockEventSourceInstances[1].triggerError(new Error("still down")),
      );
      act(() => void vi.advanceTimersByTime(5000));
      await flushTicketRequest();
      expect(global.EventSource).toHaveBeenCalledTimes(2);

      act(() => void vi.advanceTimersByTime(5000));
      await flushTicketRequest();
      expect(global.EventSource).toHaveBeenCalledTimes(3);
    });

    it("resets the backoff once a connection actually opens", async () => {
      pinJitterHigh();
      renderHook(() => useSSE(STREAM_URL, "token123"));
      await flushTicketRequest();

      // Fail once to advance the curve, then reconnect successfully.
      act(() => mockEventSourceInstances[0].triggerError(new Error("blip")));
      act(() => void vi.advanceTimersByTime(5000));
      await flushTicketRequest();
      act(() => mockEventSourceInstances[1].triggerOpen());

      // A later failure starts from 5s again rather than inheriting the old streak.
      act(() =>
        mockEventSourceInstances[1].triggerError(new Error("blip again")),
      );
      act(() => void vi.advanceTimersByTime(5000));
      await flushTicketRequest();
      expect(global.EventSource).toHaveBeenCalledTimes(3);
    });

    it("stops retrying while the tab is hidden, and reconnects the moment it wakes", async () => {
      pinJitterHigh();
      renderHook(() => useSSE(STREAM_URL, "token123"));
      await flushTicketRequest();

      setVisibility("hidden");
      act(() => mockEventSourceInstances[0].triggerError(new Error("down")));

      // No timer is armed at all — a background tab must not reconnect on a schedule.
      act(() => void vi.advanceTimersByTime(120000));
      await flushTicketRequest();
      expect(global.EventSource).toHaveBeenCalledTimes(1);

      setVisibility("visible");
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await flushTicketRequest();

      // Immediate, with no backoff window the user never saw start.
      expect(global.EventSource).toHaveBeenCalledTimes(2);
    });

    it("defers a retry that comes due while the tab is hidden", async () => {
      pinJitterHigh();
      renderHook(() => useSSE(STREAM_URL, "token123"));
      await flushTicketRequest();

      // Tab is visible when the failure happens, so the 5s timer is armed...
      act(() => mockEventSourceInstances[0].triggerError(new Error("down")));
      // ...but is hidden by the time it fires.
      setVisibility("hidden");
      act(() => void vi.advanceTimersByTime(5000));
      await flushTicketRequest();
      expect(global.EventSource).toHaveBeenCalledTimes(1);

      setVisibility("visible");
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await flushTicketRequest();
      expect(global.EventSource).toHaveBeenCalledTimes(2);
    });

    it("ignores a wake-up when no retry is pending", async () => {
      renderHook(() => useSSE(STREAM_URL, "token123"));
      await flushTicketRequest();
      act(() => mockEventSourceInstances[0].triggerOpen());

      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await flushTicketRequest();
      expect(global.EventSource).toHaveBeenCalledTimes(1);
    });
  });

  describe("session expiry pushed by the server (AUDIT-F7)", () => {
    it("ends the session when the stream reports it expired", async () => {
      localStorage.setItem(
        "manga_user",
        JSON.stringify({ token: "token123", email: "reader@manga.local" }),
      );
      // Claiming the event is what App.tsx's SessionWatcher does, so `utils` skips its
      // hard-redirect fallback -- the router handles the sign-out.
      const expired = vi.fn((e: Event) => e.preventDefault());
      window.addEventListener("session-expired", expired);

      renderHook(() => useSSE(STREAM_URL, "token123"));
      await flushTicketRequest();

      act(() => {
        mockEventSourceInstances[0].trigger(
          "session-expired",
          '{"reason":"expired"}',
        );
      });

      // Without this listener the backend push lands on an EventSource that has no handler for
      // it and is dropped silently -- the whole point of AUDIT-F7 is that an idle tab with a live
      // connection finds out now rather than on its next request.
      expect(localStorage.getItem("manga_user")).toBeNull();
      expect(expired).toHaveBeenCalledTimes(1);

      window.removeEventListener("session-expired", expired);
    });

    it("leaves an ordinary event alone", async () => {
      localStorage.setItem("manga_user", JSON.stringify({ token: "token123" }));
      renderHook(() => useSSE(STREAM_URL, "token123"));
      await flushTicketRequest();

      act(() => mockEventSourceInstances[0].trigger("notification", "{}"));

      expect(localStorage.getItem("manga_user")).not.toBeNull();
      localStorage.removeItem("manga_user");
    });
  });
});
