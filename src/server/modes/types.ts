import type { GameState, Visit } from '../../shared/types';

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
 * A game mode processes visits and determines win conditions.
 */
export interface GameModeHandler {
  /** Process a visit: validate, compute new score, check win/bust. */
  processVisit(game: GameState, visit: Visit): VisitResult;

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
