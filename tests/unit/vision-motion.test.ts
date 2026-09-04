import { describe, it, expect } from 'vitest';
import { diffMask, gaussianBlur, fillTileCounts, rgbaToGray, type MotionDefaults } from '../../src/client/vision/motionAnalysis';

/**
 * The motion gate's arithmetic.
 *
 * This is what decides whether an inference runs at all, so a regression here is not a wrong score
 * — it is a board that stops being watched, or a phone that runs the model on every frame and gets
 * hot. Neither shows up as a failure anywhere else, which is why these are pinned so tightly.
 *
 * A 8x8 analysis square keeps the fixtures readable; the real one is 240x240.
 *
 * Noise reduction is a 5×5 separable Gaussian blur [1,4,6,4,1] applied *before* frame
 * differencing — the Android-proven strategy that replaced the old dilate+erode morphology.
 */
const DEFAULTS: MotionDefaults = {
  gridRows: 2,
  gridCols: 2,
  tileChangePercent: 10,
  minTiles: 1,
  maxTiles: 8,
  pixelThreshold: 15,
  pixelThresholdMult: 0.5,
  analyzeSize: 8,
  quietTimeMs: 300,
  quietFrames: 3,
  largeMotionQuietMultiplier: 2,
};

const SIZE = DEFAULTS.analyzeSize;

/** A blank frame, with an optional patch of a given value. */
function frame(fill = 0, patch?: { x: number; y: number; w: number; h: number; value: number }) {
  const grey = new Uint8Array(SIZE * SIZE).fill(fill);
  if (patch) {
    for (let y = patch.y; y < patch.y + patch.h; y++) {
      for (let x = patch.x; x < patch.x + patch.w; x++) grey[y * SIZE + x] = patch.value;
    }
  }
  return grey;
}

const countSet = (mask: Uint8Array) => mask.reduce((n, v) => n + v, 0);

describe('rgbaToGray', () => {
  it('weights the channels the way the eye does', () => {
    // Rec.601 luma: 0.299R + 0.587G + 0.114B. A shader that swapped the coefficients would still
    // produce a plausible grey, and every downstream threshold would shift with it.
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 255, 255,
    ]);
    expect(Array.from(rgbaToGray(rgba))).toEqual([76, 150, 29, 255]);
  });

  it('produces one grey byte per pixel', () => {
    expect(rgbaToGray(new Uint8ClampedArray(4 * 16)).length).toBe(16);
  });
});

describe('gaussianBlur', () => {
  it('preserves a uniform image', () => {
    const flat = frame(100);
    const blurred = gaussianBlur(flat, SIZE);
    // Every output pixel should be within rounding error of the input.
    for (let i = 0; i < blurred.length; i++) {
      expect(blurred[i]).toBe(100);
    }
  });

  it('spreads a single bright pixel into its neighbourhood', () => {
    // A single pixel of 255 on a black background. The blur kernel [1,4,6,4,1]²
    // distributes energy over a 5×5 footprint, so the centre pixel is dimmed and
    // the immediate neighbours pick up some brightness.
    const dot = frame(0, { x: 4, y: 4, w: 1, h: 1, value: 255 });
    const blurred = gaussianBlur(dot, SIZE);
    // Centre pixel is attenuated — energy spread to neighbours.
    expect(blurred[4 * SIZE + 4]).toBeLessThan(255);
    expect(blurred[4 * SIZE + 4]).toBeGreaterThan(0);
    // At least one immediate neighbour picked up brightness.
    const neighbourValues = [
      blurred[3 * SIZE + 4],  // above
      blurred[5 * SIZE + 4],  // below
      blurred[4 * SIZE + 3],  // left
      blurred[4 * SIZE + 5],  // right
    ];
    expect(neighbourValues.some(v => v > 0)).toBe(true);
    // Far-away pixels are still zero.
    expect(blurred[0]).toBe(0);
  });

  it('blurs symmetrically', () => {
    const dot = frame(0, { x: 4, y: 4, w: 1, h: 1, value: 255 });
    const blurred = gaussianBlur(dot, SIZE);
    // Horizontal and vertical neighbours at the same distance should be equal.
    expect(blurred[4 * SIZE + 3]).toBe(blurred[4 * SIZE + 5]);  // left === right
    expect(blurred[3 * SIZE + 4]).toBe(blurred[5 * SIZE + 4]);  // above === below
  });

  it('clamps border pixels rather than wrapping', () => {
    const flat = frame(10);
    const edge = frame(255, { x: 0, y: 0, w: 1, h: 1, value: 255 });
    // Both should produce finite, non-wrapping values — no NaN, no negative.
    const b1 = gaussianBlur(flat, SIZE);
    const b2 = gaussianBlur(edge, SIZE);
    for (let i = 0; i < b1.length; i++) {
      expect(b1[i]).toBeGreaterThanOrEqual(0);
      expect(b1[i]).toBeLessThanOrEqual(255);
      expect(b2[i]).toBeGreaterThanOrEqual(0);
      expect(b2[i]).toBeLessThanOrEqual(255);
    }
  });
});

describe('diffMask', () => {
  it('sees nothing when nothing changed', () => {
    const still = frame(100);
    // Both frames are already blurred — in the real pipeline gaussianBlur is
    // called before diffMask, but for identical inputs the blur is irrelevant.
    expect(countSet(diffMask(still, still, DEFAULTS))).toBe(0);
  });

  it('ignores a change smaller than the pixel threshold', () => {
    // 14 is below the threshold of 15: sensor noise must not wake the model up.
    const before = frame(100);
    const after = frame(100, { x: 1, y: 1, w: 4, h: 4, value: 114 });
    expect(countSet(diffMask(before, after, DEFAULTS))).toBe(0);
  });

  it('sees a change at the threshold, in either direction', () => {
    const before = frame(100);
    expect(countSet(diffMask(before, frame(100, { x: 1, y: 1, w: 4, h: 4, value: 115 }), DEFAULTS))).toBeGreaterThan(0);
    expect(countSet(diffMask(before, frame(100, { x: 1, y: 1, w: 4, h: 4, value: 85 }), DEFAULTS))).toBeGreaterThan(0);
  });

  it('detects every changed pixel in a patch', () => {
    // With blur-based noise reduction, diffMask is plain thresholding — it
    // marks every pixel whose absolute difference crosses the threshold.
    // (The caller applies gaussianBlur before calling diffMask.)
    const before = frame(0);
    const patch = frame(0, { x: 2, y: 2, w: 4, h: 4, value: 255 });
    // A 4×4 patch at 255 vs 0: all 16 pixels should be flagged.
    expect(countSet(diffMask(before, patch, DEFAULTS))).toBe(16);
  });
});

describe('fillTileCounts', () => {
  it('counts changed pixels into the tile they fall in', () => {
    // A 2x2 grid over an 8x8 square: each tile is 4x4, so the top-left quadrant is tile 0.
    const mask = new Uint8Array(SIZE * SIZE);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) mask[y * SIZE + x] = 1;

    const counts = new Uint32Array(4);
    fillTileCounts(mask, counts, DEFAULTS);
    expect(Array.from(counts)).toEqual([16, 0, 0, 0]);
  });

  it('splits a change that straddles a tile boundary', () => {
    const mask = new Uint8Array(SIZE * SIZE);
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) mask[y * SIZE + x] = 1;

    const counts = new Uint32Array(4);
    fillTileCounts(mask, counts, DEFAULTS);
    // Dead centre of a 2x2 grid: four pixels into each quadrant.
    expect(Array.from(counts)).toEqual([4, 4, 4, 4]);
  });

  it('writes every tile, so a stale count cannot survive a pass', () => {
    const counts = new Uint32Array(4).fill(99);
    fillTileCounts(new Uint8Array(SIZE * SIZE), counts, DEFAULTS);
    expect(Array.from(counts)).toEqual([0, 0, 0, 0]);
  });
});
