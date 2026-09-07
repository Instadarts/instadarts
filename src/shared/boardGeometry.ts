/** The wire coordinate space, y-up with the bull at the centre. */
export const BOARD_MAX = 1_000_000;
export const BOARD_CENTER = BOARD_MAX / 2;

/**
 * A millimetre as a fraction of the board coordinate width. The reference extent is 451mm;
 * the rendered board itself has a 225mm radius, leaving a small margin within that extent.
 */
export const MM_TO_NORMALIZED = 0.5 / 225.5;

/** Physical board radii, converted to a coordinate system whose full width is `width`. */
export function boardRadii(width: number) {
  const mm = MM_TO_NORMALIZED * width;
  return Object.freeze({
    boardOuter: 225.0 * mm,
    doubleOuter: 170.0 * mm,
    doubleInner: 160.0 * mm,
    tripleOuter: 107.0 * mm,
    tripleInner: 97.0 * mm,
    outerBull: (32.0 / 2.0) * mm,
    innerBull: (13.0 / 2.0) * mm,
  });
}

/** Radii as fractions of the board width, for normalized scoring and camera geometry. */
export const NORMALIZED_RADII = boardRadii(1);

/** Dartboard sectors clockwise from the top (20), independent of coordinate handedness. */
export const SECTOR_ORDER = Object.freeze([
  20, 1, 18, 4, 13, 6, 10, 15, 2, 17,
  3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
]);
