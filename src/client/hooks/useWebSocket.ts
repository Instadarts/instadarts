import { useEffect, useRef, useCallback, useState } from 'react';
import type { ServerMessage } from '../../shared/protocol';
import { getWsUrl, loadReconnectInfo } from '../lib/ws';
import { e2eEnabled } from '../lib/e2e';

type MessageHandler = (msg: ServerMessage) => void;

interface Options {
  /**
   * Whether to resume a lobby or match on connect. The gaming frontend does; the scoring app must
   * not, or a scorer opened in the same tab would try to rejoin the player's match.
   */
  resumeSession?: boolean;
  /**
   * Hang up and stay hung up. A scoring device that has given up waiting closes its socket to save
   * both ends the cost of holding it, and the backoff below must not immediately undo that — which
   * it would, one second later, since every other close here is one worth retrying.
   */
  standby?: boolean;
}

export function useWebSocket(onMessage: MessageHandler, options: Options = {}) {
  const resumeSession = options.resumeSession !== false;
  const standby = options.standby === true;
  const standbyRef = useRef(standby);
  standbyRef.current = standby;
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [generation, setGeneration] = useState(0);
  const generationRef = useRef(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
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
      generationRef.current += 1;
      setGeneration(generationRef.current);
      reconnectAttempt.current = 0;
      flushPending();

      // Check for reconnect info (page reload recovery)
      const info = resumeSession ? loadReconnectInfo() : null;
      if (info?.token) {
        ws.send(JSON.stringify({
          type: 'reconnect',
          lobbyId: info.lobbyId,
          matchId: info.matchId,
          token: info.token,
        }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'connected' && typeof msg.sessionId === 'string') {
          sessionIdRef.current = msg.sessionId;
          setSessionId(msg.sessionId);
        }
        handlerRef.current(msg);
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      setConnected(false);
      if (intentionalClose.current || standbyRef.current) return;
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
    if (standby) {
      // Anything queued while asleep would be sent on waking, minutes later, describing a moment
      // that has passed. Nothing here is worth that.
      pendingMessages.current = [];
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      return;
    }
    connect();
    return () => {
      intentionalClose.current = true;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect, standby]);

  // The browser's offline emulation does not sever an established WebSocket. This guarded seam
  // lets an e2e test create the real close/reconnect lifecycle without replacing the transport.
  useEffect(() => {
    if (!e2eEnabled()) return;
    const target = window as unknown as {
      __scorerLink?: SocketE2E;
      __ws?: SocketE2E;
    };
    const seam: SocketE2E = {
      disconnect: () => {
        intentionalClose.current = true;
        clearTimeout(reconnectTimer.current);
        wsRef.current?.close();
      },
      drop: () => {
        intentionalClose.current = false;
        clearTimeout(reconnectTimer.current);
        wsRef.current?.close();
      },
      reconnect: connect,
      pendingMessages: () => pendingMessages.current.length,
      generation: () => generationRef.current,
      sessionId: () => sessionIdRef.current,
    };
    target.__scorerLink = seam;
    target.__ws = seam;
    return () => { delete target.__scorerLink; delete target.__ws; };
  }, [connect]);

  return { send, connected, generation, sessionId };
}

interface SocketE2E {
  disconnect: () => void;
  /** Abrupt replacement: unlike disconnect, this allows the normal backoff to reconnect. */
  drop: () => void;
  reconnect: () => void;
  pendingMessages: () => number;
  generation: () => number;
  sessionId: () => string | null;
}
