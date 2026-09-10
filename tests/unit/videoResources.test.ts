import { describe, expect, it, vi } from 'vitest';
import { createVideoDestinationCache, regionToCrop, type CropInput } from '../../src/client/vision/stillCapture';
import { outlineInShot } from '../../src/client/vision/videoCamera';
import { createVideoPacker, packVideo, unpackVideo } from '../../src/client/media/frames';
import type { BoardGeometry } from '../../src/shared/vision/feedGeometry';

const input: CropInput = {
  region: { cx: 0.5, cy: 0.5, size: 0.25 },
  homography: [[1e6, 0, 0], [0, 1e6, 0], [0, 0, 1]],
  lensCalibration: 0,
  crop: { cropX: 160, cropY: 0, cropSize: 720 },
  frame: { width: 1040, height: 720 },
};

describe('destination cache', () => {
  it('reuses equivalent inputs, including fallback results, and resets on stop', () => {
    const cache = createVideoDestinationCache();
    const first = cache.resolve(input);
    expect(first).toEqual(regionToCrop(input));
    expect(cache.resolve({ ...input, region: { ...input.region }, crop: { ...input.crop } })).toBe(first);
    const fallback = cache.resolve({ ...input, homography: null });
    expect(fallback).toEqual({ x: 160, y: 0, size: 720 });
    expect(cache.resolve({ ...input, homography: null })).toBe(fallback);
    cache.reset();
    expect(cache.resolve({ ...input, homography: null })).not.toBe(fallback);
    expect(cache.resolve(input)).toEqual(first);
  });

  it.each([
    { region: { ...input.region, cx: 0.6 } },
    { region: { ...input.region, cy: 0.6 } },
    { region: { ...input.region, size: 0.3 } },
    { lensCalibration: 20 },
    { homography: input.homography.map((row) => [...row]) as CropInput['homography'] },
    { crop: { ...input.crop, cropX: 150 } },
    { crop: { ...input.crop, cropY: 10 } },
    { crop: { ...input.crop, cropSize: 640 } },
    { frame: { ...input.frame, width: 1280 } },
    { frame: { ...input.frame, height: 800 } },
  ])('invalidates changed geometry: %j', (change) => {
    const cache = createVideoDestinationCache();
    const first = cache.resolve(input);
    const changed = { ...input, ...change };
    const next = cache.resolve(changed);
    expect(next).not.toBe(first);
    expect(next).toEqual(regionToCrop(changed));
  });

  it('snapshots region values so mutating a reused object invalidates its result', () => {
    const cache = createVideoDestinationCache();
    const region = { ...input.region };
    const first = cache.resolve({ ...input, region });
    region.cx = 0.7;
    expect(cache.resolve({ ...input, region })).not.toBe(first);
  });
});

it('reuses mask scratch storage without changing transformed points', () => {
  const outline = new Float64Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const scratch = new Float64Array(outline.length);
  const rect = { x: 230, y: 50, size: 300 };
  const expected = outlineInShot(outline, input.crop, rect, 320);
  expect(outlineInShot(outline, input.crop, rect, 320, scratch)).toBe(scratch);
  expect(scratch).toEqual(expected);
  expect(outlineInShot(outline, input.crop, { ...rect, size: 150 }, 320, scratch)).toBe(scratch);
  expect(scratch).toEqual(outlineInShot(outline, input.crop, { ...rect, size: 150 }, 320));
  const resized = outlineInShot(outline, input.crop, rect, 320, new Float64Array(2));
  expect(resized).toEqual(expected);
});

describe('feed-scoped packet construction', () => {
  const feedId = '12345678-1234-4123-8123-123456789abc';
  const geometry: BoardGeometry = { homography: input.homography, lensK1: 0.01, shot: { x: 0.1, y: 0.2, size: 0.5 } };
  it.each([undefined, null, geometry])('keeps the wire format for geometry %j', (restingGeometry) => {
    const pack = createVideoPacker(feedId);
    const payload = new Uint8Array([4, 5, 6, 250]);
    for (const key of [false, true]) {
      const header = { seq: 72, timestamp: 5e9, key, restingGeometry };
      const copyTo = vi.fn((destination: Uint8Array) => destination.set(payload));
      const actual = pack(header, { byteLength: payload.byteLength, copyTo });
      expect(actual).toEqual(packVideo({ feedId, ...header }, payload));
      expect(copyTo).toHaveBeenCalledTimes(1);
      expect(copyTo.mock.calls[0][0].buffer).toBe(actual);
      expect(unpackVideo(actual)!.payload).toEqual(payload);
      const previous = actual.slice(0);
      const next = pack({ ...header, seq: 73 }, new Uint8Array([99]));
      expect(next).not.toBe(actual);
      expect(actual).toEqual(previous);
    }
  });
  it('validates the UUID when the packer is created', () => {
    expect(() => createVideoPacker('bad')).toThrow(TypeError);
  });
});
