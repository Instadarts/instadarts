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
// queue**: a link with a backlog is skipped for that frame and catches up on the next one, rather
// than growing a buffer until the picture is a minute behind the board.
//
// It also does not decide *what* is in the picture. The framing is the virtual camera's, upstream of
// here; this owns the codec, the clock and the fan-out.

import type { MediaRole, VideoFeedId, VideoProfile } from '../../shared/media';
import { VIDEO, maxBufferedBytes } from '../../shared/media';
import { sameBoardGeometry, type BoardGeometry } from '../../shared/vision/feedGeometry';
import type { Mesh } from './mesh';
import { packVideo } from './frames';

/**
 * One frame and the description of it.
 *
 * The two travel together rather than being asked for separately, and that is the whole of the
 * pairing problem solved: a `geometry()` call beside `grab()` would be a convention that it must be
 * read before the next frame is made, with nothing enforcing it. Here it cannot describe any frame
 * but the one it came with.
 */
export interface GrabbedFrame {
  /** Ours to close. */
  frame: VideoFrame;
  /** Where the board is in it, or null when this camera has not located one. */
  geometry: BoardGeometry | null;
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
  /**
   * Frames published carrying a geometry block — that is, frames whose camera had located the board
   * *and* had something new to say about it. Most frames of a still scene have neither.
   *
   * Named for what it counts rather than for what it carries, so it cannot be mistaken for
   * `ReceiverStats.geometry`, which is the description itself and not a number.
   */
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
  error?: string;
}

export interface VideoPublisher {
  /** Whether the encoder is configured and the loop is running. */
  readonly running: boolean;
  /** Which roles may contain the exact accepted peers this publisher is serving. */
  readonly audience: readonly MediaRole[];
  /** Send the next frame as a keyframe. Rate-limited, so several viewers asking costs one. */
  requestKeyframe(): void;
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
 * Pairing a frame with the geometry it was grabbed under, across the encoder.
 *
 * The description is known in `tick`, where the frame is made; the packet is built in the encoder's
 * output callback, an unknown number of frames later. `EncodedVideoChunk.timestamp` is the
 * `VideoFrame` timestamp we set, and **realtime H.264 has no B-frames and does not reorder** — that
 * assumption is what makes a timestamp a key, and nothing in this repository enforces it. It follows
 * from the `latencyMode: 'realtime'` and the codec that `ensureEncoder` configures, below.
 *
 * Fixed-size and never deleted from. A frame the encoder swallowed leaves a slot that is simply
 * overwritten, so there is no bookkeeping anybody can get wrong and nothing that grows — which is
 * the property a `Map` with a size cap has to be maintained into, rather than having by
 * construction. `tick` refuses to encode past `encodeQueueSize > 2`, so eight is generous.
 */
export interface FrameGeometryTrail {
  put(timestampUs: number, geometry: BoardGeometry | null): void;
  /** What was recorded for this timestamp, or null. Leaves it in place; the ring overwrites it. */
  find(timestampUs: number): BoardGeometry | null;
  clear(): void;
}

export function createFrameGeometryTrail(capacity = 8): FrameGeometryTrail {
  // NaN never equals a timestamp, so an empty slot cannot be found by accident.
  const stamps = new Float64Array(capacity).fill(Number.NaN);
  let values: (BoardGeometry | null)[] = new Array(capacity).fill(null);
  let next = 0;

  return {
    put(timestampUs: number, geometry: BoardGeometry | null): void {
      stamps[next] = timestampUs;
      values[next] = geometry;
      next = (next + 1) % capacity;
    },
    find(timestampUs: number): BoardGeometry | null {
      for (let index = 0; index < capacity; index++) {
        if (stamps[index] === timestampUs) return values[index];
      }
      return null;
    },
    clear(): void {
      stamps.fill(Number.NaN);
      values = new Array(capacity).fill(null);
      next = 0;
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
  let stats: PublisherStats = { frames: 0, keyframes: 0, bytes: 0, dropped: 0, missed: 0, oversize: 0, described: 0 };
  const trail = createFrameGeometryTrail();
  /**
   * The description a receiver should already hold, so an unchanged one is not sent again.
   *
   * Cleared with the encoder rather than with the feed, and that is the load-bearing half: a camera
   * pause stops only the encoder and **keeps the feed UUID**, so without this a receiver would carry
   * geometry across a camera restart and pair it with pictures from a phone that may have been moved
   * in between. A fresh encoder starts wanting a keyframe, so the first frame after a pause carries
   * the current answer.
   */
  let lastSentGeometry: BoardGeometry | null = null;
  let lastFrameAt = 0;
  /**
   * The last keyframe that actually reached a link, and the last one asked of the encoder.
   *
   * Two clocks rather than one, and keeping them apart is what stops a feed drifting — see
   * `keyframeDue`. Negative infinity rather than zero so that neither is satisfied by a page that
   * happens to have been open a while.
   */
  let lastKeyframeAt = -Infinity;
  let keyframeTriedAt = -Infinity;
  let wantKeyframe = true;

  /** Cancellation for whichever pacing mechanism we ended up on. */
  let rafHandle = 0;
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
    const body = new Uint8Array(chunk.byteLength);
    chunk.copyTo(body);

    const key = chunk.type === 'key';
    // On change, and on every keyframe. A mounted camera watching a still board re-solves its
    // homography only when the motion gate fires, and holds one shot between director commands, so
    // most frames say nothing at all. Repeating it on keyframes is what lets a viewer who joined
    // late, or who lost the frame that carried the last change, catch up on the same frame it can
    // start decoding from.
    //
    // A frame with no block therefore means *unchanged*, never *gone*. Within one feed that is
    // always true: a camera only ever gains or moves its board, and the homography is dropped in
    // `stop()`, which ends the camera session and the encoder with it.
    const geometry = trail.find(chunk.timestamp);
    const describe = geometry !== null && (key || !sameBoardGeometry(geometry, lastSentGeometry));
    const packet = packVideo({
      feedId,
      key,
      seq: clock.nextSequence(),
      timestamp: chunk.timestamp,
      geometry: describe ? geometry : null,
    }, body);

    const allowed = accepted();
    const addressed = mesh.viewers(audience()).filter((link) => allowed.has(link.peerId));
    let sent = 0;
    let refused = false;
    for (const link of addressed) {
      // More than this peer said it could take in one message. Handing it over anyway throws, and a
      // channel is worth more than a frame — so this link goes without and the counter says so. A
      // described frame is fifty-two bytes nearer that limit, which against sixty-four kilobytes is
      // noise — but it is real, and `oversize` is where it would show.
      if (packet.byteLength > link.maxMessageBytes) { refused = true; continue; }

      // Drop, never queue. A frame this link has not managed to send yet is worth less than the one
      // behind it, and every viewer is judged separately — one slow peer does not cost the others.
      if (link.bufferedAmount > backlogLimit) {
        stats = { ...stats, dropped: stats.dropped + 1 };
        continue;
      }
      if (link.sendMedia(packet)) sent++;
    }

    if (refused) stats = { ...stats, oversize: stats.oversize + 1 };

    // Recorded here rather than where it was encoded, because this is where it became true. A
    // keyframe nobody could take has repaired nothing, and treating the attempt as the event is what
    // let a feed sit broken for a whole `keyFrameIntervalMs` at a time — or forever, when every
    // keyframe failed for the same reason. Left un-recorded, one is still due on the next tick.
    //
    // Reaching *anyone* is enough. A viewer that was skipped while the rest were served has the
    // `keyframe` request to say so, and re-keying on its behalf would let one backed-up peer hold
    // every other viewer at two keyframes a second. An audience of nobody counts too: there is
    // nothing to repair, and an unwatched feed should not sit re-keying itself.
    if (key && (sent > 0 || addressed.length === 0)) {
      lastKeyframeAt = performance.now();
      wantKeyframe = false;
    }

    if (sent === 0) return;
    // Recorded only now, so a description nobody received is not treated as delivered. It is still
    // per-feed rather than per-link: a link that was skipped for backpressure while others were
    // served waits for the next keyframe, which is the repair path every other loss here has.
    if (describe) lastSentGeometry = geometry;
    stats = {
      ...stats,
      frames: stats.frames + 1,
      keyframes: stats.keyframes + (key ? 1 : 0),
      bytes: stats.bytes + body.byteLength,
      described: stats.described + (describe ? 1 : 0),
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
  function keyframeDue(now: number): boolean {
    if (now - keyframeTriedAt < VIDEO.keyframeMinIntervalMs) return false;
    return wantKeyframe || now - lastKeyframeAt >= profile.keyFrameIntervalMs;
  }

  function ensureEncoder(): VideoEncoder | null {
    if (encoder) return encoder;
    // A new encoder has told nobody anything, and its timestamps may start again from a clock that
    // was reset. Both halves of the pairing go with it.
    trail.clear();
    lastSentGeometry = null;
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

  function tick(): void {
    if (stopped) return;

    const now = performance.now();
    // A camera handing back thirty frames a second should not be encoded at thirty when the profile
    // says fifteen. Paced by wall clock rather than by counting, so a slow frame does not push the
    // whole feed late.
    if (now - lastFrameAt < minFrameGapMs - 1) return;
    lastFrameAt = now;

    const codec = ensureEncoder();
    if (!codec || codec.state !== 'configured') return;
    // Frames already handed over and not yet encoded. Piling more on a busy encoder buys latency,
    // not smoothness.
    if (codec.encodeQueueSize > 2) return;

    const timestampUs = clock.timestampUs(now);
    const grabbed = source.grab(profile.width, timestampUs, frameDurationUs);
    if (!grabbed) {
      stats = { ...stats, missed: stats.missed + 1 };
      return;
    }

    // Written before the frame is handed over, so a synchronous output callback — which is not
    // expected, and is not worth being wrong about — could not look for a slot that is not there.
    trail.put(timestampUs, grabbed.geometry);

    const dueKeyframe = keyframeDue(now);
    try {
      codec.encode(grabbed.frame, { keyFrame: dueKeyframe });
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

  /**
   * Pace against the camera where the platform allows it.
   *
   * `requestVideoFrameCallback` fires once per frame the camera actually decoded, which is the only
   * clock that cannot ask for a picture that does not exist yet. Where it is missing — Firefox, at
   * time of writing — a timer at the profile's rate is close enough, and `tick` throttles either way.
   */
  function loop(): void {
    if (stopped) return;
    const element = source.element();
    if (element && 'requestVideoFrameCallback' in element) {
      rafHandle = element.requestVideoFrameCallback(() => { tick(); loop(); });
      return;
    }
    timer = setTimeout(() => { tick(); loop(); }, minFrameGapMs);
  }

  loop();

  return {
    get running() { return !stopped && encoder?.state === 'configured'; },
    get audience() { return audience(); },

    requestKeyframe(): void {
      // Deliberately unlimited. Several viewers losing the same frame all ask at once and a keyframe
      // costs every viewer bandwidth, but the limit belongs on the answer rather than the question —
      // `keyframeDue` is where one answer comes to serve all of them. A limit here could only count
      // *asking*, which meant a request that crossed a keyframe already on its way bought a second
      // one nobody needed, while a request that arrived just after a failed keyframe bought nothing.
      wantKeyframe = true;
    },

    stats(): PublisherStats { return stats; },

    stop(): void {
      if (stopped) return;
      stopped = true;
      const element = source.element();
      if (rafHandle && element && 'cancelVideoFrameCallback' in element) element.cancelVideoFrameCallback(rafHandle);
      if (timer) clearTimeout(timer);
      // `close()` rather than `flush()`: whatever is still in the encoder describes a moment that has
      // passed, and a live feed has no use for it.
      try { encoder?.close(); } catch { /* already gone */ }
      encoder = null;
      trail.clear();
      lastSentGeometry = null;
    },
  };
}
