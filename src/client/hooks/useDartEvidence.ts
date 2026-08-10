// Dart evidence: a photograph of where each dart of the visit in progress actually landed.
//
// The only place in the app that knows what a still is *for*. Everything below it — the region, the
// request, the frame on the wire — is a general "photograph this square of a board", and this file
// is what makes one of those mean "that dart, there".
//
// Who asks and who watches are deliberately different:
//
//   · the **thrower** asks their own board camera, once per dart as it lands. Only they can: the
//     camera answers the frontend that claimed it and nobody else.
//   · **everyone else** — the opponent, any spectators — receives the same picture unasked, because
//     the camera sends to every viewer. That is why an answer carries a `tag` saying which dart it
//     belongs to: an observer never sent a request and has no id of its own to match against.
//
// Evidence belongs to the visit in progress. It is pruned on undo and dropped when the visit is
// submitted, along with the slots it sits under.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlMessage, Region } from '../../shared/media';
import { DART_EVIDENCE_REGION_SIZE, DART_EVIDENCE_TRANSITION_MS, MEDIA_ROLES, STILL } from '../../shared/media';
import type { CurrentVisit } from '../../shared/types';
import { BOARD_MAX } from '../../shared/scoring';
import type { Mesh } from '../media/mesh';
import { e2eEnabled } from '../lib/e2e';

const TIMING_LIMIT = 20;

/** What the tag on a dart-evidence still carries. Small on purpose: it crosses a link. */
interface EvidenceTag {
  dart: number;
}

function readTag(tag: unknown): number | null {
  const dart = (tag as EvidenceTag | undefined)?.dart;
  return typeof dart === 'number' && Number.isInteger(dart) && dart >= 0 ? dart : null;
}

/** The square of board a dart's evidence shows, centred on where it landed. */
export function dartRegion(dart: { x: number; y: number }): Region {
  return {
    cx: dart.x / BOARD_MAX,
    cy: dart.y / BOARD_MAX,
    size: DART_EVIDENCE_REGION_SIZE,
  };
}

interface Options {
  mesh: Mesh | null;
  /** The visit being thrown, or undefined between visits. */
  currentVisit: CurrentVisit | undefined;
  /** Whether this user is the one throwing — only they may ask their camera for anything. */
  isThrower: boolean;
  /**
   * Point the live feed at the same square, if there is a feed. Silent when there is not.
   *
   * Passed in rather than reached for, because this hook's business is evidence and the feed's is
   * elsewhere — but they want the same square at the same moment, and one dart producing both a
   * photograph and a camera move is the comparison the whole step exists to make.
   */
  direct?: (region: Region, transitionMs: number, resetMs?: number) => void;
}

/** How long a dart's picture took to come back, from the asking side. */
export interface EvidenceTiming {
  dart: number;
  roundTripMs: number;
  bytes: number;
}

export interface DartEvidence {
  /** One entry per dart of the visit, by index. A hole is a picture that has not arrived. */
  images: (string | undefined)[];
  /** What each picture cost, end to end. Never filled in a shipped build. */
  timings: React.RefObject<EvidenceTiming[]>;
  /** Feed every control message here. */
  handleControl: (from: string, message: ControlMessage, payload?: Uint8Array) => void;
  /**
   * Whether a board camera is in play at all, for the peer being watched.
   *
   * What the strip's existence keys off, and it must be answerable *before* any picture arrives —
   * an element that appears when its content does is the screen jumping.
   */
  available: boolean;
}

export function useDartEvidence({ mesh, currentVisit, isThrower, direct }: Options): DartEvidence {
  const [images, setImages] = useState<(string | undefined)[]>([]);
  /** Object URLs we made, so they can be revoked. A blob URL leaks until it is. */
  const urls = useRef<(string | undefined)[]>([]);
  /** Darts already asked about, so a re-render is not a second request. */
  const asked = useRef(new Set<number>());
  /** When each was asked, for the round trip — and never filled in a shipped build. */
  const requestedAt = useRef(new Map<number, number>());
  const timings = useRef<EvidenceTiming[]>([]);
  const measuring = useRef(e2eEnabled()).current;
  const meshRef = useRef(mesh);
  meshRef.current = mesh;
  const directRef = useRef(direct);
  directRef.current = direct;

  const replace = useCallback((next: (string | undefined)[]) => {
    for (const url of urls.current) {
      if (url && !next.includes(url)) URL.revokeObjectURL(url);
    }
    urls.current = next;
    setImages(next);
  }, []);

  const darts = currentVisit?.darts;
  const visitOf = currentVisit?.playerId;

  // A new visit, or a dart taken back. Both are "what we hold describes something that is no longer
  // on screen", and both are answered by cutting the list to what the visit now has.
  const previousVisit = useRef<string | undefined>(undefined);
  useEffect(() => {
    const count = darts?.length ?? 0;
    const changedVisit = visitOf !== previousVisit.current;
    previousVisit.current = visitOf;

    if (changedVisit) { asked.current = new Set(); requestedAt.current.clear(); }
    for (const index of [...asked.current]) {
      if (index >= count) asked.current.delete(index);
    }

    if (changedVisit || urls.current.length > count) {
      replace(changedVisit ? [] : urls.current.slice(0, count));
    }
  }, [darts?.length, visitOf, replace]);

  // Ask, once per dart, as it lands. Manual or camera-scored alike: either way a dart appeared in
  // the visit, and the board in front of the camera has one more in it.
  useEffect(() => {
    if (!isThrower || !darts?.length) return;
    const camera = boardCamera(meshRef.current);
    if (!camera) return;

    for (let index = 0; index < darts.length; index++) {
      if (asked.current.has(index)) continue;
      const region = dartRegion(darts[index]);
      const sent = meshRef.current?.link(camera)?.sendControl({
        kind: 'still_request',
        id: crypto.randomUUID(),
        region,
        tag: { dart: index } satisfies EvidenceTag,
        // Everyone. Evidence is the case the fan-out was built for: an observer's copy of what a
        // dart did must not be able to drift from the thrower's, and the only way to guarantee that
        // is for all of them to be looking at the same photograph.
        to: [...MEDIA_ROLES],
      });
      // Recorded as asked only once the link actually took it. A channel that is not open yet drops
      // the message silently, and marking it regardless meant a dart thrown in the moment after a
      // link was rebuilt never got a picture at all — the next match state retries it instead.
      if (!sent) continue;
      asked.current.add(index);
      // The same square, as a camera move rather than a photograph. Not conditional on the still
      // having arrived: they are two independent answers to one dart landing.
      //
      // No `resetMs`, which means the camera comes back on its own — the right shape for this, since
      // nothing here would ever send a second command to release it.
      directRef.current?.(region, DART_EVIDENCE_TRANSITION_MS);
      if (measuring) requestedAt.current.set(index, performance.now());
    }
  }, [darts, isThrower, measuring]);

  const handleControl = useCallback((from: string, message: ControlMessage, payload?: Uint8Array) => {
    if (message.kind !== 'still' || !payload) return;
    const index = readTag(message.tag);
    if (index === null) return;
    // Only from a camera, and only for a dart the visit actually has. An observer is reading a tag
    // it did not write, and a still can outlive the dart it was asked about by a moment.
    if (!isCamera(meshRef.current, from)) return;
    if (index >= (darts?.length ?? 0)) return;

    if (measuring) {
      const sentAt = requestedAt.current.get(index);
      if (sentAt !== undefined) {
        timings.current = [...timings.current, {
          dart: index,
          roundTripMs: Math.round(performance.now() - sentAt),
          bytes: payload.byteLength,
        }].slice(-TIMING_LIMIT);
      }
    }

    const url = URL.createObjectURL(new Blob([payload as BlobPart], { type: message.mime || STILL.mime }));
    const next = [...urls.current];
    next[index] = url;
    replace(next);
  }, [darts?.length, replace, measuring]);

  useEffect(() => () => {
    for (const url of urls.current) if (url) URL.revokeObjectURL(url);
  }, []);

  return {
    images,
    timings,
    handleControl,
    // A board camera in the room at all — ours if we are throwing, the thrower's if we are watching.
    // Asked of the roster rather than of what has arrived, so the answer is stable from the first
    // frame of the visit rather than appearing with the first picture.
    available: Boolean(mesh?.links().some((link) => link.peer.kind === 'device')),
  };
}

/** This frontend's own board camera: the one device peer the roster marks as ours. */
function boardCamera(mesh: Mesh | null): string | null {
  return mesh?.ownPeers().find((peer) => peer.kind === 'device')?.peerId ?? null;
}

function isCamera(mesh: Mesh | null, peerId: string): boolean {
  return mesh?.links().some((link) => link.peer.peerId === peerId && link.peer.kind === 'device') === true;
}
