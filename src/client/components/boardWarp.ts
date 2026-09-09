// Turning the board's geometry into the two CSS properties that show it.
//
// `boardWarpMatrix` in shared/vision does the arithmetic; this is only how it is spelled, and where
// the shape of the hole around the board is decided.

import { NORMALIZED_RADII } from '../../shared/boardGeometry';
import type { Matrix3x3 } from '../../shared/vision/types';

/**
 * A homography, as CSS spells one.
 *
 * `matrix3d` is **column-major** and sixteen numbers, of which a flat element at `z = 0` uses seven:
 * the two linear rows, the two translations, and the perspective pair that makes the browser divide.
 * Laid out here as four groups of four, in the order CSS reads them, because the failure this
 * prevents is silent — a transposed matrix is not an error, it is a picture that is subtly and
 * inexplicably wrong, and `tests/unit/video.test.ts` pins the string for exactly that reason.
 *
 * ```
 *   m11 m12 m13 m14      a  d  0  g
 *   m21 m22 m23 m24  =   b  e  0  h
 *   m31 m32 m33 m34      0  0  1  0
 *   m41 m42 m43 m44      c  f  0  i
 * ```
 *
 * No `perspective` property is needed anywhere above it: the divide comes from `m14`/`m24` here.
 * Numbers are written as JavaScript writes them — CSS accepts an exponent, and in practice none of
 * these reach the magnitude where one appears.
 */
export function toMatrix3d(m: Matrix3x3): string {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  return `matrix3d(${a}, ${d}, 0, ${g}, ${b}, ${e}, 0, ${h}, 0, 0, 1, 0, ${c}, ${f}, 0, ${i})`;
}

/**
 * The hole the straightened board is seen through.
 *
 * The same radius the scoring device masks at — the sisal rim — so the two agree by construction
 * rather than by both being typed correctly. A masked feed arrives with black outside that circle,
 * and this cuts exactly that black away; an unmasked one loses its room here instead. Either way
 * what is outside becomes **transparent**, so the virtual board underneath shows through rather than
 * being covered by a square of somebody's living room.
 *
 * A percentage radius in `circle()` resolves against `√((w² + h²) / 2)`, which for the square board
 * box is its side — so this is a fraction of the board's own width, which is what the radius is.
 */
export const BOARD_CUTOUT = `circle(${(NORMALIZED_RADII.boardOuter * 100).toFixed(2)}% at 50% 50%)`;
