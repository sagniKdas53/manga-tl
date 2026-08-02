import { useEffect, useRef, useState } from "react";

type SSEEvent = {
  type: string;
  data: string;
};

const RETRY_DELAY_MS = 5000;

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

    const scheduleRetry = () => {
      if (cancelled || timeoutId) return;
      timeoutId = setTimeout(() => {
        setRetryCount((prev) => prev + 1);
      }, RETRY_DELAY_MS);
    };

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
