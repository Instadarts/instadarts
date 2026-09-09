// Blacking out everything that is not the board.
//
// The published feed is a square of the camera's picture, so it carries whatever the phone happens
// to be standing in front of — a room, and the people in it. This finds the board's edge in that
// picture, and `videoCamera.ts` fills everything outside it with black.
//
// ```
// board circle ──(inverse homography)──▶ undistorted normalized
//              ──(distortNormalizedPoint)──▶ normalized frame
// ```
//
// The same journey backwards that `stillCapture.ts` makes for a still's four corners, run here for a
// circle instead of a square. Nothing new is derived: this is `regionToCrop`'s chain with more points
// and no bounding box.
//
// **It is not a warp.** The board keeps the shape the camera saw it in, and only the surroundings
// change. Rectifying it to front-facing needs a per-pixel inverse map and therefore a GPU, on a phone
// that is already running the detection model — see `feedGeometry.ts` for the geometry that lets a
// receiver do it instead.
//
// **It changes only what is published.** Inference reads the `<video>` element directly; this draws
// on the publisher's canvas, downstream of everything the pipeline looks at. A masked feed scores
// identically to an unmasked one.

import { BOARD_CENTER, BOARD_MAX, NORMALIZED_RADII } from '../../shared/boardGeometry';
import { invertMatrix3x3, transformPoint } from '../../shared/vision/homography';
import { distortNormalizedPoint, sliderValueToLensK1 } from '../../shared/vision/lensDistortion';
import type { Matrix3x3, Point2D } from '../../shared/vision/types';

/**
 * The board's outer edge — the sisal rim at 225mm, not the double ring at 170.
 *
 * The number ring lives between the two, and it is part of what a person reads off a board. Cutting
 * at the double takes the numbers off and makes the picture look broken rather than masked, and a
 * dart in the wire outside the double still has to be visible.
 *
 * There is deliberately no margin: the mask traces the rim exactly. If a homography solved a moment
 * before somebody nudged the phone turns out to cut a crescent off the board in practice, a few
 * percent here is the knob — it is cheaper to widen than to explain.
 */
const MASK_RADIUS = NORMALIZED_RADII.boardOuter * BOARD_MAX;

/**
 * How many points the circle is drawn with.
 *
 * The same sampling the calibration spider uses. On a 320px frame the board's circumference is at
 * most about 1,000px, so 128 chords are eight pixels each and bulge inward by under a twentieth of a
 * pixel. It costs nothing regardless: this runs once per *inference*, not once per frame, and
 * inference is motion-gated.
 */
const OUTLINE_SAMPLES = 128;

/**
 * The smallest polygon worth believing, as a fraction of the input square.
 *
 * This guard is load-bearing rather than defensive. Every other failure in this file is a matrix
 * that will not invert or a point that will not project, and each one is loud in the sense that it
 * returns null and the frame goes out unmasked. A homography that is merely *wrong* is not: it
 * projects eight points happily and puts the board somewhere it is not, and the result on somebody
 * else's screen is a black square with no error attached — which nobody at the source can see,
 * because the phone shows its own camera and not what it published.
 *
 * A board this small in frame could not be scored anyway: one percent of the square is a board
 * eleven percent of the frame across.
 */
const MIN_OUTLINE_AREA = 0.01;

export interface BoardOutlineInput {
  /** The image→board homography this camera last solved. */
  homography: Matrix3x3;
  /** The lens slider value it was solved under. */
  lensCalibration: number;
}

/**
 * The board's outer circle, in the model input square's normalized coordinates. Interleaved x, y.
 *
 * Normalized rather than in source pixels, deliberately: the crop the pipeline feeds the model can
 * change with the camera's resolution, and holding the outline in the square's own coordinates keeps
 * this module free of the frame, the canvas and the shot. `outlineInShot` in `videoCamera.ts` does
 * that last step, per frame, because it is the part that moves.
 *
 * Null when the board cannot be placed honestly — see the failure list in `createBoardMask`.
 */
export function boardOutline({ homography, lensCalibration }: BoardOutlineInput): Float64Array | null {
  const inverse = invertMatrix3x3(homography);
  if (!inverse) return null;

  const k1 = sliderValueToLensK1(lensCalibration);
  const useLens = Math.abs(k1) >= 1e-12;

  const points = new Float64Array(OUTLINE_SAMPLES * 2);
  for (let i = 0; i < OUTLINE_SAMPLES; i++) {
    const theta = (i / OUTLINE_SAMPLES) * 2 * Math.PI;
    const board: Point2D = [
      BOARD_CENTER + MASK_RADIUS * Math.cos(theta),
      BOARD_CENTER + MASK_RADIUS * Math.sin(theta),
    ];
    const undistorted = transformPoint(board, inverse);
    if (!undistorted) return null;
    // Back through the lens the same way the tips came out of it, so a calibrated camera's mask sits
    // on the board's real edge rather than where an ideal lens would have put it.
    const normalized = useLens ? distortNormalizedPoint(undistorted, k1) : undistorted;
    if (!Number.isFinite(normalized[0]) || !Number.isFinite(normalized[1])) return null;
    points[i * 2] = normalized[0];
    points[i * 2 + 1] = normalized[1];
  }

  if (polygonArea(points) < MIN_OUTLINE_AREA) return null;
  return points;
}

/** Shoelace, unsigned — the projection reverses orientation and that is not this guard's question. */
function polygonArea(points: Float64Array): number {
  let twiceArea = 0;
  for (let i = 0; i < points.length; i += 2) {
    const j = (i + 2) % points.length;
    twiceArea += points[i] * points[j + 1] - points[j] * points[i + 1];
  }
  return Math.abs(twiceArea) / 2;
}

export interface BoardMask {
  /**
   * The outline for this geometry. Null when there is none, or when it cannot be placed.
   *
   * Recomputed only when the geometry changes, which is what makes it free to call on every frame.
   */
  outline(homography: Matrix3x3 | null, lensCalibration: number): Float64Array | null;
  /** Forget it. A camera that has stopped describes no board. */
  reset(): void;
}

/**
 * The outline, computed once per solved homography rather than once per frame.
 *
 * **The cache key is the homography's array identity**, not its contents. `visionRuntime` stores a
 * fresh matrix on every inference that solved one, so reference equality is exactly the question
 * "has the board been re-solved since last time" — and inference is motion-gated, so on a mounted
 * camera watching a still board the answer is no for seconds at a time.
 *
 * A failure is cached too. A homography that will not invert will not invert on the next frame
 * either, and re-deriving that answer fifteen times a second is the one way this could become
 * expensive.
 */
export function createBoardMask(): BoardMask {
  let cachedHomography: Matrix3x3 | null = null;
  let cachedLens = Number.NaN;
  let cached: Float64Array | null = null;

  return {
    outline(homography: Matrix3x3 | null, lensCalibration: number): Float64Array | null {
      if (!homography) return null;
      if (homography === cachedHomography && lensCalibration === cachedLens) return cached;
      cachedHomography = homography;
      cachedLens = lensCalibration;
      cached = boardOutline({ homography, lensCalibration });
      return cached;
    },

    reset(): void {
      cachedHomography = null;
      cachedLens = Number.NaN;
      cached = null;
    },
  };
}
