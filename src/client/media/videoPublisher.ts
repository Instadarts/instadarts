// One encoder, however many viewers.
//
// This is what mesh.ts has been reserving space for since part 2, and the entire reason a link
// carries no video track: every `RTCPeerConnection` encodes its tracks independently, so a phone with
// four viewers would run four encoders while also running the detection model. Here the frame is
// encoded once and the same bytes are written to every open media channel.
//
// ## What it does not do
//
// It does not adapt. There is no bandwidth estimator behind a datachannel and adaptive bitrate is
// deliberately not a feature, so the honest policy for a fixed-rate link is **drop frames, never
// queue**: a link with a backlog is skipped for that frame and resumes at a repair keyframe, rather
// than growing a buffer until the picture is a minute behind the board.
//
// It also does not decide *what* is in the picture. The framing is the virtual camera's, upstream of
// here; this owns the codec, the clock and the fan-out.

import type { MediaRole, VideoFeedId, VideoProfile } from '../../shared/media';
import { VIDEO, maxBufferedBytes } from '../../shared/media';
import { sameBoardGeometry, type BoardGeometry } from '../../shared/vision/feedGeometry';
import type { Mesh } from './mesh';
import { createVideoPacker } from './frames';

/** One frame and the resting framing to apply when it is displayed. */
export interface GrabbedFrame {
  /** Ours to close. */
  frame: VideoFrame;
  /** Held through director zooms; null until a resting shot has been located this camera session. */
  restingGeometry: BoardGeometry | null;
}

/** Where a frame comes from. The device's vision runtime supplies this. */
export interface VideoFrameSource {
  /** One frame, framed as the director asked. Null when there is no camera. Ours to close. */
  grab: (size: number, timestampUs: number, durationUs: number) => GrabbedFrame | null;
  /** The element to pace against, where the platform can pace against one. */
  element: () => HTMLVideoElement | null;
}

/** What the feed has cost and produced. Read through the diagnostics panel. */
export interface PublisherStats {
  frames: number;
  keyframes: number;
  bytes: number;
  /** Frames the encoder produced that a link was too far behind to take. */
  dropped: number;
  /** Frames the source could not produce — camera between frames, mostly. */
  missed: number;
  /** Frames published with a geometry block (resets do not count). */
  described: number;
  /**
   * Frames too big for a link to carry in one message.
   *
   * Almost always keyframes, and worth its own counter rather than being folded into `dropped`:
   * these two numbers mean opposite things. A dropped frame is the backpressure policy working. An
   * oversize one is a frame nothing can ever send, so the picture it would have repaired stays
   * broken — which looks like a feed that slowly falls apart rather than like one that stutters.
   */
  oversize: number;
  pacingSkipped: number;
  encoderBusy: number;
  sendFailures: number;
  awaitingKeyframe: number;
  /** Inputs accepted by the encoder and chunks emitted, before transport filtering. */
  submitted: number;
  encoded: number;
  pacingClock: 'waiting' | 'media' | 'callback' | 'timer';
  error?: string;
}

export interface VideoPublisher {
  /** Whether the encoder is configured and the loop is running. */
  readonly running: boolean;
  /** Which roles may contain the exact accepted peers this publisher is serving. */
  readonly audience: readonly MediaRole[];
  /** Send the next frame as a keyframe. Rate-limited, so several viewers asking costs one. */
  requestKeyframe(peerId: string): void;
  stats(): PublisherStats;
  stop(): void;
}

/**
 * Packet identity and media time belong to a feed/source epoch, not to one encoder incarnation.
 *
 * The encoder is deliberately stopped while every accepted recipient is temporarily unwritable.
 * Recreating it must continue both values: an existing receiver rejects repeated sequence numbers,
 * and a decoder should not see the same feed's timeline jump back to zero after link recovery.
 */
export interface VideoFeedClock {
  nextSequence(): number;
  timestampUs(nowMs: number): number;
  reset(nowMs?: number): void;
}

/**
 * FIFO pairing for the realtime H.264 encoder. See docs/media.md for the codec assumptions.
 * Empty means no update; null is a recorded reset and must keep its place.
 */
export interface FrameGeometryQueue<T = BoardGeometry | null> {
  /** Record the geometry of a frame the encoder has just taken. */
  push(geometry: T): void;
  /** The next frame's resting geometry, or undefined when there is no pending frame. */
  shift(): T | undefined;
  clear(): void;
}

export function createFrameGeometryQueue<T = BoardGeometry | null>(capacity = 8): FrameGeometryQueue<T> {
  const items: T[] = [];

  return {
    push(geometry: T): void {
      items.push(geometry);
      if (items.length > capacity) items.shift();
    },
    shift(): T | undefined {
      return items.shift();
    },
    clear(): void {
      items.length = 0;
    },
  };
}

export function createVideoFeedClock(nowMs = performance.now()): VideoFeedClock {
  let sequence = 0;
  let startedAt = nowMs;
  return {
    nextSequence(): number { return sequence++; },
    timestampUs(now: number): number { return Math.round((now - startedAt) * 1000); },
    reset(now = performance.now()): void {
      sequence = 0;
      startedAt = now;
    },
  };
}

export interface PublisherOptions {
  mesh: Mesh;
  profile: VideoProfile;
  source: VideoFrameSource;
  feedId: VideoFeedId;
  /**
   * Which kinds of viewer this feed is for, asked on every frame.
   *
   * A getter rather than a value, because the owner can re-address a running feed and doing so must
   * not disturb the encoder — the recipient list is not part of how a frame is made.
   */
  audience: () => readonly MediaRole[];
  /** Exact peers that accepted; intersected with the current authorized audience on every frame. */
  accepted: () => ReadonlySet<string>;
  /** Persistent clock for this feed UUID; shared across temporary encoder incarnations. */
  clock: VideoFeedClock;
}

/** Whether this browser can publish at all. Safari gained `VideoEncoder` in 16.4; older ones cannot. */
export function canPublish(): boolean {
  return typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';
}

export function createVideoPublisher({ mesh, profile, source, feedId, audience, accepted, clock }: PublisherOptions): VideoPublisher {
  const frameDurationUs = 1e6 / profile.frameRate;
  const minFrameGapMs = 1000 / profile.frameRate;
  /** A quarter-second of *this* profile, not of the one it was tuned against. */
  const backlogLimit = maxBufferedBytes(profile);

  let encoder: VideoEncoder | null = null;
  let stopped = false;
  let stats: PublisherStats = { frames: 0, keyframes: 0, bytes: 0, dropped: 0, missed: 0, oversize: 0, described: 0, pacingSkipped: 0, encoderBusy: 0, sendFailures: 0, awaitingKeyframe: 0, submitted: 0, encoded: 0, pacingClock: 'waiting' };
  const geometries = createFrameGeometryQueue<{ geometry: BoardGeometry | null; generation: number }>();
  const pack = createVideoPacker(feedId);
  const knownViewers = new Set<string>();
  const recovery = new Map<string, number>();
  let generation = 0;

  function needKeyframe(peerId: string): void {
    recovery.set(peerId, ++generation);
    stats = { ...stats, awaitingKeyframe: recovery.size };
  }

  function viewers() {
    const allowed = accepted();
    const links = mesh.viewers(audience()).filter((link) => allowed.has(link.peerId));
    const current = new Set(links.map((link) => link.peerId));
    for (const peerId of knownViewers) {
      if (!current.has(peerId)) { knownViewers.delete(peerId); recovery.delete(peerId); }
    }
    for (const peerId of current) {
      if (!knownViewers.has(peerId)) { knownViewers.add(peerId); needKeyframe(peerId); }
    }
    stats = { ...stats, awaitingKeyframe: recovery.size };
    return links;
  }
  /** Last value delivered to at least one viewer. Undefined forces an initial update or reset. */
  let lastSentGeometry: BoardGeometry | null | undefined;
  let nextFrameAt: number | null = null;
  let lastSampleAt = -Infinity;
  let sampleElement: HTMLVideoElement | null = null;
  let sampleMode = '';
  let clockElement: HTMLVideoElement | null = null;
  let lastMediaTime: number | undefined;
  let lastPresentedFrames: number | undefined;
  let mediaChangedAt = 0;
  let useCallbackClock = false;
  let timerDeadline: number | null = null;
  /**
   * The last keyframe that actually reached a link, and the last one asked of the encoder.
   *
   * Two clocks rather than one, and keeping them apart is what stops a feed drifting — see
   * `keyframeDue`. Negative infinity rather than zero so that neither is satisfied by a page that
   * happens to have been open a while.
   */
  let lastKeyframeAt = -Infinity;
  let keyframeTriedAt = -Infinity;

  /** Cancellation for whichever pacing mechanism we ended up on. */
  let rafHandle = 0;
  let callbackElement: HTMLVideoElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** Recorded rather than thrown or reported outwards: `stats()` is where anybody asks how it is going. */
  function fail(message: string): void {
    stats = { ...stats, error: message };
  }

  /**
   * One encoded frame out to everyone entitled to it.
   *
   * `mesh.viewers(...)` is the same call a still's fan-out makes: the roster answering "who may
   * receive from us", narrowed to the roles the owner addressed the feed to. Neither question is
   * this file's to decide.
   */
  function publish(chunk: EncodedVideoChunk): void {
    if (stopped) return;
    stats = { ...stats, encoded: stats.encoded + 1 };

    const key = chunk.type === 'key';
    // Repeat the full resting state on keyframes, including resets, to recover from packet loss.
    const metadata = geometries.shift();
    const geometry = metadata?.geometry;
    const update = geometry !== undefined
      && (key || lastSentGeometry === undefined || !sameBoardGeometry(geometry, lastSentGeometry));
    const packet = pack({
      key,
      seq: clock.nextSequence(),
      timestamp: chunk.timestamp,
      restingGeometry: update ? geometry : undefined,
    }, chunk);

    const addressed = viewers();
    let sent = 0;
    let refused = false;
    for (const link of addressed) {
      if (!key && recovery.has(link.peerId)) continue;
      if (packet.byteLength > link.maxMessageBytes) {
        refused = true;
        if (!recovery.has(link.peerId)) needKeyframe(link.peerId);
        continue;
      }
      if (link.bufferedAmount > backlogLimit) {
        stats = { ...stats, dropped: stats.dropped + 1 };
        if (!recovery.has(link.peerId)) needKeyframe(link.peerId);
        continue;
      }
      if (!link.sendMedia(packet)) {
        stats = { ...stats, sendFailures: stats.sendFailures + 1 };
        if (!recovery.has(link.peerId)) needKeyframe(link.peerId);
        continue;
      }
      sent++;
      const requested = recovery.get(link.peerId);
      // Sending an older in-flight keyframe must not consume a newer repair request.
      if (key && requested !== undefined && metadata && requested <= metadata.generation) {
        recovery.delete(link.peerId);
      }
    }
    stats = { ...stats, awaitingKeyframe: recovery.size };

    if (refused) stats = { ...stats, oversize: stats.oversize + 1 };

    // The periodic schedule follows delivery; individual repairs remain pending independently.
    if (key && sent > 0) lastKeyframeAt = performance.now();

    if (sent === 0) return;
    // Recorded only now, so a description nobody received is not treated as delivered. It is still
    // per-feed rather than per-link: a link that was skipped for backpressure while others were
    // served waits for the next keyframe, which is the repair path every other loss here has.
    if (update) lastSentGeometry = geometry;
    stats = {
      ...stats,
      frames: stats.frames + 1,
      keyframes: stats.keyframes + (key ? 1 : 0),
      bytes: stats.bytes + chunk.byteLength,
      described: stats.described + (update && geometry ? 1 : 0),
    };
  }

  /**
   * Whether the frame about to be encoded should be a keyframe.
   *
   * The schedule is measured from the last keyframe that **went out**, and the retry from the last
   * one **asked of the encoder**. One clock could not do both: measuring the schedule from the
   * attempt hides a keyframe that never left, and measuring the retry from the delivery would ask
   * for another one on every tick for as long as they keep failing.
   *
   * `keyframeMinIntervalMs` therefore rations keyframes themselves rather than requests for them,
   * which is also what makes `requestKeyframe` free to call.
   */
  function keyframeDue(now: number, addressed: ReturnType<typeof viewers>): boolean {
    if (now - keyframeTriedAt < VIDEO.keyframeMinIntervalMs) return false;
    return addressed.some((link) => link.ready && link.bufferedAmount <= backlogLimit
      && (now - lastKeyframeAt >= profile.keyFrameIntervalMs || recovery.has(link.peerId)));
  }

  function ensureEncoder(): VideoEncoder | null {
    if (encoder) return encoder;
    // A new encoder has told nobody anything, and the frames a previous one never emitted are not
    // its to answer for. Both halves of the pairing go with it.
    geometries.clear();
    lastSentGeometry = undefined;
    try {
      encoder = new VideoEncoder({
        output: (chunk) => publish(chunk),
        error: (e) => fail(e instanceof Error ? e.message : String(e)),
      });
      encoder.configure({
        codec: profile.codec,
        width: profile.width,
        height: profile.height,
        bitrate: profile.bitrate,
        framerate: profile.frameRate,
        latencyMode: 'realtime',
        // Annex B puts SPS/PPS in front of every keyframe, so a keyframe is everything a decoder
        // needs to start. That is what lets a viewer who joined thirty seconds late begin on the
        // next one with nothing negotiated out of band — there is no signalling channel for codec
        // configuration here and there should not need to be.
        avc: { format: 'annexb' },
      });
      return encoder;
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
      encoder = null;
      return null;
    }
  }

  function tick(element: HTMLVideoElement | null, mode: PublisherStats['pacingClock'], sampleAt: number): void {
    if (stopped) return;
    const now = performance.now();
    if (element !== sampleElement || mode !== sampleMode || sampleAt < lastSampleAt) {
      nextFrameAt = null;
    }
    sampleElement = element;
    sampleMode = mode;
    if (stats.pacingClock !== mode) stats = { ...stats, pacingClock: mode };
    const repeated = sampleAt === lastSampleAt && mode === 'media' && nextFrameAt !== null;
    lastSampleAt = sampleAt;
    // The epsilon covers rounding accumulated by fractional (e.g. 15 fps) deadlines.
    const tolerance = (mode === 'media' ? 1 : Math.min(5, minFrameGapMs / 10)) + 1e-6;
    if (nextFrameAt === null) nextFrameAt = sampleAt;
    if (repeated || sampleAt + tolerance < nextFrameAt) {
      stats = { ...stats, pacingSkipped: stats.pacingSkipped + 1 };
      return;
    }
    nextFrameAt += Math.max(1, Math.floor((sampleAt + tolerance - nextFrameAt) / minFrameGapMs) + 1) * minFrameGapMs;
    const addressed = viewers();

    const codec = ensureEncoder();
    if (!codec || codec.state !== 'configured') return;
    // Frames already handed over and not yet encoded. Piling more on a busy encoder buys latency,
    // not smoothness.
    if (codec.encodeQueueSize > 2) {
      stats = { ...stats, encoderBusy: stats.encoderBusy + 1 };
      return;
    }

    const timestampUs = clock.timestampUs(now);
    const grabbed = source.grab(profile.width, timestampUs, frameDurationUs);
    if (!grabbed) {
      stats = { ...stats, missed: stats.missed + 1 };
      return;
    }

    const dueKeyframe = keyframeDue(now, addressed);
    const coveredGeneration = generation;
    try {
      codec.encode(grabbed.frame, { keyFrame: dueKeyframe });
      stats = { ...stats, submitted: stats.submitted + 1 };
      // Recorded only once the encoder has taken the frame. A throw above produces no chunk, and an
      // entry with nothing to pair it to would offset every frame after it by one.
      geometries.push({ geometry: grabbed.restingGeometry, generation: coveredGeneration });
      // Only that it was asked for. Whether it counts as one is `publish`'s to say.
      if (dueKeyframe) keyframeTriedAt = now;
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    } finally {
      // Always, on every path. A `VideoFrame` holds a real buffer and a handful of leaked ones stall
      // the encoder outright rather than degrading gently.
      grabbed.frame.close();
    }
  }

  /** Sample source time when available; callback execution time includes main-thread jitter. */
  function loop(): void {
    if (stopped) return;
    const element = source.element();
    if (element && 'requestVideoFrameCallback' in element) {
      timerDeadline = null;
      callbackElement = element;
      rafHandle = element.requestVideoFrameCallback((_now, metadata) => {
        rafHandle = 0;
        if (source.element() === element) {
          const now = performance.now();
          const mediaTime = metadata?.mediaTime;
          const valid = Number.isFinite(mediaTime) && mediaTime >= 0;
          if (clockElement !== element) {
            clockElement = element;
            lastMediaTime = undefined;
            lastPresentedFrames = undefined;
            mediaChangedAt = now;
            useCallbackClock = false;
          }
          const presented = metadata?.presentedFrames;
          const newFrame = Number.isFinite(presented) && lastPresentedFrames !== undefined
            && presented > lastPresentedFrames;
          // A finite timestamp is not necessarily a usable clock. Some sources can submit new
          // frames with the same timestamp; starving the encoder also prevents keyframe recovery.
          // Latch the fallback to avoid resetting the pacing phase on every repeated timestamp.
          if (valid && mediaTime === lastMediaTime
            && (newFrame || now - mediaChangedAt >= Math.max(250, 2 * minFrameGapMs))) {
            useCallbackClock = true;
          }
          if (mediaTime !== lastMediaTime) mediaChangedAt = now;
          lastMediaTime = mediaTime;
          lastPresentedFrames = Number.isFinite(presented) ? presented : undefined;
          const useMediaClock = valid && !useCallbackClock;
          tick(element, useMediaClock ? 'media' : 'callback', useMediaClock ? mediaTime * 1000 : now);
        }
        loop();
      });
      return;
    }
    const now = performance.now();
    if (timerDeadline === null) timerDeadline = now + minFrameGapMs;
    else if (timerDeadline <= now) {
      timerDeadline += (Math.floor((now - timerDeadline) / minFrameGapMs) + 1) * minFrameGapMs;
    }
    timer = setTimeout(() => {
      timer = null;
      tick(element, 'timer', performance.now());
      // Advance from the scheduled time, never from the end of frame processing.
      timerDeadline! += minFrameGapMs;
      loop();
    }, Math.max(1, timerDeadline - now));
  }

  loop();

  return {
    get running() { return !stopped && encoder?.state === 'configured'; },
    get audience() { return audience(); },

    requestKeyframe(peerId: string): void {
      if (!stopped && viewers().some((link) => link.peerId === peerId)) needKeyframe(peerId);
    },

    stats(): PublisherStats { if (!stopped) viewers(); return stats; },

    stop(): void {
      if (stopped) return;
      stopped = true;
      if (rafHandle && callbackElement) callbackElement.cancelVideoFrameCallback(rafHandle);
      if (timer) clearTimeout(timer);
      // `close()` rather than `flush()`: whatever is still in the encoder describes a moment that has
      // passed, and a live feed has no use for it.
      try { encoder?.close(); } catch { /* already gone */ }
      encoder = null;
      geometries.clear();
      recovery.clear();
      knownViewers.clear();
      stats = { ...stats, awaitingKeyframe: 0 };
      lastSentGeometry = undefined;
    },
  };
}
