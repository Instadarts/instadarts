import type { GameState, Visit } from '../shared/types';
import { getModeHandler } from './modes/types';

/**
 * Process a visit submission for the current game.
 * Returns the updated game state or an error message.
 */
export function processVisit(
  game: GameState,
  visit: Visit,
): { success: true; game: GameState } | { success: false; error: string } {
  if (game.status !== 'in_progress') {
    return { success: false, error: 'Game is not in progress' };
  }

  const handler = getModeHandler(game.settings.mode);
  if (!handler) {
    return { success: false, error: `Unknown game mode: ${game.settings.mode}` };
  }

  // Verify it's this player's turn
  const currentPlayer = game.players[game.currentPlayerIndex];
  if (visit.playerId !== currentPlayer.id) {
    return { success: false, error: 'Not your turn' };
  }

  const result = handler.processVisit(game, visit);
  return { success: true, game: result.game };
}
