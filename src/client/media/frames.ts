// How bytes are framed on each of a link's two channels.
//
// Both formats live here rather than beside their senders, because framing is the one thing the two
// ends of a link have to agree on exactly, and a reader checking that agreement should have to open
// one file. They are shaped differently because their channels are:
//
// **Control — a still** carries its own description, as JSON:
//
// ```
// [uint32 headerLength][headerLength bytes of UTF-8 JSON][payload]
// ```
//
// The obvious alternative — a JSON message saying "a still follows", then the bytes as the next
// binary message — works exactly until two are in flight, at which point the receiver is pairing
// headers with payloads by arrival order and hoping. Three darts landing in one throw window makes
// that an ordinary Tuesday rather than an edge case, so the two travel together and there is nothing
// to pair.
//
// **Media — an encoded frame** is fixed-width and tiny, because it is written fifteen times a second
// and the channel it goes out on is the one carrying real bitrate. See `packVideo`.
//
// Big-endian throughout, because that is what `DataView` does by default and a wire format should
// not depend on remembering to pass `true`.

import { isVideoFeedId, type ControlMessage, type VideoFeedId } from '../../shared/media';

/** A control message with bytes attached. Only `still` uses it today. */
export interface BinaryFrame {
  header: ControlMessage;
  payload: Uint8Array;
}

const LENGTH_BYTES = 4;

export function packFrame(header: ControlMessage, payload: Uint8Array): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const buffer = new ArrayBuffer(LENGTH_BYTES + json.length + payload.length);
  new DataView(buffer).setUint32(0, json.length);
  const bytes = new Uint8Array(buffer);
  bytes.set(json, LENGTH_BYTES);
  bytes.set(payload, LENGTH_BYTES + json.length);
  return buffer;
}

/**
 * Read one back, or null if it is not one of ours.
 *
 * Everything a malformed frame could be is null rather than a throw: this runs on data from another
 * machine, and one bad message must not take the channel down with it.
 */
export function unpackFrame(data: ArrayBuffer): BinaryFrame | null {
  if (data.byteLength < LENGTH_BYTES) return null;

  const headerLength = new DataView(data).getUint32(0);
  // Guards against a length that would have us read past the end — including the pathological case
  // of a huge value that happens to fit in a uint32.
  if (headerLength <= 0 || LENGTH_BYTES + headerLength > data.byteLength) return null;

  try {
    const json = new TextDecoder().decode(new Uint8Array(data, LENGTH_BYTES, headerLength));
    const header = JSON.parse(json) as ControlMessage;
    if (typeof header?.kind !== 'string') return null;
    // Copied, not viewed: the buffer a datachannel hands over is not ours to hold on to, and a still
    // outlives the message it arrived in.
    return { header, payload: new Uint8Array(data.slice(LENGTH_BYTES + headerLength)) };
  } catch {
    return null;
  }
}

// ============================================================
// An encoded video frame
// ============================================================

/**
 * One encoded frame off the media channel.
 *
 * `seq` is what makes an unreliable, unordered channel usable at all. The channel is configured
 * `maxRetransmits: 0, ordered: false`, so frames can go missing and can arrive out of order — and a
 * decoder fed a delta frame out of order does not produce a late picture, it produces a wrong one
 * that stays wrong. A receiver drops anything at or below what it has already decoded, and a gap is
 * what tells it to ask for a keyframe.
 */
export interface VideoFrameHeader {
  feedId: VideoFeedId;
  key: boolean;
  seq: number;
  /** Microseconds, on the publisher's own timeline — the same value that went into the encoder. */
  timestamp: number;
}

/**
 * ```
 * byte 0      u8   flags — bit 0 set for a keyframe
 * bytes 1–4   u32  seq
 * bytes 5–12  f64  timestamp, microseconds
 * bytes 13–28  the feed UUID
 * ```
 *
 * Twenty-nine fixed bytes rather than the JSON above. At fifteen frames a second the difference is
 * small in absolute terms, but this is the channel with a bitrate budget and the header is the one
 * part of it we are not being paid for.
 *
 * The timestamp is a float64 rather than a `u32` of microseconds, which would wrap after seventy-one
 * minutes — a length of time a match can exceed. Every integer we will ever put in it is exact in a
 * double, and `DataView` reads one without the `BigInt` awkwardness a `u64` would bring.
 */
const VIDEO_HEADER_BYTES = 29;
const KEY_FLAG = 1;

function uuidBytes(feedId: VideoFeedId): Uint8Array {
  if (!isVideoFeedId(feedId)) throw new TypeError('Invalid video feed UUID');
  const compact = feedId.replaceAll('-', '');
  return Uint8Array.from({ length: 16 }, (_, i) => Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16));
}

function uuidString(bytes: Uint8Array): VideoFeedId | null {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return isVideoFeedId(value) ? value : null;
}

export function packVideo(header: VideoFrameHeader, payload: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(VIDEO_HEADER_BYTES + payload.length);
  const view = new DataView(buffer);
  view.setUint8(0, header.key ? KEY_FLAG : 0);
  view.setUint32(1, header.seq);
  view.setFloat64(5, header.timestamp);
  new Uint8Array(buffer).set(uuidBytes(header.feedId), 13);
  new Uint8Array(buffer).set(payload, VIDEO_HEADER_BYTES);
  return buffer;
}

/**
 * Read one back, or null if it is not one of ours.
 *
 * Null rather than a throw, for the same reason `unpackFrame` is: this is data from another machine
 * arriving on a channel where corruption is expected, and one bad message must not take down the
 * feed behind it.
 */
export function unpackVideo(data: ArrayBuffer): { header: VideoFrameHeader; payload: Uint8Array } | null {
  if (data.byteLength <= VIDEO_HEADER_BYTES) return null;

  const view = new DataView(data);
  const timestamp = view.getFloat64(5);
  const feedId = uuidString(new Uint8Array(data, 13, 16));
  if (!Number.isFinite(timestamp) || !feedId) return null;

  return {
    header: {
      key: (view.getUint8(0) & KEY_FLAG) !== 0,
      seq: view.getUint32(1),
      timestamp,
      feedId,
    },
    // Copied for the same reason a still's payload is: the decoder is handed this after the message
    // that carried it is gone.
    payload: new Uint8Array(data.slice(VIDEO_HEADER_BYTES)),
  };
}
