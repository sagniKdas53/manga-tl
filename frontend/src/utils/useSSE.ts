import { useEffect, useRef, useState } from "react";

type SSEEvent = {
  type: string;
  data: string;
};

const INITIAL_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 60000;

/**
 * Exponential backoff with equal jitter (AUDIT-F3).
 *
 * The retry used to be a flat 5s, forever. A backend that is down or restarting therefore took one
 * reconnect attempt every 5 seconds from every open tab for as long as it stayed down, and all of
 * them retried in lockstep — so the first thing the backend saw on coming back was a synchronised
 * thundering herd.
 *
 * Equal jitter keeps a floor of half the nominal delay, so retries still make steady progress,
 * while spreading a fleet of reconnecting tabs across the window instead of aligning them.
 */
export const sseRetryDelayMs = (attempt: number) => {
  const exponential = Math.min(
    MAX_RETRY_DELAY_MS,
    INITIAL_RETRY_DELAY_MS * 2 ** attempt,
  );
  return exponential / 2 + Math.random() * (exponential / 2);
};

/**
 * Derives the ticket endpoint from the stream endpoint.
 *
 * `EventSource` cannot set request headers, so the session JWT used to be appended to the stream
 * URL as `?token=`. Tomcat logged the full request line, which put a 24-hour bearer token into the
 * access log in plaintext on every reconnect (AUDIT-S4). The token is now spent on an ordinary POST
 * that carries it in a header, and only the resulting single-use, 60-second ticket travels in the
 * URL.
 */
const ticketUrlFor = (streamUrl: string) =>
  streamUrl.replace(/\/stream$/, "/ticket");

export function useSSE(
  url: string,
  token: string | null,
  onMessage?: (event: SSEEvent) => void,
) {
  const [isConnected, setIsConnected] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Consecutive failures, for the backoff curve. Lives in a ref because `retryCount` re-runs the
  // effect, and the streak has to survive that; reset the moment a connection actually opens.
  const attemptRef = useRef(0);
  // Set when a retry came due while the tab was hidden, so the wake handler knows to fire at once.
  const retryWhenVisibleRef = useRef(false);

  const onMessageRef = useRef(onMessage);
  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    let eventSource: EventSource | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const updateEvent = (type: string, data: string) => {
      if (import.meta.env.DEV) {
        console.log(`[SSE Event Received] ${type}:`, data);
      }
      if (onMessageRef.current) {
        onMessageRef.current({ type, data });
      }
    };

    const triggerRetry = () => {
      if (cancelled) return;
      setRetryCount((prev) => prev + 1);
    };

    const scheduleRetry = () => {
      if (cancelled || timeoutId) return;

      const delay = sseRetryDelayMs(attemptRef.current);
      attemptRef.current += 1;

      // Nobody is looking at a hidden tab, and mobile browsers throttle or freeze its timers
      // anyway. Stop retrying until it comes back, then reconnect immediately rather than
      // making the user wait out a backoff window they never saw start.
      if (document.visibilityState !== "visible") {
        retryWhenVisibleRef.current = true;
        return;
      }

      timeoutId = setTimeout(() => {
        timeoutId = null;
        if (document.visibilityState !== "visible") {
          retryWhenVisibleRef.current = true;
          return;
        }
        triggerRetry();
      }, delay);
    };

    const onVisibilityChange = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      if (!retryWhenVisibleRef.current) return;
      retryWhenVisibleRef.current = false;
      triggerRetry();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    const fail = () => {
      setIsConnected(false);
      updateEvent("error", "Connection lost. Retrying...");
      scheduleRetry();
    };

    const requestTicket = async (): Promise<string | null> => {
      try {
        const res = await fetch(ticketUrlFor(url), {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`ticket request failed: ${res.status}`);
        const ticket = (await res.json())?.ticket;
        if (!ticket) throw new Error("ticket request returned no ticket");
        return ticket;
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error("SSE ticket request failed", error);
        }
        return null;
      }
    };

    const connect = async () => {
      const ticket = await requestTicket();
      // The effect may have been torn down while the request was in flight.
      if (cancelled) return;
      if (!ticket) {
        fail();
        return;
      }

      eventSource = new EventSource(
        `${url}?ticket=${encodeURIComponent(ticket)}`,
      );
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        // A real connection resets the backoff curve, so an unrelated blip weeks later starts
        // from 5s again rather than inheriting an old streak's 60s.
        attemptRef.current = 0;
        retryWhenVisibleRef.current = false;
        setIsConnected(true);
        if (import.meta.env.DEV) {
          console.log("SSE connection opened");
        }
      };

      const listeners = [
        "connected",
        "notification",
        "job_update",
        "queue_paused",
        "queue_resumed",
        "queue_cleared",
      ];

      listeners.forEach((evtType) => {
        eventSource?.addEventListener(evtType, (event) => {
          updateEvent(evtType, (event as MessageEvent).data);
        });
      });

      eventSource.onerror = (error) => {
        if (import.meta.env.DEV) {
          console.error("SSE error", error);
        }
        eventSource?.close();
        // A ticket is single-use, so reconnecting has to go back through connect() for a fresh one.
        fail();
      };
    };

    void connect();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      eventSource?.close();
      setIsConnected(false);
      eventSourceRef.current = null;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [url, token, retryCount]);

  return { isConnected, retryCount };
}
