import { describe, it, expect } from 'vitest';
import { BOARD_CENTER, BOARD_MAX, scoreFromBoardCoords } from '../../src/shared/scoring';
import { REFERENCE_POINTS, computeSpiderHomography, transformPoint } from '../../src/shared/vision/homography';
import {
  sliderValueToLensK1,
  distortNormalizedPoint,
  undistortNormalizedPoint,
} from '../../src/shared/vision/lensDistortion';
import { processPredictions } from '../../src/client/vision/predictionPipeline';
import type { Keypoint, Matrix3x3, Point2D } from '../../src/shared/vision/types';

// ============================================================
// Helpers
// ============================================================

/**
 * A synthetic camera: maps instadarts board coordinates into normalized image space, so a test can
 * say "put a dart at T20" and get the pixel a model would have seen. Deliberately an oblique view
 * with perspective, so the homography has real work to do.
 */
function makeCamera(matrix: Matrix3x3) {
  return (board: Point2D): Point2D => {
    const p = transformPoint(board, matrix);
    if (!p) throw new Error('camera projection failed');
    return p;
  };
}

/** board → image, for a board filling most of the frame, tilted and viewed from below-left. */
const BOARD_TO_IMAGE: Matrix3x3 = [
  [0.9 / BOARD_MAX, 0.1 / BOARD_MAX, 0.02],
  [-0.06 / BOARD_MAX, -0.85 / BOARD_MAX, 0.93],
  [0.10 / BOARD_MAX, 0.14 / BOARD_MAX, 1],
];

const project = makeCamera(BOARD_TO_IMAGE);

/** The eight board keypoints as this camera would see them. */
function boardKeypoints(confidence = 0.95, classes = [0, 1, 2, 3, 4, 5, 6, 7]): Keypoint[] {
  return classes.map((cls) => {
    const [x, y] = project(REFERENCE_POINTS[cls]);
    return [x, y, confidence, cls] as Keypoint;
  });
}

/** A dart tip at a board position, as this camera would see it. */
function tipAt(board: Point2D, confidence = 0.9): Keypoint {
  const [x, y] = project(board);
  return [x, y, confidence, 8];
}

/** Board coordinate at radius r on a bearing measured clockwise from straight up. */
function polar(radiusUnits: number, bearingDeg: number): Point2D {
  const theta = (bearingDeg * Math.PI) / 180;
  return [
    BOARD_CENTER + radiusUnits * Math.sin(theta),
    BOARD_CENTER + radiusUnits * Math.cos(theta),
  ];
}

// ============================================================
// Reference points
// ============================================================

describe('REFERENCE_POINTS', () => {
  it('all sit on the outside of the double ring', () => {
    const expected = 170.0 * (0.5 / 225.5) * BOARD_MAX;
    for (const [x, y] of REFERENCE_POINTS) {
      const r = Math.hypot(x - BOARD_CENTER, y - BOARD_CENTER);
      expect(r).toBeCloseTo(expected, 6);
    }
  });

  it('class 0 ("18-4") is up and to the right — y above centre, x right of centre', () => {
    const [x, y] = REFERENCE_POINTS[0];
    expect(x).toBeGreaterThan(BOARD_CENTER);
    expect(y).toBeGreaterThan(BOARD_CENTER);
  });

  it('scores as a boundary between the two sectors it is named for', () => {
    // A hair either side of each keypoint's bearing must land in the two named sectors.
    const names = [
      [18, 4], [4, 13], [10, 15], [15, 2], [7, 16], [16, 8], [14, 9], [9, 12],
    ];
    for (let cls = 0; cls < 8; cls++) {
      const [x, y] = REFERENCE_POINTS[cls];
      const bearing = (Math.atan2(x - BOARD_CENTER, y - BOARD_CENTER) * 180) / Math.PI;
      const [left, right] = names[cls];
      const justInside = 200_000; // singles ring, well away from any radius boundary
      expect(scoreFromBoardCoords(...polar(justInside, bearing - 3)).base).toBe(left);
      expect(scoreFromBoardCoords(...polar(justInside, bearing + 3)).base).toBe(right);
    }
  });
});

// ============================================================
// Homography
// ============================================================

describe('computeSpiderHomography', () => {
  it('recovers a known camera to sub-unit board accuracy at 1e6 scale', () => {
    const homography = computeSpiderHomography(boardKeypoints());
    expect(homography).not.toBeNull();

    for (const point of REFERENCE_POINTS) {
      const back = transformPoint(project(point), homography!);
      expect(back).not.toBeNull();
      expect(Math.hypot(back![0] - point[0], back![1] - point[1])).toBeLessThan(1);
    }
  });

  it('works from the minimum of four keypoints', () => {
    const homography = computeSpiderHomography(boardKeypoints(0.95, [0, 2, 4, 6]));
    expect(homography).not.toBeNull();
    const back = transformPoint(project(REFERENCE_POINTS[1]), homography!);
    expect(Math.hypot(back![0] - REFERENCE_POINTS[1][0], back![1] - REFERENCE_POINTS[1][1])).toBeLessThan(1);
  });

  it('tolerates one badly misplaced keypoint', () => {
    const kps = boardKeypoints();
    kps[3] = [kps[3][0] + 0.08, kps[3][1] - 0.05, 0.95, 3];
    const homography = computeSpiderHomography(kps);
    expect(homography).not.toBeNull();
    const back = transformPoint(project(REFERENCE_POINTS[0]), homography!);
    expect(Math.hypot(back![0] - REFERENCE_POINTS[0][0], back![1] - REFERENCE_POINTS[0][1])).toBeLessThan(1);
  });

  it('returns null below four keypoints', () => {
    expect(computeSpiderHomography(boardKeypoints(0.95, [0, 2, 4]))).toBeNull();
  });

  it('returns null when fewer than three class pairs are covered', () => {
    // Four keypoints, but all from two pairs — a degenerate one-sided fit.
    expect(computeSpiderHomography(boardKeypoints(0.95, [0, 1, 2, 3]))).toBeNull();
  });

  it('ignores dart tips when solving', () => {
    const withTips = [...boardKeypoints(), tipAt(polar(225_000, 0)), tipAt(polar(100_000, 90))];
    const homography = computeSpiderHomography(withTips);
    expect(homography).not.toBeNull();
    const back = transformPoint(project(REFERENCE_POINTS[5]), homography!);
    expect(Math.hypot(back![0] - REFERENCE_POINTS[5][0], back![1] - REFERENCE_POINTS[5][1])).toBeLessThan(1);
  });
});

describe('transformPoint', () => {
  it('returns null on a degenerate denominator', () => {
    const degenerate: Matrix3x3 = [[1, 0, 0], [0, 1, 0], [0, 0, 0]];
    expect(transformPoint([0.5, 0.5], degenerate)).toBeNull();
  });
});

// ============================================================
// Lens distortion
// ============================================================

describe('lens distortion', () => {
  it('maps the slider onto k1', () => {
    expect(sliderValueToLensK1(0)).toBe(0);
    expect(sliderValueToLensK1(100)).toBeCloseTo(0.18, 10);
    expect(sliderValueToLensK1(-100)).toBeCloseTo(-0.18, 10);
    expect(sliderValueToLensK1(50)).toBeCloseTo(0.09, 10);
  });

  it('clamps out-of-range and rejects nonsense', () => {
    expect(sliderValueToLensK1(9999)).toBeCloseTo(0.18, 10);
    expect(sliderValueToLensK1(-9999)).toBeCloseTo(-0.18, 10);
    expect(sliderValueToLensK1(NaN)).toBe(0);
  });

  it('leaves the image centre alone', () => {
    expect(distortNormalizedPoint([0.5, 0.5], 0.18)).toEqual([0.5, 0.5]);
  });

  it('round-trips distort → undistort to well under a pixel', () => {
    // The inversion is eight fixed-point passes, not a closed form, so it converges rather than
    // being exact. At the strongest correction and the worst-placed point the residual is ~1e-5 of
    // the frame — a hundredth of a pixel at 960px, which is what "well under" has to mean here.
    const worstAllowed = 0.5 / 960;
    for (const k1 of [0.18, -0.18, 0.07]) {
      for (const point of [[0.1, 0.1], [0.9, 0.2], [0.5, 0.95], [0.33, 0.66]] as Point2D[]) {
        const back = undistortNormalizedPoint(distortNormalizedPoint(point, k1), k1);
        expect(Math.hypot(back[0] - point[0], back[1] - point[1])).toBeLessThan(worstAllowed);
      }
    }
  });

  it('is a no-op at k1 = 0', () => {
    const point: Point2D = [0.2, 0.8];
    expect(distortNormalizedPoint(point, 0)).toBe(point);
    expect(undistortNormalizedPoint(point, 0)).toBe(point);
  });
});

// ============================================================
// The whole camera-side pipeline
// ============================================================

describe('processPredictions', () => {
  const T20 = polar(226_000, 0);
  const D20 = polar(365_000, 0);
  const S6 = polar(300_000, 90);
  const DB: Point2D = [BOARD_CENTER, BOARD_CENTER];

  function run(extra: Keypoint[], lens = 0) {
    return processPredictions([...boardKeypoints(), ...extra], 0.8, 0.75, lens);
  }

  it('projects tips back to the board positions they were thrown at', () => {
    const result = run([tipAt(T20), tipAt(D20), tipAt(S6), tipAt(DB)]);
    expect(result).not.toBeNull();
    expect(result!.tips).toHaveLength(4);

    const labels = result!.tips.map((t) => scoreFromBoardCoords(t.x, t.y).label);
    expect(labels).toEqual(['T20', 'D20', 'S6', 'DB']);
  });

  it('emits integers inside the board square', () => {
    const result = run([tipAt(T20)]);
    for (const tip of result!.tips) {
      expect(Number.isInteger(tip.x)).toBe(true);
      expect(Number.isInteger(tip.y)).toBe(true);
      expect(tip.x).toBeGreaterThanOrEqual(0);
      expect(tip.x).toBeLessThanOrEqual(BOARD_MAX);
      expect(tip.y).toBeGreaterThanOrEqual(0);
      expect(tip.y).toBeLessThanOrEqual(BOARD_MAX);
    }
  });

  it('clamps a tip projected outside the board square', () => {
    const wayOff = tipAt([BOARD_CENTER, BOARD_CENTER]);
    wayOff[0] = -4; // far off frame, projects well outside the board
    const result = run([wayOff]);
    expect(result!.tips[0].x).toBeGreaterThanOrEqual(0);
    expect(result!.tips[0].y).toBeGreaterThanOrEqual(0);
  });

  it('drops tips below the tip threshold and keypoints below the board threshold', () => {
    expect(run([tipAt(T20, 0.5)])!.tips).toHaveLength(0);
    expect(processPredictions([...boardKeypoints(0.6), tipAt(T20)], 0.8, 0.75)).toBeNull();
  });

  it('deduplicates tips that are the same detection twice', () => {
    const a = tipAt(T20, 0.9);
    const b: Keypoint = [a[0] + 0.001, a[1] + 0.001, 0.8, 8];
    const result = run([a, b]);
    expect(result!.tipKeypoints).toBe(1);
    expect(result!.tips).toHaveLength(1);
    expect(result!.tips[0].confidence).toBe(0.9);
  });

  it('keeps two genuinely separate tips apart', () => {
    const result = run([tipAt(T20), tipAt(polar(226_000, 18))]);
    expect(result!.tips).toHaveLength(2);
  });

  it('reports an empty tip list rather than null when the board is empty', () => {
    const result = run([]);
    expect(result).not.toBeNull();
    expect(result!.tips).toEqual([]);
    expect(result!.boardKeypoints).toBe(8);
  });

  it('returns null when the board cannot be located', () => {
    expect(processPredictions([tipAt(T20)], 0.8, 0.75)).toBeNull();
    expect(processPredictions([], 0.8, 0.75)).toBeNull();
  });

  it('survives lens correction: a straight lens scores the same either way', () => {
    // k1 = 0 is applied as a no-op, so the result must match the uncorrected run exactly.
    expect(run([tipAt(T20)], 0)!.tips).toEqual(run([tipAt(T20)])!.tips);
  });

  it('undoes a barrel-distorted lens', () => {
    const k1 = sliderValueToLensK1(60);
    // Build what a distorting lens would actually have produced, then ask for it back.
    const bend = (kp: Keypoint): Keypoint => {
      const [x, y] = distortNormalizedPoint([kp[0], kp[1]], k1);
      return [x, y, kp[2], kp[3]];
    };
    const data = [...boardKeypoints(), tipAt(T20), tipAt(S6)].map(bend);

    const corrected = processPredictions(data, 0.8, 0.75, 60);
    expect(corrected).not.toBeNull();
    expect(corrected!.tips.map((t) => scoreFromBoardCoords(t.x, t.y).label)).toEqual(['T20', 'S6']);

    // And without the correction the same frame lands somewhere else.
    const uncorrected = processPredictions(data, 0.8, 0.75, 0);
    const drift = Math.hypot(
      uncorrected!.tips[0].x - corrected!.tips[0].x,
      uncorrected!.tips[0].y - corrected!.tips[0].y,
    );
    expect(drift).toBeGreaterThan(1_000);
  });
});
