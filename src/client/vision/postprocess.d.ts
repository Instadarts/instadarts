import type { Keypoint } from '../../shared/vision/types';

/**
 * Decode the model's two output tensors into keypoints.
 * Returns a one-element batch: `postprocess(...)[0]` is the detection list.
 */
export function postprocess(
  singleTensor: ArrayLike<number>,
  multiTensor: ArrayLike<number>,
  inputSize: number,
): Keypoint[][];
