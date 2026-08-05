import { getAllGames, deleteGame, getAllLobbies, deleteLobby } from './store';

const GC_INTERVAL_MS = 30_000;
const FINISHED_GAME_TTL_MS = 5 * 60 * 1000;
const IDLE_LOBBY_TTL_MS = 10 * 60 * 1000;

let lobbiesCollected = 0;
let gamesCollected = 0;
let lastRunAt: number | null = null;
let lastDurationMs = 0;

export function getGCStats() {
  return {
    lobbiesCollected,
    gamesCollected,
    lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
    lastDurationMs,
  };
}

export function startGC(): NodeJS.Timeout {
  return setInterval(() => {
    const start = Date.now();
    const now = start;

    for (const [id, game] of getAllGames()) {
      if (game.status === 'finished' && game.finishedAt) {
        if (now - game.finishedAt > FINISHED_GAME_TTL_MS) {
          deleteGame(id);
          gamesCollected++;
        }
      }
    }

    for (const [id, lobby] of getAllLobbies()) {
      if (now - lobby.createdAt > IDLE_LOBBY_TTL_MS) {
        deleteLobby(id);
        lobbiesCollected++;
      }
    }

    lastRunAt = now;
    lastDurationMs = Date.now() - start;
  }, GC_INTERVAL_MS);
}
