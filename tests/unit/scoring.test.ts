import { describe, it, expect } from 'vitest';
import { scoreFromBoardCoords } from '../../src/shared/scoring';

function s(x: number, y: number) {
  return scoreFromBoardCoords(x, y);
}

// Board geometry constants in board units (0–1,000,000)
const C = 500_000;
const INNER_BULL = 14_412; // 6.5 * 0.5/225.5 * 1e6
const OUTER_BULL = 35_477; // 16 * 0.5/225.5 * 1e6
const TRIPLE_INNER = 215_078; // 97 * 0.5/225.5 * 1e6
const TRIPLE_OUTER = 237_251; // 107 * 0.5/225.5 * 1e6
const DOUBLE_INNER = 354_767; // 160 * 0.5/225.5 * 1e6
const DOUBLE_OUTER = 376_935; // 170 * 0.5/225.5 * 1e6

describe('scoreFromBoardCoords', () => {
  describe('bulls', () => {
    it('double bull at exact center', () => {
      expect(s(C, C).label).toBe('DB');
      expect(s(C, C).points).toBe(50);
    });

    it('single bull between inner and outer bull', () => {
      const r = 25_000; // between INNER_BULL (14.4k) and OUTER_BULL (35.5k)
      expect(s(C + r, C).label).toBe('SB');
      expect(s(C + r, C).points).toBe(25);
    });
  });

  describe('sectors', () => {
    it('triple 20 at the top', () => {
      // triple ring midpoint
      const r = (TRIPLE_INNER + TRIPLE_OUTER) / 2;
      const y = C + r;
      expect(s(C, y).label).toBe('T20');
      expect(s(C, y).points).toBe(60);
    });

    it('single 20 inside triple ring', () => {
      const y = C + 100_000; // well inside triple inner
      expect(s(C, y).label).toBe('S20');
      expect(s(C, y).points).toBe(20);
    });

    it('double 20 at top', () => {
      // double ring midpoint
      const r = (DOUBLE_INNER + DOUBLE_OUTER) / 2;
      const y = C + r;
      expect(s(C, y).label).toBe('D20');
      expect(s(C, y).points).toBe(40);
    });

    it('miss outside the board', () => {
      const y = C + 400_000; // outside double outer (377k)
      expect(s(C, y).label).toBe('miss');
      expect(s(C, y).points).toBe(0);
    });
  });

  describe('sector rotation', () => {
    it('sector 3 is to the right from center', () => {
      // Sector 3 is 90° clockwise from top (20). Index in SECTOR_ORDER: 20(0°),1(18°),18(36°),4(54°),13(72°),6(90°),10(108°),15(126°),2(144°),17(162°),3(180°),...
      // Wait, 3 is at index 10 → 10 * 18 = 180°. So sector 3 is at 180° (bottom, at y < C).
      // Let me check: sector 6 is at 90° (right). SECTOR_ORDER index 5 = 6.
      const r = 200_000;
      expect(s(C + r, C).base).toBe(6); // 90° clockwise = right
    });

    it('sector 18 is 36 degrees clockwise from 20', () => {
      // 18 is index 2 in SECTOR_ORDER → 2*18 = 36° clockwise from top
      const r = 200_000;
      const angle36 = 36 * Math.PI / 180;
      const x = C + Math.round(r * Math.sin(angle36));
      const y = C + Math.round(r * Math.cos(angle36));
      expect(s(x, y).base).toBe(18);
    });

    it('sector 3 is at the bottom', () => {
      // Sector 3 is index 10 → 180° from top = bottom
      expect(s(C, C - 200_000).base).toBe(3);
    });
  });

  describe('edge cases', () => {
    it('non-finite coordinates return miss', () => {
      expect(s(NaN, C).label).toBe('miss');
      expect(s(C, Infinity).label).toBe('miss');
    });

    it('top edge of double ring (D20)', () => {
      const y = C + DOUBLE_OUTER - 1;
      expect(s(C, y).label).toBe('D20');
    });

    it('bottom edge of double ring (D3)', () => {
      const y = C - DOUBLE_OUTER + 1;
      expect(s(C, y).label).toBe('D3');
    });
  });
});
