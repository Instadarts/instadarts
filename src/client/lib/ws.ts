const RECONNECT_KEY = 'instadarts_reconnect';

/**
 * What this tab presents to get its place back after a reload.
 *
 * Only ever what the server sent in a `resume`: the room, and the token that stands for the place
 * held in it. Nothing here is derived from a lobby or a match — those arrive at spectators too, and
 * a tab that writes down a player id it merely watched is a tab that can ask to become that player.
 */
interface ReconnectInfo {
  lobbyId?: string;
  matchId?: string;
  token: string;
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
  // Always same-origin: one server answers the page and the socket in every run, development
  // included. A phone on the LAN then needs one reachable port, and https gives us wss for free.
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}
