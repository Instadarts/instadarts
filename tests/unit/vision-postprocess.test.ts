import { describe, it, expect } from 'vitest';
import { postprocess } from '../../src/client/vision/postprocess';

/**
 * Decoding the model's two output tensors.
 *
 * The tensors are laid out channel-major: a [C, N] tensor is C runs of N values, so value `c, n`
 * lives at `c * N + n`. Getting that stride wrong is the failure this file exists to catch, because
 * it does not throw — it silently reads a score as a coordinate and puts darts in the wrong bed.
 */

/** Build a [10, N] single-class tensor: 8 class-score rows, then the x and y rows. */
function singleTensor(n: number, entries: { cls: number; pos: number; score: number; x: number; y: number }[]) {
  const t = new Float32Array(10 * n).fill(-1);
  for (const { cls, pos, score, x, y } of entries) {
    t[cls * n + pos] = score;
    t[8 * n + pos] = x;
    t[9 * n + pos] = y;
  }
  return t;
}

/** Build a [3, N] multi-class tensor: one score row, then x and y. */
function multiTensor(n: number, entries: { pos: number; score: number; x: number; y: number }[]) {
  const t = new Float32Array(3 * n).fill(0);
  for (const { pos, score, x, y } of entries) {
    t[pos] = score;
    t[n + pos] = x;
    t[2 * n + pos] = y;
  }
  return t;
}

const EMPTY_MULTI = new Float32Array(0);

describe('postprocess', () => {
  it('takes the best position per board keypoint class', () => {
    // Class 3 scores higher at position 1 than at position 0; only the winner is emitted.
    const single = singleTensor(4, [
      { cls: 3, pos: 0, score: 0.4, x: 0.1, y: 0.1 },
      { cls: 3, pos: 1, score: 0.9, x: 0.7, y: 0.8 },
    ]);

    const [detections] = postprocess(single, EMPTY_MULTI, 960);
    expect(detections).toHaveLength(1);
    // closeTo throughout: the tensors are Float32Array, so 0.7 comes back as 0.69999998807.
    expect(detections[0]).toEqual([expect.closeTo(0.7), expect.closeTo(0.8), expect.closeTo(0.9), 3]);
  });

  it('reads x and y from the rows after the class scores, not from the scores', () => {
    // The whole point of the [C, N] stride: eight score rows come first, then x, then y.
    const single = singleTensor(2, [{ cls: 0, pos: 1, score: 0.8, x: 0.25, y: 0.75 }]);
    const [detections] = postprocess(single, EMPTY_MULTI, 960);
    expect(detections[0][0]).toBeCloseTo(0.25);
    expect(detections[0][1]).toBeCloseTo(0.75);
  });

  it('drops a class nothing scored above the confidence floor', () => {
    const single = singleTensor(2, [{ cls: 5, pos: 0, score: 0.05, x: 0.5, y: 0.5 }]);
    expect(postprocess(single, EMPTY_MULTI, 960)[0]).toEqual([]);
  });

  it('emits dart tips as class 8, best score first', () => {
    const multi = multiTensor(3, [
      { pos: 0, score: 0.3, x: 0.1, y: 0.1 },
      { pos: 1, score: 0.9, x: 0.2, y: 0.2 },
      { pos: 2, score: 0.6, x: 0.3, y: 0.3 },
    ]);

    const [detections] = postprocess(new Float32Array(0), multi, 960);
    expect(detections.map((d) => d[3])).toEqual([8, 8, 8]);
    expect(detections.map((d) => d[2])).toEqual([
      expect.closeTo(0.9), expect.closeTo(0.6), expect.closeTo(0.3),
    ]);
    expect(detections[0].slice(0, 2)).toEqual([expect.closeTo(0.2), expect.closeTo(0.2)]);
  });

  it('caps the whole detection list at 32, board keypoints first', () => {
    // Eight board classes plus 40 candidate tips: the tips are what gets cut.
    const single = singleTensor(1, [...Array(8)].map((_, cls) => ({ cls, pos: 0, score: 0.9, x: 0.5, y: 0.5 })));
    const multi = multiTensor(40, [...Array(40)].map((_, pos) => ({ pos, score: 0.5, x: 0.1, y: 0.1 })));

    const [detections] = postprocess(single, multi, 960);
    expect(detections).toHaveLength(32);
    expect(detections.filter((d) => d[3] !== 8)).toHaveLength(8);
  });

  it('normalizes coordinates that arrive in pixels, and leaves normalized ones alone', () => {
    // A model that emits pixels gives values far above 1; one that emits normalized never does.
    const pixels = singleTensor(1, [{ cls: 0, pos: 0, score: 0.9, x: 480, y: 240 }]);
    expect(postprocess(pixels, EMPTY_MULTI, 960)[0][0].slice(0, 2)).toEqual([0.5, 0.25]);

    const normalized = singleTensor(1, [{ cls: 0, pos: 0, score: 0.9, x: 0.5, y: 0.25 }]);
    expect(postprocess(normalized, EMPTY_MULTI, 960)[0][0].slice(0, 2)).toEqual([0.5, 0.25]);
  });

  it('treats a coordinate of exactly 2 as normalized, and just above it as pixels', () => {
    // The boundary of that guess, pinned so a change to it is deliberate.
    const at = singleTensor(1, [{ cls: 0, pos: 0, score: 0.9, x: 2, y: 2 }]);
    expect(postprocess(at, EMPTY_MULTI, 960)[0][0][0]).toBe(2);

    const above = singleTensor(1, [{ cls: 0, pos: 0, score: 0.9, x: 2.5, y: 2.5 }]);
    expect(postprocess(above, EMPTY_MULTI, 960)[0][0][0]).toBeCloseTo(2.5 / 960);
  });
});
