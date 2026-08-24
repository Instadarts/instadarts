// The board as it is drawn, and how that relates to the board as it is talked about.
//
// Two coordinate systems, deliberately:
//
//   · **board units** — 0…1,000,000, y-up, centre at 500,000. This is the wire: what a dart's
//     `x`/`y` are, what the scoring rules and the camera work in. Nothing here changes it.
//   · **SVG units** — 0…100, y-down. This is only how the picture is drawn.
//
// The drawing needs its own, smaller system because of text. A readable label in a million-unit
// viewBox is tens of thousands of units tall, and Chrome clamps `font-size` at 10,000 — so the
// sector numbers and the digits in the dart markers came out invisible and could not be fixed by
// asking for more. At 1:10,000 a label is a few units and everything renders.
//
// The cost is fractional coordinates, which costs nothing: the radii below were already irrational
// multiples of a millimetre, and the only integers in the old system were the dart positions, which
// are converted at the two functions below and stay whole numbers on the wire.

/** The wire's coordinate space. See `BOARD_MAX` in shared/scoring — the same number, by definition. */
export const BOARD_SIZE = 1_000_000;

/** The drawing's coordinate space: the whole board, including the miss area, across 100 units. */
export const SVG_SIZE = 100;

const SVG_PER_BOARD = SVG_SIZE / BOARD_SIZE;

/**
 * A millimetre in SVG units. The board is 451mm across, which is `SVG_SIZE` wide.
 *
 * Exported because the decoration is measured in millimetres too — the width of a wire, the ring
 * the sisal ends at, how coarse the fibre grain is. A number taken off a photograph of a real
 * board arrives in millimetres and has to be brought into this space before it means anything.
 */
export const MM = 0.5 / 225.5 * SVG_SIZE;

export const RADII = {
  boardOuter: 225.0 * MM,        // ~49.89 — full board including miss area
  doubleOuter: 170.0 * MM,       // ~37.69
  doubleInner: 160.0 * MM,       // ~35.48
  tripleOuter: 107.0 * MM,       // ~23.73
  tripleInner: 97.0 * MM,        // ~21.51
  outerBull: (32.0 / 2.0) * MM,  // ~3.55
  innerBull: (13.0 / 2.0) * MM,  // ~1.44
};

export const CENTER = SVG_SIZE / 2;

/**
 * Wire thicknesses, in SVG units.
 *
 * A real spider wire is about a quarter of a millimetre thick, which is what these used to be and
 * why they read as a rasteriser artefact rather than as wire: a quarter of a millimetre is a third
 * of a pixel on a phone, so it flickered in and out along its own length as the board was scaled.
 * These are nearer three quarters of a millimetre — the width at which a wire looks like a wire —
 * and the hierarchy between them is the real one, the double ring's outer wire being the board's
 * rim rather than a divider.
 */
export const WIRE = {
  thin: 0.75 * MM,
  normal: 0.85 * MM,
  thick: 1.05 * MM,
};

/**
 * A wire is drawn three times in the same place: a dark spread beneath it, the steel itself, then a
 * highlight along the lit edge. That is what makes it round — a single flat stroke is a line drawn
 * on the board, and three are a wire lying on top of it.
 *
 * The widths are multiples of whichever thickness above the wire has, so one treatment covers all
 * three, and every pass covers every wire before the next one starts. Drawing a whole wire at a
 * time instead would put each wire's highlight under its neighbour's shadow at the junctions.
 */
export const WIRE_PASSES = [
  { stroke: '#000', width: 2.1, opacity: 0.4 },
  { stroke: '#b9c0c7', width: 1, opacity: 1 },
  { stroke: '#eef2f5', width: 0.38, opacity: 0.9 },
] as const;

// Sector order clockwise from top (y-up)
export const SECTOR_ORDER = [
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17,
  3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
];

// Colors per sector index (alternating)
// Black sectors → red doubles/triples, cream sectors → green doubles/triples
//
// A sisal board has no pure colours on it. The dark bed is a warm-grey stain worked into fibre, the
// light one is the fibre itself, and the rings are paint that has to sit against both — so these
// are those four, rather than the screen primaries they replaced.
const SINGLE_COLORS = ['#1c1c20', '#ecdfbe'];
const DOUBLE_TRIPLE_COLORS = ['#ce2431', '#1e7c3f'];

export function getSectorColor(sectorIndex: number): string {
  return SINGLE_COLORS[sectorIndex % 2];
}

export function getDoubleTripleColor(sectorIndex: number): string {
  return DOUBLE_TRIPLE_COLORS[sectorIndex % 2];
}

// ============================================================
// Between the two systems
// ============================================================

/** A point on the wire, as the drawing sees it. Board y is up, SVG y is down. */
export function toSvg(board: { x: number; y: number }): { x: number; y: number } {
  return { x: board.x * SVG_PER_BOARD, y: (BOARD_SIZE - board.y) * SVG_PER_BOARD };
}

/** A point in the drawing, as the wire sees it. Rounded: a dart's position is a whole board unit. */
export function toBoard(svg: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(svg.x / SVG_PER_BOARD),
    y: Math.round(BOARD_SIZE - svg.y / SVG_PER_BOARD),
  };
}
