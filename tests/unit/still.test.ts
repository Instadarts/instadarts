// The pure pieces a still is made of: what a region means, the geometry that finds it in a frame,
// and the frame it travels in — plus the board outline the live feed is masked to, which is the same
// geometry run backwards for a circle instead of a square.
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
import { sliderValueToLensK1, undistortNormalizedPoint } from '../../src/shared/vision/lensDistortion';
import { BOARD_CENTER, BOARD_MAX, NORMALIZED_RADII } from '../../src/shared/boardGeometry';
import { boardOutline, createBoardMask } from '../../src/client/vision/boardMask';
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
// The board's edge, for the mask
// ============================================================

/** The radius the mask traces, in board units — `MASK_RADIUS` in boardMask.ts. */
const MASK_RADIUS = NORMALIZED_RADII.boardOuter * BOARD_MAX;

/** How far a point on the outline is from the bull, once it is back in board space. */
function radiusOf(outline: Float64Array, index: number, homography: Matrix3x3, lens: number): number {
  const k1 = sliderValueToLensK1(lens);
  const distorted: [number, number] = [outline[index * 2], outline[index * 2 + 1]];
  const undistorted = Math.abs(k1) >= 1e-12 ? undistortNormalizedPoint(distorted, k1) : distorted;
  const board = transformPoint(undistorted, homography)!;
  return Math.hypot(board[0] - BOARD_CENTER, board[1] - BOARD_CENTER);
}

describe('boardOutline', () => {
  it('draws the board rim, and every point of it is on the rim', () => {
    const homography = sampleHomography();
    const outline = boardOutline({ homography, lensCalibration: 0 })!;
    expect(outline).not.toBeNull();
    expect(outline.length).toBe(256);
    expect([...outline].every(Number.isFinite)).toBe(true);

    // The whole correctness claim of the mask: run each point forward through the same homography
    // the pipeline uses, and it must land back on the circle it was drawn from. A swapped axis, a
    // sign error or a missing perspective divide all fail here and nowhere else.
    for (let i = 0; i < outline.length / 2; i++) {
      expect(radiusOf(outline, i, homography, 0) / MASK_RADIUS).toBeCloseTo(1, 6);
    }
  });

  it('puts the rim back where a calibrated lens actually shows it', () => {
    const homography = sampleHomography();
    const outline = boardOutline({ homography, lensCalibration: 40 })!;
    expect(outline).not.toBeNull();

    // Undistorting is a fixed-point inversion rather than a closed form, so this round trip is only
    // as tight as those eight passes — which is far tighter than a pixel, and a pixel of a 320px
    // frame is some three thousand board units.
    for (let i = 0; i < outline.length / 2; i++) {
      expect(radiusOf(outline, i, homography, 40) / MASK_RADIUS).toBeCloseTo(1, 4);
    }

    // And it is a different circle from the uncorrected one, or the lens value did nothing.
    const straight = boardOutline({ homography, lensCalibration: 0 })!;
    expect([...outline]).not.toEqual([...straight]);
  });

  it('refuses a homography it cannot run backwards', () => {
    expect(boardOutline({ homography: [[1, 2, 3], [2, 4, 6], [1, 1, 1]], lensCalibration: 0 })).toBeNull();
  });

  it('refuses a board the camera cannot see all of', () => {
    // The horizon passes directly through sampled rim points.
    const horizon = invertMatrix3x3([[1, 0, 0], [0, 1, 0], [1, 0, -BOARD_CENTER]])!;
    expect(boardOutline({ homography: horizon, lensCalibration: 0 })).toBeNull();
  });

  it('refuses horizon crossings and tangencies between sampled rim points', () => {
    const angle = Math.PI / 128;
    const g = Math.cos(angle);
    const h = Math.sin(angle);
    for (const distance of [MASK_RADIUS * 0.9, MASK_RADIUS]) {
      const inverse: Matrix3x3 = [[1, 0, 0], [0, 1, 0],
        [g, h, -(g + h) * BOARD_CENTER - distance]];
      const homography = invertMatrix3x3(inverse)!;
      // Every sampled point projects to a finite value; the circle still crosses or touches w=0.
      for (let n = 0; n < 128; n++) {
        const theta = n * Math.PI / 64;
        expect(transformPoint([BOARD_CENTER + MASK_RADIUS * Math.cos(theta),
          BOARD_CENTER + MASK_RADIUS * Math.sin(theta)], inverse)).not.toBeNull();
      }
      expect(boardOutline({ homography, lensCalibration: 0 })).toBeNull();
    }
  });

  it('accepts either consistent denominator sign', () => {
    const homography = sampleHomography();
    const negated = homography.map(row => row.map(value => -value)) as Matrix3x3;
    expect(boardOutline({ homography: negated, lensCalibration: 0 }))
      .toEqual(boardOutline({ homography, lensCalibration: 0 }));
  });

  it('refuses a board too small to believe rather than blacking out the picture', () => {
    // A camera whose homography says the board is half a percent of the frame across. Nothing about
    // this matrix fails to invert or project — it is simply wrong, which is the failure that would
    // otherwise reach a viewer as a black square with no error attached.
    const tiny: Matrix3x3 = [[1e8, 0, 0], [0, 1e8, 0], [0, 0, 1]];
    expect(boardOutline({ homography: tiny, lensCalibration: 0 })).toBeNull();
  });
});

describe('createBoardMask', () => {
  it('computes once per solved homography and hands the same array back', () => {
    const mask = createBoardMask();
    const homography = sampleHomography();

    const first = mask.outline(homography, 0);
    expect(first).not.toBeNull();
    // Identity, not equality: this is what makes it free to call fifteen times a second.
    expect(mask.outline(homography, 0)).toBe(first);

    // A re-solved board is a new array, even when it says the same thing — which is exactly the
    // signal the cache is keyed on.
    const resolved = sampleHomography();
    const second = mask.outline(resolved, 0);
    expect(second).not.toBe(first);
    expect([...second!]).toEqual([...first!]);

    // A lens change moves the outline without the board moving at all.
    const lensed = mask.outline(resolved, 40);
    expect(lensed).not.toBe(second);
    expect([...lensed!]).not.toEqual([...second!]);
  });

  it('remembers a refusal too, rather than re-deriving it every frame', () => {
    const mask = createBoardMask();
    const singular: Matrix3x3 = [[1, 2, 3], [2, 4, 6], [1, 1, 1]];
    expect(mask.outline(singular, 0)).toBeNull();
    expect(mask.outline(singular, 0)).toBeNull();
  });

  it('has nothing to say before a board is found, or after the camera stops', () => {
    const mask = createBoardMask();
    expect(mask.outline(null, 0)).toBeNull();

    const homography = sampleHomography();
    const outline = mask.outline(homography, 0);
    mask.reset();
    expect(mask.outline(homography, 0)).not.toBe(outline);
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
