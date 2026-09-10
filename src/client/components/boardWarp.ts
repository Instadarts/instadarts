// Turning the board's geometry into the two CSS properties that show it.
//
// `boardWarpMatrix` in shared/vision does the arithmetic; this is only how it is spelled, and where
// the shape of the hole around the board is decided.

import { NORMALIZED_RADII } from '../../shared/boardGeometry';
import type { Matrix3x3 } from '../../shared/vision/types';

/**
 * Column-major CSS matrix for a flat element, including the perspective divide.
 *
 * ```
 *   m11 m12 m13 m14      a  d  0  g
 *   m21 m22 m23 m24  =   b  e  0  h
 *   m31 m32 m33 m34      0  0  1  0
 *   m41 m42 m43 m44      c  f  0  i
 * ```
 *
 */
export function toMatrix3d(m: Matrix3x3): string {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  return `matrix3d(${a}, ${d}, 0, ${g}, ${b}, ${e}, 0, ${h}, 0, 0, 1, 0, ${c}, ${f}, 0, ${i})`;
}

/**
 * Clip at the same outer rim used by the source mask. On a square, CSS circle percentages resolve
 * against the side length; outside the clip is transparent so the virtual board shows through.
 */
export const BOARD_CUTOUT = `circle(${(NORMALIZED_RADII.boardOuter * 100).toFixed(2)}% at 50% 50%)`;
