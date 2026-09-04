// Per-frame image→board homography.
//
// RANSAC over the eight double-ring keypoints the model finds, validated against real boards.
// There is no stored board calibration: every inference re-solves this from the keypoints it just
// saw, which is what lets the camera be nudged mid-session without anyone recalibrating.
//
// THE ONE CHANGE FROM THE REFERENCE is REFERENCE_POINTS, which are expressed in instadarts board
// space ([0, BOARD_MAX], y-up, bull at the centre) instead of the reference's [0,1] y-down. This is
// the earliest point at which board space exists at all, so from here on there is exactly one board
// coordinate system in the codebase.
//
// Two numeric consequences of that, both benign — do not "fix" them:
//   · The y-flip makes the transform orientation-reversing (det H < 0). solve4Point is an
//     unconstrained 8-DOF linear solve and evaluateMatrix only measures reprojection distance, so
//     neither cares about handedness.
//   · Destination coordinates at 1e6 mix with source coordinates at 1 inside solve4Point's rows,
//     costing roughly six digits in the elimination. Double precision leaves about ten, against the
//     six we need for sub-unit board accuracy. The absolute 1e-10 / 1e-12 epsilons below become
//     relatively *more* conservative at this scale, not less.

import { BOARD_MAX, BOARD_CENTER } from '../scoring';
import type { Keypoint, Matrix3x3, Point2D } from './types';

const HOMOGRAPHY_INLIER_SCALE_RATIO = 0.005;
const MIN_VISIBLE_KEYPOINTS = 4;
const MIN_COVERED_PAIRS = 3;

/** Dartboard sectors in clockwise order, starting at the top. */
const SECTOR_ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

/** The eight keypoint classes, each a sector boundary on the outside of the double ring. */
const KEYPOINT_NAMES = ['18-4', '4-13', '10-15', '15-2', '7-16', '16-8', '14-9', '9-12'];

/** At least 3 of these 4 pairs must have a detection — a guard against a degenerate one-sided fit. */
const CLASS_PAIRS = [[0, 1], [2, 3], [4, 5], [6, 7]] as const;

/** Where each keypoint class sits on a real board, in instadarts board coordinates. */
export const REFERENCE_POINTS: Point2D[] = (() => {
  const radius = 170.0 * (0.5 / 225.5) * BOARD_MAX; // outside of the double ring
  const centerAngles = new Map(SECTOR_ORDER.map((n, i) => [n, i * 18]));
  return KEYPOINT_NAMES.map((name) => {
    const [left, right] = name.split('-').map(Number);
    const thetaDeg = 0.5 * ((centerAngles.get(left) ?? 0) + (centerAngles.get(right) ?? 0));
    const theta = (thetaDeg * Math.PI) / 180;
    // theta is a bearing clockwise from straight up, and y grows upward, so cos is added.
    return [BOARD_CENTER + radius * Math.sin(theta), BOARD_CENTER + radius * Math.cos(theta)] as Point2D;
  });
})();

/**
 * Extract board keypoints (classes 0–7), check coverage, compute the image→board homography.
 * Returns null when the board was not seen well enough to say where anything is.
 */
export function computeSpiderHomography(allDetections: Keypoint[]): Matrix3x3 | null {
  const keypoints = allDetections
    .filter((d) => d[3] >= 0 && d[3] <= 7)
    .map((d) => ({ classId: d[3], x: d[0], y: d[1] }));

  if (keypoints.length < MIN_VISIBLE_KEYPOINTS) return null;

  let coveredPairs = 0;
  const seen = new Set(keypoints.map((k) => k.classId));
  for (const [a, b] of CLASS_PAIRS) {
    if (seen.has(a) || seen.has(b)) coveredPairs++;
  }
  if (coveredPairs < MIN_COVERED_PAIRS) return null;

  const srcPts: Point2D[] = [];
  const dstPts: Point2D[] = [];
  for (const kp of keypoints) {
    srcPts.push([kp.x, kp.y]);
    dstPts.push(REFERENCE_POINTS[kp.classId]);
  }

  return findHomography(srcPts, dstPts);
}

/** Transform a point through a homography (perspective divide). */
export function transformPoint(point: Point2D, matrix: Matrix3x3): Point2D | null {
  const x = point[0];
  const y = point[1];
  const denom = matrix[2][0] * x + matrix[2][1] * y + matrix[2][2];
  if (!isFinite(denom) || Math.abs(denom) < 1e-9) return null;
  const px = (matrix[0][0] * x + matrix[0][1] * y + matrix[0][2]) / denom;
  const py = (matrix[1][0] * x + matrix[1][1] * y + matrix[1][2]) / denom;
  if (!isFinite(px) || !isFinite(py)) return null;
  return [px, py];
}

/**
 * The other way round: board→image, for asking where a known board position appears in a frame.
 *
 * The pipeline only ever needs image→board — a keypoint arrives and a board coordinate comes out —
 * so this exists for the one job that runs backwards: a **still request** names a square of the
 * board, and the camera has to find it in its own picture.
 *
 * Adjugate over determinant, which for 3×3 is exact arithmetic rather than an elimination, so it
 * adds no error of its own to a matrix that already spent digits mixing 1e6 destinations with unit
 * sources (see the note at the top of this file). Scale is irrelevant — a homography is projective,
 * and `transformPoint` divides it out.
 *
 * Returns null for a singular matrix, which a solved homography never is, but a hand-made one in a
 * test might be.
 */
export function invertMatrix3x3(m: Matrix3x3): Matrix3x3 | null {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;

  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;

  const det = a * A + b * B + c * C;
  if (!isFinite(det) || Math.abs(det) < 1e-12) return null;

  const inverse: Matrix3x3 = [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
  for (const row of inverse) {
    for (const value of row) if (!isFinite(value)) return null;
  }
  return inverse;
}

// ============================================================
// RANSAC
// ============================================================

/**
 * Exhaustive RANSAC: every 4-subset is solved exactly and scored by inlier count. With at most
 * eight keypoints that is 70 solves, which is cheaper than being clever.
 */
function findHomography(src: Point2D[], dst: Point2D[]): Matrix3x3 | null {
  if (src.length !== dst.length || src.length < 4) return null;

  const combos = generateCombinations(src.length, 4);
  if (!combos.length) return null;

  const threshold = Math.max(estimateScale(dst) * HOMOGRAPHY_INLIER_SCALE_RATIO, 1e-6);
  const candidates: { matrix: Matrix3x3; inliers: number; meanError: number }[] = [];

  for (const indices of combos) {
    const subsetSrc = indices.map((i) => src[i]);
    const subsetDst = indices.map((i) => dst[i]);
    const matrix = solve4Point(subsetSrc, subsetDst);
    if (!matrix) continue;

    const { inliers, meanError } = evaluateMatrix(matrix, src, dst, threshold);
    if (inliers >= 4) {
      candidates.push({ matrix, inliers, meanError });
    }
  }

  if (!candidates.length) {
    return src.length === 4 ? solve4Point(src, dst) : null;
  }

  // Most inliers wins, tiebreak on lowest mean error.
  return candidates.reduce((best, c) => {
    if (c.inliers > best.inliers) return c;
    if (c.inliers === best.inliers && c.meanError < best.meanError) return c;
    return best;
  }, candidates[0]).matrix;
}

function solve4Point(src: Point2D[], dst: Point2D[]): Matrix3x3 | null {
  const m: number[][] = [];
  const v: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, vv] = dst[i];
    m.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    v.push(u);
    m.push([0, 0, 0, x, y, 1, -vv * x, -vv * y]);
    v.push(vv);
  }
  const sol = gaussianElimination(m, v);
  if (!sol) return null;
  return normalizeMatrix([
    [sol[0], sol[1], sol[2]],
    [sol[3], sol[4], sol[5]],
    [sol[6], sol[7], 1],
  ]);
}

function gaussianElimination(matrix: number[][], vector: number[]): number[] | null {
  const n = matrix.length;
  const aug = matrix.map((row, i) => [...row, vector[i]]);
  for (let p = 0; p < n; p++) {
    let best = p;
    for (let r = p + 1; r < n; r++) {
      if (Math.abs(aug[r][p]) > Math.abs(aug[best][p])) best = r;
    }
    if (Math.abs(aug[best][p]) < 1e-10) return null;
    if (best !== p) [aug[p], aug[best]] = [aug[best], aug[p]];
    const pivot = aug[p][p];
    for (let c = p; c <= n; c++) aug[p][c] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === p) continue;
      const f = aug[r][p];
      for (let c = p; c <= n; c++) aug[r][c] -= f * aug[p][c];
    }
  }
  return aug.map((row) => row[n]);
}

function normalizeMatrix(matrix: number[][]): Matrix3x3 {
  const s = matrix[2][2];
  if (!isFinite(s) || Math.abs(s) < 1e-12) return matrix as Matrix3x3;
  return matrix.map((row) => row.map((value) => value / s)) as Matrix3x3;
}

function evaluateMatrix(
  matrix: Matrix3x3,
  src: Point2D[],
  dst: Point2D[],
  threshold: number,
): { inliers: number; meanError: number } {
  let inliers = 0;
  let totalErr = 0;
  for (let i = 0; i < src.length; i++) {
    const proj = transformPoint(src[i], matrix);
    if (!proj) continue;
    const err = Math.hypot(proj[0] - dst[i][0], proj[1] - dst[i][1]);
    if (err <= threshold) {
      inliers++;
      totalErr += err;
    }
  }
  return { inliers, meanError: inliers ? totalErr / inliers : Infinity };
}

function estimateScale(points: Point2D[]): number {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

function generateCombinations(n: number, k: number): number[][] {
  const result: number[][] = [];
  const cur: number[] = [];
  (function visit(start: number) {
    if (cur.length === k) {
      result.push(cur.slice());
      return;
    }
    for (let i = start; i < n; i++) {
      cur.push(i);
      visit(i + 1);
      cur.pop();
    }
  })(0);
  return result;
}
