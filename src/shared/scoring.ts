/**
 * Dartboard scoring from integer board coordinates.
 * Adapted from aidarts reference implementation.
 *
 * Board space: x, y ∈ [0, 1000000], center at [500000, 500000], y-up.
 * Top of board (above 20 segment) is [500000, 1000000].
 *
 * Internally normalizes to [0-1] with center [0.5, 0.5] for geometry math.
 */

// --- Board geometry (normalized [0-1] space) ---

const MM_TO_BOARD = 0.5 / 225.5;

const RADII = Object.freeze({
  doubleOuter: 170.0 * MM_TO_BOARD,
  doubleInner: 160.0 * MM_TO_BOARD,
  tripleOuter: 107.0 * MM_TO_BOARD,
  tripleInner: 97.0 * MM_TO_BOARD,
  outerBull: (32.0 / 2.0) * MM_TO_BOARD,
  innerBull: (13.0 / 2.0) * MM_TO_BOARD,
});

const SECTOR_ORDER = Object.freeze([
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17,
  3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
]);

// --- Types ---

export interface ScoreResult {
  label: string;
  points: number;
  mult: number;
  base: number;
}

// --- Label parsing ---

const MULT_MAP: Record<string, number> = { S: 1, D: 2, T: 3 };

function parseLabel(label: string): ScoreResult {
  if (label === 'miss') return { label, points: 0, mult: 0, base: 0 };
  if (label === 'SB') return { label, points: 25, mult: 1, base: 25 };
  if (label === 'DB') return { label, points: 50, mult: 2, base: 25 };
  const match = label.match(/^([SDT])(\d+)$/);
  if (!match) return { label, points: 0, mult: 0, base: 0 };
  const mult = MULT_MAP[match[1]] ?? 1;
  const base = parseInt(match[2], 10);
  return { label, points: base * mult, mult, base };
}

// --- Public API ---

const BOARD_MAX = 1_000_000;

/**
 * Score a dart from integer board coordinates.
 *
 * @param x - x coordinate in [0, 1000000], 0 = left, 1000000 = right
 * @param y - y coordinate in [0, 1000000], y-up (0 = bottom, 1000000 = top)
 * @returns ScoreResult with label (e.g. "T20") and point value
 */
export function scoreFromBoardCoords(x: number, y: number): ScoreResult {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return parseLabel('miss');
  }

  // Normalize to [0-1]. Both systems are y-up, so no y-flip needed.
  const nx = x / BOARD_MAX;
  const ny = y / BOARD_MAX;

  const dx = nx - 0.5;
  const dy = ny - 0.5; // y-up: positive dy = above center (toward 20 segment)
  const r = Math.hypot(dx, dy);

  if (r > RADII.doubleOuter) return parseLabel('miss');
  if (r <= RADII.innerBull) return parseLabel('DB');
  if (r <= RADII.outerBull) return parseLabel('SB');

  const angleDeg = (Math.atan2(dx, dy) * 180) / Math.PI + 360;
  const sectorIdx = Math.floor(((angleDeg + 9) % 360) / 18);
  const segment = SECTOR_ORDER[sectorIdx] ?? 20;

  if (r >= RADII.tripleInner && r <= RADII.tripleOuter) {
    return parseLabel(`T${segment}`);
  }
  if (r >= RADII.doubleInner && r <= RADII.doubleOuter) {
    return parseLabel(`D${segment}`);
  }
  return parseLabel(`S${segment}`);
}
