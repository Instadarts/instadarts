import type { GameState, Visit, DartThrow } from '../../shared/types';
import type { GameModeHandler, VisitResult } from './types';

/**
 * x01 game mode (301, 501, 701, etc.).
 *
 * Rules:
 * - Players start at the configured startScore.
 * - Each visit's dart scores are summed and subtracted from remaining.
 * - If doubleIn is set, the first scoring dart must be a double;
 *   non-double darts in that visit score 0, and the entire visit
 *   is void if no double was hit.
 * - If doubleOut is set, the winning dart must be a double that
 *   brings the score exactly to 0.
 * - Bust: visit total would make remaining < 0, equals 1, or
 *   (with doubleOut) would leave 0 without a double finish.
 */

export class X01Handler implements GameModeHandler {
  // Track whether each player has satisfied double-in
  private doubleInMet = new Map<string, boolean>();

  getRemainingScore(game: GameState, playerId: string): number {
    const startScore = game.settings.startScore;
    let remaining = startScore;

    for (const visit of game.visits) {
      if (visit.playerId !== playerId) continue;
      if (visit.bust) continue;
      const visitTotal = visit.darts.reduce((sum, d) => sum + d.score.points, 0);
      remaining -= visitTotal;
    }

    return Math.max(0, remaining);
  }

  processVisit(game: GameState, visit: Visit): VisitResult {
    const settings = game.settings;
    const playerId = visit.playerId;
    const remainingBefore = this.getRemainingScore(game, playerId);

    // Check double-in requirement
    if (settings.doubleIn && !this.doubleInMet.get(playerId)) {
      return this.processDoubleInVisit(game, visit, remainingBefore);
    }

    // Normal visit processing
    const visitTotal = visit.darts.reduce((sum, d) => sum + d.score.points, 0);
    const remainingAfter = remainingBefore - visitTotal;

    // Bust checks
    if (remainingAfter < 0) {
      return this.bustResult(game, visit, remainingBefore);
    }

    if (remainingAfter === 1) {
      return this.bustResult(game, visit, remainingBefore);
    }

    // Double-out check
    if (settings.doubleOut && remainingAfter === 0) {
      const lastDart = visit.darts[visit.darts.length - 1];
      if (lastDart.score.mult !== 2 && lastDart.score.label !== 'DB') {
        // Must finish on a double (DB counts as double)
        return this.bustResult(game, visit, remainingBefore);
      }
    }

    // Valid visit — apply it
    const newGame = this.applyVisit(game, visit);
    const won = remainingAfter === 0;

    if (won) {
      newGame.status = 'finished';
      newGame.winnerId = playerId;
      newGame.finishedAt = Date.now();
    } else {
      // Advance to next player
      newGame.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
    }

    return {
      valid: true,
      game: newGame,
      remainingScore: remainingAfter,
      won,
    };
  }

  private processDoubleInVisit(
    game: GameState,
    visit: Visit,
    remainingBefore: number,
  ): VisitResult {
    const settings = game.settings;
    const playerId = visit.playerId;

    // Find first dart that is a double
    let doubleHit = false;
    let scoreAfterDouble = 0;
    const validDarts: DartThrow[] = [];

    for (const dart of visit.darts) {
      if (!doubleHit) {
        if (dart.score.mult === 2 || dart.score.label === 'DB') {
          doubleHit = true;
          validDarts.push(dart);
          scoreAfterDouble += dart.score.points;
        }
        // Non-double darts before the double-in are ignored (score 0)
      } else {
        validDarts.push(dart);
        scoreAfterDouble += dart.score.points;
      }
    }

    if (!doubleHit) {
      // No double hit — entire visit is void (bust)
      return this.bustResult(game, visit, remainingBefore);
    }

    this.doubleInMet.set(playerId, true);
    const remainingAfter = remainingBefore - scoreAfterDouble;

    // Check bust on remaining
    if (remainingAfter < 0) {
      this.doubleInMet.delete(playerId); // reset double-in status
      return this.bustResult(game, visit, remainingBefore);
    }

    if (remainingAfter === 1) {
      this.doubleInMet.delete(playerId);
      return this.bustResult(game, visit, remainingBefore);
    }

    // Double-out check
    if (settings.doubleOut && remainingAfter === 0) {
      const lastDart = visit.darts[visit.darts.length - 1];
      if (lastDart.score.mult !== 2 && lastDart.score.label !== 'DB') {
        this.doubleInMet.delete(playerId);
        return this.bustResult(game, visit, remainingBefore);
      }
    }

    // Apply the visit with only valid darts
    const modifiedVisit: Visit = {
      ...visit,
      darts: validDarts,
    };
    const newGame = this.applyVisit(game, modifiedVisit);
    const won = remainingAfter === 0;

    if (won) {
      newGame.status = 'finished';
      newGame.winnerId = playerId;
      newGame.finishedAt = Date.now();
    } else {
      newGame.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
    }

    return {
      valid: true,
      game: newGame,
      remainingScore: remainingAfter,
      won,
    };
  }

  private bustResult(
    game: GameState,
    _visit: Visit,
    remainingBefore: number,
  ): VisitResult {
    const bustVisit: Visit = {
      ..._visit,
      bust: true,
    };
    const newGame = this.applyVisit(game, bustVisit);
    newGame.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;

    return {
      valid: false,
      game: newGame,
      remainingScore: remainingBefore,
      won: false,
    };
  }

  private applyVisit(game: GameState, visit: Visit): GameState {
    const visitNumber = game.visits.length + 1;
    return {
      ...game,
      visits: [...game.visits, { ...visit, visitNumber }],
    };
  }

  /** Reset double-in status (e.g., for new game) */
  reset(): void {
    this.doubleInMet.clear();
  }
}
