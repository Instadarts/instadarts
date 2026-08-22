import { describe, expect, it } from 'vitest';
import { makeLobbyLayout } from '../../src/client/pages/LobbyPage';

function positions(cols: number) {
  return makeLobbyLayout(cols).map(({ i, x, w }) => ({ i, x, w }));
}

describe('generated lobby layouts', () => {
  it('preserves the validated stock breakpoint geometry', () => {
    expect(positions(12)).toEqual([
      { i: 'overview', x: 0, w: 12 },
      { i: 'players', x: 0, w: 4 },
      { i: 'match-settings', x: 4, w: 4 },
      { i: 'mode-settings', x: 8, w: 4 },
      { i: 'invite', x: 0, w: 4 },
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
      { i: 'players', x: 1, w: 4 },
      { i: 'match-settings', x: 1, w: 4 },
      { i: 'mode-settings', x: 1, w: 4 },
      { i: 'invite', x: 1, w: 4 },
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
