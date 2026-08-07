import { describe, it, expect } from 'vitest';
import { addDartToMatch } from '../../src/server/match';
import { x01Remaining } from '../../src/server/modes/x01';
import { legOf, makeDart, makeMatch, playVisit, throwDart, undoDart } from '../helpers';
import type { MatchState } from '../../src/shared/types';

const remaining = (match: MatchState, playerId: string) => x01Remaining(legOf(match), playerId);

describe('Spectator / bad-actor match logic tests', () => {
  describe('turn enforcement', () => {
    it('accepts darts from the current player', () => {
      const match = playVisit(makeMatch({ currentPlayerIndex: 0 }), 'p1', ['T20', 'T20', 'T20']);
      expect(match.visits[0].voided).toBe(false);
      expect(remaining(match, 'p1')).toBe(321);
    });

    it('refuses a dart from the player whose turn it is not', () => {
      // The match layer owns this: whose visit it is is not a rule of any game mode.
      const result = addDartToMatch(makeMatch({ currentPlayerIndex: 0 }), 'p2', makeDart('T20'));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('Not your turn');
    });
  });

  describe('bust protection', () => {
    it('bust when score exceeds remaining', () => {
      const match = playVisit(makeMatch({ settings: { startScore: 40 } }), 'p1', ['T20']);
      expect(match.visits[0].voided).toBe(true);
      expect(remaining(match, 'p1')).toBe(40);
    });

    it('bust at 1 remaining', () => {
      const match = playVisit(makeMatch({ settings: { startScore: 2 } }), 'p1', ['S20']);
      expect(match.visits[0].voided).toBe(true);
      expect(remaining(match, 'p1')).toBe(2);
    });

    it('double-out: cannot win on a single', () => {
      const match = playVisit(makeMatch({ settings: { startScore: 20 } }), 'p1', ['S20']);
      expect(match.visits[0].voided).toBe(true);
      expect(match.status).toBe('in_progress');
      expect(match.winnerId).toBeNull();
    });

    it('double-out: D20 wins from 40', () => {
      const match = playVisit(makeMatch({ settings: { startScore: 40 } }), 'p1', ['D20']);
      expect(match.visits[0].voided).toBe(false);
      expect(match.status).toBe('finished');
      expect(match.winnerId).toBe('p1');
    });
  });

  describe('double-in', () => {
    it('requires a double to start scoring', () => {
      let match = makeMatch({ settings: { mode: 'x01', doubleIn: true, doubleOut: true, startScore: 501 } });
      match = playVisit(match, 'p1', ['S20', 'S20', 'S20']);
      expect(match.visits[0].voided).toBe(true);
      expect(remaining(match, 'p1')).toBe(501);

      match = playVisit(match, 'p2', []);
      match = playVisit(match, 'p1', ['D20', 'T20', 'T20']);
      expect(remaining(match, 'p1')).toBe(341);
    });

    it('all darts after double-in count', () => {
      const match = playVisit(
        makeMatch({ settings: { mode: 'x01', doubleIn: true, doubleOut: false, startScore: 501 } }),
        'p1',
        ['D20', 'T20', 'T20'],
      );
      expect(remaining(match, 'p1')).toBe(341);
    });
  });

  describe('miss darts', () => {
    it('handles visits with misses', () => {
      const match = playVisit(makeMatch({ settings: { startScore: 501 } }), 'p1', ['T20', 'miss', 'S20']);
      expect(match.visits[0].voided).toBe(false);
      expect(remaining(match, 'p1')).toBe(421);
    });
  });

  describe('per-dart lock/unlock', () => {
    it('locks on bust and unlocks on undo', () => {
      const r = throwDart(makeMatch({ settings: { startScore: 40 } }), 'p1', 'T20');
      expect(r.locked).toBe(true);
      expect(undoDart(r.match).currentVisit).toBeUndefined();
    });

    it('locks on 3 darts', () => {
      let r = throwDart(makeMatch(), 'p1', 'T20');
      r = throwDart(r.match, 'p1', 'T20');
      r = throwDart(r.match, 'p1', 'T20');
      expect(r.locked).toBe(true);
    });
  });
});
