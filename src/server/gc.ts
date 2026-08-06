import { getAllGames, deleteGame, getAllLobbies, deleteLobby } from './store';
import { sweepScoringSessions } from './scoring/store';

const GC_INTERVAL_MS = 30_000;
const FINISHED_GAME_TTL_MS = 5 * 60 * 1000;
const IDLE_LOBBY_TTL_MS = 10 * 60 * 1000;

let lobbiesCollected = 0;
let gamesCollected = 0;
let scoringSessionsCollected = 0;
let lastRunAt: number | null = null;
let lastDurationMs = 0;

export function getGCStats() {
  return {
    lobbiesCollected,
    gamesCollected,
    scoringSessionsCollected,
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

    // Scoring sessions hold a live throw-window timer, and an abandoned in-progress match is never
    // collected above — so they are swept on their own terms rather than with the game.
    scoringSessionsCollected += sweepScoringSessions();

    lastRunAt = now;
    lastDurationMs = Date.now() - start;
  }, GC_INTERVAL_MS);
}
