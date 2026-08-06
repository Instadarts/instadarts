import { useEffect, useRef, useCallback, useState } from 'react';
import type { ServerMessage } from '../../shared/protocol';
import { getWsUrl, saveReconnectInfo, loadReconnectInfo, clearReconnectInfo } from '../lib/ws';

type MessageHandler = (msg: ServerMessage) => void;

interface Options {
  /**
   * Whether to resume a lobby or match on connect. The gaming frontend does; the scoring app must
   * not, or a scorer opened in the same tab would try to rejoin the player's game.
   */
  resumeSession?: boolean;
}

export function useWebSocket(onMessage: MessageHandler, options: Options = {}) {
  const resumeSession = options.resumeSession !== false;
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reconnectAttempt = useRef(0);
  const intentionalClose = useRef(false);
  const pendingMessages = useRef<object[]>([]);
  const handlerRef = useRef(onMessage);
  useEffect(() => { handlerRef.current = onMessage; });

  const flushPending = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const msg of pendingMessages.current) {
      ws.send(JSON.stringify(msg));
    }
    pendingMessages.current = [];
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (wsRef.current?.readyState === WebSocket.CONNECTING) return;

    intentionalClose.current = false;
    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectAttempt.current = 0;
      flushPending();

      // Check for reconnect info (page reload recovery)
      const info = resumeSession ? loadReconnectInfo() : null;
      if (info) {
        ws.send(JSON.stringify({
          type: 'reconnect',
          lobbyId: info.lobbyId,
          gameId: info.gameId,
          playerId: info.playerId,
        }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handlerRef.current(msg);
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      setConnected(false);
      if (intentionalClose.current) return;
      // Auto-reconnect with exponential backoff
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt.current), 10000);
      reconnectAttempt.current++;
      reconnectTimer.current = setTimeout(connect, delay);
    };
  }, [resumeSession]);

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    } else {
      pendingMessages.current.push(msg);
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      intentionalClose.current = true;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { send, connected };
}
