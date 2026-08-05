import type { GameState, DartThrow } from '../../shared/types';

/**
 * Result of processing a visit.
 */
export interface VisitResult {
  /** Whether the visit is valid (not a bust) */
  valid: boolean;
  /** The updated game state */
  game: GameState;
  /** Remaining score for the player after this visit */
  remainingScore: number;
  /** Whether the player won on this visit */
  won: boolean;
}

/**
 * A game mode processes darts incrementally and finalizes visits.
 */
export interface GameModeHandler {
  /** Add a dart to the current visit. Returns whether the visit is now locked. */
  addDart(game: GameState, playerId: string, dart: DartThrow): { game: GameState; locked: boolean };

  /** Remove the last dart from the current visit (LIFO). */
  undoDart(game: GameState): { game: GameState };

  /** Submit the current visit — finalize it into visits[], advance turn, check win. */
  submitVisit(game: GameState): VisitResult;

  /** Get the remaining score for a player. */
  getRemainingScore(game: GameState, playerId: string): number;
}

/**
 * Registry of game mode handlers.
 */
const handlers: Record<string, GameModeHandler> = {};

export function registerModeHandler(mode: string, handler: GameModeHandler): void {
  handlers[mode] = handler;
}

export function getModeHandler(mode: string): GameModeHandler | undefined {
  return handlers[mode];
}
