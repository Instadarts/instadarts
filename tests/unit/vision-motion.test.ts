import { describe, it, expect } from 'vitest';
import { diffMask, dilate, erode, fillTileCounts, rgbaToGray, type MotionDefaults } from '../../src/client/vision/motionAnalysis';

/**
 * The motion gate's arithmetic.
 *
 * This is what decides whether an inference runs at all, so a regression here is not a wrong score
 * — it is a board that stops being watched, or a phone that runs the model on every frame and gets
 * hot. Neither shows up as a failure anywhere else, which is why these are pinned so tightly.
 *
 * A 8x8 analysis square keeps the fixtures readable; the real one is 240x240.
 */
const DEFAULTS: MotionDefaults = {
  gridRows: 2,
  gridCols: 2,
  tileChangePercent: 10,
  minTiles: 1,
  maxTiles: 8,
  pixelThreshold: 20,
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

describe('diffMask', () => {
  it('sees nothing when nothing changed', () => {
    const still = frame(100);
    expect(countSet(diffMask(still, still, DEFAULTS))).toBe(0);
  });

  it('ignores a change smaller than the pixel threshold', () => {
    // 19 is below the threshold of 20: sensor noise must not wake the model up.
    const before = frame(100);
    const after = frame(100, { x: 1, y: 1, w: 4, h: 4, value: 119 });
    expect(countSet(diffMask(before, after, DEFAULTS))).toBe(0);
  });

  it('sees a change at the threshold, in either direction', () => {
    const before = frame(100);
    expect(countSet(diffMask(before, frame(100, { x: 1, y: 1, w: 4, h: 4, value: 120 }), DEFAULTS))).toBeGreaterThan(0);
    expect(countSet(diffMask(before, frame(100, { x: 1, y: 1, w: 4, h: 4, value: 80 }), DEFAULTS))).toBeGreaterThan(0);
  });

  it('drops a single changed pixel, and keeps a dart-sized patch', () => {
    // The dilate-then-erode pair is there to kill speckle. One pixel is noise; a 4x4 block is a
    // dart. Losing this is how a phone ends up running inference on compression artefacts.
    const before = frame(0);
    const speck = frame(0, { x: 4, y: 4, w: 1, h: 1, value: 255 });
    const patch = frame(0, { x: 2, y: 2, w: 4, h: 4, value: 255 });

    expect(countSet(diffMask(before, speck, DEFAULTS))).toBe(0);
    expect(countSet(diffMask(before, patch, DEFAULTS))).toBeGreaterThan(0);
  });
});

describe('dilate and erode', () => {
  it('dilate grows a region, erode shrinks it back', () => {
    const mask = new Uint8Array(SIZE * SIZE);
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) mask[y * SIZE + x] = 1;

    const grown = dilate(mask, DEFAULTS);
    expect(countSet(grown)).toBeGreaterThan(countSet(mask));
    expect(countSet(erode(grown, DEFAULTS))).toBeLessThanOrEqual(countSet(grown));
  });

  it('erode clears anything touching the edge', () => {
    // Its 3x3 window bails out at the border, so a region on the edge cannot survive. That is the
    // behaviour, and it is why a dart at the very rim of the frame does not trigger.
    const mask = new Uint8Array(SIZE * SIZE).fill(1);
    const eroded = erode(mask, DEFAULTS);
    for (let x = 0; x < SIZE; x++) {
      expect(eroded[x]).toBe(0);
      expect(eroded[(SIZE - 1) * SIZE + x]).toBe(0);
    }
    expect(eroded[3 * SIZE + 3]).toBe(1);
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
