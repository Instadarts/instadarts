import { describe, it, expect, beforeEach } from 'vitest';
import { X01Handler } from '../../src/server/modes/x01';
import type { GameState, ScoreResult } from '../../src/shared/types';

function makeDart(label: string, x = 500_000, y = 500_000) {
  const darts: Record<string, ScoreResult> = {
    'T20': { label: 'T20', points: 60, mult: 3, base: 20 },
    'T19': { label: 'T19', points: 57, mult: 3, base: 19 },
    'T18': { label: 'T18', points: 54, mult: 3, base: 18 },
    'T17': { label: 'T17', points: 51, mult: 3, base: 17 },
    'S20': { label: 'S20', points: 20, mult: 1, base: 20 },
    'S19': { label: 'S19', points: 19, mult: 1, base: 19 },
    'S18': { label: 'S18', points: 18, mult: 1, base: 18 },
    'S5':  { label: 'S5',  points: 5,  mult: 1, base: 5 },
    'S1':  { label: 'S1',  points: 1,  mult: 1, base: 1 },
    'D20': { label: 'D20', points: 40, mult: 2, base: 20 },
    'D16': { label: 'D16', points: 32, mult: 2, base: 16 },
    'D10': { label: 'D10', points: 20, mult: 2, base: 10 },
    'D8':  { label: 'D8',  points: 16, mult: 2, base: 8 },
    'D4':  { label: 'D4',  points: 8,  mult: 2, base: 4 },
    'DB':  { label: 'DB',  points: 50, mult: 2, base: 25 },
    'SB':  { label: 'SB',  points: 25, mult: 1, base: 25 },
    'miss':{ label: 'miss',points: 0,  mult: 0, base: 0 },
  };
  const score = darts[label];
  if (!score) throw new Error(`Unknown dart label: ${label}`);
  return { x, y, score };
}

function makeGame(overrides: Partial<GameState> = {}): GameState {
  return {
    id: 'test-game',
    status: 'in_progress',
    settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 501 },
    players: [
      { id: 'p1', name: 'Alice', isRemote: false, sessionId: 's1' },
      { id: 'p2', name: 'Bob', isRemote: false, sessionId: 's2' },
    ],
    visits: [],
    currentPlayerIndex: 0,
    winnerId: null,
    createdAt: 0,
    finishedAt: null,
    isLocal: false,
    ...overrides,
  };
}

/** Add darts one by one then submit. */
function doVisit(handler: X01Handler, game: GameState, playerId: string, labels: string[]) {
  let g = game;
  for (const label of labels) {
    const r = handler.addDart(g, playerId, makeDart(label));
    g = r.game;
  }
  return handler.submitVisit(g);
}

describe('X01Handler', () => {
  let handler: X01Handler;

  beforeEach(() => {
    handler = new X01Handler();
  });

  describe('basic scoring', () => {
    it('subtracts visit total from starting score', () => {
      const game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 501 } });
      const result = doVisit(handler, game, 'p1', ['T20', 'T20', 'T20']); // 180
      expect(result.valid).toBe(true);
      expect(result.remainingScore).toBe(321);
      expect(result.won).toBe(false);
      expect(result.game.currentPlayerIndex).toBe(1);
    });

    it('accumulates multiple visits', () => {
      let game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 301 } });
      let result = doVisit(handler, game, 'p1', ['T20', 'S20', 'miss']); // 80
      game = result.game;
      expect(result.remainingScore).toBe(221);
      result = doVisit(handler, game, 'p2', ['S20', 'S20', 'S20']); // 60
      game = result.game;
      expect(result.remainingScore).toBe(241);
      result = doVisit(handler, game, 'p1', ['T20', 'S20', 'S20']); // 100
      expect(result.remainingScore).toBe(121);
    });
  });

  describe('bust rules', () => {
    it('bust when score exceeds remaining', () => {
      const game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 40 } });
      const result = doVisit(handler, game, 'p1', ['T20']); // 60 > 40
      expect(result.valid).toBe(false);
      expect(result.remainingScore).toBe(40);
      expect(result.game.currentPlayerIndex).toBe(1);
    });

    it('bust when score equals 1', () => {
      const game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 20 } });
      const result = doVisit(handler, game, 'p1', ['S19']); // 19, leaves 1
      expect(result.valid).toBe(false);
      expect(result.remainingScore).toBe(20);
    });
  });

  describe('double-out', () => {
    it('wins with a double checkout', () => {
      const game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 32 } });
      const result = doVisit(handler, game, 'p1', ['D16']); // 32
      expect(result.valid).toBe(true);
      expect(result.won).toBe(true);
      expect(result.game.status).toBe('finished');
      expect(result.game.winnerId).toBe('p1');
    });

    it('bust when finishing on a single with 0 remaining', () => {
      const game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 20 } });
      const result = doVisit(handler, game, 'p1', ['S20']); // 20, but not a double
      expect(result.valid).toBe(false);
      expect(result.remainingScore).toBe(20);
    });

    it('wins with double bull checkout', () => {
      const game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 50 } });
      const result = doVisit(handler, game, 'p1', ['DB']);
      expect(result.won).toBe(true);
    });

    it('D8 checkout from 16', () => {
      const game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 16 } });
      const result = doVisit(handler, game, 'p1', ['D8']);
      expect(result.won).toBe(true);
    });
  });

  describe('double-in', () => {
    it('requires a double to start scoring', () => {
      const handler2 = new X01Handler();
      const game = makeGame({ settings: { mode: 'x01', doubleIn: true, doubleOut: true, startScore: 501 } });
      let result = doVisit(handler2, game, 'p1', ['S20', 'T20', 'T20']);
      expect(result.valid).toBe(false);
      expect(result.remainingScore).toBe(501);
      result = doVisit(handler2, result.game, 'p1', ['S20', 'D20', 'T20']); // 40+60=100
      expect(result.valid).toBe(true);
      expect(result.remainingScore).toBe(401);
    });

    it('first dart being a double counts all subsequent darts', () => {
      const handler2 = new X01Handler();
      const game = makeGame({ settings: { mode: 'x01', doubleIn: true, doubleOut: false, startScore: 501 } });
      const result = doVisit(handler2, game, 'p1', ['D20', 'T20', 'T20']); // 160
      expect(result.valid).toBe(true);
      expect(result.remainingScore).toBe(341);
    });

    it('all three darts can count if first is a double', () => {
      const handler2 = new X01Handler();
      const game = makeGame({ settings: { mode: 'x01', doubleIn: true, doubleOut: false, startScore: 501 } });
      const result = doVisit(handler2, game, 'p1', ['D16', 'T20', 'T20']); // 152
      expect(result.valid).toBe(true);
      expect(result.remainingScore).toBe(349);
    });
  });

  describe('getRemainingScore', () => {
    it('returns startScore with no visits', () => {
      const game = makeGame();
      expect(handler.getRemainingScore(game, 'p1')).toBe(501);
    });

    it('returns correct remaining after multiple visits', () => {
      let game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: false, startScore: 501 } });
      let result = doVisit(handler, game, 'p1', ['T20', 'T20', 'T20']);
      game = result.game;
      result = doVisit(handler, game, 'p1', ['T20', 'T20', 'T20']);
      game = result.game;
      expect(handler.getRemainingScore(game, 'p1')).toBe(141); // 501 - 360
    });
  });

  describe('per-dart operations', () => {
    it('addDart builds up currentVisit', () => {
      const game = makeGame();
      const r1 = handler.addDart(game, 'p1', makeDart('T20'));
      expect(r1.game.currentVisit?.darts).toHaveLength(1);
      expect(r1.locked).toBe(false);
      const r2 = handler.addDart(r1.game, 'p1', makeDart('T20'));
      expect(r2.game.currentVisit?.darts).toHaveLength(2);
    });

    it('addDart locks after 3 darts', () => {
      const game = makeGame();
      let r = handler.addDart(game, 'p1', makeDart('T20'));
      r = handler.addDart(r.game, 'p1', makeDart('T20'));
      r = handler.addDart(r.game, 'p1', makeDart('T20'));
      expect(r.locked).toBe(true);
    });

    it('addDart locks on bust', () => {
      const game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 40 } });
      const r = handler.addDart(game, 'p1', makeDart('T20')); // 60 > 40
      expect(r.locked).toBe(true);
    });

    it('undoDart removes last dart (LIFO)', () => {
      const game = makeGame();
      let r = handler.addDart(game, 'p1', makeDart('T20'));
      r = handler.addDart(r.game, 'p1', makeDart('S20'));
      expect(r.game.currentVisit?.darts).toHaveLength(2);
      const undo = handler.undoDart(r.game);
      expect(undo.game.currentVisit?.darts).toHaveLength(1);
      expect(undo.game.currentVisit!.darts[0].score.label).toBe('T20');
    });

    it('undoDart unlocks a locked visit', () => {
      const game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 40 } });
      let r = handler.addDart(game, 'p1', makeDart('T20')); // bust, locked
      expect(r.locked).toBe(true);
      const undo = handler.undoDart(r.game);
      expect(undo.game.currentVisit).toBeUndefined();
      // Can add again
      const r2 = handler.addDart(undo.game, 'p1', makeDart('S20'));
      expect(r2.locked).toBe(false);
    });

    it('submitVisit clears currentVisit', () => {
      const game = makeGame();
      let r = handler.addDart(game, 'p1', makeDart('T20'));
      r = handler.addDart(r.game, 'p1', makeDart('T20'));
      r = handler.addDart(r.game, 'p1', makeDart('T20'));
      const result = handler.submitVisit(r.game);
      expect(result.game.currentVisit).toBeUndefined();
      expect(result.game.visits).toHaveLength(1);
    });
  });
});
