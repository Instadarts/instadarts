// Project the board rim into the camera's input square for the outgoing video mask.
// Inference reads the original video. See docs/media.md, "Blacking out the room".

import { BOARD_CENTER, BOARD_MAX, NORMALIZED_RADII } from '../../shared/boardGeometry';
import { invertMatrix3x3, transformPoint } from '../../shared/vision/homography';
import { distortNormalizedPoint, sliderValueToLensK1 } from '../../shared/vision/lensDistortion';
import type { Matrix3x3, Point2D } from '../../shared/vision/types';

/** The 225mm outer rim includes the number ring; no extra margin. */
const MASK_RADIUS = NORMALIZED_RADII.boardOuter * BOARD_MAX;

/** 128 chords approximate the rim to well below a pixel on the published canvas. */
const OUTLINE_SAMPLES = 128;

/** Reject implausibly tiny outlines that would otherwise black out nearly the whole feed. */
const MIN_OUTLINE_AREA = 0.01;

export interface BoardOutlineInput {
  /** The image→board homography this camera last solved. */
  homography: Matrix3x3;
  /** The lens slider value it was solved under. */
  lensCalibration: number;
}

/**
 * Interleaved x/y rim coordinates in the normalized model input square. Null for invalid geometry,
 * a horizon crossing the rim, or an implausibly small polygon. outlineInShot places it in each shot.
 */
export function boardOutline({ homography, lensCalibration }: BoardOutlineInput): Float64Array | null {
  const inverse = invertMatrix3x3(homography);
  if (!inverse) return null;

  // w on the circle ranges from centreW - spanW to centreW + spanW. Reject crossings and
  // tangencies analytically: testing sampled points alone misses horizons between samples.
  // Either consistent sign is valid because multiplying a homography by -1 changes no points.
  const [g, h, i] = inverse[2];
  const centreW = (g + h) * BOARD_CENTER + i;
  const spanW = MASK_RADIUS * Math.hypot(g, h);
  if (Math.abs(centreW) - spanW <= 1e-9) return null;

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

/** Cache successes and failures by matrix identity and lens setting. Each inference creates a matrix. */
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
