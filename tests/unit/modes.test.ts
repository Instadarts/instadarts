import { describe, it, expect } from 'vitest';
import { DEFAULT_MODE, allModes, describeMode, getMode, loadModes } from '../../src/server/modes/types';
import { panelOf } from '../../src/server/match';
import { textOf } from '../../src/shared/types';
import { makeMatch, playVisit } from '../helpers';
import type { MatchState } from '../../src/shared/types';

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
    expect(x01.defaults).toEqual({ startScore: 501, doubleIn: false, doubleOut: true });
    expect(x01.fields.map((f) => f.key)).toEqual(['startScore', 'doubleIn', 'doubleOut']);
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

    // Alice threw two visits, 100 and 80.
    expect(rows['3-dart average'].p1).toBe('90.0');
    expect(rows['3-dart average'].p2).toBe('60.0');
    expect(rows['Legs won']).toEqual({ p1: '1', p2: '0' });
    expect(rows['Best leg (darts)']).toEqual({ p1: '6', p2: '—' });
  });

  it('counts a 180 when there is one', () => {
    let match = makeMatch({ settings: { startScore: 501 } });
    match = playVisit(match, 'p1', ['T20', 'T20', 'T20']);
    expect(rowsOf(match)['180s']).toEqual({ p1: '1', p2: '0' });
  });

  it('says nothing before a dart is thrown', () => {
    expect(panelOf(makeMatch())!.rows).toEqual([]);
  });

  it('counts a void visit as thrown, which is what makes an average honest', () => {
    // 40 left, a treble 20 busts it: nothing scored, but the darts were still thrown.
    let match = makeMatch({ settings: { startScore: 40 } });
    match = playVisit(match, 'p1', ['T20']);
    expect(rowsOf(match)['3-dart average'].p1).toBe('0.0');
  });
});
