import { getAllGames, deleteGame, getAllLobbies, deleteLobby } from './store';

const GC_INTERVAL_MS = 30_000;
const FINISHED_GAME_TTL_MS = 5 * 60 * 1000;
const IDLE_LOBBY_TTL_MS = 10 * 60 * 1000;

export function startGC(): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();

    for (const [id, game] of getAllGames()) {
      if (game.status === 'finished' && game.finishedAt) {
        if (now - game.finishedAt > FINISHED_GAME_TTL_MS) {
          deleteGame(id);
        }
      }
    }

    for (const [id, lobby] of getAllLobbies()) {
      if (now - lobby.createdAt > IDLE_LOBBY_TTL_MS) {
        deleteLobby(id);
      }
    }
  }, GC_INTERVAL_MS);
}
