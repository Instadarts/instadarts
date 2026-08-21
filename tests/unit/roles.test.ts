// The match layer's turn and ownership rules — the part of "who may do what" that is decided by
// `match.ts` rather than by a socket.
//
// This file used to also claim to cover leaving, reconnecting and lobby permissions, with tests that
// built a finished match and asserted it was finished. Those behaviours are now covered where they
// actually happen, at the handler level:
//
//   · leaving, and what it does to a match — tests/unit/rematch.test.ts, tests/unit/nplayers.test.ts
//   · one user holding every player      — tests/unit/one-user.test.ts
//   · who owns a player, and how many    — tests/unit/nplayers.test.ts

import { describe, it, expect } from 'vitest';
import { addDartToMatch, undoDartFromMatch } from '../../src/server/match';
import { makeDart, makeMatch, playVisit } from '../helpers';

describe('whose visit it is', () => {
  it('records the visit against the player who threw it', () => {
    const match = playVisit(makeMatch(), 'p1', ['T20', 'T20', 'T20']);
    expect(match.visits[0].voided).toBe(false);
    expect(match.visits[0].playerId).toBe('p1');
  });

  it('refuses a dart for a player whose turn it is not', () => {
    const match = makeMatch({ currentPlayerIndex: 0 });
    const result = addDartToMatch(match, 'p2', makeDart('T20'));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('Not your turn');
  });

  it('accepts a dart for the player who is up', () => {
    const match = makeMatch({ currentPlayerIndex: 0 });
    expect(addDartToMatch(match, 'p1', makeDart('T20')).success).toBe(true);
  });

  it('ends the match when the mode says a dart won it', () => {
    const match = makeMatch({
      settings: { mode: 'x01', doubleIn: false, doubleOut: true, startScore: 40 },
    });
    const finished = playVisit(match, 'p1', ['D20']);
    expect(finished.status).toBe('finished');
    expect(finished.winnerId).toBe('p1');
  });
});

describe('undoing a dart', () => {
  it('takes back the last one and leaves the rest', () => {
    const match = makeMatch({ currentPlayerIndex: 0 });
    let r = addDartToMatch(match, 'p1', makeDart('T20'));
    expect(r.success).toBe(true);
    r = addDartToMatch(r.match, 'p1', makeDart('S20'));
    expect(r.success).toBe(true);
    const undo = undoDartFromMatch(r.match);
    expect(undo.success).toBe(true);
    expect(undo.match.currentVisit?.darts).toHaveLength(1);
    expect(undo.match.currentVisit!.darts[0].score.label).toBe('T20');
  });

  it('is refused once the match is over', () => {
    const match = makeMatch({ status: 'finished', winnerId: 'p1' });
    const result = undoDartFromMatch(match);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe('Match is not in progress');
  });

  it('with nothing to take back leaves a clean visit', () => {
    const result = undoDartFromMatch(makeMatch());
    expect(result.success).toBe(true);
    expect(result.match.currentVisit).toBeUndefined();
  });
});
