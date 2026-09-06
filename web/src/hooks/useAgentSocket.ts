import { useEffect, useRef, useState, useCallback } from 'react';

export interface WebSocketMessage {
  type: string;
  [key: string]: any;
}

export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected';

export function useAgentSocket(onMessage?: (msg: WebSocketMessage) => void) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('reconnecting');
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionState('connected');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          onMessageRef.current?.(data);
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        setConnectionState('reconnecting');
        // Reconnect after delay
        setTimeout(() => {
          connect();
        }, 2000);
      };

      ws.onerror = () => {
        setConnectionState('disconnected');
        ws.close();
      };
    } catch {
      setConnectionState('disconnected');
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((payload: any) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  return {
    connected: connectionState === 'connected',
    connectionState,
    send
  };
}
