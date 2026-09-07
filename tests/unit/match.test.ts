import { describe, it, expect } from 'vitest';
import { standingsOf } from '../../src/shared/matchFormat';
import type { MatchState } from '../../src/shared/types';
import { makeMatch, playVisit, visitsOf } from '../helpers';
import type { X01Over } from '../helpers';
import { addDartToMatch, submitVisitToMatch, undoDartFromMatch } from '../../src/server/match';
import { makeDart } from '../helpers';
import { registerMode } from '../../src/server/modes/types';
import { x01 } from '../../src/server/modes/x01';

/**
 * Leg → set → match progression, driven through the real submit path.
 *
 * Straight out from 180, so one visit of three trebles takes a leg and the tests can talk about
 * results rather than about darts.
 */

const quick = (over: X01Over = {}) =>
  makeMatch({ settings: { startScore: 180, doubleIn: false, doubleOut: false, ...over } });

const upNow = (match: MatchState) => match.players[match.currentPlayerIndex].id;

/** Whoever is up throws nothing, handing the board on. */
const pass = (match: MatchState) => playVisit(match, upNow(match), []);

/** Play until this player is up, then have them win the leg. */
function winLegBy(match: MatchState, playerId: string): MatchState {
  let current = match;
  while (upNow(current) !== playerId) current = pass(current);
  return playVisit(current, playerId, ['T20', 'T20', 'T20']);
}

/** The winners of every leg played, in order. */
const legWinners = (match: MatchState) => match.legs.map((leg) => leg.winnerId);

describe('a won leg', () => {
  it('closes the leg and starts the next one empty', () => {
    const match = winLegBy(quick({ legsToWinSet: 2 }), 'p1');

    expect(match.status).toBe('in_progress');
    expect(match.legs).toHaveLength(1);
    expect(match.legs[0].winnerId).toBe('p1');
    expect(match.visits).toEqual([]);          // the next leg starts from nothing
    expect(match.currentVisit).toBeUndefined();
    // The winning visit went with its leg rather than being left loose.
    expect(match.legs[0].visits.at(-1)!.voided).toBe(false);
  });

  it('hands the throw to the other player for the next leg', () => {
    const match = winLegBy(quick({ legsToWinSet: 3 }), 'p1');
    expect(match.currentPlayerIndex).toBe(1);
  });

  it('leaves the mode looking at an empty leg, so nothing carries over', () => {
    const match = winLegBy(quick({ legsToWinSet: 2 }), 'p1');
    // p1 won a leg from 180 and is back to 180: the score is derived from this leg's visits.
    expect(visitsOf(match)).toHaveLength(match.legs[0].visits.length);
    expect(match.visits).toEqual([]);
  });
});

describe('sets', () => {
  it('are won by the legs, and reset the leg count', () => {
    let match = quick({ legsToWinSet: 2, setsToWinMatch: 2 });
    match = winLegBy(match, 'p1');
    match = winLegBy(match, 'p1'); // takes the set

    const standings = standingsOf(match.legs, match.settings);
    expect(standings.setWins).toEqual({ p1: 1 });
    expect(standings.legWins).toEqual({});
    expect(match.status).toBe('in_progress'); // one set of two
  });

  it('start with the other player, whoever won the last leg', () => {
    let match = quick({ legsToWinSet: 2, setsToWinMatch: 2 });
    match = winLegBy(match, 'p1');
    match = winLegBy(match, 'p1'); // p1 won the set, including its last leg

    // Set 2 belongs to p2 regardless.
    expect(match.currentPlayerIndex).toBe(1);
  });

  it('end the match when the last one is taken', () => {
    let match = quick({ legsToWinSet: 2, setsToWinMatch: 2 });
    for (let i = 0; i < 4; i++) match = winLegBy(match, 'p1');

    expect(match.status).toBe('finished');
    expect(match.winnerId).toBe('p1');
    expect(match.legs).toHaveLength(4);
  });
});

describe('the default format', () => {
  it('is one set of one leg — a single play-through, as before sets existed', () => {
    const match = winLegBy(quick(), 'p1');
    expect(match.settings.setsToWinMatch).toBe(1);
    expect(match.settings.legsToWinSet).toBe(1);
    expect(match.status).toBe('finished');
    expect(match.winnerId).toBe('p1');
  });
});

describe('single-leg sets', () => {
  it('play exactly like legs without sets', () => {
    const asSets = (m: MatchState) => { let x = m; for (let i = 0; i < 3; i++) x = winLegBy(x, 'p1'); return x; };

    const sets = asSets(quick({ setsToWinMatch: 3, legsToWinSet: 1 }));
    const legs = asSets(quick({ setsToWinMatch: 1, legsToWinSet: 3 }));

    expect(legWinners(sets)).toEqual(legWinners(legs));
    expect(sets.status).toBe(legs.status);
    expect(sets.winnerId).toBe(legs.winnerId);
    expect(sets.legs).toHaveLength(legs.legs.length);
  });

  it('differ only in how the standings read', () => {
    let asSets = quick({ setsToWinMatch: 3, legsToWinSet: 1 });
    let asLegs = quick({ setsToWinMatch: 1, legsToWinSet: 3 });
    asSets = winLegBy(asSets, 'p1');
    asLegs = winLegBy(asLegs, 'p1');

    expect(standingsOf(asSets.legs, asSets.settings).setWins).toEqual({ p1: 1 });
    expect(standingsOf(asLegs.legs, asLegs.settings).legWins).toEqual({ p1: 1 });
  });
});

describe('a long match', () => {
  it('alternates the throw leg by leg and set by set', () => {
    // First to 2 sets of 3 legs, with the players trading legs.
    let match = quick({ legsToWinSet: 3, setsToWinMatch: 2 });
    const starters: number[] = [match.currentPlayerIndex];

    for (const winner of ['p1', 'p2', 'p1', 'p2']) {
      match = winLegBy(match, winner);
      if (match.status === 'in_progress') starters.push(match.currentPlayerIndex);
    }

    // Four legs of one set: the throw simply alternates.
    expect(starters).toEqual([0, 1, 0, 1, 0]);
    expect(standingsOf(match.legs, match.settings).legWins).toEqual({ p1: 2, p2: 2 });
  });
});

describe('the global leg visit limit', () => {
  const passedVisits = (count: number) => Array.from({ length: count }, (_, index) => ({
    darts: [], playerId: index % 2 === 0 ? 'p1' : 'p2', visitNumber: index + 1, voided: false,
  }));

  it('allows 499 visits and cancels on the 500th when the leg has no winner', () => {
    let match = makeMatch({ players: Array.from({ length: 5 }, (_, index) => ({
      id: `p${index + 1}`, name: `Player ${index + 1}`,
    })) });
    for (let i = 0; i < 499; i++) match = pass(match);
    expect(match.status).toBe('in_progress');
    expect(match.visits).toHaveLength(499);
    match = pass(match);
    expect(match.status).toBe('finished');
    expect(match.winnerId).toBeNull();
    expect(match.finishedAt).toEqual(expect.any(Number));
    expect(match.visits).toHaveLength(500);
    expect(match.currentVisit).toBeUndefined();
    expect(submitVisitToMatch(match).success).toBe(false);
    expect(addDartToMatch(match, upNow(match), makeDart('S20')).success).toBe(false);
    expect(undoDartFromMatch(match).success).toBe(false);
  });

  it('counts scored and voided visits toward the same limit', () => {
    const match = makeMatch({ visits: passedVisits(499).map((visit) => ({ ...visit, voided: true })) });
    const finished = playVisit(match, 'p1', ['S20']);
    expect(finished.status).toBe('finished');
    expect(finished.visits).toHaveLength(500);
    expect(finished.visits.at(-1)?.darts[0].score.points).toBe(20);
    expect(finished.winnerId).toBeNull();
  });

  it('allows a win on visit 500 and gives the next leg its own budget', () => {
    const match = { ...quick({ legsToWinSet: 2 }), visits: passedVisits(499) };
    const nextLeg = playVisit(match, 'p1', ['T20', 'T20', 'T20']);
    expect(nextLeg.status).toBe('in_progress');
    expect(nextLeg.legs[0].visits).toHaveLength(500);
    expect(nextLeg.visits).toHaveLength(0);
    const nextVisit = pass(nextLeg);
    expect(nextVisit.status).toBe('in_progress');
    expect(nextVisit.visits).toHaveLength(1);
  });

  it('keeps a match-winning result on visit 500', () => {
    const match = { ...quick(), visits: passedVisits(499) };
    const finished = playVisit(match, 'p1', ['T20', 'T20', 'T20']);
    expect(finished.status).toBe('finished');
    expect(finished.winnerId).toBe('p1');
    expect(finished.legs[0].visits).toHaveLength(500);
  });

  it('does not let a mode setting raise the global visit limit', () => {
    registerMode({ ...x01, id: 'long-leg', defaults: { ...x01.defaults, maxVisitsPerLeg: 1000 },
      fields: [...x01.fields, { key: 'maxVisitsPerLeg', label: 'Visit limit', kind: 'number', min: 1, max: 1000 }],
    });
    const match = makeMatch({ visits: passedVisits(499) });
    match.settings = { ...match.settings, mode: 'long-leg',
      modeSettings: { ...match.settings.modeSettings, maxVisitsPerLeg: 1000 } };
    expect(pass(match).status).toBe('finished');
  });
});
