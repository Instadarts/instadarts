import { describe, expect, it } from 'vitest';
import { makeBalancedCardLayout, makeLobbyLayout } from '../../src/client/layout/frontendLayout';

function positions(cols: number) {
  return makeLobbyLayout(cols).map(({ i, x, w }) => ({ i, x, w }));
}

describe('generated lobby layouts', () => {
  it('preserves the validated stock breakpoint geometry', () => {
    expect(positions(12)).toEqual([
      { i: 'overview', x: 0, w: 12 },
      { i: 'players', x: 1, w: 5 },
      { i: 'match-settings', x: 6, w: 5 },
      { i: 'mode-settings', x: 1, w: 5 },
      { i: 'invite', x: 6, w: 5 },
    ]);
    expect(positions(10)).toEqual([
      { i: 'overview', x: 0, w: 10 },
      { i: 'players', x: 0, w: 5 },
      { i: 'match-settings', x: 5, w: 5 },
      { i: 'mode-settings', x: 0, w: 5 },
      { i: 'invite', x: 5, w: 5 },
    ]);
    expect(positions(6)).toEqual([
      { i: 'overview', x: 0, w: 6 },
      { i: 'players', x: 0, w: 3 },
      { i: 'match-settings', x: 3, w: 3 },
      { i: 'mode-settings', x: 0, w: 3 },
      { i: 'invite', x: 3, w: 3 },
    ]);
  });

  it('centers equal-width cards when no allowed width fills the row', () => {
    expect(positions(14)).toEqual([
      { i: 'overview', x: 0, w: 14 },
      { i: 'players', x: 2, w: 5 },
      { i: 'match-settings', x: 7, w: 5 },
      { i: 'mode-settings', x: 2, w: 5 },
      { i: 'invite', x: 7, w: 5 },
    ]);
  });

  it('accepts different card constraints for other page layouts', () => {
    const layout = makeBalancedCardLayout(
      12,
      [
        { i: 'one', h: 1 },
        { i: 'two', h: 1 },
        { i: 'three', h: 1 },
      ],
      { minimumCardWidth: 3, maximumCardWidth: 5, maximumCardsPerRow: 3 },
    );

    expect(layout.map(({ x, w }) => ({ x, w }))).toEqual([
      { x: 0, w: 4 },
      { x: 4, w: 4 },
      { x: 8, w: 4 },
    ]);
  });

  it('fits the narrower generated layouts within their column bounds', () => {
    for (const cols of [4, 2]) {
      for (const item of makeLobbyLayout(cols)) {
        expect(item.x).toBeGreaterThanOrEqual(0);
        expect(item.x + item.w).toBeLessThanOrEqual(cols);
      }
    }
  });
});
