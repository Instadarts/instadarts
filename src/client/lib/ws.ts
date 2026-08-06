const RECONNECT_KEY = 'instadarts_reconnect';

interface ReconnectInfo {
  lobbyId?: string;
  gameId?: string;
  playerId: string;
}

/**
 * Store reconnect info in sessionStorage so a page refresh can restore state.
 */
export function saveReconnectInfo(info: ReconnectInfo): void {
  try {
    sessionStorage.setItem(RECONNECT_KEY, JSON.stringify(info));
  } catch {
    // sessionStorage unavailable
  }
}

export function loadReconnectInfo(): ReconnectInfo | null {
  try {
    const raw = sessionStorage.getItem(RECONNECT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearReconnectInfo(): void {
  try {
    sessionStorage.removeItem(RECONNECT_KEY);
  } catch {
    // ignore
  }
}

export function getWsUrl(): string {
  // Always same-origin: Vite proxies /ws in dev, the server serves it in production. A phone on
  // the LAN then needs one reachable port, not two, and https gives us wss for free.
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}
