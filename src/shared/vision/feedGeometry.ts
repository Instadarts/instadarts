// Where the board is in one published video frame.
//
// A scoring device publishes a square of its own picture, and a receiver has no idea what that
// square contains — which board, at what angle, cropped from where. This is the description that
// travels beside the frame so it can find out.
//
// A receiver holding this can send any pixel of a decoded frame back to a board coordinate, which
// is what a front-facing warp needs. The device deliberately does not warp its own picture — that
// needs a per-pixel inverse map and a GPU the detection model is already using — so the arithmetic
// is sent instead, to the end that has a spare one and no inference to run. `boardWarpMatrix`, at
// the foot of this file, is what reads it back — and turns out to need no GPU either.
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

// ============================================================
// Reading it back: the warp
// ============================================================

/**
 * The transform that lays a published frame square-on over a board of `sizePx` a side.
 *
 * This is the journey above run forwards for a whole picture rather than a point: element pixels of
 * the frame, out to the pixels of the box the virtual board is drawn in. A viewer applies it as a
 * CSS `matrix3d`, which **is** a homography — for a flat element the browser computes three linear
 * combinations and divides by the third, which is the same arithmetic and the same perspective
 * divide. Nothing on this end reads the bitmap, so a compositor transform is enough; the argument in
 * `client/vision/videoCamera.ts` against CSS is about the publisher, where `drawImage`,
 * `new VideoFrame(...)` and `captureStream()` all read pixels, and it does not reach this far.
 *
 * The published canvas is stretched to the box, so content point `(u, v)` in `[0,1]²` sits at
 * element-local `(u·sizePx, v·sizePx)`, and the composition is
 * `S(sizePx) · flip · homography · shotAffine · S(1/sizePx)` — where `shotAffine` carries
 * `geometry.shot`, and `sizePx` is the box, two different lengths that must not be confused.
 *
 * That `flip` is not decoration. **Board space is y-up and a screen is y-down** — the homography's
 * whole job upstream is to leave the camera's picture and arrive somewhere the scoring rules can be
 * written, and this is where that has to be undone. The drawing crosses the same line with
 * `BOARD_SIZE - y` in `client/components/boardGeometry.ts`; here it is a row of the matrix, so it
 * costs nothing and travels with everything else.
 *
 * **The lens is dropped on purpose.** `lensK1` describes a radial distortion, and a radial term is
 * not projective — no 3×3 can express it, and neither can CSS. Correcting it means a per-pixel
 * inverse map and therefore a shader, which is the entire cost this design exists to avoid. What it
 * costs instead is a smooth misplacement growing with the square of the distance from the frame's
 * centre; `tests/unit/vision-geometry.test.ts` measures it at the board's rim rather than leaving it
 * to be imagined. This is a picture to look at — it scores nothing and no one throws at it.
 *
 * Null rather than a wrong transform, on every failure. The one that matters is `w ≤ 0` at a corner:
 * a corner of the frame that projects behind the camera makes a browser draw something torn rather
 * than nothing, so it is checked here and the caller shows the picture the way it always has.
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
