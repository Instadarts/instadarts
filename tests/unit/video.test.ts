// The pure pieces of a live feed: how a camera move is timed, how it is drawn, and how a frame
// survives an unreliable channel.
//
// Deliberately not about codecs. Whether a phone can actually encode H.264 and get it across a link
// is tests/e2e/media-codec.spec.ts's question, and whether the two ends fit together is
// tests/e2e/media-video.spec.ts's. These are the parts that can be wrong arithmetically — which is
// the kind of wrong that looks, on a screen, like a mysteriously bad picture.

import { describe, it, expect, vi } from 'vitest';
import { createVirtualCamera, easeInOut, lerpCrop, outlineInShot } from '../../src/client/vision/videoCamera';
import { BOARD_CUTOUT, toMatrix3d } from '../../src/client/components/boardWarp';
import { transformPoint } from '../../src/shared/vision/homography';
import type { Matrix3x3 } from '../../src/shared/vision/types';
import { NORMALIZED_RADII } from '../../src/shared/boardGeometry';
import { packVideo, unpackVideo } from '../../src/client/media/frames';
import { MEDIA_ROLES, clampAudience, createVideoFeedId, directorTiming, isVideoFeedId, maxBufferedBytes, videoProfile } from '../../src/shared/media';
import { CONFIG_DEFAULTS } from '../../src/shared/config';
import {
  VIDEO_STALL_MS,
  frameIsFresh,
  labelVideoFeedsForMatch,
  selectVideoFeed,
  type VideoFeedStatus,
  type VideoFeedView,
} from '../../src/client/hooks/useVideoFeed';
import { canChooseVideoFeed, pruneIneligibleAcceptances, shouldRunVideoPublisher } from '../../src/client/hooks/useVideoResponder';
import { createIceRestartController, iceRestartDelay, shouldRestartIce } from '../../src/client/media/peerLink';
import { createFrameGeometryQueue, createVideoFeedClock } from '../../src/client/media/videoPublisher';
import type { BoardGeometry } from '../../src/shared/vision/feedGeometry';

/**
 * A description of one published frame, with no round number in it.
 *
 * Deliberately awkward values: every one of them loses something to float32, so a test that passes
 * has been through the conversion rather than around it.
 */
const GEOMETRY: BoardGeometry = {
  homography: [
    [1.2345678, -0.3456789, 0.1234567],
    [0.2345678, 1.4567891, -0.2345678],
    [0.0012345, -0.0023456, 1],
  ],
  lensK1: 0.072,
  shot: { x: 0.1234567, y: 0.2345678, size: 0.6543211 },
};
import { setupSnapshotSettled } from '../../src/client/hooks/useMatchMediaSetup';
import type { CropRect } from '../../src/client/vision/stillCapture';

/** The profile a deployment that changed nothing publishes with. */
const DEFAULT_PROFILE = videoProfile(CONFIG_DEFAULTS.media.video);
const FEED_ID = '12345678-1234-4123-8123-123456789abc';

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

describe('video feed ids', () => {
  it('generates RFC 4122 v4 ids', () => {
    expect(isVideoFeedId(createVideoFeedId())).toBe(true);
  });

  it('rejects malformed and non-v4 ids', () => {
    for (const value of [null, '', '123', '12345678-1234-1123-8123-123456789abc']) {
      expect(isVideoFeedId(value)).toBe(false);
    }
  });

  it('authorizes only an eligible peer naming the active feed', () => {
    expect(canChooseVideoFeed(FEED_ID, FEED_ID, ['peer-a', 'peer-b'], 'peer-b')).toBe(true);
    expect(canChooseVideoFeed(FEED_ID, FEED_ID, ['peer-a'], 'peer-b')).toBe(false);
    expect(canChooseVideoFeed(FEED_ID, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ['peer-b'], 'peer-b')).toBe(false);
    expect(canChooseVideoFeed(FEED_ID, 'not-a-uuid', ['peer-b'], 'peer-b')).toBe(false);
    expect(canChooseVideoFeed(null, FEED_ID, ['peer-b'], 'peer-b')).toBe(false);
  });
});

describe('media recovery policy', () => {
  it('restarts ICE only on the deterministic original-offerer side, with capped backoff', () => {
    expect(shouldRestartIce(false, 'failed')).toBe(true);
    expect(shouldRestartIce(true, 'failed')).toBe(false);
    expect(shouldRestartIce(false, 'disconnected')).toBe(false);
    expect([0, 1, 2, 3, 4, 20].map(iceRestartDelay)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it('retains consent while an exact peer is eligible but temporarily unwritable', () => {
    const accepted = new Set(['eligible-offline', 'removed']);
    pruneIneligibleAcceptances(accepted, ['eligible-offline']);
    expect([...accepted]).toEqual(['eligible-offline']);
  });

  it('pauses the encoder without ending the feed or consent, then permits the same feed to resume', () => {
    const accepted = new Set(['peer-a']);
    expect(shouldRunVideoPublisher(FEED_ID, true, 'video', true, true, accepted, ['peer-a'])).toBe(true);
    expect(shouldRunVideoPublisher(FEED_ID, true, 'video', true, true, accepted, [])).toBe(false);
    expect([...accepted]).toEqual(['peer-a']);
    expect(shouldRunVideoPublisher(FEED_ID, true, 'video', true, true, accepted, ['peer-a'])).toBe(true);
  });

  it('keeps packet sequence and timestamps continuous across encoder incarnations of one feed', () => {
    const clock = createVideoFeedClock(1_000);
    expect([clock.nextSequence(), clock.nextSequence()]).toEqual([0, 1]);
    expect(clock.timestampUs(1_250)).toBe(250_000);

    // A temporarily stopped encoder shares this clock when it is recreated.
    expect(clock.nextSequence()).toBe(2);
    expect(clock.timestampUs(2_000)).toBe(1_000_000);

    // Only a genuinely new feed/source epoch starts over.
    clock.reset(3_000);
    expect(clock.nextSequence()).toBe(0);
    expect(clock.timestampUs(3_025)).toBe(25_000);
  });

  it('requires every publisher gate in addition to a writable accepted peer', () => {
    expect(shouldRunVideoPublisher(FEED_ID, true, 'video', true, true, ['peer-a'], ['peer-a'])).toBe(true);
    expect(shouldRunVideoPublisher(null, true, 'video', true, true, ['peer-a'], ['peer-a'])).toBe(false);
    expect(shouldRunVideoPublisher(FEED_ID, false, 'video', true, true, ['peer-a'], ['peer-a'])).toBe(false);
    expect(shouldRunVideoPublisher(FEED_ID, true, 'stills', true, true, ['peer-a'], ['peer-a'])).toBe(false);
    expect(shouldRunVideoPublisher(FEED_ID, true, 'video', false, true, ['peer-a'], ['peer-a'])).toBe(false);
    expect(shouldRunVideoPublisher(FEED_ID, true, 'video', true, false, ['peer-a'], ['peer-a'])).toBe(false);
  });

  it('runs one ICE restart at a time after 1, 2, 4, then capped 8 second delays', () => {
    vi.useFakeTimers();
    try {
      const restartIce = vi.fn();
      const controller = createIceRestartController(false, restartIce);
      controller.stateChanged('failed');
      expect(controller.retryPending).toBe(true);
      expect(controller.negotiationInFlight).toBe(false);

      for (const [delay, calls] of [[1000, 1], [2000, 2], [4000, 3], [8000, 4], [8000, 5]] as const) {
        vi.advanceTimersByTime(delay - 1);
        expect(restartIce).toHaveBeenCalledTimes(calls - 1);
        vi.advanceTimersByTime(1);
        expect(restartIce).toHaveBeenCalledTimes(calls);
        expect(controller.retryPending).toBe(false);
        expect(controller.negotiationInFlight).toBe(true);
        vi.advanceTimersByTime(60_000);
        expect(restartIce).toHaveBeenCalledTimes(calls); // still one negotiation in flight
        controller.negotiationFinished();
        expect(controller.retryPending).toBe(true);
        expect(controller.negotiationInFlight).toBe(false);
      }
      controller.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels ICE retries on recovery, disconnect, negotiation, and close', () => {
    vi.useFakeTimers();
    try {
      const restartIce = vi.fn();
      const controller = createIceRestartController(false, restartIce);

      controller.stateChanged('failed');
      controller.stateChanged('disconnected');
      expect(controller.retryPending).toBe(false);
      vi.advanceTimersByTime(10_000);
      expect(restartIce).not.toHaveBeenCalled();

      controller.stateChanged('failed');
      controller.stateChanged('connecting');
      expect(controller.retryPending).toBe(false);
      vi.advanceTimersByTime(10_000);
      expect(restartIce).not.toHaveBeenCalled();

      controller.stateChanged('failed');
      controller.stateChanged('connected');
      expect(controller.retryPending).toBe(false);
      vi.advanceTimersByTime(10_000);
      expect(restartIce).not.toHaveBeenCalled();

      // Connected reset the sequence: the next failure waits one second again.
      controller.stateChanged('failed');
      vi.advanceTimersByTime(1000);
      expect(restartIce).toHaveBeenCalledTimes(1);
      expect(controller.negotiationInFlight).toBe(true);
      controller.close();
      expect(controller.retryPending).toBe(false);
      expect(controller.negotiationInFlight).toBe(false);
      controller.negotiationFinished();
      vi.advanceTimersByTime(60_000);
      expect(restartIce).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never schedules ICE restarts on the polite side', () => {
    vi.useFakeTimers();
    try {
      const restartIce = vi.fn();
      const controller = createIceRestartController(true, restartIce);
      controller.stateChanged('failed');
      vi.advanceTimersByTime(60_000);
      expect(restartIce).not.toHaveBeenCalled();
      controller.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a setup snapshot on ready, failed, closed, or roster-removed links', () => {
    const peer = (peerId: string, state: any, ready = false) => ({
      peer: { peerId }, state, ready,
    }) as any;
    expect(setupSnapshotSettled(['ready', 'failed', 'closed', 'removed'], [
      peer('ready', 'connected', true), peer('failed', 'failed'), peer('closed', 'closed'),
    ])).toBe(true);
    expect(setupSnapshotSettled(['waiting'], [peer('waiting', 'connecting')])).toBe(false);
    expect(setupSnapshotSettled(['disconnected'], [peer('disconnected', 'disconnected')])).toBe(false);
  });
});

// ============================================================
// Which decoded board is allowed to cover the virtual one
// ============================================================

const fakeCanvas = {} as HTMLCanvasElement;

function feed(playerId: string, status: VideoFeedStatus = 'live'): VideoFeedView {
  return {
    feedId: FEED_ID,
    peerId: `camera-${playerId}`,
    playerId,
    choice: 'accepted',
    canvas: fakeCanvas,
    geometry: () => null,
    status,
    lastFrameAt: status === 'live' ? 1000 : null,
    stats: null,
    linkState: 'connected',
    linkReady: true,
    decoderSupported: true,
    order: 0,
  };
}

describe('live board selection', () => {
  it('uses exactly three seconds as the frozen-picture boundary', () => {
    expect(frameIsFresh(null, 10_000)).toBe(false);
    expect(frameIsFresh(1000, 1000 + VIDEO_STALL_MS - 1)).toBe(true);
    expect(frameIsFresh(1000, 1000 + VIDEO_STALL_MS)).toBe(false);
  });

  it('shows an opponent but never the local player to a participant', () => {
    const feeds = [feed('p1'), feed('p2')];
    expect(selectVideoFeed(feeds, 'p1', 'p1', false)).toBeNull();
    expect(selectVideoFeed(feeds, 'p2', 'p1', false)?.peerId).toBe('camera-p2');
  });

  it('follows the current player for a spectator', () => {
    const feeds = [feed('p1'), feed('p2')];
    expect(selectVideoFeed(feeds, 'p1', null, true)?.peerId).toBe('camera-p1');
    expect(selectVideoFeed(feeds, 'p2', null, true)?.peerId).toBe('camera-p2');
  });

  it('falls through to the virtual board for every unusable state', () => {
    for (const status of ['offered', 'waiting', 'stalled', 'unavailable'] as const) {
      expect(selectVideoFeed([feed('p2', status)], 'p2', 'p1', false)).toBeNull();
    }
    expect(selectVideoFeed([{ ...feed('p2'), choice: 'declined' }], 'p2', 'p1', false)).toBeNull();
    expect(selectVideoFeed([], 'p2', 'p1', false)).toBeNull();
  });

  it('follows the thrower to their board, including a user\'s second player', () => {
    // Alice and Carol share the host's board, so Carol's turn shows the feed published for it.
    // Selecting on player id instead would leave the other side looking at a virtual board.
    const feeds = [feed('p1'), feed('p3')];
    expect(selectVideoFeed(feeds, 'p1', 'p3', false)?.peerId).toBe('camera-p1');
    expect(selectVideoFeed(feeds, 'p1', 'p1', false)).toBeNull();
    expect(selectVideoFeed(feeds, 'p3', 'p1', false)?.peerId).toBe('camera-p3');
  });

  it('shows one shared board on every turn to a watcher, and never to the people at it', () => {
    // The shape a single user produces: every player resolves to the same board, so a watcher sees
    // it whoever is up, and the people standing at it never do. Nothing here needs to know how the
    // match was created — `boardCount` and `Player.boardId` carry that, and are tested separately.
    const feeds = [feed('p1')];
    expect(selectVideoFeed(feeds, 'p1', null, true)?.peerId).toBe('camera-p1');
    expect(selectVideoFeed(feeds, 'p1', 'p1', false)).toBeNull();
  });

  it('names a board after everybody who throws at it', () => {
    const online = {
      players: [
        { id: 'p1', name: 'Alice', boardId: 'p1' },
        { id: 'p2', name: 'Carol', boardId: 'p1' },
        { id: 'p3', name: 'Bob', boardId: 'p3' },
      ],
    };
    // A noun phrase, because the label goes in front of "is offering a live video feed".
    expect(labelVideoFeedsForMatch([feed('p1')], online)[0].label).toBe("Alice & Carol's board");
    expect(labelVideoFeedsForMatch([feed('p3')], online)[0].label).toBe('Bob');

    // One user holding the whole roster is one board, named after all of them by the same rule.
    const oneBoard = {
      players: online.players.map((p) => ({ ...p, boardId: 'p1' })),
    };
    expect(labelVideoFeedsForMatch([feed('p1')], oneBoard)[0].label).toBe("Alice, Carol & Bob's board");

    // Past a few names, listing them says less than not listing them.
    const crowd = { players: [...oneBoard.players, { id: 'p4', name: 'Dave', boardId: 'p1' }] };
    expect(labelVideoFeedsForMatch([feed('p1')], crowd)[0].label).toBe('the shared board');
  });
});

// ============================================================
// What a director command's numbers mean
// ============================================================

describe('directorTiming', () => {
  /**
   * Distinctive numbers, and deliberately not the shipped defaults.
   *
   * Both fallbacks are deployment settings now, passed in rather than reached for — so a test using
   * the shipped values could not tell "the argument was honoured" from "the argument was ignored and
   * something else supplied the same number". `transitionMs` especially: its default is 0, which is
   * also what a missing argument would produce.
   */
  const FALLBACK = { transitionMs: 60, resetMs: 7777 };

  it('takes both fallbacks when the command says neither', () => {
    expect(directorTiming({}, FALLBACK)).toEqual(FALLBACK);
  });

  it('takes the numbers it is given, over the deployment default', () => {
    expect(directorTiming({ transitionMs: 500, resetMs: 4000 }, FALLBACK)).toEqual({ transitionMs: 500, resetMs: 4000 });
  });

  it('ships defaulting in opposite directions, which is the design and not an oversight', () => {
    // Saying nothing about *how to move* means do not move; saying nothing about *how long to stay*
    // does not mean stay forever. Asserted against what a deployment actually gets, because the
    // asymmetry is the part a well-meaning edit to the defaults would quietly destroy.
    const shipped = CONFIG_DEFAULTS.media.virtualCamera;
    expect(directorTiming({}, shipped).transitionMs, 'a cut').toBe(0);
    expect(directorTiming({}, shipped).resetMs, 'and it comes back').toBeGreaterThan(0);
  });

  it('treats an explicit zero reset as "stay there"', () => {
    // Distinct from leaving it out, which is the whole point of the fallback.
    expect(directorTiming({ resetMs: 0 }, FALLBACK).resetMs).toBe(0);
    expect(directorTiming({}, FALLBACK).resetMs).toBe(FALLBACK.resetMs);
  });

  it('lets a deployment turn the expiry off, which is a thing it has to be able to mean', () => {
    // `media.virtualCamera.resetMs: 0` says a command that asks for nothing holds its shot
    // indefinitely. Not a good idea, and not ours to refuse — but it must survive being passed through.
    expect(directorTiming({}, { transitionMs: 0, resetMs: 0 }).resetMs).toBe(0);
  });

  it('falls back rather than clamping when a number is not one', () => {
    // These arrive from another machine. Garbage becoming `0` would mean "hold this shot forever" —
    // the one outcome the fallback exists to prevent.
    for (const bad of [NaN, Infinity, -Infinity, undefined]) {
      expect(directorTiming({ resetMs: bad }, FALLBACK).resetMs).toBe(FALLBACK.resetMs);
      expect(directorTiming({ transitionMs: bad }, FALLBACK).transitionMs).toBe(FALLBACK.transitionMs);
    }
  });

  it('has no use for a negative duration', () => {
    expect(directorTiming({ transitionMs: -1, resetMs: -1 }, FALLBACK)).toEqual({ transitionMs: 0, resetMs: 0 });
  });
});

// ============================================================
// How far behind a link may fall
// ============================================================

describe('maxBufferedBytes', () => {
  it('is a quarter-second of whatever this deployment encodes at', () => {
    expect(maxBufferedBytes(DEFAULT_PROFILE)).toBe(DEFAULT_PROFILE.bitrate / 8 / 4);
  });

  it('stays well clear of a single frame at any quality, which a flat number did not', () => {
    // The reason this is a function. Written down as 16KB it was a quarter-second at 500kbps and
    // *less than one frame* at 5Mbps — so a deployment that raised its quality would have found the
    // rule that exists to stop a picture falling behind throwing away frames the link could carry.
    for (const bitrate of [200_000, 500_000, 2_000_000, 5_000_000]) {
      const profile = { ...DEFAULT_PROFILE, bitrate };
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
// Putting the board's edge where the shot is
// ============================================================

describe('outlineInShot', () => {
  /** The model's input square, offset inside a landscape frame the way a real crop is. */
  const crop = { cropX: 280, cropY: 0, cropSize: 720 };
  /** Two corners of the input square and its centre, in the normalized coordinates the mask holds. */
  const outline = Float64Array.from([0, 0, 1, 1, 0.5, 0.5]);

  it('maps the input square onto the whole canvas when the shot is the whole crop', () => {
    const shot = { x: 280, y: 0, size: 720 };
    const points = outlineInShot(outline, crop, shot, 320);
    expect([...points]).toEqual([0, 0, 320, 320, 160, 160]);
  });

  it('doubles the scale for a shot half the size of the crop', () => {
    // A shot centred on the crop and half its side: the input square's corners now fall a quarter of
    // the canvas outside it on each side, and its centre stays in the middle. Swapping an axis or
    // flipping a sign moves exactly these numbers and nothing the eye would catch on a live board.
    const shot = { x: 280 + 180, y: 180, size: 360 };
    const points = outlineInShot(outline, crop, shot, 320);
    expect([...points]).toEqual([-160, -160, 480, 480, 160, 160]);
  });

  it('lets the board run off the edge rather than clamping it', () => {
    // A shot in the corner of the crop, so most of the board is outside the frame. Clamping here
    // would bend the outline along the canvas edge and mask the wrong side of it; the rasterizer
    // handles the overhang for free.
    const shot = { x: 280, y: 0, size: 180 };
    const points = outlineInShot(outline, crop, shot, 320);
    expect(points[2]).toBeGreaterThan(320);
    expect(points[3]).toBeGreaterThan(320);
  });
});

// ============================================================
// Spelling a homography as CSS
// ============================================================

describe('toMatrix3d', () => {
  /** Nothing symmetric, so a transposed matrix cannot come out looking the same. */
  const matrix: Matrix3x3 = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];

  it('writes the sixteen numbers in the order CSS reads them', () => {
    // Pinned as text because there is no `DOMMatrix` here to parse it, and because the failure this
    // guards is silent: a transposed matrix is not an error, it is a picture that is wrong in a way
    // nobody can trace back to a comma.
    expect(toMatrix3d(matrix)).toBe('matrix3d(1, 4, 0, 7, 2, 5, 0, 8, 0, 0, 1, 0, 3, 6, 0, 9)');
  });

  it('means, to a browser, what the matrix means to us', () => {
    // The same string read the way a browser reads it: column-major, applied to a flat element at
    // z = 0, divided through by w. That it agrees with `transformPoint` is the whole claim behind
    // using CSS for this at all — and it is a claim about the *ordering*, which the string above
    // pins and this gives the meaning of.
    const css = toMatrix3d(matrix).slice('matrix3d('.length, -1).split(',').map(Number);
    for (const [x, y] of [[0, 0], [17, 0], [0, 23], [140, 260], [-30, 610]] as const) {
      const w = css[3] * x + css[7] * y + css[15];
      const browser = [(css[0] * x + css[4] * y + css[12]) / w, (css[1] * x + css[5] * y + css[13]) / w];
      const ours = transformPoint([x, y], matrix)!;
      expect(browser[0]).toBeCloseTo(ours[0], 10);
      expect(browser[1]).toBeCloseTo(ours[1], 10);
    }
  });
});

describe('BOARD_CUTOUT', () => {
  it('cuts at the same rim the scoring device masks at', () => {
    // Both sides read `boardOuter`, so a masked feed's black ring falls exactly outside this hole
    // rather than nearly outside it. Written out here so a change to either is a failure and not a
    // thin crescent nobody can account for.
    expect(BOARD_CUTOUT).toBe('circle(49.89% at 50% 50%)');
    expect(Number((NORMALIZED_RADII.boardOuter * 100).toFixed(2))).toBe(49.89);
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
    const packed = packVideo({ feedId: FEED_ID, key: true, seq: 41, timestamp: 2_733_333 }, payload);
    const read = unpackVideo(packed);
    expect(read).not.toBeNull();
    expect(read!.header).toEqual({
      feedId: FEED_ID, key: true, seq: 41, timestamp: 2_733_333, geometry: null,
    });
    expect([...read!.payload]).toEqual([...payload]);
  });

  it('distinguishes a delta frame from a keyframe', () => {
    expect(unpackVideo(packVideo({ feedId: FEED_ID, key: false, seq: 1, timestamp: 0 }, payload))!.header.key).toBe(false);
  });

  it('carries a timestamp a u32 of microseconds could not', () => {
    // Seventy-one minutes is where microseconds overflow a u32, and a match can outlast that. Two
    // hours in, exactly.
    const timestamp = 2 * 60 * 60 * 1e6;
    expect(unpackVideo(packVideo({ feedId: FEED_ID, key: true, seq: 7, timestamp }, payload))!.header.timestamp).toBe(timestamp);
  });

  it('carries a sequence number to the top of its range', () => {
    const seq = 4_294_967_295;
    expect(unpackVideo(packVideo({ feedId: FEED_ID, key: false, seq, timestamp: 1 }, payload))!.header.seq).toBe(seq);
  });

  it('is exactly twenty-nine bytes of overhead, and eighty-one with a geometry block', () => {
    expect(packVideo({ feedId: FEED_ID, key: true, seq: 0, timestamp: 0 }, payload).byteLength).toBe(payload.length + 29);
    expect(packVideo({ feedId: FEED_ID, key: true, seq: 0, timestamp: 0, geometry: GEOMETRY }, payload).byteLength)
      .toBe(payload.length + 29 + 52);
  });

  it('returns null rather than throwing on anything too short to be one', () => {
    // Data from another machine on a channel where corruption is expected. One bad message must not
    // take down the feed behind it.
    for (const length of [0, 1, 28, 29]) {
      expect(unpackVideo(new ArrayBuffer(length))).toBeNull();
    }
  });

  it('copies the payload rather than viewing the message it arrived in', () => {
    const packed = packVideo({ feedId: FEED_ID, key: true, seq: 1, timestamp: 0 }, payload);
    const read = unpackVideo(packed)!;
    // Scribble over the original: a decoder handed this later must not see the change.
    new Uint8Array(packed).fill(0);
    expect([...read.payload]).toEqual([...payload]);
  });

  it('rejects a malformed feed id before writing a frame', () => {
    expect(() => packVideo({ feedId: 'not-a-uuid', key: true, seq: 1, timestamp: 0 }, payload)).toThrow();
  });

  it('rejects malformed UUID bytes before receiver state can see them', () => {
    // Thirty zero bytes have a finite timestamp and a payload, but UUID version/variant bits that
    // can never identify a feed created by this protocol.
    expect(unpackVideo(new ArrayBuffer(30))).toBeNull();
  });

  it('carries a geometry block, field by field, to what a float32 can hold', () => {
    const read = unpackVideo(packVideo(
      { feedId: FEED_ID, key: false, seq: 3, timestamp: 5, geometry: GEOMETRY }, payload,
    ))!;
    const geometry = read.header.geometry!;
    expect(geometry).not.toBeNull();
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        expect(geometry.homography[row][col]).toBe(Math.fround(GEOMETRY.homography[row][col]));
      }
    }
    expect(geometry.lensK1).toBe(Math.fround(GEOMETRY.lensK1));
    expect(geometry.shot.x).toBe(Math.fround(GEOMETRY.shot.x));
    expect(geometry.shot.y).toBe(Math.fround(GEOMETRY.shot.y));
    expect(geometry.shot.size).toBe(Math.fround(GEOMETRY.shot.size));
  });

  it('finds the payload by the flag rather than by the length', () => {
    // The one that catches somebody simplifying the offset arithmetic: with a block in front of it,
    // the picture must still come back byte for byte and not fifty-two bytes of floats plus most of
    // a picture — which is a stream a decoder accepts and then renders as rubbish.
    const described = unpackVideo(packVideo(
      { feedId: FEED_ID, key: true, seq: 1, timestamp: 0, geometry: GEOMETRY }, payload,
    ))!;
    expect([...described.payload]).toEqual([...payload]);

    const plain = unpackVideo(packVideo({ feedId: FEED_ID, key: true, seq: 1, timestamp: 0 }, payload))!;
    expect([...plain.payload]).toEqual([...payload]);
    expect(plain.header.geometry).toBeNull();
  });

  it('says nothing about the board on a frame that carries no block', () => {
    // Absent means *unchanged*, which is the sender's contract — this only pins that the reader does
    // not invent one.
    const read = unpackVideo(packVideo({ feedId: FEED_ID, key: false, seq: 9, timestamp: 1 }, payload))!;
    expect(read.header.geometry).toBeNull();
  });

  it('refuses a message that claims a block it does not carry', () => {
    const packed = packVideo(
      { feedId: FEED_ID, key: true, seq: 1, timestamp: 0, geometry: GEOMETRY }, payload,
    );
    // Exactly the header and the block, and no picture behind it.
    expect(unpackVideo(packed.slice(0, 81))).toBeNull();
    expect(unpackVideo(packed.slice(0, 80))).toBeNull();
  });

  it('keeps the picture when the description of it is unreadable', () => {
    // A bad float is a lost description, never a lost frame. Trading a picture for a complaint about
    // one would be the wrong way round on a channel that expects corruption.
    for (const [offset, value] of [[29, Number.NaN], [29 + 48, 0]] as const) {
      const packed = packVideo(
        { feedId: FEED_ID, key: true, seq: 1, timestamp: 0, geometry: GEOMETRY }, payload,
      );
      new DataView(packed).setFloat32(offset, value);
      const read = unpackVideo(packed)!;
      expect(read).not.toBeNull();
      expect(read.header.geometry, `offset ${offset}`).toBeNull();
      expect([...read.payload]).toEqual([...payload]);
    }
  });

  it('keeps the keyframe flag and the geometry flag independent', () => {
    const deltaDescribed = unpackVideo(packVideo(
      { feedId: FEED_ID, key: false, seq: 1, timestamp: 0, geometry: GEOMETRY }, payload,
    ))!.header;
    expect(deltaDescribed.key).toBe(false);
    expect(deltaDescribed.geometry).not.toBeNull();

    const keyPlain = unpackVideo(packVideo(
      { feedId: FEED_ID, key: true, seq: 2, timestamp: 0 }, payload,
    ))!.header;
    expect(keyPlain.key).toBe(true);
    expect(keyPlain.geometry).toBeNull();
  });
});

// ============================================================
// Pairing a frame with its geometry, across the encoder
// ============================================================

describe('the frame geometry queue', () => {
  /** A second description, so an out-of-order answer cannot pass as the right one. */
  const OTHER: BoardGeometry = { ...GEOMETRY, lensK1: 0.031 };

  it('hands frames back in the order the encoder took them', () => {
    // The whole of the pairing, and the reason this is a queue and not a lookup: nothing about a
    // chunk identifies which frame it came from except its place in the sequence.
    const queue = createFrameGeometryQueue(4);
    queue.push(GEOMETRY);
    queue.push(null);
    queue.push(OTHER);
    expect(queue.shift()).toBe(GEOMETRY);
    // A frame whose camera had not located a board is a recorded answer too, and holds its place.
    expect(queue.shift()).toBeNull();
    expect(queue.shift()).toBe(OTHER);
  });

  it('has nothing to say about a chunk it never saw a frame for', () => {
    const queue = createFrameGeometryQueue(4);
    expect(queue.shift()).toBeNull();
  });

  it('drops the oldest rather than growing, so an encoder that stops emitting cannot leak', () => {
    const queue = createFrameGeometryQueue(2);
    queue.push(null);
    queue.push(GEOMETRY);
    queue.push(OTHER);
    expect(queue.shift(), 'the oldest entry was not dropped').toBe(GEOMETRY);
    expect(queue.shift()).toBe(OTHER);
    expect(queue.shift()).toBeNull();
  });

  it('is emptied with its encoder, so frames it never answered for cannot offset the next one', () => {
    const queue = createFrameGeometryQueue(4);
    queue.push(GEOMETRY);
    queue.clear();
    expect(queue.shift()).toBeNull();
  });
});
