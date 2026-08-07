import { describe, it, expect } from 'vitest';
import { x01, x01NeedsDoubleIn, x01Remaining } from '../../src/server/modes/x01';
import { legOf, makeMatch, playVisit, submitVisit, throwDart, undoDart } from '../helpers';
import type { X01Over } from '../helpers';
import type { MatchState } from '../../src/shared/types';

/** What the mode says this player has left. */
const remaining = (match: MatchState, playerId: string) => x01Remaining(legOf(match), playerId);

const settings = (over: X01Over = {}): X01Over => ({ doubleIn: false, doubleOut: true, startScore: 501, ...over });

describe('x01', () => {
  describe('basic scoring', () => {
    it('subtracts visit total from starting score', () => {
      const match = playVisit(makeMatch({ settings: settings() }), 'p1', ['T20', 'T20', 'T20']); // 180
      expect(remaining(match, 'p1')).toBe(321);
      expect(match.status).toBe('in_progress');
      expect(match.currentPlayerIndex).toBe(1);
    });

    it('accumulates multiple visits', () => {
      let match = makeMatch({ settings: settings({ startScore: 301 }) });
      match = playVisit(match, 'p1', ['T20', 'S20', 'miss']); // 80
      expect(remaining(match, 'p1')).toBe(221);
      match = playVisit(match, 'p2', ['S20', 'S20', 'S20']); // 60
      expect(remaining(match, 'p2')).toBe(241);
      match = playVisit(match, 'p1', ['T20', 'S20', 'S20']); // 100
      expect(remaining(match, 'p1')).toBe(121);
    });
  });

  describe('bust rules', () => {
    it('bust when score exceeds remaining', () => {
      const match = playVisit(makeMatch({ settings: settings({ startScore: 40 }) }), 'p1', ['T20']); // 60 > 40
      expect(match.visits[0].voided).toBe(true);
      expect(remaining(match, 'p1')).toBe(40);
      expect(match.currentPlayerIndex).toBe(1);
    });

    it('bust when score equals 1', () => {
      const match = playVisit(makeMatch({ settings: settings({ startScore: 20 }) }), 'p1', ['S19']); // leaves 1
      expect(match.visits[0].voided).toBe(true);
      expect(remaining(match, 'p1')).toBe(20);
    });

    it('leaving 1 is NOT a bust under straight out — a single 1 checks it out', () => {
      const match = playVisit(makeMatch({ settings: settings({ doubleOut: false, startScore: 20 }) }), 'p1', ['S19']);
      expect(match.visits[0].voided).toBe(false);
      expect(remaining(match, 'p1')).toBe(1);
    });

    it('a straight-out player left on 1 finishes on the single', () => {
      const match = playVisit(makeMatch({ settings: settings({ doubleOut: false, startScore: 1 }) }), 'p1', ['S1']);
      expect(match.status).toBe('finished');
      expect(match.winnerId).toBe('p1');
    });

    it('locks the visit the moment it leaves 1 under double out', () => {
      // Nothing thrown after this can help, and a player left on one should be told so rather than
      // being invited to throw the rest of the visit.
      const r = throwDart(makeMatch({ settings: settings({ startScore: 21 }) }), 'p1', 'S20'); // leaves 1
      expect(r.locked).toBe(true);
      expect(r.match.currentVisit!.darts).toHaveLength(1);

      // And it stays a one-dart voided visit.
      const submitted = submitVisit(r.match);
      expect(submitted.visits[0].voided).toBe(true);
      expect(submitted.visits[0].darts).toHaveLength(1);
    });

    it('does not lock on 1 under straight out', () => {
      const r = throwDart(makeMatch({ settings: settings({ doubleOut: false, startScore: 21 }) }), 'p1', 'S20');
      expect(r.locked).toBe(false);

      const finish = throwDart(r.match, 'p1', 'S1');
      expect(finish.locked).toBe(true);
      expect(submitVisit(finish.match).status).toBe('finished');
    });

    it('unlocks again when the dart that left 1 is undone', () => {
      const r = throwDart(makeMatch({ settings: settings({ startScore: 61 }) }), 'p1', 'T20'); // leaves 1
      expect(r.locked).toBe(true);

      const undone = undoDart(r.match);
      expect(undone.currentVisit).toBeUndefined();

      expect(throwDart(undone, 'p1', 'S20').locked).toBe(false); // leaves 41 — still alive
    });
  });

  describe('double-out', () => {
    it('wins with a double checkout', () => {
      const match = playVisit(makeMatch({ settings: settings({ startScore: 32 }) }), 'p1', ['D16']);
      expect(match.visits[0].voided).toBe(false);
      expect(match.status).toBe('finished');
      expect(match.winnerId).toBe('p1');
    });

    it('bust when finishing on a single with 0 remaining', () => {
      const match = playVisit(makeMatch({ settings: settings({ startScore: 20 }) }), 'p1', ['S20']); // not a double
      expect(match.visits[0].voided).toBe(true);
      expect(match.status).toBe('in_progress');
      expect(remaining(match, 'p1')).toBe(20);
    });

    it('wins with double bull checkout', () => {
      expect(playVisit(makeMatch({ settings: settings({ startScore: 50 }) }), 'p1', ['DB']).winnerId).toBe('p1');
    });

    it('D8 checkout from 16', () => {
      expect(playVisit(makeMatch({ settings: settings({ startScore: 16 }) }), 'p1', ['D8']).winnerId).toBe('p1');
    });
  });

  describe('double-in', () => {
    it('requires a double to start scoring', () => {
      let match = makeMatch({ settings: settings({ doubleIn: true }) });
      match = playVisit(match, 'p1', ['S20', 'T20', 'T20']);
      expect(match.visits[0].voided).toBe(true);
      expect(remaining(match, 'p1')).toBe(501);

      match = playVisit(match, 'p2', []); // hand the board back
      match = playVisit(match, 'p1', ['S20', 'D20', 'T20']); // 40 + 60 = 100
      expect(remaining(match, 'p1')).toBe(401);
    });

    it('first dart being a double counts all subsequent darts', () => {
      const match = playVisit(makeMatch({ settings: settings({ doubleIn: true, doubleOut: false }) }), 'p1', ['D20', 'T20', 'T20']);
      expect(remaining(match, 'p1')).toBe(341); // 501 - 160
    });

    it('all three darts can count if first is a double', () => {
      const match = playVisit(makeMatch({ settings: settings({ doubleIn: true, doubleOut: false }) }), 'p1', ['D16', 'T20', 'T20']);
      expect(remaining(match, 'p1')).toBe(349); // 501 - 152
    });

    it('is satisfied once, and stays satisfied through a later bust', () => {
      let match = makeMatch({ settings: settings({ doubleIn: true, startScore: 200 }) });
      match = playVisit(match, 'p1', ['D20']); // 40 — doubled in
      expect(x01NeedsDoubleIn(legOf(match), 'p1')).toBe(false);

      match = playVisit(match, 'p2', []);
      match = playVisit(match, 'p1', ['T20', 'T20', 'T20']); // 180 > 160 → bust
      expect(match.visits[2].voided).toBe(true);
      expect(x01NeedsDoubleIn(legOf(match), 'p1')).toBe(false);
      expect(remaining(match, 'p1')).toBe(160);
    });

    it('a zero-dart submit does not satisfy double-in', () => {
      // It commits three misses as a non-void visit. Keying off "any non-void visit" would let the
      // player start scoring without ever having hit a double.
      let match = makeMatch({ settings: settings({ doubleIn: true }) });
      match = playVisit(match, 'p1', []);
      expect(match.visits[0].voided).toBe(false);
      expect(x01NeedsDoubleIn(legOf(match), 'p1')).toBe(true);

      match = playVisit(match, 'p2', []);
      match = playVisit(match, 'p1', ['T20', 'T20', 'T20']); // still no double → scores nothing
      expect(match.visits[2].voided).toBe(true);
      expect(remaining(match, 'p1')).toBe(501);
    });
  });

  describe('remaining score', () => {
    it('returns startScore with no visits', () => {
      expect(remaining(makeMatch(), 'p1')).toBe(501);
    });

    it('returns correct remaining after multiple visits', () => {
      let match = makeMatch({ settings: settings({ doubleOut: false }) });
      match = playVisit(match, 'p1', ['T20', 'T20', 'T20']);
      match = playVisit(match, 'p2', []);
      match = playVisit(match, 'p1', ['T20', 'T20', 'T20']);
      expect(remaining(match, 'p1')).toBe(141); // 501 - 360
    });
  });

  describe('per-dart operations', () => {
    it('builds up currentVisit', () => {
      const r1 = throwDart(makeMatch(), 'p1', 'T20');
      expect(r1.match.currentVisit?.darts).toHaveLength(1);
      expect(r1.locked).toBe(false);
      expect(throwDart(r1.match, 'p1', 'T20').match.currentVisit?.darts).toHaveLength(2);
    });

    it('locks after 3 darts', () => {
      let r = throwDart(makeMatch(), 'p1', 'T20');
      r = throwDart(r.match, 'p1', 'T20');
      r = throwDart(r.match, 'p1', 'T20');
      expect(r.locked).toBe(true);
    });

    it('locks on bust', () => {
      expect(throwDart(makeMatch({ settings: settings({ startScore: 40 }) }), 'p1', 'T20').locked).toBe(true);
    });

    it('undo removes the last dart (LIFO)', () => {
      let r = throwDart(makeMatch(), 'p1', 'T20');
      r = throwDart(r.match, 'p1', 'S20');
      expect(r.match.currentVisit?.darts).toHaveLength(2);
      const undone = undoDart(r.match);
      expect(undone.currentVisit?.darts).toHaveLength(1);
      expect(undone.currentVisit!.darts[0].score.label).toBe('T20');
    });

    it('undo unlocks a locked visit', () => {
      const r = throwDart(makeMatch({ settings: settings({ startScore: 40 }) }), 'p1', 'T20'); // bust, locked
      expect(r.locked).toBe(true);
      const undone = undoDart(r.match);
      expect(undone.currentVisit).toBeUndefined();
      expect(throwDart(undone, 'p1', 'S20').locked).toBe(false);
    });

    it('a locked visit refuses further darts without erroring', () => {
      let r = throwDart(makeMatch(), 'p1', 'T20');
      r = throwDart(r.match, 'p1', 'T20');
      r = throwDart(r.match, 'p1', 'T20');
      const fourth = throwDart(r.match, 'p1', 'T20');
      expect(fourth.locked).toBe(true);
      expect(fourth.match.currentVisit?.darts).toHaveLength(3);
    });

    it('submit clears currentVisit', () => {
      let r = throwDart(makeMatch(), 'p1', 'T20');
      r = throwDart(r.match, 'p1', 'T20');
      const match = submitVisit(r.match);
      expect(match.currentVisit).toBeUndefined();
      expect(match.visits).toHaveLength(1);
    });
  });

  describe('zero-dart submit (auto-miss)', () => {
    it('creates a visit of 3 misses', () => {
      const match = submitVisit(makeMatch());
      expect(match.visits).toHaveLength(1);
      expect(match.visits[0].voided).toBe(false);
      expect(match.visits[0].darts).toHaveLength(3);
      expect(match.visits[0].darts.every((d) => d.score.label === 'miss')).toBe(true);
    });

    it('advances to the next player', () => {
      expect(submitVisit(makeMatch({ currentPlayerIndex: 0 })).currentPlayerIndex).toBe(1);
    });

    it('does not score any points', () => {
      const match = submitVisit(makeMatch({ settings: settings({ startScore: 301 }) }));
      expect(remaining(match, 'p1')).toBe(301);
    });
  });

  describe('the mode itself', () => {
    it('reports three darts per visit', () => {
      expect(x01.dartsPerVisit(makeMatch().settings)).toBe(3);
    });

    it('never writes match state — finalizeVisit only reports a leg winner', () => {
      const r = throwDart(makeMatch({ settings: settings({ startScore: 32 }) }), 'p1', 'D16');
      const finalized = x01.finalizeVisit(legOf(r.match));
      expect(finalized.legWinnerId).toBe('p1');
      expect(Object.keys(finalized)).toEqual(['visit', 'legWinnerId']);
    });
  });
});
