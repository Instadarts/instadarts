// The frontend's side of a live board: ask for it, watch it, and report on it.
//
// Two halves that only look related:
//
//   · **Asking** is the owner's alone. An opponent or spectator never sends `video_start`; they
//     receive whatever the owner's camera is publishing, exactly as with stills.
//   · **Watching** is anybody's. A receiver is made for whichever peer starts sending frames, because
//     the roster has already decided that a peer sending us media is entitled to.
//
// Links come up in the lobby, but a feed is asked for only while an online match is in progress. It
// then stays running across turns: hiding a decoded picture is free, stopping and restarting an
// encoder is not.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlMessage, MediaRole, Region, VideoRefusal } from '../../shared/media';
import { videoProfile } from '../../shared/media';
import type { MediaClientConfig } from '../../shared/config';
import { CONFIG_DEFAULTS } from '../../shared/config';
import type { Mesh, MeshLink } from '../media/mesh';
import { canReceive, createVideoReceiver, type ReceiverStats, type VideoReceiver } from '../media/videoReceiver';

/**
 * A player is already looking at their physical board. Only remote participants and spectators need
 * the picture; leaving `owner` out also keeps those encoded bytes off the local frontend link.
 */
const LIVE_AUDIENCE: MediaRole[] = ['opponent', 'spectator'];

/** A frozen board is worse than the exact virtual fallback sitting underneath it. */
export const VIDEO_STALL_MS = 3000;

export type VideoFeedStatus = 'waiting' | 'live' | 'stalled' | 'off' | 'unavailable';

/** One board-camera peer as the match screen sees it. */
export interface VideoFeedView {
  peerId: string;
  playerId?: string;
  label?: string;
  canvas: HTMLCanvasElement | null;
  status: VideoFeedStatus;
  reason?: VideoRefusal;
  lastFrameAt: number | null;
  stats: ReceiverStats | null;
}

export function frameIsFresh(lastFrameAt: number | null, now: number): boolean {
  return lastFrameAt !== null && now - lastFrameAt < VIDEO_STALL_MS;
}

/**
 * Pick the one picture that may cover the virtual board. Selection is deliberately stricter than
 * reception: hidden feeds keep decoding, but only a fresh current-player feed reaches the screen.
 */
export function selectVideoFeed(
  feeds: readonly VideoFeedView[],
  currentPlayerId: string | null,
  ownPlayerId: string | null,
  isSpectator: boolean,
  isLocal: boolean,
): VideoFeedView | null {
  if (isLocal || !currentPlayerId) return null;
  if (!isSpectator && currentPlayerId === ownPlayerId) return null;
  return feeds.find((feed) =>
    feed.playerId === currentPlayerId && feed.status === 'live' && feed.canvas !== null) ?? null;
}

interface Options {
  mesh: Mesh | null;
  config: MediaClientConfig | null;
  /**
   * The roster as it stands.
   *
   * Passed in rather than read off the mesh, and it is not redundant: a `Mesh` is memoised on the ICE
   * configuration, so its identity survives every roster change. An effect watching only `mesh` would
   * run once — before any camera had been offered — and never again.
   */
  links: MeshLink[];
  /** Whether this frontend should ask its own scorer to publish right now. */
  publish: boolean;
}

export interface VideoFeed {
  /** Feed every media-channel message here. */
  handleMedia: (from: string, data: ArrayBuffer) => void;
  /** Feed every control message here — `video_state` is how a camera says why there is no picture. */
  handleControl: (from: string, message: ControlMessage) => void;
  /**
   * Point our own board camera at a square of the board. Silent when there is no feed to direct.
   *
   * `resetMs` left out means the camera releases itself after `media.virtualCamera.resetMs` — see
   * `directorTiming`. Pass `0` only where something else will certainly send the release.
   */
  direct: (region: Region, transitionMs: number, resetMs?: number) => void;
  /** Board-camera peers, including cameras that have not produced a usable frame. */
  feeds: VideoFeedView[];
  /** What each feed says about itself, for the diagnostics panel. */
  stats: React.RefObject<{ peerId: string; on: boolean; reason?: string; stats: ReceiverStats }[]>;
}

export function useVideoFeed({ mesh, config, links, publish }: Options): VideoFeed {
  const receivers = useRef(new Map<string, VideoReceiver>());
  const states = useRef(new Map<string, { on: boolean; reason?: string }>());
  const lastFrames = useRef(new Map<string, number>());
  const fresh = useRef(new Set<string>());
  const stats = useRef<{ peerId: string; on: boolean; reason?: string; stats: ReceiverStats }[]>([]);
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((value) => value + 1), []);

  const meshRef = useRef(mesh);
  meshRef.current = mesh;
  const profile = config?.video ?? videoProfile(CONFIG_DEFAULTS.media.video);
  const profileRef = useRef(profile);
  profileRef.current = profile;

  /** The camera we have actually asked, so a re-render is not a second request. */
  const askedCamera = useRef<string | null>(null);

  /**
   * Ask our own camera to publish, once there is one and it has said it can.
   *
   * The tier is checked here as well as on the device — not because the device's check is in doubt,
   * but because asking a camera that offered stills only is a question we already know the answer to.
   *
   * Written as a reconciliation rather than a start/cleanup pair, because this runs on every roster
   * change: a cleanup that sent `video_stop` would tear the feed down and rebuild it every time
   * anybody joined or left. Only a *change of camera* is an event.
   */
  useEffect(() => {
    const wanted = publish && mesh
      ? mesh.ownPeers().find((peer) => peer.kind === 'device' && peer.tier === 'video')?.peerId ?? null
      : null;

    if (wanted === askedCamera.current) return;

    if (askedCamera.current) mesh?.link(askedCamera.current)?.sendControl({ kind: 'video_stop' });
    askedCamera.current = null;
    if (!wanted) return;

    // Recorded as asked only once the link took it — the same lesson as the still requests next door.
    // A channel that is not open yet drops the message, and `links` changes again when it opens, so
    // the retry costs nothing to arrange.
    if (mesh?.link(wanted)?.sendControl({ kind: 'video_start', to: LIVE_AUDIENCE })) askedCamera.current = wanted;
  }, [publish, mesh, links]);

  const handleMedia = useCallback((from: string, data: ArrayBuffer) => {
    if (!canReceive()) return;
    let receiver = receivers.current.get(from);
    if (!receiver) {
      receiver = createVideoReceiver({
        profile: profileRef.current,
        requestKeyframe: () => { meshRef.current?.link(from)?.sendControl({ kind: 'keyframe' }); },
        onFrame: () => {
          lastFrames.current.set(from, Date.now());
          if (!fresh.current.has(from)) {
            fresh.current.add(from);
            changed();
          }
        },
      });
      receivers.current.set(from, receiver);
      changed();
    }
    receiver.accept(data);
    stats.current = [...receivers.current].map(([peerId, r]) => ({
      peerId,
      on: states.current.get(peerId)?.on ?? true,
      reason: states.current.get(peerId)?.reason,
      stats: r.stats(),
    }));
  }, [changed]);

  const handleControl = useCallback((_from: string, message: ControlMessage) => {
    if (message.kind !== 'video_state') return;
    states.current.set(_from, { on: message.on, reason: message.reason });
    // A future `on` must wait for a future decoded frame. Otherwise a restart could briefly uncover
    // the last picture from before the camera stopped and present it as live.
    if (!message.on) fresh.current.delete(_from);
    changed();
  }, [changed]);

  const direct = useCallback((region: Region, transitionMs: number, resetMs?: number) => {
    const camera = askedCamera.current;
    if (!camera) return;
    meshRef.current?.link(camera)?.sendControl({ kind: 'video_region', region, transitionMs, resetMs });
  }, []);

  // Check freshness without re-rendering the app for every one of the fifteen frames per second.
  // Only the live → stalled transition changes React state; the next decoded frame changes it back.
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

  // A peer that has left the roster has no more frames coming, and its decoder is holding platform
  // resources. The roster is the only teardown mechanism in this feature; this is that rule applied
  // one level down.
  useEffect(() => {
    const offered = new Set(links.map((link) => link.peer.peerId));
    let changed = false;
    for (const [peerId, receiver] of receivers.current) {
      if (offered.has(peerId)) continue;
      receiver.close();
      receivers.current.delete(peerId);
      states.current.delete(peerId);
      lastFrames.current.delete(peerId);
      fresh.current.delete(peerId);
      changed = true;
    }
    if (changed) {
      stats.current = [...receivers.current].map(([peerId, r]) => ({
        peerId,
        on: states.current.get(peerId)?.on ?? true,
        reason: states.current.get(peerId)?.reason,
        stats: r.stats(),
      }));
      setRevision((value) => value + 1);
    }
  }, [links]);

  useEffect(() => () => {
    for (const receiver of receivers.current.values()) receiver.close();
    receivers.current.clear();
  }, []);

  const feeds = links
    .filter((link) => link.peer.kind === 'device')
    .map((link): VideoFeedView => {
      const receiver = receivers.current.get(link.peer.peerId);
      const state = states.current.get(link.peer.peerId);
      const lastFrameAt = lastFrames.current.get(link.peer.peerId) ?? null;
      const reason = state?.reason as VideoRefusal | undefined;
      const status: VideoFeedStatus = link.peer.tier !== 'video' || !canReceive()
        ? 'unavailable'
        : state?.on === false
          ? 'off'
          : link.state === 'failed' || link.state === 'closed'
            ? 'unavailable'
            : !link.ready || !receiver || lastFrameAt === null
              ? 'waiting'
              : fresh.current.has(link.peer.peerId)
                ? 'live'
                : 'stalled';
      return {
        peerId: link.peer.peerId,
        ...(link.peer.playerId ? { playerId: link.peer.playerId } : {}),
        ...(link.peer.label ? { label: link.peer.label } : {}),
        canvas: receiver?.canvas ?? null,
        status,
        ...(reason ? { reason } : {}),
        lastFrameAt,
        stats: receiver?.stats() ?? null,
      };
    });
  // `revision` is intentionally read: refs above hold the hot path, and this is their transition
  // signal for React. Keeping it out would make a first frame or a stall invisible until a roster
  // happened to change for some unrelated reason.
  void revision;

  return { handleMedia, handleControl, direct, feeds, stats };
}
