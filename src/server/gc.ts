import { getAllGames, deleteGame, getAllLobbies, deleteLobby } from './store';

const GC_INTERVAL_MS = 30_000;
const FINISHED_TTL_MS = 5 * 60 * 1000;
const DISCONNECTED_TTL_MS = 2 * 60 * 1000;

/**
 * Start the garbage collector.
 * Periodically removes finished and abandoned games.
 */
export function startGC(): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();

    for (const [id, game] of getAllGames()) {
      if (game.status === 'finished') {
        // Games include a timestamp via their id generation order;
        // for simplicity, we check if the game has been finished for a while.
        // Since we don't store timestamps yet, we just remove all finished games.
        // TODO: add createdAt/finishedAt to GameState when needed.
        deleteGame(id);
      }
    }
  }, GC_INTERVAL_MS);
}
