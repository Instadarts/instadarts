// Board geometry in board units (0–1,000,000)
// Derived from dart-scoring.ts constants

const MM_TO_BOARD = 0.5 / 225.5 * 1_000_000;

export const RADII = {
  boardOuter: 225.0 * MM_TO_BOARD,         // ~498,891 — full board including miss area
  doubleOuter: 170.0 * MM_TO_BOARD,        // ~376,935
  doubleInner: 160.0 * MM_TO_BOARD,        // ~354,767
  tripleOuter: 107.0 * MM_TO_BOARD,        // ~237,251
  tripleInner: 97.0 * MM_TO_BOARD,         // ~215,078
  outerBull: (32.0 / 2.0) * MM_TO_BOARD,   // ~35,477
  innerBull: (13.0 / 2.0) * MM_TO_BOARD,   // ~14,412
};

export const CENTER = 500_000;
export const BOARD_SIZE = 1_000_000;

// Sector order clockwise from top (y-up)
export const SECTOR_ORDER = [
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17,
  3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
];

// Colors per sector index (alternating)
const SINGLE_COLORS = ['#1a1a1a', '#f5e6c8']; // black, cream
const DOUBLE_TRIPLE_COLORS = ['#d44', '#4a4'];  // red, green (red on black sectors, green on cream? actually traditional: red/green alternate)
// Traditional: sectors alternate black/cream for singles, red/green for doubles/triples
// Black sector → triple/double is red, Cream sector → triple/double is green
// Wait, actually: traditionally doubles and triples are red for black sectors, green for cream sectors
// But wait, traditional dartboard: black sectors get red doubles/triples, white(cream) get green
// Let me use: index 0 (black) → red, index 1 (cream) → green

export function getSectorColor(sectorIndex: number): string {
  return SINGLE_COLORS[sectorIndex % 2];
}

export function getDoubleTripleColor(sectorIndex: number): string {
  return DOUBLE_TRIPLE_COLORS[sectorIndex % 2];
}

// SVG: y-down, board: y-up. Convert board y to SVG y.
export function boardYToSvgY(boardY: number): number {
  return BOARD_SIZE - boardY;
}
