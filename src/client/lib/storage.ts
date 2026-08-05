const STORAGE_KEY = 'instadarts_player_name';

export interface ClientStorage {
  getPlayerName(): string | null;
  setPlayerName(name: string): void;
}

/**
 * Minimal keyed storage for client-side persistence.
 * Currently wraps localStorage; easy to swap for another backend.
 */
export const storage: ClientStorage = {
  getPlayerName(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },

  setPlayerName(name: string): void {
    try {
      localStorage.setItem(STORAGE_KEY, name);
    } catch {
      // ignore
    }
  },
};
