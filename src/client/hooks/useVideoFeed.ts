// The frontend's side of a live board: ask for it, watch it, and report on it.
//
// Two halves that only look related:
//
//   · **Asking** is the owner's alone, and is gated on `?e2e=1` for now — the feed is not a shipped
//     feature yet, it is a thing being proven. An opponent or spectator never sends `video_start`;
//     they receive whatever the owner's camera is publishing, exactly as with stills.
//   · **Watching** is anybody's. A receiver is made for whichever peer starts sending frames, because
//     the roster has already decided that a peer sending us media is entitled to.
//
// The feed is asked for **in the lobby**, which is where the links come up, and is left running from
// there — a match is not a new negotiation, and re-asking at the throw-off would only risk a gap at
// the moment anyone actually wants to look.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlMessage, MediaRole, Region } from '../../shared/media';
import { videoProfile } from '../../shared/media';
import type { MediaClientConfig } from '../../shared/config';
import { CONFIG_DEFAULTS } from '../../shared/config';
import type { Mesh, MeshLink } from '../media/mesh';
import { canReceive, createVideoReceiver, type ReceiverStats, type VideoReceiver } from '../media/videoReceiver';
import { e2eEnabled } from '../lib/e2e';

/**
 * Who the lobby feed is for: the owner, and nobody else.
 *
 * This feed exists to be proven, not to be shown. Sending it to an opponent would put a live board
 * in front of somebody who never asked for one, over a link they cannot switch off, for a feature
 * that is still behind `?e2e=1` — and sending it to a spectator would do that to a stranger. When
 * there is a real board view on the match screen, that view will address its own audience; until
 * then the narrowest one that still proves anything is the right one.
 */
const PROVING_AUDIENCE: MediaRole[] = ['owner'];

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
  /** Whether there is a lobby or match to watch a board for. Nothing is asked outside one. */
  inRoom: boolean;
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
  /** The canvas each publishing peer's picture lands in. */
  canvases: { peerId: string; canvas: HTMLCanvasElement }[];
  /** What each feed says about itself, for the diagnostics panel. */
  stats: React.RefObject<{ peerId: string; on: boolean; reason?: string; stats: ReceiverStats }[]>;
}

export function useVideoFeed({ mesh, config, links, inRoom }: Options): VideoFeed {
  const receivers = useRef(new Map<string, VideoReceiver>());
  const states = useRef(new Map<string, { on: boolean; reason?: string }>());
  const stats = useRef<{ peerId: string; on: boolean; reason?: string; stats: ReceiverStats }[]>([]);
  const [canvases, setCanvases] = useState<{ peerId: string; canvas: HTMLCanvasElement }[]>([]);

  const meshRef = useRef(mesh);
  meshRef.current = mesh;
  const profile = config?.video ?? videoProfile(CONFIG_DEFAULTS.media.video);
  const profileRef = useRef(profile);
  profileRef.current = profile;

  // Read once, like every other use of the seam: react-router drops the query string the moment the
  // app navigates off "/", so asking later would answer no.
  const asking = useRef(e2eEnabled()).current;

  /** This frontend's own board camera — the one device peer the roster marks as ours. */
  const ownCamera = useCallback((): string | null => {
    return meshRef.current?.ownPeers().find((peer) => peer.kind === 'device')?.peerId ?? null;
  }, []);

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
    const wanted = asking && inRoom && mesh
      ? mesh.ownPeers().find((peer) => peer.kind === 'device' && peer.tier === 'video')?.peerId ?? null
      : null;

    if (wanted === askedCamera.current) return;

    if (askedCamera.current) mesh?.link(askedCamera.current)?.sendControl({ kind: 'video_stop' });
    askedCamera.current = null;
    if (!wanted) return;

    // Recorded as asked only once the link took it — the same lesson as the still requests next door.
    // A channel that is not open yet drops the message, and `links` changes again when it opens, so
    // the retry costs nothing to arrange.
    if (mesh?.link(wanted)?.sendControl({ kind: 'video_start', to: PROVING_AUDIENCE })) askedCamera.current = wanted;
  }, [asking, inRoom, mesh, links]);

  const handleMedia = useCallback((from: string, data: ArrayBuffer) => {
    if (!canReceive()) return;
    let receiver = receivers.current.get(from);
    if (!receiver) {
      receiver = createVideoReceiver({
        profile: profileRef.current,
        requestKeyframe: () => { meshRef.current?.link(from)?.sendControl({ kind: 'keyframe' }); },
      });
      receivers.current.set(from, receiver);
      setCanvases([...receivers.current].map(([peerId, r]) => ({ peerId, canvas: r.canvas })));
    }
    receiver.accept(data);
    stats.current = [...receivers.current].map(([peerId, r]) => ({
      peerId,
      on: states.current.get(peerId)?.on ?? true,
      reason: states.current.get(peerId)?.reason,
      stats: r.stats(),
    }));
  }, []);

  const handleControl = useCallback((_from: string, message: ControlMessage) => {
    if (message.kind !== 'video_state') return;
    states.current.set(_from, { on: message.on, reason: message.reason });
  }, []);

  const direct = useCallback((region: Region, transitionMs: number, resetMs?: number) => {
    if (!asking) return;
    const camera = ownCamera();
    if (!camera) return;
    meshRef.current?.link(camera)?.sendControl({ kind: 'video_region', region, transitionMs, resetMs });
  }, [asking, ownCamera]);

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
      changed = true;
    }
    if (changed) setCanvases([...receivers.current].map(([peerId, r]) => ({ peerId, canvas: r.canvas })));
  }, [links]);

  useEffect(() => () => {
    for (const receiver of receivers.current.values()) receiver.close();
    receivers.current.clear();
  }, []);

  return { handleMedia, handleControl, direct, canvases, stats };
}
