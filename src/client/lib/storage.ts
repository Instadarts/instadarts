const NAMES_KEY = 'instadarts_player_names';
const MAX_NAMES = 5;

export interface ClientStorage {
  getPlayerNames(): string[];
  addPlayerName(name: string): void;
}

/**
 * Persisted player names list (FIFO, max 5, most-recently-used first).
 */
export const storage: ClientStorage = {
  getPlayerNames(): string[] {
    try {
      const raw = localStorage.getItem(NAMES_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  addPlayerName(name: string): void {
    try {
      const names = storage.getPlayerNames().filter((n) => n !== name);
      names.unshift(name);
      if (names.length > MAX_NAMES) names.pop();
      localStorage.setItem(NAMES_KEY, JSON.stringify(names));
    } catch {
      // ignore
    }
  },
};
