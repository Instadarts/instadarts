import { describe, it, expect } from 'vitest';
import { matchWinnerOf, standingsOf, starterIndex } from '../../src/shared/matchFormat';
import type { CompletedLeg, MatchSettings } from '../../src/shared/types';

/**
 * Standings are derived from the ordered leg winners and nothing else, so these tests can hand over
 * a list of winners and read off everything the match knows about itself.
 */

const format = (setsToWinMatch: number, legsToWinSet: number): MatchSettings => ({
  mode: 'x01',
  modeSettings: {},
  setsToWinMatch,
  legsToWinSet,
});

/** Legs from a string of winners: 'ABBA' is A, then B, then B, then A. */
const legs = (winners: string): CompletedLeg[] =>
  [...winners].map((winnerId) => ({ visits: [], winnerId }));

describe('standings', () => {
  it('count legs within the set being played', () => {
    const s = standingsOf(legs('ABA'), format(1, 3));
    expect(s.legWins).toEqual({ A: 2, B: 1 });
    expect(s.setWins).toEqual({});
    expect(s.legsInCurrentSet).toBe(3);
    expect(s.setsPlayed).toBe(0);
  });

  it('close a set and start the leg count again', () => {
    // First to 3 legs: A takes the set 3–1, and the fifth leg is the first of a new set.
    const s = standingsOf(legs('ABAAB'), format(3, 3));
    expect(s.setWins).toEqual({ A: 1 });
    expect(s.legWins).toEqual({ B: 1 }); // only the leg played since the set closed
    expect(s.setsPlayed).toBe(1);
    expect(s.legsInCurrentSet).toBe(1);
  });

  it('treat single-leg sets as a set per leg', () => {
    const s = standingsOf(legs('ABA'), format(3, 1));
    expect(s.setWins).toEqual({ A: 2, B: 1 });
    expect(s.legWins).toEqual({});
    expect(s.legsInCurrentSet).toBe(0);
  });

  it('report no winner until the sets are there', () => {
    const settings = format(2, 2);
    expect(matchWinnerOf(standingsOf(legs('AA'), settings), settings)).toBeNull();  // one set
    expect(matchWinnerOf(standingsOf(legs('AABB'), settings), settings)).toBeNull(); // one each
    expect(matchWinnerOf(standingsOf(legs('AABBAA'), settings), settings)).toBe('A');
  });

  it('decide a single-leg, single-set match on the first leg', () => {
    const settings = format(1, 1);
    expect(matchWinnerOf(standingsOf(legs('B'), settings), settings)).toBe('B');
  });
});

describe('who throws first', () => {
  const starter = (winners: string, settings: MatchSettings) =>
    starterIndex(standingsOf(legs(winners), settings), 2);

  it('alternates every leg within a set', () => {
    const settings = format(3, 3);
    expect(starter('', settings)).toBe(0);   // leg 1 of set 1
    expect(starter('A', settings)).toBe(1);  // leg 2
    expect(starter('AB', settings)).toBe(0); // leg 3
  });

  it('alternates per set as well, whoever won the last leg', () => {
    // The spec's example: first to 3 legs, the second player takes set 1 by 1–3 — winning its last
    // leg — and still throws first in set 2.
    const settings = format(3, 3);
    expect(starter('ABBB', settings)).toBe(1);
  });

  it('gives the first player the odd sets and the second the even ones', () => {
    const settings = format(5, 1); // one leg per set, so each leg closes a set
    expect(starter('', settings)).toBe(0);     // set 1
    expect(starter('A', settings)).toBe(1);    // set 2
    expect(starter('AA', settings)).toBe(0);   // set 3
    expect(starter('AAA', settings)).toBe(1);  // set 4
    expect(starter('AAAA', settings)).toBe(0); // set 5
  });

  it('never leaves a single player waiting for someone else', () => {
    expect(starterIndex(standingsOf(legs('AAA'), format(3, 1)), 1)).toBe(0);
  });
});
