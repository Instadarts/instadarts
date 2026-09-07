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
import { MEDIA_ROLES, STILL } from '../../shared/media';
import { dartEvidence } from '../lib/appConfig';
import type { CurrentVisit } from '../../shared/types';
import { BOARD_MAX } from '../../shared/scoring';
import type { Mesh, MeshLink } from '../media/mesh';
import { e2eEnabled } from '../lib/e2e';

const TIMING_LIMIT = 20;

/** What the tag on a dart-evidence still carries. Small on purpose: it crosses a link. */
interface EvidenceTag {
  kind: 'dart_evidence';
  matchId: string;
  boardId: string;
  visitId: string;
  dartId: string;
  dart: number;
}

function readTag(tag: unknown): EvidenceTag | null {
  if (!tag || typeof tag !== 'object') return null;
  const value = tag as EvidenceTag;
  if (value.kind !== 'dart_evidence' || !Number.isInteger(value.dart) || value.dart < 0) return null;
  if (![value.matchId, value.boardId, value.visitId, value.dartId].every((id) => typeof id === 'string' && id.length > 0)) return null;
  return value;
}

/** The square of board a dart's evidence shows, centred on where it landed. */
export function dartRegion(dart: { x: number; y: number }): Region {
  return {
    cx: dart.x / BOARD_MAX,
    cy: dart.y / BOARD_MAX,
    size: dartEvidence().regionSize,
  };
}

interface Options {
  mesh: Mesh | null;
  matchId: string | null;
  /** The current thrower's board id from the server's public player roster. */
  boardId: string | null;
  /**
   * The links as they stand, so that a request dropped on a channel that was not open yet is tried
   * again the moment one is. Reactive where `mesh` is not, and wanted only for that — the same
   * reason `useVideoFeed` watches them.
   */
  links: MeshLink[];
  /** The visit being thrown, or undefined between visits. */
  currentVisit: CurrentVisit | undefined;
  /** Whether this user is the one throwing — only they may ask their camera for anything. */
  isThrower: boolean;
  /**
   * Whether this match wants evidence at all. False for a game mode that declined the feature.
   *
   * Gates the asking and the strip together, because half of that would be worse than neither: a
   * picture requested and then not shown is a camera swung at a dart for nobody.
   */
  enabled?: boolean;
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

export function useDartEvidence({
  mesh, links, matchId, boardId, currentVisit, isThrower, direct, enabled = true,
}: Options): DartEvidence {
  const [images, setImages] = useState<(string | undefined)[]>([]);
  /** Object URLs we made, so they can be revoked. A blob URL leaks until it is. */
  const urls = useRef<(string | undefined)[]>([]);
  /** Darts already asked about, so a re-render is not a second request. */
  const asked = useRef(new Map<number, string>());
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
  const visitId = currentVisit?.id;
  const camera = boardCamera(mesh, boardId);
  const cameraLink = camera ? mesh?.link(camera.peerId) : undefined;
  const context = JSON.stringify([matchId, boardId, visitId, camera?.peerId, enabled, isThrower]);

  const previous = useRef<{ context: string; mesh: Mesh | null; link: typeof cameraLink; ids: (string | undefined)[] } | null>(null);
  // Compare identities, not counts or coordinates: undo/replacement and consecutive turns by the
  // same player may look identical. Also run before receiving, in case a frame beats the effect.
  const reconcile = useCallback(() => {
    const ids = darts?.map((dart) => dart.id) ?? [];
    const before = previous.current;
    const reset = before?.context !== context || before.mesh !== mesh || before.link !== cameraLink;
    for (const index of asked.current.keys()) {
      if (reset || !ids[index] || before?.ids[index] !== ids[index]) {
        asked.current.delete(index);
        requestedAt.current.delete(index);
      }
    }
    const next = reset ? [] : urls.current.slice(0, ids.length).map((url, index) =>
      ids[index] && before?.ids[index] === ids[index] ? url : undefined);
    previous.current = { context, mesh, link: cameraLink, ids };
    if (next.length !== urls.current.length || next.some((url, index) => url !== urls.current[index])) {
      replace(next);
    }
  }, [darts, context, mesh, cameraLink, replace]);
  useEffect(reconcile, [reconcile]);

  // Ask, once per dart, as it lands. Manual or camera-scored alike: either way a dart appeared in
  // the visit, and the board in front of the camera has one more in it.
  useEffect(() => {
    reconcile();
    if (!enabled || !isThrower || !darts?.length || !matchId || !boardId || !visitId) return;
    if (!camera?.own || !cameraLink) return;

    for (let index = 0; index < darts.length; index++) {
      if (asked.current.has(index)) continue;
      const dartId = darts[index].id;
      if (!dartId) continue;
      const region = dartRegion(darts[index]);
      const id = crypto.randomUUID();
      const sent = cameraLink.sendControl({
        kind: 'still_request',
        id,
        region,
        tag: { kind: 'dart_evidence', matchId, boardId, visitId, dartId, dart: index } satisfies EvidenceTag,
        // Everyone. Evidence is the case the fan-out was built for: an observer's copy of what a
        // dart did must not be able to drift from the thrower's, and the only way to guarantee that
        // is for all of them to be looking at the same photograph.
        to: [...MEDIA_ROLES],
      });
      // Recorded as asked only once the link actually took it. A channel that is not open yet drops
      // the message silently, and marking it regardless meant a dart thrown in the moment after a
      // link was rebuilt never got a picture at all — the next match state retries it instead.
      if (!sent) continue;
      asked.current.set(index, id);
      // The same square, as a camera move rather than a photograph. Not conditional on the still
      // having arrived: they are two independent answers to one dart landing.
      //
      // Both timings said outright. Leaving either off would fall back to `media.virtualCamera`,
      // which is the backstop for callers with no opinion — and this caller has one: how long a dart
      // is worth looking at is a question about darts, not about the deployment. It matters that it
      // is said at all, because nothing here ever sends a second command to release the camera.
      const { transitionMs, resetMs } = dartEvidence();
      directRef.current?.(region, transitionMs, resetMs);
      if (measuring) requestedAt.current.set(index, performance.now());
    }
    // `links` is not read in here — it is the signal that a link may have become writable,
    // which is what turns the `if (!sent) continue;` above into a retry rather than a loss.
  }, [darts, enabled, isThrower, measuring, links, matchId, boardId, visitId, camera?.own, cameraLink, reconcile]);

  const handleControl = useCallback((from: string, message: ControlMessage, payload?: Uint8Array) => {
    reconcile();
    if (!enabled || message.kind !== 'still' || !payload?.byteLength) return;
    const tag = readTag(message.tag);
    if (!tag || tag.matchId !== matchId || tag.boardId !== boardId || tag.visitId !== visitId) return;
    const index = tag.dart;
    if (darts?.[index]?.id !== tag.dartId) return;
    const source = boardCamera(meshRef.current, boardId);
    if (!source || source.peerId !== from || meshRef.current?.link(from) !== cameraLink) return;
    // Observers did not ask, but the requester must receive the answer to its exact request.
    if (isThrower && (!source.own || asked.current.get(index) !== message.id)) return;
    if (urls.current[index]) return; // duplicate replies cannot replace accepted evidence

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
  }, [darts, replace, measuring, enabled, matchId, boardId, visitId, isThrower, cameraLink, reconcile]);

  useEffect(() => () => {
    for (const url of urls.current) if (url) URL.revokeObjectURL(url);
  }, []);

  return {
    images,
    timings,
    handleControl,
    // A board camera in the room at all — ours if we are throwing, the thrower's if we are watching.
    // Asked of the roster rather than of what has arrived, so the answer is stable from the first
    // frame of the visit rather than appearing with the first picture. A mode that declined evidence
    // reads as no camera, so the visit shows unavailable-evidence placeholders.
    available: enabled && Boolean(camera),
  };
}

/** The server-selected source for this board, whether we own it or observe it. */
function boardCamera(mesh: Mesh | null, boardId: string | null) {
  if (!boardId) return undefined;
  return mesh?.links().find(({ peer }) => peer.kind === 'device' && peer.send && peer.playerId === boardId)?.peer;
}
