// Vision pipeline value types: what a keypoint, a homography and a board tip are.

export type Point2D = [number, number];

export type Matrix3x3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];

/** One raw model detection: [x, y, score, classId], x/y in normalized image space. */
export type Keypoint = [number, number, number, number];

/**
 * One observation of a dart tip, in instadarts board coordinates.
 *
 * `deviceId` is what the fusion code keys its repeat/attach logic on: a tip from a camera that
 * has already seen a tracked dart is a re-sighting, a tip from one that has not is that camera
 * seeing the dart for the first time.
 */
export interface DartPoint {
  x: number;
  y: number;
  confidence: number;
  deviceId: string;
}

/** One dart tip as it crosses the wire: board coordinates, integers. */
export interface BoardTip {
  x: number;
  y: number;
  confidence: number;
}
