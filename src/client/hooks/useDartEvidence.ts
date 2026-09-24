// Dart evidence: a photograph of where each dart of the visit in progress actually landed.
//
// The only place in the app that knows what a still is *for*. Everything below it — the region, the
// request, the frame on the wire — is a general "photograph this square of a board", and this file
// is what makes one of those mean "that dart, there".
//
// Who asks and who watches are deliberately different:
//
//   · the **thrower** asks one of their own scorers, once per dart as it lands — the scorer that
//     placed the dart, when the roster has it, since that is the camera that saw it. Only they can
//     ask: a scorer answers the frontend that claimed it and nobody else.
//   · **everyone else** — the opponent, any spectators — receives the same picture unasked, because
//     the scorer sends to every viewer. That is why an answer carries a `tag` saying which dart it
//     belongs to: an observer never sent a request and has no id of its own to match against.
//
// Evidence belongs to the visit in progress. It is pruned on undo and dropped when the visit is
// submitted, along with the slots it sits under.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlMessage, MediaPeer, Region } from '../../shared/media';
import { MEDIA_ROLES, STILL } from '../../shared/media';
import { dartEvidence } from '../lib/appConfig';
import type { CurrentVisit, DartThrow } from '../../shared/types';
import { BOARD_MAX } from '../../shared/scoring';
import type { Mesh, MeshLink } from '../media/mesh';
import type { PeerLink } from '../media/peerLink';
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
   * again the moment one is, and a dart is asked of a scorer that has only just joined. Reactive
   * where `mesh` is not — it changes with every roster and every link — and wanted only for that,
   * the same reason `useVideoFeed` watches them.
   */
  links: MeshLink[];
  /** The visit being thrown, or undefined between visits. */
  currentVisit: CurrentVisit | undefined;
  /** Whether this user is the one throwing — only they may ask their scorers for anything. */
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
   * Whether evidence can be shown: a picture already received, or a scorer that can photograph
   * the board — one of ours if we are throwing, one of the thrower's if we are watching.
   *
   * What the strip's existence keys off, and it must be answerable *before* any picture arrives —
   * an element that appears when its content does is the screen jumping.
   */
  available: boolean;
}

/** One dart's request: which scorer it went to, and over which link, so only that link answers. */
interface Request {
  id: string;
  peerId: string;
  link: PeerLink;
  /** When it went, for the round trip — and never filled in a shipped build. */
  at?: number;
}

/**
 * How long a scorer that refused a dart's picture is left alone before it may be asked again.
 *
 * Refusals are mostly passing states — a camera restarting, a board not found yet, a queue full —
 * and another scorer is asked at once, so this only decides how soon the one that refused gets a
 * second chance when nobody else could help.
 */
const REFUSAL_BACKOFF_MS = 1500;
/** How many refusals from one scorer end its asking about one dart. What makes the retries finite. */
const MAX_REFUSALS = 3;

/**
 * One scorer's refusals of one dart: how many, and the back-off timer that is leaving it alone.
 *
 * The back-off ends when its own timer fires, not when a clock says it should have: a wall clock
 * stepped back by a moment would otherwise read as "not yet" in the very run the timer caused, and
 * nothing would come to ask again.
 */
interface Refusal {
  count: number;
  backoff: ReturnType<typeof setTimeout> | null;
}

export function useDartEvidence({
  mesh, links, matchId, boardId, currentVisit, isThrower, direct, enabled = true,
}: Options): DartEvidence {
  const [images, setImages] = useState<(string | undefined)[]>([]);
  /** Object URLs we made, so they can be revoked. A blob URL leaks until it is. */
  const urls = useRef<(string | undefined)[]>([]);
  /** The request each dart is waiting on, so a re-render is not a second request. */
  const asked = useRef(new Map<number, Request>());
  /**
   * Every request sent for each dart, by id. One given up on — its camera stopped, or another
   * scorer has been asked since — can still be answered: whichever picture arrives first is the
   * dart's, which is also the rule for everyone who did not ask. A picture already on its way is
   * therefore kept by the thrower as it is by them, rather than refused by the one screen that asked.
   */
  const issued = useRef(new Map<number, Map<string, Request>>());
  /** Refusals, by dart and link. A scorer that refused is asked again later, and not forever. */
  const refused = useRef(new Map<number, Map<PeerLink, Refusal>>());
  /** Bumped to run the asking again: after a refusal, and when a back-off ends. */
  const [retry, setRetry] = useState(0);
  const backoffs = useRef(new Set<ReturnType<typeof setTimeout>>());
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
  const sources = boardScorers(mesh, boardId, isThrower);
  const context = JSON.stringify([matchId, boardId, visitId, enabled, isThrower]);

  const previous = useRef<{ context: string; mesh: Mesh | null; ids: (string | undefined)[] } | null>(null);
  // Compare identities, not counts or coordinates: undo/replacement and consecutive turns by the
  // same player may look identical. Also run before receiving, in case a frame beats the effect.
  const reconcile = useCallback(() => {
    const ids = darts?.map((dart) => dart.id) ?? [];
    const before = previous.current;
    const reset = before?.context !== context || before.mesh !== mesh;
    const sameDart = (index: number) => !reset && Boolean(ids[index]) && before?.ids[index] === ids[index];
    const current = meshRef.current;
    // The links of the scorers that could take a picture right now. A replaced link is not one of
    // them, and neither is the nominee's while its camera is off: it keeps its link through a
    // restart, but whatever it was capturing went with the camera.
    const eligible = new Set(boardScorers(current, boardId, isThrower).map((peer) => current?.link(peer.peerId)));
    for (const [index, requests] of issued.current) {
      if (!sameDart(index)) {
        issued.current.delete(index);
        continue;
      }
      // Nothing comes back over a link that has gone.
      for (const [id, request] of requests) {
        if (current?.link(request.peerId) !== request.link) requests.delete(id);
      }
    }
    for (const [index, request] of asked.current) {
      // A failed connection can keep the same link and roster entry. Stop waiting while it is
      // unwritable, but keep the issued request so a delayed answer can still be accepted.
      if (!sameDart(index) || !eligible.has(request.link) || !request.link.ready) asked.current.delete(index);
    }
    const forget = (refusals: Map<PeerLink, Refusal>, link: PeerLink) => {
      const backoff = refusals.get(link)?.backoff;
      if (backoff) {
        clearTimeout(backoff);
        backoffs.current.delete(backoff);
      }
      refusals.delete(link);
    };
    for (const [index, refusals] of refused.current) {
      // A camera that stopped and came back starts again with a clean record.
      for (const link of [...refusals.keys()]) {
        if (!sameDart(index) || !eligible.has(link)) forget(refusals, link);
      }
      if (!refusals.size) refused.current.delete(index);
    }
    const next = reset ? [] : urls.current.slice(0, ids.length).map((url, index) =>
      ids[index] && before?.ids[index] === ids[index] ? url : undefined);
    previous.current = { context, mesh, ids };
    if (next.length !== urls.current.length || next.some((url, index) => url !== urls.current[index])) {
      replace(next);
    }
  }, [darts, context, mesh, boardId, isThrower, replace]);
  useEffect(reconcile, [reconcile]);

  // Ask, once per dart, as it lands. Manual or camera-scored alike: either way a dart appeared in
  // the visit, and the board in front of the camera has one more in it.
  useEffect(() => {
    reconcile();
    if (!enabled || !isThrower || !darts?.length || !matchId || !boardId || !visitId) return;

    for (let index = 0; index < darts.length; index++) {
      // A dart with its picture is done, even if the link that brought it has since been replaced.
      if (asked.current.has(index) || urls.current[index]) continue;
      const dartId = darts[index].id;
      if (!dartId) continue;
      // Only writable links, excluding a scorer still backing off or one that refused too often.
      const refusals = refused.current.get(index);
      const candidates = sources.filter((peer) => {
        const link = meshRef.current?.link(peer.peerId);
        const refusal = link ? refusals?.get(link) : undefined;
        return link?.ready && (!refusal || (refusal.count < MAX_REFUSALS && !refusal.backoff));
      });
      const source = scorerFor(darts[index], candidates);
      const link = source ? meshRef.current?.link(source.peerId) : undefined;
      if (!source || !link) continue;
      const region = dartRegion(darts[index]);
      const id = crypto.randomUUID();
      const sent = link.sendControl({
        kind: 'still_request',
        id,
        region,
        tag: { kind: 'dart_evidence', matchId, boardId, visitId, dartId, dart: index } satisfies EvidenceTag,
        // Each response sends identical bytes to every viewer. Each keeps its first valid response;
        // replies from different cameras can arrive in different orders on different screens.
        to: [...MEDIA_ROLES],
      });
      // Recorded as asked only once the link actually took it. A channel that is not open yet drops
      // the message silently, and marking it regardless meant a dart thrown in the moment after a
      // link was rebuilt never got a picture at all — the next match state retries it instead.
      if (!sent) continue;
      const request: Request = { id, peerId: source.peerId, link, ...(measuring ? { at: performance.now() } : {}) };
      asked.current.set(index, request);
      const requests = issued.current.get(index) ?? new Map<string, Request>();
      requests.set(id, request);
      issued.current.set(index, requests);
      // The same square, as a camera move rather than a photograph. Not conditional on the still
      // having arrived: they are two independent answers to one dart landing, and the move goes to
      // the live camera whichever scorer takes the picture.
      //
      // Both timings said outright. Leaving either off would fall back to `media.virtualCamera`,
      // which is the backstop for callers with no opinion — and this caller has one: how long a dart
      // is worth looking at is a question about darts, not about the deployment. It matters that it
      // is said at all, because nothing here ever sends a second command to release the camera.
      const { transitionMs, resetMs } = dartEvidence();
      directRef.current?.(region, transitionMs, resetMs);
    }
    // `links` is not read in here — it is the signal that a link may have become writable or a
    // scorer appeared, which is what turns the `continue`s above into a retry rather than a loss.
    // `sources` is derived from the same mesh, so it cannot change without `links` changing too.
  }, [darts, enabled, isThrower, measuring, links, matchId, boardId, visitId, reconcile, retry]);

  const handleControl = useCallback((from: string, message: ControlMessage, payload?: Uint8Array) => {
    reconcile();
    if (!enabled) return;
    if (isThrower && message.kind === 'still_refused') {
      for (const [index, requests] of issued.current) {
        const request = requests.get(message.id);
        if (!request || request.peerId !== from || meshRef.current?.link(from) !== request.link) continue;
        requests.delete(message.id);
        if (urls.current[index]) break;
        // A refusal from a camera that is off now is the camera stopping, which reconcile has already
        // accounted for: recorded, it would outlive the stop and hold the camera back when it returns.
        const eligible = boardScorers(meshRef.current, boardId, isThrower)
          .some((peer) => meshRef.current?.link(peer.peerId) === request.link);
        if (!eligible) break;
        const refusals = refused.current.get(index) ?? new Map<PeerLink, Refusal>();
        const refusal = refusals.get(request.link) ?? { count: 0, backoff: null };
        refusal.count += 1;
        refusals.set(request.link, refusal);
        refused.current.set(index, refusals);
        // Only the request the dart is waiting on moves it on, to another scorer now. A refusal of
        // one already given up on changes nothing but that scorer's record.
        if (asked.current.get(index)?.id === message.id) {
          asked.current.delete(index);
          setRetry((value) => value + 1);
        }
        // And back to this one when its back-off ends, unless it has refused too often.
        if (refusal.backoff) {
          clearTimeout(refusal.backoff);
          backoffs.current.delete(refusal.backoff);
          refusal.backoff = null;
        }
        if (refusal.count < MAX_REFUSALS) {
          const timer = setTimeout(() => {
            backoffs.current.delete(timer);
            if (refusal.backoff === timer) refusal.backoff = null;
            setRetry((value) => value + 1);
          }, REFUSAL_BACKOFF_MS);
          refusal.backoff = timer;
          backoffs.current.add(timer);
        }
        break;
      }
      return;
    }
    if (message.kind !== 'still' || !payload?.byteLength) return;
    const tag = readTag(message.tag);
    if (!tag || tag.matchId !== matchId || tag.boardId !== boardId || tag.visitId !== visitId) return;
    const index = tag.dart;
    if (darts?.[index]?.id !== tag.dartId) return;
    if (urls.current[index]) return; // duplicate replies cannot replace accepted evidence
    if (isThrower) {
      // The answer to one of this dart's requests, from the scorer it went to, over the link it went
      // out on. Not necessarily the latest one: the first picture to arrive is the dart's.
      const request = issued.current.get(index)?.get(message.id);
      if (!request || request.peerId !== from || meshRef.current?.link(from) !== request.link) return;
    } else if (!boardScorers(meshRef.current, boardId, false).some((peer) => peer.peerId === from)) {
      // Observers did not ask, so they cannot know which scorer was asked. Any the server placed at
      // this board will do, and none placed anywhere else.
      return;
    }

    // Timed from the request that was answered, which is not always the latest one.
    const sentAt = isThrower ? issued.current.get(index)?.get(message.id)?.at : undefined;
    if (measuring && sentAt !== undefined) {
      timings.current = [...timings.current, {
        dart: index,
        roundTripMs: Math.round(performance.now() - sentAt),
        bytes: payload.byteLength,
      }].slice(-TIMING_LIMIT);
    }

    const url = URL.createObjectURL(new Blob([payload as BlobPart], { type: message.mime || STILL.mime }));
    const next = [...urls.current];
    next[index] = url;
    replace(next);
  }, [darts, replace, measuring, enabled, matchId, boardId, visitId, isThrower, reconcile]);

  useEffect(() => () => {
    for (const url of urls.current) if (url) URL.revokeObjectURL(url);
    for (const timer of backoffs.current) clearTimeout(timer);
  }, []);

  return {
    images,
    timings,
    handleControl,
    // Reserve the strip before capture, and keep received pictures visible if all cameras stop.
    available: enabled && (sources.length > 0 || images.some(Boolean)),
  };
}

/**
 * The scorers that may answer for this board.
 *
 * A thrower asks its own, and only those with a camera on — the live camera first, since it is the
 * one its owner chose to show the board, then the rest by label. An observer asks nobody and takes
 * a picture from any scorer the server placed at the board.
 */
function boardScorers(mesh: Mesh | null, boardId: string | null, isThrower: boolean): MediaPeer[] {
  if (!mesh || !boardId) return [];
  const board = mesh.links()
    .map(({ peer }) => peer)
    .filter((peer) => peer.kind === 'device' && peer.send && peer.playerId === boardId);
  if (!isThrower) return board;
  return board
    .filter((peer) => peer.own && peer.cameraOn)
    .sort((a, b) => Number(b.live ?? false) - Number(a.live ?? false)
      || (a.scorer ?? '').localeCompare(b.scorer ?? ''));
}

/**
 * Which of the thrower's scorers to ask for this dart: the one that placed it, which saw it, when
 * it is still in the roster; otherwise the first in line. A manually added dart has no scorer of
 * its own and goes straight to the first in line.
 */
function scorerFor(dart: DartThrow, sources: MediaPeer[]): MediaPeer | undefined {
  const winner = dart.detection?.winningScorerId;
  return sources.find((peer) => winner !== undefined && peer.scorerId === winner) ?? sources[0];
}
