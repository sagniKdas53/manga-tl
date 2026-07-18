import { useEffect, useRef, useState } from "react";

type SSEEvent = {
  type: string;
  data: string;
};

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

    const sseUrl = `${url}?token=${encodeURIComponent(token)}`;
    const eventSource = new EventSource(sseUrl);
    eventSourceRef.current = eventSource;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const updateEvent = (type: string, data: string) => {
      if (import.meta.env.DEV) {
        console.log(`[SSE Event Received] ${type}:`, data);
      }
      if (onMessageRef.current) {
        onMessageRef.current({ type, data });
      }
    };

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
      eventSource.addEventListener(evtType, (event) => {
        updateEvent(evtType, (event as MessageEvent).data);
      });
    });

    eventSource.onerror = (error) => {
      if (import.meta.env.DEV) {
        console.error("SSE error", error);
      }
      setIsConnected(false);
      updateEvent("error", "Connection lost. Retrying...");
      eventSource.close();

      // Auto-reconnect after 5 seconds
      timeoutId = setTimeout(() => {
        setRetryCount((prev) => prev + 1);
      }, 5000);
    };

    return () => {
      eventSource.close();
      setIsConnected(false);
      eventSourceRef.current = null;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [url, token, retryCount]);

  return { isConnected, retryCount };
}
