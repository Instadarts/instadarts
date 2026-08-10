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
import type { ControlMessage, MediaTier, Region, VideoProfile, VideoRefusal } from '../../shared/media';
import { directorTiming } from '../../shared/media';
import type { Mesh } from '../media/mesh';
import { canPublish, createVideoPublisher, type PublisherStats, type VideoFrameSource } from '../media/videoPublisher';

interface Options {
  meshRef: React.MutableRefObject<Mesh | null>;
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
}

export function useVideoResponder({ meshRef, sourceRef, directRef, tier, profile, cameraActive }: Options): VideoResponder {
  /** What the owner asked for, which is not the same as what is happening. */
  const [wanted, setWanted] = useState(false);
  const publisher = useRef<ReturnType<typeof createVideoPublisher> | null>(null);
  const [publishing, setPublishing] = useState(false);

  /** Tell every viewer where the feed stands. A spectator never asked and would otherwise not know. */
  const announce = useCallback((on: boolean, reason?: VideoRefusal) => {
    const message: ControlMessage = reason ? { kind: 'video_state', on, reason } : { kind: 'video_state', on };
    for (const link of meshRef.current?.viewers() ?? []) link.sendControl(message);
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
    });
    setPublishing(true);
    announce(true);

    return () => {
      publisher.current?.stop();
      publisher.current = null;
      setPublishing(false);
    };
  }, [wanted, tier, cameraActive, profile, meshRef, sourceRef, announce]);

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
      case 'video_start':
        setWanted(true);
        break;
      case 'video_stop':
        setWanted(false);
        break;
      case 'video_region': {
        // Read here rather than trusted as sent: the numbers came from another machine, and the
        // camera is the authority on its own framing. `directorTiming` is what both ends agree they
        // mean.
        const { transitionMs, resetMs } = directorTiming(message);
        directRef.current?.(message.region, transitionMs, resetMs);
        break;
      }
    }
  }, [meshRef, directRef]);

  const stats = useCallback(() => publisher.current?.stats() ?? null, []);

  return { handleControl, publishing, stats };
}
