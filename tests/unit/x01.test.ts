import { describe, it, expect, beforeEach } from 'vitest';
import { X01Handler } from '../../src/server/modes/x01';
import type { GameState } from '../../src/shared/types';
import { makeDart, makeGame } from '../helpers';

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

    it('leaving 1 is NOT a bust under straight out — a single 1 checks it out', () => {
      const game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: false, startScore: 20 } });
      const result = doVisit(handler, game, 'p1', ['S19']); // 19, leaves 1
      expect(result.valid).toBe(true);
      expect(result.remainingScore).toBe(1);
    });

    it('a straight-out player left on 1 finishes on the single', () => {
      const game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: false, startScore: 1 } });
      const result = doVisit(handler, game, 'p1', ['S1']);
      expect(result.won).toBe(true);
      expect(result.game.status).toBe('finished');
    });

    it('locks the visit the moment it leaves 1 under double out', () => {
      // Nothing thrown after this can help, and a player left on one should be told so rather than
      // being invited to throw the rest of the visit.
      const game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 21 } });
      const r = handler.addDart(game, 'p1', makeDart('S20')); // leaves 1
      expect(r.locked).toBe(true);
      expect(r.game.currentVisit!.darts).toHaveLength(1);

      // And it stays a one-dart busted visit.
      const submitted = handler.submitVisit(r.game);
      expect(submitted.valid).toBe(false);
      expect(submitted.game.visits[0].bust).toBe(true);
      expect(submitted.game.visits[0].darts).toHaveLength(1);
    });

    it('does not lock on 1 under straight out', () => {
      const game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: false, startScore: 21 } });
      const r = handler.addDart(game, 'p1', makeDart('S20')); // leaves 1
      expect(r.locked).toBe(false);

      const finish = handler.addDart(r.game, 'p1', makeDart('S1'));
      expect(finish.locked).toBe(true);
      expect(handler.submitVisit(finish.game).won).toBe(true);
    });

    it('unlocks again when the dart that left 1 is undone', () => {
      const game = makeGame({ settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 61 } });
      let r = handler.addDart(game, 'p1', makeDart('T20')); // 60 thrown, leaves 1
      expect(r.locked).toBe(true);

      const undo = handler.undoDart(r.game);
      expect(undo.game.currentVisit).toBeUndefined();

      r = handler.addDart(undo.game, 'p1', makeDart('S20')); // leaves 41 — still alive
      expect(r.locked).toBe(false);
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

  describe('zero-dart submit (auto-miss)', () => {
    it('submitting with no darts creates a visit of 3 misses', () => {
      const game = makeGame();
      // Submit without adding any darts first
      const result = handler.submitVisit(game);
      expect(result.valid).toBe(true);
      expect(result.game.visits).toHaveLength(1);
      expect(result.game.visits[0].darts).toHaveLength(3);
      expect(result.game.visits[0].darts.every(d => d.score.label === 'miss')).toBe(true);
    });

    it('auto-miss visit advances to next player', () => {
      const game = makeGame({ currentPlayerIndex: 0 });
      const result = handler.submitVisit(game);
      expect(result.game.currentPlayerIndex).toBe(1);
    });

    it('auto-miss does not score any points', () => {
      const game = makeGame({ settings: { startScore: 301 } });
      const result = handler.submitVisit(game);
      expect(result.remainingScore).toBe(301);
    });
  });
});
