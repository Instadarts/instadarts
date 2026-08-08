// The camera device's geometry step: threshold filter, dedup, undistort, homography, project,
// clamp into board space.
//
// This is where the camera's work ends. It produces board coordinates and stops: which of these
// tips are new, and what they are worth, is the server's to decide.

import { BOARD_MAX } from '../../shared/scoring';
import { computeSpiderHomography, transformPoint } from '../../shared/vision/homography';
import { sliderValueToLensK1, undistortNormalizedPoint } from '../../shared/vision/lensDistortion';
import { KEYPOINT_DEDUP_RADIUS } from '../../shared/vision/constants';
import type { Keypoint, Matrix3x3, Point2D } from '../../shared/vision/types';

export interface TipProjection {
  x: number;
  y: number;
  confidence: number;
}

export interface PipelineResult {
  homography: Matrix3x3;
  tips: TipProjection[];
  /** Count of class 0–7 keypoints after threshold filtering. */
  boardKeypoints: number;
  /** Count of class 8 keypoints after threshold filtering and dedup. */
  tipKeypoints: number;
}

/**
 * Deduplicate keypoints: within KEYPOINT_DEDUP_RADIUS (image space), keep the higher confidence.
 */
function deduplicateKeypoints(kps: Keypoint[]): Keypoint[] {
  if (kps.length <= 1) return kps;

  const sorted = [...kps].sort((a, b) => b[2] - a[2]);
  const kept: Keypoint[] = [];

  for (const kp of sorted) {
    const tooClose = kept.some((k) => Math.hypot(k[0] - kp[0], k[1] - kp[1]) < KEYPOINT_DEDUP_RADIUS);
    if (!tooClose) kept.push(kp);
  }

  return kept;
}

/**
 * Turn one inference's raw keypoints into board-space dart tips.
 *
 * Returns null when the board was not visible enough to solve a homography. That is NOT the same
 * as an empty board, and the caller must not report it as one — see the guard in visionRuntime.
 */
export function processPredictions(
  data: Keypoint[],
  boardThreshold: number,
  tipThreshold: number,
  lensCalibrationValue = 0,
): PipelineResult | null {
  if (!data || data.length === 0) return null;

  const boardKps = data.filter((d) => d[3] >= 0 && d[3] <= 7 && d[2] >= boardThreshold);
  const tipKps = deduplicateKeypoints(data.filter((d) => d[3] === 8 && d[2] >= tipThreshold));

  if (boardKps.length < 4) return null;

  const lensK1 = sliderValueToLensK1(lensCalibrationValue);
  const useLensCorrection = Math.abs(lensK1) >= 1e-12;
  const homographyBoardKps = useLensCorrection ? undistortBoardKeypoints(boardKps, lensK1) : boardKps;

  const homography = computeSpiderHomography(homographyBoardKps);
  if (!homography) return null;

  const tips: TipProjection[] = [];
  for (const d of tipKps) {
    const originalImage: Point2D = [d[0], d[1]];
    const correctedImage = useLensCorrection ? undistortNormalizedPoint(originalImage, lensK1) : originalImage;
    const proj = transformPoint(correctedImage, homography);
    if (!proj) continue;
    tips.push({
      x: clampToBoard(proj[0]),
      y: clampToBoard(proj[1]),
      confidence: d[2],
    });
  }

  return {
    homography,
    tips,
    boardKeypoints: boardKps.length,
    tipKeypoints: tipKps.length,
  };
}

function clampToBoard(value: number): number {
  return Math.round(Math.max(0, Math.min(BOARD_MAX, value)));
}

function undistortBoardKeypoints(boardKps: Keypoint[], lensK1: number): Keypoint[] {
  return boardKps.map((keypoint): Keypoint => {
    const undistorted = undistortNormalizedPoint([keypoint[0], keypoint[1]], lensK1);
    return [undistorted[0], undistorted[1], keypoint[2], keypoint[3]];
  });
}
