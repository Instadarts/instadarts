// The three pure pieces a still is made of: what a region means, the geometry that finds it in a
// frame, and the frame it travels in.
//
// Deliberately not about cameras. Whether a phone can actually photograph a dartboard is
// tests/e2e/media-stills.spec.ts's question; these are the parts that can be wrong arithmetically,
// which is the kind of wrong that is hard to see in a picture.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REGION,
  MIN_REGION_SIZE,
  clampRegion,
  type ControlMessage,
} from '../../src/shared/media';
import { computeSpiderHomography, invertMatrix3x3, transformPoint, REFERENCE_POINTS } from '../../src/shared/vision/homography';
import { packFrame, unpackFrame } from '../../src/client/media/frames';
import type { Keypoint, Matrix3x3 } from '../../src/shared/vision/types';

// ============================================================
// Regions
// ============================================================

describe('clampRegion', () => {
  it('leaves a region that already fits alone', () => {
    expect(clampRegion({ cx: 0.5, cy: 0.5, size: 0.25 })).toEqual({ cx: 0.5, cy: 0.5, size: 0.25 });
  });

  it('moves a centre that would fall off the edge towards the middle', () => {
    // The whole board can only be centred on the middle, so a centre anywhere else is pulled to it.
    expect(clampRegion({ cx: 0.5, cy: 1, size: 1 })).toEqual({ cx: 0.5, cy: 0.5, size: 1 });

    // A dart in the 20 bed is near the top: the useful answer is the closest square that still holds
    // it, at the size that was asked for, rather than a refusal or a smaller crop.
    expect(clampRegion({ cx: 0.5, cy: 0.98, size: 0.25 })).toEqual({ cx: 0.5, cy: 0.875, size: 0.25 });
    expect(clampRegion({ cx: 0, cy: 0, size: 0.4 })).toEqual({ cx: 0.2, cy: 0.2, size: 0.4 });
  });

  it('holds the size to something a camera can actually deliver', () => {
    expect(clampRegion({ cx: 0.5, cy: 0.5, size: 4 }).size).toBe(1);
    expect(clampRegion({ cx: 0.5, cy: 0.5, size: 0 }).size).toBe(MIN_REGION_SIZE);
    expect(clampRegion({ cx: 0.5, cy: 0.5, size: -1 }).size).toBe(MIN_REGION_SIZE);
  });

  it('falls back to the whole board for anything it cannot read', () => {
    expect(clampRegion(undefined)).toEqual(DEFAULT_REGION);
    expect(clampRegion({ cx: NaN, cy: 0.5, size: 0.25 })).toEqual(DEFAULT_REGION);
    expect(clampRegion({ cx: 0.5, cy: Infinity, size: 0.25 })).toEqual(DEFAULT_REGION);
    // A region is a number from another machine, so the shapes it can arrive in are not all ours.
    expect(clampRegion({ cx: '0.5', cy: 0.5, size: 0.25 } as never)).toEqual(DEFAULT_REGION);
  });

  it('is idempotent — clamping a clamped region changes nothing', () => {
    const once = clampRegion({ cx: 0.02, cy: 1.4, size: 0.3 });
    expect(clampRegion(once)).toEqual(once);
  });
});

// ============================================================
// Running the geometry backwards
// ============================================================

/** A homography from a real board's worth of keypoints, seen at an angle. */
function sampleHomography(): Matrix3x3 {
  // The eight reference points, projected through a made-up camera: a perspective view of a board
  // that fills most of a square frame. Solving from these gives the same kind of matrix a phone
  // produces, rather than a tidy one that would hide a mistake.
  const keypoints: Keypoint[] = REFERENCE_POINTS.map((point, classId) => {
    const bx = point[0] / 1_000_000;
    const by = point[1] / 1_000_000;
    const w = 1 + 0.18 * (by - 0.5);
    return [0.5 + (bx - 0.5) * 0.8 / w, 0.5 - (by - 0.5) * 0.8 / w, 0.9, classId];
  });
  const homography = computeSpiderHomography(keypoints);
  if (!homography) throw new Error('the sample keypoints did not solve');
  return homography;
}

describe('invertMatrix3x3', () => {
  it('sends a board point back to the image point it came from', () => {
    const homography = sampleHomography();
    const inverse = invertMatrix3x3(homography)!;
    expect(inverse).not.toBeNull();

    // The forward trip is what the pipeline does on every inference; this is the same journey in
    // reverse, which is the only thing a still request needs and the only place it is used.
    for (const image of [[0.5, 0.5], [0.3, 0.42], [0.71, 0.66]] as const) {
      const board = transformPoint([image[0], image[1]], homography)!;
      const back = transformPoint(board, inverse)!;
      expect(back[0]).toBeCloseTo(image[0], 6);
      expect(back[1]).toBeCloseTo(image[1], 6);
    }
  });

  it('refuses a matrix that has no inverse rather than returning nonsense', () => {
    expect(invertMatrix3x3([[1, 2, 3], [2, 4, 6], [1, 1, 1]])).toBeNull();
    expect(invertMatrix3x3([[0, 0, 0], [0, 0, 0], [0, 0, 0]])).toBeNull();
  });
});

// ============================================================
// The frame a still travels in
// ============================================================

describe('still frames', () => {
  const header: ControlMessage = {
    kind: 'still', id: 'abc', tag: { dart: 2 }, width: 480, height: 480, mime: 'image/jpeg',
  };

  it('carries its header and its bytes in one message', () => {
    // The point of the format: nothing has to be paired with "whatever arrives next", which is what
    // breaks the moment three darts land at once and three stills come back together.
    const payload = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10, 0xff, 0xd9]);
    const frame = unpackFrame(packFrame(header, payload))!;

    expect(frame.header).toEqual(header);
    expect([...frame.payload]).toEqual([...payload]);
  });

  it('survives bytes that would not survive being treated as text', () => {
    // A JPEG is not a string. Lone surrogates and nulls are ordinary inside one, and a format that
    // stringified the payload would quietly corrupt them.
    const payload = new Uint8Array([0, 0xed, 0xa0, 0x80, 0xff, 0xfe, 0x80, 0]);
    const frame = unpackFrame(packFrame(header, payload))!;
    expect([...frame.payload]).toEqual([...payload]);
  });

  it('handles an empty payload and a large one', () => {
    expect(unpackFrame(packFrame(header, new Uint8Array()))!.payload.length).toBe(0);

    const big = new Uint8Array(64_000).map((_, i) => i % 256);
    expect(unpackFrame(packFrame(header, big))!.payload.length).toBe(64_000);
  });

  it('returns null for anything that is not one of ours', () => {
    // Data from another machine: one bad message must not take the channel down with it.
    expect(unpackFrame(new ArrayBuffer(0))).toBeNull();
    expect(unpackFrame(new ArrayBuffer(2))).toBeNull();

    // A header length that runs past the end of the buffer.
    const lying = new ArrayBuffer(16);
    new DataView(lying).setUint32(0, 9999);
    expect(unpackFrame(lying)).toBeNull();

    // Well-formed length, contents that are not JSON.
    const notJson = new Uint8Array([0, 0, 0, 3, 0x7b, 0x7b, 0x7b]);
    expect(unpackFrame(notJson.buffer)).toBeNull();

    // Valid JSON that is not a control message.
    const noKind = packFrame({ nope: true } as never, new Uint8Array([1]));
    expect(unpackFrame(noKind)).toBeNull();
  });

  it('hands back a copy, not a view of the message it arrived in', () => {
    // A datachannel's buffer is not ours to hold, and a still outlives the message that carried it.
    const payload = new Uint8Array([1, 2, 3]);
    const buffer = packFrame(header, payload);
    const frame = unpackFrame(buffer)!;
    new Uint8Array(buffer).fill(0);
    expect([...frame.payload]).toEqual([1, 2, 3]);
  });
});
