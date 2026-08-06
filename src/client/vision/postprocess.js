// Tensor decoding, ported verbatim from dartszentrale-ai-scorer src/vision/postprocess.js.
// Pure: [10, N] single-class + [3, N] multi-class → [x, y, score, classId] in normalized image
// space. No boxes, no anchors, no NMS — the model emits keypoints directly.
const CONFIDENCE_THRESHOLD = 0.1;
const SINGLE_CLASSES = 8;
const MULTI_CLASS_ID = 8;
const MAX_DET = 32;

export function postprocess(singleTensor, multiTensor, inputSize) {
  // single: shape [10, N_single] (8 class scores + 2 keypoint coords)
  // multi:  shape [3, N_multi] (1 class score + 2 keypoint coords)
  const nSingle = singleTensor.length / 10;
  const nMulti = multiTensor.length / 3;
  const detections = [];

  // The eight board keypoints are structurally at most one each: argmax over positions per class.
  for (let cls = 0; cls < SINGLE_CLASSES; cls += 1) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    const base = cls * nSingle;

    for (let pos = 0; pos < nSingle; pos += 1) {
      const score = singleTensor[base + pos];
      if (score > bestScore) {
        bestScore = score;
        bestIdx = pos;
      }
    }

    if (bestScore >= CONFIDENCE_THRESHOLD) {
      const kx = singleTensor[SINGLE_CLASSES * nSingle + bestIdx];
      const ky = singleTensor[(SINGLE_CLASSES + 1) * nSingle + bestIdx];
      detections.push([kx, ky, bestScore, cls]);
    }
  }

  const remaining = MAX_DET - detections.length;
  if (remaining > 0 && nMulti > 0) {
    const pairs = [];
    for (let pos = 0; pos < nMulti; pos += 1) {
      const score = multiTensor[pos];
      if (score >= CONFIDENCE_THRESHOLD) {
        pairs.push({ score, idx: pos });
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    const k = Math.min(remaining, pairs.length);
    for (let i = 0; i < k; i += 1) {
      const { score, idx } = pairs[i];
      const kx = multiTensor[nMulti + idx];
      const ky = multiTensor[2 * nMulti + idx];
      detections.push([kx, ky, score, MULTI_CLASS_ID]);
    }
  }

  return [normalizeDetectionCoordinates(detections, inputSize)];
}

// The model may emit either normalized or pixel coordinates; divide only when they look like pixels.
function normalizeDetectionCoordinates(detections, inputSize) {
  const maxCoordinate = detections.reduce((maxValue, detection) => {
    return Math.max(maxValue, Math.abs(Number(detection[0])), Math.abs(Number(detection[1])));
  }, 0);
  if (maxCoordinate <= 2) {
    return detections;
  }
  return detections.map((detection) => [
    detection[0] / inputSize,
    detection[1] / inputSize,
    detection[2],
    detection[3],
  ]);
}
