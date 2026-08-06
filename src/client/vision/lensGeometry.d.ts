import type { Keypoint } from '../../shared/vision/types';

export type SpiderProjection = {
  canCompute: boolean;
  reason?: string;
  keypointCount: number;
  /** Closed ring polylines, in normalized image space. */
  rings: [number, number][][];
  /** Sector boundary polylines, in normalized image space. */
  radials: [number, number][][];
  sections: unknown[];
  detections: { classId: number; x: number; y: number }[];
};

/**
 * Project the board's spider back into IMAGE space from the keypoints one inference found.
 * Overlaying that on a still is what makes lens calibration possible: you slide k1 until the drawn
 * lines sit on the board's real wires.
 *
 * Self-contained geometry: it builds its own board reference points and inverts its own homography,
 * so it never meets instadarts' board coordinates and needs no adaptation.
 */
export function computeDistortionCorrectedSpider(detections: Keypoint[], lensK1: number): SpiderProjection;
