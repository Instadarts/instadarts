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
import { DEFAULT_VIDEO_PROFILE, MEDIA_ROLES, VIDEO, clampAudience, directorTiming, excluded, maxBufferedBytes } from '../../src/shared/media';
import { FLASH_MS, flashAt, flashShape, overlayFor, toneColour } from '../../src/client/components/feedOverlay';
import type { CropRect } from '../../src/client/vision/stillCapture';
import type { MatchState } from '../../src/shared/types';
import { viewOf } from '../../src/server/match';
import { makeMatch, throwDart } from '../helpers';

// ============================================================
// The match, written over the picture
// ============================================================

/**
 * The overlay a clip of this match would carry, built from the mode's real output.
 *
 * Driven through `viewOf` rather than a hand-written `ModeView` on purpose: every word and every
 * colour the overlay shows is x01's, so a fixture here would be a second copy of x01's opinions —
 * exactly the drift the test is meant to catch.
 */
function overlayOf(match: MatchState) {
  const thrower = match.players[match.currentPlayerIndex];
  return overlayFor(thrower, match.currentVisit?.darts ?? [], viewOf(match));
}

describe('what the overlay says', () => {
  it('flashes the visit as it stands, not the dart that just landed', () => {
    // The number a person watching a clip back wants: 60, then 120, then 170. The dart's own label
    // is already on the strip below, and repeating it across the middle of the board says nothing.
    let match = throwDart(makeMatch(), 'p1', 'T20').match;
    expect(overlayOf(match).flash).toEqual({ text: '60', tone: 'default' });

    match = throwDart(match, 'p1', 'T20').match;
    expect(overlayOf(match).flash).toEqual({ text: '120', tone: 'default' });

    match = throwDart(match, 'p1', 'DB').match;
    expect(overlayOf(match).flash).toEqual({ text: '170', tone: 'default' });
  });

  it('says "miss" rather than a total that did not move', () => {
    const match = throwDart(makeMatch(), 'p1', 'miss').match;
    expect(overlayOf(match).flash).toEqual({ text: 'miss', tone: 'danger' });
  });

  it('borrows the mode\'s own verdicts, and takes their side', () => {
    // Neither string is written down in the overlay: x01 already says "Bust!" on the player's card
    // the instant it happens, and a clip should say what the screen said.
    const bust = throwDart(makeMatch({ settings: { startScore: 40 } }), 'p1', 'T20').match;
    expect(overlayOf(bust).flash).toEqual({ text: 'Bust!', tone: 'danger' });

    const out = throwDart(makeMatch({ settings: { startScore: 32 } }), 'p1', 'D16').match;
    expect(overlayOf(out).flash).toEqual({ text: 'Checkout!', tone: 'positive' });
  });

  it('colours the strip: the dart that finished it, the ones that scored nothing', () => {
    let match = throwDart(makeMatch({ settings: { startScore: 72 } }), 'p1', 'miss').match;
    match = throwDart(match, 'p1', 'S20').match;
    expect(overlayOf(match).darts).toEqual([
      { label: 'miss', tone: 'danger' },
      { label: 'S20', tone: 'default' },
    ]);

    // 52 left, D16 does not finish it — and then D10 does.
    match = throwDart(match, 'p1', 'D16').match;
    expect(overlayOf(match).darts[2]).toEqual({ label: 'D16', tone: 'default' });

    const finished = throwDart(makeMatch({ settings: { startScore: 20 } }), 'p1', 'D10').match;
    expect(overlayOf(finished).darts).toEqual([{ label: 'D10', tone: 'positive' }]);
  });

  it('reads the same three colours the rest of the screen means', () => {
    expect(toneColour('positive')).not.toBe(toneColour('danger'));
    // Everything else is just the score. A board feed has no use for a fourth shade.
    expect(toneColour('default')).toBe(toneColour('muted'));
    expect(toneColour('default')).toBe(toneColour('accent'));
  });
});

// ============================================================
// The dart that just landed, written over the picture
// ============================================================

const T20 = { text: 'T20', tone: 'default' } as const;

describe('the overlay flash', () => {
  it('is over when it is over', () => {
    const started = 1000;
    expect(flashAt(started, started - 1, T20)).toBeNull();
    expect(flashAt(started, started + FLASH_MS, T20)).toBeNull();
    expect(flashAt(started, started + FLASH_MS + 5000, T20)).toBeNull();
    expect(flashAt(started, started + FLASH_MS / 2, T20)).toEqual({ ...T20, progress: 0.5 });
  });

  it('is done inside a second, because a flourish that outlasts the next throw is not one', () => {
    expect(FLASH_MS).toBeLessThanOrEqual(1000);
  });

  it('starts filling most of the picture and grows out of it', () => {
    expect(flashShape(0).scale).toBe(1);
    expect(flashShape(1).scale).toBeGreaterThan(2);
    // Monotonic, or it would read as a wobble rather than a throw.
    let previous = 0;
    for (let t = 0; t <= 1; t += 0.05) {
      expect(flashShape(t).scale).toBeGreaterThan(previous);
      previous = flashShape(t).scale;
    }
  });

  it('begins at three quarters opacity and ends at none', () => {
    expect(flashShape(0).alpha).toBeCloseTo(0.75, 10);
    expect(flashShape(1).alpha).toBeCloseTo(0, 10);
  });

  it('is thinnest exactly where it is largest', () => {
    // The two move against each other on purpose: at the point it covers most of the board it is
    // barely there, so it never hides the thing it is annotating.
    const early = flashShape(0.2);
    const late = flashShape(0.8);
    expect(late.scale).toBeGreaterThan(early.scale);
    expect(late.alpha).toBeLessThan(early.alpha);
  });

  it('spends most of its life at a size you can read, then leaves quickly', () => {
    // The point of the shaping, and the thing that was wrong before it. Easing the growth *out*
    // makes a second of animation contain a tenth of a second of legible label: it is past a
    // readable size almost immediately and merely large and faint for the rest. Easing it in holds
    // it near its starting size and then throws it off the screen.
    const readable = (t: number) => flashShape(t).scale < 1.5;
    expect(readable(0.5), 'unreadable by the midpoint').toBe(true);
    expect(readable(0.6)).toBe(true);
    expect(readable(1)).toBe(false);

    const first = flashShape(0.25).scale - flashShape(0).scale;
    const last = flashShape(1).scale - flashShape(0.75).scale;
    expect(last, 'the exit should be the quick part').toBeGreaterThan(first);
  });

  it('stays legible while it is legibly sized', () => {
    // Opacity has to hold through the readable stretch or the shaping above buys nothing: a label
    // at a readable size and a quarter opacity is not readable.
    expect(flashShape(0.5).alpha).toBeGreaterThan(0.5);
  });
});

// ============================================================
// Who a command's result is for
// ============================================================

describe('clampAudience', () => {
  it('keeps a list that is already one', () => {
    expect(clampAudience(['owner', 'spectator'])).toEqual(['owner', 'spectator']);
    expect(clampAudience([...MEDIA_ROLES])).toEqual([...MEDIA_ROLES]);
  });

  it('drops what it does not recognise and collapses repeats', () => {
    expect(clampAudience(['owner', 'owner', 'nonsense', 42, null])).toEqual(['owner']);
  });

  it('answers in a fixed order however the list was written', () => {
    // So that two commands addressing the same people compare equal, and a panel reads the same way
    // twice.
    expect(clampAudience(['spectator', 'owner'])).toEqual(clampAudience(['owner', 'spectator']));
  });

  it('fails closed to the owner alone, never to everybody', () => {
    // The whole point. A sender that gets this wrong should cost a picture, never a broadcast — the
    // failure must not be able to widen an audience.
    for (const bad of [undefined, null, [], ['nonsense'], 'owner', 7, {}]) {
      expect(clampAudience(bad)).toEqual(['owner']);
    }
  });
});

describe('excluded', () => {
  it('is the rest of the room', () => {
    expect(excluded(['owner'])).toEqual(['opponent', 'spectator']);
    expect(excluded([...MEDIA_ROLES])).toEqual([]);
    expect(excluded([])).toEqual([...MEDIA_ROLES]);
  });
});

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
// How far behind a link may fall
// ============================================================

describe('maxBufferedBytes', () => {
  it('is a quarter-second of whatever this deployment encodes at', () => {
    expect(maxBufferedBytes(DEFAULT_VIDEO_PROFILE)).toBe(DEFAULT_VIDEO_PROFILE.bitrate / 8 / 4);
  });

  it('stays well clear of a single frame at any quality, which a flat number did not', () => {
    // The reason this is a function. Written down as 16KB it was a quarter-second at 500kbps and
    // *less than one frame* at 5Mbps — so a deployment that raised its quality would have found the
    // rule that exists to stop a picture falling behind throwing away frames the link could carry.
    for (const bitrate of [200_000, 500_000, 2_000_000, 5_000_000]) {
      const profile = { ...DEFAULT_VIDEO_PROFILE, bitrate };
      const frame = bitrate / 8 / profile.frameRate;
      expect(maxBufferedBytes(profile), `${bitrate}bps`).toBeGreaterThan(frame * 3);
    }
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
