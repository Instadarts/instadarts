import { describe, it, expect } from 'vitest';
import { X01Handler } from '../../src/server/modes/x01';
import { makeDart, makeGame } from '../helpers';
import type { GameState } from '../../src/shared/types';

function doVisit(handler: X01Handler, game: GameState, playerId: string, labels: string[]) {
  let g = game;
  for (const label of labels) { const r = handler.addDart(g, playerId, makeDart(label)); g = r.game; }
  return handler.submitVisit(g);
}

describe('Spectator / bad-actor game logic tests', () => {
  describe('turn enforcement', () => {
    it('accepts darts from current player', () => {
      const handler = new X01Handler();
      const game = makeGame({ currentPlayerIndex: 0 });
      const result = doVisit(handler, game, 'p1', ['T20', 'T20', 'T20']);
      expect(result.valid).toBe(true);
      expect(result.remainingScore).toBe(321);
    });

    it('mode processes any playerId (wsHandler enforces turn order)', () => {
      const handler = new X01Handler();
      const game = makeGame({ currentPlayerIndex: 0 });
      const result = doVisit(handler, game, 'p2', ['T20', 'T20', 'T20']);
      expect(result.valid).toBe(true);
      expect(result.remainingScore).toBe(321);
    });
  });

  describe('bust protection', () => {
    const handler = new X01Handler();
    it('bust when score exceeds remaining', () => {
      const game = makeGame({ settings: { startScore: 40 } });
      const result = doVisit(handler, game, 'p1', ['T20']);
      expect(result.valid).toBe(false);
      expect(result.remainingScore).toBe(40);
    });
    it('bust at 1 remaining', () => {
      const game = makeGame({ settings: { startScore: 2 } });
      const result = doVisit(handler, game, 'p1', ['S20']);
      expect(result.valid).toBe(false);
      expect(result.remainingScore).toBe(2);
    });
    it('double-out: cannot win on single', () => {
      const game = makeGame({ settings: { startScore: 20 } });
      const result = doVisit(handler, game, 'p1', ['S20']);
      expect(result.valid).toBe(false);
      expect(result.won).toBe(false);
    });
    it('double-out: D20 wins from 40', () => {
      const game = makeGame({ settings: { startScore: 40 } });
      const result = doVisit(handler, game, 'p1', ['D20']);
      expect(result.valid).toBe(true);
      expect(result.won).toBe(true);
      expect(result.game.status).toBe('finished');
      expect(result.game.winnerId).toBe('p1');
    });
  });

  describe('double-in', () => {
    it('requires double to start scoring', () => {
      const h = new X01Handler();
      const game = makeGame({ settings: { mode: 'x01', doubleIn: true, doubleOut: true, startScore: 501 } });
      let result = doVisit(h, game, 'p1', ['S20', 'S20', 'S20']);
      expect(result.valid).toBe(false);
      expect(result.remainingScore).toBe(501);
      result = doVisit(h, result.game, 'p1', ['D20', 'T20', 'T20']);
      expect(result.valid).toBe(true);
      expect(result.remainingScore).toBe(341);
    });
    it('all darts after double-in count', () => {
      const h = new X01Handler();
      const game = makeGame({ settings: { mode: 'x01', doubleIn: true, doubleOut: false, startScore: 501 } });
      const result = doVisit(h, game, 'p1', ['D20', 'T20', 'T20']);
      expect(result.valid).toBe(true);
      expect(result.remainingScore).toBe(341);
    });
  });

  describe('miss darts', () => {
    const handler = new X01Handler();
    it('handles visits with misses', () => {
      const game = makeGame({ settings: { startScore: 501 } });
      const result = doVisit(handler, game, 'p1', ['T20', 'miss', 'S20']);
      expect(result.valid).toBe(true);
      expect(result.remainingScore).toBe(421);
    });
  });

  describe('per-dart lock/unlock', () => {
    const handler = new X01Handler();
    it('locks on bust and unlocks on undo', () => {
      const game = makeGame({ settings: { startScore: 40 } });
      const r = handler.addDart(game, 'p1', makeDart('T20'));
      expect(r.locked).toBe(true);
      const undo = handler.undoDart(r.game);
      expect(undo.game.currentVisit).toBeUndefined();
    });
    it('locks on 3 darts', () => {
      const game = makeGame();
      let r = handler.addDart(game, 'p1', makeDart('T20'));
      r = handler.addDart(r.game, 'p1', makeDart('T20'));
      r = handler.addDart(r.game, 'p1', makeDart('T20'));
      expect(r.locked).toBe(true);
    });
  });
});
