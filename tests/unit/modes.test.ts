import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_MODE, allModes, describeMode, getMode, loadModes, registerMode } from '../../src/server/modes/types';
import { modeBans } from '../../src/shared/settings';
import { panelOf } from '../../src/server/match';
import { textOf } from '../../src/shared/types';
import { makeMatch, playVisit, throwDart } from '../helpers';
// The helpers register x01, which is all most of this file needs. The media declarations are only
// interesting where two modes disagree, so the second one is installed the way a deployment does it.
import '../../src/server/modes/whac-a-mole';
import { countUp } from '../../src/server/modes/count-up';
import type { MatchState } from '../../src/shared/types';

// A mode that caps itself at two players, because no shipped one does any more. Vitest isolates
// per file, so it goes no further — see docs/game-modes.md, "Limiting the player count".
registerMode({ ...countUp, id: 'two-only', label: 'Two Only', maxPlayers: 2 });

/**
 * Installing a mode is adding a file to src/server/modes/. These tests exercise the finding of them,
 * and what a found mode is then able to say for itself.
 */

describe('installed modes', () => {
  it('are found by scanning the directory', async () => {
    const modes = await loadModes();
    expect(modes.map((m) => m.id)).toContain('x01');
    expect(getMode('x01')).toBeDefined();
  });

  it('do not include the contract file itself', async () => {
    const modes = await loadModes();
    expect(modes.map((m) => m.id)).not.toContain('types');
  });

  it('include x01, which a deployment may not be without', async () => {
    // loadModes throws when it is missing; that it returns at all is the assertion.
    await expect(loadModes()).resolves.toBeDefined();
    expect(DEFAULT_MODE).toBe('x01');
    expect(getMode(DEFAULT_MODE)).toBeDefined();
  });

  it('describe themselves well enough for a lobby to offer them', async () => {
    await loadModes();
    const described = allModes().map(describeMode);

    const x01 = described.find((d) => d.id === 'x01')!;
    expect(x01.label).toBe('x01');
    expect(x01.defaults).toEqual({ startScore: 501, doubleIn: false, doubleOut: true, stats: 'graphic' });
    expect(x01.fields.map((f) => f.key)).toEqual(['startScore', 'doubleIn', 'doubleOut', 'stats']);
    expect(x01.maxPlayers).toBe(null);
  });

  it('declares maxPlayers, normalises silence to null, and narrows server cap', async () => {
    await loadModes();
    const described = allModes().map(describeMode);

    // No shipped mode declares one any more: x01 is a race of independent scores and Whac-A-Mole
    // counts turns rather than rounds, so neither has a rule about a second player. The mechanism
    // is exercised by a mode registered for the purpose.
    for (const id of ['x01', 'whac-a-mole', 'count-up']) {
      expect(described.find((d) => d.id === id)!.maxPlayers).toBe(null);
    }
    expect(described.find((d) => d.id === 'two-only')!.maxPlayers).toBe(2);

    const { effectiveMaxPlayers } = await import('../../src/shared/settings');
    expect(effectiveMaxPlayers(5, 2)).toBe(2);
    expect(effectiveMaxPlayers(5, null)).toBe(5);
    expect(effectiveMaxPlayers(5, undefined)).toBe(5);
    expect(effectiveMaxPlayers(2, 5)).toBe(2);
  });

  it('say which media features they do not want, and default to wanting all of them', async () => {
    await loadModes();
    const described = allModes().map(describeMode);

    // Optional to declare, always present to read: nobody consuming a descriptor has to tell
    // "declined none" from "did not say".
    const x01 = described.find((d) => d.id === 'x01')!;
    expect(x01.bansMedia).toEqual([]);
    expect(getMode('x01')!.bansMedia).toBeUndefined();

    // The board is drawn on for this one, so a picture of a real board cannot be laid over it.
    const whac = described.find((d) => d.id === 'whac-a-mole')!;
    expect(whac.bansMedia).toEqual(['boardVideo']);

    expect(modeBans(whac, 'boardVideo')).toBe(true);
    // Banning one is not banning the other — evidence stills are untouched here.
    expect(modeBans(whac, 'dartEvidence')).toBe(false);
    expect(modeBans(x01, 'boardVideo')).toBe(false);
  });

  it('withholds nothing for a mode this build has never heard of', () => {
    // A descriptor that has not arrived is not an instruction to take a feature away.
    expect(modeBans(undefined, 'boardVideo')).toBe(false);
    expect(modeBans(undefined, 'dartEvidence')).toBe(false);
  });

  it('keeps the statistics knob out of a production build', async () => {
    // The tests are a development build, so the production branch is only reachable by loading the
    // mode again under a different environment.
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const { x01: shipped } = await import('../../src/server/modes/x01');

      // Not offered, and — because the validator reads the same list — not settable either.
      expect(shipped.fields.map((f) => f.key)).toEqual(['startScore', 'doubleIn', 'doubleOut']);
      // The setting still exists. Production is simply always the one it defaults to.
      expect(shipped.defaults.stats).toBe('graphic');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('the x01 panel', () => {
  /** Alice wins a leg from 180 straight out; Bob throws one visit of 60. */
  function played(): MatchState {
    let match = makeMatch({ settings: { startScore: 180, doubleOut: false, legsToWinSet: 2 } });
    match = playVisit(match, 'p1', ['T20', 'S20', 'S20']); // 100, leaves 80
    match = playVisit(match, 'p2', ['T20', 'miss', 'miss']); // 60
    match = playVisit(match, 'p1', ['T20', 'S20', 'miss']);  // 80 → wins the leg
    return match;
  }

  it('identifies itself as statistics', () => {
    expect(panelOf(makeMatch())?.title).toBe('Statistics');
  });

  const rowsOf = (match: MatchState) => {
    const panel = panelOf(match)!;
    return Object.fromEntries(
      panel.rows.map((row) => [row.label, Object.fromEntries(Object.entries(row.values).map(([k, v]) => [k, textOf(v)]))]),
    );
  };

  it('reports statistics across the whole match, not just the current leg', () => {
    const match = played();
    expect(match.legs).toHaveLength(1); // one leg done, the next one open
    const rows = rowsOf(match);

    // Alice scored 180 off five darts: a full visit of 100, then out on the second dart of the next.
    expect(rows['3-dart average'].p1).toBe('108.0');
    expect(rows['3-dart average'].p2).toBe('60.0');
    expect(rows['Legs won']).toEqual({ p1: '1', p2: '0' });
    expect(rows['Best leg (darts)']).toEqual({ p1: '5', p2: '—' });
  });

  it('stops counting darts at the one that won the leg', () => {
    // 100 left: 60 then 40 is out on the second dart, and nobody throws a third after checking out.
    let match = makeMatch({ settings: { startScore: 100, doubleOut: false } });
    match = playVisit(match, 'p1', ['T20', 'D20', 'T20']);

    const winning = match.legs[0].visits.at(-1)!;
    expect(winning.darts.map((d) => d.score.label)).toEqual(['T20', 'D20']); // not padded to three
    expect(rowsOf(match)['Best leg (darts)'].p1).toBe('2');
    expect(rowsOf(match)['3-dart average'].p1).toBe('150.0');               // 100 off two darts
  });

  it('still counts a full three darts for a visit cut short by a bust', () => {
    // 40 left: the treble busts on the first dart, but the turn is over all the same.
    let match = makeMatch({ settings: { startScore: 41, doubleOut: false } });
    match = playVisit(match, 'p1', ['T20']);        // 60 into 41 → bust, one dart thrown
    match = playVisit(match, 'p2', []);
    match = playVisit(match, 'p1', ['S1', 'D20']);  // 41 → out on the second dart

    expect(match.legs[0].visits[0].darts).toHaveLength(1); // what was thrown
    // Three for the bust, two for the checkout: five darts for 41.
    expect(rowsOf(match)['Best leg (darts)'].p1).toBe('5');
  });

  it('counts a 180 when there is one', () => {
    let match = makeMatch({ settings: { startScore: 501 } });
    match = playVisit(match, 'p1', ['T20', 'T20', 'T20']);
    expect(rowsOf(match)['180s']).toEqual({ p1: '1', p2: '0' });
  });

  it('counts the round from one, turning over when the leg opener is back on', () => {
    const round = (match: MatchState) => textOf(panelOf(match)!.lines![0]);
    let match = makeMatch({ settings: { startScore: 501 } });

    // The visit about to be thrown counts, so a leg opens on round 1.
    match = throwDart(match, 'p1', 'T20').match;
    expect(round(match)).toBe('Round 1');

    match = playVisit(match, 'p1', ['T20']);   // Alice done: Bob is up, still round 1
    expect(round(match)).toBe('Round 1');

    match = playVisit(match, 'p2', ['T20']);   // back to Alice
    expect(round(match)).toBe('Round 2');
    match = playVisit(match, 'p1', ['T20']);
    expect(round(match)).toBe('Round 2');
    match = playVisit(match, 'p2', ['T20']);
    expect(round(match)).toBe('Round 3');
  });

  it('counts a submitted visit as three darts however it ended', () => {
    const darts = (match: MatchState) => rowsOf(match)['Darts this leg'];
    // 40 left: a treble twenty busts on the first dart, and the visit is over.
    let match = makeMatch({ settings: { startScore: 40 } });
    match = playVisit(match, 'p1', ['T20']);
    expect(match.visits[0].darts).toHaveLength(1); // one dart was actually thrown
    expect(darts(match).p1).toBe('3');             // but it cost a whole visit

    // Darts in hand count as they land.
    match = throwDart(match, 'p2', 'T20').match;
    expect(darts(match).p2).toBe('1');
  });

  it('counts darts for the current leg only', () => {
    let match = makeMatch({ settings: { startScore: 180, doubleOut: false, legsToWinSet: 2 } });
    match = playVisit(match, 'p1', ['T20', 'T20', 'T20']); // wins the leg
    expect(match.legs).toHaveLength(1);
    expect(rowsOf(match)['Darts this leg'].p1).toBe('0'); // a new leg, nothing thrown in it
  });

  it('leaves out visits thrown below 170, where a player is finishing rather than scoring', () => {
    const scoring = (match: MatchState) => rowsOf(match)['Scoring average'];

    // 501 → 341 → 181 → 61. The first three visits are scoring; the fourth is not.
    let match = makeMatch({ settings: { startScore: 501, doubleOut: false } });
    for (const _ of [1, 2, 3]) {
      match = playVisit(match, 'p1', ['T20', 'T20', 'miss']); // 120 each
      match = playVisit(match, 'p2', []);
    }
    expect(scoring(match).p1).toBe('120.0');

    // From 141, a 60 counts towards the three-dart average but not towards scoring.
    match = playVisit(match, 'p1', ['T20', 'miss', 'miss']);
    expect(scoring(match).p1).toBe('120.0');            // unchanged
    expect(rowsOf(match)['3-dart average'].p1).toBe('105.0'); // 420 over 4 visits
  });

  it('has no scoring average to report until a visit qualifies', () => {
    // Every visit is thrown from under 170, so none of them says anything about scoring.
    let match = makeMatch({ settings: { startScore: 101, doubleOut: false } });
    match = playVisit(match, 'p1', ['T20', 'miss', 'miss']);
    expect(rowsOf(match)['Scoring average'].p1).toBe('—');
  });

  it('reports nothing about the current leg once the match is over', () => {
    const match = playVisit(makeMatch({ settings: { startScore: 180, doubleOut: false } }), 'p1', ['T20', 'T20', 'T20']);
    expect(match.status).toBe('finished');

    const panel = panelOf(match)!;
    expect(panel.lines).toBeUndefined();
    expect(panel.rows.map((r) => r.label)).not.toContain('Darts this leg');
    expect(panel.rows.map((r) => r.label)).toContain('Legs won');
  });

  it('is there before a dart is thrown, so the screen does not jump when one is', () => {
    const rows = rowsOf(makeMatch());
    expect(rows['Darts this leg']).toEqual({ p1: '0', p2: '0' });
    expect(rows['3-dart average']).toEqual({ p1: '—', p2: '—' });
    expect(rows['Legs won']).toEqual({ p1: '0', p2: '0' });
  });

  it('draws itself the way the match asked, or not at all', () => {
    // Graphic and text are the same statistics drawn differently — the mode says which, the screen
    // obeys, and the rows do not change.
    const graphic = panelOf(makeMatch())!;
    expect(graphic.render).toBe('auto');

    const text = panelOf(makeMatch({ settings: { stats: 'text' } }))!;
    expect(text.render).toBe('table');
    expect(text.rows.map((r) => r.label)).toEqual(graphic.rows.map((r) => r.label));

    // Off is not a hidden panel: there is no panel, so nothing is computed and nothing is sent.
    expect(panelOf(makeMatch({ settings: { stats: 'off' } }))).toBeUndefined();
  });

  describe('with more than two players', () => {
    /** A roster of n, in the order the panel is expected to report them. */
    const roster = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}`, sessionId: `s${i + 1}` }));

    it('gives every player on the roster a value in every row, in roster order', () => {
      // What x01's own component reads: it derives the cards it draws from these keys, so their
      // presence and their order are the panel's side of that contract rather than a detail.
      const match = makeMatch({ players: roster(5), settings: { startScore: 501 } });
      const panel = panelOf(match)!;
      const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];

      expect(panel.rows.length).toBeGreaterThan(0);
      for (const row of panel.rows) expect(Object.keys(row.values)).toEqual(ids);

      // And the bars, which are the half a table cannot draw and the reason that file exists.
      const { recent } = panel.custom as { recent: Record<string, number[]> };
      expect(Object.keys(recent)).toEqual(ids);
    });

    it('counts a round as one visit each, however many players there are', () => {
      const round = (match: MatchState) => textOf(panelOf(match)!.lines![0]);
      let match = makeMatch({ players: roster(3), settings: { startScore: 501 } });

      expect(round(match)).toBe('Round 1');
      match = playVisit(match, 'p1', ['T20']);
      expect(round(match)).toBe('Round 1');
      match = playVisit(match, 'p2', ['T20']);
      expect(round(match)).toBe('Round 1'); // still the first time round the table
      match = playVisit(match, 'p3', ['T20']);
      expect(round(match)).toBe('Round 2');
    });

    it('reports legs won across the whole roster', () => {
      let match = makeMatch({
        players: roster(3),
        settings: { startScore: 40, doubleOut: false, legsToWinSet: 3 },
      });
      match = playVisit(match, 'p1', ['D20']); // takes leg 1
      match = playVisit(match, 'p2', ['D20']); // takes leg 2

      expect(rowsOf(match)['Legs won']).toEqual({ p1: '1', p2: '1', p3: '0' });
      expect(rowsOf(match)['Best leg (darts)']).toEqual({ p1: '1', p2: '1', p3: '—' });
    });
  });

  it('counts a void visit as thrown, which is what makes an average honest', () => {
    // 40 left, a treble 20 busts it: nothing scored, but the darts were still thrown.
    let match = makeMatch({ settings: { startScore: 40 } });
    match = playVisit(match, 'p1', ['T20']);
    expect(rowsOf(match)['3-dart average'].p1).toBe('0.0');
  });
});
