// The scoring device's side of the live feed: start when the owner says, point where the owner
// points, and send the same picture to everybody watching.
//
// The rules are the ones stills already established, with one deliberate exception:
//
//   · **Only the owner commands.** `video_start`, `video_stop` and `video_region` from any other peer
//     are dropped in silence. The roster says who the owner is; this file only reads it.
//   · **`keyframe` is answered for anyone.** A viewer asking for a keyframe is saying "I cannot
//     decode what you are sending", which is a statement about them and changes nothing about what is
//     shown. Refusing it would leave an opponent staring at a broken picture with no way to say so.
//     The rate limit lives in the publisher, so several viewers asking at once costs one keyframe.
//   · **The answer goes to everyone.** One encode, written to every link the roster marks as a
//     viewer — the whole reason the encoder is owned here rather than by a link.
//
// The owner's wish outlives the camera. A phone whose camera is switched off and on again resumes
// publishing without being asked, because the owner never withdrew the request and cannot see that
// anything happened.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlMessage, MediaRole, MediaTier, Region, VideoProfile, VideoRefusal } from '../../shared/media';
import { clampAudience, directorTiming, excluded } from '../../shared/media';
import { virtualCamera } from '../lib/appConfig';
import type { Mesh, MeshLink } from '../media/mesh';
import { canPublish, createVideoPublisher, type PublisherStats, type VideoFrameSource } from '../media/videoPublisher';

interface Options {
  meshRef: React.MutableRefObject<Mesh | null>;
  /**
   * The links as they stand — reactive, where `meshRef` deliberately is not.
   *
   * Wanted for one thing only: noticing that somebody new can now be told something. See the effect
   * that repeats the announcement.
   */
  links: MeshLink[];
  sourceRef: React.MutableRefObject<VideoFrameSource | null>;
  /** Where the director's commands land. Held apart from the frame source: this one survives a
   *  camera restart, and the source does not. */
  directRef: React.MutableRefObject<((region: Region | null, transitionMs: number, resetMs: number) => void) | null>;
  /** How much this phone is willing to send. Only `video` may publish a feed. */
  tier: MediaTier;
  /** What to encode at, as the deployment ships it. Null until the server has said. */
  profile: VideoProfile | null;
  /** Whether a camera is running. A feed cannot start without one, and stops when it goes. */
  cameraActive: boolean;
}

export interface VideoResponder {
  /** Feed every control message here. */
  handleControl: (from: string, message: ControlMessage) => void;
  /** Whether a feed is publishing right now. */
  publishing: boolean;
  /**
   * What it has cost, read at the moment of asking. Null when nothing is publishing.
   *
   * A function rather than a ref that something refreshes on a timer. The publisher counts fifteen
   * times a second, so a snapshot is stale the instant it is taken — and a stale count read beside a
   * live one from the other end of the link makes a camera look as though it delivered frames it
   * never sent. Whoever wants a number can ask for one.
   */
  stats: () => PublisherStats | null;
  /** Who the feed is currently addressed to, or null when nothing is publishing. */
  audience: () => readonly MediaRole[] | null;
}

export function useVideoResponder({ meshRef, links, sourceRef, directRef, tier, profile, cameraActive }: Options): VideoResponder {
  /** What the owner asked for, which is not the same as what is happening. */
  const [wanted, setWanted] = useState(false);
  /**
   * Who the feed is for, held in a ref rather than in state on purpose.
   *
   * Re-addressing a running feed must not re-run the effect below, because that would stop the
   * encoder and start another one — costing every viewer, including the ones whose membership never
   * changed, a gap and a keyframe. The recipient list is not part of how a frame is made.
   */
  const audience = useRef<MediaRole[]>([]);
  const publisher = useRef<ReturnType<typeof createVideoPublisher> | null>(null);
  const [publishing, setPublishing] = useState(false);
  /** The last thing this camera said about itself, or null if it has never said anything. */
  const last = useRef<{ on: boolean; reason?: VideoRefusal } | null>(null);

  /**
   * Tell every viewer where the feed stands — including, and especially, the ones it is not for.
   *
   * A spectator never sent `video_start` and has no other way to tell a feed that is off from a link
   * that is broken. Once a feed can be addressed, there is a third thing to be unable to tell apart:
   * a feed that is running for somebody else. Saying `on` to a peer that will receive nothing would
   * be worse than saying nothing at all, so the announcement is split — the complement of an
   * audience is just another audience.
   */
  const announce = useCallback((on: boolean, reason?: VideoRefusal) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // Kept so it can be said again to somebody who could not hear it the first time — see below.
    last.current = { on, reason };

    const addressed: ControlMessage = reason ? { kind: 'video_state', on, reason } : { kind: 'video_state', on };
    for (const link of mesh.viewers(on ? audience.current : undefined)) link.sendControl(addressed);
    if (!on) return;

    for (const link of mesh.viewers(excluded(audience.current))) {
      link.sendControl({ kind: 'video_state', on: false, reason: 'not_addressed' });
    }
  }, [meshRef]);

  // Whether a feed should be running, and the three independent reasons it might not be. Kept as one
  // effect because "start it" and "stop it" are the same decision read two ways, and splitting them
  // is how a publisher gets left running after the thing that justified it went away.
  useEffect(() => {
    const mesh = meshRef.current;
    const refusal: VideoRefusal | null =
      tier !== 'video' ? 'not_offered'
      : !canPublish() ? 'no_encoder'
      : !cameraActive ? 'no_camera'
      : null;

    if (!wanted || refusal || !mesh || !profile) {
      if (publisher.current) {
        publisher.current.stop();
        publisher.current = null;
        setPublishing(false);
        announce(false, refusal ?? undefined);
      } else if (wanted && refusal) {
        // Never started, and the owner is owed the reason — they asked and nothing happened.
        announce(false, refusal);
      }
      return;
    }

    if (publisher.current) return;
    publisher.current = createVideoPublisher({
      mesh,
      profile,
      source: {
        grab: (size, timestampUs, durationUs) => sourceRef.current?.grab(size, timestampUs, durationUs) ?? null,
        element: () => sourceRef.current?.element() ?? null,
      },
      // Read on every frame rather than captured, which is what lets the list change underneath a
      // running encoder.
      audience: () => audience.current,
    });
    setPublishing(true);
    announce(true);

    return () => {
      publisher.current?.stop();
      publisher.current = null;
      setPublishing(false);
    };
  }, [wanted, tier, cameraActive, profile, meshRef, sourceRef, announce]);

  /**
   * Say it again whenever somebody new could hear it.
   *
   * Every `announce` above fires at a moment that matters to the *camera*: a feed starting, stopping,
   * being refused, being re-addressed. A viewer arriving is a moment that matters to somebody else —
   * a spectator opening a match where a feed is already running, or any peer whose channels finish
   * opening a fraction after the announcement went out. `sendControl` drops a message on a channel
   * that is not open yet, and from the other end a dropped message and a camera that never spoke are
   * the same silence.
   *
   * There is nothing the viewer can do about it: `video_state` is a camera telling, and the protocol
   * has no matching question. So the camera repeats its last word instead — whatever that was, a
   * running feed or a refusal — whenever the set of peers that could hear it changes. One control
   * message per viewer per roster change, and idempotent at the other end.
   *
   * Keyed on *which* peers are reachable rather than on the array, which is rebuilt on every change.
   */
  const reachable = links.filter((link) => link.ready).map((link) => link.peer.peerId).sort().join(' ');
  useEffect(() => {
    if (last.current) announce(last.current.on, last.current.reason);
  }, [reachable, announce]);

  const handleControl = useCallback((from: string, message: ControlMessage) => {
    // The one command anyone may send. Answered before the ownership check rather than after, so the
    // exception is visible rather than implied by a fall-through.
    if (message.kind === 'keyframe') {
      publisher.current?.requestKeyframe();
      return;
    }

    // Silence, not a refusal — the same rule as a still request, and for the same reason: a peer with
    // no business commanding learns nothing from an answer.
    if (!meshRef.current?.isOwn(from)) return;

    switch (message.kind) {
      case 'video_start': {
        // A camera publishes one feed, so a second start is not a second feed — it re-addresses the
        // one that is running. Nothing here restarts anything.
        audience.current = clampAudience(message.to);
        setWanted(true);
        // Only if it is already running: otherwise the effect below announces it on the way up, and
        // a peer that has just been added has never seen a keyframe and would sit on a grey square
        // until the next scheduled one.
        if (publisher.current) {
          publisher.current.requestKeyframe();
          announce(true);
        }
        break;
      }
      case 'video_stop':
        // No roles to read: a stop is for everybody. Narrowing an audience is a shorter `video_start`.
        setWanted(false);
        break;
      case 'video_region': {
        // Read here rather than trusted as sent: the numbers came from another machine, and the
        // camera is the authority on its own framing. `directorTiming` is what both ends agree they
        // mean.
        const { transitionMs, resetMs } = directorTiming(message, virtualCamera());
        directRef.current?.(message.region, transitionMs, resetMs);
        break;
      }
    }
  }, [meshRef, directRef, announce]);

  const stats = useCallback(() => publisher.current?.stats() ?? null, []);
  const currentAudience = useCallback(() => publisher.current?.audience ?? null, []);

  return { handleControl, publishing, stats, audience: currentAudience };
}
