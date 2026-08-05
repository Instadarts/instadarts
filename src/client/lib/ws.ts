const RECONNECT_URL_KEY = 'instadarts_reconnect';

/**
 * Store reconnect info in sessionStorage so a page refresh can restore state.
 */
export function saveReconnectInfo(gameId: string, playerId: string): void {
  try {
    sessionStorage.setItem(RECONNECT_URL_KEY, JSON.stringify({ gameId, playerId }));
  } catch {
    // sessionStorage unavailable
  }
}

export function loadReconnectInfo(): { gameId: string; playerId: string } | null {
  try {
    const raw = sessionStorage.getItem(RECONNECT_URL_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearReconnectInfo(): void {
  try {
    sessionStorage.removeItem(RECONNECT_URL_KEY);
  } catch {
    // ignore
  }
}

const WS_URL = `ws://${window.location.hostname}:3000/ws`;

/**
 * Create a WebSocket connection with auto-reconnect.
 * Returns [ws, send] tuple.
 */
export function createWS(): WebSocket {
  const ws = new WebSocket(WS_URL);
  return ws;
}

export function getWsUrl(): string {
  // In dev, Vite proxies /ws; in production, connect directly
  if (import.meta.env.DEV) {
    return `ws://${window.location.hostname}:3000/ws`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}
