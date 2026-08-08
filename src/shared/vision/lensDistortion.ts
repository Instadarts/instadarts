// Single-parameter radial lens distortion.
//
// This one stays in normalized *image* space ([0,1], y-down, origin top-left of the input square),
// because that is where a lens distorts: it is a property of the optics, not of the board. The
// slider mapping is kept because the calibration UI reuses the same -100..100 scale.

import type { Point2D } from './types';

const LENS_DISTORTION_MAX_K1 = 0.18;
const INVERSE_DISTORTION_ITERATIONS = 8;
const NORMALIZED_HALF_DIAGONAL = Math.SQRT1_2;

export function sliderValueToLensK1(value: number): number {
  const sliderValue = Number(value);
  if (!Number.isFinite(sliderValue)) return 0;
  const clampedValue = Math.min(Math.max(Math.round(sliderValue), -100), 100);
  return (clampedValue / 100) * LENS_DISTORTION_MAX_K1;
}

export function distortNormalizedPoint(point: Point2D, k1: number): Point2D {
  if (!Number.isFinite(k1) || Math.abs(k1) < 1e-12) return point;

  const dx = point[0] - 0.5;
  const dy = point[1] - 0.5;
  const r2 = (dx * dx + dy * dy) / (NORMALIZED_HALF_DIAGONAL * NORMALIZED_HALF_DIAGONAL);
  const scale = 1 + k1 * r2;
  return [0.5 + dx * scale, 0.5 + dy * scale];
}

export function undistortNormalizedPoint(distortedPoint: Point2D, k1: number): Point2D {
  if (!Number.isFinite(k1) || Math.abs(k1) < 1e-12) return distortedPoint;

  // Fixed-point inversion: there is no closed form, but the model is gentle enough that eight
  // passes converge well below a pixel.
  let undistortedPoint: Point2D = [distortedPoint[0], distortedPoint[1]];
  for (let index = 0; index < INVERSE_DISTORTION_ITERATIONS; index += 1) {
    const redistortedPoint = distortNormalizedPoint(undistortedPoint, k1);
    undistortedPoint = [
      undistortedPoint[0] + (distortedPoint[0] - redistortedPoint[0]),
      undistortedPoint[1] + (distortedPoint[1] - redistortedPoint[1]),
    ];
  }
  return undistortedPoint;
}
