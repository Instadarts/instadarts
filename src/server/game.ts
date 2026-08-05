import type { GameState, DartThrow } from '../shared/types';
import { getModeHandler } from './modes/types';
import type { VisitResult } from './modes/types';

export function addDartToGame(
  game: GameState,
  playerId: string,
  dart: DartThrow,
): { success: true; game: GameState; locked: boolean } | { success: false; error: string } {
  if (game.status !== 'in_progress') return { success: false, error: 'Game is not in progress' };
  const handler = getModeHandler(game.settings.mode);
  if (!handler) return { success: false, error: `Unknown game mode: ${game.settings.mode}` };
  const currentPlayer = game.players[game.currentPlayerIndex];
  if (playerId !== currentPlayer.id) return { success: false, error: 'Not your turn' };
  const result = handler.addDart(game, playerId, dart);
  return { success: true, game: result.game, locked: result.locked };
}

export function undoDartFromGame(
  game: GameState,
): { success: true; game: GameState } | { success: false; error: string } {
  if (game.status !== 'in_progress') return { success: false, error: 'Game is not in progress' };
  const handler = getModeHandler(game.settings.mode);
  if (!handler) return { success: false, error: `Unknown game mode: ${game.settings.mode}` };
  const result = handler.undoDart(game);
  return { success: true, game: result.game };
}

export function submitVisitToGame(
  game: GameState,
): { success: true; result: VisitResult } | { success: false; error: string } {
  if (game.status !== 'in_progress') return { success: false, error: 'Game is not in progress' };
  const handler = getModeHandler(game.settings.mode);
  if (!handler) return { success: false, error: `Unknown game mode: ${game.settings.mode}` };
  const result = handler.submitVisit(game);
  return { success: true, result };
}
