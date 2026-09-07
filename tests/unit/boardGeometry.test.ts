import { describe, expect, it } from 'vitest';
import { CENTER, RADII, toBoard, toSvg } from '../../src/client/components/boardGeometry';
import { scoreFromBoardCoords } from '../../src/shared/scoring';

describe('drawing and scoring coordinate agreement', () => {
  // Independent expected order: sharing geometry must not hide a rotated or mirrored board.
  const sectors = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

  it.each(sectors.map((sector, index) => ({ sector, index })))('scores every drawn bed in sector $sector', ({ sector, index }) => {
    const angle = index * Math.PI / 10;
    const beds = [
      { radius: (RADII.outerBull + RADII.tripleInner) / 2, label: `S${sector}` },
      { radius: (RADII.tripleInner + RADII.tripleOuter) / 2, label: `T${sector}` },
      { radius: (RADII.tripleOuter + RADII.doubleInner) / 2, label: `S${sector}` },
      { radius: (RADII.doubleInner + RADII.doubleOuter) / 2, label: `D${sector}` },
      { radius: (RADII.doubleOuter + RADII.boardOuter) / 2, label: 'miss' },
    ];
    for (const { radius, label } of beds) {
      const point = toBoard({ x: CENTER + radius * Math.sin(angle), y: CENTER - radius * Math.cos(angle) });
      expect(scoreFromBoardCoords(point.x, point.y).label).toBe(label);
    }
  });

  it('scores both drawn bulls', () => {
    for (const [radius, label] of [[RADII.innerBull / 2, 'DB'], [(RADII.innerBull + RADII.outerBull) / 2, 'SB']] as const) {
      const point = toBoard({ x: CENTER + radius, y: CENTER });
      expect(scoreFromBoardCoords(point.x, point.y).label).toBe(label);
    }
  });

  it('preserves the wire scale, vertical flip and integer round trips', () => {
    expect(toBoard({ x: 0, y: 0 })).toEqual({ x: 0, y: 1_000_000 });
    expect(toBoard({ x: 100, y: 100 })).toEqual({ x: 1_000_000, y: 0 });
    expect(toSvg({ x: 500_000, y: 500_000 })).toEqual({ x: 50, y: 50 });
    for (const point of [{ x: 1, y: 999_999 }, { x: 376_935, y: 737_251 }, { x: 999_999, y: 1 }]) {
      expect(toBoard(toSvg(point))).toEqual(point);
    }
  });
});
