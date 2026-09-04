// The scoring device's side of a live feed: hold one standing offer, accept choices only from the
// peers the owner addressed, and encode once for the exact peers that opted in.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlMessage, MediaRole, MediaTier, Region, VideoFeedId, VideoProfile } from '../../shared/media';
import { clampAudience, createVideoFeedId, directorTiming, isVideoFeedId } from '../../shared/media';
import type { MediaSourceStateMessage } from '../../shared/protocol';
import { virtualCamera } from '../lib/appConfig';
import type { Mesh, MeshLink } from '../media/mesh';
import {
  canPublish,
  createVideoFeedClock,
  createVideoPublisher,
  type PublisherStats,
  type VideoFrameSource,
} from '../media/videoPublisher';

interface Options {
  meshRef: React.MutableRefObject<Mesh | null>;
  /** Reactive roster/link state; the mesh itself deliberately keeps one identity. */
  links: MeshLink[];
  sourceRef: React.MutableRefObject<VideoFrameSource | null>;
  directRef: React.MutableRefObject<((region: Region | null, transitionMs: number, resetMs: number) => void) | null>;
  tier: MediaTier;
  profile: VideoProfile | null;
  cameraActive: boolean;
}

export interface VideoOfferStats {
  feedId: VideoFeedId;
  audience: readonly MediaRole[];
  accepted: readonly string[];
}

export interface VideoResponder {
  handleControl: (from: string, message: ControlMessage) => void;
  handleSourceState: (message: MediaSourceStateMessage) => void;
  /** Whether an encoder is running, as opposed to a standing offer merely existing. */
  publishing: boolean;
  stats: () => PublisherStats | null;
  /** The standing offer and its exact recipients. Null when the owner has no active offer. */
  offer: () => VideoOfferStats | null;
}

/** Pure authorization check shared by accept and feed-scoped keyframe commands. */
export function canChooseVideoFeed(
  activeFeedId: VideoFeedId | null,
  requestedFeedId: unknown,
  eligiblePeerIds: Iterable<string>,
  from: string,
): requestedFeedId is VideoFeedId {
  if (!isVideoFeedId(requestedFeedId) || requestedFeedId !== activeFeedId) return false;
  for (const peerId of eligiblePeerIds) if (peerId === from) return true;
  return false;
}

/** Roster eligibility owns consent; temporary writability must never prune it. */
export function pruneIneligibleAcceptances(accepted: Set<string>, eligiblePeerIds: Iterable<string>): void {
  const eligible = new Set(eligiblePeerIds);
  for (const peerId of accepted) if (!eligible.has(peerId)) accepted.delete(peerId);
}

/** Encoder lifetime follows writability; the feed UUID and exact-peer consent do not. */
export function shouldRunVideoPublisher(
  feedId: VideoFeedId | null,
  wanted: boolean,
  tier: MediaTier,
  hasProfile: boolean,
  cameraActive: boolean,
  acceptedPeerIds: Iterable<string>,
  writablePeerIds: Iterable<string>,
): boolean {
  if (!feedId || !wanted || tier !== 'video' || !hasProfile || !cameraActive) return false;
  const writable = new Set(writablePeerIds);
  for (const peerId of acceptedPeerIds) if (writable.has(peerId)) return true;
  return false;
}

export function useVideoResponder({ meshRef, links, sourceRef, directRef, tier, profile, cameraActive }: Options): VideoResponder {
  const [wanted, setWanted] = useState(false);
  const wantedRef = useRef(false);
  const audience = useRef<MediaRole[]>([]);
  const sourceEpoch = useRef<string | null>(null);
  const feedId = useRef<VideoFeedId | null>(null);
  /** Survives encoder pauses; reset only when this source epoch gets a new feed UUID. */
  const feedClock = useRef(createVideoFeedClock());
  /** Peers successfully told about this UUID, whether they accepted or declined it. */
  const offered = useRef(new Set<string>());
  const accepted = useRef(new Set<string>());
  /** End notices waiting for a temporarily unwritable, but still rostered, peer. */
  const pendingEnds = useRef(new Map<string, Set<VideoFeedId>>());
  const publisher = useRef<ReturnType<typeof createVideoPublisher> | null>(null);
  const [publishing, setPublishing] = useState(false);

  const tierRef = useRef(tier);
  tierRef.current = tier;
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const cameraActiveRef = useRef(cameraActive);
  cameraActiveRef.current = cameraActive;

  const stopPublisher = useCallback(() => {
    if (!publisher.current) return;
    publisher.current.stop();
    publisher.current = null;
    setPublishing(false);
  }, []);

  /** Current authorization, re-read for every choice and every encoded frame. */
  const eligible = useCallback(() => meshRef.current?.viewers(audience.current) ?? [], [meshRef]);

  const queueEnd = useCallback((peerId: string, id: VideoFeedId) => {
    const link = meshRef.current?.link(peerId);
    // A missing roster peer cleans up the offer locally, so there is nobody left to notify.
    if (!link) {
      pendingEnds.current.delete(peerId);
      return;
    }
    if (link.sendControl({ kind: 'video_end', feedId: id })) return;
    const ids = pendingEnds.current.get(peerId) ?? new Set<VideoFeedId>();
    ids.add(id);
    pendingEnds.current.set(peerId, ids);
  }, [meshRef]);

  const flushEnds = useCallback(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (const [peerId, ids] of pendingEnds.current) {
      const link = mesh.link(peerId);
      if (!link) {
        pendingEnds.current.delete(peerId);
        continue;
      }
      for (const id of ids) {
        if (!link.sendControl({ kind: 'video_end', feedId: id })) break;
        ids.delete(id);
      }
      if (ids.size === 0) pendingEnds.current.delete(peerId);
    }
  }, [meshRef]);

  const syncPublisher = useCallback(() => {
    const id = feedId.current;
    const mesh = meshRef.current;
    const eligibleLinks = eligible();
    const allowed = new Set(eligibleLinks.map((link) => link.peerId));
    const writable = new Set(eligibleLinks.filter((link) => link.ready).map((link) => link.peerId));
    pruneIneligibleAcceptances(accepted.current, allowed);

    const shouldRun = Boolean(mesh) && shouldRunVideoPublisher(
      id,
      wantedRef.current,
      tierRef.current,
      Boolean(profileRef.current),
      cameraActiveRef.current,
      accepted.current,
      writable,
    );
    if (!shouldRun) {
      stopPublisher();
      return;
    }
    if (publisher.current) return;

    publisher.current = createVideoPublisher({
      mesh: mesh!,
      profile: profileRef.current!,
      feedId: id!,
      source: {
        grab: (size, timestampUs, durationUs) => sourceRef.current?.grab(size, timestampUs, durationUs) ?? null,
        element: () => sourceRef.current?.element() ?? null,
      },
      audience: () => audience.current,
      accepted: () => accepted.current,
      clock: feedClock.current,
    });
    setPublishing(true);
  }, [eligible, meshRef, sourceRef, stopPublisher]);

  /** End the UUID once for every peer that was actually offered it, then forget every choice. */
  const endOffer = useCallback(() => {
    const id = feedId.current;
    if (id) {
      for (const peerId of offered.current) queueEnd(peerId, id);
    }
    stopPublisher();
    feedId.current = null;
    offered.current.clear();
    accepted.current.clear();
  }, [queueEnd, stopPublisher]);

  /** Reconcile the standing offer with the current roster and owner audience. */
  const reconcileOffer = useCallback((repeat = false) => {
    const id = feedId.current;
    const mesh = meshRef.current;
    if (!id || !mesh) return;
    // Deliver queued ends first so ordered control channels cannot expose a replacement offer early.
    flushEnds();

    const allowed = new Map(eligible().map((link) => [link.peerId, link]));
    for (const peerId of [...offered.current]) {
      if (allowed.has(peerId)) continue;
      queueEnd(peerId, id);
      offered.current.delete(peerId);
      accepted.current.delete(peerId);
    }

    for (const link of allowed.values()) {
      if (!link.ready || (!repeat && offered.current.has(link.peerId))) continue;
      if (link.sendControl({ kind: 'video_offer', feedId: id })) offered.current.add(link.peerId);
    }
    syncPublisher();
  }, [eligible, flushEnds, meshRef, queueEnd, syncPublisher]);

  const ensureOffer = useCallback(() => {
    const canOffer = wantedRef.current
      && tierRef.current === 'video'
      && canPublish()
      && Boolean(meshRef.current)
      && Boolean(profileRef.current);
    if (!canOffer) {
      if (feedId.current) endOffer();
      return;
    }
    if (!feedId.current) {
      feedId.current = createVideoFeedId();
      feedClock.current.reset();
    }
    reconcileOffer();
    syncPublisher();
  }, [endOffer, meshRef, reconcileOffer, syncPublisher]);

  // Camera pauses stop only the encoder. Tier/capability withdrawal ends the UUID and its consent.
  useEffect(() => {
    if (wanted) ensureOffer();
    else endOffer();
  }, [wanted, tier, profile, cameraActive, ensureOffer, endOffer]);

  // Repeating an offer is safe and makes a newly writable control channel self-healing.
  const reachable = links.filter((link) => link.ready).map((link) => `${link.peer.peerId}:${link.peer.role}`).sort().join(' ');
  useEffect(() => {
    flushEnds();
    if (feedId.current) reconcileOffer(true);
  }, [reachable, flushEnds, reconcileOffer]);

  useEffect(() => () => endOffer(), [endOffer]);

  const handleSourceState = useCallback((message: MediaSourceStateMessage) => {
    if (!message.active) {
      sourceEpoch.current = null;
      wantedRef.current = false;
      setWanted(false);
      endOffer();
      return;
    }
    if (sourceEpoch.current === message.sourceEpoch) {
      audience.current = clampAudience(message.audience);
      reconcileOffer(true);
      return;
    }
    endOffer();
    sourceEpoch.current = message.sourceEpoch;
    audience.current = clampAudience(message.audience);
    wantedRef.current = true;
    setWanted(true);
    ensureOffer();
  }, [endOffer, ensureOffer, reconcileOffer]);

  const handleControl = useCallback((from: string, message: ControlMessage) => {
    if (message.kind === 'video_accept') {
      if (!canChooseVideoFeed(feedId.current, message.feedId, eligible().map((link) => link.peerId), from)) return;
      const added = !accepted.current.has(from);
      accepted.current.add(from);
      syncPublisher();
      if (added && publisher.current) publisher.current.requestKeyframe();
      return;
    }

    if (message.kind === 'video_decline') {
      if (!canChooseVideoFeed(feedId.current, message.feedId, eligible().map((link) => link.peerId), from)) return;
      if (!accepted.current.delete(from)) return;
      syncPublisher();
      return;
    }

    if (message.kind === 'keyframe') {
      if (!accepted.current.has(from)
        || !canChooseVideoFeed(feedId.current, message.feedId, eligible().map((link) => link.peerId), from)) return;
      publisher.current?.requestKeyframe();
      return;
    }

    // Direction remains the owner's authority. Source lifetime comes from the retained server
    // directive above, so a transient owner link cannot end it.
    if (!meshRef.current?.isOwn(from)) return;

    switch (message.kind) {
      case 'video_region': {
        const { transitionMs, resetMs } = directorTiming(message, virtualCamera());
        directRef.current?.(message.region, transitionMs, resetMs);
        break;
      }
    }
  }, [directRef, eligible, meshRef, syncPublisher]);

  const stats = useCallback(() => publisher.current?.stats() ?? null, []);
  const offer = useCallback((): VideoOfferStats | null => {
    if (!feedId.current) return null;
    return {
      feedId: feedId.current,
      audience: [...audience.current],
      accepted: [...accepted.current],
    };
  }, []);

  return { handleControl, handleSourceState, publishing, stats, offer };
}
