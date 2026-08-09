// A still on the wire: one message that carries its own description.
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
// Big-endian for the length, because that is what `DataView` does by default and a wire format
// should not depend on remembering to pass `true`.

import type { ControlMessage } from '../../shared/media';

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
