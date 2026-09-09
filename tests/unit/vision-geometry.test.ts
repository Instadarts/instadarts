import { describe, it, expect } from 'vitest';
import { BOARD_CENTER, BOARD_MAX, scoreFromBoardCoords } from '../../src/shared/scoring';
import { REFERENCE_POINTS, computeSpiderHomography, transformPoint } from '../../src/shared/vision/homography';
import {
  sliderValueToLensK1,
  distortNormalizedPoint,
  undistortNormalizedPoint,
} from '../../src/shared/vision/lensDistortion';
import { processPredictions } from '../../src/client/vision/predictionPipeline';
import { boardWarpMatrix, publishedBoardGeometry, type BoardGeometry } from '../../src/shared/vision/feedGeometry';
import { NORMALIZED_RADII } from '../../src/shared/boardGeometry';
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

// ============================================================
// What a published frame says about the board
// ============================================================

/**
 * The receiver's half of the geometry block, written out here and nowhere else.
 *
 * This is the journey a warping receiver would make, and there is deliberately no implementation of
 * it in `src/` yet — so this test is what says the thirteen numbers are *sufficient*. If it stops
 * passing, no amount of receiver code would have helped.
 */
function pixelToBoard(geometry: BoardGeometry, pixelX: number, pixelY: number, frameSize: number): Point2D {
  const u = pixelX / frameSize;
  const v = pixelY / frameSize;
  const distorted: Point2D = [
    geometry.shot.x + u * geometry.shot.size,
    geometry.shot.y + v * geometry.shot.size,
  ];
  const undistorted = Math.abs(geometry.lensK1) >= 1e-12
    ? undistortNormalizedPoint(distorted, geometry.lensK1)
    : distorted;
  const board = transformPoint(undistorted, geometry.homography);
  if (!board) throw new Error('the block did not describe a board');
  return [board[0] * BOARD_MAX, board[1] * BOARD_MAX];
}

/** Push every number in a block through float32, as the wire does. */
function throughFloat32(geometry: BoardGeometry): BoardGeometry {
  return {
    homography: geometry.homography.map((row) => row.map(Math.fround)) as Matrix3x3,
    lensK1: Math.fround(geometry.lensK1),
    shot: {
      x: Math.fround(geometry.shot.x),
      y: Math.fround(geometry.shot.y),
      size: Math.fround(geometry.shot.size),
    },
  };
}

describe('publishedBoardGeometry', () => {
  /** The model's input square inside a 1280×720 stream — the centre crop the pipeline feeds. */
  const crop = { cropX: 280, cropY: 0, cropSize: 720 };
  /** A shot of the middle of that square, as a director's quarter-board move produces. */
  const shot = { x: 280 + 150, y: 130, size: 430 };
  const FRAME = 320;

  /** The camera's own solved matrix, in board units, exactly as `visionRuntime` holds it. */
  function solved(lens: number): Matrix3x3 {
    const keypoints = lens === 0 ? boardKeypoints() : boardKeypoints().map((kp) => {
      const [x, y] = distortNormalizedPoint([kp[0], kp[1]], sliderValueToLensK1(lens));
      return [x, y, kp[2], kp[3]] as Keypoint;
    });
    const result = processPredictions(keypoints, 0.85, 0.8, lens);
    if (!result) throw new Error('the synthetic board did not solve');
    return result.homography;
  }

  for (const lens of [0, 40]) {
    it(`sends a published pixel back to the board point it came from (lens ${lens})`, () => {
      const homography = solved(lens);
      const k1 = sliderValueToLensK1(lens);
      const geometry = publishedBoardGeometry({ homography, lensCalibration: lens, crop, shot })!;
      expect(geometry).not.toBeNull();

      for (const board of [polar(0, 0), polar(103_000, 18), polar(330_000, 180), polar(165_000, 306)]) {
        // Forward, the way a camera makes a frame: board → this camera's picture → the lens →
        // source pixels → the square that was actually published.
        const ideal = project(board);
        const seen = Math.abs(k1) >= 1e-12 ? distortNormalizedPoint(ideal, k1) : ideal;
        const sourceX = crop.cropX + seen[0] * crop.cropSize;
        const sourceY = crop.cropY + seen[1] * crop.cropSize;
        const pixelX = ((sourceX - shot.x) / shot.size) * FRAME;
        const pixelY = ((sourceY - shot.y) / shot.size) * FRAME;

        // And back, with nothing but the thirteen numbers and the frame's own width.
        const [x, y] = pixelToBoard(geometry, pixelX, pixelY, FRAME);
        expect(Math.hypot(x - board[0], y - board[1])).toBeLessThan(200);
      }
    });
  }

  it('survives the float32 the wire carries it in', () => {
    // The bound is two hundred board units — under a tenth of a millimetre, and against the three
    // thousand a single pixel of a 320px frame covers. What float32 actually costs here is nearer a
    // twentieth of a unit; the slack is for the fixed-point undistortion, which is the loose step in
    // this chain and has nothing to do with the wire.
    const geometry = publishedBoardGeometry({
      homography: solved(40), lensCalibration: 40, crop, shot,
    })!;
    const wire = throughFloat32(geometry);

    for (const board of [polar(0, 0), polar(103_000, 18), polar(330_000, 180)]) {
      const ideal = project(board);
      const seen = distortNormalizedPoint(ideal, sliderValueToLensK1(40));
      const pixelX = ((crop.cropX + seen[0] * crop.cropSize - shot.x) / shot.size) * FRAME;
      const pixelY = ((crop.cropY + seen[1] * crop.cropSize - shot.y) / shot.size) * FRAME;

      const [x, y] = pixelToBoard(wire, pixelX, pixelY, FRAME);
      expect(Math.hypot(x - board[0], y - board[1])).toBeLessThan(200);
    }
  });

  it('describes nothing rather than something invented', () => {
    const homography = solved(0);
    expect(publishedBoardGeometry({
      homography, lensCalibration: 0, crop: { cropX: 0, cropY: 0, cropSize: 0 }, shot,
    })).toBeNull();
    expect(publishedBoardGeometry({
      homography, lensCalibration: 0, crop, shot: { x: 0, y: 0, size: 0 },
    })).toBeNull();
    expect(publishedBoardGeometry({
      homography: [[Number.NaN, 0, 0], [0, 1, 0], [0, 0, 1]], lensCalibration: 0, crop, shot,
    })).toBeNull();
  });
});

// ============================================================
// Laying a published frame over the board it shows
// ============================================================

describe('boardWarpMatrix', () => {
  /** The model's input square inside a 1280×720 stream, as elsewhere in this file. */
  const crop = { cropX: 280, cropY: 0, cropSize: 720 };
  /** The board box, in the CSS pixels a frontend draws it at. */
  const BOX = 600;

  function solved(lens: number): Matrix3x3 {
    const keypoints = lens === 0 ? boardKeypoints() : boardKeypoints().map((kp) => {
      const [x, y] = distortNormalizedPoint([kp[0], kp[1]], sliderValueToLensK1(lens));
      return [x, y, kp[2], kp[3]] as Keypoint;
    });
    const result = processPredictions(keypoints, 0.85, 0.8, lens);
    if (!result) throw new Error('the synthetic board did not solve');
    return result.homography;
  }

  /**
   * Where a board point appears in the transformed element, in its own CSS pixels.
   *
   * The forward journey a camera makes — board, this camera's picture, the lens, the published
   * square — ending in the element the transform is applied to, which is the published canvas
   * stretched across the whole board box.
   */
  function elementPixel(
    board: Point2D, lens: number, shot: { x: number; y: number; size: number },
  ): Point2D {
    const k1 = sliderValueToLensK1(lens);
    const ideal = project(board);
    const seen = Math.abs(k1) >= 1e-12 ? distortNormalizedPoint(ideal, k1) : ideal;
    return [
      ((crop.cropX + seen[0] * crop.cropSize - shot.x) / shot.size) * BOX,
      ((crop.cropY + seen[1] * crop.cropSize - shot.y) / shot.size) * BOX,
    ];
  }

  /** Where the transform puts it, in the board box's pixels. */
  function placed(matrix: Matrix3x3, pixel: Point2D): Point2D {
    const point = transformPoint(pixel, matrix);
    if (!point) throw new Error('the transform placed nothing');
    return point;
  }

  /**
   * Where the virtual board draws that same point, in the same pixels.
   *
   * **Board y is up and a screen's y is down** — the crossing `toSvg` makes in
   * `client/components/boardGeometry.ts`. Written out here rather than inline because the first
   * version of this test compared against board y directly: a vertically mirrored board, which every
   * assertion symmetric about the bull passes happily.
   */
  function onScreen(board: Point2D): Point2D {
    return [(board[0] / BOARD_MAX) * BOX, (1 - board[1] / BOARD_MAX) * BOX];
  }

  const wholeBoard = { x: crop.cropX, y: crop.cropY, size: crop.cropSize };
  /** What a dart-evidence command produces: a quarter of the frame, here centred on the bull. */
  const zoomed = (() => {
    const bull = project(polar(0, 0));
    const side = crop.cropSize / 4;
    return {
      x: crop.cropX + bull[0] * crop.cropSize - side / 2,
      y: crop.cropY + bull[1] * crop.cropSize - side / 2,
      size: side,
    };
  })();

  for (const [name, shot] of [['the whole board', wholeBoard], ['a director\'s zoom', zoomed]] as const) {
    it(`lays ${name} over the board it shows`, () => {
      const geometry = publishedBoardGeometry({
        homography: solved(0), lensCalibration: 0, crop, shot,
      })!;
      const matrix = boardWarpMatrix(geometry, BOX)!;
      expect(matrix).not.toBeNull();

      // The registration claim itself: whatever the camera saw, wherever the shot was pointed, a
      // board point lands where the virtual board draws it. Deliberately above and below the bull
      // as well as left and right of it, so a mirrored board cannot pass: the treble 20 is at the
      // top, and the rim point at 234° is down and to the left.
      for (const board of [polar(0, 0), polar(103_000, 0), polar(NORMALIZED_RADII.boardOuter * BOARD_MAX, 234)]) {
        const [x, y] = placed(matrix, elementPixel(board, 0, shot));
        const [wantX, wantY] = onScreen(board);
        expect(x).toBeCloseTo(wantX, 6);
        expect(y).toBeCloseTo(wantY, 6);
      }
    });
  }

  it('places a shot by what it covers rather than stretching it over the board', () => {
    // The behaviour change worth pinning: a director command that fills the published frame with a
    // quarter of the board must not fill the *board box* with it. The video goes where the video is.
    const geometry = publishedBoardGeometry({
      homography: solved(0), lensCalibration: 0, crop, shot: zoomed,
    })!;
    const matrix = boardWarpMatrix(geometry, BOX)!;

    const spread = (shot: { x: number; y: number; size: number }) => {
      const m = boardWarpMatrix(publishedBoardGeometry({
        homography: solved(0), lensCalibration: 0, crop, shot,
      })!, BOX)!;
      const corners = ([[0, 0], [BOX, 0], [BOX, BOX], [0, BOX]] as Point2D[]).map((c) => placed(m, c));
      return Math.max(...corners.map(([x]) => x)) - Math.min(...corners.map(([x]) => x));
    };

    // A quarter of the frame covers about a quarter of the board, and this places it there. Note
    // what that means and why the device does not lean on it: a shot like this is never described
    // in practice, because a viewer given it would watch a camera move *shrink* into a dart rather
    // than zoom into one. See `grabVideoFrame`. The arithmetic still has to be right — the same shot
    // affine carries the resting framing — so it is pinned here.
    expect(spread(wholeBoard)).toBeGreaterThan(BOX * 0.9);
    expect(spread(zoomed)).toBeLessThan(BOX * 0.5);
  });

  it('refuses rather than handing a browser something it will tear', () => {
    const geometry = publishedBoardGeometry({
      homography: solved(0), lensCalibration: 0, crop, shot: wholeBoard,
    })!;

    expect(boardWarpMatrix(geometry, 0)).toBeNull();
    expect(boardWarpMatrix(geometry, -1)).toBeNull();
    expect(boardWarpMatrix({ ...geometry, homography: [[Number.NaN, 0, 0], [0, 1, 0], [0, 0, 1]] }, BOX)).toBeNull();

    // A horizon crossing the picture: the divisor changes sign half way along, and past it the frame
    // folds through the vanishing line. Browsers draw that rather than declining to.
    const horizon: BoardGeometry = {
      homography: [[1, 0, 0], [0, 1, 0], [-2, 0, 1]],
      lensK1: 0,
      shot: { x: 0, y: 0, size: 1 },
    };
    expect(boardWarpMatrix(horizon, BOX)).toBeNull();
  });

  it('costs this much for dropping the lens correction', () => {
    // Not a tolerance — a measurement, kept where somebody changing the distortion model will see
    // what it does to the picture. A radial term is not projective, so no matrix can carry it; the
    // question is only whether what is left over is small enough to look at, and at the maximum
    // slider it is a couple of percent of the board's radius at the rim.
    const radius = NORMALIZED_RADII.boardOuter * BOX;
    const worstAt = (lens: number) => {
      const geometry = publishedBoardGeometry({
        homography: solved(lens), lensCalibration: lens, crop, shot: wholeBoard,
      })!;
      const matrix = boardWarpMatrix(geometry, BOX)!;
      let worst = 0;
      for (let bearing = 0; bearing < 360; bearing += 15) {
        const board = polar(NORMALIZED_RADII.boardOuter * BOARD_MAX, bearing);
        const [x, y] = placed(matrix, elementPixel(board, lens, wholeBoard));
        const [wantX, wantY] = onScreen(board);
        worst = Math.max(worst, Math.hypot(x - wantX, y - wantY));
      }
      return worst / radius;
    };

    // Exact for a camera nobody has calibrated, which is most of them: with k1 at zero the whole
    // journey is projective and a matrix carries it perfectly.
    expect(worstAt(0)).toBeLessThan(1e-9);

    // And from there it grows in proportion to the slider — measured on this synthetic camera at
    // roughly a tenth of a percent of the rim radius per point of it:
    //
    //   slider  20 → 1.9% of the rim radius →  6px of a 600px board
    //   slider  60 → 5.8%                    → 18px
    //   slider 100 → 9.8%                    → 29px
    //
    // A phone that needed the whole slider would show a rim visibly off the drawn one. Nothing is
    // scored from this picture, and the fix is a shader; if these numbers ever matter, that is the
    // conversation, and this is the test that would start it.
    expect(worstAt(20)).toBeLessThan(0.03);
    expect(worstAt(100)).toBeLessThan(0.11);
  });
});
