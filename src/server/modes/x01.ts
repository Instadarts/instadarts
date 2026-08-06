import type { GameState, Visit, DartThrow } from '../../shared/types';
import type { GameModeHandler, VisitResult } from './types';

/**
 * x01 game mode (301, 501, 701, etc.).
 *
 * Rules:
 * - Players start at the configured startScore.
 * - Each visit has 3 dart slots. Darts arrive one at a time via addDart.
 * - If doubleIn is set, the first scoring dart must be a double;
 *   non-double darts before the double-in score 0, and the entire visit
 *   is void if no double was hit.
 * - If doubleOut is set, the winning dart must be a double that
 *   brings the score exactly to 0.
 * - Bust: visit total would make remaining < 0, equals 1, or
 *   (with doubleOut) would leave 0 without a double finish.
 */

const MAX_DARTS = 3;

export class X01Handler implements GameModeHandler {
  private doubleInMet = new Map<string, boolean>();

  getRemainingScore(game: GameState, playerId: string): number {
    const startScore = game.settings.startScore;
    let remaining = startScore;
    for (const visit of game.visits) {
      if (visit.playerId !== playerId || visit.bust) continue;
      remaining -= visit.darts.reduce((sum, d) => sum + d.score.points, 0);
    }
    return Math.max(0, remaining);
  }

  // --- Per-dart operations ---

  addDart(game: GameState, playerId: string, dart: DartThrow): { game: GameState; locked: boolean } {
    let cv = game.currentVisit;
    if (!cv) cv = { playerId, darts: [], locked: false };
    if (cv.locked) return { game, locked: true };

    const newDarts = [...cv.darts, dart];
    const locked = this.checkLock(game, playerId, newDarts);

    return {
      game: { ...game, currentVisit: { playerId, darts: newDarts, locked } },
      locked,
    };
  }

  undoDart(game: GameState): { game: GameState } {
    const cv = game.currentVisit;
    if (!cv || cv.darts.length === 0) {
      return { game: { ...game, currentVisit: undefined } };
    }
    const newDarts = cv.darts.slice(0, -1);
    if (newDarts.length === 0) {
      return { game: { ...game, currentVisit: undefined } };
    }
    const locked = this.checkLock(game, cv.playerId, newDarts);
    return { game: { ...game, currentVisit: { playerId: cv.playerId, darts: newDarts, locked } } };
  }

  submitVisit(game: GameState): VisitResult {
    const cv = game.currentVisit;
    const playerId = cv?.playerId ?? game.players[game.currentPlayerIndex].id;
    const darts = cv?.darts ?? [];
    const remainingBefore = this.getRemainingScore(game, playerId);

    if (darts.length === 0) {
      // Zero-dart submit: commit as a valid visit with 3 misses (not a bust)
      return this.commitVisit(game, [], playerId, false, remainingBefore);
    }

    const settings = game.settings;
    return settings.doubleIn && !this.doubleInMet.get(playerId)
      ? this.finalizeDoubleInVisit(game, darts, playerId, remainingBefore)
      : this.finalizeNormalVisit(game, darts, playerId, remainingBefore);
  }

  // --- Lock detection ---

  private isBustScore(remainingAfter: number): boolean {
    return remainingAfter < 0 || remainingAfter === 1;
  }

  private isNoDoubleCheckout(lastDart: DartThrow, doubleOut: boolean, remainingAfter: number): boolean {
    return doubleOut && remainingAfter === 0 && lastDart.score.mult !== 2 && lastDart.score.label !== 'DB';
  }

  private checkLock(game: GameState, playerId: string, darts: DartThrow[]): boolean {
    if (darts.length >= MAX_DARTS) return true;

    const remainingBefore = this.getRemainingScore(game, playerId);
    const effectiveScore = this.computeEffectiveScore(game, playerId, darts);
    const remainingAfter = remainingBefore - effectiveScore;

    if (remainingAfter <= 0) return true;

    return false;
  }

  private computeEffectiveScore(game: GameState, playerId: string, darts: DartThrow[]): number {
    if (!game.settings.doubleIn || this.doubleInMet.get(playerId)) {
      return darts.reduce((sum, d) => sum + d.score.points, 0);
    }
    let effective = 0;
    let doubleHit = false;
    for (const dart of darts) {
      if (!doubleHit && (dart.score.mult === 2 || dart.score.label === 'DB')) doubleHit = true;
      if (doubleHit) effective += dart.score.points;
    }
    return effective;
  }

  // --- Visit finalization ---

  private finalizeNormalVisit(game: GameState, darts: DartThrow[], playerId: string, remainingBefore: number): VisitResult {
    const visitTotal = darts.reduce((sum, d) => sum + d.score.points, 0);
    const remainingAfter = remainingBefore - visitTotal;

    if (this.isBustScore(remainingAfter)) return this.commitVisit(game, darts, playerId, true, remainingBefore);
    if (this.isNoDoubleCheckout(darts[darts.length - 1], game.settings.doubleOut, remainingAfter)) {
      return this.commitVisit(game, darts, playerId, true, remainingBefore);
    }
    return this.commitVisit(game, darts, playerId, false, remainingAfter);
  }

  private finalizeDoubleInVisit(game: GameState, darts: DartThrow[], playerId: string, remainingBefore: number): VisitResult {
    const settings = game.settings;
    let doubleHit = false;
    let scoreAfterDouble = 0;
    const validDarts: DartThrow[] = [];

    for (const dart of darts) {
      if (!doubleHit) {
        if (dart.score.mult === 2 || dart.score.label === 'DB') {
          doubleHit = true;
          validDarts.push(dart);
          scoreAfterDouble += dart.score.points;
        }
      } else {
        validDarts.push(dart);
        scoreAfterDouble += dart.score.points;
      }
    }

    if (!doubleHit) return this.commitVisit(game, darts, playerId, true, remainingBefore);

    this.doubleInMet.set(playerId, true);
    const remainingAfter = remainingBefore - scoreAfterDouble;

    if (this.isBustScore(remainingAfter)) {
      this.doubleInMet.delete(playerId);
      return this.commitVisit(game, darts, playerId, true, remainingBefore);
    }
    if (this.isNoDoubleCheckout(darts[darts.length - 1], settings.doubleOut, remainingAfter)) {
      this.doubleInMet.delete(playerId);
      return this.commitVisit(game, darts, playerId, true, remainingBefore);
    }
    return this.commitVisit(game, validDarts, playerId, false, remainingAfter);
  }

  private commitVisit(game: GameState, darts: DartThrow[], playerId: string, bust: boolean, remainingScore: number): VisitResult {
    const visitNumber = game.visits.length + 1;
    // Pad non-bust visits with misses to 3 slots. Zero-dart bust visits also get 3 misses.
    const MISS = { x: 0, y: 0, score: { label: 'miss', points: 0, mult: 0, base: 0 } as const };
    const paddedDarts = (!bust || darts.length === 0)
      ? [...darts, ...Array.from({ length: Math.max(0, 3 - darts.length) }, () => ({ ...MISS, score: { ...MISS.score } }))]
      : darts;
    const visit: Visit = { playerId, darts: paddedDarts, visitNumber, bust };
    const newGame: GameState = { ...game, visits: [...game.visits, visit], currentVisit: undefined };

    if (bust) {
      newGame.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
      return { valid: false, game: newGame, remainingScore, won: false };
    }

    const won = remainingScore === 0;
    if (won) {
      newGame.status = 'finished';
      newGame.winnerId = playerId;
      newGame.finishedAt = Date.now();
    } else {
      newGame.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
    }
    return { valid: true, game: newGame, remainingScore, won };
  }

}
