// Coordinate mapping for a published square. The live feed holds the last resting shot's mapping
// through director zooms. Transport cadence and reset semantics are documented in docs/media.md.

import { BOARD_MAX } from '../boardGeometry';
import { sliderValueToLensK1 } from './lensDistortion';
import type { Matrix3x3 } from './types';

/** The mapping from a published square to normalized board coordinates. */
export interface BoardGeometry {
  /** Normalized model input square → normalized board space ([0, 1], y-up). */
  homography: Matrix3x3;
  /** Radial distortion coefficient, independent of the calibration slider's scale. */
  lensK1: number;
  /** The published square, in those same input-square coordinates. */
  shot: { x: number; y: number; size: number };
}

export interface PublishedGeometryInput {
  /** The image→board homography this camera last solved, in board units. */
  homography: Matrix3x3;
  /** The lens slider value it was solved under. */
  lensCalibration: number;
  /** Where the model's input square sits in the video frame. */
  crop: { cropX: number; cropY: number; cropSize: number };
  /** The square actually drawn into the published frame, in the same video pixels. */
  shot: { x: number; y: number; size: number };
}

/** Normalize a source shot and its homography for publication; null when invalid. */
export function publishedBoardGeometry({
  homography, lensCalibration, crop, shot,
}: PublishedGeometryInput): BoardGeometry | null {
  if (!(crop.cropSize > 0) || !(shot.size > 0)) return null;

  const normalized: Matrix3x3 = [
    [homography[0][0] / BOARD_MAX, homography[0][1] / BOARD_MAX, homography[0][2] / BOARD_MAX],
    [homography[1][0] / BOARD_MAX, homography[1][1] / BOARD_MAX, homography[1][2] / BOARD_MAX],
    [homography[2][0], homography[2][1], homography[2][2]],
  ];
  for (const row of normalized) {
    for (const value of row) if (!Number.isFinite(value)) return null;
  }

  const geometry: BoardGeometry = {
    homography: normalized,
    lensK1: sliderValueToLensK1(lensCalibration),
    shot: {
      x: (shot.x - crop.cropX) / crop.cropSize,
      y: (shot.y - crop.cropY) / crop.cropSize,
      size: shot.size / crop.cropSize,
    },
  };
  if (!Number.isFinite(geometry.shot.x) || !Number.isFinite(geometry.shot.y)) return null;
  if (!(geometry.shot.size > 0)) return null;
  return geometry;
}

/** Whether two descriptions say the same thing, so an unchanged one need not be sent again. */
export function sameBoardGeometry(a: BoardGeometry | null, b: BoardGeometry | null): boolean {
  if (!a || !b) return a === b;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      if (a.homography[row][col] !== b.homography[row][col]) return false;
    }
  }
  return a.lensK1 === b.lensK1
    && a.shot.x === b.shot.x
    && a.shot.y === b.shot.y
    && a.shot.size === b.shot.size;
}

// ============================================================
// Reading it back: the warp
// ============================================================

/**
 * Map a canvas stretched to sizePx into the virtual board's screen coordinates:
 * S(sizePx) · yFlip · homography · shotAffine · S(1/sizePx).
 * CSS matrix3d can express this projective map, but not radial lens correction.
 * Reject non-finite results and a horizon through the frame. See docs/media.md for the tradeoffs.
 */
export function boardWarpMatrix(geometry: BoardGeometry, sizePx: number): Matrix3x3 | null {
  if (!(sizePx > 0)) return null;

  const { x, y, size } = geometry.shot;
  const h = geometry.homography;

  // homography · shotAffine, where the affine takes content [0,1] into the input square's own
  // normalized coordinates. Written out rather than looped: three rows of three is shorter this way
  // than the machinery to multiply it would be.
  const board: Matrix3x3 = [
    [h[0][0] * size, h[0][1] * size, h[0][0] * x + h[0][1] * y + h[0][2]],
    [h[1][0] * size, h[1][1] * size, h[1][0] * x + h[1][1] * y + h[1][2]],
    [h[2][0] * size, h[2][1] * size, h[2][0] * x + h[2][1] * y + h[2][2]],
  ];

  // Turning the board the right way up for a screen. In homogeneous coordinates `1 - y/w` is the
  // row `w - y`, so the flip is one subtraction of the third row from the second and nothing else
  // moves — the horizontal row and the divisor are the same board seen either way up.
  const k: Matrix3x3 = [
    board[0],
    [board[2][0] - board[1][0], board[2][1] - board[1][1], board[2][2] - board[1][2]],
    board[2],
  ];

  // Conjugating by the box's side turns content coordinates into element pixels at both ends. The
  // linear part is unchanged by it; only the translations and the perspective row carry a length.
  const matrix: Matrix3x3 = [
    [k[0][0], k[0][1], k[0][2] * sizePx],
    [k[1][0], k[1][1], k[1][2] * sizePx],
    [k[2][0] / sizePx, k[2][1] / sizePx, k[2][2]],
  ];
  for (const row of matrix) {
    for (const value of row) if (!Number.isFinite(value)) return null;
  }

  // The four corners of the picture, in content coordinates. A homography is a plane seen from
  // somewhere, and the plane's horizon can fall inside a frame — past it the divisor changes sign
  // and the picture folds over itself.
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
    const w = k[2][0] * u + k[2][1] * v + k[2][2];
    if (!(w > 1e-6)) return null;
  }
  return matrix;
}
