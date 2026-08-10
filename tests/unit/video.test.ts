// The pure pieces of a live feed: how a camera move is timed, how it is drawn, and how a frame
// survives an unreliable channel.
//
// Deliberately not about codecs. Whether a phone can actually encode H.264 and get it across a link
// is tests/e2e/media-codec.spec.ts's question, and whether the two ends fit together is
// tests/e2e/media-video.spec.ts's. These are the parts that can be wrong arithmetically — which is
// the kind of wrong that looks, on a screen, like a mysteriously bad picture.

import { describe, it, expect } from 'vitest';
import { createVirtualCamera, easeInOut, lerpCrop } from '../../src/client/vision/videoCamera';
import { packVideo, unpackVideo } from '../../src/client/media/frames';
import { VIDEO, directorTiming } from '../../src/shared/media';
import type { CropRect } from '../../src/client/vision/stillCapture';

// ============================================================
// What a director command's numbers mean
// ============================================================

describe('directorTiming', () => {
  it('cuts, and comes back, when the command says neither', () => {
    // The asymmetry is the design: saying nothing about *how to move* means do not move, and saying
    // nothing about *how long to stay* does not mean stay forever.
    expect(directorTiming({})).toEqual({ transitionMs: 0, resetMs: VIDEO.defaultResetMs });
  });

  it('takes the numbers it is given', () => {
    expect(directorTiming({ transitionMs: 500, resetMs: 4000 })).toEqual({ transitionMs: 500, resetMs: 4000 });
  });

  it('treats an explicit zero reset as "stay there"', () => {
    // Distinct from leaving it out, which is the whole point of the default.
    expect(directorTiming({ resetMs: 0 }).resetMs).toBe(0);
    expect(directorTiming({}).resetMs).toBe(VIDEO.defaultResetMs);
  });

  it('falls back rather than clamping when a number is not one', () => {
    // These arrive from another machine. Garbage becoming `0` would mean "hold this shot forever" —
    // the one outcome the default exists to prevent.
    for (const bad of [NaN, Infinity, -Infinity, undefined]) {
      expect(directorTiming({ resetMs: bad }).resetMs).toBe(VIDEO.defaultResetMs);
      expect(directorTiming({ transitionMs: bad }).transitionMs).toBe(0);
    }
  });

  it('has no use for a negative duration', () => {
    expect(directorTiming({ transitionMs: -1, resetMs: -1 })).toEqual({ transitionMs: 0, resetMs: 0 });
  });
});

// ============================================================
// The easing
// ============================================================

describe('easeInOut', () => {
  it('starts where it starts and ends where it ends', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
  });

  it('is halfway at halfway', () => {
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 10);
  });

  it('clamps rather than extrapolating', () => {
    // A caller handing over a stale clock should get the end of the move, not a shot beyond it —
    // which for a crop rectangle would mean a square outside the frame.
    expect(easeInOut(-1)).toBe(0);
    expect(easeInOut(2)).toBe(1);
  });

  it('never goes backwards', () => {
    let previous = -1;
    for (let t = 0; t <= 1; t += 0.01) {
      const value = easeInOut(t);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('is slow at the ends and quick through the middle, which is the whole point of it', () => {
    // The first tenth covers less ground than a linear ramp would; the middle tenth covers more.
    expect(easeInOut(0.1)).toBeLessThan(0.1);
    expect(easeInOut(0.55) - easeInOut(0.45)).toBeGreaterThan(0.1);
  });
});

// ============================================================
// Interpolating a shot
// ============================================================

describe('lerpCrop', () => {
  const wide: CropRect = { x: 0, y: 0, size: 100 };
  const tight: CropRect = { x: 40, y: 40, size: 20 };

  it('returns the ends exactly', () => {
    expect(lerpCrop(wide, tight, 0)).toEqual(wide);
    expect(lerpCrop(wide, tight, 1)).toEqual(tight);
  });

  it('holds the centre through a pure zoom', () => {
    // The reason this interpolates centre and size rather than corner and size. Both squares are
    // centred on (50,50); every square in between must be too, or the picture slides sideways while
    // it shrinks.
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const rect = lerpCrop(wide, tight, t);
      expect(rect.x + rect.size / 2).toBeCloseTo(50, 10);
      expect(rect.y + rect.size / 2).toBeCloseTo(50, 10);
    }
  });

  it('moves the centre in a straight line through a pure pan', () => {
    const left: CropRect = { x: 0, y: 0, size: 20 };
    const right: CropRect = { x: 80, y: 0, size: 20 };
    const half = lerpCrop(left, right, 0.5);
    expect(half.x).toBeCloseTo(40, 10);
    expect(half.size).toBe(20);
  });
});

// ============================================================
// The camera itself
// ============================================================

describe('the virtual camera', () => {
  const near: CropRect = { x: 0, y: 0, size: 100 };
  const far: CropRect = { x: 40, y: 40, size: 20 };

  it('cuts straight to its destination when nothing has asked for a move', () => {
    const camera = createVirtualCamera();
    expect(camera.shot(near, performance.now())).toEqual(near);
  });

  it('cuts on the first shot even if a move was asked for', () => {
    // There is nothing to move *from* before the first frame, and animating out of an invented
    // rectangle would be a swoop from nowhere.
    const camera = createVirtualCamera();
    camera.move(500);
    expect(camera.shot(far, performance.now())).toEqual(far);
  });

  it('takes the long way round once it knows where it was', () => {
    const camera = createVirtualCamera();
    const start = performance.now();
    camera.shot(near, start);
    camera.move(500);

    const middle = camera.shot(far, performance.now() + 250);
    expect(middle.size).toBeGreaterThan(far.size);
    expect(middle.size).toBeLessThan(near.size);
    expect(camera.moving(performance.now())).toBe(true);
  });

  it('arrives, and stays arrived', () => {
    const camera = createVirtualCamera();
    camera.shot(near, performance.now());
    camera.move(10);

    // Past the end of the move: the destination exactly, not merely close to it.
    expect(camera.shot(far, performance.now() + 5000)).toEqual(far);
    expect(camera.shot(far, performance.now() + 6000)).toEqual(far);
  });

  it('follows a destination that moves under it', () => {
    // The case that makes the whole design work: a feed can start before the board has been located,
    // pointing at the camera's own square, and the destination changes to the board mid-move. The
    // shot has to keep easing towards wherever the target ended up rather than towards where it was
    // when the move began.
    const camera = createVirtualCamera();
    camera.shot(near, performance.now());
    camera.move(500);

    const towardsOne = camera.shot({ x: 0, y: 0, size: 50 }, performance.now() + 250);
    const towardsAnother = camera.shot({ x: 200, y: 200, size: 50 }, performance.now() + 250);
    expect(towardsAnother.x).toBeGreaterThan(towardsOne.x);
  });

  it('picks up a new move from wherever the last one had got to', () => {
    // What makes a second director command — or a reset arriving mid-swing — read as one continuous
    // camera rather than as a jump back to the start. `from` is the shot as last drawn, not the shot
    // the interrupted move departed from.
    const camera = createVirtualCamera();
    camera.shot(near, performance.now());
    camera.move(500);

    const midway = camera.shot(far, performance.now() + 250);
    expect(midway.size).toBeGreaterThan(far.size);
    expect(midway.size).toBeLessThan(near.size);

    camera.move(500);
    // At the very start of the new move, the shot is where the interrupted one had reached.
    const resumed = camera.shot(near, performance.now());
    expect(resumed.size).toBeCloseTo(midway.size, 0);
    expect(resumed.size).toBeLessThan(near.size);
  });

  it('cuts after a reset, because a re-aimed camera should not slide from where the old one pointed', () => {
    const camera = createVirtualCamera();
    camera.shot(near, performance.now());
    camera.reset();
    camera.move(500);
    expect(camera.shot(far, performance.now())).toEqual(far);
  });

  it('treats a zero-length move as the cut it is', () => {
    const camera = createVirtualCamera();
    camera.shot(near, performance.now());
    camera.move(0);
    expect(camera.shot(far, performance.now())).toEqual(far);
  });
});

// ============================================================
// The frame on the media channel
// ============================================================

describe('the video frame header', () => {
  const payload = new Uint8Array([0, 1, 2, 250, 251, 255]);

  it('round-trips', () => {
    const packed = packVideo({ key: true, seq: 41, timestamp: 2_733_333 }, payload);
    const read = unpackVideo(packed);
    expect(read).not.toBeNull();
    expect(read!.header).toEqual({ key: true, seq: 41, timestamp: 2_733_333 });
    expect([...read!.payload]).toEqual([...payload]);
  });

  it('distinguishes a delta frame from a keyframe', () => {
    expect(unpackVideo(packVideo({ key: false, seq: 1, timestamp: 0 }, payload))!.header.key).toBe(false);
  });

  it('carries a timestamp a u32 of microseconds could not', () => {
    // Seventy-one minutes is where microseconds overflow a u32, and a match can outlast that. Two
    // hours in, exactly.
    const timestamp = 2 * 60 * 60 * 1e6;
    expect(unpackVideo(packVideo({ key: true, seq: 7, timestamp }, payload))!.header.timestamp).toBe(timestamp);
  });

  it('carries a sequence number to the top of its range', () => {
    const seq = 4_294_967_295;
    expect(unpackVideo(packVideo({ key: false, seq, timestamp: 1 }, payload))!.header.seq).toBe(seq);
  });

  it('is exactly thirteen bytes of overhead', () => {
    expect(packVideo({ key: true, seq: 0, timestamp: 0 }, payload).byteLength).toBe(payload.length + 13);
  });

  it('returns null rather than throwing on anything too short to be one', () => {
    // Data from another machine on a channel where corruption is expected. One bad message must not
    // take down the feed behind it.
    for (const length of [0, 1, 12, 13]) {
      expect(unpackVideo(new ArrayBuffer(length))).toBeNull();
    }
  });

  it('copies the payload rather than viewing the message it arrived in', () => {
    const packed = packVideo({ key: true, seq: 1, timestamp: 0 }, payload);
    const read = unpackVideo(packed)!;
    // Scribble over the original: a decoder handed this later must not see the change.
    new Uint8Array(packed).fill(0);
    expect([...read.payload]).toEqual([...payload]);
  });
});
