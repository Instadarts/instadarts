// The viewer's half: encoded frames off an unreliable channel, back into a picture.
//
// Everything hard here is a consequence of the channel being `ordered: false, maxRetransmits: 0`.
// Frames go missing and frames arrive late, and a decoder handed a delta frame whose predecessor
// never came does not produce a late picture — it produces a wrong one, and keeps producing wrong
// ones until the next keyframe. So this drops rather than hopes:
//
//   · nothing at all until a keyframe arrives, because a keyframe is the only frame that means
//     anything on its own (annexb, so it carries its own SPS/PPS — see videoPublisher.ts);
//   · anything at or behind what has already been decoded, which is a frame that took the scenic
//     route;
//   · everything after a gap, until the next keyframe — and it asks for one rather than waiting for
//     the publisher's next scheduled keyframe.
//
// The picture lands in a canvas this owns. Handing a `VideoFrame` out to React would make its
// lifetime somebody else's problem, and a leaked one is a held GPU texture.

import type { VideoFeedId, VideoProfile } from '../../shared/media';
import { unpackVideo } from './frames';
import type { BoardGeometry } from '../../shared/vision/feedGeometry';

export interface ReceiverStats {
  /** Frames handed to the decoder. */
  decoded: number;
  /** Frames thrown away: stale, or after a gap with no keyframe yet. */
  dropped: number;
  /** Gaps seen in the sequence — the honest measure of what the channel is losing. */
  gaps: number;
  bytes: number;
  /** Whether a keyframe has been seen at all. False here means a black rectangle is expected. */
  started: boolean;
  /** Resting framing committed with the painted frame, held through zooms. Null means unlocated. */
  restingGeometry: BoardGeometry | null;
  error?: string;
}

export interface VideoReceiver {
  /** One message off the media channel. */
  accept(data: ArrayBuffer): void;
  /** Where the picture is. Attach it to the DOM to show the feed. */
  readonly canvas: HTMLCanvasElement;
  stats(): ReceiverStats;
  close(): void;
}

export interface ReceiverOptions {
  profile: VideoProfile;
  feedId: VideoFeedId;
  /** Ask the publisher for a keyframe. Called when there is no way forward without one. */
  requestKeyframe: () => void;
  /** A decoded frame was actually painted and is safe to put on screen. */
  onFrame?: () => void;
}

export function createVideoReceiver({ profile, feedId, requestKeyframe, onFrame }: ReceiverOptions): VideoReceiver {
  const canvas = document.createElement('canvas');
  canvas.width = profile.width;
  canvas.height = profile.height;
  const context = canvas.getContext('2d', { alpha: false });

  let stats: ReceiverStats = { decoded: 0, dropped: 0, gaps: 0, bytes: 0, started: false, restingGeometry: null };
  let lastSeq = -1;
  /** Whether the stream is decodable from here. False until a keyframe, and again after a gap. */
  let synced = false;
  let closed = false;
  let queuedGeometry: BoardGeometry | null = null;
  const pendingGeometry = new Map<number, BoardGeometry | null>();

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const restingGeometry = pendingGeometry.get(frame.timestamp);
        if (closed || !context || restingGeometry === undefined) return;
        // An output can skip frames. Each entry holds the resolved state, so skipped updates still
        // apply to later pictures, and their unused entries can be discarded.
        for (const seq of pendingGeometry.keys()) {
          if (seq > frame.timestamp) break;
          pendingGeometry.delete(seq);
        }
        context.drawImage(frame, 0, 0, canvas.width, canvas.height);
        stats = { ...stats, restingGeometry };
        onFrame?.();
      } finally {
        frame.close();
      }
    },
    error: (e) => {
      stats = { ...stats, error: e instanceof Error ? e.message : String(e) };
      // Whatever state the decoder is in, it is not one we can continue from.
      synced = false;
      pendingGeometry.clear();
      queuedGeometry = stats.restingGeometry;
      requestKeyframe();
    },
  });

  try {
    decoder.configure({
      codec: profile.codec,
      codedWidth: profile.width,
      codedHeight: profile.height,
      // Annex B keyframes carry their own parameter sets, so there is no `description` to pass and
      // nothing to negotiate — which is exactly what lets a viewer join a feed already in progress.
      optimizeForLatency: true,
    });
  } catch (e) {
    stats = { ...stats, error: e instanceof Error ? e.message : String(e) };
  }

  function drop(): void {
    stats = { ...stats, dropped: stats.dropped + 1 };
  }

  return {
    canvas,

    accept(data: ArrayBuffer): void {
      if (closed) return;
      const frame = unpackVideo(data);
      if (!frame) { drop(); return; }

      const { header, payload } = frame;
      if (header.feedId !== feedId) { drop(); return; }

      // Behind what we have already shown. Unordered delivery, not corruption.
      if (header.seq <= lastSeq) { drop(); return; }

      if (header.key) {
        synced = true;
        stats = { ...stats, started: true };
      } else if (synced && header.seq !== lastSeq + 1) {
        // A hole. Every frame after it predicts from something we never received, so there is no
        // point decoding any of them — and no point waiting for the publisher's next scheduled
        // keyframe when asking costs one message.
        synced = false;
        stats = { ...stats, gaps: stats.gaps + 1 };
        requestKeyframe();
      }

      lastSeq = header.seq;

      if (!synced) {
        // Before the first keyframe, and after a gap. Asking here as well as above covers the join
        // case, where there has been no gap because there has been nothing.
        if (!stats.started) requestKeyframe();
        drop();
        return;
      }

      if (decoder.state !== 'configured') { drop(); return; }

      const restingGeometry = header.restingGeometry === undefined
        ? queuedGeometry : header.restingGeometry;
      pendingGeometry.set(header.seq, restingGeometry);
      try {
        decoder.decode(new EncodedVideoChunk({
          type: header.key ? 'key' : 'delta',
          // Paint immediately, without scheduling by source time. A unique sequence timestamp
          // pairs outputs with metadata even when the source encoder repeats timestamps.
          timestamp: header.seq,
          data: payload,
        }));
        queuedGeometry = restingGeometry;
        stats = {
          ...stats,
          decoded: stats.decoded + 1,
          bytes: stats.bytes + payload.byteLength,
        };
      } catch (e) {
        pendingGeometry.delete(header.seq);
        stats = { ...stats, error: e instanceof Error ? e.message : String(e) };
        synced = false;
        requestKeyframe();
      }
    },

    stats(): ReceiverStats { return stats; },

    close(): void {
      if (closed) return;
      closed = true;
      pendingGeometry.clear();
      try { decoder.close(); } catch { /* already gone */ }
    },
  };
}

/** Whether this browser can watch a feed at all. Same generation of support as `canPublish`. */
export function canReceive(): boolean {
  return typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function';
}
