// Where the board is in one published video frame.
//
// A scoring device publishes a square of its own picture, and a receiver has no idea what that
// square contains — which board, at what angle, cropped from where. This is the description that
// travels beside the frame so it can find out.
//
// It exists to be *used later*: a receiver holding this can send any pixel of a decoded frame back
// to a board coordinate, which is what a front-facing warp needs. Nothing consumes it yet. The
// device deliberately does not warp its own picture — that needs a per-pixel inverse map and a GPU
// the detection model is already using — so the arithmetic is sent instead, to the end that has a
// spare one and no inference to run.
//
// Thirteen numbers, and they are sufficient. The receiver's journey is:
//
// ```
// published pixel  ──(/ frame width)──▶  u, v in [0,1]
//                  ──(shot)──▶           input-square normalized
//                  ──(undistortNormalizedPoint)──▶  undistorted
//                  ──(transformPoint)──▶  normalized board space
// ```
//
// The frame's width comes from the decoded frame itself and the frame is square, so it does not
// travel. Both functions that journey needs are already in this directory.

import { BOARD_MAX } from '../boardGeometry';
import { sliderValueToLensK1 } from './lensDistortion';
import type { Matrix3x3 } from './types';

/**
 * The geometry of one published frame.
 *
 * Both normalizations below are about the *interface*, not about arithmetic. Float32 on the wire is
 * comfortable either way — its error is relative, so the scale of the numbers does not come into it
 * (`frames.ts` has the measurement). What they buy is that a receiver can read this without knowing
 * anything about how a scoring device stores geometry internally.
 */
export interface BoardGeometry {
  /**
   * The model input square's normalized coordinates → **normalized board space**, `[0, 1]`.
   *
   * Not board units. The two board rows are divided by `BOARD_MAX` on the way out, so this lands in
   * the same `[0, 1]` a `Region` is expressed in — the one board coordinate system anything outside
   * the vision pipeline already speaks — and a receiver never has to learn that board units exist.
   */
  homography: Matrix3x3;
  /**
   * The lens coefficient, not the slider position.
   *
   * `sliderValueToLensK1` is a mapping between a UI control and some optics, with a tunable maximum
   * in the middle of it. The wire carries the optics; a slider is nobody else's business.
   */
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

/**
 * Describe the frame about to be published.
 *
 * Null when there is nothing honest to say: a crop or a shot with no extent, or a matrix carrying a
 * value that is not a number. A frame then goes out with no description, which a receiver reads as
 * "unchanged" rather than as "gone" — see the cadence note in `videoPublisher.ts`.
 *
 * Deliberately **not** checked for invertibility. The receiver runs this matrix forwards, pixel to
 * board, so a matrix that cannot be inverted is not this function's problem — and refusing one here
 * would be inventing a requirement nothing downstream has.
 */
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

// The inverse — a published pixel back to a board coordinate — belongs beside this, and is
// deliberately absent: it is the warping commit's, and writing it here with nothing calling it would
// be a second description of the same journey with no test to keep the two honest.
