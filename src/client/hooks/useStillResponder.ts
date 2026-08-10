// The scoring device's side of a still request: photograph that square of the board, and send the
// picture to everybody watching.
//
// Two rules, and both are enforced here rather than trusted:
//
//   · **Only the owner may ask.** A request from any other peer is dropped in silence — not refused,
//     ignored — which is what stops an opponent deciding what somebody else's camera photographs.
//     The roster is what says who the owner is; this file only reads it.
//   · **The answer goes to everyone.** One capture, one encode, written to every open link. The
//     opponent and any spectators see exactly the picture the owner asked for, which is the whole
//     shape of the feature: they are observers, not requesters.

import { useCallback, useRef } from 'react';
import type { ControlMessage, MediaRole, Region, StillRefusal } from '../../shared/media';
import { MAX_PENDING_STILLS, STILL, clampAudience } from '../../shared/media';
import type { Mesh } from '../media/mesh';
import type { Capture } from '../vision/stillCapture';
import { e2eEnabled } from '../lib/e2e';

/** Whatever can currently take a picture. Null while no camera is running. */
export interface StillSource {
  capture: (region: Region) => Promise<Capture | null>;
  /** Whether the board has been located, so a failure can say which failure it was. */
  located: () => boolean;
}

interface Pending {
  id: string;
  from: string;
  region?: Region;
  tag?: unknown;
  /** Which kinds of viewer this picture is for. Read off the request, never assumed. */
  to: MediaRole[];
  /** When the request arrived, so the wait before it is worked on can be told from the work. */
  at: number;
}

/**
 * What one still cost, on the device that took it.
 *
 * The only place the split is visible: a frontend can time the round trip and nothing inside it, so
 * "was it slow to start or slow to encode" has no answer anywhere else. Kept only where the e2e seam
 * is open, and read through the diagnostics panel.
 */
export interface StillTiming {
  /** Milliseconds between the request arriving and the capture beginning. Queue and contention. */
  waitMs: number;
  /** The crop: one drawImage from the video into the still canvas. */
  drawMs: number;
  /** The JPEG. Expected to dominate, which is exactly what wants confirming. */
  encodeMs: number;
  bytes: number;
  /**
   * Who it went to.
   *
   * Recorded because an audience fails closed: a malformed request still produces a picture, just a
   * narrower one, and without this that narrowing would be invisible — which is the difference
   * between failing closed and failing quietly.
   */
  audience: MediaRole[];
}

const TIMING_LIMIT = 20;

export function useStillResponder(
  meshRef: React.MutableRefObject<Mesh | null>,
  sourceRef: React.MutableRefObject<StillSource | null>,
) {
  const queue = useRef<Pending[]>([]);
  const working = useRef(false);
  /** The last few captures, for the panel. Never filled in a shipped build. */
  const timings = useRef<StillTiming[]>([]);
  const measuring = useRef(e2eEnabled()).current;

  const refuse = useCallback((to: string, id: string, reason: StillRefusal) => {
    meshRef.current?.link(to)?.sendControl({ kind: 'still_refused', id, reason });
  }, [meshRef]);

  const drain = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    try {
      while (queue.current.length > 0) {
        const job = queue.current.shift()!;
        const mesh = meshRef.current;
        const source = sourceRef.current;
        if (!mesh) continue;

        if (!source) { refuse(job.from, job.id, 'no_frame'); continue; }

        const startedAt = performance.now();
        const capture = await source.capture(job.region ?? { cx: 0.5, cy: 0.5, size: 1 });
        if (!capture) {
          // Which failure it was matters to whoever is looking: a camera that is off is a different
          // problem from one that cannot find the board.
          refuse(job.from, job.id, source.located() ? 'no_frame' : 'not_located');
          continue;
        }

        const header: ControlMessage = {
          kind: 'still',
          id: job.id,
          tag: job.tag,
          width: STILL.size,
          height: STILL.size,
          mime: STILL.mime,
        };
        const payload = new Uint8Array(await capture.blob.arrayBuffer());
        if (measuring) {
          timings.current = [...timings.current, {
            waitMs: Math.round(startedAt - job.at),
            drawMs: Math.round(capture.timing.drawMs),
            encodeMs: Math.round(capture.timing.encodeMs),
            bytes: payload.byteLength,
            audience: job.to,
          }].slice(-TIMING_LIMIT);
        }
        // Every viewer the request addressed, which for dart evidence is all of them. One capture
        // and one encode however many that is, and they receive the identical bytes — which is what
        // keeps this camera the single account of what its board looks like, so an observer's copy
        // cannot drift from the owner's.
        //
        // A link that will not take one — never open, or a still bigger than the peer agreed to
        // receive — goes without, and the rest of the loop still runs. Which is the whole reason
        // `sendControl` refuses rather than throws: an unsendable still should cost one viewer a
        // picture, not cost every viewer after it one.
        for (const link of mesh.viewers(job.to)) link.sendControl(header, payload);
      }
    } finally {
      working.current = false;
    }
  }, [meshRef, sourceRef, refuse]);

  const handleControl = useCallback((from: string, message: ControlMessage) => {
    if (message.kind !== 'still_request') return;
    // Silence, not a refusal: a peer with no business asking learns nothing from an answer, and an
    // error frame would only tell it that it reached something.
    if (!meshRef.current?.isOwn(from)) return;

    if (queue.current.length >= MAX_PENDING_STILLS) {
      refuse(from, message.id, 'busy');
      return;
    }
    // Queued rather than serialised away, because three darts can land in one throw window and
    // arrive as three requests in the same breath. They share a video frame and cost three crops.
    queue.current.push({
      id: message.id,
      from,
      region: message.region,
      tag: message.tag,
      // Clamped on arrival rather than at the point of use: the audience is a value from another
      // machine, and this is the moment the device decides what it actually means.
      to: clampAudience(message.to),
      at: performance.now(),
    });
    void drain();
  }, [meshRef, refuse, drain]);

  return { handleControl, timings };
}
