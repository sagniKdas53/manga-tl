import { useEffect, useRef, useState } from 'react';

type SSEEvent = {
  type: string;
  data: string;
};

export function useSSE(url: string, token: string | null) {
  const [lastEvent, setLastEvent] = useState<SSEEvent | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!token) return;

    const sseUrl = `${url}?token=${encodeURIComponent(token)}`;
    const eventSource = new EventSource(sseUrl);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setIsConnected(true);
      console.log('SSE connection opened');
    };

    eventSource.addEventListener('connected', (event) => {
      setLastEvent({ type: 'connected', data: (event as MessageEvent).data });
    });

    eventSource.addEventListener('notification', (event) => {
      setLastEvent({ type: 'notification', data: (event as MessageEvent).data });
    });

    eventSource.onerror = (error) => {
      console.error('SSE error', error);
      setIsConnected(false);
      setLastEvent({ type: 'error', data: 'Connection lost. Retrying...' });
      eventSource.close();
      
      // Auto-reconnect after 5 seconds
      setTimeout(() => {
        if (eventSourceRef.current === eventSource) {
          eventSourceRef.current = null;
        }
      }, 5000);
    };

    return () => {
      eventSource.close();
      setIsConnected(false);
      eventSourceRef.current = null;
    };
  }, [url, token]);

  return { lastEvent, isConnected };
}
