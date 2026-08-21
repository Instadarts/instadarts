// The frontend's live-video state: ask its own camera to make an offer, let remote offers be chosen,
// and decode only the exact feed UUIDs this viewer accepted.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlMessage, Region, VideoFeedId } from '../../shared/media';
import { isVideoFeedId, videoProfile } from '../../shared/media';
import type { MediaClientConfig } from '../../shared/config';
import { CONFIG_DEFAULTS } from '../../shared/config';
import type { MatchState } from '../../shared/types';
import type { Mesh, MeshLink } from '../media/mesh';
import type { LinkState } from '../media/peerLink';
import { canReceive, createVideoReceiver, type ReceiverStats, type VideoReceiver } from '../media/videoReceiver';

export const VIDEO_STALL_MS = 3000;

export type VideoOfferChoice = 'pending' | 'accepted' | 'declined';
export type VideoFeedStatus = 'offered' | 'waiting' | 'live' | 'stalled' | 'unavailable';

export interface VideoFeedView {
  feedId: VideoFeedId;
  peerId: string;
  playerId?: string;
  /** Match-derived display name. Peer rosters deliberately carry no device names. */
  label?: string;
  choice: VideoOfferChoice;
  canvas: HTMLCanvasElement | null;
  status: VideoFeedStatus;
  lastFrameAt: number | null;
  stats: ReceiverStats | null;
  linkState: LinkState;
  linkReady: boolean;
  decoderSupported: boolean;
  /** Stable arrival order for the consent-dialog queue. */
  order: number;
}

interface OfferState {
  feedId: VideoFeedId;
  choice: VideoOfferChoice;
  order: number;
}

interface ReceiverState {
  feedId: VideoFeedId;
  receiver: VideoReceiver;
}

export function frameIsFresh(lastFrameAt: number | null, now: number): boolean {
  return lastFrameAt !== null && now - lastFrameAt < VIDEO_STALL_MS;
}

/** Only an accepted, fresh feed may cover the virtual board. */
export function selectVideoFeed(
  feeds: readonly VideoFeedView[],
  currentBoardId: string | null,
  ownBoardId: string | null,
  isSpectator: boolean,
): VideoFeedView | null {
  if (!currentBoardId) return null;
  // Never your own board: you are standing at it. Which also covers the whole of a single-board
  // match for the people playing it, without that being a case of its own.
  if (!isSpectator && currentBoardId === ownBoardId) return null;
  return feeds.find((feed) =>
    feed.playerId === currentBoardId
    && feed.choice === 'accepted'
    && feed.status === 'live'
    && feed.canvas !== null) ?? null;
}

/**
 * Name board feeds from match participants, never from the scorer device that happens to publish
 * them.
 *
 * A board is named after everybody who throws at it — "Alice & Carol's board" where one user
 * brought two players, and the whole roster where one user brought them all.
 */
export function labelVideoFeedsForMatch(
  feeds: readonly VideoFeedView[],
  match: Pick<MatchState, 'players'> | null,
): VideoFeedView[] {
  if (!match) return [...feeds];

  const boards = new Map<string, { name: string }[]>();
  for (const player of match.players) {
    const boardId = player.boardId ?? player.id;
    boards.set(boardId, [...(boards.get(boardId) ?? []), player]);
  }
  return feeds.map((feed) => {
    const label = feed.playerId ? boardLabel(boards.get(feed.playerId) ?? []) : undefined;
    return label ? { ...feed, label } : feed;
  });
}

/**
 * What to call a board, given who throws at it.
 *
 * A **noun phrase**, and that is the whole design: the label lands in "<label> is offering a live
 * video feed", so a bare list of names would put a plural subject in front of a singular verb. One
 * player is simply named — a board with one person at it is that person, which is what an online
 * 1v1 has always said. More than one becomes possessive, and a crowd stops listing names at all.
 */
function boardLabel(players: { name: string }[]): string | undefined {
  if (players.length === 0) return undefined;
  if (players.length === 1) return players[0].name;
  if (players.length > 3) return 'the shared board';
  const names = players.map((player) => player.name);
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}'s board`;
}

interface Options {
  mesh: Mesh | null;
  config: MediaClientConfig | null;
  links: MeshLink[];
  /** Whether remote offers belong to the current screen. False clears every in-memory choice. */
  receive: boolean;
  /** A match state may arrive just after its source's offer; retain that short pre-match race. */
  anticipate: boolean;
}

export interface VideoFeedStats {
  feedId: VideoFeedId;
  peerId: string;
  choice: VideoOfferChoice;
  stats: ReceiverStats | null;
}

export interface VideoFeed {
  handleMedia: (from: string, data: ArrayBuffer) => void;
  handleControl: (from: string, message: ControlMessage) => void;
  direct: (region: Region, transitionMs: number, resetMs?: number) => void;
  accept: (feedId: VideoFeedId) => void;
  decline: (feedId: VideoFeedId) => void;
  feeds: VideoFeedView[];
  stats: React.RefObject<VideoFeedStats[]>;
}

export function useVideoFeed({ mesh, config, links, receive, anticipate }: Options): VideoFeed {
  const offers = useRef(new Map<string, OfferState>());
  const receivers = useRef(new Map<string, ReceiverState>());
  const lastFrames = useRef(new Map<string, number>());
  const fresh = useRef(new Set<string>());
  const nextOrder = useRef(0);
  const stats = useRef<VideoFeedStats[]>([]);
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((value) => value + 1), []);

  const meshRef = useRef(mesh);
  meshRef.current = mesh;
  const linksRef = useRef(links);
  linksRef.current = links;
  const receiveRef = useRef(receive);
  receiveRef.current = receive;
  const anticipateRef = useRef(anticipate);
  anticipateRef.current = anticipate;
  const profile = config?.video ?? videoProfile(CONFIG_DEFAULTS.media.video);
  const profileRef = useRef(profile);
  profileRef.current = profile;

  const refreshStats = useCallback(() => {
    stats.current = [...offers.current].map(([peerId, offer]) => ({
      peerId,
      feedId: offer.feedId,
      choice: offer.choice,
      stats: receivers.current.get(peerId)?.receiver.stats() ?? null,
    }));
  }, []);

  const closeReceiver = useCallback((peerId: string) => {
    receivers.current.get(peerId)?.receiver.close();
    receivers.current.delete(peerId);
    lastFrames.current.delete(peerId);
    fresh.current.delete(peerId);
  }, []);

  const findOffer = useCallback((feedId: VideoFeedId): [string, OfferState] | null => {
    for (const entry of offers.current) if (entry[1].feedId === feedId) return entry;
    return null;
  }, []);

  const accept = useCallback((id: VideoFeedId) => {
    const found = findOffer(id);
    if (!found) return;
    const [peerId, offer] = found;
    offer.choice = 'accepted';
    fresh.current.delete(peerId);
    meshRef.current?.link(peerId)?.sendControl({ kind: 'video_accept', feedId: id });
    refreshStats();
    changed();
  }, [changed, findOffer, refreshStats]);

  const decline = useCallback((id: VideoFeedId) => {
    const found = findOffer(id);
    if (!found) return;
    const [peerId, offer] = found;
    offer.choice = 'declined';
    closeReceiver(peerId);
    meshRef.current?.link(peerId)?.sendControl({ kind: 'video_decline', feedId: id });
    refreshStats();
    changed();
  }, [changed, closeReceiver, findOffer, refreshStats]);

  const handleMedia = useCallback((from: string, data: ArrayBuffer) => {
    const offer = offers.current.get(from);
    if (!receiveRef.current || !offer || offer.choice !== 'accepted' || !canReceive()) return;

    let state = receivers.current.get(from);
    if (!state || state.feedId !== offer.feedId) {
      state?.receiver.close();
      const id = offer.feedId;
      const receiver = createVideoReceiver({
        profile: profileRef.current,
        feedId: id,
        requestKeyframe: () => meshRef.current?.link(from)?.sendControl({ kind: 'keyframe', feedId: id }),
        onFrame: () => {
          lastFrames.current.set(from, Date.now());
          if (!fresh.current.has(from)) {
            fresh.current.add(from);
            changed();
          }
        },
      });
      state = { feedId: id, receiver };
      receivers.current.set(from, state);
      changed();
    }
    state.receiver.accept(data);
    refreshStats();
  }, [changed, refreshStats]);

  const handleControl = useCallback((from: string, message: ControlMessage) => {
    if (message.kind === 'video_offer') {
      // A source can see the match transition a few milliseconds before this frontend does. Keep
      // the offer now and let `receive` decide when its dialog is visible, or that race would drop
      // the only announcement from an otherwise healthy link.
      if (!isVideoFeedId(message.feedId)) return;
      const link = linksRef.current.find((candidate) => candidate.peer.peerId === from);
      if (!link || link.peer.kind !== 'device' || link.peer.tier !== 'video' || !link.peer.send) return;
      if (!receiveRef.current && !anticipateRef.current) {
        meshRef.current?.link(from)?.sendControl({ kind: 'video_decline', feedId: message.feedId });
        return;
      }

      const previous = offers.current.get(from);
      if (previous?.feedId === message.feedId) return;
      if (previous) closeReceiver(from);

      const offer: OfferState = {
        feedId: message.feedId,
        choice: canReceive() ? 'pending' : 'declined',
        order: nextOrder.current++,
      };
      offers.current.set(from, offer);
      if (!canReceive()) meshRef.current?.link(from)?.sendControl({ kind: 'video_decline', feedId: offer.feedId });
      refreshStats();
      changed();
      return;
    }

    if (message.kind === 'video_end' && isVideoFeedId(message.feedId)) {
      const offer = offers.current.get(from);
      if (!offer || offer.feedId !== message.feedId) return;
      closeReceiver(from);
      offers.current.delete(from);
      refreshStats();
      changed();
    }
  }, [changed, closeReceiver, refreshStats]);

  const direct = useCallback((region: Region, transitionMs: number, resetMs?: number) => {
    const camera = meshRef.current?.ownPeers()
      .find((peer) => peer.kind === 'device' && peer.tier === 'video')?.peerId;
    if (!camera) return;
    meshRef.current?.link(camera)?.sendControl({ kind: 'video_region', region, transitionMs, resetMs });
  }, []);

  // Retry the local choice after a ready-link transition. Both controls are idempotent at the source.
  const reachable = links.filter((link) => link.ready).map((link) => link.peer.peerId).sort().join(' ');
  useEffect(() => {
    for (const [peerId, offer] of offers.current) {
      const kind = offer.choice === 'accepted' ? 'video_accept' : offer.choice === 'declined' ? 'video_decline' : null;
      if (kind) mesh?.link(peerId)?.sendControl({ kind, feedId: offer.feedId });
    }
  }, [reachable, mesh]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      let anyChanged = false;
      for (const peerId of fresh.current) {
        if (frameIsFresh(lastFrames.current.get(peerId) ?? null, now)) continue;
        fresh.current.delete(peerId);
        anyChanged = true;
      }
      if (anyChanged) changed();
    }, 250);
    return () => clearInterval(timer);
  }, [changed]);

  // End local consent as soon as the match screen no longer owns remote offers.
  useEffect(() => {
    if (receive || anticipate || offers.current.size === 0) return;
    for (const [peerId, offer] of offers.current) {
      mesh?.link(peerId)?.sendControl({ kind: 'video_decline', feedId: offer.feedId });
      closeReceiver(peerId);
    }
    offers.current.clear();
    refreshStats();
    changed();
  }, [receive, anticipate, mesh, changed, closeReceiver, refreshStats]);

  // Roster removal is authoritative teardown even when no `video_end` could cross the link.
  useEffect(() => {
    const present = new Set(links.map((link) => link.peer.peerId));
    let removed = false;
    for (const peerId of [...offers.current.keys()]) {
      if (present.has(peerId)) continue;
      closeReceiver(peerId);
      offers.current.delete(peerId);
      removed = true;
    }
    if (removed) {
      refreshStats();
      changed();
    }
  }, [links, changed, closeReceiver, refreshStats]);

  useEffect(() => () => {
    for (const state of receivers.current.values()) state.receiver.close();
    receivers.current.clear();
  }, []);

  const feeds = [...offers.current]
    .map(([peerId, offer]): VideoFeedView | null => {
      const link = links.find((candidate) => candidate.peer.peerId === peerId);
      if (!link) return null;
      const receiver = receivers.current.get(peerId)?.receiver ?? null;
      const lastFrameAt = lastFrames.current.get(peerId) ?? null;
      const status: VideoFeedStatus = !canReceive() || link.state === 'failed' || link.state === 'closed'
        ? 'unavailable'
        : offer.choice !== 'accepted'
          ? 'offered'
          : !link.ready || !receiver || lastFrameAt === null
            ? 'waiting'
            : fresh.current.has(peerId)
              ? 'live'
              : 'stalled';
      return {
        feedId: offer.feedId,
        peerId,
        ...(link.peer.playerId ? { playerId: link.peer.playerId } : {}),
        choice: offer.choice,
        canvas: receiver?.canvas ?? null,
        status,
        lastFrameAt,
        stats: receiver?.stats() ?? null,
        linkState: link.state,
        linkReady: link.ready,
        decoderSupported: canReceive(),
        order: offer.order,
      };
    })
    .filter((entry): entry is VideoFeedView => entry !== null)
    .sort((a, b) => a.order - b.order);

  void revision;
  return { handleMedia, handleControl, direct, accept, decline, feeds, stats };
}
